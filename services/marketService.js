// services/marketService.js
// Phase 1 – Snapshot Hardening
// Rate-limit-safe, dedup, in-memory cache, never crashes.

"use strict";

const { getUSQuote } = require("./providerService");
const { buildHQSResponse } = require("../hqsEngine");
const { Redis } = require("@upstash/redis");
const { Pool } = require("pg");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const DEFAULT_SYMBOLS = (process.env.GUARDIAN_SYMBOLS || "AAPL,MSFT,NVDA,AMD")
  .split(",")
  .map((s) => String(s || "").trim().toUpperCase())
  .filter((s) => /^[A-Z0-9.-]{1,12}$/.test(s));

// ============================
// SLEEP
// ============================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================
// IN-MEMORY SYMBOL CACHE
// TTL: 60 seconds
// ============================

const symbolMemCache = new Map();
const SYMBOL_CACHE_TTL_MS = 60 * 1000;

function memCacheGet(symbol) {
  const entry = symbolMemCache.get(symbol);
  if (!entry) return null;
  if (Date.now() - entry.ts > SYMBOL_CACHE_TTL_MS) {
    symbolMemCache.delete(symbol);
    return null;
  }
  return entry.data;
}

function memCacheSet(symbol, data) {
  symbolMemCache.set(symbol, { data, ts: Date.now() });
}

// ============================
// SAFE NORMALIZER
// ============================

function safeNull(value) {
  const n = Number(value);
  return isNaN(n) ? null : n;
}

function normalizeMarketItem(raw, source) {
  if (!raw || typeof raw !== "object") return null;
  const symbol = String(raw.symbol || "").trim().toUpperCase();
  if (!symbol) return null;
  return {
    symbol,
    price: safeNull(raw.price),
    change: safeNull(raw.change),
    changesPercentage: safeNull(raw.changesPercentage),
    high: safeNull(raw.high),
    low: safeNull(raw.low),
    open: safeNull(raw.open),
    previousClose: safeNull(raw.previousClose),
    source: String(source || "unknown"),
  };
}

// ============================
// TABLE CREATION
// ============================

async function ensureTablesExist() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS market_snapshots (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(20),
        price NUMERIC,
        hqs_score NUMERIC,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS prices_daily (
        symbol VARCHAR(20) NOT NULL,
        date DATE NOT NULL,
        open NUMERIC,
        high NUMERIC,
        low NUMERIC,
        close NUMERIC,
        volume NUMERIC,
        source VARCHAR(40) DEFAULT 'fmp',
        created_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (symbol, date)
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_prices_daily_symbol_date
      ON prices_daily (symbol, date);
    `);
    console.log("[MarketService] Tabellen geprueft/erstellt");
  } catch (err) {
    console.error("[MarketService] Table Creation Error:", err.message);
  }
}

// ============================
// REDIS CACHE
// ============================

async function readSnapshotCache() {
  try {
    const cached = await redis.get("market:snapshot");
    if (!cached) return null;
    return typeof cached === "string" ? JSON.parse(cached) : cached;
  } catch (err) {
    console.error("[MarketService] Cache Read Error:", err.message);
    return null;
  }
}

async function writeSnapshotCache(payload) {
  try {
    await redis.set("market:snapshot", JSON.stringify(payload), { ex: 60 });
  } catch (err) {
    console.error("[MarketService] Cache Write Error:", err.message);
  }
}

// ============================
// SAVE SNAPSHOT TO POSTGRES
// ============================

async function saveSnapshotToDB(results) {
  if (!Array.isArray(results) || results.length === 0) return;
  try {
    for (const item of results) {
      if (!item || !item.symbol) continue;
      await pool.query(
        `INSERT INTO market_snapshots (symbol, price, hqs_score) VALUES ($1, $2, $3)`,
        [item.symbol, item.price !== null ? item.price : 0, item.hqsScore !== null ? item.hqsScore : 0],
      );
    }
    console.log("[Snapshot] Saved " + results.length + " entries");
  } catch (err) {
    console.error("[MarketService] DB Insert Error:", err.message);
  }
}

// ============================
// FETCH SINGLE SYMBOL – never throws
// ============================

async function fetchSymbolData(symbol) {
  const memHit = memCacheGet(symbol);
  if (memHit) {
    console.log("[Snapshot] Cache Hit: " + symbol);
    return memHit;
  }

  try {
    const result = await getUSQuote(symbol);

    if (!result || !result.data) {
      console.warn("[MarketService] No data available for:", symbol);
      return null;
    }

    const source = result.provider || (result.fallbackUsed ? "alpha_vantage" : "fmp");
    let normalized = null;

    try {
      const hqsData = await buildHQSResponse(result.data);
      if (hqsData && typeof hqsData === "object") {
        normalized = normalizeMarketItem(Object.assign({}, result.data, hqsData), source);
      }
    } catch (hqsErr) {
      console.warn("[MarketService] HQS Engine fallback for " + symbol + ":", hqsErr.message);
    }

    if (!normalized) {
      normalized = normalizeMarketItem(result.data, source);
    }

    if (normalized) memCacheSet(symbol, normalized);

    return normalized;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg.includes("FMP")) {
      console.warn("[MarketService] FMP failed for " + symbol + ":", msg);
    } else if (msg.includes("Alpha") || msg.includes("alpha")) {
      console.warn("[MarketService] Alpha fallback used for " + symbol + ":", msg);
    } else {
      console.warn("[MarketService] No data available for " + symbol + ":", msg);
    }
    return null;
  }
}

// ============================
// SNAPSHOT BUILDER
// Rate-limit-safe: 200ms delay between symbols.
// Dedup via seen Set.
// Never crashes.
// ============================

async function buildMarketSnapshot() {
  const results = [];
  const seen = new Set();

  for (const symbol of DEFAULT_SYMBOLS) {
    if (seen.has(symbol)) continue;
    seen.add(symbol);

    console.log("[Snapshot] Processing " + symbol);

    const item = await fetchSymbolData(symbol);
    if (item) results.push(item);

    await sleep(200);
  }

  if (results.length === 0) {
    console.warn("[MarketService] No data available - snapshot empty, using cache.");
    const staleData = await readSnapshotCache();
    return Array.isArray(staleData) ? staleData : [];
  }

  await writeSnapshotCache(results);
  await saveSnapshotToDB(results);

  console.log("[Snapshot] Completed without crash");
  return results;
}

// ============================
// getMarketData(symbol?)
// Always Array. Never undefined/null/crash.
// ============================

async function getMarketData(symbol) {
  if (symbol) {
    const safeSymbol = String(symbol || "").trim().toUpperCase();
    if (!safeSymbol || !/^[A-Z0-9.-]{1,12}$/.test(safeSymbol)) return [];
    const item = await fetchSymbolData(safeSymbol);
    return item ? [item] : [];
  }

  try {
    const cached = await readSnapshotCache();
    if (Array.isArray(cached) && cached.length > 0) {
      console.log("[MarketService] Snapshot Cache Hit");
      return cached;
    }
  } catch (err) {
    console.error("[MarketService] Cache Error:", err.message);
  }

  return buildMarketSnapshot();
}

// ============================
// EXPORTS
// ============================

module.exports = {
  getMarketData,
  buildMarketSnapshot,
  ensureTablesExist,
};