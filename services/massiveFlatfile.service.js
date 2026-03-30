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

/**
 * Returns true for Saturday (6) and Sunday (0) – no exchange flatfiles exist
 * for non-trading days.
 */
function isWeekend(isoDate) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Returns true when an S3 error signals "object not found" (NoSuchKey / 404)
 * or "access denied" (403). A 403 from the Massive flatfile endpoint typically
 * means the subscription does not cover that particular date/dataset segment,
 * which is equivalent to "no data available" for our purposes.
 */
function isNoSuchKeyError(err) {
  if (!err) return false;
  const name = String(err.name || "");
  const code = String(err.code || err.Code || "");
  const status = err.$metadata?.httpStatusCode ?? err.$response?.statusCode;
  return (
    name === "NoSuchKey" ||
    code === "NoSuchKey" ||
    status === 404 ||
    status === 403
  );
}

/**
 * Returns true when a zlib/gunzip error indicates that the response body is
 * NOT a valid GZIP file. This happens when the S3-compatible endpoint returns
 * an XML or JSON error document instead of the actual flatfile – e.g. for
 * dates that have not yet been published or whose access is restricted.
 * These are permanent conditions; retrying will not help.
 */
function isGzipParseError(err) {
  if (!err) return false;
  const code = String(err.code || "");
  const msg = String(err.message || "").toLowerCase();
  return (
    code === "Z_DATA_ERROR" ||
    code === "Z_BUF_ERROR" ||
    code === "Z_STREAM_ERROR" ||
    msg.includes("incorrect header check") ||
    msg.includes("invalid block type") ||
    msg.includes("unknown compression method") ||
    msg.includes("invalid stored block")
  );
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

    // TTL for the per-month key listing cache (default: 10 minutes).
    // A shorter TTL keeps the set fresh for recently published dates while
    // still avoiding redundant ListObjectsV2 calls within a single run.
    this.monthKeyCacheTTLms =
      options.monthKeyCacheTTLms !== undefined
        ? options.monthKeyCacheTTLms
        : safeInt(env("MASSIVE_FLATFILES_MONTH_KEY_CACHE_TTL", "600000"), 600000);

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

    /**
     * Month-key listing cache for day_aggs_v1.
     * Prefix (e.g. "us_stocks_sip/day_aggs_v1/2026/03/") ->
     *   { keys: Set<string>, expiresAt: number }
     *
     * Populated by listAvailableKeysForMonth(); used by loadDailyAggFileRows()
     * to avoid blind GetObject calls for dates that are not published yet.
     */
    this._monthKeyCache = new Map();
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

        // NoSuchKey and GZIP parse errors are permanent conditions – retrying
        // will not help and only wastes time and quota.
        if (isNoSuchKeyError(err) || isGzipParseError(err)) break;

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

  /**
   * Returns a Set of all S3 keys that exist under the year/month prefix for
   * a given dataset, e.g. "us_stocks_sip/day_aggs_v1/2026/03/".
   *
   * The result is cached for `monthKeyCacheTTLms` milliseconds so that
   * repeated calls within the same batch do not trigger multiple
   * ListObjectsV2 requests for the same prefix.
   *
   * Returns `null` when the listing itself fails (network error, permissions,
   * etc.); callers should fall back to the normal GetObject path in that case
   * so that a transient ListObjects failure does not silently drop all rows.
   */
  async listAvailableKeysForMonth(dataset, year, month) {
    const prefix = `${dataset}/${year}/${month}/`;
    const cacheKey = `monthkeys:${prefix}`;

    const cached = this._monthKeyCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.keys;
    }

    // Prune expired entries to keep the cache bounded.  In normal usage at
    // most a handful of distinct year/month combinations are queried per run,
    // so this is a cheap safety net rather than a hot path.
    if (this._monthKeyCache.size >= 24) {
      const now = Date.now();
      for (const [k, entry] of this._monthKeyCache.entries()) {
        if (!entry || entry.expiresAt <= now) {
          this._monthKeyCache.delete(k);
        }
      }
    }

    logger.info("[MassiveFlatfileService] listing available keys for month", { prefix });

    let keys;
    try {
      const rawKeys = await this.listPrefix(prefix);
      keys = new Set(rawKeys);
      logger.info("[MassiveFlatfileService] month listing complete", {
        prefix,
        availableFiles: rawKeys.length,
      });
    } catch (err) {
      // Listing failed (e.g. network error, permission denied for the prefix).
      // Return null so that the caller can fall back to the regular GetObject
      // path rather than silently skipping all dates in this month.
      logger.warn("[MassiveFlatfileService] listAvailableKeysForMonth failed – will fall back to direct GetObject", {
        prefix,
        error: extractErrorContext(err),
      });
      return null;
    }

    this._monthKeyCache.set(cacheKey, {
      keys,
      expiresAt: Date.now() + this.monthKeyCacheTTLms,
    });

    return keys;
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
      // Downgrade "file not found" to warn – it is expected for holidays and
      // any date for which Massive has not yet published a flatfile.
      if (isNoSuchKeyError(err)) {
        logger.warn("[MassiveFlatfileService] streamCsvRowsFromGzipKey: object not found", {
          endpoint: this.endpoint,
          bucket: this.bucket,
          key,
          error: extractErrorContext(err),
        });
      } else if (isGzipParseError(err)) {
        // The server returned an XML/JSON error document instead of a real
        // GZIP file. Treat as "not available" – the date is not published yet
        // or the content is not accessible. No retry needed.
        logger.warn("[MassiveFlatfileService] streamCsvRowsFromGzipKey: response is not valid GZIP (error payload?)", {
          endpoint: this.endpoint,
          bucket: this.bucket,
          key,
          error: extractErrorContext(err),
        });
      } else {
        logger.error("[MassiveFlatfileService] streamCsvRowsFromGzipKey failed", {
          endpoint: this.endpoint,
          bucket: this.bucket,
          key,
          error: extractErrorContext(err),
        });
      }
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
    const iso = toIsoDate(date);
    if (!iso) throw new Error(`Invalid date: ${date}`);

    // Stock-exchange flatfiles are only published for trading days (Mon–Fri).
    // Skip weekends early to avoid guaranteed NoSuchKey errors.
    if (isWeekend(iso)) {
      logger.info("[MassiveFlatfileService] skipping weekend date – no flatfile available", {
        date: iso,
      });
      return [];
    }

    const key = this.buildDailyAggKey(date, options);

    const cached = options.useCache === false ? null : this._cacheGet(key);
    if (cached) {
      logger.info("[MassiveFlatfileService] flatfile cache hit", { key, rows: cached.length });
      return cached;
    }

    // For day_aggs_v1: list the month prefix first so we can skip dates that
    // are not published without issuing a blind GetObject that triggers
    // NoSuchKey.  The listing result is cached per year/month so repeated
    // single-date calls within the same batch are cheap.
    const dataset = options.dataset || env("MASSIVE_FLATFILES_DAILY_DATASET", "us_stocks_sip/day_aggs_v1");
    if (dataset.includes("day_aggs_v1")) {
      const [year, month, _day] = iso.split("-");
      const availableKeys = await this.listAvailableKeysForMonth(dataset, year, month);

      if (availableKeys !== null) {
        if (!availableKeys.has(key)) {
          logger.info(
            "[MassiveFlatfileService] day file not listed under month prefix – skipping (holiday / not yet published)",
            { key, date: iso, availableInMonth: availableKeys.size }
          );
          return [];
        }
        // Key is confirmed to exist – proceed directly to GetObject.
      }
      // availableKeys === null means the listing call itself failed; fall
      // through to the regular GetObject path so the date is not silently
      // dropped.
    }

    logger.info("[MassiveFlatfileService] loading flatfile", { key });

    const rows = [];

    try {
      await this.streamCsvRowsFromGzipKey(key, async (raw) => {
        const normalized = this.normalizeDailyAggRow(raw);
        if (!normalized) return;
        rows.push(normalized);
      });
    } catch (err) {
      // Holidays and future dates produce NoSuchKey – treat as "no data" rather
      // than a hard failure so the rest of the backfill can continue.
      // Gzip parse errors (Z_DATA_ERROR etc.) indicate the server returned an
      // XML/JSON error document instead of a real flatfile – same treatment.
      if (isNoSuchKeyError(err) || isGzipParseError(err)) {
        logger.warn(
          "[MassiveFlatfileService] flatfile not available – date is likely a holiday, not yet published, or returned an error payload",
          { key, date: iso }
        );
        return [];
      }
      throw err;
    }

    if (options.useCache !== false) {
      this._cacheSet(key, rows);
    }

    return rows;
  }

  /**
   * Given a dataset and a reference ISO date, returns the ISO date string of
   * the most-recent available day-aggregate file that is on or before the
   * reference date.
   *
   * Strategy:
   *  1. List the year/month prefix for the reference date (uses cache).
   *  2. Extract dates from matching keys (e.g. "…/2026-03-28.csv.gz").
   *  3. Return the latest date that is ≤ referenceDate.
   *  4. If the current month yields nothing, try the previous month once
   *     (handles month-boundary cases: first day of a new month where no
   *     files have been published yet).
   *
   * Returns null when no available date can be determined (e.g. listing
   * failed for both months or no matching keys were found).
   */
  async findLastAvailableDayAggDate(dataset, referenceDate) {
    const iso = toIsoDate(referenceDate);
    if (!iso) return null;

    const extractDatesFromKeys = (keys, maxIso) => {
      const dates = [];
      for (const key of keys) {
        const match = key.match(/(\d{4}-\d{2}-\d{2})\.csv\.gz$/);
        if (match && match[1] <= maxIso) {
          dates.push(match[1]);
        }
      }
      dates.sort();
      return dates;
    };

    const [year, month] = iso.split("-");

    // 1. Try the current month
    const currentKeys = await this.listAvailableKeysForMonth(dataset, year, month);
    if (currentKeys !== null) {
      const dates = extractDatesFromKeys(currentKeys, iso);
      if (dates.length > 0) {
        return dates[dates.length - 1];
      }
    }

    // 2. Fall back to the previous month (covers month-boundary situations)
    const prevDate = new Date(`${iso}T12:00:00Z`);
    prevDate.setUTCMonth(prevDate.getUTCMonth() - 1);
    const prevYear = String(prevDate.getUTCFullYear());
    const prevMonth = String(prevDate.getUTCMonth() + 1).padStart(2, "0");

    const prevKeys = await this.listAvailableKeysForMonth(dataset, prevYear, prevMonth);
    if (prevKeys !== null && prevKeys.size > 0) {
      const dates = extractDatesFromKeys(prevKeys, iso);
      if (dates.length > 0) {
        return dates[dates.length - 1];
      }
    }

    return null;
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
