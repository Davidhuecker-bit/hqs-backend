const axios = require("axios");

async function getCryptoData(symbol) {
  const timestamp = new Date().toISOString();

  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${symbol}&vs_currencies=usd&include_24hr_change=true`;
    const response = await axios.get(url, { timeout: 7000 });

    if (!response.data || !response.data[symbol]) {
      throw new Error("Keine Crypto Daten gefunden");
    }

    const data = response.data[symbol];

    return {
      success: true,
      segment: "crypto",
      provider: "coingecko",
      symbol,
      data: {
        symbol,
        price: data.usd,
        changesPercentage: data.usd_24h_change,
      },
      fallbackUsed: false,
      timestamp,
    };
  } catch (error) {
    return {
      success: false,
      segment: "crypto",
      provider: null,
      symbol,
      data: null,
      fallbackUsed: false,
      error: error.message,
      timestamp,
    };
  }
}

module.exports = { getCryptoData };
