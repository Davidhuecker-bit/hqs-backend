const express = require("express");
const cors = require("cors");
require("dotenv").config();

// Core Services
const {
  getMarketData,
  buildMarketSnapshot,
  ensureTablesExist,
  backfillSymbolHistory,
  updateSymbolDaily,
} = require("./services/marketService");

const { analyzeStockWithGuardian } = require("./services/guardianService");
const { getMarketDataBySegment } = require("./services/aggregator.service");

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
