const axios = require("axios");

// Nutzt nur noch Finnhub
const API_KEY = process.env.FINNHUB_API_KEY;
const BASE_URL = "https://finnhub.io/api/v1";

async function fetchQuote(symbol) {
  if (!API_KEY) {
    console.error("❌ FINNHUB_API_KEY fehlt in Railway.");
    return null;
  }

  try {
    // Finnhub nutzt /quote für Echtzeitdaten
    const url = `${BASE_URL}/quote?symbol=${symbol}&token=${API_KEY}`;
    const response = await axios.get(url, { timeout: 7000 });

    if (!response.data || Object.keys(response.data).length === 0) {
      console.error(`Finnhub: Keine Daten für ${symbol}`);
      return null;
    }

    // Finnhub gibt Daten im Format { c: 150, h: 155, ... } zurück.
    // Wir hängen das Symbol manuell an, damit dein Mapper weiß, um welche Aktie es geht.
    const normalizedData = {
      symbol: symbol,
      price: response.data.c,        // Current price
      change: response.data.d,       // Change
      changesPercentage: response.data.dp, // Percent change
      ...response.data
    };

    return [normalizedData];

  } catch (error) {
    if (error.response) {
      console.error(`Finnhub Fehler (${error.response.status}) für ${symbol}`);
    } else {
      console.error("Finnhub Netzwerkfehler:", error.message);
    }
    return null;
  }
}

module.exports = {
  fetchQuote,
};
