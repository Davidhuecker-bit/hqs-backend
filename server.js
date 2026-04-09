"use strict";

const path = require("path");
const express = require("express");
const cors = require("cors");
const { createPool, closeAllPools } = require("./config/database");
require("dotenv").config();

/* =========================================================
LOGGER
========================================================= */

const logger = require("./utils/logger");
const {
  badRequest,
  parseInteger,
  parseSymbol,
} = require("./utils/requestValidation");

/* =========================================================
CORE SERVICES
========================================================= */

const {
  getMarketData,
  hydrateMarketRuntimeState,
  ensureTablesExist,
  pingDb,
  getPipelineStatus,
} = require("./services/marketService");

const { analyzeStockWithGuardian } = require("./services/guardianService");

const { buildGuardianPayload } = require("./services/frontendAdapter.service");

const { initFactorTable } = require("./services/factorHistory.repository");

const { initJobLocksTable } = require("./services/jobLock.repository");
const {
  hydrateOpportunityRuntimeState,
} = require("./services/opportunityScanner.service");
const { buildWorldState } = require("./services/worldState.service");

/* =========================================================
STEP 4 – SUMMARY REFRESH ORCHESTRATION LAYER
(replaces Step 3 individual builder imports)
========================================================= */

const { ensureUiSummariesTable } = require("./services/uiSummary.repository");
const {
  readSummary,
  SUPPORTED_TYPES: _summarySupportedTypes,
} = require("./services/uiSummaryRefresh.service");
const { getOrBuildSymbolSummary } = require("./services/symbolSummary.builder");

/* =========================================================
ROUTES
========================================================= */

const opportunitiesRoutes = require("./routes/opportunities.routes");
const discoveryRoutes = require("./routes/discovery.routes");
const notificationsRoutes = require("./routes/notifications.routes");
const adminRoutes = require("./routes/admin.routes");
const marketNewsRoutes = require("./routes/marketNews.routes");
const secEdgarRoutes = require("./routes/secEdgar.routes");
const portfolioRoutes = require("./routes/portfolio.routes");

const { apiLimiter, adminLimiter } = require("./middleware/rateLimiter");

/* =========================================================
DISCOVERY
========================================================= */

const { initDiscoveryTable } = require("./services/discoveryLearning.repository");
const { initSecEdgarTables } = require("./services/secEdgar.repository");
const { initAdminSnapshotsTable } = require("./services/adminSnapshots.repository");
const { initAutonomyAuditTable, initNearMissTable, initAutomationAuditTable, initFeatureHistoryTable, initDiscoveryLabelsTable, initMlModelsTable } = require("./services/autonomyAudit.repository");
const { initAgentForecastTable, initAgentsTable } = require("./services/agentForecast.repository");
const { initDynamicWeightsTable } = require("./services/causalMemory.repository");
const { initTechRadarTable } = require("./services/techRadar.service");
const { ensureVirtualPositionsTable } = require("./services/portfolioTwin.service");
const { ensureSisHistoryTable } = require("./services/sisHistory.service");
const { ensurePipelineStatusTable } = require("./services/pipelineStatus.repository");
const { initEntityMapTable } = require("./services/entityMap.repository");
const { initAdminReferencePortfolioTable } = require("./services/adminReferencePortfolio.repository");
const { initChangeMemoryTable } = require("./services/changeMemory.repository");
/* =========================================================
DB HEALTH  (Task 1 – centralised DB error classification)
========================================================= */

const { waitForDb } = require("./utils/dbHealth");

/* =========================================================
TABLE HEALTH  (Task 5 – admin table diagnostics)
========================================================= */

const { runTableHealthCheck } = require("./services/tableHealth.service");

/* =========================================================
NOTIFICATIONS
========================================================= */

const {
  initNotificationTables,
} = require("./services/notifications.repository");

/* =========================================================
APP INIT
========================================================= */

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 8080;
const DEFAULT_CORS_ORIGINS = [
  "https://dhsystemhqs.de",
  "https://www.dhsystemhqs.de",
  "https://hqs-private-quant.vercel.app",
  /^https:\/\/hqs-private-quant-[a-z0-9-]+(-david-huecker-s-projects)?\.vercel\.app$/,
  "http://localhost:3000",
  "http://localhost:5173",
];

const STARTUP_DB_MAX_RETRIES    = Number(process.env.STARTUP_DB_MAX_RETRIES    || 10);
const STARTUP_DB_RETRY_DELAY_MS = Number(process.env.STARTUP_DB_RETRY_DELAY_MS || 3000);

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

app.use("/api/notifications", apiLimiter, notificationsRoutes);
app.use("/api/opportunities", apiLimiter, opportunitiesRoutes);
app.use("/api/discovery", apiLimiter, discoveryRoutes);
app.use("/api/portfolio", apiLimiter, portfolioRoutes);
app.use("/api/admin", adminLimiter, adminRoutes);
app.use("/api/market-news", apiLimiter, marketNewsRoutes);
app.use("/api/sec-edgar", apiLimiter, secEdgarRoutes);
app.use("/api/portfolio", apiLimiter, portfolioRoutes);

/* Alias: flat path used by some clients – read-only from DB (DB-first architecture) */
app.get("/api/admin-demo-portfolio", async (_req, res) => {
  try {
    const result = await readSummary("demo_portfolio");
    if (!result.payload) {
      throw new Error("Demo portfolio not yet written by job – no data available");
    }
    return res.json(result.payload);
  } catch (error) {
    logger.error("admin-demo-portfolio alias route error", { message: error.message });
    return res.json({
      success: false,
      portfolioId: "DEMO_ADMIN_20",
      portfolioName: "Internes Admin-Prüfportfolio",
      symbolCount: 0,
      dataStatus: "error",
      holdings: [],
      partialErrors: [{ symbol: "*", error: error.message }],
      generatedAt: new Date().toISOString(),
      summary: { total: 0, green: 0, yellow: 0, red: 0 },
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

    // Canonical integrationEngine output fields – present when outcome_tracking data exists.
    finalConviction: item.finalConviction ?? null,
    finalConfidence: item.finalConfidence ?? null,
    finalRating: item.finalRating ?? null,
    finalDecision: item.finalDecision ?? null,
    whyInteresting: Array.isArray(item.whyInteresting) ? item.whyInteresting : [],
    components: item.components ?? null,

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
    service: "hqs-backend",
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

async function handleMarketRoute(req, res) {
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

    let stocks;
    let summaryMeta = null;

    if (!symbol) {
      // List path: read-only from prepared DB summary (DB-first architecture).
      // Summary is written by job:ui-market-list – API never rebuilds.
      const result = await readSummary("market_list");
      const rawStocks = Array.isArray(result.payload?.stocks) ? result.payload.stocks : [];
      stocks = rawStocks.map(formatMarketItem).filter(Boolean).slice(0, limit);
      summaryMeta = {
        source:          "ui_summary",
        builtAt:         result.builtAt,
        freshness:       result.freshnessLabel,
        dataAge:         result.ageMs != null ? Math.round(result.ageMs / 1000) : null,
        lastSnapshotAt:  result.builtAt ?? null,
        isPartial:       result.isPartial,
        rebuilding:      false,
        writer:          result.writer,
      };
    } else {
      // Single-symbol path: bypass summary (symbol-level data is always live)
      const raw = await getMarketData(symbol, { limit });
      stocks = Array.isArray(raw) ? raw.map(formatMarketItem).filter(Boolean) : [];
    }

    return res.json({
      success: true,
      count: stocks.length,
      stocks,
      ...(summaryMeta ? { summaryMeta } : {}),
    });
  } catch (error) {
    logger.error("Market route error", { message: error.message });

    return res.status(500).json({
      success: false,
      message: "Fehler beim Abrufen der Marktdaten",
      error: error.message,
    });
  }
}

/* Legacy / BFF compatibility alias – frontend BFF calls /market directly */
app.get("/market", handleMarketRoute);
app.get("/api/market", handleMarketRoute);

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

    // ── Primary path: symbol_summary layer ──────────────────────────────────
    // getOrBuildSymbolSummary uses SWR: fresh→serve, stale→serve+async, missing→build.
    // It always returns a valid object (never throws). Status may be
    // "ready", "partial", or "building" (when no snapshot exists yet).
    const summary = await getOrBuildSymbolSummary(ticker);

    // ── Guardian AI analysis (natural-language) ──────────────────────────────
    // Only attempt when we have at minimum an HQS score or price so the
    // guardian prompt is not completely empty.  Failures are soft-caught so
    // they never block the structured response.
    let guardianAnalysis = null;
    if (summary.status !== "building" && (summary.hqsScore != null || summary.price != null)) {
      try {
        guardianAnalysis = await analyzeStockWithGuardian({
          symbol: ticker,
          segment: null,
          provider: null,
          fallbackUsed: false,
          marketData: {
            hqsScore:        summary.hqsScore,
            regime:          summary.regime,
            finalConfidence: summary.finalConfidence,
            finalRating:     summary.rating,
            finalDecision:   summary.decision,
            whyInteresting:  summary.whyInteresting,
            // finalConviction / components are not in the summary layer;
            // guardianService degrades gracefully when they are absent.
            source: "symbol_summary",
          },
        });
      } catch (guardianErr) {
        logger.warn("[guardian/analyze] Guardian AI failed, continuing without", {
          symbol: ticker,
          message: guardianErr.message,
        });
      }
    }

    // ── Assemble response ────────────────────────────────────────────────────
    // Structured fields from symbol_summary (primary output layer).
    // `analysis` is kept for backward-compat clients that read the GPT string.
    return res.json({
      success: true,

      // Structured summary fields
      symbol:            summary.symbol,
      name:              summary.name,
      price:             summary.price,
      change:            summary.change,
      changesPercentage: summary.changesPercentage,
      currency:          summary.currency,
      hqsScore:          summary.hqsScore,
      rating:            summary.rating,
      decision:          summary.decision,
      finalConfidence:   summary.finalConfidence,
      whyInteresting:    summary.whyInteresting,
      regime:            summary.regime,
      trend:             summary.trend,
      volatility:        summary.volatility,
      maturityProfile:   summary.maturityProfile,
      maturityLevel:     summary.maturityLevel,
      maturityScore:     summary.maturityScore,
      newsSummary:       summary.newsSummary,
      status:            summary.status,
      missingComponents: summary.missingComponents,
      updatedAt:         summary.updatedAt,

      // Natural-language Guardian analysis (backward-compat; null when building)
      analysis: guardianAnalysis,

      // Summary layer meta
      summaryMeta: {
        source:    "symbol_summary",
        builtAt:   summary.builtAt ?? null,
        freshness: summary.freshness ?? null,
        dataAge:   summary.ageMs != null ? Math.round(summary.ageMs / 1000) : null,
        isPartial: summary.isPartial ?? null,
      },
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
SERVER START
========================================================= */

async function runStartupInit() {
  const initErrors = [];
  let okCount = 0;

  // ── DB readiness guard (Task 1 + Task 2) ─────────────────────────────────
  // Before touching any table, verify the DB is actually reachable.
  // Use a dedicated pool probe so we get typed error categories.
  const probePool = createPool({ max: 1 });

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

  // ── NON-CRITICAL steps – auxiliary tables ─────────────────────────────────
  await safeInit("initDiscoveryTable",                    initDiscoveryTable);
  await safeInit("initAdminSnapshotsTable",               initAdminSnapshotsTable);
  await safeInit("initAutonomyAuditTable",                initAutonomyAuditTable);
  await safeInit("initNearMissTable",                     initNearMissTable);
  await safeInit("initAgentForecastTable",                initAgentForecastTable);
  await safeInit("initAgentsTable",                       initAgentsTable);
  await safeInit("initDynamicWeightsTable",               initDynamicWeightsTable);
  await safeInit("initTechRadarTable",                    initTechRadarTable);
  await safeInit("initAutomationAuditTable",              initAutomationAuditTable);
  await safeInit("initFeatureHistoryTable",               initFeatureHistoryTable);
  await safeInit("initDiscoveryLabelsTable",              initDiscoveryLabelsTable);
  await safeInit("initMlModelsTable",                     initMlModelsTable);
  await safeInit("initNotificationTables",                initNotificationTables);
  await safeInit("initSecEdgarTables",                    initSecEdgarTables);
  await safeInit("initEntityMapTable",                    initEntityMapTable);
  await safeInit("initAdminReferencePortfolioTable",      initAdminReferencePortfolioTable);
  await safeInit("ensureVirtualPositionsTable",           ensureVirtualPositionsTable);
  await safeInit("ensureSisHistoryTable",                 ensureSisHistoryTable);
  await safeInit("ensurePipelineStatusTable",             ensurePipelineStatusTable);
  await safeInit("ensureUiSummariesTable",                ensureUiSummariesTable);
  await safeInit("initChangeMemoryTable",                 initChangeMemoryTable);
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
// Module-level pg pools drain automatically on process exit.
// The startup probePool (created inside runStartupInit) is already drained
// via its own finally block before this handler is ever invoked.
function gracefulShutdown(signal) {
  logger.info(`[shutdown] ${signal} received – closing shared DB pool`);
  closeAllPools()
    .catch((err) => logger.warn("[shutdown] pool close error", { message: err.message }))
    .finally(() => process.exit(0));
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

  // ── UI summary warmup REMOVED (DB-first architecture) ───────────────────
  // ui_summaries are now written exclusively by dedicated cron jobs:
  //   job:ui-market-list, job:ui-demo-portfolio, job:ui-guardian-status
  // The API server only reads from ui_summaries – it never triggers rebuilds.
  // If summaries are stale/empty on cold start, the API returns degraded
  // responses until the next job run populates the data.
  logger.info("[startup] ui_summaries: DB-first mode – API reads only, jobs write", {
    supportedTypes: _summarySupportedTypes,
  });

  // ── Background job schedulers REMOVED ─────────────────────────────────────
  // Forecast verification, causal memory, tech-radar, and data-cleanup are
  // now standalone job scripts in jobs/ and must be triggered via Railway
  // cron services (e.g. npm run job:forecast-verification).
  // The API server no longer schedules or runs any background jobs.

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
