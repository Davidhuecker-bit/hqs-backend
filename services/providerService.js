// services/providerService.js
// HQS Massive Provider (Primary Source)
// Clean, normalized, snapshot-ready

const axios = require("axios");

// ============================
// ENV
// ============================

const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;

if (!MASSIVE_API_KEY) {
  console.warn("⚠️ MASSIVE_API_KEY is not set in environment variables");
}

// ============================
// NORMALIZER
// ============================

function normalizeMassiveData(raw) {
  return {
    symbol: raw.T,
    price: Number(raw.c),
    open: Number(raw.o),
    high: Number(raw.h),
    low: Number(raw.l),
    previousClose: Number(raw.c),
    volume: Number(raw.v),
    source: "MASSIVE",
    timestamp: Date.now(),
  };
}

// ============================
// FETCH FROM MASSIVE
// ============================

async function fetchFromMassive(symbol) {
  const url = `https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(
    symbol
  )}/prev?apiKey=${MASSIVE_API_KEY}`;

  const response = await axios.get(url);

  if (!response.data || response.data.status !== "OK") {
    throw new Error("Massive response not OK");
  }

  if (!response.data.results || response.data.results.length === 0) {
    throw new Error("Massive returned empty results");
  }

  const normalized = normalizeMassiveData(response.data.results[0]);

  return [normalized];
}

// ============================
// MAIN FETCH
// ============================

async function fetchQuote(symbol) {
  try {
    return await fetchFromMassive(symbol);
  } catch (error) {
    console.error(`❌ Massive failed for ${symbol}:`, error.message);
    throw error;
  }
}

// ============================
// EXPORT
// ============================

module.exports = {
  fetchQuote,
};
