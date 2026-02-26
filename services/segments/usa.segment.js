const finnhub = require("../providers/finnhub.provider");
const fmp = require("../providers/fmp.provider");
const alpha = require("../providers/alpha.provider");

async function getUSData(symbol) {
  try {
    const data = await finnhub.getQuote(symbol);
    return { success: true, source: "finnhub", data };
  } catch (e1) {
    try {
      const data = await fmp.getQuote(symbol);
      return { success: true, source: "fmp", data };
    } catch (e2) {
      try {
        const data = await alpha.getQuote(symbol);
        return { success: true, source: "alpha_vantage", data };
      } catch (e3) {
        return {
          success: false,
          error: "All providers failed",
          data: null,
        };
      }
    }
  }
}

module.exports = { getUSData };
