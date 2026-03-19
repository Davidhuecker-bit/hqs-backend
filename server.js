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

const { analyzeStockWithGuardian } = require("./services/guardianService");

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
const { discoverStocks } = require("./services/discoveryEngine.service");
const { evaluateDiscoveries } = require("./services/discoveryLearning.service");
const { initSecEdgarTables } = require("./services/secEdgar.repository");
const { initAdminSnapshotsTable } = require("./services/adminSnapshots.repository");
const { initAutonomyAuditTable, initNearMissTable, initAutomationAuditTable } = require("./services/autonomyAudit.repository");
const { initAgentForecastTable, initAgentsTable } = require("./services/agentForecast.repository");
const { initDynamicWeightsTable } = require("./services/causalMemory.repository");
const { runForecastVerificationJob } = require("./jobs/forecastVerification.job");
const { runCausalMemoryJob } = require("./jobs/causalMemory.job");
const { initTechRadarTable, initSystemEvolutionProposalsTable } = require("./services/techRadar.service");
const { runTechRadarJob } = require("./jobs/techRadar.job");
const { ensureVirtualPositionsTable, syncVirtualPositions } = require("./services/portfolioTwin.service");
const { ensureSisHistoryTable, saveSisSnapshot } = require("./services/sisHistory.service");
const { ensurePipelineStatusTable } = require("./services/pipelineStatus.repository");
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

/* =========================================================
STARTUP / HEALTH ROUTES
========================================================= */

app.get("/health", (_req, res) => {
  return res.json({
    success: true,
    alive: true,
    ready: startupState.ready,
    startedAt: startupState.startedAt,
    completedAt: startupState.completedAt,
    initErrors: startupState.initErrors,
    now: new Date().toISOString(),
  });
});

app.get("/api/health", async (_req, res) => {
  try {
    const db = await pingDb();
    const pipeline = await getPipelineStatus().catch(() => null);

    return res.json({
      success: true,
      ready: startupState.ready,
      startedAt: startupState.startedAt,
      completedAt: startupState.completedAt,
      initErrors: startupState.initErrors,
      db,
      pipeline,
      now: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      ready: startupState.ready,
      error: error.message,
      initErrors: startupState.initErrors,
      now: new Date().toISOString(),
    });
  }
});

/* =========================================================
MARKET ROUTE
========================================================= */

app.get("/api/market", async (req, res) => {
  try {
    const symbolResult = parseSymbol(req.query.symbol, {
      label: "symbol",
    });
    if (symbolResult.error) {
      return badRequest(res, symbolResult.error);
    }

    const limitResult = parseInteger(req.query.limit, {
      defaultValue: 25,
      min: 1,
      max: 100,
      label: "limit",
    });
    if (limitResult.error) {
      return badRequest(res, limitResult.error);
    }

    const symbol = symbolResult.value || null;
    const limit = limitResult.value;

    const raw = await getMarketData(symbol || undefined, { limit });
    let stocks = Array.isArray(raw)
      ? raw.map(formatMarketItem).filter(Boolean)
      : [];

    if (!symbol) {
      stocks = stocks.slice(0, limit);
    }

    return res.json({
      success: true,
      count: stocks.length,
      stocks,
    });
  } catch (error) {
    logger.error("Market route error", { message: error.message });

    return res.status(500).json({
      success: false,
      message: "Fehler beim Abrufen der Marktdaten",
      error: error.message,
    });
  }
});

/* =========================================================
SNAPSHOT ROUTE
========================================================= */

app.post("/api/admin/snapshot", async (_req, res) => {
  try {
    const result = await buildMarketSnapshot();

    return res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    logger.error("Snapshot route error", { message: error.message });

    return res.status(500).json({
      success: false,
      message: "Snapshot-Erstellung fehlgeschlagen",
      error: error.message,
    });
  }
});

/* =========================================================
MARKET-NEWS ROUTES
========================================================= */

app.post("/api/admin/market-news/collect", async (req, res) => {
  try {
    const limitResult = parseInteger(req.body?.limit, {
      defaultValue: 10,
      min: 1,
      max: 200,
      label: "limit",
    });
    if (limitResult.error) {
      return badRequest(res, limitResult.error);
    }

    const symbolsInput = Array.isArray(req.body?.symbols)
      ? req.body.symbols
      : [];
    const symbols = normalizeSymbols(symbolsInput);

    const result = await collectAndStoreMarketNews({
      limit: limitResult.value,
      symbols,
    });

    return res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    logger.error("Market-news collect route error", { message: error.message });

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
TABLE HEALTH
========================================================= */

app.get("/api/admin/table-health", async (_req, res) => {
  try {
    const result = await runTableHealthCheck();
    return res.json(result);
  } catch (error) {
    logger.error("Table health route error", { message: error.message });
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

    return res.json({
      success: true,
      symbol,
      message: "Für dieses Symbol ist noch kein gespeicherter HQS vorhanden.",
      source: "database",
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
GUARDIAN ROUTE
========================================================= */

app.get("/api/guardian/dashboard", async (req, res) => {
  try {
    const rawSymbols = Array.isArray(req.query.symbols)
      ? req.query.symbols.join(",")
      : req.query.symbols || req.query.symbol;

    const requestedSymbols = String(rawSymbols || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    if (!requestedSymbols.length) {
      return badRequest(res, "symbols is required");
    }

    const symbols = [];

    for (const requestedSymbol of requestedSymbols) {
      const symbolResult = parseSymbol(requestedSymbol, {
        required: true,
        label: "symbols",
      });
      if (symbolResult.error) {
        return badRequest(res, symbolResult.error);
      }

      if (!symbols.includes(symbolResult.value)) {
        symbols.push(symbolResult.value);
      }

      if (symbols.length >= 8) {
        break;
      }
    }

    const marketData = await Promise.all(symbols.map((symbol) => getMarketData(symbol)));
    const stocks = marketData
      .map((entries) => {
        if (!Array.isArray(entries) || !entries.length) {
          return null;
        }

        return formatMarketItem(entries[0]);
      })
      .filter(Boolean);

    if (!stocks.length) {
      return res.status(404).json({
        success: false,
        message: "Für dieses Dashboard sind noch keine gespeicherten Daten vorhanden.",
      });
    }

    const payload = buildGuardianPayload(stocks, {
      generatedAt: new Date().toISOString(),
    });

    return res.json({
      ...payload,
      engineStatus: {
        ...(payload.engineStatus || {}),
        source: "database",
      },
    });
  } catch (error) {
    logger.error("Guardian dashboard route error", { message: error.message });

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get("/api/guardian/analyze/:ticker", async (req, res) => {
  try {
    const tickerResult = parseSymbol(req.params.ticker, {
      required: true,
      label: "ticker",
    });
    if (tickerResult.error) {
      return badRequest(res, tickerResult.error);
    }

    const ticker = tickerResult.value;
    const marketData = await getMarketData(ticker);

    if (!marketData.length) {
      return res.status(404).json({
        success: false,
        message: "Für dieses Symbol sind noch keine gespeicherten Daten vorhanden.",
      });
    }

    const storedMarketData = formatMarketItem(marketData[0]);

    const guardianResult = await analyzeStockWithGuardian({
      symbol: ticker,
      segment: null,
      provider: null,
      fallbackUsed: false,
      marketData: {
        ...storedMarketData,
        source: "database",
      },
    });

    return res.json({ success: true, analysis: guardianResult });
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
    const portfolio = Array.isArray(req.body?.portfolio) ? req.body.portfolio : [];

    if (!portfolio.length) {
      return badRequest(res, "portfolio is required and must be a non-empty array");
    }

    const result = await calculatePortfolioHQS(portfolio);

    if (result.error) {
      return res.json({
        success: false,
        ...result,
        optimizedAllocation: [],
      });
    }

    // Use breakdown (the DB-first output field) – never the old positions field
    const breakdown = Array.isArray(result.breakdown) ? result.breakdown : [];
    const availableForOptimization = breakdown.filter((p) => p.available === true);

    const optimizedAllocation =
      availableForOptimization.length > 0
        ? optimizePortfolio(availableForOptimization)
        : [];

    return res.json({
      success: true,
      ...result,
      optimizedAllocation,
    });
  } catch (error) {
    logger.error("Portfolio route error", { message: error.message });

    return res.status(500).json({
      success: false,
      message: "Portfolio-Analyse fehlgeschlagen",
      error: error.message,
    });
  }
});

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
    scheduleDailyDiscoveryScan();
    scheduleDailyDiscoveryLearning();
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

/* =========================================================
   DAILY DISCOVERY SCAN  (populate discovery_history)
========================================================= */

async function scheduleDailyDiscoveryScan() {
  // Default: run at 09:00 daily.
  // Snapshot data refreshes every 15 min via warmup cycle, so prices are always recent.
  const hour   = Number(process.env.DISCOVERY_SCAN_HOUR   || 9);
  const minute = Number(process.env.DISCOVERY_SCAN_MINUTE || 0);

  const delay = msUntilNextLocalTime(hour, minute);

  setTimeout(async () => {
    try {
      await runDiscoveryScanLocked();
    } catch (err) {
      logger.error("[discovery] daily scan failed", { message: err.message });
    } finally {
      scheduleDailyDiscoveryScan();
    }
  }, delay);
}

/* =========================================================
   DAILY DISCOVERY LEARNING  (7d / 30d return evaluation)
========================================================= */

async function scheduleDailyDiscoveryLearning() {
  // Default: run at 11:00 daily.
  // Evaluates discoveries ≥ 7d / ≥ 30d old (independent of scan timing).
  const hour   = Number(process.env.DISCOVERY_LEARNING_HOUR   || 11);
  const minute = Number(process.env.DISCOVERY_LEARNING_MINUTE || 0);

  const delay = msUntilNextLocalTime(hour, minute);

  setTimeout(async () => {
    try {
      await runDiscoveryLearningLocked();
    } catch (err) {
      logger.error("[discovery] daily learning evaluation failed", { message: err.message });
    } finally {
      scheduleDailyDiscoveryLearning();
    }
  }, delay);
}
