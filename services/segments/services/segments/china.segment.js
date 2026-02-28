// services/segments/china.segment.js
// China Market Segment Service

const { fetchQuote } = require("../providerService");

// Beispiel-Liste (kann später erweitert oder DB-basiert werden)
const CHINA_SYMBOLS = [
  "0700.HK", // Tencent
  "9988.HK", // Alibaba
  "3690.HK", // Meituan
  "1810.HK", // Xiaomi
];

async function getChinaMarketData() {
  const results = [];

  for (const symbol of CHINA_SYMBOLS) {
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
