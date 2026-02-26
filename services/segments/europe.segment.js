const provider = require("../providerService");

async function getEuropeData(symbol) {
  const timestamp = new Date().toISOString();

  try {
    // Für Europa nehmen wir aktuell FMP als Primary
    if (!process.env.FMP_API_KEY) {
      throw new Error("FMP_API_KEY fehlt für Europe Segment");
    }

    const axios = require("axios");
    const url = `https://financialmodelingprep.com/api/v3/quote/${symbol}?apikey=${process.env.FMP_API_KEY}`;
    const response = await axios.get(url, { timeout: 7000 });

    if (!response.data || !response.data.length) {
      throw new Error("Keine Europe Daten gefunden");
    }

    const q = response.data[0];

    return {
      success: true,
      segment: "europe",
      provider: "fmp",
      symbol,
      data: {
        symbol,
        price: q.price,
        change: q.change,
        changesPercentage: q.changesPercentage,
        high: q.dayHigh,
        low: q.dayLow,
        open: q.open,
        previousClose: q.previousClose,
      },
      fallbackUsed: false,
      timestamp,
    };
  } catch (error) {
    return {
      success: false,
      segment: "europe",
      provider: null,
      symbol,
      data: null,
      fallbackUsed: false,
      error: error.message,
      timestamp,
    };
  }
}

module.exports = { getEuropeData };
