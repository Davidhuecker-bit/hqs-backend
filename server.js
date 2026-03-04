"use strict";

const express = require("express");
const cors = require("cors");
require("dotenv").config();

/* =========================================================
   LOGGER
========================================================= */
const logger = require("./utils/logger");

/* =========================================================
   CORE SERVICES
========================================================= */

const {
  getMarketData,
  buildMarketSnapshot,
  ensureTablesExist,
} = require("./services/marketService");

const { buildHQSResponse } = require("./hqsEngine");

const { analyzeStockWithGuardian } = require("./services/guardianService");
const { getMarketDataBySegment } = require("./services/aggregator.service");

const { calculatePortfolioHQS } = require("./services/portfolioHqs.service");

const { initFactorTable } = require("./services/factorHistory.repository");
const { initWeightTable } = require("./services/weightHistory.repository");

const { runForwardLearning } = require("./services/forwardLearning.service");

// ✅ Locking (prevents double runs)
const { acquireLock } = require("./services/jobLock.repository");

/* =========================================================
   NOTIFICATIONS (In-App)
========================================================= */

const notificationsRoutes = require("./routes/notifications.routes");
const {
  initNotificationTables,
  seedDemoUserIfEmpty,
} = require("./services/notifications.repository");

/* =========================================================
   APP INIT
========================================================= */

const app = express();
const PORT = process.env.PORT || 8080;

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
  })
);

app.use(express.json());

/* =========================================================
   ROUTES
========================================================= */

// ✅ In-App Notification Center
app.use("/api/notifications", notificationsRoutes);

/* =========================================================
   RESPONSE FORMATTER
========================================================= */

function formatMarketItem(item) {
  if (!item || typeof item !== "object") return null;

  const hqsBreakdown =
    item.momentum !== null ||
    item.quality !== null ||
    item.stability !== null ||
    item.relative !== null
      ? {
          momentum: item.momentum ?? null,
          quality: item.quality ?? null,
          stability: item.stability ?? null,
          relative: item.relative ?? null,
        }
      : null;

  return {
    symbol: item.symbol ?? null,
    price: item.price ?? null,
    change: item.change ?? null,
    changesPercentage: item.changesPercentage ?? null,
    high: item.high ?? null,
    low: item.low ?? null,
    open: item.open ?? null,
    previousClose: item.previousClose ?? null,
    marketCap: item.marketCap ?? null,

    // ✅ DB-first HQS
    hqsScore: item.hqsScore ?? null,
    hqsBreakdown,
    regime: item.regime ?? null,
    hqsCreatedAt: item.hqsCreatedAt ?? null,

    // ✅ Advanced (DB-first wenn market_advanced_metrics genutzt wird)
    trend: item.trend ?? null,
    volatility: item.volatility ?? null,
    scenarios: item.scenarios ?? null,
    advancedUpdatedAt: item.advancedUpdatedAt ?? null,

    timestamp: item.timestamp ?? null,
    source: item.source ?? null,
  };
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/", (req, res) => {
  res.json({
    success: true,
    status: "HQS Backend running",
    time: new Date().toISOString(),
  });
});

/* =========================================================
   MARKET ROUTE
========================================================= */

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
    logger.error("Market route error", { message: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
   HQS ROUTE (DB-first)
========================================================= */

app.get("/api/hqs", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").trim().toUpperCase();

    if (!symbol) {
      return res.status(400).json({
        success: false,
        message: "Symbol fehlt.",
      });
    }

    const marketData = await getMarketData(symbol);

    if (!marketData.length) {
      return res.status(404).json({
        success: false,
        message: "Keine Marktdaten gefunden.",
      });
    }

    // ✅ DB-first
    if (marketData[0].hqsScore !== null && marketData[0].hqsScore !== undefined) {
      return res.json({
        success: true,
        symbol,
        hqsScore: marketData[0].hqsScore,
        hqsBreakdown: {
          momentum: marketData[0].momentum ?? null,
          quality: marketData[0].quality ?? null,
          stability: marketData[0].stability ?? null,
          relative: marketData[0].relative ?? null,
        },
        regime: marketData[0].regime ?? null,

        // ✅ Advanced
        trend: marketData[0].trend ?? null,
        volatility: marketData[0].volatility ?? null,
        scenarios: marketData[0].scenarios ?? null,
        advancedUpdatedAt: marketData[0].advancedUpdatedAt ?? null,

        source: "database",
      });
    }

    // Live fallback
    const fullMarket = await getMarketData();
    const changes = Array.isArray(fullMarket)
      ? fullMarket.map((s) => Number(s?.changesPercentage) || 0)
      : [];
    const marketAverage =
      changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;

    const hqs = await buildHQSResponse(marketData[0], marketAverage);

    return res.json({
      success: true,
      symbol,
      hqs,
      source: "live",
      marketAverage: Number(marketAverage.toFixed(4)),
    });
  } catch (error) {
    logger.error("HQS route error", { message: error.message });
    return res.status(500).json({
      success: false,
      message: "HQS Berechnung fehlgeschlagen",
      error: error.message,
    });
  }
});

/* =========================================================
   SEGMENT ROUTE
========================================================= */

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
    logger.error("Segment route error", { message: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
   GUARDIAN ROUTE
========================================================= */

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
      guardian: guardianResult,
    });
  } catch (error) {
    logger.error("Guardian route error", { message: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
   PORTFOLIO ROUTE
========================================================= */

app.post("/api/portfolio", async (req, res) => {
  try {
    const portfolio = req.body;

    if (!Array.isArray(portfolio) || !portfolio.length) {
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
    logger.error("Portfolio route error", { message: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
   SAFE FORWARD LEARNING RUNNER (LOCKED)
========================================================= */

async function runForwardLearningLocked() {
  const won = await acquireLock("forward_learning_job", 12 * 60);
  if (!won) {
    logger.warn("Forward learning skipped (lock held)");
    return;
  }

  await runForwardLearning();
  logger.info("Forward learning executed");
}

/* =========================================================
   SERVER START
========================================================= */

app.listen(PORT, async () => {
  logger.info(`HQS Backend aktiv auf Port ${PORT}`);

  try {
    // Core tables
    await ensureTablesExist();
    await initFactorTable();
    await initWeightTable();

    // Notification center tables
    await initNotificationTables();
    await seedDemoUserIfEmpty();

    // Warm start
    await buildMarketSnapshot();
    await runForwardLearningLocked();

    logger.info("Startup completed successfully");
  } catch (err) {
    logger.error("Startup Fehler", { message: err.message });
  }
});

/* =========================================================
   AUTO SNAPSHOT + FORWARD LEARNING
========================================================= */

setInterval(async () => {
  try {
    await buildMarketSnapshot();
    await runForwardLearningLocked();
    logger.info("Warmup executed");
  } catch (err) {
    logger.error("Warmup Fehler", { message: err.message });
  }
}, 15 * 60 * 1000);
