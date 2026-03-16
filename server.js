"use strict";

const path = require("path");
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

/* =========================================================
LOGGER
========================================================= */

const logger = require("./utils/logger");
const {
  badRequest,
  parseEnum,
  parseInteger,
  parseNumber,
  parseSymbol,
} = require("./utils/requestValidation");

/* =========================================================
CORE SERVICES
========================================================= */

const {
  getMarketData,
  buildMarketSnapshot,
  hydrateMarketRuntimeState,
  ensureTablesExist,
  pingDb,
  getPipelineStatus,
} = require("./services/marketService");

const { buildHQSResponse } = require("./hqsEngine");

const { analyzeStockWithGuardian } = require("./services/guardianService");
const { getMarketDataBySegment } = require("./services/aggregator.service");

const { calculatePortfolioHQS } = require("./services/portfolioHqs.service");
const { optimizePortfolio } = require("./services/portfolioOptimizer");
const { simulateStrategy } = require("./services/backtestEngine");
const { buildGuardianPayload } = require("./services/frontendAdapter.service");

const { initFactorTable } = require("./services/factorHistory.repository");
const { initWeightTable } = require("./services/weightHistory.repository");
const { getBacktestHistory } = require("./services/factorHistory.repository");

const { runForwardLearning } = require("./services/forwardLearning.service");

const {
  collectAndStoreMarketNews,
  normalizeSymbols,
} = require("./services/marketNews.service");

const { acquireLock, initJobLocksTable } = require("./services/jobLock.repository");
const {
  runMarketNewsRefreshJob,
} = require("./jobs/marketNewsRefresh.job");
const {
  runNewsLifecycleCleanupJob,
} = require("./jobs/newsLifecycleCleanup.job");
const {
  hydrateOpportunityRuntimeState,
} = require("./services/opportunityScanner.service");
const { buildWorldState } = require("./services/worldState.service");

/* =========================================================
UNIVERSE
========================================================= */

const { refreshUniverse } = require("./services/universe.service");

/* =========================================================
ROUTES
========================================================= */

const opportunitiesRoutes = require("./routes/opportunities.routes");
const discoveryRoutes = require("./routes/discovery.routes");
const notificationsRoutes = require("./routes/notifications.routes");
const adminRoutes = require("./routes/admin.routes");
const marketNewsRoutes = require("./routes/marketNews.routes");
const secEdgarRoutes = require("./routes/secEdgar.routes");

/* =========================================================
DISCOVERY
========================================================= */

const { initDiscoveryTable } = require("./services/discoveryLearning.repository");
const { initSecEdgarTables } = require("./services/secEdgar.repository");
const { initAdminSnapshotsTable } = require("./services/adminSnapshots.repository");
const { initAutonomyAuditTable, initNearMissTable, initAutomationAuditTable } = require("./services/autonomyAudit.repository");
const { initAgentForecastTable, initAgentsTable } = require("./services/agentForecast.repository");
const { initDynamicWeightsTable } = require("./services/causalMemory.repository");
const { runForecastVerificationJob } = require("./jobs/forecastVerification.job");
const { runCausalMemoryJob } = require("./jobs/causalMemory.job");
const { initTechRadarTable, initSystemEvolutionProposalsTable } = require("./services/techRadar.service");
const { runTechRadarJob } = require("./jobs/techRadar.job");
const { ensureVirtualPositionsTable } = require("./services/portfolioTwin.service");
const { ensureSisHistoryTable, saveSisSnapshot } = require("./services/sisHistory.service");
const { ensurePipelineStatusTable } = require("./services/pipelineStatus.repository");
const { getSystemIntelligenceReport } = require("./services/systemIntelligence.service");

/* =========================================================
DB HEALTH  (Task 1 – centralised DB error classification)
========================================================= */

const { waitForDb, classifyDbError } = require("./utils/dbHealth");

/* =========================================================
TABLE HEALTH  (Task 5 – admin table diagnostics)
========================================================= */

const { runTableHealthCheck } = require("./services/tableHealth.service");

/* =========================================================
NOTIFICATIONS
========================================================= */

const {
  initNotificationTables,
  seedDemoUserIfEmpty,
} = require("./services/notifications.repository");

/* =========================================================
APP INIT
========================================================= */

const app = express();
const PORT = process.env.PORT || 8080;
const SUPPORTED_SEGMENTS = ["usa", "europe", "china", "japan", "india"];
const SEGMENT_ALIASES = {
  us: "usa",
};
const DEFAULT_CORS_ORIGINS = [
  "https://dhsystemhqs.de",
  "https://www.dhsystemhqs.de",
  "https://hqs-frontend-v8.vercel.app",
  /^https:\/\/hqs-private-quant-[a-z0-9-]+-david-hucker-s-projects\.vercel\.app$/,
  "http://localhost:3000",
];

const STARTUP_DB_MAX_RETRIES    = Number(process.env.STARTUP_DB_MAX_RETRIES    || 10);
const STARTUP_DB_RETRY_DELAY_MS = Number(process.env.STARTUP_DB_RETRY_DELAY_MS || 3000);

const RUN_JOBS =
  String(process.env.RUN_JOBS || "false").toLowerCase() === "true";
const EXTRA_CORS_ORIGINS = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const ALLOWED_CORS_ORIGINS = [...DEFAULT_CORS_ORIGINS, ...EXTRA_CORS_ORIGINS];
const startupState = {
  ready: false,
  startedAt: new Date().toISOString(),
  completedAt: null,
  error: null,
  initErrors: null,
};

// Lightweight single-connection pool reused by the DB readiness probe
// inside runIntegratedWarmupCycle (avoids creating a new pool on every tick).
const _warmupProbePool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

function isAllowedCorsOrigin(origin) {
  if (!origin) return true;

  return ALLOWED_CORS_ORIGINS.some((allowedOrigin) => {
    if (allowedOrigin instanceof RegExp) {
      return allowedOrigin.test(origin);
    }

    return allowedOrigin === origin;
  });
}

app.use(
  cors({
    origin(origin, callback) {
      return callback(null, isAllowedCorsOrigin(origin));
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* =========================================================
ROUTES
========================================================= */

app.use("/api/notifications", notificationsRoutes);
app.use("/api/opportunities", opportunitiesRoutes);
app.use("/api/discovery", discoveryRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/market-news", marketNewsRoutes);
app.use("/api/sec-edgar", secEdgarRoutes);

/* Alias: /api/admin-demo-portfolio → /api/admin/demo-portfolio */
const { getAdminDemoPortfolio } = require("./services/adminDemoPortfolio.service");
app.get("/api/admin-demo-portfolio", async (_req, res) => {
  try {
    const result = await getAdminDemoPortfolio();
    return res.json(result);
  } catch (error) {
    return res.json({
      success: false,
      dataStatus: "error",
      holdings: [],
      partialErrors: [{ symbol: "*", error: error.message }],
      generatedAt: new Date().toISOString(),
      summary: { total: 0, green: 0, yellow: 0, red: 0, topBottleneck: null },
    });
  }
});

/* =========================================================
FORMATTER
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

    hqsScore: item.hqsScore ?? null,
    hqsBreakdown,
    regime: item.regime ?? null,
    hqsCreatedAt: item.hqsCreatedAt ?? null,

    trend: item.trend ?? null,
    volatility: item.volatility ?? null,
    scenarios: item.scenarios ?? null,
    advancedUpdatedAt: item.advancedUpdatedAt ?? null,

    timestamp: item.timestamp ?? null,
    source: item.source ?? null,
  };
}

function normalizeSegmentInput(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return SEGMENT_ALIASES[normalized] || normalized;
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

app.get("/health", async (req, res) => {
  let dbOk = false;
  let dbError = null;
  let dbErrorType = null;

  try {
    await pingDb();
    dbOk = true;
  } catch (err) {
    dbError     = err.message;
    dbErrorType = classifyDbError(err);
  }

  // Railway restart loop prevention: once the listen callback has completed
  // (on any boot), we consider the HTTP server itself "alive".
  // Individual DB / init failures are surfaced in the response body but do
  // NOT cause a 503 — that would trigger an infinite restart loop on Railway.
  // A 503 is only returned during the brief startup window while the listen
  // callback is still running.
  const serverAlive = startupState.completedAt !== null;
  const statusCode  = serverAlive ? 200 : 503;

  // Surface the first critical init error for fast triage
  const criticalInitErrors = Array.isArray(startupState.initErrors)
    ? startupState.initErrors.filter((e) => e.critical)
    : [];
  const lastCriticalError = criticalInitErrors.length > 0
    ? criticalInitErrors[criticalInitErrors.length - 1]
    : undefined;

  return res.status(statusCode).json({
    success:     serverAlive,
    ready:       startupState.ready,
    generatedAt: new Date().toISOString(),
    db:          dbOk ? "ok" : "error",
    dbReady:     dbOk,
    dbError:     dbError     || undefined,
    dbErrorType: dbErrorType || undefined,
    startedAt:      startupState.startedAt,
    completedAt:    startupState.completedAt,
    startupError:   startupState.error || undefined,
    lastCriticalError: lastCriticalError || undefined,
    initErrors: Array.isArray(startupState.initErrors) && startupState.initErrors.length > 0
      ? startupState.initErrors
      : undefined,
    jobsEnabled: RUN_JOBS,
  });
});

/* =========================================================
MARKET ROUTE
========================================================= */

app.get("/api/market", async (req, res) => {
  try {
    const symbolResult = parseSymbol(req.query.symbol, {
      required: false,
      label: "symbol",
    });
    if (symbolResult.error) {
      return badRequest(res, symbolResult.error);
    }

    const symbol = symbolResult.value;

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
ADMIN NEWS COLLECTOR
========================================================= */

app.get("/api/admin/collect-market-news", async (req, res) => {
  try {
    const symbols = normalizeSymbols((req.query.symbols || "").split(","));
    const limitResult = parseInteger(req.query.limit, {
      defaultValue: 5,
      min: 1,
      max: 25,
      label: "limit",
    });
    if (limitResult.error) {
      return badRequest(res, limitResult.error);
    }

    const limit = limitResult.value;

    if (!symbols.length) {
      return badRequest(res, "symbols query parameter is required");
    }

    const summary = await collectAndStoreMarketNews(symbols, limit);

    return res.json({
      success: true,
      ...summary,
    });
  } catch (error) {
    logger.error("Collect market news route error", { message: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
HQS ROUTE
========================================================= */

app.get("/api/hqs", async (req, res) => {
  try {
    const symbolResult = parseSymbol(req.query.symbol, {
      required: true,
      label: "symbol",
    });
    if (symbolResult.error) {
      return badRequest(res, symbolResult.error);
    }

    const symbol = symbolResult.value;

    const marketData = await getMarketData(symbol);

    if (!marketData.length) {
      return res.status(404).json({
        success: false,
        message: "Keine Marktdaten gefunden.",
      });
    }

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
        trend: marketData[0].trend ?? null,
        volatility: marketData[0].volatility ?? null,
        scenarios: marketData[0].scenarios ?? null,
        advancedUpdatedAt: marketData[0].advancedUpdatedAt ?? null,
        source: "database",
      });
    }

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
    const segmentResult = parseEnum(normalizeSegmentInput(req.query.segment), SUPPORTED_SEGMENTS, {
      required: true,
      label: "segment",
    });
    if (segmentResult.error) {
      return badRequest(res, segmentResult.error);
    }

    const symbolResult = parseSymbol(req.query.symbol, {
      required: true,
      label: "symbol",
    });
    if (symbolResult.error) {
      return badRequest(res, symbolResult.error);
    }

    const segment = segmentResult.value;
    const symbol = symbolResult.value;
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
    const tickerResult = parseSymbol(req.params.ticker, {
      required: true,
      label: "ticker",
    });
    if (tickerResult.error) {
      return badRequest(res, tickerResult.error);
    }

    const segmentResult = parseEnum(normalizeSegmentInput(req.query.segment), SUPPORTED_SEGMENTS, {
      defaultValue: "usa",
      label: "segment",
    });
    if (segmentResult.error) {
      return badRequest(res, segmentResult.error);
    }

    const ticker = tickerResult.value;
    const segment = segmentResult.value;
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

    const normalizedPortfolio = [];
    for (const [index, position] of portfolio.entries()) {
      if (!position || typeof position !== "object") {
        return badRequest(res, `portfolio[${index}] must be an object`);
      }

      const symbolResult = parseSymbol(position.symbol, {
        required: true,
        label: `portfolio[${index}].symbol`,
      });
      if (symbolResult.error) {
        return badRequest(res, symbolResult.error);
      }

      const weightResult = parseNumber(position.weight, {
        defaultValue: 1,
        min: 0,
        label: `portfolio[${index}].weight`,
      });
      if (weightResult.error) {
        return badRequest(res, weightResult.error);
      }

      normalizedPortfolio.push({
        ...position,
        symbol: symbolResult.value,
        weight: weightResult.value,
      });
    }

    const result = await calculatePortfolioHQS(normalizedPortfolio);

    const optimizedAllocation = optimizePortfolio(
      Array.isArray(result?.positions) ? result.positions : normalizedPortfolio
    );

    return res.json({
      success: true,
      ...result,
      optimizedAllocation,
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
BACKTEST ROUTE
========================================================= */

/**
 * GET /api/backtest?symbol=AAPL&threshold=70
 * Simulates an HQS-threshold strategy on historical factor+price data.
 * Returns winRate, totalReturn, averageReturn, sharpe, maxDrawdown.
 */
app.get("/api/backtest", async (req, res) => {
  try {
    const symbolResult = parseSymbol(req.query.symbol, {
      required: true,
      label: "symbol",
    });
    if (symbolResult.error) {
      return badRequest(res, symbolResult.error);
    }

    const thresholdResult = parseInteger(req.query.threshold, {
      defaultValue: 70,
      min: 0,
      max: 100,
      label: "threshold",
    });
    if (thresholdResult.error) {
      return badRequest(res, thresholdResult.error);
    }

    const symbol = symbolResult.value;
    const threshold = thresholdResult.value;

    const history = await getBacktestHistory(symbol);

    if (!history.length) {
      return res.status(404).json({
        success: false,
        message: "Keine Backtest-Daten verfügbar für dieses Symbol.",
        symbol,
      });
    }

    const result = simulateStrategy(history, threshold);

    return res.json({
      success: true,
      symbol,
      threshold,
      dataPoints: history.length,
      ...result,
    });
  } catch (error) {
    logger.error("Backtest route error", { message: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
GUARDIAN DASHBOARD ROUTE
========================================================= */

/**
 * GET /api/guardian/dashboard
 * Returns a fully normalized guardian dashboard payload for the frontend.
 * Includes portfolioHealth, topSignals, riskFlags, alerts, correlationSeries.
 */
app.get("/api/guardian/dashboard", async (req, res) => {
  try {
    const raw = await getMarketData();
    const stocks = Array.isArray(raw) ? raw : [];
    const payload = buildGuardianPayload(stocks);
    return res.json(payload);
  } catch (error) {
    logger.error("Guardian dashboard route error", { message: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
SAFE FORWARD LEARNING
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
UNIVERSE REFRESH
========================================================= */

async function runUniverseRefreshLocked() {
  const won = await acquireLock("universe_refresh_job", 2 * 60 * 60);

  if (!won) {
    logger.warn("Universe refresh skipped (lock held)");
    return;
  }

  await refreshUniverse();
  logger.info("Universe refresh executed");
}

async function runIntegratedWarmupCycle() {
  // ── DB readiness guard ────────────────────────────────────────────────────
  // If the DB is not reachable, skip the entire warmup cycle instead of
  // letting each step fail with hard errors.
  const warmupDbReady = await waitForDb(_warmupProbePool, {
    maxRetries: 2,
    delayMs: 2000,
    label: "warmup:dbReady",
  });

  if (!warmupDbReady) {
    logger.warn("[warmup] DB not ready – skipping warmup cycle", {
      skipReason: "DB_NOT_READY",
    });
    return;
  }

  try {
    await runMarketNewsRefreshJob({ closePool: false });
  } catch (error) {
    logger.warn("Market news refresh failed inside RUN_JOBS", {
      message: error.message,
      errorType: classifyDbError(error),
    });
  }

  try {
    await runNewsLifecycleCleanupJob();
  } catch (error) {
    logger.warn("News lifecycle cleanup failed inside RUN_JOBS", {
      message: error.message,
      errorType: classifyDbError(error),
    });
  }

  try {
    await buildMarketSnapshot();
  } catch (error) {
    logger.warn("buildMarketSnapshot failed inside warmup cycle", {
      message: error.message,
      errorType: classifyDbError(error),
    });
  }

  try {
    await runForwardLearningLocked();
  } catch (error) {
    logger.warn("runForwardLearningLocked failed inside warmup cycle", {
      message: error.message,
      errorType: classifyDbError(error),
    });
  }

  // Rebuild world_state after each market snapshot so it reflects the latest
  // regime, volatility and cross-asset signals. Non-blocking.
  buildWorldState().catch((wsErr) => {
    logger.warn("worldState: rebuild after warmup failed", {
      message: wsErr.message,
      errorType: classifyDbError(wsErr),
    });
  });

  // Persist a SIS snapshot after each warmup – non-blocking, deduped by interval.
  getSystemIntelligenceReport().then((report) => saveSisSnapshot(report)).catch((sisErr) => {
    logger.warn("sisHistory: snapshot after warmup failed", {
      message: sisErr.message,
      errorType: classifyDbError(sisErr),
    });
  });
}

/* =========================================================
SERVER START
========================================================= */

async function runStartupInit() {
  const initErrors = [];
  let okCount = 0;

  // ── DB readiness guard (Task 1 + Task 2) ─────────────────────────────────
  // Before touching any table, verify the DB is actually reachable.
  // Use a dedicated pool probe so we get typed error categories.
  const probePool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 1,
  });

  let dbReady = false;
  try {
    dbReady = await waitForDb(probePool, {
      maxRetries: STARTUP_DB_MAX_RETRIES,
      delayMs: STARTUP_DB_RETRY_DELAY_MS,
      label: "startup:dbReady",
    });
  } finally {
    probePool.end().catch(() => {});
  }

  if (!dbReady) {
    logger.error("[startup] DB not reachable – skipping all table init steps", {
      hint: "Check DATABASE_URL and Railway Postgres service health.",
    });
    return [{ label: "db_readiness_check", error: `DB not reachable after ${STARTUP_DB_MAX_RETRIES} retries`, critical: true }];
  }
  logger.info("[startup] DB ready – proceeding with init steps");

  // ── Helpers ───────────────────────────────────────────────────────────────
  async function safeInit(label, fn, critical = false) {
    logger.info(`[startup] ${label}: starting`);
    try {
      await fn();
      logger.info(`[startup] ${label}: ok`);
      okCount++;
    } catch (err) {
      logger.error(`[startup] ${label}: FAILED`, { message: err.message, critical });
      initErrors.push({ label, error: err.message, critical });
    }
  }

  // ── CRITICAL steps – core market tables ──────────────────────────────────
  await safeInit("ensureTablesExist",   ensureTablesExist,   true);
  await safeInit("initJobLocksTable",   initJobLocksTable,   true);
  await safeInit("initFactorTable",     initFactorTable,     true);
  await safeInit("initWeightTable",     initWeightTable,     true);

  // ── NON-CRITICAL steps – auxiliary tables ─────────────────────────────────
  await safeInit("initDiscoveryTable",                    initDiscoveryTable);
  await safeInit("initAdminSnapshotsTable",               initAdminSnapshotsTable);
  await safeInit("initAutonomyAuditTable",                initAutonomyAuditTable);
  await safeInit("initNearMissTable",                     initNearMissTable);
  await safeInit("initAgentForecastTable",                initAgentForecastTable);
  await safeInit("initAgentsTable",                       initAgentsTable);
  await safeInit("initDynamicWeightsTable",               initDynamicWeightsTable);
  await safeInit("initTechRadarTable",                    initTechRadarTable);
  await safeInit("initSystemEvolutionProposalsTable",     initSystemEvolutionProposalsTable);
  await safeInit("initAutomationAuditTable",              initAutomationAuditTable);
  await safeInit("initNotificationTables",                initNotificationTables);
  await safeInit("seedDemoUserIfEmpty",                   seedDemoUserIfEmpty);
  await safeInit("initSecEdgarTables",                    initSecEdgarTables);
  await safeInit("ensureVirtualPositionsTable",           ensureVirtualPositionsTable);
  await safeInit("ensureSisHistoryTable",                 ensureSisHistoryTable);
  await safeInit("ensurePipelineStatusTable",             ensurePipelineStatusTable);
  await safeInit("hydrateMarketRuntimeState",             hydrateMarketRuntimeState);
  await safeInit("hydrateOpportunityRuntimeState",        hydrateOpportunityRuntimeState);

  // ── Startup init report (Task 2) ─────────────────────────────────────────
  const criticalFailed = initErrors.filter((e) => e.critical);
  const nonCriticalFailed = initErrors.filter((e) => !e.critical);
  const finalStatus = criticalFailed.length > 0 ? "DEGRADED" : "OK";

  logger.info("[startup] init report", {
    totalSteps: okCount + initErrors.length,
    ok: okCount,
    failed: initErrors.length,
    criticalFailed: criticalFailed.length,
    nonCriticalFailed: nonCriticalFailed.length,
    failedLabels: initErrors.map((e) => e.label),
    finalStatus,
  });

  return initErrors;
}

// ── Graceful shutdown ─────────────────────────────────────────────────────
// Drain the module-level warmup probe pool on process termination so that
// Railway / Docker do not see orphaned connections.
// Note: the startup probePool (created inside runStartupInit) is already
// drained via its own finally block before this handler is ever invoked.
// Other module-level pools (pg) drain automatically on process exit.
function gracefulShutdown(signal) {
  logger.info(`[shutdown] ${signal} received – draining pools`);
  _warmupProbePool.end().catch((err) => {
    logger.warn("[shutdown] _warmupProbePool.end failed", { message: err.message });
  }).finally(() => {
    process.exit(0);
  });
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));

app.listen(PORT, async () => {
  logger.info(`HQS Backend aktiv auf Port ${PORT}`);

  const initErrors = await runStartupInit();

  // Build the initial world_state snapshot (regime + cross-asset + sector + agents)
  // Non-blocking: errors are logged but do not abort startup.
  buildWorldState().catch((wsErr) => {
    logger.warn("worldState: initial build failed on startup", {
      message: wsErr.message,
    });
  });

  if (RUN_JOBS) {
    logger.info("RUN_JOBS=true -> starting background jobs inside API server");

    try {
      if (process.env.FMP_API_KEY) {
        await runUniverseRefreshLocked();
      } else {
        logger.warn("FMP_API_KEY missing -> Universe refresh skipped on startup");
      }
    } catch (uErr) {
      logger.warn("Universe refresh failed on startup", {
        message: uErr.message,
      });
    }

    try {
      await runIntegratedWarmupCycle();
    } catch (err) {
      logger.warn("runIntegratedWarmupCycle failed on startup", {
        message: err.message,
      });
    }

    setInterval(async () => {
      try {
        await runIntegratedWarmupCycle();
        logger.info("Warmup executed");
      } catch (err) {
        logger.error("Warmup Fehler", { message: err.message });
      }
    }, 15 * 60 * 1000);

    scheduleDailyUniverseRefresh();
    scheduleDailyForecastVerification();
    scheduleCausalMemoryRecalibration();
    scheduleTechRadarScan();
  }

  const failedLabels = initErrors.map((e) => e.label);
  startupState.ready = true;
  startupState.completedAt = new Date().toISOString();
  startupState.initErrors = initErrors.length > 0 ? initErrors : null;
  startupState.error = initErrors.length > 0
    ? `${initErrors.length} init step(s) failed: ${failedLabels.join(", ")}`
    : null;
  logger.info("Startup completed", { initFailures: initErrors.length });

  // Run a table health check after startup so the first log entry is immediately visible
  // in Railway without needing to call the endpoint manually (Task 5).
  runTableHealthCheck().catch((thErr) => {
    logger.warn("[startup] tableHealth check failed", { message: thErr.message });
  });
});

/* =========================================================
DAILY UNIVERSE REFRESH
========================================================= */

function msUntilNextLocalTime(targetHour, targetMinute) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(targetHour, targetMinute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

async function scheduleDailyUniverseRefresh() {
  const hour = Number(process.env.UNIVERSE_REFRESH_HOUR || 2);
  const minute = Number(process.env.UNIVERSE_REFRESH_MINUTE || 10);

  const delay = msUntilNextLocalTime(hour, minute);

  setTimeout(async () => {
    try {
      if (process.env.FMP_API_KEY) {
        await runUniverseRefreshLocked();
      } else {
        logger.warn("FMP_API_KEY missing -> Universe refresh skipped");
      }
    } catch (err) {
      logger.error("Daily universe refresh failed", { message: err.message });
    } finally {
      scheduleDailyUniverseRefresh();
    }
  }, delay);
}

/* =========================================================
DAILY FORECAST VERIFICATION  (Prediction-Self-Audit)
========================================================= */

async function scheduleDailyForecastVerification() {
  // Default: run at 03:00 (after markets close and 24h has passed for overnight forecasts)
  const hour = Number(process.env.FORECAST_VERIFY_HOUR || 3);
  const minute = Number(process.env.FORECAST_VERIFY_MINUTE || 0);

  const delay = msUntilNextLocalTime(hour, minute);

  setTimeout(async () => {
    try {
      await runForecastVerificationJob();
    } catch (err) {
      logger.error("Daily forecast verification failed", { message: err.message });
    } finally {
      scheduleDailyForecastVerification();
    }
  }, delay);
}

/* =========================================================
   CAUSAL MEMORY RECALIBRATION  (Recursive Meta-Learning)
========================================================= */

async function scheduleCausalMemoryRecalibration() {
  // Default: run at 04:00 (after forecast verification at 03:00)
  const hour   = Number(process.env.CAUSAL_MEMORY_HOUR   || 4);
  const minute = Number(process.env.CAUSAL_MEMORY_MINUTE || 0);

  const delay = msUntilNextLocalTime(hour, minute);

  setTimeout(async () => {
    try {
      await runCausalMemoryJob();
    } catch (err) {
      logger.error("Causal memory recalibration failed", { message: err.message });
    } finally {
      scheduleCausalMemoryRecalibration();
    }
  }, delay);
}

/* =========================================================
   TECH-RADAR SCAN  (Innovation Scanner)
========================================================= */

async function scheduleTechRadarScan() {
  // Default: run at 06:00 daily (after causal memory at 04:00)
  const hour   = Number(process.env.TECH_RADAR_HOUR   || 6);
  const minute = Number(process.env.TECH_RADAR_MINUTE || 0);

  const delay = msUntilNextLocalTime(hour, minute);

  setTimeout(async () => {
    try {
      await runTechRadarJob();
    } catch (err) {
      logger.error("Tech-Radar scan failed", { message: err.message });
    } finally {
      scheduleTechRadarScan();
    }
  }, delay);
}
