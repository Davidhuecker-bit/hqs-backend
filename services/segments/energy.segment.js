const axios = require("axios");

async function getEnergyData(symbol) {
  const timestamp = new Date().toISOString();

  try {
    if (!process.env.FMP_API_KEY) {
      throw new Error("FMP_API_KEY fehlt für Energy Segment");
    }

    const url = `https://financialmodelingprep.com/api/v3/quote/${symbol}?apikey=${process.env.FMP_API_KEY}`;
    const response = await axios.get(url, { timeout: 7000 });

    if (!response.data || !response.data.length) {
      throw new Error("Keine Energy Daten gefunden");
    }

    const q = response.data[0];

    return {
      success: true,
      segment: "energy",
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
      segment: "energy",
      provider: null,
      symbol,
      data: null,
      fallbackUsed: false,
      error: error.message,
      timestamp,
    };
  }
}

module.exports = { getEnergyData };
