"use strict";

const express = require("express");
const cors = require("cors");
require("dotenv").config();

// Core Services
const {
  getMarketData,
  buildMarketSnapshot,
  ensureTablesExist,
} = require("./services/marketService");

const { analyzeStockWithGuardian } = require("./services/guardianService");
const { getMarketDataBySegment } = require("./services/aggregator.service");

// ✅ DB init tables (Learning / HQS)
const { initFactorTable } = require("./services/factorHistory.repository");
const { initWeightTable } = require("./services/weightHistory.repository");

const app = express();
const PORT = process.env.PORT || 8080;

// ==========================================================
// CORS
// ==========================================================
app.use(
  cors({
    origin: [
      "https://dhsystemhqs.de",
      "https://www.dhsystemhqs.de",
      "https://hqs-frontend-v8.vercel.app",
      /^https:\/\/hqs-private-quant-[a-z0-9-]+-david-hucker-s-projects\.vercel\.app$/,
      "http://localhost:3000",
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json());

// ==========================================================
// RESPONSE FORMATTER
// Defensive: all score fields fall back to null.
// ==========================================================
function formatMarketItem(item) {
  if (!item || typeof item !== "object") return null;
  return {
    symbol: item.symbol || null,
    price: item.price !== undefined ? item.price : null,
    change: item.change !== undefined ? item.change : null,
    changesPercentage: item.changesPercentage !== undefined ? item.changesPercentage : null,
    high: item.high !== undefined ? item.high : null,
    low: item.low !== undefined ? item.low : null,
    open: item.open !== undefined ? item.open : null,
    previousClose: item.previousClose !== undefined ? item.previousClose : null,
    marketCap: item.marketCap !== undefined ? item.marketCap : null,
    score: item.score !== undefined ? item.score : null,
    rating: item.rating !== undefined ? item.rating : null,
    risk: item.risk !== undefined ? item.risk : null,
    momentum: item.momentum !== undefined ? item.momentum : null,
    stability: item.stability !== undefined ? item.stability : null,
    timestamp: item.timestamp !== undefined ? item.timestamp : null,
    source: item.source || null,
  };
}

// ==========================================================
// MARKET ROUTE
// GET /api/market
// GET /api/market?symbol=AAPL
// ==========================================================
app.get("/api/market", async (req, res) => {
  try {
    const symbol = req.query.symbol
      ? String(req.query.symbol).trim().toUpperCase()
      : null;

    const raw = await getMarketData(symbol || undefined);

    const stocks = Array.isArray(raw)
      ? raw.map(formatMarketItem).filter(Boolean)
      : [];

    // ✅ Wichtig: "stocks" (Frontend-friendly)
    return res.json({
      success: true,
      count: stocks.length,
      stocks,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      count: 0,
      stocks: [],
      error: error.message,
    });
  }
});

// ==========================================================
// SEGMENT ROUTE
// ==========================================================
app.get("/api/segment", async (req, res) => {
  try {
    const segment = String(req.query.segment || "").toLowerCase();
    const symbol = String(req.query.symbol || "").toUpperCase();

    if (!segment || !symbol) {
      return res.status(400).json({
        success: false,
        message: "segment und symbol sind erforderlich.",
      });
    }

    const result = await getMarketDataBySegment({ segment, symbol });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Segment Fehler",
      error: error.message,
    });
  }
});

// ==========================================================
// GUARDIAN ANALYZE (SEGMENT BASED)
// ==========================================================
app.get("/api/guardian/analyze/:ticker", async (req, res) => {
  try {
    const ticker = String(req.params.ticker || "").toUpperCase();
    const segment = String(req.query.segment || "usa").toLowerCase();

    if (!ticker) {
      return res.status(400).json({
        success: false,
        message: "Ticker fehlt.",
      });
    }

    const segmentData = await getMarketDataBySegment({
      segment,
      symbol: ticker,
    });

    if (!segmentData.success) {
      return res.status(404).json({
        success: false,
        message: "Segmentdaten nicht verfügbar.",
        error: segmentData.error,
      });
    }

    const guardianResult = await analyzeStockWithGuardian({
      symbol: ticker,
      segment,
      provider: segmentData.provider,
      fallbackUsed: segmentData.fallbackUsed,
      marketData: segmentData.data,
    });

    return res.json({
      success: true,
      timestamp: new Date().toISOString(),
      guardian: guardianResult,
      marketMeta: {
        segment,
        provider: segmentData.provider,
        fallbackUsed: segmentData.fallbackUsed,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Guardian Analyse fehlgeschlagen",
      error: error.message,
    });
  }
});

// ==========================================================
// SERVER START
// ==========================================================
app.listen(PORT, async () => {
  console.log(`HQS Backend aktiv auf Port ${PORT}`);

  // ✅ Schritt 1: alle Tabellen anlegen
  await ensureTablesExist();
  await initFactorTable();
  await initWeightTable();

  try {
    await buildMarketSnapshot();
  } catch (err) {
    console.error("Initial Snapshot Fehler:", err.message);
  }
});

// Warmup / Snapshot
setInterval(async () => {
  try {
    await buildMarketSnapshot();
  } catch (err) {
    console.error("Warmup Fehler:", err.message);
  }
}, 15 * 60 * 1000);
