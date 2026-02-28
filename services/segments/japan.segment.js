// services/segments/japan.segment.js
// Japan Market Segment Service (Dynamic Version)

const { fetchQuote } = require("../providerService");

/**
 * Holt Japan-Marktdaten für übergebene Symbole
 * @param {string[]} symbols
 */
async function getJapanMarketData(symbols = []) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return [];
  }

  const results = [];

  for (const symbol of symbols) {
    try {
      const data = await fetchQuote(symbol, "japan");

      if (Array.isArray(data)) {
        results.push(...data);
      }
    } catch (error) {
      console.warn(`Japan segment failed for ${symbol}:`, error.message);
    }
  }

  return results;
}

module.exports = {
  getJapanMarketData,
};
