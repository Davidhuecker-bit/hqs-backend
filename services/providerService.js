// services/providerService.js
// Massive Primary + FMP + Alpha fallback

const axios = require("axios");

const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;
const FMP_API_KEY = process.env.FMP_API_KEY;
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY;

// ==========================
// Massive (Primary)
// ==========================

async function fetchFromMassive(symbol) {
  const url = `https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(
    symbol
  )}/prev?apiKey=${encodeURIComponent(MASSIVE_API_KEY || "")}`;

  const response = await axios.get(url);

  if (!response.data || response.data.status !== "OK") {
    throw new Error("Massive returned invalid response");
  }

  const result = response.data.results?.[0];
  if (!result) throw new Error("Massive returned empty results");

  return [
    {
      symbol,
      price: result.c ?? null,
      open: result.o ?? null,
      high: result.h ?? null,
      low: result.l ?? null,
      volume: result.v ?? null,
      previousClose: result.c ?? null,
      change: null,
      changesPercentage: null,
      marketCap: null,
      source: "MASSIVE",
      timestamp: new Date(result.t).toISOString(),
    },
  ];
}

// ==========================
// FMP (Fallback)
// ==========================

async function fetchFromFMP(symbol) {
  const url = `https://financialmodelingprep.com/stable/quote?symbol=${encodeURIComponent(
    symbol
  )}&apikey=${encodeURIComponent(FMP_API_KEY || "")}`;

  const response = await axios.get(url);

  if (!Array.isArray(response.data) || response.data.length === 0) {
    throw new Error("FMP returned empty array");
  }

  const raw = response.data[0];

  return [
    {
      symbol: raw.symbol,
      price: raw.price ?? null,
      open: raw.open ?? null,
      high: raw.dayHigh ?? null,
      low: raw.dayLow ?? null,
      volume: raw.volume ?? null,
      previousClose: raw.previousClose ?? null,
      change: raw.change ?? null,
      changesPercentage: raw.changesPercentage ?? null,
      marketCap: raw.marketCap ?? null,
      source: "FMP",
      timestamp: new Date().toISOString(),
    },
  ];
}

// ==========================
// Alpha Vantage (Last fallback)
// ==========================

async function fetchFromAlphaVantage(symbol) {
  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(
    symbol
  )}&apikey=${encodeURIComponent(ALPHA_VANTAGE_API_KEY || "")}`;

  const response = await axios.get(url);

  const quote = response.data?.["Global Quote"];
  if (!quote || Object.keys(quote).length === 0) {
    throw new Error("Alpha returned empty quote");
  }

  return [
    {
      symbol: quote["01. symbol"],
      price: Number(quote["05. price"]) || null,
      open: Number(quote["02. open"]) || null,
      high: Number(quote["03. high"]) || null,
      low: Number(quote["04. low"]) || null,
      volume: Number(quote["06. volume"]) || null,
      previousClose: Number(quote["08. previous close"]) || null,
      change: null,
      changesPercentage: null,
      marketCap: null,
      source: "ALPHA_VANTAGE",
      timestamp: new Date().toISOString(),
    },
  ];
}

// ==========================
// MAIN FETCH
// =================
