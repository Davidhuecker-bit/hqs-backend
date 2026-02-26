const finnhub = require("../providers/finnhub.provider");
const fmp = require("../providers/fmp.provider");
const alpha = require("../providers/alpha.provider");

async function getUSData(symbol) {
  const timestamp = new Date().toISOString();

  if (!symbol) {
    return {
      success: false,
      segment: "usa",
      provider: null,
      symbol: null,
      data: null,
      fallbackUsed: false,
      error: "Symbol fehlt",
      timestamp,
    };
  }

  // =============================
  // 1️⃣ PRIMARY: FINNHUB
  // =============================
  try {
    const data = await finnhub.getQuote(symbol);

    return {
      success: true,
      segment: "usa",
      provider: "finnhub",
      symbol,
      data,
      fallbackUsed: false,
      timestamp,
    };
  } catch (e1) {
    console.warn(`⚠️ Finnhub failed for ${symbol}: ${e1.message}`);
  }

  // =============================
  // 2️⃣ FALLBACK: FMP
  // =============================
  try {
    const data = await fmp.getQuote(symbol);

    return {
      success: true,
      segment: "usa",
      provider: "fmp",
      symbol,
      data,
      fallbackUsed: true,
      timestamp,
    };
  } catch (e2) {
    console.warn(`⚠️ FMP failed for ${symbol}: ${e2.message}`);
  }

  // =============================
  // 3️⃣ FALLBACK: ALPHA VANTAGE
  // =============================
  try {
    const data = await alpha.getQuote(symbol);

    return {
      success: true,
      segment: "usa",
      provider: "alpha_vantage",
      symbol,
      data,
      fallbackUsed: true,
      timestamp,
    };
  } catch (e3) {
    console.error(`❌ All US providers failed for ${symbol}`);
  }

  // =============================
  // ❌ TOTAL FAILURE
  // =============================
  return {
    success: false,
    segment: "usa",
    provider: null,
    symbol,
    data: null,
    fallbackUsed: false,
    error: "All US providers failed",
    timestamp,
  };
}

module.exports = { getUSData };
