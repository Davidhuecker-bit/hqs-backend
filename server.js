const express = require("express");
const cors = require("cors");
const axios = require("axios");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 8080;

// ============================
// CONFIG
// ============================

// 🔥 Nur eine Test-Aktie
const DEFAULT_SYMBOL = "NVDA";

const API_KEY = process.env.FMP_API_KEY;
const BASE_URL = "https://financialmodelingprep.com/stable";

// ============================
// CORS
// ============================

app.use(cors({
  origin: [
    "https://dhsystemhqs.de",
    "https://www.dhsystemhqs.de",
    "http://localhost:3000"
  ],
  methods: ["GET", "POST"]
}));

app.use(express.json());

// ============================
// HQS LOGIK
// ============================

function getAIInsight(score) {
  if (score >= 80) return "Starke institutionelle Akkumulation erkannt.";
  if (score <= 45) return "Erhöhtes Risiko – Gewinnmitnahmen wahrscheinlich.";
  return "Neutraler Markt – Konsolidierungsphase möglich.";
}

function calculateHQS(item) {
  const change = Number(item.changesPercentage || 0);
  const volume = Number(item.volume || 0);
  const avgVolume = Number(item.avgVolume || 1);
  const vRatio = avgVolume > 0 ? volume / avgVolume : 0;

  let score = 50;

  if (change > 0) score += 10;
  if (vRatio > 1.3) score += 15;
  if (item.marketCap && item.marketCap > 1e11) score += 10;

  return Math.min(100, Math.round(score));
}

// ============================
// MARKET ENDPOINT
// ============================

app.get(["/market", "/api/market"], async (req, res) => {
  try {

    if (!API_KEY) {
      return res.status(500).json({
        success: false,
        message: "FMP_API_KEY ist nicht gesetzt."
      });
    }

    // 🔥 Optional: Symbol über Query erlauben
    const symbol = req.query.symbol || DEFAULT_SYMBOL;

    const url = `${BASE_URL}/quote?symbol=${symbol}&apikey=${API_KEY}`;

    const response = await axios.get(url, { timeout: 8000 });

    if (!response.data || !Array.isArray(response.data)) {
      throw new Error("Ungültige FMP Antwort");
    }

    const stocks = response.data.map(item => {
      const hqs = calculateHQS(item);

      return {
        symbol: item.symbol,
        name: item.name,
        price: item.price,
        changePercent: Number(item.changesPercentage || 0).toFixed(2),
        volume: item.volume,
        avgVolume: item.avgVolume,
        marketCap: item.marketCap,
        hqsScore: hqs,
        rating:
          hqs >= 85 ? "Strong Buy" :
          hqs >= 70 ? "Buy" :
          hqs >= 50 ? "Hold" :
          "Risk",
        decision:
          hqs >= 70 ? "KAUFEN" :
          hqs >= 50 ? "HALTEN" :
          "NICHT KAUFEN",
        aiInsight: getAIInsight(hqs)
      };
    });

    res.json({ success: true, stocks });

  } catch (error) {
    console.error("FMP Fehler:", error.response?.data || error.message);

    res.status(500).json({
      success: false,
      message: "Marktdaten konnten nicht geladen werden.",
      error: error.response?.data || error.message
    });
  }
});

// ============================
// STATUS
// ============================

app.get(["/admin-bypass-status", "/api/admin-bypass-status"], (req, res) => {
  res.json({ active: true, mode: "HQS AI Hybrid Online" });
});

// ============================
// START
// ============================

app.listen(PORT, () => {
  console.log(`🚀 HQS Backend läuft auf Port ${PORT}`);
});
