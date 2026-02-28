"use strict";

const axios = require("axios");
const { normalizeMarketData } = require("./marketNormalizer");

// ============================
// ENV
// ============================

const FMP_API_KEY = process.env.FMP_API_KEY;
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY;

// ============================
// REGION RESOLUTION
// ============================

function resolveRegion(symbol, regionOverride) {
  if (regionOverride) return regionOverride;

  if (symbol.endsWith(".HK")) return "china";
  if (symbol.endsWith(".T")) return "japan";
  if (symbol.endsWith(".NS")) return "india";

  return "us";
}

// ============================
// FMP FETCH
// ============================

async function fetchFromFMP(symbol, region) {
  if (!FMP_API_KEY) {
    throw new Error("FMP API key missing");
  }

  const url = `https://financialmodelingprep.com/stable/quote?symbol=${encodeURIComponent(
    symbol
  )}&apikey=${encodeURIComponent(FMP_API_KEY)}`;

  const response = await axios.get(url, { timeout: 10000 });

  if (!Array.isArray(response.data) || response.data.length === 0) {
    throw new Error("FMP returned empty array");
  }

  return response.data
    .map((raw) => normalizeMarketData(raw, "FMP", region))
    .filter(Boolean);
}

// ============================
// ALPHA VANTAGE FETCH
// ============================

async function fetchFromAlphaVantage(symbol, region) {
  if (!ALPHA_VANTAGE_API_KEY) {
    throw new Error("Alpha Vantage API key missing");
  }

  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(
    symbol
  )}&apikey=${encodeURIComponent(ALPHA_VANTAGE_API_KEY)}`;

  const response = await axios.get(url, { timeout: 10000 });

  const quote = response.data?.["Global Quote"];

  if (!quote || Object.keys(quote).length === 0) {
    throw new Error("Alpha Vantage returned empty quote");
  }

  const raw = {
    symbol: quote["01. symbol"],
    price: quote["05. price"],
    open: quote["02. open"],
    high: quote["03. high"],
    low: quote["04. low"],
    previousClose: quote["08. previous close"],
    volume: quote["06. volume"],
  };

  const normalized = normalizeMarketData(raw, "ALPHA_VANTAGE", region);
  return normalized ? [normalized] : [];
}

// ============================
// MAIN FETCH
// ============================

async function fetchQuote(symbol, regionOverride = null) {
  const region = resolveRegion(symbol, regionOverride);

  try {
    return await fetchFromFMP(symbol, region);
  } catch (fmpError) {
    console.warn(`⚠️ FMP failed for ${symbol}, trying Alpha Vantage...`);
    return await fetchFromAlphaVantage(symbol, region);
  }
}

// ============================
// EXPORT
// ============================

module.exports = {
  fetchQuote,
};
