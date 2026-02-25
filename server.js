const express = require("express");
const cors = require("cors");
require("dotenv").config();

// Services
const {
  getMarketData,
  buildMarketSnapshot,
  ensureTablesExist
} = require("./services/marketService");

const { analyzeStockWithGuardian } = require("./services/guardianService");

const {
  parseSymbolsQuery,
  buildGuardianPayload,
  buildMarketNewsPayload,
  buildInsiderSignalPayload,
} = require("./services/frontendAdapter.service");

const app = express();
const PORT = process.env.PORT || 8080;

// ==========================================================
// 🛡️ CORS SETTINGS
// ==========================================================

app.use(cors({
  origin: [
    "https://dhsystemhqs.de",
    "https://www.dhsystemhqs.de",
    "https://hqs-frontend-v8.vercel.app",
    /^https:\/\/hqs-private-quant-[a-z0-9-]+-david-hucker-s-projects\.vercel\.app$/,
    "http://localhost:3000"
  ],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());

// ==========================================================
// 🧠 GUARDIAN ANALYZE ROUTE (FIXED)
// ==========================================================

app.get(["/guardian/analyze/:ticker", "/api/guardian/analyze/:ticker"], async (req, res) => {
  try {
    const ticker = String(req.params.ticker || "").toUpperCase();

    if (!ticker) {
      return res.status(400).json({
        success: false,
        message: "Ticker fehlt."
      });
    }

    console.log(`🛡️ Guardian Analyse startet für ${ticker}`);

    // 1️⃣ HQS Daten laden
    const marketData = await getMarketData(ticker);

    if (!Array.isArray(marketData) || marketData.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Keine Marktdaten für ${ticker} gefunden.`
      });
    }

    const stockData = marketData[0];

    // 2️⃣ Guardian mit vollständigem HQS-Kontext
    const guardianResult = await analyzeStockWithGuardian(stockData);

    return res.json({
      success: true,
      timestamp: new Date().toISOString(),
      data: guardianResult
    });

  } catch (error) {
    console.error("Guardian Route Fehler:", error.message);

    return res.status(500).json({
      success: false,
      message: "Guardian Analyse fehlgeschlagen.",
      error: error.message
    });
  }
});

// ==========================================================
// 🧠 GUARDIAN SNAPSHOT ROUTE
// ==========================================================

app.get(["/guardian", "/api/guardian"], async (req, res) => {
  try {
    const generatedAt = new Date().toISOString();
    const stocks = await getMarketData();

    const payload = buildGuardianPayload(stocks, { generatedAt });
    res.json(payload);

  } catch (error) {
    console.error("Guardian Snapshot Fehler:", error.message);

    const fallbackPayload = buildGuardianPayload([], {
      generatedAt: new Date().toISOString()
    });

    res.json({
      ...fallbackPayload,
      degraded: true,
      message: "Guardian Snapshot Fallback aktiv."
    });
  }
});

// ==========================================================
// 📊 MARKET ROUTE
// ==========================================================

app.get(["/market", "/api/market"], async (req, res) => {
  try {
    const symbol =
      typeof req.query.symbol === "string"
        ? req.query.symbol.trim().toUpperCase()
        : "";

    const stockData = await getMarketData(symbol || undefined);

    res.json({
      success: true,
      source: "Finnhub + HQS Engine",
      stocks: stockData
    });

  } catch (error) {
    console.error("Market Fehler:", error.message);
    res.status(500).json({
      success: false,
      message: "Marktdaten-Abfrage fehlgeschlagen.",
      error: error.message
    });
  }
});

// ==========================================================
// 🔥 HQS ROUTE (Single Symbol)
// ==========================================================

app.get(["/hqs", "/api/hqs"], async (req, res) => {
  try {
    const symbol =
      typeof req.query.symbol === "string"
        ? req.query.symbol.trim().toUpperCase()
        : "";

    if (!symbol) {
      return res.status(400).json({
        success: false,
        message: "Symbol fehlt."
      });
    }

    const marketData = await getMarketData(symbol);

    if (!Array.isArray(marketData) || marketData.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Keine Daten für ${symbol} gefunden.`
      });
    }

    res.json({
      success: true,
      data: marketData[0]
    });

  } catch (error) {
    console.error("HQS Fehler:", error.message);
    res.status(500).json({
      success: false,
      message: "HQS Berechnung fehlgeschlagen."
    });
  }
});

// ==========================================================
// 🚀 SERVER START
// ==========================================================

app.listen(PORT, async () => {
  console.log(`🚀 HQS Backend aktiv auf Port ${PORT}`);

  await ensureTablesExist();

  try {
    await buildMarketSnapshot();
  } catch (err) {
    console.error("Initial Snapshot Fehler:", err.message);
  }
});

setInterval(async () => {
  try {
    await buildMarketSnapshot();
  } catch (err) {
    console.error("Warmup Fehler:", err.message);
  }
}, 15 * 60 * 1000);
