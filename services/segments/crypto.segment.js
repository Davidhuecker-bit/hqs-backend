const coingecko = require("../providers/coingecko.provider");
const cryptocompare = require("../providers/cryptocompare.provider");

async function getCryptoData(symbol) {
  const timestamp = new Date().toISOString();

  if (!symbol) {
    return {
      success: false,
      segment: "crypto",
      provider: null,
      symbol: null,
      data: null,
      fallbackUsed: false,
      error: "Symbol fehlt",
      timestamp,
    };
  }

  // 1️⃣ PRIMARY: CoinGecko
  try {
    const data = await coingecko.getQuote(symbol);

    return {
      success: true,
      segment: "crypto",
      provider: "coingecko",
      symbol,
      data,
      fallbackUsed: false,
      timestamp,
    };
  } catch (e1) {
    console.warn(`⚠️ CoinGecko failed for ${symbol}: ${e1.message}`);
  }

  // 2️⃣ FALLBACK: CryptoCompare
  try {
    const data = await cryptocompare.getQuote(symbol);

    return {
      success: true,
      segment: "crypto",
      provider: "cryptocompare",
      symbol,
      data,
      fallbackUsed: true,
      timestamp,
    };
  } catch (e2) {
    console.error(`❌ All Crypto providers failed for ${symbol}`);
  }

  return {
    success: false,
    segment: "crypto",
    provider: null,
    symbol,
    data: null,
    fallbackUsed: false,
    error: "All Crypto providers failed",
    timestamp,
  };
}

module.exports = { getCryptoData };
