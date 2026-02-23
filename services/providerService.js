const axios = require("axios");

const API_KEY = process.env.FMP_API_KEY;
const BASE_URL = "https://financialmodelingprep.com/v3"; // Oder /stable, beides geht bei FMP

async function fetchQuote(symbol) {
  if (!API_KEY) {
    console.error("❌ FMP_API_KEY fehlt.");
    return null; // Rückgabe von null erlaubt dem Haupt-Service den Fallback
  }

  const url = `${BASE_URL}/quote/${symbol}?apikey=${API_KEY}`;

  try {
    const response = await axios.get(url, { timeout: 5000 }); // 5s reicht meistens

    // FMP sendet manchmal 200 OK mit Fehlermeldung im Body
    if (response.data && response.data["Error Message"]) {
      console.error("FMP API Error Message:", response.data["Error Message"]);
      return null;
    }

    if (!response.data || !Array.isArray(response.data)) {
      return null;
    }

    return response.data;

  } catch (error) {
    // Logge den Fehler, aber "schlucke" ihn, damit das Fallback-System übernehmen kann
    if (error.response) {
      console.error(`FMP Status Error (${error.response.status}) für ${symbol}`);
    } else if (error.code === "ECONNABORTED") {
      console.error(`FMP Timeout für ${symbol}`);
    } else {
      console.error("FMP Verbindungsfehler:", error.message);
    }
    
    return null; // Wichtig für die Kette!
  }
}

module.exports = {
  fetchQuote,
};
