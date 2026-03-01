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

// ✅ NEU: Portfolio Engine
const { calculatePortfolioHQS } = require("./services/portfolioHqs.service");

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
// ==========================================================
function formatMarketItem(item) {
  if (!item || typeof item !== "object") return null;
  return {
    symbol: item.symbol || null,
    price: item.price ?? null,
    change: item.change ?? null,
    changesPercentage: item.changesPercentage ?? null,
    high: item.high ?? null,
    low: item.low ?? null,
    open: item.open ?? null,
    previousClose: item.previousClose ?? null,
    marketCap: item.marketCap ?? null,
    score: item.score ?? null,
    rating: item.rating ?? null,
    risk: item.risk ?? null,
    momentum: item.momentum ?? null,
    stability: item.stability ?? null,
    timestamp: item.timestamp ?? null,
    source: item.source || null,
  };
}

// ==========================================================
// MARKET ROUTE
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
// GUARDIAN ANALYZE
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
// 🔥 PORTFOLIO ROUTE (NEU)
// POST /api/portfolio
// ==========================================================
app.post("/api/portfolio", async (req, res) => {
  try {
    const portfolio = req.body;

    if (!Array.isArray(portfolio) || portfolio.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Portfolio muss ein Array sein.",
      });
    }

    const result = await calculatePortfolioHQS(portfolio);

    return res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error("Portfolio API Error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Portfolio Berechnung fehlgeschlagen",
      error: error.message,
    });
  }
});

// ==========================================================
// SERVER START
// ==========================================================
app.listen(PORT, async () => {
  console.log(`HQS Backend aktiv auf Port ${PORT}`);

  await ensureTablesExist();
  await initFactorTable();
  await initWeightTable();

  try {
    await buildMarketSnapshot();
  } catch (err) {
    console.error("Initial Snapshot Fehler:", err.message);
  }
});

// ==========================================================
// WARMUP SNAPSHOT
// ==========================================================
setInterval(async () => {
  try {
    await buildMarketSnapshot();
  } catch (err) {
    console.error("Warmup Fehler:", err.message);
  }
}, 15 * 60 * 1000);
