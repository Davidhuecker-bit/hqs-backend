"use strict";

/**
 * Lightweight FX helper (USD → EUR)
 * - primary source: exchangerate.host (no key required)
 * - cache to avoid per-symbol HTTP calls
 * - defensive fallback: FX_STATIC_USD_EUR env value (documented, manual)
 */

const axios = require("axios");
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

function isValidRate(rate) {
  return Number.isFinite(rate) && rate > 0;
}

function convertUsdToEur(amount, rate) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  if (!isValidRate(rate)) return null;
  return Math.round(n * rate * PRICE_PRECISION_FACTOR) / PRICE_PRECISION_FACTOR;
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
    return cachedRate;
  }

  const liveRate = await fetchUsdEurRate();
  if (isValidRate(liveRate)) {
    cachedRate = liveRate;
    cachedAt = now;
    return liveRate;
  }

  if (isValidRate(FX_FALLBACK_STATIC)) {
    logger.warn("fx: using static fallback rate", {
      rate: FX_FALLBACK_STATIC,
    });
    cachedRate = FX_FALLBACK_STATIC;
    cachedAt = now;
    return FX_FALLBACK_STATIC;
  }

  logger.warn("fx: no USD→EUR rate available (live + fallback missing)");
  return null;
}

module.exports = {
  getUsdToEurRate,
  convertUsdToEur,
};
