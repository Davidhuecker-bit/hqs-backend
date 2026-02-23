const express = require("express");
const cors = require("cors");
require("dotenv").config();

// Services laden
const { getMarketData, buildMarketSnapshot } = require("./services/marketService");
const { buildHQSResponse } = require("./hqsEngine");
const { analyzeStockWithGuardian } = require("./services/guardianService"); 

const app = express();
const PORT = process.env.PORT || 8080;

// CORS Einstellungen für dein Dashboard
app.use(cors({
  origin: [
    "https://dhsystemhqs.de",
    "https://www.dhsystemhqs.de",
    "http://localhost:3000"
  ],
  methods: ["GET", "POST"]
}));

app.use(express.json());

// ==========================================================
// 🛡️ GUARDIAN AI ROUTE (Gemini Integration)
// ==========================================================
// Test-Link: /guardian/analyze/IONQ
app.get("/guardian/analyze/:ticker", async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    console.log(`🛡️ Guardian: Starte KI-Analyse für ${ticker}...`);
    
    // Hier nutzen wir den GOOGLE_GEMINI_API_KEY
    const analysis = await analyzeStockWithGuardian(ticker);
    
    res.json({
      success: true,
      ticker: ticker,
      timestamp: new Date().toISOString(),
      analysis: analysis
    });
  } catch (error) {
    console.error("Guardian Fehler:", error.message);
    res.status(500).json({
      success: false,
      message: "Guardian Analyse fehlgeschlagen. Prüfe API-Keys.",
      error: error.message
    });
  }
});

// ==========================================================
// 📈 MARKET ROUTE (Finnhub & Fallbacks)
// ==========================================================
app.get(["/market", "/api/market"], async (req, res) => {
  try {
    const symbol = req.query.symbol || null;
    const stocks = await getMarketData(symbol);
    res.json({ success: true, stocks });
  } catch (error) {
    console.error("Market Fehler:", error.message);
    res.status(500).json({
      success: false,
      message: "Marktdaten konnten nicht geladen werden.",
      error: error.message
    });
  }
});

// ==========================================================
// 🔥 HQS ENGINE ROUTE
// ==========================================================
app.get(["/hqs", "/api/hqs"], async (req, res) => {
  try {
    const symbol = req.query.symbol;
    if (!symbol) return res.status(400).json({ success: false, message: "Symbol fehlt." });

    const marketData = await getMarketData(symbol.toUpperCase());
    if (!marketData) return res.status(404).json({ success: false, message: "Symbol nicht gefunden." });

    const hqsResult = await buildHQSResponse(marketData);
    res.json({ success: true, data: hqsResult });
  } catch (error) {
    console.error("HQS Fehler:", error.message);
    res.status(500).json({ success: false, message: "HQS Berechnung fehlgeschlagen." });
  }
});

// ==========================================================
// ⚙️ STATUS & ADMIN
// ==========================================================
app.get(["/admin-bypass-status", "/api/admin-bypass-status"], (req, res) => {
  res.json({ 
    active: true, 
    mode: "HQS AI Hybrid Online", 
    guardian: "Integrated",
    fallbacks: "Active (Data from 17.02.2026)" 
  });
});

// ==========================================================
// 🚀 SERVER START & JOBS
// ==========================================================
app.listen(PORT, async () => {
  console.log(`🚀 HQS Backend aktiv auf Port ${PORT}`);
  try {
    await buildMarketSnapshot();
  } catch (err) {
    console.error("Initial Snapshot Fehler:", err.message);
  }
});

// Alle 15 Minuten Daten auffrischen (Warmup)
setInterval(async () => {
  try {
    await buildMarketSnapshot();
  } catch (err) {
    console.error("Warmup Fehler:", err.message);
  }
}, 15 * 60 * 1000);
