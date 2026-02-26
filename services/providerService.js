const axios = require("axios");

// ENV KEYS
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const FMP_KEY = process.env.FMP_API_KEY;
const ALPHA_KEY = process.env.ALPHA_VANTAGE_API_KEY;

// ======================================================
// FINNHUB
// ======================================================

async function fetchFinnhub(symbol) {
  if (!FINNHUB_KEY) throw new Error("FINNHUB_API_KEY fehlt");

  const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_KEY}`;
  const response = await axios.get(url, { timeout: 7000 });

  if (!response.data || !response.data.c) {
    throw new Error("Finnhub keine gültigen Daten");
  }

  return {
    provider: "finnhub",
    data: {
      symbol,
      price: response.data.c,
      change: response.data.d,
      changesPercentage: response.data.dp,
      high: response.data.h,
      low: response.data.l,
      open: response.data.o,
      previousClose: response.data.pc,
    },
  };
}

// ======================================================
// FMP
// ======================================================

async function fetchFMP(symbol) {
  if (!FMP_KEY) throw new Error("FMP_API_KEY fehlt");

  const url = `https://financialmodelingprep.com/api/v3/quote/${symbol}?apikey=${FMP_KEY}`;
  const response = await axios.get(url, { timeout: 7000 });

  if (!response.data || !response.data.length) {
    throw new Error("FMP keine Daten");
  }

  const q = response.data[0];

  return {
    provider: "fmp",
    data: {
      symbol,
      price: q.price,
      change: q.change,
      changesPercentage: q.changesPercentage,
      high: q.dayHigh,
      low: q.dayLow,
      open: q.open,
      previousClose: q.previousClose,
    },
  };
}

// ======================================================
// ALPHA VANTAGE
// ======================================================

async function fetchAlpha(symbol) {
  if (!ALPHA_KEY) throw new Error("ALPHA_VANTAGE_API_KEY fehlt");

  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${ALPHA_KEY}`;
  const response = await axios.get(url, { timeout: 7000 });

  const q = response.data["Global Quote"];
  if (!q || !q["05. price"]) {
    throw new Error("Alpha keine Daten");
  }

  return {
    provider: "alpha_vantage",
    data: {
      symbol,
      price: parseFloat(q["05. price"]),
      change: parseFloat(q["09. change"]),
      changesPercentage: parseFloat(q["10. change percent"]),
      high: parseFloat(q["03. high"]),
      low: parseFloat(q["04. low"]),
      open: parseFloat(q["02. open"]),
      previousClose: parseFloat(q["08. previous close"]),
    },
  };
}

// ======================================================
// PUBLIC FUNCTION MIT FALLBACK
// ======================================================

async function getUSQuote(symbol) {
  try {
    const primary = await fetchFinnhub(symbol);
    return { ...primary, fallbackUsed: false };
  } catch (e1) {
    console.warn("⚠️ Finnhub failed:", e1.message);
  }

  try {
    const fallback1 = await fetchFMP(symbol);
    return { ...fallback1, fallbackUsed: true };
  } catch (e2) {
    console.warn("⚠️ FMP failed:", e2.message);
  }

  try {
    const fallback2 = await fetchAlpha(symbol);
    return { ...fallback2, fallbackUsed: true };
  } catch (e3) {
    console.warn("⚠️ Alpha failed:", e3.message);
  }

  throw new Error("Alle US Provider fehlgeschlagen");
}

module.exports = {
  getUSQuote,
};
