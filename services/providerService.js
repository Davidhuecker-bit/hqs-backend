// services/providerService.js
// FMP (Primary) + Alpha Vantage (Fallback)

const axios = require("axios");

// ============================
// ENV
// ============================

const FMP_API_KEY = process.env.FMP_API_KEY;
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY;

// ============================
// FMP QUOTE
// ============================

async function fetchFromFMP(symbol) {
  try {
    const url = `https://financialmodelingprep.com/api/v3/quote/${symbol}?apikey=${FMP_API_KEY}`;

    const response = await axios.get(url);

    if (!Array.isArray(response.data) || response.data.length === 0) {
      throw new Error("FMP returned empty array");
    }

    return response.data;
  } catch (error) {
    console.error("FMP Error:", error.message);
    console.error("FMP raw response:", error?.response?.data);
    throw error;
  }
}

// ============================
// ALPHA VANTAGE FALLBACK
// ============================

async function fetchFromAlphaVantage(symbol) {
  try {
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${ALPHA_VANTAGE_API_KEY}`;

    const response = await axios.get(url);

    const quote = response.data?.["Global Quote"];

    if (!quote || Object.keys(quote).length === 0) {
      throw new Error("Alpha Vantage returned empty quote");
    }

    return [
      {
        symbol: quote["01. symbol"],
        price: parseFloat(quote["05. price"]),
        open: parseFloat(quote["02. open"]),
        high: parseFloat(quote["03. high"]),
        low: parseFloat(quote["04. low"]),
        previousClose: parseFloat(quote["08. previous close"]),
        volume: parseFloat(quote["06. volume"]),
      },
    ];
  } catch (error) {
    console.error("Alpha Vantage Error:", error.message);
    throw error;
  }
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
