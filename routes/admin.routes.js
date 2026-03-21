"use strict";

const express = require("express");
const logger = require("../utils/logger");

const { getAdminInsights } = require("../services/adminInsights.service");
const {
  getMockPortfolio,
  getSnapshotById,
  getAuditFeed,
  getPortfolioAuditHistory,
} = require("../services/mockPortfolio.service");
const { getAdminDemoPortfolio } = require("../services/adminDemoPortfolio.service");
const {
  saveAdminSnapshot,
  loadAdminSnapshotBefore,
} = require("../services/adminSnapshots.repository");
const { buildAdminDiagnostics } = require("../engines/adminDiagnostics.engine");
const { buildAdminValidation } = require("../engines/adminValidation.engine");
const { buildAdminTuning } = require("../engines/adminTuning.engine");
const { buildAdminRecommendations } = require("../engines/adminRecommendations.engine");
const { buildAdminTrends } = require("../engines/adminTrends.engine");
const { buildAdminAlerts } = require("../engines/adminAlerts.engine");
const { buildAdminPriorities } = require("../engines/adminPriorities.engine");
const { buildAdminTargets } = require("../engines/adminTargets.engine");
const { buildAdminCausality } = require("../engines/adminCausality.engine");
const { buildAdminRelease } = require("../engines/adminRelease.engine");
const { buildAdminBriefing } = require("../engines/adminBriefing.engine");
const { buildAdminActionPlan } = require("../engines/adminActionPlan.engine");
const { getNearMisses, evaluateSavedCapital } = require("../services/autonomyAudit.repository");
const { getInterMarketCorrelation } = require("../services/interMarketCorrelation.service");
const { getAgentWisdomScores } = require("../services/agentForecast.repository");
const { getAgentWeights, adjustAgentWeights, getAllDynamicWeights } = require("../services/causalMemory.repository");
const {
  getSharpenedSectorSnapshot,
  getSectorDefinitions,
  notifySectorLeaderQuote,
} = require("../services/sectorCoherence.service");
const {
  runBlackSwanTest,
  rankPortfolioAntifragility,
  BLACK_SWAN_SCENARIOS,
} = require("../services/syntheticStressTest.service");
const {
  getTechRadarEntries,
  getEvolutionBoard,
  markEntriesSeen,
} = require("../services/techRadar.service");
const { getWorldState, buildWorldState } = require("../services/worldState.service");
const {
  calculatePositionSize,
  applyCapitalAllocation,
  REGIME_MULTIPLIERS,
  DEFAULT_MAX_SECTOR_PCT,
  SECTOR_ALERT_MAX_PCT,
  DEFAULT_MAX_POSITIONS,
} = require("../services/capitalAllocation.service");
const {
  openVirtualPositionFromAllocation,
  refreshOpenVirtualPositions,
  closeVirtualPosition,
  getPortfolioTwinSnapshot,
  getStage4Analysis,
  listVirtualPositions,
  syncVirtualPositions,
} = require("../services/portfolioTwin.service");
const { getSystemIntelligenceReport } = require("../services/systemIntelligence.service");
const { getOperationalReleaseStatus } = require("../services/sisReleaseControl.service");
const { getInterfaceState } = require("../services/interfaceState.service");
const {
  saveSisSnapshot,
  getSisHistory,
  getSisTrendSummary,
  detectSisRegression,
  detectSisImprovement,
} = require("../services/sisHistory.service");
const { buildMarketSnapshot, getPipelineStatusWithPersistence } = require("../services/marketService");
const { runTableHealthCheck } = require("../services/tableHealth.service");
const {
  collectAndStoreMarketNews,
  normalizeSymbols,
} = require("../services/marketNews.service");
const { badRequest, parseInteger } = require("../utils/requestValidation");
const {
  getSignalHistoryAll,
  getSignalHistoryBySymbol,
  getOutcomeAnalysis,
  getTimingQuality,
  getForecastVsOutcome,
  getSignalKPIs,
} = require("../services/signalHistory.repository");
const { getTopOpportunities } = require("../services/opportunityScanner.service");
// Step 8 Block 1: Governance context for admin-level role/scope classification
// Step 8 Block 2: Operating Console / Exception Hub aggregate view
// Step 8 Block 3: Policy Plane – policy version/status/mode, shadow, four-eyes basis
// Step 8 Block 4: Evidence Packages & Policy Versioning – policyFingerprint, evidencePackage, operatorActionTrace
// Step 8 Block 5: Tenant/resource governance – tenant policy, load band, quota, guardrail summary
// Step 8 Block 6: Operational resilience – degradation mode, fallback tier, recovery/pressure summary
// Step 9 Block 1: Autonomy levels + drift detection basis
// Step 9 Block 2: Action chains – state-machine basis
// Step 9 Block 3: Controlled auto-preparation layer
// Step 9 Block 4: Partial auto-execution under policy
const { computeGovernanceContext, computeOperatingConsoleContext, computePolicyPlaneContext, computeEvidencePackage, computeTenantResourceGovernanceSummary, computeOperationalResilienceContextSummary, computeAutonomyDriftSummary, computeActionChainSummary, computeControlledAutoPreparationSummary, computePartialAutoExecutionSummary } = require("../services/governance.context");

const router = express.Router();

// Step 8 Block 2: exception priority ordering for exception-hub sort (lower = higher priority)
const EXCEPTION_PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

function createAdminState({ insights, diagnostics, validation, tuning }) {
  return {
    insights: insights || {},
    diagnostics: diagnostics || {},
    validation: validation || {},
    tuning: tuning || {},
  };
}

async function buildAdminStack(options = {}) {
  const { persistSnapshot = false } = options;

  let insights;
  try {
    insights = await getAdminInsights();
  } catch (err) {
    logger.warn("buildAdminStack: getAdminInsights failed", { message: err.message });
    insights = {
      generatedAt: new Date().toISOString(),
      system: {},
      universe: {},
      activity: {},
      coverage: {},
      quickFacts: {},
      _meta: {
        dataStatus: "error",
        partialErrors: [{ field: "getAdminInsights", error: err.message }],
        emptyFields: [],
      },
    };
  }

  function safeEngine(name, fn, fallback = {}) {
    try {
      return fn();
    } catch (err) {
      logger.warn(`buildAdminStack: ${name} failed`, { message: err.message });
      return fallback;
    }
  }

  const diagnostics = safeEngine("buildAdminDiagnostics", () => buildAdminDiagnostics(insights));
  const validation = safeEngine("buildAdminValidation", () => buildAdminValidation(insights, diagnostics));
  const tuning = safeEngine("buildAdminTuning", () => buildAdminTuning(insights, diagnostics, validation));

  const currentState = createAdminState({
    insights,
    diagnostics,
    validation,
    tuning,
  });

  async function safeLoadSnapshot(interval) {
    try {
      return await loadAdminSnapshotBefore(interval);
    } catch (err) {
      logger.warn(`loadAdminSnapshotBefore ${interval} failed`, { message: err.message });
      return null;
    }
  }

  const [previous24h, previous7d, previous30d] = await Promise.all([
    safeLoadSnapshot("24 hours"),
    safeLoadSnapshot("7 days"),
    safeLoadSnapshot("30 days"),
  ]);

  const trends = safeEngine("buildAdminTrends", () => buildAdminTrends({
    current: currentState,
    previous24h: previous24h || currentState,
    previous7d: previous7d || currentState,
    previous30d: previous30d || currentState,
  }));

  const alerts = safeEngine("buildAdminAlerts", () => buildAdminAlerts({
    insights,
    diagnostics,
    validation,
    tuning,
    trends,
  }));

  const priorities = safeEngine("buildAdminPriorities", () => buildAdminPriorities({
    insights,
    diagnostics,
    validation,
    tuning,
    alerts,
  }));

  const targets = safeEngine("buildAdminTargets", () => buildAdminTargets({
    insights,
    diagnostics,
    validation,
  }));

  const causality = safeEngine("buildAdminCausality", () => buildAdminCausality({
    insights,
    diagnostics,
    validation,
    targets,
  }));

  const release = safeEngine("buildAdminRelease", () => buildAdminRelease({
    diagnostics,
    validation,
    priorities,
    targets,
    causality,
  }));

  const recommendations = safeEngine("buildAdminRecommendations", () => buildAdminRecommendations({
    insights,
    diagnostics,
    validation,
    tuning,
  }));

  const briefing = safeEngine("buildAdminBriefing", () => buildAdminBriefing({
    insights,
    diagnostics,
    validation,
    tuning,
    trends,
    alerts,
    priorities,
    targets,
    causality,
    release,
  }));

  if (persistSnapshot) {
    try {
      await saveAdminSnapshot(currentState);
    } catch (error) {
      logger.warn("Admin snapshot persistence failed", {
        message: error.message,
      });
    }
  }

  return {
    insights,
    diagnostics,
    validation,
    tuning,
    trends,
    alerts,
    priorities,
    targets,
    causality,
    release,
    recommendations,
    briefing,
  };
}

router.get("/overview", async (req, res) => {
  try {
    const data = await buildAdminStack({ persistSnapshot: false });
    const dataStatus = data.insights?._meta?.dataStatus || "full";

    return res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      dataStatus,
      partialErrors: data.insights?._meta?.partialErrors || [],
      emptyFields: data.insights?._meta?.emptyFields || [],
      ...data,
    });
  } catch (error) {
    logger.error("Admin overview route error", { message: error.message });
    return res.status(500).json({
      success: false,
      generatedAt: new Date().toISOString(),
      dataStatus: "error",
      error: error.message,
    });
  }
});

router.get("/diagnostics", async (req, res) => {
  try {
    const { diagnostics } = await buildAdminStack();

    return res.json({
      success: true,
      diagnostics,
    });
  } catch (error) {
    logger.error("Admin diagnostics route error", { message: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

router.get("/validation", async (req, res) => {
  try {
    const { validation } = await buildAdminStack();

    return res.json({
      success: true,
      validation,
    });
  } catch (error) {
    logger.error("Admin validation route error", { message: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

router.get("/tuning", async (req, res) => {
  try {
    const { tuning } = await buildAdminStack();

    return res.json({
      success: true,
      tuning,
    });
  } catch (error) {
    logger.error("Admin tuning route error", { message: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

router.get("/trends", async (req, res) => {
  try {
    const { trends } = await buildAdminStack();

    return res.json({
      success: true,
      trends,
    });
  } catch (error) {
    logger.error("Admin trends route error", { message: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

router.get("/alerts", async (req, res) => {
  try {
    const { alerts } = await buildAdminStack();

    return res.json({
      success: true,
      alerts,
    });
  } catch (error) {
    logger.error("Admin alerts route error", { message: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

router.get("/priorities", async (req, res) => {
  try {
    const { priorities } = await buildAdminStack();

    return res.json({
      success: true,
      priorities,
    });
  } catch (error) {
    logger.error("Admin priorities route error", { message: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

router.get("/targets", async (req, res) => {
  try {
    const { targets } = await buildAdminStack();

    return res.json({
      success: true,
      targets,
    });
  } catch (error) {
    logger.error("Admin targets route error", { message: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

router.get("/causality", async (req, res) => {
  try {
    const { causality } = await buildAdminStack();

    return res.json({
      success: true,
      causality,
    });
  } catch (error) {
    logger.error("Admin causality route error", { message: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

router.get("/release", async (req, res) => {
  try {
    const { release } = await buildAdminStack();

    return res.json({
      success: true,
      release,
    });
  } catch (error) {
    logger.error("Admin release route error", { message: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

router.get("/recommendations", async (req, res) => {
  try {
    const { recommendations } = await buildAdminStack();

    return res.json({
      success: true,
      recommendations,
    });
  } catch (error) {
    logger.error("Admin recommendations route error", { message: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

router.get("/briefing", async (req, res) => {
  try {
    const { briefing } = await buildAdminStack();

    return res.json({
      success: true,
      briefing,
    });
  } catch (error) {
    logger.error("Admin briefing route error", { message: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

router.get("/action-plan", async (req, res) => {
  try {
    const { briefing, priorities, recommendations, release } =
      await buildAdminStack();

    const actionPlan = buildAdminActionPlan({
      briefing,
      priorities,
      recommendations,
      release,
    });

    return res.json({
      success: true,
      actionPlan,
    });
  } catch (error) {
    logger.error("Admin action plan route error", { message: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
   PORTFOLIO ROUTES (MockPortfolioEngine)
========================================================= */

router.get("/portfolio", async (req, res) => {
  try {
    const portfolio = await getMockPortfolio();
    return res.json({ success: true, portfolio });
  } catch (error) {
    logger.error("Admin portfolio route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/audit-feed", async (req, res) => {
  try {
    const limitRaw = req.query.limit;
    const limit = limitRaw ? Math.min(100, Math.max(1, parseInt(limitRaw, 10) || 25)) : 25;
    const feed = await getAuditFeed({ limit });
    return res.json({ success: true, feed });
  } catch (error) {
    logger.error("Admin audit-feed route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/snapshot/:source/:id", async (req, res) => {
  try {
    const { source, id } = req.params;
    const allowedSources = ["outcome_tracking", "autonomy_audit", "static_seed"];
    if (!allowedSources.includes(source)) {
      return res.status(400).json({ success: false, error: "Invalid source" });
    }
    if (source === "static_seed") {
      return res.json({ success: true, snapshot: null, note: "Kein Snapshot für Seed-Daten verfügbar." });
    }
    const idNum = parseInt(id, 10);
    if (!Number.isFinite(idNum) || idNum <= 0) {
      return res.status(400).json({ success: false, error: "Invalid id" });
    }
    const snapshot = await getSnapshotById({ id: idNum, source });
    if (!snapshot) {
      return res.status(404).json({ success: false, error: "Snapshot not found" });
    }
    return res.json({ success: true, snapshot });
  } catch (error) {
    logger.error("Admin snapshot route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/portfolio/:symbol/audit-history", async (req, res) => {
  try {
    const { symbol } = req.params;
    const limitRaw = req.query.limit;
    const limit = limitRaw ? Math.min(10, Math.max(1, parseInt(limitRaw, 10) || 3)) : 3;
    const history = await getPortfolioAuditHistory(symbol, limit);
    return res.json({ success: true, history });
  } catch (error) {
    logger.error("Admin portfolio audit-history route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   VIRTUAL CAPITAL PROTECTOR  –  near-miss feed
========================================================= */

/**
 * GET /api/admin/near-misses
 * Returns Guardian / Debate blocked signals with saved_capital estimates.
 * Query params:
 *   limit         (number, 1-100, default 25)
 *   evaluatedOnly (boolean, default false) – only return evaluated records
 */
router.get("/near-misses", async (req, res) => {
  try {
    // Trigger evaluation of pending near-misses (fire-and-forget)
    evaluateSavedCapital().catch((err) => {
      logger.warn("near-misses: background evaluation failed", { message: err.message });
    });

    const limitParsed = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitParsed) ? Math.min(100, Math.max(1, limitParsed)) : 25;
    const evaluatedOnly = req.query.evaluatedOnly === "true";

    const nearMisses = await getNearMisses({ limit, evaluatedOnly });

    const totalSavedCapital = nearMisses.reduce(
      (sum, row) => sum + (Number(row.saved_capital) || 0),
      0
    );

    return res.json({
      success: true,
      nearMisses,
      count: nearMisses.length,
      totalSavedCapital: Number(totalSavedCapital.toFixed(2)),
      unit: "EUR (virtuell)",
    });
  } catch (error) {
    logger.error("Admin near-misses route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   INTER-MARKET CORRELATION  –  BTC/Gold early-warning feed
========================================================= */

/**
 * GET /api/admin/inter-market
 * Returns the latest BTC/USD and Gold correlation snapshot.
 * Results are cached for 5 minutes in the service layer.
 */
router.get("/inter-market", async (req, res) => {
  try {
    const data = await getInterMarketCorrelation();
    return res.json({ success: true, ...data });
  } catch (error) {
    logger.error("Admin inter-market route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   AGENT WISDOM SCORES  (Prediction-Self-Audit)
========================================================= */

/**
 * GET /api/admin/agent-wisdom
 * Returns the Wisdom Score (hit-rate) for each swarm agent over the
 * last N calendar days.
 * Query params:
 *   windowDays  (number, 1-365, default 30)
 */
router.get("/agent-wisdom", async (req, res) => {
  try {
    const windowRaw = parseInt(req.query.windowDays, 10);
    const windowDays = Number.isFinite(windowRaw)
      ? Math.min(365, Math.max(1, windowRaw))
      : 30;

    const data = await getAgentWisdomScores({ windowDays });
    return res.json({ success: true, ...data });
  } catch (error) {
    logger.error("Admin agent-wisdom route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   CAUSAL MEMORY  –  Dynamic Agent Weights
========================================================= */

/**
 * GET /api/admin/agent-weights
 * Returns the current dynamic influence weights for each swarm agent.
 */
router.get("/agent-weights", async (req, res) => {
  try {
    const weights = await getAgentWeights();
    return res.json({ success: true, weights, generatedAt: new Date().toISOString() });
  } catch (error) {
    logger.error("Admin agent-weights route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/agent-weights/recalibrate
 * Triggers a manual Causal Memory recalibration cycle (adjusts weights
 * based on verified 48-h forecasts).
 */
router.post("/agent-weights/recalibrate", async (req, res) => {
  try {
    const result = await adjustAgentWeights();
    return res.json({ success: true, ...result, generatedAt: new Date().toISOString() });
  } catch (error) {
    logger.error("Admin agent-weights recalibrate error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/admin/dynamic-weights
 * Returns ALL rows from dynamic_weights – agent weights and factor weights.
 */
router.get("/dynamic-weights", async (req, res) => {
  try {
    const weights = await getAllDynamicWeights();
    return res.json({ success: true, weights, count: weights.length, generatedAt: new Date().toISOString() });
  } catch (error) {
    logger.error("Admin dynamic-weights route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   SECTOR COHERENCE CHECK
========================================================= */

/**
 * GET /api/admin/sector-coherence
 * Returns currently sharpened sectors and their definitions.
 */
router.get("/sector-coherence", async (req, res) => {
  try {
    const sharpened  = getSharpenedSectorSnapshot();
    const definitions = getSectorDefinitions();
    return res.json({
      success: true,
      sharpened,
      sharpenedCount: sharpened.length,
      definitions,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("Admin sector-coherence route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/sector-coherence/notify
 * Manually notify the coherence engine about a leader's price change.
 * Body: { symbol: string, changeFraction: number }
 * Example: { symbol: "AAPL", changeFraction: -0.03 }
 */
router.post("/sector-coherence/notify", (req, res) => {
  try {
    const symbol = String(req.body?.symbol || "").trim().toUpperCase();
    const changeFraction = Number(req.body?.changeFraction);

    if (!symbol) {
      return res.status(400).json({ success: false, error: "symbol is required" });
    }
    if (!Number.isFinite(changeFraction)) {
      return res.status(400).json({ success: false, error: "changeFraction must be a finite number" });
    }
    if (changeFraction < -1.0 || changeFraction > 1.0) {
      return res.status(400).json({ success: false, error: "changeFraction must be between -1.0 and 1.0" });
    }

    notifySectorLeaderQuote(symbol, changeFraction);
    const sharpened = getSharpenedSectorSnapshot();
    return res.json({
      success: true,
      message: `Sector coherence updated for ${symbol} (change: ${(changeFraction * 100).toFixed(2)}%)`,
      sharpened,
    });
  } catch (error) {
    logger.error("Admin sector-coherence notify error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   SYNTHETIC STRESS-TEST  –  Black Swan Engine
========================================================= */

/**
 * GET /api/admin/stress-test
 * Runs the Black Swan phantom scenario suite against all portfolio stocks
 * and returns an antifragility ranking.
 * Uses the latest portfolio data (mock portfolio).
 */
router.get("/stress-test", async (req, res) => {
  try {
    const portfolio = await getMockPortfolio();
    const rows = Array.isArray(portfolio) ? portfolio : [];

    const ranked = rankPortfolioAntifragility(
      rows.map((item) => ({
        symbol: item.symbol,
        snapshot: {
          hqsScore:    item.hqs_score ?? 0,
          entryPrice:  item.entry_price ?? 0,
          features: {
            momentum:       item.momentum       ?? 0,
            quality:        item.quality        ?? 0,
            stability:      item.stability      ?? 0,
            relative:       item.relative       ?? 0,
            volatility:     item.volatility     ?? 0,
            trendStrength:  item.trend_strength ?? 0,
            relativeVolume: item.relative_volume ?? 0,
            liquidityScore: item.liquidity_score ?? 0,
          },
          signalContext: {
            signalStrength:       item.signal_strength       ?? 0,
            trendScore:           item.trend_score           ?? 0,
            signalDirectionScore: item.signal_direction_score ?? 0,
            signalConfidence:     item.signal_confidence     ?? 0,
            buzzScore:            item.buzz_score            ?? 50,
            sentimentScore:       item.sentiment_score       ?? 0,
          },
          orchestrator: {
            opportunityStrength:    item.opportunity_strength    ?? 0,
            orchestratorConfidence: item.orchestrator_confidence ?? 0,
          },
        },
      }))
    );

    return res.json({
      success: true,
      ranking: ranked,
      scenarios: BLACK_SWAN_SCENARIOS.map((s) => ({ id: s.id, label: s.label, description: s.description })),
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("Admin stress-test route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/stress-test/single
 * Runs the Black Swan suite against a single snapshot provided in the body.
 * Body: { snapshot: { hqsScore, entryPrice, features, signalContext, orchestrator } }
 */
router.post("/stress-test/single", (req, res) => {
  try {
    const snapshot = req.body?.snapshot;
    if (!snapshot || typeof snapshot !== "object") {
      return res.status(400).json({ success: false, error: "snapshot object is required" });
    }

    const result = runBlackSwanTest(snapshot);
    return res.json({ success: true, ...result, generatedAt: new Date().toISOString() });
  } catch (error) {
    logger.error("Admin stress-test/single error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   TECH-RADAR  –  Innovation Scanner
========================================================= */

/**
 * GET /api/admin/tech-radar
 * Returns recent Tech-Radar entries from arXiv / research RSS feeds.
 * Query params:
 *   limit     (number, 1-200, default 50)
 *   relevance (string: 'high' | 'medium' | 'low')
 *   category  (string: 'quant_finance' | 'ai_ml' | 'risk_models' | 'other')
 */
router.get("/tech-radar", async (req, res) => {
  try {
    const limit     = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const relevance = ["high", "medium", "low"].includes(req.query.relevance)
      ? req.query.relevance : null;
    const category  = req.query.category || null;

    const entries = await getTechRadarEntries({ limit, relevance, category });
    return res.json({
      success: true,
      entries,
      count: entries.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("Admin tech-radar route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/admin/evolution-board
 * Returns the Evolution-Board: aggregated upgrade suggestions derived from
 * high/medium-relevance Tech-Radar discoveries.
 */
router.get("/evolution-board", async (req, res) => {
  try {
    const board = await getEvolutionBoard();
    // Mark new entries as seen after delivery
    markEntriesSeen().catch((err) => {
      logger.warn("evolution-board: markEntriesSeen failed", { message: err.message });
    });
    return res.json({ success: true, ...board });
  } catch (error) {
    logger.error("Admin evolution-board route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   SAVED CAPITAL  –  Wealth Protection Tracker
========================================================= */

/**
 * GET /api/admin/saved-capital
 * Returns the total fictive capital protected by Guardian / Debate vetoes.
 * Triggers a background evaluation of unscored near-misses.
 */
router.get("/saved-capital", async (req, res) => {
  try {
    // Non-blocking evaluation of pending near-miss records
    evaluateSavedCapital().catch((err) => {
      logger.warn("saved-capital: background evaluation failed", { message: err.message });
    });

    const nearMisses = await getNearMisses({ limit: 500, evaluatedOnly: true });
    const totalSaved = nearMisses.reduce(
      (sum, row) => sum + (Number(row.saved_capital) || 0), 0
    );
    const blockedCount = nearMisses.length;
    const recentBlocked = nearMisses.slice(0, 10).map((r) => ({
      symbol:        r.symbol,
      savedCapital:  Number(r.saved_capital) || 0,
      marketCluster: r.market_cluster,
      robustness:    Number(r.robustness_score) || 0,
      blockedAt:     r.created_at,
    }));

    return res.json({
      success: true,
      totalSavedCapital: Math.round(totalSaved * 100) / 100,
      blockedSignalsCount: blockedCount,
      recentBlocked,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("Admin saved-capital route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   WORLD STATE  –  Global Market Truth Layer
========================================================= */

/**
 * GET /api/admin/world-state
 * Returns the current unified world_state (regime + cross-asset + sector + agents).
 * Served from the in-memory cache when fresh; triggers a background rebuild
 * when the snapshot is stale.
 *
 * Optional query parameter:
 *   ?refresh=true  – forces a synchronous rebuild before responding
 */
router.get("/world-state", async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === "true";
    const worldState = forceRefresh
      ? await buildWorldState()
      : await getWorldState();

    return res.json({ success: true, worldState });
  } catch (error) {
    logger.error("Admin world-state route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/admin/allocation-preview
 * -------------------------------------------------------
 * Returns the current Capital Allocation Layer plan:
 *   - Reads worldState (regime, risk_mode, uncertainty)
 *   - Loads top portfolio items from MockPortfolioEngine
 *   - Runs applyCapitalAllocation() in-memory (no DB writes)
 *   - Returns per-item allocation fields + budget summary
 *
 * Optional query params:
 *   ?budget=10000    – override total budget in EUR
 *   ?maxPositions=10 – override max positions
 *   ?maxSectorPct=30 – override per-sector cap
 */
router.get("/allocation-preview", async (req, res) => {
  try {
    // 1. World state (cached, no extra cost)
    const ws = await getWorldState();

    const riskMode    = ws.risk_mode    || "neutral";
    const uncertainty = Number(ws.uncertainty) || 0;

    // 2. Portfolio candidates from MockPortfolioEngine (reads from DB, already cached path)
    const portfolioRows = await getMockPortfolio();
    const candidates    = Array.isArray(portfolioRows) ? portfolioRows : [];

    // Map portfolio rows to the shape capitalAllocation expects
    const mappedCandidates = candidates
      .filter(row => !row.suppressed)
      .map(row => ({
        symbol:          String(row.symbol || "").toUpperCase(),
        finalConviction: Number(row.final_conviction) || 0,
        finalRating:     null,
        robustnessScore: Number(row.robustness_score) || 0.5,
        volatility:      0,          // not stored on portfolio rows
        sectorAlert:     false,      // sector alerts come from sectorCoherence (runtime)
        hqsScore:        Number(row.hqs_score) || 0,
        strategy:        row.strategy || null,
        market_regime:   row.market_regime || "neutral",
      }))
      // Sort by finalConviction desc (mirrors opportunityScanner priority order)
      .sort((a, b) => b.finalConviction - a.finalConviction);

    // 3. Parse optional overrides
    const totalBudgetEur = Number(req.query.budget)       || Number(process.env.ALLOCATION_BUDGET_EUR) || 10000;
    const maxPositions   = Number(req.query.maxPositions) || DEFAULT_MAX_POSITIONS;
    const maxSectorPct   = Number(req.query.maxSectorPct) || DEFAULT_MAX_SECTOR_PCT;

    // 4. Run allocation (pure, O(n))
    const { opportunities: allocated, budgetSummary } = applyCapitalAllocation(
      mappedCandidates,
      { riskMode, uncertainty },
      { totalBudgetEur, maxPositions, maxSectorPct }
    );

    // 5. Split approved vs. rejected
    const approved = allocated.filter(o => o.allocationApproved);
    const rejected = allocated.filter(o => !o.allocationApproved);

    return res.json({
      success: true,
      worldState: {
        riskMode,
        uncertainty: Number(uncertainty.toFixed(3)),
        regime:      ws.regime?.cluster || "unknown",
        volatilityState: ws.volatility_state || "unknown",
        capturedAt:  ws.created_at || null,
      },
      budgetSummary,
      approvedPositions:  approved,
      rejectedCandidates: rejected,
      config: {
        totalBudgetEur,
        maxPositions,
        maxSectorPct,
        regimeMultipliers:  REGIME_MULTIPLIERS,
        sectorAlertMaxPct:  SECTOR_ALERT_MAX_PCT,
        env_ALLOCATION_BUDGET_EUR: process.env.ALLOCATION_BUDGET_EUR || null,
      },
    });
  } catch (error) {
    logger.error("Admin allocation-preview route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/allocation-preview/simulate
 * -------------------------------------------------------
 * Simulates position sizing for a single set of parameters.
 * Useful for testing how regime / uncertainty affect sizing.
 *
 * Body (JSON):
 *   { finalConviction, finalRating, robustnessScore, volatility,
 *     riskMode, uncertainty, sectorAlert, totalBudgetEur }
 */
router.post("/allocation-preview/simulate", (req, res) => {
  try {
    const body = req.body || {};
    const result = calculatePositionSize({
      finalConviction: Number(body.finalConviction) || 0,
      finalRating:     body.finalRating     || null,
      robustnessScore: Number(body.robustnessScore) || 0.5,
      volatility:      Number(body.volatility)      || 0,
      riskMode:        body.riskMode        || "neutral",
      uncertainty:     Number(body.uncertainty)     || 0,
      sectorAlert:     Boolean(body.sectorAlert),
      totalBudgetEur:  Number(body.totalBudgetEur)  || 10000,
    });

    return res.json({ success: true, sizing: result });
  } catch (error) {
    logger.error("Admin allocation-preview/simulate route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   PORTFOLIO TWIN  –  Virtual Capital Tracker (Stage 1)
========================================================= */

/**
 * GET /api/admin/portfolio-twin
 * Returns a full portfolio twin snapshot:
 *   totalAllocatedEur, unrealizedPnlEur, realizedPnlEur,
 *   openPositions, closedPositions, equityCurve, maxDrawdownPct
 *
 * Optional query params:
 *   ?limit=50  – max positions per bucket (open / closed)
 */
router.get("/portfolio-twin", async (req, res) => {
  try {
    const limit    = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
    const snapshot = await getPortfolioTwinSnapshot({ limit });
    return res.json({ success: true, portfolioTwin: snapshot });
  } catch (error) {
    logger.error("Admin portfolio-twin route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/admin/portfolio-twin/positions
 * Returns a paginated list of virtual positions.
 *
 * Optional query params:
 *   ?status=open|closed  – filter by status
 *   ?limit=50            – max results
 *   ?offset=0            – pagination offset
 */
router.get("/portfolio-twin/positions", async (req, res) => {
  try {
    const status = req.query.status || null;
    const limit  = Math.max(1, Math.min(Number(req.query.limit)  || 50,  200));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    if (status && status !== "open" && status !== "closed") {
      return res.status(400).json({
        success: false,
        error: "status must be 'open' or 'closed'",
      });
    }

    const positions = await listVirtualPositions({ status, limit, offset });
    return res.json({ success: true, positions, count: positions.length });
  } catch (error) {
    logger.error("Admin portfolio-twin/positions route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/portfolio-twin/refresh
 * Refreshes current_price and unrealised PnL for all open positions
 * using latest prices from market_snapshots (no external API cost).
 */
router.post("/portfolio-twin/refresh", async (req, res) => {
  try {
    const result = await refreshOpenVirtualPositions();
    return res.json({ success: true, ...result });
  } catch (error) {
    logger.error("Admin portfolio-twin/refresh route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/portfolio-twin/close/:id
 * Closes a virtual position manually.
 *
 * Optional body:
 *   { reason: "manual", exitPrice: 150.00 }
 */
router.post("/portfolio-twin/close/:id", async (req, res) => {
  try {
    const id    = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: "id must be a positive integer" });
    }

    const body      = req.body || {};
    const reason    = String(body.reason || "manual").slice(0, 100);
    const exitPrice = body.exitPrice != null ? Number(body.exitPrice) : null;

    if (exitPrice !== null && (!Number.isFinite(exitPrice) || exitPrice <= 0)) {
      return res.status(400).json({ success: false, error: "exitPrice must be a positive number" });
    }

    const position = await closeVirtualPosition(id, reason, exitPrice || null);
    return res.json({ success: true, position });
  } catch (error) {
    // Surface "not found" / "already closed" as 400
    if (error.message && (
      error.message.includes("not found") ||
      error.message.includes("already closed")
    )) {
      return res.status(400).json({ success: false, error: error.message });
    }
    logger.error("Admin portfolio-twin/close route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/portfolio-twin/open
 * Debug/admin endpoint: manually open a virtual position.
 *
 * Body (JSON, all required unless noted):
 *   { symbol, entryPrice, allocatedEur, allocatedPct,
 *     convictionTier?, riskModeAtEntry?, uncertaintyAtEntry?, sourceRunId? }
 */
router.post("/portfolio-twin/open", async (req, res) => {
  try {
    const body = req.body || {};

    const symbol       = String(body.symbol || "").trim().toUpperCase();
    const entryPrice   = Number(body.entryPrice);
    const allocatedEur = Number(body.allocatedEur);
    const allocatedPct = Number(body.allocatedPct) || 0;

    if (!symbol) {
      return res.status(400).json({ success: false, error: "symbol is required" });
    }
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      return res.status(400).json({ success: false, error: "entryPrice must be a positive number" });
    }
    if (!Number.isFinite(allocatedEur) || allocatedEur <= 0) {
      return res.status(400).json({ success: false, error: "allocatedEur must be a positive number" });
    }

    const position = await openVirtualPositionFromAllocation({
      symbol,
      entryPrice,
      allocatedEur,
      allocatedPct,
      convictionTier:     body.convictionTier    || null,
      riskModeAtEntry:    body.riskModeAtEntry   || null,
      uncertaintyAtEntry: body.uncertaintyAtEntry != null ? Number(body.uncertaintyAtEntry) : null,
      sourceRunId:        body.sourceRunId        || null,
    });

    return res.status(201).json({ success: true, position });
  } catch (error) {
    logger.error("Admin portfolio-twin/open route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/admin/portfolio-twin/stage4
 *
 * Returns the Stage 4 Portfolio Twin intelligence block:
 *   - currentDrawdownPct  : live drawdown from equity peak
 *   - maxDrawdownPct      : historical maximum drawdown
 *   - concentrationFlags  : sector/cluster/risk concentration heuristics  (Paket B)
 *   - activeFlags         : list of currently active warning flags
 *   - correlationApprox   : lightweight correlation risk score + warnings  (Paket C)
 *   - counterfactual      : what-if estimates for trimming/capping          (Paket D)
 *
 * Pure read – no writes, no external API calls.
 * WorldState consumed opportunistically (graceful fallback on failure).
 */
router.get("/portfolio-twin/stage4", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 200));
    const analysis = await getStage4Analysis({ limit });
    return res.json({ success: true, stage4: analysis });
  } catch (error) {
    logger.error("Admin portfolio-twin/stage4 route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   SYSTEM INTELLIGENCE  (Meta-Layer Self-Assessment)
========================================================= */

/**
 * GET /api/admin/system-intelligence
 * Returns a unified System Intelligence Report (SIS 0–100) aggregated
 * from all active intelligence layers:
 *   - Prediction Quality (agent forecast accuracy)
 *   - Capital Protection (Guardian near-miss records)
 *   - Portfolio Twin     (virtual positions & PnL)
 *   - Adaptive Learning  (dynamic-weight divergence)
 *   - Innovation Awareness (tech-radar entries)
 *   - Pattern Memory     (verified outcome records)
 *
 * Pure read – no writes, no external API calls.
 */
router.get("/system-intelligence", async (req, res) => {
  try {
    const report = await getSystemIntelligenceReport();
    return res.json({ success: true, ...report });
  } catch (error) {
    logger.error("Admin system-intelligence route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   OPERATIONAL STATUS  (Portfolio Twin Stage 3 + SIS Release Control)
========================================================= */

/**
 * GET /api/admin/operational-status
 *
 * Returns the combined operational view:
 *   - portfolioTwinState : Stage 3 snapshot (win rate, avg gain/loss, maturity, …)
 *   - sisReport          : current SIS score, layers, recommendations
 *   - operationalRelease : per-gate decisions (granted/blocked + reason each)
 *   - controlStatus      : three-way split (technically possible / released / blocked)
 *   - biggestBlockers    : list of currently blocking gates with reasons
 *   - nextStep           : concrete recommendation for the next improvement
 *
 * Pure read – no writes, no external API calls.
 */
router.get("/operational-status", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));

    const [releaseStatus, twinSnapshot, sisReport] = await Promise.all([
      getOperationalReleaseStatus(),
      getPortfolioTwinSnapshot({ limit }),
      getSystemIntelligenceReport(),
    ]);

    return res.json({
      success: true,
      portfolioTwinState: twinSnapshot,
      sisReport,
      operationalRelease: {
        recommendedMode:        releaseStatus.recommendedMode,
        allowAutoPositionOpen:  releaseStatus.allowAutoPositionOpen,
        allowBroaderDiscovery:  releaseStatus.allowBroaderDiscovery,
        allowAggressiveWeights: releaseStatus.allowAggressiveWeights,
        allowScaleTo450:        releaseStatus.allowScaleTo450,
        allowScaleTo600:        releaseStatus.allowScaleTo600,
        allowChinaExpansion:    releaseStatus.allowChinaExpansion,
        allowEuropeExpansion:   releaseStatus.allowEuropeExpansion,
        grantedCount:           releaseStatus.grantedCount,
        blockerCount:           releaseStatus.blockerCount,
      },
      controlStatus:   releaseStatus.controlStatus,
      biggestBlockers: releaseStatus.biggestBlockers,
      nextStep:        releaseStatus.nextStep,
      riskMode:        releaseStatus.riskMode,
      generatedAt:     releaseStatus.generatedAt,
    });
  } catch (error) {
    logger.error("Admin operational-status route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   SIS HISTORY  (Trend Layer)
========================================================= */

/**
 * GET /api/admin/sis-history?range=24h|7d|30d
 *
 * Returns raw SIS snapshot rows for the requested time window.
 * Also triggers a fresh snapshot save (deduped by interval).
 */
router.get("/sis-history", async (req, res) => {
  try {
    const VALID_RANGES = ["24h", "7d", "30d"];
    const range = VALID_RANGES.includes(req.query.range) ? req.query.range : "7d";

    // Opportunistically refresh the snapshot (deduped – low cost)
    getSystemIntelligenceReport()
      .then((r) => saveSisSnapshot(r))
      .catch(() => {});

    const rows = await getSisHistory(range);
    return res.json({ success: true, range, count: rows.length, history: rows });
  } catch (error) {
    logger.error("Admin sis-history route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/admin/sis-trend-summary
 *
 * Returns a compact trend summary:
 *   current, delta24h, delta7d, delta30d, direction, directionLabel,
 *   topDeclineLayer, topGainLayer, snapshotCount, lastUpdated
 */
router.get("/sis-trend-summary", async (req, res) => {
  try {
    const summary = await getSisTrendSummary();
    return res.json({ success: true, ...summary });
  } catch (error) {
    logger.error("Admin sis-trend-summary route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/admin/sis-regressions
 *
 * Returns regression and improvement episodes from the last 30 days.
 * Useful for early-warning and root-cause analysis.
 */
router.get("/sis-regressions", async (req, res) => {
  try {
    const [regressions, improvements] = await Promise.all([
      detectSisRegression(),
      detectSisImprovement(),
    ]);
    return res.json({
      success: true,
      regressions,
      improvements,
      regressionCount:  regressions.length,
      improvementCount: improvements.length,
    });
  } catch (error) {
    logger.error("Admin sis-regressions route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
 * GET /api/admin/interface-state
 * ─────────────────────────────────────────────────────────
 * Returns the UI-direction payload for the "Interface on Demand" layer.
 * Aggregates SIS, operational gates, world state and SIS trend into a
 * single surfaceMode + agentDiscourse payload. Pure derivation – no DB
 * writes, no external API calls.
 */
router.get("/interface-state", async (req, res) => {
  try {
    const state = await getInterfaceState();
    return res.json({ success: true, ...state });
  } catch (error) {
    logger.error("Admin interface-state route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   PIPELINE STATUS  (Task 4 – data pipeline observability)
   GET /api/admin/pipeline-status
   Returns the last-known stage counts from buildMarketSnapshot().
   Merges runtime (in-memory) data with persisted DB data so counts
   survive Railway restarts.
========================================================= */

router.get("/pipeline-status", async (req, res) => {
  try {
    const raw = await getPipelineStatusWithPersistence();
    // Ensure all expected stage keys are present with safe defaults
    const stages = ["universe", "snapshot", "advancedMetrics", "hqsScoring", "outcome"];
    const status = { stages: {} };
    for (const stage of stages) {
      const s = raw?.stages?.[stage] ?? null;
      status.stages[stage] = {
        inputCount:    s?.inputCount    ?? 0,
        successCount:  s?.successCount  ?? 0,
        failedCount:   s?.failedCount   ?? 0,
        skippedCount:  s?.skippedCount  ?? 0,
        lastUpdated:   s?.lastUpdated   ?? null,
        source:        s?.source        ?? "empty",
      };
    }
    status.generatedAt       = raw?.generatedAt ?? null;
    status.statusGeneratedAt = status.generatedAt; // kept for backwards-compatibility
    status.lastRunMs         = raw?.lastRunMs   ?? null;
    return res.json({ success: true, ...status });
  } catch (error) {
    logger.error("Admin pipeline-status route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   TABLE HEALTH  (Task 5 – admin table diagnostics)
   GET /api/admin/table-health
   Returns green/yellow/red status for the 8 admin-relevant tables.
========================================================= */

router.get("/table-health", async (req, res) => {
  try {
    const report = await runTableHealthCheck();
    // Ensure consistent shape even on partial failure
    const safeReport = {
      overallStatus: report?.overallStatus ?? "red",
      green:         report?.green         ?? 0,
      yellow:        report?.yellow        ?? 0,
      red:           report?.red           ?? 0,
      tables:        Array.isArray(report?.tables) ? report.tables : [],
      generatedAt:   report?.checkedAt     ?? new Date().toISOString(),
      checkedAt:     report?.checkedAt     ?? new Date().toISOString(),
      durationMs:    report?.durationMs    ?? 0,
    };
    return res.json({ success: true, ...safeReport });
  } catch (error) {
    logger.error("Admin table-health route error", { message: error.message });
    return res.status(500).json({
      success:       false,
      generatedAt:   new Date().toISOString(),
      overallStatus: "red",
      green:  0,
      yellow: 0,
      red:    0,
      tables: [],
      error:  error.message,
    });
  }
});

/* =========================================================
   SNAPSHOT TRIGGER
   POST /api/admin/snapshot
   Triggers a full market snapshot build.
========================================================= */

router.post("/snapshot", async (_req, res) => {
  try {
    const result = await buildMarketSnapshot();
    return res.json({ success: true, ...result });
  } catch (error) {
    logger.error("Admin snapshot route error", { message: error.message });
    return res.status(500).json({
      success: false,
      message: "Snapshot-Erstellung fehlgeschlagen",
      error: error.message,
    });
  }
});

/* =========================================================
   MARKET NEWS COLLECT
   POST /api/admin/market-news/collect
   Collects and stores market news for given symbols.
========================================================= */

router.post("/market-news/collect", async (req, res) => {
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

    const symbolsInput = Array.isArray(req.body?.symbols) ? req.body.symbols : [];
    const symbols = normalizeSymbols(symbolsInput);

    const result = await collectAndStoreMarketNews({
      limit: limitResult.value,
      symbols,
    });

    return res.json({ success: true, ...result });
  } catch (error) {
    logger.error("Admin market-news/collect route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   ADMIN DEMO PORTFOLIO  (real DB data, no mocks)
========================================================= */

router.get("/demo-portfolio", async (req, res) => {
  try {
    const result = await getAdminDemoPortfolio();
    return res.json(result);
  } catch (error) {
    logger.error("Admin demo-portfolio route error", { message: error.message });
    return res.json({
      success: false,
      portfolioId: "DEMO_ADMIN_20",
      portfolioName: "Internes Admin-Prüfportfolio",
      symbolCount: 0,
      dataStatus: "error",
      holdings: [],
      partialErrors: [{ symbol: "*", error: error.message }],
      generatedAt: new Date().toISOString(),
      summary: {
        total: 0, green: 0, yellow: 0, red: 0,
        topBottleneck: null, topBottleneckCount: 0,
        byReason: {}, avgCompletenessScore: 0, avgReliabilityScore: 0,
        missingSourceCounts: { snapshot: 0, score: 0, metrics: 0, news: 0 },
        staleCounts: { snapshot: 0, score: 0, metrics: 0, news: 0 },
      },
    });
  }
});

/* =========================================================
   VIRTUAL POSITIONS – Admin Read + Manual Sync
   ─────────────────────────────────────────────────────────
   Dedicated endpoints for virtual_positions (paper/probe positions).
   Separate from portfolio-twin analytics to provide a clean,
   focused interface for admin/frontend consumption.

   Relationship to Demo-Portfolio:
     • demo-portfolio  = curated ~20 symbol diagnostic view (read-only)
     • virtual_positions = persistent system paper positions with lifecycle
   Both are complementary – demo-portfolio diagnoses data quality,
   virtual_positions tracks actual simulated trades.
========================================================= */

/**
 * GET /api/admin/virtual-positions
 * Returns a paginated list of virtual positions with clear response shape.
 *
 * Query params:
 *   ?status=open|closed  – filter by position status (default: all)
 *   ?limit=50            – max results (1-200)
 *   ?offset=0            – pagination offset
 */
router.get("/virtual-positions", async (req, res) => {
  try {
    const status = req.query.status || null;
    const limit  = Math.max(1, Math.min(Number(req.query.limit)  || 50,  200));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    if (status && status !== "open" && status !== "closed") {
      return res.status(400).json({
        success: false,
        error: "status must be 'open' or 'closed'",
      });
    }

    const positions = await listVirtualPositions({ status, limit, offset });

    return res.json({
      success:     true,
      count:       positions.length,
      filters:     { status: status || "all", limit, offset },
      positions,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("Admin virtual-positions route error", { message: error.message });
    return res.status(500).json({
      success: false,
      error:   error.message,
      positions: [],
      count:   0,
    });
  }
});

/**
 * POST /api/admin/virtual-positions/sync
 * Manually triggers a sync of virtual positions from real data sources.
 * Normally runs automatically via warmup cycle (every 15 min).
 */
router.post("/virtual-positions/sync", async (req, res) => {
  try {
    const report = await syncVirtualPositions();
    return res.json({ success: true, syncReport: report });
  } catch (error) {
    logger.error("Admin virtual-positions/sync route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   STEP 3 – OUTCOME / TIMING / PROOF ENDPOINTS
   ─────────────────────────────────────────────────────────
   All endpoints are read-only, purely derived from existing
   tables (outcome_tracking, market_snapshots, agent_forecasts,
   guardian_near_miss).  No mock data.  All responses carry
   a _meta block with dataStatus (full|partial|empty).
========================================================= */

/* ─────────────────────────────────────────────────────────
 * GET /api/admin/signal-history
 * Returns paginated list of all signals with current price
 * context and completeness indicators.
 *
 * Query params:
 *   ?limit=50     – max results (1–200)
 *   ?offset=0     – pagination offset
 * ───────────────────────────────────────────────────────── */
router.get("/signal-history", async (req, res) => {
  try {
    const limit  = Math.max(1, Math.min(Number(req.query.limit)  || 50,  200));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const result = await getSignalHistoryAll({ limit, offset });
    return res.json(result);
  } catch (error) {
    logger.error("Admin signal-history route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

/* ─────────────────────────────────────────────────────────
 * GET /api/admin/signal-history/:symbol
 * Returns signal history for a single symbol.
 *
 * Query params:
 *   ?limit=50  – max results (1–200)
 * ───────────────────────────────────────────────────────── */
router.get("/signal-history/:symbol", async (req, res) => {
  try {
    const symbol = String(req.params.symbol || "").trim().toUpperCase();
    if (!symbol) {
      return res.status(400).json({ success: false, error: "symbol is required" });
    }
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
    const result = await getSignalHistoryBySymbol(symbol, limit);
    return res.json(result);
  } catch (error) {
    logger.error("Admin signal-history/:symbol route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

/* ─────────────────────────────────────────────────────────
 * GET /api/admin/outcome-analysis
 * Returns 7d / 30d outcome evaluation per signal including
 * max-upside and max-drawdown from stored market snapshots.
 *
 * Query params:
 *   ?symbol=AAPL – filter to one symbol (optional)
 *   ?limit=50
 *   ?offset=0
 * ───────────────────────────────────────────────────────── */
router.get("/outcome-analysis", async (req, res) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).trim().toUpperCase() : null;
    const limit  = Math.max(1, Math.min(Number(req.query.limit)  || 50,  200));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const result = await getOutcomeAnalysis({ symbol, limit, offset });
    return res.json(result);
  } catch (error) {
    logger.error("Admin outcome-analysis route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

/* ─────────────────────────────────────────────────────────
 * GET /api/admin/timing-quality
 * Returns timing assessment per signal (zu früh / passend /
 * zu spät / unklar) with a human-readable reason string.
 *
 * Query params:
 *   ?symbol=AAPL – filter to one symbol (optional)
 *   ?limit=50
 *   ?offset=0
 * ───────────────────────────────────────────────────────── */
router.get("/timing-quality", async (req, res) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).trim().toUpperCase() : null;
    const limit  = Math.max(1, Math.min(Number(req.query.limit)  || 50,  200));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const result = await getTimingQuality({ symbol, limit, offset });
    return res.json(result);
  } catch (error) {
    logger.error("Admin timing-quality route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

/* ─────────────────────────────────────────────────────────
 * GET /api/admin/forecast-vs-outcome
 * Compares agent forecast directions (agent_forecasts) with
 * actual 24h and 7d outcomes.  Only verified forecasts shown.
 *
 * Query params:
 *   ?symbol=AAPL       – filter to one symbol (optional)
 *   ?limit=50
 *   ?offset=0
 *   ?windowDays=30     – look-back window in days (1–365)
 * ───────────────────────────────────────────────────────── */
router.get("/forecast-vs-outcome", async (req, res) => {
  try {
    const symbol     = req.query.symbol ? String(req.query.symbol).trim().toUpperCase() : null;
    const limit      = Math.max(1, Math.min(Number(req.query.limit)      || 50,  200));
    const offset     = Math.max(0, Number(req.query.offset) || 0);
    const windowDays = Math.max(1, Math.min(Number(req.query.windowDays) || 30,  365));
    const result = await getForecastVsOutcome({ symbol, limit, offset, windowDays });
    return res.json(result);
  } catch (error) {
    logger.error("Admin forecast-vs-outcome route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

/* ─────────────────────────────────────────────────────────
 * GET /api/admin/signal-kpis
 * Aggregated KPI dashboard: hit rates, avg returns, timing
 * distribution, agent accuracy.
 *
 * Query params:
 *   ?windowDays=90  – aggregation window in days (7–365)
 * ───────────────────────────────────────────────────────── */
router.get("/signal-kpis", async (req, res) => {
  try {
    const windowDays = Math.max(7, Math.min(Number(req.query.windowDays) || 90, 365));
    const result = await getSignalKPIs({ windowDays });
    return res.json(result);
  } catch (error) {
    logger.error("Admin signal-kpis route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

/* ─────────────────────────────────────────────────────────
 * GET /api/admin/review-queue
 * Step 7 Block 2: Approval-Queue & Action Review Flow
 *
 * Returns the current approval/review queue derived from
 * the top opportunities.  No execution – read-only view.
 *
 * Response shape:
 *   pendingApproval  – items awaiting manual review (approvalRequired=true)
 *   proposalBucket   – structured proposals ready for user decision
 *   insufficientData – signals not yet ready for any action
 *   summary          – counts per bucket + priority breakdown
 *
 * Query params:
 *   ?limit=20        – number of scanner candidates to evaluate (1–50)
 * ───────────────────────────────────────────────────────── */
router.get("/review-queue", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 50));
    const opportunities = await getTopOpportunities({ limit });

    // Step 8 Block 1: compute governance context for admin caller
    const governanceCtx = computeGovernanceContext({ isAdminRoute: true });

    const pendingApproval = [];
    const proposalBucket  = [];
    const insufficientData = [];

    for (const opp of opportunities) {
      const aq = opp.approvalQueueEntry;
      if (!aq) continue;

      const entry = {
        symbol:              opp.symbol,
        actionReadiness:     opp.actionReadiness?.actionReadiness ?? null,
        approvalRequired:    opp.actionReadiness?.approvalRequired ?? false,
        reviewPriority:      aq.reviewPriority,
        approvalQueueBucket: aq.approvalQueueBucket,
        reviewReason:        aq.reviewReason,
        reviewSummary:       aq.reviewSummary,
        actionType:          opp.nextAction?.actionType        ?? null,
        actionPriority:      opp.nextAction?.actionPriority    ?? null,
        escalationLevel:     opp.actionOrchestration?.escalationLevel ?? null,
        concentrationRisk:   opp.portfolioContext?.concentrationRisk  ?? null,
        finalConviction:     opp.finalConviction  ?? null,
        hqsScore:            opp.hqsScore         ?? null,
        // Step 7 Block 3: decision layer fields
        decisionStatus:      opp.decisionLayer?.decisionStatus    ?? null,
        decisionReason:      opp.decisionLayer?.decisionReason    ?? null,
        approvalOutcome:     opp.decisionLayer?.approvalOutcome   ?? null,
        decisionReadiness:   opp.decisionLayer?.decisionReadiness ?? null,
        // Step 7 Block 4: controlled approval flow fields
        approvalFlowStatus:    opp.controlledApprovalFlow?.approvalFlowStatus    ?? null,
        postDecisionAction:    opp.controlledApprovalFlow?.postDecisionAction    ?? null,
        closureStatus:         opp.controlledApprovalFlow?.closureStatus         ?? null,
        nextReviewAt:          opp.controlledApprovalFlow?.nextReviewAt          ?? null,
        deferUntil:            opp.controlledApprovalFlow?.deferUntil            ?? null,
        executionIntent:       opp.controlledApprovalFlow?.executionIntent       ?? null,
        actionLifecycleStage:  opp.controlledApprovalFlow?.actionLifecycleStage  ?? null,
        // Step 7 Block 5: audit/trace/safety fields
        governanceStatus:    opp.auditTrace?.governanceStatus    ?? null,
        blockedByGuardrail:  opp.auditTrace?.blockedByGuardrail  ?? false,
        traceReason:         opp.auditTrace?.traceReason         ?? null,
        safetyFlags:         opp.auditTrace?.safetyFlags         ?? [],
        auditSummary:        opp.auditTrace?.auditSummary        ?? null,
        // Step 8 Block 1: per-opportunity governance classification
        governanceContext:   opp.governanceContext ?? null,
      };

      if (aq.pendingApproval) {
        pendingApproval.push(entry);
      } else if (aq.approvalQueueBucket === "proposal_bucket") {
        proposalBucket.push(entry);
      } else if (aq.approvalQueueBucket === "insufficient_data") {
        insufficientData.push(entry);
      }
    }

    // Sort pending by reviewPriority (high → medium → low)
    const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
    const byPriority = (a, b) =>
      (PRIORITY_RANK[a.reviewPriority] ?? 3) - (PRIORITY_RANK[b.reviewPriority] ?? 3);
    pendingApproval.sort(byPriority);
    proposalBucket.sort(byPriority);

    return res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      summary: {
        pendingApprovalCount:  pendingApproval.length,
        proposalBucketCount:   proposalBucket.length,
        insufficientDataCount: insufficientData.length,
        riskReviewCount:       pendingApproval.filter((e) => e.approvalQueueBucket === "risk_review").length,
        highPriorityCount:     pendingApproval.filter((e) => e.reviewPriority === "high").length,
        // Step 7 Block 3: decision layer distribution
        approvedCandidateCount:  [...pendingApproval, ...proposalBucket, ...insufficientData].filter((e) => e.decisionStatus === "approved_candidate").length,
        pendingReviewCount:      [...pendingApproval, ...proposalBucket, ...insufficientData].filter((e) => e.decisionStatus === "pending_review").length,
        deferredReviewCount:     [...pendingApproval, ...proposalBucket, ...insufficientData].filter((e) => e.decisionStatus === "deferred_review").length,
        needsMoreDataCount:      [...pendingApproval, ...proposalBucket, ...insufficientData].filter((e) => e.decisionStatus === "needs_more_data").length,
        // Step 7 Block 4: controlled approval flow distribution
        approvalFlowApprovedPendingAction: [...pendingApproval, ...proposalBucket, ...insufficientData].filter((e) => e.approvalFlowStatus === "approved_pending_action").length,
        approvalFlowAwaitingReview:        [...pendingApproval, ...proposalBucket, ...insufficientData].filter((e) => e.approvalFlowStatus === "awaiting_review").length,
        approvalFlowDeferred:              [...pendingApproval, ...proposalBucket, ...insufficientData].filter((e) => e.approvalFlowStatus === "deferred").length,
        approvalFlowWaitingForMoreData:    [...pendingApproval, ...proposalBucket, ...insufficientData].filter((e) => e.approvalFlowStatus === "waiting_for_more_data").length,
        approvalFlowClosed:                [...pendingApproval, ...proposalBucket, ...insufficientData].filter((e) => e.approvalFlowStatus === "closed").length,
        // Step 7 Block 5: audit/safety distribution
        blockedByGuardrailCount:   [...pendingApproval, ...proposalBucket, ...insufficientData].filter((e) => e.blockedByGuardrail === true).length,
        reviewControlledCount:     [...pendingApproval, ...proposalBucket, ...insufficientData].filter((e) => e.governanceStatus === "review_controlled").length,
        dataLimitedCount:          [...pendingApproval, ...proposalBucket, ...insufficientData].filter((e) => e.governanceStatus === "data_limited").length,
      },
      // Step 8 Block 1: governance context for admin caller (role, scope, SoD)
      governanceContext: governanceCtx,
      pendingApproval,
      proposalBucket,
      insufficientData,
    });
  } catch (error) {
    logger.error("Admin review-queue route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * GET /api/admin/exception-hub
 * Step 8 Block 2: Operating Console / Exception Hub – read-only.
 *
 * Returns an aggregate view of all open operational exceptions derived from
 * existing governance layers (actionReadiness, approvalQueueEntry,
 * decisionLayer, controlledApprovalFlow, auditTrace, userAttentionLevel).
 * No new signals are introduced – pure read/fold over scanner output.
 *
 * Query params:
 *   ?limit=20  – number of scanner candidates to evaluate (1–50)
 * ───────────────────────────────────────────────────────── */
router.get("/exception-hub", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 50));
    const opportunities = await getTopOpportunities({ limit });

    // Governance context for the calling admin actor
    const governanceCtx = computeGovernanceContext({ isAdminRoute: true });

    // Step 8 Block 2: aggregate exception/operating console view
    const exceptionHub = computeOperatingConsoleContext(opportunities);

    // Slim per-exception-entry list sorted by exception priority
    const exceptionEntries = opportunities
      .filter((o) => o.exceptionFields?.exceptionType !== "normal")
      .map((o) => ({
        symbol:              o.symbol,
        exceptionType:       o.exceptionFields?.exceptionType     ?? "normal",
        exceptionPriority:   o.exceptionFields?.exceptionPriority ?? "low",
        actionReadiness:     o.actionReadiness?.actionReadiness   ?? null,
        approvalQueueBucket: o.approvalQueueEntry?.approvalQueueBucket ?? null,
        pendingApproval:     o.approvalQueueEntry?.pendingApproval ?? false,
        decisionStatus:      o.decisionLayer?.decisionStatus      ?? null,
        approvalFlowStatus:  o.controlledApprovalFlow?.approvalFlowStatus ?? null,
        blockedByGuardrail:  o.auditTrace?.blockedByGuardrail     ?? false,
        governanceStatus:    o.auditTrace?.governanceStatus        ?? null,
        reviewPriority:      o.approvalQueueEntry?.reviewPriority  ?? null,
        governanceContext:   o.governanceContext                    ?? null,
      }))
      .sort((a, b) =>
        (EXCEPTION_PRIORITY_RANK[a.exceptionPriority] ?? 3) -
        (EXCEPTION_PRIORITY_RANK[b.exceptionPriority] ?? 3)
      );

    return res.json({
      success:        true,
      generatedAt:    new Date().toISOString(),
      governanceContext: governanceCtx,
      exceptionHub,
      exceptionEntries,
    });
  } catch (error) {
    logger.error("Admin exception-hub route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * GET /api/admin/policy-plane
 * Step 8 Block 3: Policy Plane / Shadow Mode / Four-Eyes – read-only.
 *
 * Returns a governance-level summary of policy versions, statuses, modes,
 * shadow-mode eligibility and four-eyes (second-approval) classification
 * derived from existing opportunity layers.  No new signals introduced.
 *
 * Query params:
 *   ?limit=20  – number of scanner candidates to evaluate (1–50)
 * ───────────────────────────────────────────────────────── */
router.get("/policy-plane", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 50));
    const opportunities = await getTopOpportunities({ limit });

    // Governance context for the calling admin actor
    const governanceCtx = computeGovernanceContext({ isAdminRoute: true });

    // Aggregate policy-plane summary from enriched opportunities
    const secondApprovalRequired = opportunities.filter((o) => o.policyPlane?.requiresSecondApproval === true);
    const shadowMode              = opportunities.filter((o) => o.policyPlane?.policyMode === "shadow");
    const draftMode               = opportunities.filter((o) => o.policyPlane?.policyMode === "draft");
    const shadowEligible          = opportunities.filter((o) => o.policyPlane?.shadowModeEligible === true);
    const pendingApprovalPolicy   = opportunities.filter((o) => o.policyPlane?.policyStatus === "pending_approval");

    const policyPlaneSummary = {
      totalEvaluated:            opportunities.length,
      secondApprovalRequiredCount: secondApprovalRequired.length,
      shadowModeCount:           shadowMode.length,
      draftModeCount:            draftMode.length,
      shadowEligibleCount:       shadowEligible.length,
      pendingApprovalPolicyCount: pendingApprovalPolicy.length,
      policyPlaneBasis:          "step8_block3",
    };

    // Slim per-entry list for non-live / non-normal policy states
    const policyEntries = opportunities
      .filter((o) => o.policyPlane && o.policyPlane.policyMode !== "live")
      .map((o) => ({
        symbol:                o.symbol,
        policyVersion:         o.policyPlane.policyVersion,
        policyStatus:          o.policyPlane.policyStatus,
        policyMode:            o.policyPlane.policyMode,
        requiresSecondApproval: o.policyPlane.requiresSecondApproval,
        approvalState:         o.policyPlane.approvalState,
        secondApprovalReady:   o.policyPlane.secondApprovalReady,
        shadowModeEligible:    o.policyPlane.shadowModeEligible,
        shadowReason:          o.policyPlane.shadowReason ?? null,
        policyScope:           o.policyPlane.policyScope,
        policyMutationAllowed: o.policyPlane.policyMutationAllowed,
        // Relevant cross-layer context
        decisionStatus:        o.decisionLayer?.decisionStatus         ?? null,
        approvalFlowStatus:    o.controlledApprovalFlow?.approvalFlowStatus ?? null,
        blockedByGuardrail:    o.auditTrace?.blockedByGuardrail        ?? false,
        governanceContext:     o.governanceContext                      ?? null,
      }));

    return res.json({
      success:         true,
      generatedAt:     new Date().toISOString(),
      governanceContext: governanceCtx,
      policyPlaneSummary,
      policyEntries,
    });
  } catch (error) {
    logger.error("Admin policy-plane route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * GET /api/admin/evidence-packages
 * Step 8 Block 4: Evidence Packages & Policy Versioning – read-only.
 *
 * Returns per-opportunity evidence packages (policyFingerprint, policyValidity,
 * policyApprovalHistory, operatorActionTrace) and an aggregate evidence summary
 * derived from existing governance layers.  No new signals introduced.
 *
 * Query params:
 *   ?limit=20  – number of scanner candidates to evaluate (1–50)
 * ───────────────────────────────────────────────────────── */
router.get("/evidence-packages", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 50));
    const opportunities = await getTopOpportunities({ limit });

    // Governance context for the calling admin actor
    const governanceCtx = computeGovernanceContext({ isAdminRoute: true });

    // Aggregate evidence summary counts
    const suspendedCount = opportunities.filter((o) => o.policyValidity === "suspended").length;
    const pendingCount   = opportunities.filter((o) => o.policyValidity === "pending").length;
    const validCount     = opportunities.filter((o) => o.policyValidity === "valid" || !o.policyValidity).length;
    const withFourEyes   = opportunities.filter((o) => o.evidencePackage?.approvalSummary?.requiresSecondApproval === true).length;
    const withGuardrail  = opportunities.filter((o) => o.evidencePackage?.governanceStatus === "review_controlled" ||
                                                        o.auditTrace?.blockedByGuardrail === true).length;

    const evidenceSummary = {
      totalEvaluated:   opportunities.length,
      validCount,
      pendingCount,
      suspendedCount,
      withFourEyesCount:     withFourEyes,
      withGuardrailCount:    withGuardrail,
      evidenceBasis:         "step8_block4",
    };

    // Per-opportunity evidence entries (only those with a non-trivial evidence state)
    const evidenceEntries = opportunities.map((o) => {
      // Re-compute if not already attached (fallback for legacy enrichment paths)
      const ep = o.evidencePackage || computeEvidencePackage(o, governanceCtx).evidencePackage;
      return {
        symbol:                 o.symbol,
        policyVersion:          o.policyVersion          ?? ep.policyVersion,
        policyFingerprint:      o.policyFingerprint      ?? ep.policyFingerprint,
        policyValidity:         o.policyValidity         ?? ep.policyValidity,
        governanceStatus:       ep.governanceStatus,
        traceReason:            ep.traceReason           ?? null,
        reviewSummary:          ep.reviewSummary         ?? null,
        decisionSummary:        ep.decisionSummary       ?? null,
        approvalSummary:        ep.approvalSummary       ?? null,
        actorContext:           ep.actorContext           ?? null,
        policyApprovalHistory:  o.policyApprovalHistory  ?? ep.policyApprovalHistory,
        operatorActionTrace:    o.operatorActionTrace    ?? ep.operatorActionTrace,
      };
    });

    return res.json({
      success:          true,
      generatedAt:      new Date().toISOString(),
      governanceContext: governanceCtx,
      evidenceSummary,
      evidenceEntries,
    });
  } catch (error) {
    logger.error("Admin evidence-packages route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * GET /api/admin/tenant-resource-governance
 * Step 8 Block 5: Read-only admin view of tenant/resource governance state.
 *
 * Surfaces:
 *   - tenant summary (load band distribution, quota warnings)
 *   - backlog pressure aggregate
 *   - quota / load distribution counts
 *   - noisy-neighbor risk at platform level
 *   - resource guardrail / hard-gated counts
 *
 * All derived from existing opportunity layers – no new DB calls.
 *
 * Query params:
 *   ?limit=20  – number of scanner candidates to evaluate (1–50)
 * ───────────────────────────────────────────────────────── */
router.get("/tenant-resource-governance", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 50));
    const opportunities = await getTopOpportunities({ limit });

    // Governance context for the calling admin actor
    const governanceCtx = computeGovernanceContext({ isAdminRoute: true });

    // Aggregate tenant/resource governance summary
    const tenantSummary = computeTenantResourceGovernanceSummary(opportunities);

    // Per-opportunity tenant/resource governance entries (compact)
    const tenantEntries = opportunities.map((o) => {
      const trg = o.tenantResourceGovernance || {};
      return {
        symbol:                   o.symbol,
        tenantId:                 trg.tenantId                 ?? "tenant_default",
        tenantPolicyScope:        trg.tenantPolicyScope        ?? null,
        tenantMaxAutonomyLevel:   trg.tenantMaxAutonomyLevel   ?? null,
        tenantQuotaProfile:       trg.tenantQuotaProfile       ?? null,
        resourceGovernanceStatus: trg.resourceGovernanceStatus ?? null,
        rateLimitRisk:            trg.rateLimitRisk            ?? null,
        noisyNeighborRisk:        trg.noisyNeighborRisk        ?? null,
        quotaUsage:               trg.quotaUsage               ?? null,
        backlogPressure:          trg.backlogPressure          ?? null,
        tenantLoadBand:           trg.tenantLoadBand           ?? null,
        quotaWarning:             trg.quotaWarning             ?? false,
        resourceGuardrail:        trg.resourceGuardrail        ?? null,
      };
    });

    return res.json({
      success:          true,
      generatedAt:      new Date().toISOString(),
      governanceContext: governanceCtx,
      tenantSummary,
      tenantEntries,
    });
  } catch (error) {
    logger.error("Admin tenant-resource-governance route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * GET /api/admin/operational-resilience
 * Step 8 Block 6: Read-only admin view of operational resilience state.
 *
 * Surfaces:
 *   - governance context for the calling admin actor
 *   - aggregate resilience summary (degradation modes, health, pressure level)
 *   - per-opportunity resilience entries (compact)
 *
 * All derived from existing opportunity layers – no new DB calls.
 *
 * Query params:
 *   ?limit=20  – number of scanner candidates to evaluate (1–50)
 * ───────────────────────────────────────────────────────── */
router.get("/operational-resilience", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 50));
    const opportunities = await getTopOpportunities({ limit });

    // Governance context for the calling admin actor
    const governanceCtx = computeGovernanceContext({ isAdminRoute: true });

    // Aggregate operational resilience summary
    const resilienceSummary = computeOperationalResilienceContextSummary(opportunities);

    // Per-opportunity resilience entries (compact)
    const resilienceEntries = opportunities.map((o) => {
      const or_ = o.operationalResilience || {};
      const trg = o.tenantResourceGovernance || {};
      return {
        symbol:               o.symbol,
        degradationMode:      or_.degradationMode      ?? "normal",
        operationalHealth:    or_.operationalHealth    ?? "healthy",
        fallbackTier:         or_.fallbackTier         ?? "full_context",
        recoveryState:        or_.recoveryState        ?? "stable",
        resumeReady:          or_.resumeReady          ?? true,
        resilienceFlags:      or_.resilienceFlags      ?? [],
        systemPressureSummary: or_.systemPressureSummary ?? null,
        // Surface key pressure inputs for admin observability
        tenantLoadBand:       trg.tenantLoadBand       ?? null,
        backlogPressure:      trg.backlogPressure      ?? null,
        rateLimitRisk:        trg.rateLimitRisk        ?? null,
        quotaWarning:         trg.quotaWarning         ?? false,
      };
    });

    return res.json({
      success:           true,
      generatedAt:       new Date().toISOString(),
      governanceContext: governanceCtx,
      resilienceSummary,
      resilienceEntries,
    });
  } catch (error) {
    logger.error("Admin operational-resilience route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * GET /api/admin/autonomy-drift
 * Step 9 Block 1: Read-only admin view of autonomy levels and drift detection.
 *
 * Surfaces:
 *   - governance context for the calling admin actor
 *   - aggregate autonomy-level + drift-detection summary
 *   - per-opportunity autonomy-level and drift entries (compact)
 *
 * All derived from existing opportunity layers – no new DB calls.
 *
 * Query params:
 *   ?limit=20  – number of scanner candidates to evaluate (1–50)
 * ───────────────────────────────────────────────────────── */
router.get("/autonomy-drift", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 50));
    const opportunities = await getTopOpportunities({ limit });

    // Governance context for the calling admin actor
    const governanceCtx = computeGovernanceContext({ isAdminRoute: true });

    // Aggregate autonomy + drift summary
    const autonomyDriftSummary = computeAutonomyDriftSummary(opportunities);

    // Per-opportunity entries (compact)
    const autonomyDriftEntries = opportunities.map((o) => {
      const al = o.autonomyLevel   || {};
      const dd = o.driftDetection  || {};
      return {
        symbol:             o.symbol,
        effectiveLevel:     al.effectiveLevel    ?? "assisted",
        levelLabel:         al.levelLabel        ?? "Assistiert",
        levelCap:           al.levelCap          ?? "supervised",
        escalationRequired: al.escalationRequired ?? false,
        levelBasis:         al.levelBasis        ?? null,
        driftLevel:         dd.driftLevel        ?? "none",
        driftSignalCount:   dd.driftSignalCount  ?? 0,
        metronomDeviation:  dd.metronomDeviation ?? false,
        baselineState:      dd.baselineState     ?? "stable",
        driftSignals:       dd.driftSignals      ?? [],
      };
    });

    return res.json({
      success:              true,
      generatedAt:          new Date().toISOString(),
      governanceContext:    governanceCtx,
      autonomyDriftSummary,
      autonomyDriftEntries,
    });
  } catch (error) {
    logger.error("Admin autonomy-drift route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * GET /api/admin/action-chain-summary
 * Step 9 Block 2: Read-only admin view of action-chain / state-machine status.
 *
 * Surfaces:
 *   - governance context for the calling admin actor
 *   - aggregate action-chain state distribution
 *   - blocked / escalated / conflict-risk counts
 *   - per-opportunity chain state entries (compact)
 *
 * All derived from existing opportunity layers – no new DB calls.
 *
 * Query params:
 *   ?limit=20  – number of scanner candidates to evaluate (1–50)
 * ───────────────────────────────────────────────────────── */
router.get("/action-chain-summary", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 50));
    const opportunities = await getTopOpportunities({ limit });

    // Governance context for the calling admin actor
    const governanceCtx = computeGovernanceContext({ isAdminRoute: true });

    // Aggregate action-chain summary
    const actionChainSummary = computeActionChainSummary(opportunities);

    // Per-opportunity entries (compact)
    const actionChainEntries = opportunities.map((o) => {
      const acs = o.actionChainState || {};
      return {
        symbol:            o.symbol,
        actionChainState:  acs.actionChainState   ?? "idle",
        actionChainLabel:  acs.actionChainLabel   ?? "Inaktiv",
        actionChainStage:  acs.actionChainStage   ?? "no_signal",
        nextChainStep:     acs.nextChainStep      ?? null,
        chainBlocked:      acs.chainBlocked       ?? false,
        chainBlockReason:  acs.chainBlockReason   ?? null,
        escalationPath:    acs.escalationPath     ?? null,
        chainConflictRisk: acs.chainConflictRisk  ?? false,
        chainSafetyMode:   acs.chainSafetyMode   ?? false,
      };
    });

    return res.json({
      success:            true,
      generatedAt:        new Date().toISOString(),
      governanceContext:  governanceCtx,
      actionChainSummary,
      actionChainEntries,
    });
  } catch (error) {
    logger.error("Admin action-chain-summary route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * GET /api/admin/auto-preparation-summary
 * Step 9 Block 3: Read-only admin view of controlled auto-preparation status.
 *
 * Surfaces:
 *   - governance context for the calling admin actor
 *   - aggregate preparation type distribution
 *   - guarded / eligible / manual-confirmation-required counts
 *   - per-opportunity preparation entries (compact)
 *
 * All derived from existing opportunity layers – no new DB calls.
 * No mutations – read-only observability endpoint.
 *
 * Query params:
 *   ?limit=20  – number of scanner candidates to evaluate (1–50)
 * ───────────────────────────────────────────────────────── */
router.get("/auto-preparation-summary", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 50));
    const opportunities = await getTopOpportunities({ limit });

    // Governance context for the calling admin actor
    const governanceCtx = computeGovernanceContext({ isAdminRoute: true });

    // Aggregate auto-preparation summary
    const autoPreparationSummary = computeControlledAutoPreparationSummary(opportunities);

    // Per-opportunity entries (compact)
    const autoPreparationEntries = opportunities.map((o) => {
      const cap = o.controlledAutoPreparation || {};
      return {
        symbol:                    o.symbol,
        autoPreparationEligible:   cap.autoPreparationEligible        ?? false,
        preparationType:           cap.preparationType                ?? "no_auto_prep",
        preparationReason:         cap.preparationReason              ?? null,
        preparationPriority:       cap.preparationPriority            ?? "none",
        preparationGuarded:        cap.preparationGuarded             ?? false,
        preparationWindow:         cap.preparationWindow              ?? null,
        manualConfirmationRequired: cap.manualConfirmationRequired    ?? false,
        preparationSummary:        cap.preparationSummary             ?? null,
      };
    });

    return res.json({
      success:                true,
      generatedAt:            new Date().toISOString(),
      governanceContext:      governanceCtx,
      autoPreparationSummary,
      autoPreparationEntries,
    });
  } catch (error) {
    logger.error("Admin auto-preparation-summary route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * GET /api/admin/auto-execution-summary
 * Step 9 Block 4: Read-only admin view of partial auto-execution status.
 *
 * Surfaces:
 *   - governance context for the calling admin actor
 *   - aggregate execution type distribution
 *   - guarded / blocked / eligible execution counts
 *   - execution safety distribution
 *   - per-opportunity execution entries (compact)
 *
 * All derived from existing opportunity layers – no new DB calls.
 * No mutations – read-only observability endpoint.
 *
 * Query params:
 *   ?limit=20  – number of scanner candidates to evaluate (1–50)
 * ───────────────────────────────────────────────────────── */
router.get("/auto-execution-summary", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 50));
    const opportunities = await getTopOpportunities({ limit });

    // Governance context for the calling admin actor
    const governanceCtx = computeGovernanceContext({ isAdminRoute: true });

    // Aggregate auto-execution summary
    const autoExecutionSummary = computePartialAutoExecutionSummary(opportunities);

    // Per-opportunity entries (compact)
    const autoExecutionEntries = opportunities.map((o) => {
      const pae = o.partialAutoExecution || {};
      return {
        symbol:                o.symbol,
        autoExecutionEligible: pae.autoExecutionEligible  ?? false,
        autoExecutionType:     pae.autoExecutionType      ?? "no_execution",
        autoExecutionReason:   pae.autoExecutionReason    ?? null,
        autoExecutionGuarded:  pae.autoExecutionGuarded   ?? false,
        autoExecutionSafety:   pae.autoExecutionSafety    ?? "none",
        executionIntent:       pae.executionIntent        ?? null,
        executionScope:        pae.executionScope         ?? "none",
        executionSummary:      pae.executionSummary       ?? null,
      };
    });

    return res.json({
      success:              true,
      generatedAt:          new Date().toISOString(),
      governanceContext:    governanceCtx,
      autoExecutionSummary,
      autoExecutionEntries,
    });
  } catch (error) {
    logger.error("Admin auto-execution-summary route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

module.exports = router;
