"use strict";

const axios = require("axios");
const cache = require("../config/cache");

// optional logger
let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

const HISTORICAL_CACHE_TTL_SECONDS = Number(
  process.env.HISTORICAL_CACHE_TTL_SECONDS || 6 * 60 * 60
);

const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || "";
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || "";

if (!MASSIVE_API_KEY && !TWELVE_DATA_API_KEY && !FINNHUB_API_KEY) {
  const msg =
    "No historical data provider is configured. Set MASSIVE_API_KEY, TWELVE_DATA_API_KEY, or FINNHUB_API_KEY.";
  if (logger?.warn) logger.warn(msg);
  else console.warn("⚠️ " + msg);
}

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
   FINNHUB HISTORICAL (candle endpoint)
========================================================= */

async function fetchHistoricalFromFinnhub(sym, per) {
  if (!FINNHUB_API_KEY) throw new Error("Missing FINNHUB_API_KEY");

  const days = periodToDays(per);
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 24 * 60 * 60;

  const url =
    `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(sym)}` +
    `&resolution=D&from=${from}&to=${to}&token=${FINNHUB_API_KEY}`;

  const res = await http.get(url);
  const data = res?.data;

  if (!data || data.s !== "ok" || !Array.isArray(data.t) || !data.t.length) {
    return [];
  }

  return data.t
    .map((t, i) => {
      const close = Number(data.c?.[i]);
      if (!Number.isFinite(close) || close <= 0) return null;
      return {
        date: new Date(t * 1000).toISOString().slice(0, 10),
        close,
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/* =========================================================
   MAIN HISTORICAL API
========================================================= */

async function getHistoricalPrices(symbol, period = "1y") {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) throw new Error("Symbol is required");

  const per = String(period || "1y").toLowerCase().trim();
  const isLongRangePeriod =
    per === "max" || per === "5y" || per === "5years";
  const cacheKey = `historical_${sym}_${per}`;

  const cached = await cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const providers = [];
  if (MASSIVE_API_KEY) {
    providers.push({ name: "MASSIVE", fetcher: fetchHistoricalFromMassive });
  }
  if (TWELVE_DATA_API_KEY) {
    providers.push({
      name: "TWELVE_DATA",
      fetcher: fetchHistoricalFromTwelveData,
    });
  }
  if (FINNHUB_API_KEY) {
    providers.push({
      name: "FINNHUB",
      fetcher: fetchHistoricalFromFinnhub,
    });
  }

  if (!providers.length) {
    await cache.set(cacheKey, [], HISTORICAL_CACHE_TTL_SECONDS);
    return [];
  }

  for (let index = 0; index < providers.length; index++) {
    const provider = providers[index];

    try {
      const data = await provider.fetcher(sym, per);

      if (data.length) {
        await cache.set(cacheKey, data, HISTORICAL_CACHE_TTL_SECONDS);

        if (index > 0 && logger?.info) {
          logger.info("Historical fallback success", {
            symbol: sym,
            provider: provider.name,
            period: per,
          });
        }

        return data;
      }

      if (isLongRangePeriod && per !== "1y") {
        if (logger?.warn) {
          logger.warn(
            `Historical fallback to 1y after empty ${provider.name} result`,
            { sym, from: per }
          );
        }
        const fallbackData = await getHistoricalPrices(sym, "1y");
        await cache.set(cacheKey, fallbackData, HISTORICAL_CACHE_TTL_SECONDS);
        return fallbackData;
      }
    } catch (err) {
      const msg = `${provider.name} historical failed for ${sym}: ${err.message}`;
      if (logger?.warn) logger.warn(msg);
      else console.warn("⚠️ " + msg);
    }
  }

  if (isLongRangePeriod && per !== "1y") {
    if (logger?.warn) logger.warn("Historical fallback to 1y after provider errors", { sym, from: per });
    const fallbackData = await getHistoricalPrices(sym, "1y");
    await cache.set(cacheKey, fallbackData, HISTORICAL_CACHE_TTL_SECONDS);
    return fallbackData;
  }

  await cache.set(cacheKey, [], HISTORICAL_CACHE_TTL_SECONDS);
  return [];
}

module.exports = { getHistoricalPrices };
