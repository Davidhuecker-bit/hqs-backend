"use strict";

/**
 * Lightweight FX helper (USD → EUR)
 *
 * Resolution order for USD→EUR rate:
 *   1. In-process cache (< FX_CACHE_MS old)
 *   2. Live fetch from FX API
 *      → on success: persisted to fx_rates table as last-known-good
 *   3. Last-known-good from fx_rates table (Postgres-persistent)
 *   4. FX_STATIC_USD_EUR env var (emergency static fallback)
 *   5. No rate available → caller must skip the snapshot
 *
 * Optional ENV:
 *   FX_USD_EUR_URL      – override live FX API endpoint
 *   FX_CACHE_MS         – in-process cache TTL (default 15 min)
 *   FX_STATIC_USD_EUR   – emergency static fallback rate (e.g. 0.92)
 */

const axios = require("axios");
const { Pool } = require("pg");
const logger = require("../utils/logger");

const FX_URL =
  process.env.FX_USD_EUR_URL ||
  "https://api.exchangerate.host/latest?base=USD&symbols=EUR";
const FX_CACHE_MS = Number(process.env.FX_CACHE_MS || 15 * 60 * 1000); // 15 min
const PRICE_PRECISION_FACTOR = 1_000_000;

// Emergency static fallback – read once at startup
const _staticRaw =
  process.env.FX_STATIC_USD_EUR !== undefined
    ? Number(process.env.FX_STATIC_USD_EUR)
    : null;
const FX_FALLBACK_STATIC =
  _staticRaw !== null && Number.isFinite(_staticRaw) && _staticRaw > 0
    ? _staticRaw
    : null;

if (
  process.env.FX_STATIC_USD_EUR !== undefined &&
  FX_FALLBACK_STATIC === null
) {
  logger.warn("fx: invalid FX_STATIC_USD_EUR provided – ignoring", {
    raw: process.env.FX_STATIC_USD_EUR,
  });
}

// In-process rate cache
let cachedRate = null;
let cachedAt = 0;
let cachedSource = null;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── helpers ────────────────────────────────────────────────────────────────

function isValidRate(rate) {
  return Number.isFinite(rate) && rate > 0;
}

function convertUsdToEur(amount, rate) {
  // Explicit null/undefined guard: Number(null)=0 and Number(undefined)=NaN,
  // so we must reject null/undefined before converting to avoid storing 0 as EUR price.
  if (amount === null || amount === undefined) return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  if (!isValidRate(rate)) return null;
  return Math.round(n * rate * PRICE_PRECISION_FACTOR) / PRICE_PRECISION_FACTOR;
}

function storeCachedRate(rate, source) {
  cachedRate = rate;
  cachedAt = Date.now();
  cachedSource = source || null;
}

// ─── fx_rates table DDL ──────────────────────────────────────────────────────

async function ensureFxRatesTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fx_rates (
        id             SERIAL PRIMARY KEY,
        base_currency  TEXT        NOT NULL DEFAULT 'USD',
        quote_currency TEXT        NOT NULL DEFAULT 'EUR',
        rate           NUMERIC     NOT NULL,
        source         TEXT        NOT NULL DEFAULT 'live',
        fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS fx_rates_pair_fetched_idx
        ON fx_rates (base_currency, quote_currency, fetched_at DESC);
    `);
    logger.info("fx: fx_rates table ensured");
  } catch (err) {
    logger.warn("fx: ensureFxRatesTable failed", { message: err.message });
  }
}

// ─── persist last-known-good ─────────────────────────────────────────────────

async function persistLastKnownGood(rate, source) {
  if (!isValidRate(rate)) return;
  try {
    await pool.query(
      `INSERT INTO fx_rates (base_currency, quote_currency, rate, source, fetched_at)
       VALUES ('USD', 'EUR', $1, $2, NOW())`,
      [rate, source || "live"]
    );
    logger.info("fx: last-known-good rate persisted", {
      rate,
      source: source || "live",
    });
  } catch (err) {
    // Non-fatal – we continue even if persistence fails
    logger.warn("fx: could not persist last-known-good rate", {
      message: err.message,
    });
  }
}

// ─── load last-known-good from fx_rates ──────────────────────────────────────

async function loadLastKnownGoodFromFxRates() {
  try {
    const res = await pool.query(
      `SELECT rate, source, fetched_at
       FROM fx_rates
       WHERE base_currency = 'USD' AND quote_currency = 'EUR'
       ORDER BY fetched_at DESC
       LIMIT 1`
    );
    if (!res.rows.length) return null;
    const rate = Number(res.rows[0].rate);
    if (!isValidRate(rate)) return null;
    return {
      rate,
      source: res.rows[0].source || "stored",
      fetchedAt: res.rows[0].fetched_at
        ? new Date(res.rows[0].fetched_at).toISOString()
        : null,
    };
  } catch (err) {
    logger.warn("fx: fx_rates lookup failed", { message: err.message });
    return null;
  }
}

// ─── live fetch ──────────────────────────────────────────────────────────────

async function fetchUsdEurRate() {
  try {
    const response = await axios.get(FX_URL, { timeout: 8000 });
    // Use nullish coalescing to avoid false fallthrough on a numeric 0
    const data = response?.data ?? {};
    const raw =
      data.rates?.EUR ?? data.eur ?? data.EUR ?? null;
    const rate = raw !== null ? Number(raw) : null;
    if (isValidRate(rate)) {
      return rate;
    }
    throw new Error("FX response missing EUR rate");
  } catch (err) {
    logger.warn("fx: primary rate fetch failed", {
      message: err.message,
      url: FX_URL,
    });
    return null;
  }
}

// ─── main resolver ───────────────────────────────────────────────────────────

/**
 * Resolve the current USD→EUR rate using the 4-tier fallback chain.
 * Returns a numeric rate, or null if no rate is available.
 */
async function getUsdToEurRate({ forceRefresh = false } = {}) {
  const now = Date.now();

  // 0. In-process cache
  if (!forceRefresh && cachedRate && now - cachedAt < FX_CACHE_MS) {
    logger.info("fx: source used", {
      source: "cache",
      cachedFrom: cachedSource || "unknown",
      rate: cachedRate,
      ageMs: now - cachedAt,
    });
    return cachedRate;
  }

  // 1. Live fetch
  const liveRate = await fetchUsdEurRate();
  if (isValidRate(liveRate)) {
    storeCachedRate(liveRate, "live");
    logger.info("fx: live usd-eur fetched", { rate: liveRate, source: "live" });
    // Persist as last-known-good (non-blocking); errors already logged inside persistLastKnownGood
    persistLastKnownGood(liveRate, "live").catch(() => {});
    return liveRate;
  }

  // 2. Last-known-good from fx_rates table
  const stored = await loadLastKnownGoodFromFxRates();
  if (stored && isValidRate(stored.rate)) {
    storeCachedRate(stored.rate, "stored_fx_rates");
    logger.warn("fx: stored usd-eur rate used", {
      rate: stored.rate,
      source: stored.source,
      fetchedAt: stored.fetchedAt,
    });
    return stored.rate;
  }

  // 3. Static emergency fallback
  if (isValidRate(FX_FALLBACK_STATIC)) {
    storeCachedRate(FX_FALLBACK_STATIC, "static_fallback");
    logger.warn("fx: static usd-eur fallback used", {
      rate: FX_FALLBACK_STATIC,
      source: "FX_STATIC_USD_EUR",
    });
    return FX_FALLBACK_STATIC;
  }

  // 4. No rate available
  logger.warn("fx: no usable usd-eur rate available", {
    liveOk: false,
    storedOk: false,
    staticOk: false,
  });
  return null;
}

/**
 * Actively fetch and persist the current USD→EUR rate.
 * Designed to be called from cron jobs (e.g. snapshotScan) so that
 * fx_rates always has a recent row, even when no snapshot conversion
 * happens to trigger the passive persist path.
 *
 * Returns the persisted rate, or null if fetch failed.
 */
async function refreshAndPersistFxRate() {
  try {
    await ensureFxRatesTable();
    const liveRate = await fetchUsdEurRate();
    if (isValidRate(liveRate)) {
      await persistLastKnownGood(liveRate, "cron_refresh");
      storeCachedRate(liveRate, "cron_refresh");
      logger.info("fx: cron refresh persisted", { rate: liveRate });
      return liveRate;
    }
    // Live failed – try to refresh from stored as a health signal
    const stored = await loadLastKnownGoodFromFxRates();
    if (stored && isValidRate(stored.rate)) {
      storeCachedRate(stored.rate, "stored_fx_rates");
      logger.warn("fx: cron refresh – live failed, reusing stored rate", {
        rate: stored.rate,
        fetchedAt: stored.fetchedAt,
      });
      return stored.rate;
    }
    logger.warn("fx: cron refresh – no rate available");
    return null;
  } catch (err) {
    logger.warn("fx: refreshAndPersistFxRate failed", { message: err.message });
    return null;
  }
}

module.exports = {
  getUsdToEurRate,
  convertUsdToEur,
  ensureFxRatesTable,
  refreshAndPersistFxRate,
};
