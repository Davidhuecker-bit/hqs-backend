const coingecko = require("../providers/coingecko.provider");

async function getCryptoData(symbol) {
  try {
    const data = await coingecko.getPrice(symbol);
    return { success: true, source: "coingecko", data };
  } catch {
    return {
      success: false,
      error: "Crypto provider failed",
      data: null,
    };
  }
}

module.exports = { getCryptoData };
