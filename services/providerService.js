// services/providerService.js
// FMP (Primary) + Alpha Vantage (Fallback)
// Mit globalem Market Normalizer

const axios = require("axios");
const { normalizeMarketData } = require("./normalizers/marketNormalizer");

// ============================
// ENV
// ============================

const FMP_API_KEY = process.env.FMP_API_KEY;
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY;

// ============================
// FMP QUOTE (STABLE ROUTE)
// ============================

async function fetchFromFMP(symbol) {
  const url = `https://financialmodelingprep.com/stable/quote?symbol=${encodeURIComponent(
    symbol,
  )}&apikey=${encodeURIComponent(FMP_API_KEY || "")}`;

  const response = await axios.get(url);

  if (!Array.isArray(response.data) || response.data.length === 0) {
    throw new Error("FMP returned empty array");
  }

  return response.data.map((raw) =>
    normalizeMarketData(raw, "FMP", "us"),
  );
}

// ============================
// ALPHA VANTAGE FALLBACK
// ============================

async function fetchFromAlphaVantage(symbol) {
  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(
    symbol,
  )}&apikey=${encodeURIComponent(ALPHA_VANTAGE_API_KEY || "")}`;

  const response = await axios.get(url);

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

  return [normalizeMarketData(raw, "ALPHA_VANTAGE", "us")];
}

// ============================
// MAIN FETCH
// ============================

async function fetchQuote(symbol) {
  try {
    return await fetchFromFMP(symbol);
  } catch (fmpError) {
    console.warn(`⚠️ FMP failed for ${symbol}, trying Alpha Vantage...`);
    return await fetchFromAlphaVantage(symbol);
  }
}

// ============================
// EXPORTS
// ============================

module.exports = {
  fetchQuote,
};
