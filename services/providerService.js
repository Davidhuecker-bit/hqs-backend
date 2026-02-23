const axios = require("axios");

const API_KEY = process.env.FMP_API_KEY;
// Wir nutzen /v3, da dies der stabilste Endpunkt für Batch-Quotes ist
const BASE_URL = "https://financialmodelingprep.com/api/v3";

async function fetchQuote(symbol) {
  if (!API_KEY) {
    console.error("❌ FMP_API_KEY fehlt in den Umgebungsvariablen.");
    return null; 
  }

  // WICHTIG: Nutze die Query-Parameter Struktur (?symbol=), 
  // damit auch kommagetrennte Listen (z.B. "NVDA,AAPL") funktionieren.
  const url = `${BASE_URL}/quote/${symbol}?apikey=${API_KEY}`;

  try {
    const response = await axios.get(url, { timeout: 5000 });

    // FMP sendet bei Fehlern (z.B. Limit erreicht) oft 200 OK, aber mit Fehlermeldung im Body
    if (response.data && (response.data["Error Message"] || response.data["error"])) {
      console.error("FMP API Hinweis:", response.data["Error Message"] || response.data["error"]);
      return null;
    }

    // Sicherstellen, dass wir ein Array erhalten
    if (!response.data || !Array.isArray(response.data)) {
      console.error(`FMP lieferte kein Array für ${symbol}`);
      return null;
    }

    return response.data;

  } catch (error) {
    // Fehler loggen, aber null zurückgeben, damit der Fallback-Provider (Polygon/Alpha) einspringen kann
    if (error.response) {
      console.error(`FMP Status Fehler (${error.response.status}) bei Symbol: ${symbol}`);
    } else if (error.code === "ECONNABORTED") {
      console.error(`FMP Timeout (5s überschritten) für ${symbol}`);
    } else {
      console.error("FMP Netzwerkfehler:", error.message);
    }
    
    return null; 
  }
}

module.exports = {
  fetchQuote,
};
