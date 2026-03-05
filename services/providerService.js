"use strict";

// services/providerService.js
// HQS Massive Provider (Primary Source)
// Clean, normalized, snapshot-ready
// ✅ Enterprise-safe: retry, backoff, better error logs (no API key leak)

const axios = require("axios");

// optional logger (falls vorhanden)
let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

// ============================
// ENV
// ============================

const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;

if (!MASSIVE_API_KEY) {
  const msg = "MASSIVE_API_KEY is not set in environment variables";
  if (logger?.warn) logger.warn(msg);
  else console.warn("⚠️ " + msg);
}

function num(x, fallback = null) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function hasNum(x) {
  return x !== null && x !== undefined && Number.isFinite(Number(x));
}

function calcChangesPercentage(price, previousClose) {
  const p = num(price, null);
  const prev = num(previousClose, null);
  if (!hasNum(p) || !hasNum(prev) || Number(prev) === 0) return null;
  return ((p - prev) / prev) * 100;
}

// ============================
// AXIOS INSTANCE
// ============================

const http = axios.create({
  timeout: 15000,
  headers: {
    "User-Agent": "HQS-Backend/1.0",
    Accept: "application/json",
  },
});

// backoff helper
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function shouldRetry(err) {
  const status = err?.response?.status;
  if (!status) {
    // network / timeout / dns
    return true;
  }
  // retry on rate limit and server errors
  return status === 429 || (status >= 500 && status <= 599);
}

function safeUrlWithoutKey(url) {
  // remove apiKey from logs
  return String(url || "").replace(/apiKey=[^&]+/i, "apiKey=***");
}

// ============================
// NORMALIZER
// ============================

function normalizeMassiveData(raw, symbolFallback) {
  // raw fields (Polygon-like):
  // T ticker, c close, o open, h high, l low, v volume
  const symbol = String(raw?.T || symbolFallback || "").toUpperCase();

  const close = num(raw?.c, null);
  const open = num(raw?.o, null);

  // We don't truly have previousClose from "prev" unless provider gives it.
  // fallback: open, else close
  const previousClose = open !== null ? open : close;

  const changesPercentage = calcChangesPercentage(close, previousClose);
  const change =
    hasNum(close) && hasNum(previousClose) ? Number(close) - Number(previousClose) : null;

  return {
    symbol,
    price: close,
    open,
    high: num(raw?.h, null),
    low: num(raw?.l, null),
    previousClose,
    change,
    changesPercentage,
    volume: num(raw?.v, null),
    source: "MASSIVE",
    timestamp: Date.now(),
  };
}

// ============================
// FETCH FROM MASSIVE
// ============================

async function fetchFromMassive(symbol) {
  if (!MASSIVE_API_KEY) {
    throw new Error("Missing MASSIVE_API_KEY");
  }

  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) throw new Error("Missing symbol");

  const url = `https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(
    sym
  )}/prev?apiKey=${MASSIVE_API_KEY}`;

  const maxTries = Number(process.env.MASSIVE_RETRIES || 3);

  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      const response = await http.get(url);
      const data = response?.data;

      const status = String(data?.status || "").toUpperCase();

      if (!data || status !== "OK") {
        throw new Error(`Massive response not OK (${data?.status || "no status"})`);
      }

      if (!Array.isArray(data.results) || data.results.length === 0) {
        throw new Error("Massive returned empty results");
      }

      const normalized = normalizeMassiveData(data.results[0], sym);
      return [normalized];
    } catch (err) {
      const status = err?.response?.status;
      const msg = `Massive fetch failed (attempt ${attempt}/${maxTries}) for ${sym}: ${err.message}`;

      if (logger?.warn) {
        logger.warn(msg, {
          status: status ?? null,
          url: safeUrlWithoutKey(url),
        });
      } else {
        console.warn("⚠️ " + msg);
      }

      const retry = attempt < maxTries && shouldRetry(err);
      if (!retry) throw err;

      // simple backoff
      await sleep(400 * attempt);
    }
  }

  throw new Error("Massive fetch failed after retries");
}

// ============================
// MAIN FETCH
// ============================

async function fetchQuote(symbol) {
  try {
    return await fetchFromMassive(symbol);
  } catch (error) {
    const msg = `Massive failed for ${symbol}: ${error.message}`;
    if (logger?.error) logger.error(msg);
    else console.error("❌ " + msg);
    throw error;
  }
}

// ============================
// EXPORT
// ============================

module.exports = {
  fetchQuote,
};
