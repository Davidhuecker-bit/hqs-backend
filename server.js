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
// 🧠 GUARDIAN ANALYZE ROUTE
// ==========================================================

app.get(["/guardian/analyze/:ticker", "/api/guardian/analyze/:ticker"], async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();

    const analysis = await analyzeStockWithGuardian(ticker);

    res.json({
      success: true,
      ticker,
      timestamp: new Date().toISOString(),
      analysis
    });

  } catch (error) {
    console.error("Guardian Fehler:", error.message);
    res.status(500).json({
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
    const hasSymbolsQuery =
      typeof req.query.symbols === "string" && req.query.symbols.trim().length > 0;

    const generatedAt = new Date().toISOString();
    let stocks = [];

    if (hasSymbolsQuery) {
      const symbols = parseSymbolsQuery(req.query.symbols);
      stocks = await getMarketData();
    } else {
      stocks = await getMarketData();
    }

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
// 🗞️ MARKET NEWS ROUTE
// ==========================================================

app.get("/api/market-news", async (req, res) => {
  try {
    const symbols = parseSymbolsQuery(req.query.symbols);
    const stocks = await getMarketData();

    const payload = buildMarketNewsPayload(
      symbols,
      stocks,
      new Date().toISOString()
    );

    res.json(payload);

  } catch (error) {
    console.error("Market News Fehler:", error.message);
    res.json({
      degraded: true,
      message: "News-Fallback aktiv."
    });
  }
});

// ==========================================================
// 🕵️ INSIDER SIGNAL ROUTE
// ==========================================================

app.get("/api/insider-signal", async (req, res) => {
  try {
    const symbols = parseSymbolsQuery(req.query.symbols);
    const stocks = await getMarketData();

    const payload = buildInsiderSignalPayload(
      symbols,
      stocks,
      new Date().toISOString()
    );

    res.json(payload);

  } catch (error) {
    console.error("Insider Signal Fehler:", error.message);
    res.json({
      degraded: true,
      message: "Insider-Fallback aktiv."
    });
  }
});

// ==========================================================
// ⚙️ STATUS ROUTE
// ==========================================================

app.get("/api/status", (req, res) => {
  res.json({
    active: true,
    mode: "HQS AI Hybrid Online",
    engine: "Finnhub Optimized",
    guardian: "Gemini Integrated",
    database: "Postgres + Redis"
  });
});

// ==========================================================
// 🚀 SERVER START
// ==========================================================

app.listen(PORT, async () => {
  console.log(`🚀 HQS Backend aktiv auf Port ${PORT}`);

  // Tabelle prüfen / erstellen
  await ensureTablesExist();

  try {
    await buildMarketSnapshot();
  } catch (err) {
    console.error("Initial Snapshot Fehler:", err.message);
  }
});

// Snapshot Refresh alle 15 Minuten
setInterval(async () => {
  try {
    await buildMarketSnapshot();
  } catch (err) {
    console.error("Warmup Fehler:", err.message);
  }
}, 15 * 60 * 1000);
