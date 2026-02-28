// services/segments/china.segment.js
// China Market Segment Service (Dynamic Version)

const { fetchQuote } = require("../providerService");

/**
 * Holt China-Marktdaten für übergebene Symbole
 * @param {string[]} symbols
 */
async function getChinaMarketData(symbols = []) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return [];
  }

  const results = [];

  for (const symbol of symbols) {
    try {
      const data = await fetchQuote(symbol, "china");

      if (Array.isArray(data)) {
        results.push(...data);
      }
    } catch (error) {
      console.warn(`China segment failed for ${symbol}:`, error.message);
    }
  }

  return results;
}

module.exports = {
  getChinaMarketData,
};
