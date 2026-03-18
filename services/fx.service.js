"use strict";

/**
 * Lightweight FX helper (USD → EUR)
 * - primary source: exchangerate.host (no key required)
 * - cache to avoid per-symbol HTTP calls
 * - defensive fallback: FX_STATIC_USD_EUR env value (documented, manual)
 */

const axios = require("axios");
const { Pool } = require("pg");
const logger = require("../utils/logger");

const FX_URL =
  process.env.FX_USD_EUR_URL ||
  "https://api.exchangerate.host/latest?base=USD&symbols=EUR";
const FX_CACHE_MS = Number(process.env.FX_CACHE_MS || 15 * 60 * 1000); // 15m
const PRICE_PRECISION_FACTOR = 1_000_000;
const FX_FALLBACK_STATIC =
  process.env.FX_STATIC_USD_EUR !== undefined
    ? Number(process.env.FX_STATIC_USD_EUR)
    : null;

if (process.env.FX_STATIC_USD_EUR !== undefined && !isValidRate(FX_FALLBACK_STATIC)) {
  logger.warn("fx: invalid FX_STATIC_USD_EUR provided – ignoring", {
    raw: process.env.FX_STATIC_USD_EUR,
  });
}

let cachedRate = null;
let cachedAt = 0;
let cachedSource = null;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

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

async function loadLastStoredUsdEurRate() {
  try {
    const res = await pool.query(
      `SELECT fx_rate, created_at
       FROM market_snapshots
       WHERE fx_rate IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1`
    );
    if (!res.rows.length) return null;

    const rate = Number(res.rows[0].fx_rate);
    if (!isValidRate(rate)) return null;

    return {
      rate,
      createdAt: res.rows[0].created_at
        ? new Date(res.rows[0].created_at).toISOString()
        : null,
    };
  } catch (err) {
    logger.warn("fx: stored rate lookup failed", {
      message: err.message,
    });
    return null;
  }
}

async function fetchUsdEurRate() {
  try {
    const response = await axios.get(FX_URL, { timeout: 8000 });
    const rate =
      Number(response?.data?.rates?.EUR) ||
      Number(response?.data?.eur) ||
      Number(response?.data?.EUR);
    if (isValidRate(rate)) {
      logger.info("fx: fetched USD→EUR rate", { rate });
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

async function getUsdToEurRate({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cachedRate && now - cachedAt < FX_CACHE_MS) {
    logger.info("fx: source used", {
      source: "cache",
      cachedFrom: cachedSource || "unknown",
      rate: cachedRate,
      ageMs: now - cachedAt,
    });
    return cachedRate;
  }

  const liveRate = await fetchUsdEurRate();
  if (isValidRate(liveRate)) {
    storeCachedRate(liveRate, "live");
    logger.info("fx: source used", {
      source: "live",
      rate: liveRate,
    });
    return liveRate;
  }

  if (isValidRate(FX_FALLBACK_STATIC)) {
    logger.warn("fx: using static fallback rate", {
      rate: FX_FALLBACK_STATIC,
    });
    storeCachedRate(FX_FALLBACK_STATIC, "static_fallback");
    logger.info("fx: source used", {
      source: "static_fallback",
      rate: FX_FALLBACK_STATIC,
    });
    return FX_FALLBACK_STATIC;
  }

  const storedRate = await loadLastStoredUsdEurRate();
  if (isValidRate(storedRate?.rate)) {
    logger.warn("fx: using last stored market snapshot rate", {
      rate: storedRate.rate,
      createdAt: storedRate.createdAt,
    });
    storeCachedRate(storedRate.rate, "last_stored_market_snapshot");
    logger.info("fx: source used", {
      source: "last_stored_market_snapshot",
      rate: storedRate.rate,
      createdAt: storedRate.createdAt,
    });
    return storedRate.rate;
  }

  logger.warn("fx: no USD→EUR rate available (live + static + stored missing)");
  return null;
}

module.exports = {
  getUsdToEurRate,
  convertUsdToEur,
};
