const axios = require("axios");

// Wir priorisieren jetzt den Finsheet Key
const API_KEY = process.env.FINSHEET_API_KEY;
const BASE_URL = "https://finsheet.io/api/v1"; 

async function fetchQuote(symbol) {
  if (!API_KEY) {
    console.error("❌ FINSHEET_API_KEY fehlt in Railway.");
    return null; 
  }

  try {
    // Finsheet nutzt oft den /quote Endpunkt
    // Wichtig: Falls du mehrere Symbole hast, muss die URL evtl. angepasst werden
    const url = `${BASE_URL}/quote?symbol=${symbol}&token=${API_KEY}`;

    const response = await axios.get(url, { timeout: 7000 });

    // Validierung der Finsheet-Antwort
    if (!response.data) {
      console.error(`Finsheet: Keine Daten für ${symbol}`);
      return null;
    }

    // Finsheet gibt bei Einzelsymbolen oft ein Objekt zurück. 
    // Da dein Snapshot-Builder ein Array erwartet (.map), wickeln wir es ein:
    const data = Array.isArray(response.data) ? response.data : [response.data];

    return data;

  } catch (error) {
    if (error.response) {
      // Hier fangen wir den 401 ab, den du im Log hattest
      console.error(`Finsheet Fehler (${error.response.status}):`, error.response.data);
    } else {
      console.error("Finsheet Verbindungsfehler:", error.message);
    }
    return null; 
  }
}

module.exports = {
  fetchQuote,
};
