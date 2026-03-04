"use strict";

const axios = require("axios");
const NodeCache = require("node-cache");

let logger = null;
try { logger = require("../utils/logger"); } catch (_) { logger = null; }

const cache = new NodeCache({ stdTTL: 6 * 60 * 60, checkperiod: 10 * 60 });

const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;

function periodToDays(period) {
  const p = String(period || "1y").toLowerCase();
  if (p === "1m") return 35;
  if (p === "3m") return 110;
  if (p === "6m") return 220;
  if (p === "1y" || p === "1year") return 400;
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

/**
 * Massive/Polygon-like aggregates historical
 * Returns: [{ date: "YYYY-MM-DD", close: number }] oldest->newest
 * IMPORTANT: Accepts status "OK" and "DELAYED"
 * If delayed/no results -> returns [] (does NOT throw), so snapshots can still run.
 */
async function getHistoricalPrices(symbol, period = "1y") {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) throw new Error("Symbol is required");

  if (!MASSIVE_API_KEY) {
    const msg = "Missing MASSIVE_API_KEY (required for historical data)";
    if (logger?.error) logger.error(msg);
    throw new Error(msg);
  }

  const days = periodToDays(period);
  const cacheKey = `massive_hist_${sym}_${String(period).toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const to = new Date();
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const url =
    `https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(sym)}` +
    `/range/1/day/${fmtDate(from)}/${fmtDate(to)}` +
    `?adjusted=true&sort=asc&limit=5000&apiKey=${MASSIVE_API_KEY}`;

  // Retry, falls "DELAYED" kurzzeitig ist
  const maxTries = 3;

  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      const res = await axios.get(url, { timeout: 20000 });
      const data = res?.data;

      const status = String(data?.status || "").toUpperCase();

      // ✅ Accept OK and DELAYED (we try to read results anyway)
      if (status !== "OK" && status !== "DELAYED") {
        throw new Error(`Massive historical not OK (${data?.status || "no status"})`);
      }

      const results = Array.isArray(data?.results) ? data.results : [];

      // Wenn delayed und leer: retry
      if (!results.length && status === "DELAYED" && attempt < maxTries) {
        if (logger?.warn) logger.warn("Massive historical delayed; retrying", { sym, attempt });
        await sleep(700 * attempt);
        continue;
      }

      // Wenn immer noch leer: KEIN throw -> leeres Array zurückgeben
      if (!results.length) {
        if (logger?.warn) logger.warn("Massive historical returned no results", { sym, status });
        cache.set(cacheKey, []);
        return [];
      }

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

      cache.set(cacheKey, normalized);
      return normalized;
    } catch (err) {
      if (attempt < maxTries) {
        if (logger?.warn) logger.warn("Massive historical fetch failed; retrying", { sym, attempt, message: err.message });
        await sleep(700 * attempt);
        continue;
      }

      // Final attempt: return [] (don’t kill snapshots)
      const msg = `Massive historical fetch failed for ${sym}: ${err.message}`;
      if (logger?.error) logger.error("Historical Data Error", { message: msg });
      else console.error("Historical Data Error:", msg);

      cache.set(cacheKey, []);
      return [];
    }
  }

  return [];
}

module.exports = { getHistoricalPrices };
