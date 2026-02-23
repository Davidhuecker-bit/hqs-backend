const express = require("express");
const cors = require("cors");
require("dotenv").config();

// Services laden
const { getMarketData, buildMarketSnapshot } = require("./services/marketService");
const { buildHQSResponse } = require("./hqsEngine");
const { analyzeStockWithGuardian } = require("./services/guardianService"); 

const app = express();
const PORT = process.env.PORT || 8080;

// ==========================================================
// 🛡️ CORS EINSTELLUNGEN
// ==========================================================
// Erlaubt Anfragen von deinem Dashboard und lokalen Tests
app.use(cors({
  origin: [
    "https://dhsystemhqs.de",
    "https://www.dhsystemhqs.de",
    "https://hqs-frontend-v8.vercel.app", // Falls du noch über Vercel-Domains testest
    "http://localhost:3000"
  ],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());

// ==========================================================
// 🧠 GUARDIAN AI ROUTE (Gemini Integration)
// ==========================================================
// Nutzt den GOOGLE_GEMINI_API_KEY aus Railway
app.get("/guardian/analyze/:ticker", async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    console.log(`🛡️ Guardian: Starte KI-Analyse für ${ticker}...`);
    
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
      message: "Guardian Analyse fehlgeschlagen. Bitte GOOGLE_GEMINI_API_KEY in Railway prüfen.",
      error: error.message
    });
  }
});

// ==========================================================
// 📊 MARKET ROUTE (Jetzt via FINSHEET)
// ==========================================================
app.get(["/market", "/api/market"], async (req, res) => {
  try {
    const symbol = req.query.symbol || "IONQ"; // Standardwert falls leer
    const stockData = await getMarketData(symbol.toUpperCase());
    
    res.json({ 
      success: true, 
      source: "Finsheet Hybrid",
      stocks: stockData 
    });
  } catch (error) {
    console.error("Market Fehler:", error.message);
    res.status(500).json({
      success: false,
      message: "Marktdaten-Abfrage über Finsheet fehlgeschlagen.",
      error: error.message
    });
  }
});

// ==========================================================
// 🔥 HQS ENGINE ROUTE (Berechnung & Scores)
// ==========================================================
app.get(["/hqs", "/api/hqs"], async (req, res) => {
  try {
    const symbol = req.query.symbol;
    if (!symbol) return res.status(400).json({ success: false, message: "Symbol fehlt." });

    // Holt Daten von Finsheet
    const marketData = await getMarketData(symbol.toUpperCase());
    
    // Berechnet HQS Scores
    const hqsResult = await buildHQSResponse(marketData);
    
    res.json({ success: true, data: hqsResult });
  } catch (error) {
    console.error("HQS Fehler:", error.message);
    res.status(500).json({ success: false, message: "HQS Berechnung fehlgeschlagen." });
  }
});

// ==========================================================
// ⚙️ STATUS & ADMIN BEREICH
// ==========================================================
app.get(["/admin-bypass-status", "/api/admin-bypass-status"], (req, res) => {
  res.json({ 
    active: true, 
    mode: "HQS AI Hybrid Online", 
    engine: "Finsheet Optimized",
    guardian: "Integrated (Gemini 1.5)",
    fallbacks: "Active (Data from 17.02.2026)" 
  });
});

// ==========================================================
// 🚀 SERVER START
// ==========================================================
app.listen(PORT, async () => {
  console.log(`🚀 HQS Backend aktiv auf Port ${PORT}`);
  console.log(`📡 Nutze FINSHEET_API_KEY für Marktdaten`);
  
  try {
    await buildMarketSnapshot();
  } catch (err) {
    console.error("Initial Snapshot Fehler:", err.message);
  }
});

// Cache/Snapshot alle 15 Minuten auffrischen
setInterval(async () => {
  try {
    await buildMarketSnapshot();
  } catch (err) {
    console.error("Warmup Fehler:", err.message);
  }
}, 15 * 60 * 1000);
