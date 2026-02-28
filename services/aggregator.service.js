// services/aggregator.service.js
// Global Region Aggregator

const { getChinaMarketData } = require("./segments/china.segment");
const { getJapanMarketData } = require("./segments/japan.segment");
const { getIndiaMarketData } = require("./segments/india.segment");
const { fetchQuote } = require("./providerService");

/**
 * Ermittelt Region anhand Symbol-Endung
 */
function detectRegion(symbol) {
  if (symbol.endsWith(".HK")) return "china";
  if (symbol.endsWith(".T")) return "japan";
  if (symbol.endsWith(".NS")) return "india";
  return "us";
}

/**
 * Gruppiert Symbole nach Region
 */
function groupByRegion(symbols = []) {
  const grouped = {
    us: [],
    china: [],
    japan: [],
    india: [],
  };

  for (const symbol of symbols) {
    const region = detectRegion(symbol);
    grouped[region].push(symbol);
  }

  return grouped;
}

/**
 * Hauptfunktion: Holt globale Marktdaten
 */
async function getGlobalMarketData(symbols = []) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return [];
  }

  const grouped = groupByRegion(symbols);

  const results = [];

  // China
  if (grouped.china.length > 0) {
    const chinaData = await getChinaMarketData(grouped.china);
    results.push(...chinaData);
  }

  // Japan
  if (grouped.japan.length > 0) {
    const japanData = await getJapanMarketData(grouped.japan);
    results.push(...japanData);
  }

  // India
  if (grouped.india.length > 0) {
    const indiaData = await getIndiaMarketData(grouped.india);
    results.push(...indiaData);
  }

  // US + Rest
  for (const symbol of grouped.us) {
    try {
      const data = await fetchQuote(symbol, "us");
      if (Array.isArray(data)) {
        results.push(...data);
      }
    } catch (error) {
      console.warn(`US fetch failed for ${symbol}:`, error.message);
    }
  }

  return results;
}

module.exports = {
  getGlobalMarketData,
};
