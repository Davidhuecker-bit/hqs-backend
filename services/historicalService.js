"use strict";

const axios = require("axios");
const NodeCache = require("node-cache");

// optional logger
let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

// 6h Cache
const cache = new NodeCache({ stdTTL: 6 * 60 * 60, checkperiod: 10 * 60 });

const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || "";

const http = axios.create({
  timeout: 20000,
  headers: {
    "User-Agent": "HQS-Backend/1.0",
    Accept: "application/json",
  },
});

function periodToDays(period) {
  const p = String(period || "1y").toLowerCase().trim();

  if (p === "1m") return 35;
  if (p === "3m") return 110;
  if (p === "6m") return 220;
  if (p === "1y" || p === "1year" || p === "12m") return 400;
  if (p === "5y" || p === "5years") return 3650;
  if (p === "max") return 3650;

  return 400;
}

function periodToTwelveInterval(period) {
  const p = String(period || "1y").toLowerCase().trim();

  if (p === "1m") return { interval: "1day", outputsize: 35 };
  if (p === "3m") return { interval: "1day", outputsize: 110 };
  if (p === "6m") return { interval: "1day", outputsize: 220 };
  if (p === "1y" || p === "1year" || p === "12m") return { interval: "1day", outputsize: 400 };
  if (p === "5y" || p === "5years" || p === "max") return { interval: "1day", outputsize: 5000 };

  return { interval: "1day", outputsize: 400 };
}

function fmtDate(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeUrlWithoutKey(url) {
  return String(url || "")
    .replace(/apiKey=[^&]+/gi, "apiKey=***")
    .replace(/apikey=[^&]+/gi, "apikey=***");
}

function normalizeMassiveHistorical(results = []) {
  return results
    .map((r) => {
      const close = Number(r?.c);
      if (!Number.isFinite(close) || close <= 0) return null;

      let date = null;
      if (Number.isFinite(Number(r?.t))) {
        date = new Date(Number(r.t)).toISOString().slice(0, 10);
      }

      return { date, close };
    })
    .filter(Boolean);
}

function normalizeTwelveHistorical(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((r) => {
      const close = Number(r?.close);
      if (!Number.isFinite(close) || close <= 0) return null;

      const date = r?.datetime ? String(r.datetime).slice(0, 10) : null;

      return { date, close };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/* =========================================================
   MASSIVE HISTORICAL
========================================================= */

async function fetchHistoricalFromMassive(sym, per) {
  if (!MASSIVE_API_KEY) {
    throw new Error("Missing MASSIVE_API_KEY");
  }

  const days = periodToDays(per);
  const to = new Date();
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const url =
    `https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(sym)}` +
    `/range/1/day/${fmtDate(from)}/${fmtDate(to)}` +
    `?adjusted=true&sort=asc&limit=5000&apiKey=${MASSIVE_API_KEY}`;

  const maxTries = Number(process.env.MASSIVE_RETRIES || 3);

  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      const res = await http.get(url);
      const data = res?.data;
      const status = String(data?.status || "").toUpperCase();

      if (status !== "OK" && status !== "DELAYED") {
        throw new Error(`Massive historical not OK (${data?.status || "no status"})`);
      }

      const results = Array.isArray(data?.results) ? data.results : [];

      if (!results.length && status === "DELAYED" && attempt < maxTries) {
        if (logger?.warn) {
          logger.warn("Massive historical delayed; retrying", {
            sym,
            attempt,
            period: per,
          });
        }
        await sleep(700 * attempt);
        continue;
      }

      if (!results.length) {
        if (logger?.warn) {
          logger.warn("Massive historical returned no results", {
            sym,
            status,
            period: per,
            url: safeUrlWithoutKey(url),
          });
        }
        return [];
      }

      if (logger?.info && results.length >= 5000) {
        logger.info("Historical hit limit=5000 (may be truncated)", {
          sym,
          period: per,
        });
      }

      return normalizeMassiveHistorical(results);
    } catch (err) {
      if (attempt < maxTries) {
        if (logger?.warn) {
          logger.warn("Massive historical fetch failed; retrying", {
            sym,
            attempt,
            period: per,
            message: err.message,
            url: safeUrlWithoutKey(url),
          });
        }
        await sleep(700 * attempt);
        continue;
      }

      throw err;
    }
  }

  return [];
}

/* =========================================================
   TWELVE DATA HISTORICAL FALLBACK
========================================================= */

async function fetchHistoricalFromTwelveData(sym, per) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error("Missing TWELVE_DATA_API_KEY");
  }

  const cfg = periodToTwelveInterval(per);

  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}` +
    `&interval=${cfg.interval}` +
    `&outputsize=${cfg.outputsize}` +
    `&apikey=${TWELVE_DATA_API_KEY}`;

  const maxTries = Number(process.env.TWELVE_DATA_RETRIES || 2);

  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      const res = await http.get(url);
      const data = res?.data || {};

      if (data?.status === "error") {
        throw new Error(data?.message || "Twelve Data historical error");
      }

      const values = Array.isArray(data?.values) ? data.values : [];

      if (!values.length) {
        if (logger?.warn) {
          logger.warn("Twelve Data historical returned no results", {
            sym,
            period: per,
            url: safeUrlWithoutKey(url),
          });
        }
        return [];
      }

      return normalizeTwelveHistorical(values);
    } catch (err) {
      if (attempt < maxTries) {
        if (logger?.warn) {
          logger.warn("Twelve Data historical fetch failed; retrying", {
            sym,
            attempt,
            period: per,
            message: err.message,
            url: safeUrlWithoutKey(url),
          });
        }
        await sleep(700 * attempt);
        continue;
      }

      throw err;
    }
  }

  return [];
}

/* =========================================================
   MAIN HISTORICAL API
========================================================= */

async function getHistoricalPrices(symbol, period = "1y") {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) throw new Error("Symbol is required");

  const per = String(period || "1y").toLowerCase().trim();
  const cacheKey = `historical_${sym}_${per}`;

  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const massiveData = await fetchHistoricalFromMassive(sym, per);

    if (massiveData.length) {
      cache.set(cacheKey, massiveData);
      return massiveData;
    }

    if ((per === "max" || per === "5y" || per === "5years") && per !== "1y") {
      if (logger?.warn) logger.warn("Historical fallback to 1y after empty Massive result", { sym, from: per });
      const fallbackData = await getHistoricalPrices(sym, "1y");
      cache.set(cacheKey, fallbackData);
      return fallbackData;
    }

    if (!TWELVE_DATA_API_KEY) {
      cache.set(cacheKey, []);
      return [];
    }
  } catch (err) {
    const msg = `Massive historical failed for ${sym}: ${err.message}`;
    if (logger?.warn) logger.warn(msg);
    else console.warn("⚠️ " + msg);
  }

  if (!TWELVE_DATA_API_KEY) {
    cache.set(cacheKey, []);
    return [];
  }

  try {
    const twelveData = await fetchHistoricalFromTwelveData(sym, per);

    if (twelveData.length) {
      cache.set(cacheKey, twelveData);

      if (logger?.info) {
        logger.info("Historical fallback success", {
          symbol: sym,
          provider: "TWELVE_DATA",
          period: per,
        });
      }

      return twelveData;
    }

    if ((per === "max" || per === "5y" || per === "5years") && per !== "1y") {
      if (logger?.warn) logger.warn("Historical fallback to 1y after empty Twelve Data result", { sym, from: per });
      const fallbackData = await getHistoricalPrices(sym, "1y");
      cache.set(cacheKey, fallbackData);
      return fallbackData;
    }

    cache.set(cacheKey, []);
    return [];
  } catch (err) {
    const msg = `All historical providers failed for ${sym}: ${err.message}`;

    if (logger?.error) logger.error("Historical Data Error", { message: msg });
    else console.error("Historical Data Error:", msg);

    if ((per === "max" || per === "5y" || per === "5years") && per !== "1y") {
      if (logger?.warn) logger.warn("Historical fallback to 1y after provider errors", { sym, from: per });
      const fallbackData = await getHistoricalPrices(sym, "1y");
      cache.set(cacheKey, fallbackData);
      return fallbackData;
    }

    cache.set(cacheKey, []);
    return [];
  }
}

module.exports = { getHistoricalPrices };
