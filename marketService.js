const { fetchQuote } = require("./providerService");
const { buildHQSResponse } = require("./hqsEngine");

async function getMarketData(symbol) {
  const rawData = await fetchQuote(symbol);

  return rawData.map(item => buildHQSResponse(item));
}

module.exports = {
  getMarketData,
};
