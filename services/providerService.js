"use strict";

// services/providerService.js
// HQS Provider Service
// Primary: Massive
// Optional Fallback: Twelve Data
// Clean, normalized, snapshot-ready

const axios = require("axios");

// optional logger
let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

/* =========================================================
   ENV
========================================================= */

const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || "";

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

/* =========================================================
   AXIOS INSTANCE
========================================================= */

const http = axios.create({
  timeout: 15000,
  headers: {
    "User-Agent": "HQS-Backend/1.0",
    Accept: "application/json",
  },
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function shouldRetry(err) {
  const status = err?.response?.status;
  if (!status) return true;
  return status === 429 || (status >= 500 && status <= 599);
}

function safeUrlWithoutKey(url) {
  return String(url || "")
    .replace(/apiKey=[^&]+/gi, "apiKey=***")
    .replace(/apikey=[^&]+/gi, "apikey=***");
}

/* =========================================================
   NORMALIZERS
========================================================= */

function normalizeMassiveData(raw, symbolFallback) {
  const symbol = String(raw?.T || symbolFallback || "").toUpperCase();

  const close = num(raw?.c, null);
  const open = num(raw?.o, null);
  const previousClose = open !== null ? open : close;

  const changesPercentage = calcChangesPercentage(close, previousClose);
  const change =
    hasNum(close) && hasNum(previousClose)
      ? Number(close) - Number(previousClose)
      : null;

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

function normalizeTwelveData(raw, symbolFallback) {
  const symbol = String(raw?.symbol || symbolFallback || "").toUpperCase();

  const close = num(raw?.close ?? raw?.price, null);
  const open = num(raw?.open, close);
  const high = num(raw?.high, close);
  const low = num(raw?.low, close);
  const previousClose = num(raw?.previous_close, open !== null ? open : close);

  const changesPercentage = calcChangesPercentage(close, previousClose);
  const change =
    hasNum(close) && hasNum(previousClose)
      ? Number(close) - Number(previousClose)
      : null;

  return {
    symbol,
    price: close,
    open,
    high,
    low,
    previousClose,
    change,
    changesPercentage,
    volume: num(raw?.volume, null),
    source: "TWELVE_DATA",
    timestamp: Date.now(),
  };
}

/* =========================================================
   FETCH FROM MASSIVE
========================================================= */

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

      await sleep(400 * attempt);
    }
  }

  throw new Error("Massive fetch failed after retries");
}

/* =========================================================
   OPTIONAL FALLBACK: TWELVE DATA
========================================================= */

async function fetchFromTwelveData(symbol) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error("Missing TWELVE_DATA_API_KEY");
  }

  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) throw new Error("Missing symbol");

  const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(
    sym
  )}&apikey=${TWELVE_DATA_API_KEY}`;

  const maxTries = Number(process.env.TWELVE_DATA_RETRIES || 2);

  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      const response = await http.get(url);
      const data = response?.data || {};

      if (data?.status === "error") {
        throw new Error(data?.message || "Twelve Data error");
      }

      if (!data || (!data.close && !data.price)) {
        throw new Error("Twelve Data returned empty quote");
      }

      const normalized = normalizeTwelveData(data, sym);
      return [normalized];
    } catch (err) {
      const status = err?.response?.status;
      const msg = `Twelve Data fetch failed (attempt ${attempt}/${maxTries}) for ${sym}: ${err.message}`;

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

      await sleep(500 * attempt);
    }
  }

  throw new Error("Twelve Data fetch failed after retries");
}

/* =========================================================
   MAIN FETCH
========================================================= */

async function fetchQuote(symbol) {
  const sym = String(symbol || "").trim().toUpperCase();

  if (!sym) {
    throw new Error("fetchQuote called without symbol");
  }

  try {
    return await fetchFromMassive(sym);
  } catch (massiveError) {
    const massiveMsg = `Massive failed for ${sym}: ${massiveError.message}`;

    if (logger?.warn) logger.warn(massiveMsg);
    else console.warn("⚠️ " + massiveMsg);

    if (!TWELVE_DATA_API_KEY) {
      if (logger?.error) logger.error(massiveMsg);
      else console.error("❌ " + massiveMsg);
      throw massiveError;
    }

    try {
      const fallbackData = await fetchFromTwelveData(sym);

      if (logger?.info) {
        logger.info("Provider fallback success", {
          symbol: sym,
          provider: "TWELVE_DATA",
        });
      }

      return fallbackData;
    } catch (fallbackError) {
      const finalMsg = `All providers failed for ${sym}: Massive=${massiveError.message}; TwelveData=${fallbackError.message}`;

      if (logger?.error) logger.error(finalMsg);
      else console.error("❌ " + finalMsg);

      throw fallbackError;
    }
  }
}

/* =========================================================
   EXPORT
========================================================= */

module.exports = {
  fetchQuote,
};
