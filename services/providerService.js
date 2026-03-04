"use strict";

// services/providerService.js
// HQS Massive Provider (Primary Source)
// Clean, normalized, snapshot-ready

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

function calcChangesPercentage(price, previousClose) {
  const p = num(price);
  const prev = num(previousClose);
  if (!p || !prev) return null;
  return ((p - prev) / prev) * 100;
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
  // Best approximation: previous close ≈ open (same session) if nothing else.
  // If your provider has a better field for previous close, swap it here.
  const previousClose = open ?? close;

  const changesPercentage = calcChangesPercentage(close, previousClose);
  const change = (close !== null && previousClose !== null) ? close - previousClose : null;

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

  const response = await axios.get(url, { timeout: 15000 });

  const data = response?.data;
  if (!data || data.status !== "OK") {
    throw new Error(`Massive response not OK (${data?.status || "no status"})`);
  }

  if (!Array.isArray(data.results) || data.results.length === 0) {
    throw new Error("Massive returned empty results");
  }

  const normalized = normalizeMassiveData(data.results[0], sym);

  return [normalized];
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
