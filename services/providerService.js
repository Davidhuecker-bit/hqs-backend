"use strict";

const axios = require("axios");
const { normalizeMarketData } = require("./marketNormalizer");

// ============================
// KEY ROTATION
// ============================

const FMP_KEYS = [
  process.env.FMP_KEY_1,
  process.env.FMP_KEY_2,
  process.env.FMP_KEY_3
].filter(Boolean);

let keyIndex = 0;

function getNextKey() {
  if (!FMP_KEYS.length) {
    throw new Error("No FMP keys configured");
  }

  const key = FMP_KEYS[keyIndex];
  keyIndex = (keyIndex + 1) % FMP_KEYS.length;
  return key;
}

// ============================
// RATE GUARD (1 req / 400ms)
// ============================

let lastCallTime = 0;

async function rateGuard() {
  const now = Date.now();
  const diff = now - lastCallTime;

  if (diff < 400) {
    await new Promise((res) => setTimeout(res, 400 - diff));
  }

  lastCallTime = Date.now();
}

// ============================
// FETCH
// ============================

async function fetchQuote(symbol, region = "us") {
  await rateGuard();

  const apiKey = getNextKey();

  const url = `https://financialmodelingprep.com/api/v3/quote/${encodeURIComponent(
    symbol
  )}?apikey=${encodeURIComponent(apiKey)}`;

  const response = await axios.get(url, { timeout: 10000 });

  if (!Array.isArray(response.data) || response.data.length === 0) {
    console.warn("FMP returned empty for", symbol);
    return [];
  }

  return response.data
    .map((raw) => normalizeMarketData(raw, "FMP", region))
    .filter(Boolean);
}

module.exports = {
  fetchQuote,
};
