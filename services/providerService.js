"use strict";

/*
  Multi-Region Provider Service
  FMP (Primary) + Alpha Vantage (Fallback)
  Region aware + Normalized
*/

const axios = require("axios");
const path = require("path");

// 🔥 Absolute sichere Require-Variante (Linux safe)
const { normalizeMarketData } = require(path.join(
  __dirname,
  "normalizers",
  "marketNormalizer"
));

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

  if (!symbol) return "us";

  if (symbol.endsWith(".HK")) return "china";
  if (symbol.endsWith(".T")) return "japan";
  if (symbol.endsWith(".NS")) return "india";

  return "us";
}

// ============================
// FMP
// ============================

async function fetchFromFMP(symbol, region) {
  if (!FMP_API_KEY) {
    throw new Error("FMP_API_KEY not configured");
  }

  const url = `https://financialmodelingprep.com/stable/quote?symbol=${encodeURIComponent(
    symbol
  )}&apikey=${encodeURIComponent(FMP_API_KEY)}`;

  const response = await axios.get(url, { timeout: 10000 });

  if (!Array.isArray(response.data) || response.data.length === 0) {
    throw new Error("FMP returned empty array");
  }

  return response.data.map((raw) =>
    normalizeMarketData(raw, "FMP", region)
  );
}

// ============================
// ALPHA VANTAGE
// ============================

async function fetchFromAlphaVantage(symbol, region) {
  if (!ALPHA_VANTAGE_API_KEY) {
    throw new Error("ALPHA_VANTAGE_API_KEY not configured");
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

  return [normalizeMarketData(raw, "ALPHA_VANTAGE", region)];
}

// ============================
// MAIN FETCH
// ============================

async function fetchQuote(symbol, regionOverride = null) {
  const region = resolveRegion(symbol, regionOverride);

  try {
    return await fetchFromFMP(symbol, region);
  } catch (fmpError) {
    console.warn(
      `⚠️ FMP failed for ${symbol}, trying Alpha Vantage...`,
      fmpError.message
    );

    return await fetchFromAlphaVantage(symbol, region);
  }
}

// ============================
// EXPORTS
// ============================

module.exports = {
  fetchQuote,
};
