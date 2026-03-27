"use strict";

const { S3Client, GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { Readable } = require("stream");
const readline = require("readline");
const zlib = require("zlib");
const logger = require("../utils/logger");

/**
 * Extract a structured, loggable error context from any error value.
 * Covers standard Error properties as well as AWS SDK v3-specific fields
 * ($fault, $metadata, Code, code) that are otherwise invisible when only
 * `err.message` is logged.
 */
function extractErrorContext(err) {
  if (!err || typeof err !== "object") {
    return { raw: String(err) };
  }

  return {
    name: err.name,
    message: err.message,
    code: err.code || err.Code,
    httpStatusCode: err.$metadata?.httpStatusCode ?? err.$response?.statusCode,
    fault: err.$fault,
    requestId: err.$metadata?.requestId,
    cfId: err.$metadata?.cfId,
    stack: err.stack,
  };
}

function env(name, fallback = "") {
  const value = process.env[name];
  return value == null || value === "" ? fallback : value;
}

function safeNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeInt(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function toIsoDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class MassiveFlatfileService {
  constructor(options = {}) {
    this.bucket = options.bucket || env("MASSIVE_FLATFILES_BUCKET", "flatfiles");
    this.endpoint = options.endpoint || env("MASSIVE_FLATFILES_ENDPOINT", "https://files.massive.com");
    this.region = options.region || env("MASSIVE_FLATFILES_REGION", "auto");
    this.accessKeyId = options.accessKeyId || env("MASSIVE_FLATFILES_ACCESS_KEY_ID");
    this.secretAccessKey = options.secretAccessKey || env("MASSIVE_FLATFILES_SECRET_ACCESS_KEY");
    this.forcePathStyle =
      options.forcePathStyle !== undefined
        ? options.forcePathStyle
        : String(env("MASSIVE_FLATFILES_FORCE_PATH_STYLE", "true")).toLowerCase() === "true";

    this.cacheMaxSize =
      options.cacheMaxSize !== undefined
        ? options.cacheMaxSize
        : safeInt(env("MASSIVE_FLATFILES_CACHE_SIZE", "3"), 3);

    this.cacheTTLms =
      options.cacheTTLms !== undefined
        ? options.cacheTTLms
        : safeInt(env("MASSIVE_FLATFILES_CACHE_TTL", "300000"), 300000);

    this.maxRetries =
      options.maxRetries !== undefined
        ? options.maxRetries
        : safeInt(env("MASSIVE_FLATFILES_MAX_RETRIES", "3"), 3);

    this.retryBaseDelayMs =
      options.retryBaseDelayMs !== undefined
        ? options.retryBaseDelayMs
        : safeInt(env("MASSIVE_FLATFILES_RETRY_BASE_DELAY_MS", "750"), 750);

    if (!this.accessKeyId || !this.secretAccessKey) {
      throw new Error(
        "Missing Massive flatfile credentials (MASSIVE_FLATFILES_ACCESS_KEY_ID / MASSIVE_FLATFILES_SECRET_ACCESS_KEY)"
      );
    }

    this.client =
      options.s3Client ||
      new S3Client({
        region: this.region,
        endpoint: this.endpoint,
        forcePathStyle: this.forcePathStyle,
        credentials: {
          accessKeyId: this.accessKeyId,
          secretAccessKey: this.secretAccessKey,
        },
      });

    // Log config on startup so the effective values are visible in logs
    // without exposing credentials.
    logger.info("[MassiveFlatfileService] initialized", {
      endpoint: this.endpoint,
      bucket: this.bucket,
      region: this.region,
      forcePathStyle: this.forcePathStyle,
      maxRetries: this.maxRetries,
      retryBaseDelayMs: this.retryBaseDelayMs,
      cacheMaxSize: this.cacheMaxSize,
      cacheTTLms: this.cacheTTLms,
      hasAccessKey: Boolean(this.accessKeyId),
      hasSecretKey: Boolean(this.secretAccessKey),
    });

    /**
     * Datei-Cache:
     * key -> { rows, expiresAt, lastAccessedAt }
     */
    this.cache = new Map();
  }

  _pruneExpiredCache() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (!entry || entry.expiresAt <= now) {
        this.cache.delete(key);
      }
    }
  }

  _evictIfNeeded() {
    if (this.cache.size < this.cacheMaxSize) return;

    let oldestKey = null;
    let oldestAccess = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      const ts = safeNum(entry?.lastAccessedAt, Infinity);
      if (ts < oldestAccess) {
        oldestAccess = ts;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  _cacheGet(key) {
    this._pruneExpiredCache();

    const entry = this.cache.get(key);
    if (!entry) return null;

    entry.lastAccessedAt = Date.now();
    return entry.rows;
  }

  _cacheSet(key, rows) {
    this._pruneExpiredCache();
    this._evictIfNeeded();

    this.cache.set(key, {
      rows,
      expiresAt: Date.now() + this.cacheTTLms,
      lastAccessedAt: Date.now(),
    });
  }

  async _withRetry(fn, contextLabel = "operation") {
    let lastErr = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;

        const isLast = attempt >= this.maxRetries;
        logger.warn(`[MassiveFlatfileService] ${contextLabel} failed`, {
          attempt,
          maxRetries: this.maxRetries,
          error: extractErrorContext(err),
        });

        if (isLast) break;

        const delay = this.retryBaseDelayMs * attempt;
        await sleep(delay);
      }
    }

    throw lastErr;
  }

  /**
   * Beispiel:
   * us_stocks_sip/day_aggs_v1/2026/03/2026-03-25.csv.gz
   *
   * Den Dataset-Pfad ggf. an die echte Massive-Subscription anpassen.
   */
  buildDailyAggKey(date, options = {}) {
    const iso = toIsoDate(date);
    if (!iso) {
      throw new Error(`Invalid date: ${date}`);
    }

    const [year, month] = iso.split("-");
    const dataset =
      options.dataset || env("MASSIVE_FLATFILES_DAILY_DATASET", "us_stocks_sip/day_aggs_v1");

    return `${dataset}/${year}/${month}/${iso}.csv.gz`;
  }

  async listPrefix(prefix) {
    return this._withRetry(async () => {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: 500,
        })
      );

      return Array.isArray(res?.Contents)
        ? res.Contents.map((x) => x.Key).filter(Boolean)
        : [];
    }, `listPrefix(${prefix})`);
  }

  async getObjectStream(key) {
    return this._withRetry(async () => {
      logger.debug("[MassiveFlatfileService] GetObject request", {
        endpoint: this.endpoint,
        bucket: this.bucket,
        key,
        forcePathStyle: this.forcePathStyle,
      });

      let res;
      try {
        res = await this.client.send(
          new GetObjectCommand({
            Bucket: this.bucket,
            Key: key,
          })
        );
      } catch (err) {
        logger.error("[MassiveFlatfileService] GetObject S3 error", {
          endpoint: this.endpoint,
          bucket: this.bucket,
          key,
          error: extractErrorContext(err),
        });
        throw err;
      }

      if (!res || !res.Body) {
        throw new Error(`No body returned for flatfile key: ${key}`);
      }

      // AWS SDK v3 returns a Node.js Readable in Node.js environments, but can
      // return a Web ReadableStream in certain configurations (e.g. custom fetch
      // handler, edge runtimes). Normalise to a Node.js Readable so that
      // .pipe() always works downstream.
      const body = res.Body;
      if (Readable.isReadable(body)) {
        return body;
      }
      // Web ReadableStream → Node.js Readable (Node >= 16.5.0)
      if (typeof body.getReader === "function") {
        return Readable.fromWeb(body);
      }
      // Fallback: wrap any async-iterable (covers older SDK betas)
      return Readable.from(body);
    }, `getObjectStream(${key})`);
  }

  /**
   * Einfacher CSV-Parser für Standardfälle.
   * Für exotische Fälle mit echten Zeilenumbrüchen in Quotes wäre später eine CSV-Library besser.
   */
  parseCsvLine(line) {
    const out = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];

      if (ch === '"') {
        if (inQuotes && next === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (ch === "," && !inQuotes) {
        out.push(current);
        current = "";
        continue;
      }

      current += ch;
    }

    out.push(current);
    return out;
  }

  normalizeDailyAggRow(row) {
    const symbol = String(row?.ticker || row?.symbol || "").trim().toUpperCase();
    if (!symbol) return null;

    const date =
      toIsoDate(row?.date) ||
      toIsoDate(row?.window_start) ||
      toIsoDate(row?.timestamp);

    if (!date) return null;

    // close is mandatory for a usable price row – reject null / empty / zero
    const close = row?.close != null && row?.close !== "" ? safeNum(row.close) : null;
    if (close == null || close <= 0) return null;

    return {
      symbol,
      date,
      open: safeNum(row?.open),
      high: safeNum(row?.high),
      low: safeNum(row?.low),
      close,
      volume: safeNum(row?.volume),
      transactions: safeNum(row?.transactions),
      source: "massive_flatfiles",
    };
  }

  async streamCsvRowsFromGzipKey(key, onRow) {
    let body = null;
    let gunzip = null;
    let rl = null;

    try {
      body = await this.getObjectStream(key);
      gunzip = zlib.createGunzip();

      // body is guaranteed to be a Node.js Readable at this point (normalised
      // inside getObjectStream).
      const stream = body.pipe(gunzip);

      rl = readline.createInterface({
        input: stream,
        crlfDelay: Infinity,
      });

      let header = null;

      for await (const line of rl) {
        if (!line || !line.trim()) continue;

        if (!header) {
          header = this.parseCsvLine(line).map((x) => String(x || "").trim());
          continue;
        }

        const values = this.parseCsvLine(line);
        const row = {};

        for (let i = 0; i < header.length; i++) {
          row[header[i]] = values[i] ?? null;
        }

        await onRow(row);
      }
    } catch (err) {
      logger.error("[MassiveFlatfileService] streamCsvRowsFromGzipKey failed", {
        endpoint: this.endpoint,
        bucket: this.bucket,
        key,
        error: extractErrorContext(err),
      });
      throw err;
    } finally {
      try {
        if (rl) rl.close();
      } catch (_) {}

      try {
        if (gunzip && typeof gunzip.destroy === "function") gunzip.destroy();
      } catch (_) {}

      try {
        if (body && typeof body.destroy === "function") body.destroy();
      } catch (_) {}
    }
  }

  /**
   * Lädt die komplette Datei einmal und cached sie dateibasiert.
   * Danach kann beliebig nach Symbolen gefiltert werden.
   */
  async loadDailyAggFileRows(date, options = {}) {
    const key = this.buildDailyAggKey(date, options);

    const cached = options.useCache === false ? null : this._cacheGet(key);
    if (cached) {
      logger.info("[MassiveFlatfileService] flatfile cache hit", { key, rows: cached.length });
      return cached;
    }

    logger.info("[MassiveFlatfileService] loading flatfile", { key });

    const rows = [];

    await this.streamCsvRowsFromGzipKey(key, async (raw) => {
      const normalized = this.normalizeDailyAggRow(raw);
      if (!normalized) return;
      rows.push(normalized);
    });

    if (options.useCache !== false) {
      this._cacheSet(key, rows);
    }

    return rows;
  }

  async loadDailyAggregatesForSymbols({ date, symbols, useCache = true, dataset } = {}) {
    const symbolSet = new Set(
      (symbols || [])
        .map((s) => String(s || "").trim().toUpperCase())
        .filter(Boolean)
    );

    if (!symbolSet.size) return [];

    const rows = await this.loadDailyAggFileRows(date, {
      useCache,
      dataset,
    });

    return rows.filter((row) => symbolSet.has(row.symbol));
  }

  async loadDailyAggregatesForSymbolChunks({
    date,
    symbols,
    chunkSize = 500,
    useCache = true,
    dataset,
  } = {}) {
    const parts = chunk(symbols || [], chunkSize);
    const out = [];

    for (const part of parts) {
      const partial = await this.loadDailyAggregatesForSymbols({
        date,
        symbols: part,
        useCache,
        dataset,
      });
      out.push(...partial);
    }

    return out;
  }
}

module.exports = {
  MassiveFlatfileService,
};
