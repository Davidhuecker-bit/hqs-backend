const axios = require("axios");

const API_KEY = process.env.FMP_API_KEY;
const BASE_URL = "https://financialmodelingprep.com/stable";

async function fetchQuote(symbol) {
  if (!API_KEY) {
    throw new Error("FMP_API_KEY ist nicht gesetzt.");
  }

  if (!symbol) {
    throw new Error("Kein Symbol übergeben.");
  }

  const url = `${BASE_URL}/quote?symbol=${symbol}&apikey=${API_KEY}`;

  try {
    const response = await axios.get(url, { timeout: 8000 });

    if (!response.data || !Array.isArray(response.data)) {
      throw new Error("Ungültige FMP Antwortstruktur");
    }

    return response.data;

  } catch (error) {

    if (error.response) {
      console.error("FMP API Fehler:", error.response.status, error.response.data);
      throw new Error(`FMP API Fehler (${error.response.status})`);
    }

    if (error.code === "ECONNABORTED") {
      throw new Error("FMP Anfrage Timeout");
    }

    console.error("Unbekannter Provider Fehler:", error.message);
    throw new Error("Marktdaten-Provider nicht erreichbar.");
  }
}

module.exports = {
  fetchQuote,
};
