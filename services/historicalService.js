const axios = require("axios");
const NodeCache = require("node-cache");

const cache = new NodeCache({ stdTTL: 3600 });

const API_KEY = process.env.FMP_API_KEY;
const BASE_URL = "https://financialmodelingprep.com/api/v3";

async function getHistoricalPrices(symbol, period = "1year") {
  const cacheKey = `hist_${symbol}_${period}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const url = `${BASE_URL}/historical-price-full/${symbol}?serietype=line&apikey=${API_KEY}`;
    const response = await axios.get(url);

    const data = response.data.historical || [];
    cache.set(cacheKey, data);

    return data;
  } catch (error) {
    console.error("Historical Data Error:", error.message);
    throw new Error("Failed to fetch historical data");
  }
}

module.exports = { getHistoricalPrices };
