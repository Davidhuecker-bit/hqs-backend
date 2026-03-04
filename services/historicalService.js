"use strict";

const axios = require("axios");
const NodeCache = require("node-cache");

// optional logger (falls vorhanden)
let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

// 6h Cache, weil historische Daten sich nicht minütlich ändern
const cache = new NodeCache({ stdTTL: 6 * 60 * 60, checkperiod: 10 * 60 });

const API_KEY = process.env.FMP_API_KEY;
const BASE_URL = "https://financialmodelingprep.com/api/v3";

/**
 * period options:
 * - "1m"  (≈ 30 trading days)
 * - "3m"  (≈ 90)
 * - "6m"  (≈ 180)
 * - "1y"  (≈ 252)
 * - "max" (no limit)
 */
function periodToLimit(period) {
  const p = String(period || "1y").toLowerCase();
  if (p === "1m") return 30;
  if (p === "3m") return 90;
  if (p === "6m") return 180;
  if (p === "1y" || p === "1year") return 252;
  if (p === "max") return null;
  // fallback
  return 252;
}

async function getHistoricalPrices(symbol, period = "1y") {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) throw new Error("Symbol is required");

  if (!API_KEY) {
    const msg = "Missing FMP_API_KEY in environment variables";
    if (logger?.error) logger.error(msg);
    throw new Error(msg);
  }

  const limit = periodToLimit(period);
  const cacheKey = `hist_${sym}_${String(period).toLowerCase()}`;

  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const url = `${BASE_URL}/historical-price-full/${sym}?serietype=line&apikey=${API_KEY}`;
    const response = await axios.get(url, { timeout: 15000 });

    const payload = response?.data || {};
    const arr = Array.isArray(payload.historical) ? payload.historical : [];

    // FMP liefert meist newest->oldest. Für Trend/Momentum ist Konsistenz wichtig.
    // Wir lassen es wie geliefert und behandeln das später konsistent.
    let data = arr;

    // limit anwenden (wenn gewünscht)
    if (limit && data.length > limit) {
      data = data.slice(0, limit);
    }

    cache.set(cacheKey, data);
    return data;
  } catch (error) {
    const msg = `Failed to fetch historical data for ${sym}: ${error.message}`;
    if (logger?.error) logger.error("Historical Data Error", { message: msg });
    else console.error("Historical Data Error:", msg);
    throw new Error(msg);
  }
}

module.exports = { getHistoricalPrices };
