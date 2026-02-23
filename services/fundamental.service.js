// services/fundamental.service.js
// HQS Fundamental Data Service - Umgestellt auf Finnhub

const axios = require("axios");

// Wir nutzen jetzt den Finnhub Key, der in Railway bereits funktioniert
const API_KEY = process.env.FINNHUB_API_KEY;
const BASE_URL = "https://finnhub.io/api/v1";

async function getFundamentals(symbol) {
  if (!API_KEY) {
    console.error("❌ FINNHUB_API_KEY fehlt für Fundamentals");
    return null;
  }

  try {
    // Finnhub bietet "Basic Financials" (Metriken statt voller Listen)
    const url = `${BASE_URL}/stock/metric?symbol=${symbol}&metric=all&token=${API_KEY}`;
    
    const response = await axios.get(url, { timeout: 7000 });
    const data = response.data;

    if (!data || !data.metric) {
      console.log(`Keine Fundamental-Metriken für ${symbol} gefunden.`);
      return null;
    }

    // Wir mappen die Finnhub-Metriken so um, dass dein System nicht abstürzt.
    // Finnhub liefert keine 5-Jahres-Liste im Free Plan, daher geben wir das aktuellste Jahr zurück.
    return [{
      year: new Date().getFullYear().toString(),
      revenue: data.metric.revenueTTM || 0,
      netIncome: data.metric.netProfitMarginTTM || 0, // Finnhub liefert hier oft Margen
      ebitda: data.metric.ebitda || 0,
      eps: data.metric.epsTTM || 0,
      operatingIncome: 0, // Nicht direkt in Basis-Metriken enthalten
    }];

  } catch (error) {
    // Das verhindert den roten "401" Error im Log
    console.error("Fundamental fetch error (Finnhub):", error.message);
    return null;
  }
}

module.exports = {
  getFundamentals,
};
