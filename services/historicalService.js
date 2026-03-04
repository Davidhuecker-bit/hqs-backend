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

function periodToDays(period) {
  const p = String(period || "1y").toLowerCase();
  if (p === "1m") return 35;     // etwas Puffer
  if (p === "3m") return 110;
  if (p === "6m") return 220;
  if (p === "1y" || p === "1year") return 400; // Puffer für Wochenenden/Feiertage
  if (p === "max") return 3650;
  return 400;
}

function fmtDate(d) {
  // YYYY-MM-DD
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Returns array like: [{ date: "YYYY-MM-DD", close: number }]
 * sorted oldest -> newest
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

  const fromStr = fmtDate(from);
  const toStr = fmtDate(to);

  // Polygon-like aggregates endpoint (matches your /prev pattern)
  const url =
    `https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(sym)}` +
    `/range/1/day/${fromStr}/${toStr}` +
    `?adjusted=true&sort=asc&limit=5000&apiKey=${MASSIVE_API_KEY}`;

  try {
    const res = await axios.get(url, { timeout: 20000 });
    const data = res?.data;

    if (!data || data.status !== "OK") {
      throw new Error(`Massive historical not OK (${data?.status || "no status"})`);
    }

    const results = Array.isArray(data.results) ? data.results : [];

    // Normalize to {date, close}
    const normalized = results
      .map((r) => {
        const close = Number(r?.c);
        if (!Number.isFinite(close) || close <= 0) return null;

        // r.t is usually ms timestamp
        let date = null;
        if (Number.isFinite(Number(r?.t))) {
          date = new Date(Number(r.t)).toISOString().slice(0, 10);
        }

        // fallback if timestamp missing
        if (!date) date = null;

        return { date, close };
      })
      .filter(Boolean);

    cache.set(cacheKey, normalized);
    return normalized;
  } catch (err) {
    const msg = `Massive historical fetch failed for ${sym}: ${err.message}`;
    if (logger?.error) logger.error("Historical Data Error", { message: msg });
    else console.error("Historical Data Error:", msg);
    throw new Error(msg);
  }
}

module.exports = { getHistoricalPrices };
