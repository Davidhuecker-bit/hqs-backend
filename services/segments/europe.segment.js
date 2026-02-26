const yahoo = require("../providers/yahoo.provider");
const investing = require("../providers/investing.provider");

async function getEuropeData(symbol) {
  const timestamp = new Date().toISOString();

  if (!symbol) {
    return {
      success: false,
      segment: "europe",
      provider: null,
      symbol: null,
      data: null,
      fallbackUsed: false,
      error: "Symbol fehlt",
      timestamp,
    };
  }

  // 1️⃣ PRIMARY: Yahoo Finance
  try {
    const data = await yahoo.getQuote(symbol);

    return {
      success: true,
      segment: "europe",
      provider: "yahoo",
      symbol,
      data,
      fallbackUsed: false,
      timestamp,
    };
  } catch (e1) {
    console.warn(`⚠️ Yahoo failed for ${symbol}: ${e1.message}`);
  }

  // 2️⃣ FALLBACK: Investing.com
  try {
    const data = await investing.getQuote(symbol);

    return {
      success: true,
      segment: "europe",
      provider: "investing",
      symbol,
      data,
      fallbackUsed: true,
      timestamp,
    };
  } catch (e2) {
    console.error(`❌ All Europe providers failed for ${symbol}`);
  }

  return {
    success: false,
    segment: "europe",
    provider: null,
    symbol,
    data: null,
    fallbackUsed: false,
    error: "All Europe providers failed",
    timestamp,
  };
}

module.exports = { getEuropeData };
