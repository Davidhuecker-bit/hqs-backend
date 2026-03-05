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

// 6h Cache (Historical ändert sich kaum)
const cache = new NodeCache({ stdTTL: 6 * 60 * 60, checkperiod: 10 * 60 });

const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;

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

  if (p === "1y" || p === "1year" || p === "12m") return 400; // Puffer wegen WE/Feiertage

  // ✅ NEW: 5 years shorthand
  if (p === "5y" || p === "5years") return 3650;

  // ✅ max (bei Massive kostenlos bis 5 Jahre bei dir möglich)
  if (p === "max") return 3650;

  return 400;
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
  return String(url || "").replace(/apiKey=[^&]+/i, "apiKey=***");
}

/**
 * Massive/Polygon-like aggregates historical
 * Returns: [{ date: "YYYY-MM-DD", close: number }] oldest->newest
 *
 * IMPORTANT:
 * - Accepts status "OK" and "DELAYED"
 * - If delayed/no results -> returns [] (does NOT throw), so snapshots can still run
 * - ✅ NEW: if "max" returns empty, fallback to "1y"
 */
async function getHistoricalPrices(symbol, period = "1y") {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) throw new Error("Symbol is required");

  if (!MASSIVE_API_KEY) {
    const msg = "Missing MASSIVE_API_KEY (required for historical data)";
    if (logger?.error) logger.error(msg);
    throw new Error(msg);
  }

  const per = String(period || "1y").toLowerCase().trim();
  const days = periodToDays(per);

  const cacheKey = `massive_hist_${sym}_${per}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const to = new Date();
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const url =
    `https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(sym)}` +
    `/range/1/day/${fmtDate(from)}/${fmtDate(to)}` +
    `?adjusted=true&sort=asc&limit=5000&apiKey=${MASSIVE_API_KEY}`;

  const maxTries = 3;

  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      const res = await http.get(url);
      const data = res?.data;

      const status = String(data?.status || "").toUpperCase();

      // ✅ Accept OK and DELAYED
      if (status !== "OK" && status !== "DELAYED") {
        throw new Error(`Massive historical not OK (${data?.status || "no status"})`);
      }

      const results = Array.isArray(data?.results) ? data.results : [];

      // DELAYED & empty -> retry
      if (!results.length && status === "DELAYED" && attempt < maxTries) {
        if (logger?.warn) logger.warn("Massive historical delayed; retrying", { sym, attempt, period: per });
        await sleep(700 * attempt);
        continue;
      }

      // still empty -> no crash, return [] (but with fallback option)
      if (!results.length) {
        if (logger?.warn) {
          logger.warn("Massive historical returned no results", {
            sym,
            status,
            period: per,
            url: safeUrlWithoutKey(url),
          });
        }

        cache.set(cacheKey, []);

        // ✅ NEW: fallback if max/5y empty -> try 1y once
        if ((per === "max" || per === "5y" || per === "5years") && per !== "1y") {
          if (logger?.warn) logger.warn("Historical fallback to 1y", { sym, from: per });
          return await getHistoricalPrices(sym, "1y");
        }

        return [];
      }

      // normalize
      const normalized = results
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

      // optional debug if truncated
      if (logger?.info && results.length >= 5000) {
        logger.info("Historical hit limit=5000 (may be truncated)", { sym, period: per });
      }

      cache.set(cacheKey, normalized);
      return normalized;
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

      // final attempt -> no crash, return []
      const msg = `Massive historical fetch failed for ${sym}: ${err.message}`;
      if (logger?.error) logger.error("Historical Data Error", { message: msg });
      else console.error("Historical Data Error:", msg);

      cache.set(cacheKey, []);

      // ✅ NEW: fallback if max/5y fails hard -> try 1y once
      if ((per === "max" || per === "5y" || per === "5years") && per !== "1y") {
        if (logger?.warn) logger.warn("Historical fallback to 1y after error", { sym, from: per });
        return await getHistoricalPrices(sym, "1y");
      }

      return [];
    }
  }

  return [];
}

module.exports = { getHistoricalPrices };
