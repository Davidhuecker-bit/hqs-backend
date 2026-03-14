"use strict";

/*
  Inter-Market Correlation Service
  ---------------------------------
  Provides early-warning indicators for the stock portfolio by fetching
  real-time (or cached) BTC/USD and Gold spot prices from free public APIs.

  BTC source  : CoinGecko public API (no key required)
  Gold source : Yahoo Finance chart API (no key required)

  Both fetches degrade gracefully when the network is unavailable.
  Results are cached in memory for CACHE_TTL_MS milliseconds.
*/

const axios = require("axios");
const logger = require("../utils/logger");

/* =========================================================
   CACHE
========================================================= */

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let _cache = null;
let _cacheTs = 0;

function getCached() {
  if (_cache && Date.now() - _cacheTs < CACHE_TTL_MS) return _cache;
  return null;
}

function setCache(value) {
  _cache = value;
  _cacheTs = Date.now();
}

/* =========================================================
   FETCH HELPERS
========================================================= */

const FETCH_TIMEOUT_MS = 8000;

async function fetchBtcUsd() {
  try {
    const resp = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price",
      {
        params: {
          ids: "bitcoin",
          vs_currencies: "usd",
          include_24hr_change: "true",
        },
        timeout: FETCH_TIMEOUT_MS,
        headers: { Accept: "application/json" },
      }
    );
    const data = resp?.data?.bitcoin;
    if (!data) return null;
    return {
      price: Number(data.usd) || null,
      change24h: Number(data.usd_24h_change) || 0,
    };
  } catch (err) {
    logger.warn("interMarket: BTC fetch failed", { message: err.message });
    return null;
  }
}

async function fetchGoldUsd() {
  try {
    // Yahoo Finance: GC=F = Gold Futures (continuous front-month)
    const resp = await axios.get(
      "https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF",
      {
        params: { interval: "1d", range: "2d" },
        timeout: FETCH_TIMEOUT_MS,
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0",
        },
      }
    );
    const result = resp?.data?.chart?.result?.[0];
    if (!result) return null;

    const closes = result?.indicators?.quote?.[0]?.close || [];
    const currentClose = closes[closes.length - 1];
    const prevClose = closes[closes.length - 2] ?? currentClose;

    if (!currentClose) return null;

    const change24h =
      prevClose && prevClose !== 0
        ? ((currentClose - prevClose) / prevClose) * 100
        : 0;

    return {
      price: Number(currentClose.toFixed(2)),
      change24h: Number(change24h.toFixed(2)),
    };
  } catch (err) {
    logger.warn("interMarket: Gold fetch failed", { message: err.message });
    return null;
  }
}

/* =========================================================
   SIGNAL CLASSIFICATION
========================================================= */

/**
 * Classifies a single asset's 24h change into a directional signal.
 *
 * @param {number|null} change24h  percentage change over 24 h
 * @returns {"bullish"|"bearish"|"neutral"}
 */
function classifyAssetSignal(change24h) {
  if (change24h === null || change24h === undefined) return "neutral";
  if (change24h > 1.5) return "bullish";
  if (change24h < -1.5) return "bearish";
  return "neutral";
}

/**
 * Derives an early-warning flag.
 * earlyWarning = true when BOTH BTC and Gold turn bearish simultaneously –
 * a historically reliable 'risk-off' precursor for equities.
 *
 * @param {string} btcSignal
 * @param {string} goldSignal
 * @returns {boolean}
 */
function deriveEarlyWarning(btcSignal, goldSignal) {
  return btcSignal === "bearish" && goldSignal === "bearish";
}

/* =========================================================
   MAIN EXPORT
========================================================= */

/**
 * Returns the latest inter-market correlation snapshot.
 * Results are in-process cached for CACHE_TTL_MS.
 *
 * @returns {Promise<{
 *   btc:  { price: number|null, change24h: number, signal: string }|null,
 *   gold: { price: number|null, change24h: number, signal: string }|null,
 *   earlyWarning: boolean,
 *   timestamp: string
 * }>}
 */
async function getInterMarketCorrelation() {
  const cached = getCached();
  if (cached) return cached;

  const [btcRaw, goldRaw] = await Promise.all([fetchBtcUsd(), fetchGoldUsd()]);

  const btcSignal = classifyAssetSignal(btcRaw?.change24h ?? null);
  const goldSignal = classifyAssetSignal(goldRaw?.change24h ?? null);

  const result = {
    btc: btcRaw
      ? {
          price: btcRaw.price,
          change24h: Number((btcRaw.change24h || 0).toFixed(2)),
          signal: btcSignal,
        }
      : null,
    gold: goldRaw
      ? {
          price: goldRaw.price,
          change24h: Number((goldRaw.change24h || 0).toFixed(2)),
          signal: goldSignal,
        }
      : null,
    earlyWarning: deriveEarlyWarning(btcSignal, goldSignal),
    timestamp: new Date().toISOString(),
  };

  setCache(result);

  logger.info("interMarket: snapshot refreshed", {
    btcSignal,
    goldSignal,
    earlyWarning: result.earlyWarning,
  });

  return result;
}

module.exports = {
  getInterMarketCorrelation,
  classifyAssetSignal,
  deriveEarlyWarning,
};
