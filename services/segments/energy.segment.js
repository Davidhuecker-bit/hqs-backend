const marketwatch = require("../providers/marketwatch.provider");
const tradingview = require("../providers/tradingview.provider");

async function getEnergyData(symbol) {
  const timestamp = new Date().toISOString();

  if (!symbol) {
    return {
      success: false,
      segment: "energy",
      provider: null,
      symbol: null,
      data: null,
      fallbackUsed: false,
      error: "Symbol fehlt",
      timestamp,
    };
  }

  // 1️⃣ PRIMARY: MarketWatch
  try {
    const data = await marketwatch.getQuote(symbol);

    return {
      success: true,
      segment: "energy",
      provider: "marketwatch",
      symbol,
      data,
      fallbackUsed: false,
      timestamp,
    };
  } catch (e1) {
    console.warn(`⚠️ MarketWatch failed for ${symbol}: ${e1.message}`);
  }

  // 2️⃣ FALLBACK: TradingView
  try {
    const data = await tradingview.getQuote(symbol);

    return {
      success: true,
      segment: "energy",
      provider: "tradingview",
      symbol,
      data,
      fallbackUsed: true,
      timestamp,
    };
  } catch (e2) {
    console.error(`❌ All Energy providers failed for ${symbol}`);
  }

  return {
    success: false,
    segment: "energy",
    provider: null,
    symbol,
    data: null,
    fallbackUsed: false,
    error: "All Energy providers failed",
    timestamp,
  };
}

module.exports = { getEnergyData };
