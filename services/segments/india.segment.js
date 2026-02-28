// services/segments/india.segment.js
// India Market Segment Service (Dynamic Version)

const { fetchQuote } = require("../providerService");

/**
 * Holt Indien-Marktdaten für übergebene Symbole
 * @param {string[]} symbols
 */
async function getIndiaMarketData(symbols = []) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return [];
  }

  const results = [];

  for (const symbol of symbols) {
    try {
      const data = await fetchQuote(symbol, "india");

      if (Array.isArray(data)) {
        results.push(...data);
      }
    } catch (error) {
      console.warn(`India segment failed for ${symbol}:`, error.message);
    }
  }

  return results;
}

module.exports = {
  getIndiaMarketData,
};
