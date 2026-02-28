"use strict";

const axios = require("axios");
const { normalizeMarketData } = require("./marketNormalizer");

// ENV
const FMP_API_KEY = process.env.FMP_API_KEY;
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY;
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;

// REGION LOGIC
function resolveRegion(symbol) {
  if (symbol.endsWith(".HK")) return "china";
  if (symbol.endsWith(".T")) return "japan";
  if (symbol.endsWith(".NS")) return "india";
  return "us";
}

// ============================
// MASSIVE (Primary US)
// ============================

async function fetchFromMassive(symbol, region) {
  if (!MASSIVE_API_KEY) throw new Error("Massive key missing");

  const url = `https://api.massive.com/v2/aggs/ticker/${symbol}/prev?apiKey=${MASSIVE_API_KEY}`;

  const response = await axios.get(url);

  if (!response.data || !response.data.results?.length) {
    throw new Error("Massive returned empty data");
  }

  const r = response.data.results[0];

  const raw = {
    symbol,
    price: r.c,
    open: r.o,
    high: r.h,
    low: r.l,
    volume: r.v
  };

  return [normalizeMarketData(raw, "MASSIVE", region)];
}

// ============================
// FMP (Fallback)
// ============================

async function fetchFromFMP(symbol, region) {
  if (!FMP_API_KEY) throw new Error("FMP key missing");

  const url = `https://financialmodelingprep.com/stable/quote?symbol=${symbol}&apikey=${FMP_API_KEY}`;

  const response = await axios.get(url);

  if (!Array.isArray(response.data) || !response.data.length) {
    throw new Error("FMP returned empty");
  }

  return response.data.map(raw =>
    normalizeMarketData(raw, "FMP", region)
  );
}

// ============================
// ALPHA VANTAGE (Last fallback)
// ============================

async function fetchFromAlpha(symbol, region) {
  if (!ALPHA_VANTAGE_API_KEY) throw new Error("Alpha key missing");

  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${ALPHA_VANTAGE_API_KEY}`;

  const response = await axios.get(url);
  const quote = response.data?.["Global Quote"];

  if (!quote) throw new Error("Alpha returned empty");

  const raw = {
    symbol: quote["01. symbol"],
    price: quote["05. price"],
    open: quote["02. open"],
    high: quote["03. high"],
    low: quote["04. low"],
    previousClose: quote["08. previous close"],
    volume: quote["06. volume"]
  };

  return [normalizeMarketData(raw, "ALPHA_VANTAGE", region)];
}

// ============================
// ORCHESTRATOR
// ============================

async function fetchQuote(symbol) {
  const region = resolveRegion(symbol);

  if (region === "us") {
    try {
      return await fetchFromMassive(symbol, region);
    } catch (err) {
      console.warn("Massive failed, trying FMP...");
      try {
        return await fetchFromFMP(symbol, region);
      } catch {
        console.warn("FMP failed, trying Alpha...");
        return await fetchFromAlpha(symbol, region);
      }
    }
  }

  // Non-US
  try {
    return await fetchFromFMP(symbol, region);
  } catch {
    return await fetchFromAlpha(symbol, region);
  }
}

module.exports = { fetchQuote };
