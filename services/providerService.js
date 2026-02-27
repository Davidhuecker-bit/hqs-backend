const axios = require("axios");

// ======================================================// ENV KEYS// ======================================================

const FMP_KEY = process.env.FMP_API_KEY;
const ALPHA_KEY = process.env.ALPHA_VANTAGE_API_KEY;

// ======================================================// NORMALIZER// ======================================================

function safeNumber(value) {
  const n = Number(value);
  return isNaN(n) ? 0 : n;
}

function normalizeData(symbol, raw) {
  return {
    symbol,
    price: safeNumber(raw.price),
    change: safeNumber(raw.change),
    changesPercentage: safeNumber(raw.changesPercentage),
    high: safeNumber(raw.high),
    low: safeNumber(raw.low),
    open: safeNumber(raw.open),
    previousClose: safeNumber(raw.previousClose),
  };
}

// ======================================================// FMP (Primary)// ======================================================

async function fetchFMP(symbol) {
  if (!FMP_KEY) {
    throw new Error("FMP_API_KEY fehlt");
  }

  const url = `https://financialmodelingprep.com/api/v3/quote/${symbol}?apikey=${FMP_KEY}`;
  const response = await axios.get(url, { timeout: 7000 });

  if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
    throw new Error("FMP keine Daten");
  }

  const q = response.data[0];

  return {
    provider: "fmp",
    data: normalizeData(symbol, {
      price: q.price,
      change: q.change,
      changesPercentage: q.changesPercentage,
      high: q.dayHigh,
      low: q.dayLow,
      open: q.open,
      previousClose: q.previousClose,
    }),
  };
}

// ======================================================// ALPHA VANTAGE (Fallback)// ======================================================

async function fetchAlpha(symbol) {
  if (!ALPHA_KEY) {
    throw new Error("ALPHA_VANTAGE_API_KEY fehlt");
  }

  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${ALPHA_KEY}`;
  const response = await axios.get(url, { timeout: 7000 });

  const q = response.data?.["Global Quote"];

  if (!q || q["05. price"] === undefined) {
    throw new Error("Alpha keine Daten");
  }

  return {
    provider: "alpha_vantage",
    data: normalizeData(symbol, {
      price: q["05. price"],
      change: q["09. change"],
      changesPercentage: q["10. change percent"],
      high: q["03. high"],
      low: q["04. low"],
      open: q["02. open"],
      previousClose: q["08. previous close"],
    }),
  };
}

// ======================================================// PUBLIC FUNCTION (FMP Primary, Alpha Fallback)// ======================================================

async function getUSQuote(symbol) {
  try {
    const primary = await fetchFMP(symbol);
    return { ...primary, fallbackUsed: false };
  } catch (e1) {
    console.warn("FMP failed:", e1.message);
  }

  try {
    const fallback = await fetchAlpha(symbol);
    return { ...fallback, fallbackUsed: true };
  } catch (e2) {
    console.warn("Alpha failed:", e2.message);
  }

  throw new Error("Alle Provider fehlgeschlagen fuer: " + symbol);
}

// ======================================================// EXPORT// ======================================================

module.exports = {
  getUSQuote,
  fetchQuote: getUSQuote,
};
