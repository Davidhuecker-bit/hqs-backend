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
  getAdminTechRadarEntries,
  updateTechRadarEntryStatus,
  VALID_ADMIN_STATUSES,
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
const { getDataFlowHealth } = require("../services/dataFlowHealth.service");
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

// UI Summary – read-only service (DB-first architecture, jobs write)
const {
  readSummary,
  getSummaryStatus,
  listSummaryStatuses,
  getHealthSnapshot,
  SUPPORTED_TYPES,
  BACKOFF_THRESHOLDS,
  FAILING_THRESHOLD,
} = require("../services/uiSummaryRefresh.service");
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
// Step 9 Block 5: Recovery, stop, override & promotion safety layer
// Step 10 Block 2: Attention Management / Delivery Intelligence aggregate
// Step 10 Block 3: Autonomy Preview / Companion Trust Layer aggregate
// Step 10 Block 4: Adaptive UX / Feedback Layer aggregate
const { computeGovernanceContext, computeOperatingConsoleContext, computePolicyPlaneContext, computeEvidencePackage, computeTenantResourceGovernanceSummary, computeOperationalResilienceContextSummary, computeAutonomyDriftSummary, computeActionChainSummary, computeControlledAutoPreparationSummary, computePartialAutoExecutionSummary, computeRecoverySafetyLayerSummary, computeAttentionDeliveryMeta, computeAutonomyPreviewSummary, computeAdaptiveUXSummary } = require("../services/governance.context");
// HQS 2.0 Block 1: Data Quality summary from factor history
// HQS 2.0 Block 2: Sector / Peer-Group Normalization meta from factor history
// HQS 2.0 Block 3: Regime / Stability / Liquidity meta from factor history
// HQS 2.1 Block 4: Explainability, Versioning & Event-Awareness meta from factor history
const { getRecentHqsDataQuality, getRecentHqsSectorMeta, getRecentHqsRegimeMeta, getRecentHqsExplainabilityMeta, getRecentHqsShadowMeta } = require("../services/factorHistory.repository");
const { getServiceDiagnostics } = require("../services/serviceDiagnostics.service");
const { getLearningDiagnostics } = require("../services/learningDiagnostics.service");
const { getAdminDemoPortfolio } = require("../services/adminDemoPortfolio.service");
const { refreshGuardianStatusSummary } = require("../services/guardianStatusSummary.builder");
const { readUiSummary } = require("../services/uiSummary.repository");
const {
  getActiveReferenceSymbols,
  enrichReferencePortfolio,
  upsertReferencePortfolioEntry,
} = require("../services/adminReferencePortfolio.repository");

const router = express.Router();

// Step 8 Block 2: exception priority ordering for exception-hub sort (lower = higher priority)
const EXCEPTION_PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

// ── Admin stack TTL cache ────────────────────────────────────────────────────
// buildAdminStack() is an expensive full DB aggregation (getAdminInsights +
// 3 historical snapshot loads + all engine derivations).  Every admin sub-route
// (/overview, /diagnostics, /validation, …) calls it and only picks one key
// from the result.  Caching the result for ADMIN_STACK_TTL_MS means the heavy
// computation only fires once per window, regardless of how many sub-routes are
// hit in quick succession.
//
// Admin data is diagnostic/observational and tolerate a short lag; 90 s is a
// good balance between freshness and latency reduction.
//
// Read-first design:
//  - Fresh cache  → return immediately (no DB work).
//  - Stale cache  → return stale data immediately, trigger one background
//                   rebuild so the *next* caller gets fresh data (SWR pattern).
//  - No cache     → one inflight promise shared by all concurrent callers;
//                   no stampede even on cold start.
const ADMIN_STACK_TTL_MS = (() => {
  const v = parseInt(process.env.ADMIN_STACK_TTL_MS, 10);
  return Number.isFinite(v) && v > 0 ? v : 90_000;
})();
let _adminStackCache = null;    // { data, ts }
let _adminStackInflight = null; // deduplication for concurrent cold-start callers
let _adminStackBgRunning = false; // guard: only one background SWR refresh at a time

/**
 * Returns a cached admin-stack result if it is still fresh, otherwise builds
 * a new one.  The cache is bypassed when persistSnapshot is requested so that
 * manual snapshot triggers always get a fresh run.
 *
 * Stale-while-revalidate: stale cache is returned immediately; a single
 * background rebuild updates the cache for subsequent callers.
 * Inflight deduplication: concurrent cold-start calls share one promise.
 */
async function buildAdminStack(options = {}) {
  const { persistSnapshot = false } = options;

  // Explicit snapshot persistence: always bypass cache, run fresh.
  if (persistSnapshot) {
    return _runBuildAdminStack(options);
  }

  const now = Date.now();

  // Fresh cache → return immediately.
  if (_adminStackCache && now - _adminStackCache.ts < ADMIN_STACK_TTL_MS) {
    return _adminStackCache.data;
  }

  // Stale cache → return stale data right away; kick off one background refresh.
  if (_adminStackCache && !_adminStackBgRunning) {
    _adminStackBgRunning = true;
    setImmediate(() => {
      _runBuildAdminStack({})
        .catch((err) =>
          logger.warn("buildAdminStack: background SWR refresh failed", { message: err.message })
        )
        .finally(() => {
          _adminStackBgRunning = false;
        });
    });
    return _adminStackCache.data;
  }
  if (_adminStackCache) {
    // Background refresh already running; return stale data without queuing another.
    return _adminStackCache.data;
  }

  // No cache at all (cold start): deduplicate concurrent callers with one shared promise.
  if (_adminStackInflight) {
    return _adminStackInflight;
  }
  const t0 = Date.now();
  _adminStackInflight = _runBuildAdminStack(options)
    .then((result) => {
      logger.info("buildAdminStack: cold build completed", { ms: Date.now() - t0 });
      return result;
    })
    .catch((err) => {
      logger.warn("buildAdminStack: cold build failed", { message: err.message });
      throw err;
    })
    .finally(() => {
      _adminStackInflight = null;
    });
  return _adminStackInflight;
}

function createAdminState({ insights, diagnostics, validation, tuning }) {
  return {
    insights: insights || {},
    diagnostics: diagnostics || {},
    validation: validation || {},
    tuning: tuning || {},
  };
}

async function _runBuildAdminStack(options = {}) {
  const { persistSnapshot = false } = options;
  const t0 = Date.now();

  // Load insights and maturitySummary in parallel – both are DB reads
  // that are independent of each other.  maturitySummary is needed already
  // by buildAdminDiagnostics so that detectBottlenecks() can produce
  // maturity-aware bottleneck titles instead of hard-coded fallbacks.
  let insights;
  let maturitySummary = null;

  const [insightsResult, maturityStored] = await Promise.allSettled([
    getAdminInsights(),
    readUiSummary("maturity_summary"),
  ]);

  if (insightsResult.status === "fulfilled") {
    insights = insightsResult.value;
  } else {
    const err = insightsResult.reason;
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

  if (maturityStored.status === "fulfilled") {
    maturitySummary = maturityStored.value?.payload || null;
  } else {
    logger.warn("buildAdminStack: maturitySummary load failed", { message: maturityStored.reason?.message });
  }

  function safeEngine(name, fn, fallback = {}) {
    try {
      return fn();
    } catch (err) {
      logger.warn(`buildAdminStack: ${name} failed`, { message: err.message });
      return fallback;
    }
  }

  const diagnostics = safeEngine("buildAdminDiagnostics", () => buildAdminDiagnostics(insights, maturitySummary));
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
    maturitySummary,
  }));

  const priorities = safeEngine("buildAdminPriorities", () => buildAdminPriorities({
    insights,
    diagnostics,
    validation,
    tuning,
    alerts,
    maturitySummary,
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
    maturitySummary,
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

  const result = {
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

  // Store in cache so the next non-persist call gets the freshly built result.
  _adminStackCache = { data: result, ts: Date.now() };
  const elapsedMs = Date.now() - t0;
  if (elapsedMs > 3000) {
    logger.warn("buildAdminStack: slow build detected", { ms: elapsedMs });
  } else {
    logger.info("buildAdminStack: build completed", { ms: elapsedMs });
  }

  return result;
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

/**
 * GET /api/admin/tech-radar-admin
 * Extended Tech-Radar admin endpoint with HQS relevance assessment and
 * advanced filters.
 * Query params:
 *   limit          (number, 1-200, default 50)
 *   category       (string)
 *   status         (string: 'neu' | 'beobachten' | 'prüfen' | 'testen' | 'übernehmen' | 'verworfen')
 *   fitForHQS      (string: 'yes' | 'maybe' | 'no')
 *   hasLink        (boolean string: 'true' | 'false')
 *   isNew          (boolean string: 'true')
 *   unreviewed     (boolean string: 'true')
 *   adoptionTiming (string: 'sofort' | 'kurzfristig' | 'mittelfristig' | 'langfristig' | 'beobachten')
 *   relevance      (string: 'high' | 'medium' | 'low')
 *   strategicFit   (string: 'high' | 'medium' | 'low')
 *   timeHorizon    (string: 'now' | 'mid' | 'later')
 *   decisionHint   (string: 'watch' | 'evaluate' | 'test' | 'adopt' | 'reject')
 *   stackFit       (string: 'good' | 'mixed' | 'weak')
 */
router.get("/tech-radar-admin", async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const category = req.query.category || null;
    const status = req.query.status || null;
    const fitForHQS = req.query.fitForHQS || null;
    const hasLink = req.query.hasLink === "true" ? true : req.query.hasLink === "false" ? false : null;
    const isNew = req.query.isNew === "true" ? true : null;
    const unreviewed = req.query.unreviewed === "true" ? true : null;
    const adoptionTiming = req.query.adoptionTiming || null;
    const relevance = req.query.relevance || null;
    const strategicFit = req.query.strategicFit || null;
    const timeHorizon = req.query.timeHorizon || null;
    const decisionHint = req.query.decisionHint || null;
    const stackFit = req.query.stackFit || null;

    const result = await getAdminTechRadarEntries({
      limit, category, status, fitForHQS, hasLink, isNew, unreviewed,
      adoptionTiming, relevance, strategicFit, timeHorizon, decisionHint, stackFit,
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    logger.error("Admin tech-radar-admin route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PATCH /api/admin/tech-radar-admin/:id/status
 * Update the status of a Tech-Radar entry.
 * Body: { status: string, rejectionReason?: string }
 */
router.patch("/tech-radar-admin/:id/status", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, error: "id must be a positive integer" });
    }

    const VALID_STATUSES = VALID_ADMIN_STATUSES;
    const status = req.body?.status;
    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `status must be one of: ${VALID_STATUSES.join(", ")}`,
      });
    }

    const rejectionReason = status === "verworfen" ? (req.body?.rejectionReason || null) : null;
    const updated = await updateTechRadarEntryStatus(id, status, rejectionReason);
    return res.json({ success: true, entry: updated });
  } catch (error) {
    if (error.message?.includes("not found")) {
      return res.status(404).json({ success: false, error: error.message });
    }
    logger.error("Admin tech-radar-admin status update error", { message: error.message });
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
    // ── Merge runtime stages + all persisted stages ─────────────────────────
    // The old code only exposed 5 hardcoded stages. Now we expose every stage
    // that appears either in the runtime data or in the DB-persisted rows.
    const ALL_KNOWN_STAGES = [
      "universe", "snapshot", "advancedMetrics", "hqsScoring", "outcome",
      "market_news_refresh", "universe_refresh", "build_entity_map",
      "daily_briefing", "summary_refresh",
      "forecast_verification", "causal_memory", "tech_radar",
      "news_lifecycle_cleanup", "discovery_notify", "data_cleanup",
    ];
    const seenStages = new Set([
      ...ALL_KNOWN_STAGES,
      ...Object.keys(raw?.stages ?? {}),
    ]);
    const status = { stages: {} };
    for (const stage of seenStages) {
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
   DATA FLOW HEALTH
   GET /api/admin/data-flow-health
   Comprehensive view of all critical data-flow chains.
   For each chain: lastWriteAt, rowCount, rowCount24h, freshnessLabel,
   ageHours, writtenBy, readBy.
   Chains: market, portfolio, guardian, world_state, news, pipeline,
           universe, forecasts.
========================================================= */

router.get("/data-flow-health", async (_req, res) => {
  try {
    const report = await getDataFlowHealth();
    return res.json({ success: true, ...report });
  } catch (error) {
    logger.error("Admin data-flow-health route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
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
   Read-only from ui_summaries – written by job:ui-demo-portfolio
========================================================= */

router.get("/demo-portfolio", async (req, res) => {
  try {
    const result = await readSummary("demo_portfolio");
    if (result.payload) {
      const payload = result.payload;
      return res.json({
        ...payload,
        freshnessMetadata: {
          source:      "ui_summary",
          builtAt:     result.builtAt,
          freshness:   result.freshnessLabel,
          dataAge:     result.ageMs != null ? Math.round(result.ageMs / 1000) : null,
          isPartial:   result.isPartial,
          rebuilding:  false,
          writer:      result.writer,
        },
      });
    }

    // ui_summaries not yet written by job – fall back to live build from DB tables
    logger.warn("Admin demo-portfolio: ui_summary empty, falling back to live build");
    const livePayload = await getAdminDemoPortfolio();
    return res.json({
      ...livePayload,
      freshnessMetadata: {
        source:    "live_build",
        builtAt:   livePayload.generatedAt ?? new Date().toISOString(),
        freshness: "live",
        dataAge:   0,
        isPartial: livePayload.dataStatus === "missing" || livePayload.dataStatus === "error",
        rebuilding: false,
        writer:    "adminDemoPortfolio.service (on-demand fallback)",
      },
    });
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

/* ─────────────────────────────────────────────────────────────────────────
 * GET /api/admin/recovery-safety-summary
 * Step 9 Block 5: Read-only admin view of recovery/stop/override/promotion-safety status.
 *
 * Surfaces:
 *   - governance context for the calling admin actor
 *   - aggregate safety counts (stop, degrade, promotion blocked, operator
 *     intervention, resume allowed, rollback suggested, override allowed)
 *   - kill-switch scope distribution
 *   - per-opportunity safety entries (compact)
 *
 * All derived from existing opportunity layers – no new DB calls.
 * No mutations – read-only observability endpoint.
 *
 * Query params:
 *   ?limit=20  – number of scanner candidates to evaluate (1–50)
 * ───────────────────────────────────────────────────────── */
router.get("/recovery-safety-summary", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 50));
    const opportunities = await getTopOpportunities({ limit });

    // Governance context for the calling admin actor
    const governanceCtx = computeGovernanceContext({ isAdminRoute: true });

    // Aggregate recovery-safety summary
    const recoverySafetySummary = computeRecoverySafetyLayerSummary(opportunities);

    // Per-opportunity entries (compact)
    const recoverySafetyEntries = opportunities.map((o) => {
      const rsl = o.recoverySafetyLayer || {};
      return {
        symbol:                        o.symbol,
        stopEligible:                  rsl.stopEligible                 ?? false,
        overrideAllowed:               rsl.overrideAllowed              ?? false,
        killSwitchScope:               rsl.killSwitchScope              ?? "none",
        recoveryAction:                rsl.recoveryAction               ?? null,
        rollbackSuggested:             rsl.rollbackSuggested            ?? false,
        promotionBlocked:              rsl.promotionBlocked             ?? false,
        degradeRequired:               rsl.degradeRequired              ?? false,
        resumeAllowed:                 rsl.resumeAllowed                ?? false,
        operatorInterventionRequired:  rsl.operatorInterventionRequired ?? false,
        safetyControlSummary:          rsl.safetyControlSummary        ?? null,
      };
    });

    return res.json({
      success:               true,
      generatedAt:           new Date().toISOString(),
      governanceContext:     governanceCtx,
      recoverySafetySummary,
      recoverySafetyEntries,
    });
  } catch (error) {
    logger.error("Admin recovery-safety-summary route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * GET /api/admin/hqs-data-quality
 * HQS 2.0 Block 1: Read-only meta view of Data Quality, Confidence &
 * Imputation status across recent HQS score snapshots.
 *
 * Surfaces:
 *   - governance context for the calling admin actor
 *   - aggregate summary: avg confidence, imputation rate, stale flags
 *   - per-symbol compact entries with version + quality meta
 *
 * All derived from factor_history table – no new DB calls beyond that.
 * No mutations – read-only observability endpoint.
 *
 * Query params:
 *   ?limit=50  – number of recent snapshots to evaluate (1–200)
 * ───────────────────────────────────────────────────────── */
router.get("/hqs-data-quality", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
    const rows = await getRecentHqsDataQuality(limit);

    // Governance context for the calling admin actor
    const governanceCtx = computeGovernanceContext({ isAdminRoute: true });

    // Aggregate summary
    const total = rows.length;
    let confidenceSum = 0;
    let confidenceCount = 0;
    let imputedCount = 0;
    let staleCount = 0;
    let missingFundamentalsCount = 0;
    let hqsVersions = new Set();

    for (const row of rows) {
      if (row.hqsVersion) hqsVersions.add(row.hqsVersion);

      if (row.confidenceScore != null) {
        confidenceSum += Number(row.confidenceScore);
        confidenceCount++;
      }

      const dqm = row.dataQualityMeta || {};
      const imp = row.imputationMeta || {};

      const dqFlags = Array.isArray(dqm.dataQualityFlags) ? dqm.dataQualityFlags : [];
      const impFlags = Array.isArray(imp.imputationFlags) ? imp.imputationFlags : [];
      const freshFlags = Array.isArray(dqm.freshnessFlags) ? dqm.freshnessFlags : [];

      if (impFlags.length > 0)                          imputedCount++;
      if (freshFlags.length > 0)                        staleCount++;
      if (dqFlags.includes("missing_fundamentals"))     missingFundamentalsCount++;
    }

    const avgConfidence = confidenceCount > 0
      ? Math.round(confidenceSum / confidenceCount)
      : null;

    const summary = {
      total,
      avgConfidence,
      imputedCount,
      imputationRate: total > 0 ? Math.round((imputedCount / total) * 100) : 0,
      staleCount,
      staleRate: total > 0 ? Math.round((staleCount / total) * 100) : 0,
      missingFundamentalsCount,
      hqsVersions: Array.from(hqsVersions),
    };

    // Compact per-entry view
    const entries = rows.map((row) => {
      const dqm = row.dataQualityMeta || {};
      const imp = row.imputationMeta || {};
      return {
        symbol:           row.symbol,
        hqsScore:         row.hqsScore,
        regime:           row.regime,
        hqsVersion:       row.hqsVersion ?? null,
        confidenceScore:  row.confidenceScore ?? null,
        dataQualityFlags: dqm.dataQualityFlags || [],
        imputationFlags:  imp.imputationFlags  || [],
        freshnessFlags:   dqm.freshnessFlags   || [],
        confidenceReason: dqm.confidenceReason   ?? null,
        createdAt:        row.createdAt,
      };
    });

    return res.json({
      success:          true,
      generatedAt:      new Date().toISOString(),
      governanceContext: governanceCtx,
      summary,
      entries,
    });
  } catch (error) {
    logger.error("Admin hqs-data-quality route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * GET /api/admin/hqs-sector-meta
 * HQS 2.0 Block 2: Read-only sector template & peer-group normalization view.
 *
 * Surfaces:
 *   - sector template distribution across recent HQS score snapshots
 *   - peer context availability rate
 *   - normalization summary per template
 *   - per-entry sector scoring meta
 *
 * All derived from factor_history table – no mutations.
 *
 * Query params:
 *   ?limit=50  – number of recent snapshots to evaluate (1–200)
 * ───────────────────────────────────────────────────────── */
router.get("/hqs-sector-meta", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
    const rows = await getRecentHqsSectorMeta(limit);

    // Governance context for the calling admin actor
    const governanceCtx = computeGovernanceContext({ isAdminRoute: true });

    const total = rows.length;
    const templateCounts = {};
    let peerContextCount = 0;

    for (const row of rows) {
      const tmpl = row.sectorTemplate || "unknown";
      templateCounts[tmpl] = (templateCounts[tmpl] || 0) + 1;
      if (row.peerContextAvailable === true) peerContextCount++;
    }

    const templateDistribution = Object.entries(templateCounts).map(([template, count]) => ({
      template,
      count,
      pct: total > 0 ? Math.round((count / total) * 100) : 0,
    })).sort((a, b) => b.count - a.count);

    const summary = {
      total,
      templateDistribution,
      peerContextCount,
      peerContextRate: total > 0 ? Math.round((peerContextCount / total) * 100) : 0,
    };

    const entries = rows.map((row) => {
      const ssm = row.sectorScoringMeta || {};
      return {
        symbol:               row.symbol,
        hqsScore:             row.hqsScore,
        regime:               row.regime,
        hqsVersion:           row.hqsVersion ?? null,
        sectorTemplate:       row.sectorTemplate ?? null,
        sectorLabel:          ssm.sectorLabel ?? null,
        sectorScoringFlags:   ssm.sectorScoringFlags ?? [],
        peerContextAvailable: row.peerContextAvailable ?? null,
        normalizationMeta:    ssm.normalizationMeta ?? null,
        sectorReason:         ssm.sectorReason ?? null,
        baseQuality:          ssm.baseQuality ?? null,
        appliedAdjustments:   ssm.appliedAdjustments ?? [],
        createdAt:            row.createdAt,
      };
    });

    return res.json({
      success:           true,
      generatedAt:       new Date().toISOString(),
      governanceContext: governanceCtx,
      summary,
      entries,
    });
  } catch (error) {
    logger.error("Admin hqs-sector-meta route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * GET /api/admin/hqs-regime-meta
 * HQS 2.0 Block 3: Read-only regime weighting, enhanced stability &
 * liquidity guardrail view.
 *
 * Surfaces:
 *   - regime distribution across recent HQS score snapshots
 *   - average liquidity tier distribution
 *   - slippage risk summary
 *   - enhanced stability band distribution
 *   - per-entry Block 3 meta
 *
 * All derived from factor_history table – no mutations.
 *
 * Query params:
 *   ?limit=50  – number of recent snapshots to evaluate (1–200)
 * ───────────────────────────────────────────────────────── */
router.get("/hqs-regime-meta", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
    const rows = await getRecentHqsRegimeMeta(limit);

    const governanceCtx = computeGovernanceContext({ isAdminRoute: true });

    const total = rows.length;
    const regimeCounts = {};
    const liquidityTierCounts = {};
    const slippageRiskCounts = {};
    const stabilityBandCounts = {};
    let totalLiquidityPenalty = 0;
    let penaltyCount = 0;

    for (const row of rows) {
      const regime = row.regime || "unknown";
      regimeCounts[regime] = (regimeCounts[regime] || 0) + 1;

      const lm = row.liquidityMeta || {};
      const tier = lm.liquidityTier || "unknown";
      liquidityTierCounts[tier] = (liquidityTierCounts[tier] || 0) + 1;

      const sr = lm.slippageRisk || "unknown";
      slippageRiskCounts[sr] = (slippageRiskCounts[sr] || 0) + 1;

      if (lm.liquidityPenalty != null) {
        totalLiquidityPenalty += Number(lm.liquidityPenalty) || 0;
        penaltyCount++;
      }

      const esm = row.enhancedStabilityMeta || {};
      const band = esm.stabilityBand || "unknown";
      stabilityBandCounts[band] = (stabilityBandCounts[band] || 0) + 1;
    }

    const toDistribution = (counts) =>
      Object.entries(counts)
        .map(([label, count]) => ({
          label,
          count,
          pct: total > 0 ? Math.round((count / total) * 100) : 0,
        }))
        .sort((a, b) => b.count - a.count);

    const summary = {
      total,
      regimeDistribution:       toDistribution(regimeCounts),
      liquidityTierDistribution: toDistribution(liquidityTierCounts),
      slippageRiskDistribution:  toDistribution(slippageRiskCounts),
      stabilityBandDistribution: toDistribution(stabilityBandCounts),
      avgLiquidityPenalty: penaltyCount > 0
        ? Math.round((totalLiquidityPenalty / penaltyCount) * 10) / 10
        : 0,
    };

    const entries = rows.map((row) => {
      const rwp = row.regimeWeightProfile || {};
      const esm = row.enhancedStabilityMeta || {};
      const lm  = row.liquidityMeta || {};
      return {
        symbol:               row.symbol,
        hqsScore:             row.hqsScore,
        regime:               row.regime,
        hqsVersion:           row.hqsVersion ?? null,
        regimeWeightProfile:  Object.keys(rwp).length > 0 ? rwp : null,
        stabilityBand:        esm.stabilityBand ?? null,
        volatilityProxy:      esm.volatilityProxy ?? null,
        drawdownProxy:        esm.drawdownProxy ?? null,
        gapStress:            esm.gapStress ?? null,
        priceConsistency:     esm.priceConsistency ?? null,
        stabilityReasons:     esm.stabilityReasons ?? [],
        liquidityTier:        lm.liquidityTier ?? null,
        slippageRisk:         lm.slippageRisk ?? null,
        liquidityPenalty:     lm.liquidityPenalty ?? null,
        liquidityReason:      lm.liquidityReason ?? null,
        createdAt:            row.createdAt,
      };
    });

    return res.json({
      success:           true,
      generatedAt:       new Date().toISOString(),
      governanceContext: governanceCtx,
      summary,
      entries,
    });
  } catch (error) {
    logger.error("Admin hqs-regime-meta route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * GET /api/admin/hqs-explainability-meta
 * HQS 2.1 Block 4: Read-only explainable tags, version & event-awareness view.
 *
 * Surfaces:
 *   - explainable tag distribution across recent HQS snapshots
 *   - hqs version summary
 *   - event awareness distribution (nominal / event_caution / event_high_caution)
 *   - event risk flag frequency
 *   - per-entry Block 4 meta
 *
 * All derived from factor_history table – no mutations.
 *
 * Query params:
 *   ?limit=50  – number of recent snapshots to evaluate (1–200)
 * ───────────────────────────────────────────────────────── */
router.get("/hqs-explainability-meta", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
    const rows = await getRecentHqsExplainabilityMeta(limit);

    const governanceCtx = computeGovernanceContext({ isAdminRoute: true });

    const total = rows.length;
    const tagCounts = {};
    const versionCounts = {};
    const eventAwarenessCounts = {};
    const eventRiskFlagCounts = {};

    for (const row of rows) {
      // ── Tag distribution ────────────────────────────────────────────────
      const tags = Array.isArray(row.explainableTags) ? row.explainableTags : [];
      for (const tag of tags) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }

      // ── Version distribution ────────────────────────────────────────────
      const version = row.hqsVersion || "unknown";
      versionCounts[version] = (versionCounts[version] || 0) + 1;

      // ── Event awareness distribution ────────────────────────────────────
      const eam = row.eventAwarenessMeta || {};
      const awareness = eam.eventAwareness || "unknown";
      eventAwarenessCounts[awareness] = (eventAwarenessCounts[awareness] || 0) + 1;

      // ── Event risk flag frequency ───────────────────────────────────────
      const flags = Array.isArray(eam.eventRiskFlags) ? eam.eventRiskFlags : [];
      for (const flag of flags) {
        eventRiskFlagCounts[flag] = (eventRiskFlagCounts[flag] || 0) + 1;
      }
    }

    const toDistribution = (counts) =>
      Object.entries(counts)
        .map(([label, count]) => ({
          label,
          count,
          pct: total > 0 ? Math.round((count / total) * 100) : 0,
        }))
        .sort((a, b) => b.count - a.count);

    const summary = {
      total,
      tagDistribution:          toDistribution(tagCounts),
      versionDistribution:      toDistribution(versionCounts),
      eventAwarenessDistribution: toDistribution(eventAwarenessCounts),
      eventRiskFlagDistribution: toDistribution(eventRiskFlagCounts),
    };

    const entries = rows.map((row) => {
      const eam = row.eventAwarenessMeta || {};
      return {
        symbol:             row.symbol,
        hqsScore:           row.hqsScore,
        regime:             row.regime,
        hqsVersion:         row.hqsVersion ?? null,
        versionReason:      row.versionReason ?? null,
        explainableTags:    Array.isArray(row.explainableTags) ? row.explainableTags : [],
        eventAwareness:     eam.eventAwareness ?? null,
        eventRiskFlags:     Array.isArray(eam.eventRiskFlags) ? eam.eventRiskFlags : [],
        eventConfidenceImpact: eam.eventConfidenceImpact ?? null,
        eventSource:        eam.eventSource ?? null,
        createdAt:          row.createdAt,
      };
    });

    return res.json({
      success:           true,
      generatedAt:       new Date().toISOString(),
      governanceContext: governanceCtx,
      summary,
      entries,
    });
  } catch (error) {
    logger.error("Admin hqs-explainability-meta route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

/* =========================================================
   HQS 2.2 BLOCK 5: SHADOW-HQS META (read-only)
   GET /api/admin/hqs-shadow-meta
   Returns model distribution, shadow availability, average
   shadow delta and point-in-time readiness summary.
========================================================= */
router.get("/hqs-shadow-meta", async (req, res) => {
  try {
    const governanceCtx = computeGovernanceContext(req);
    const limit = Math.min(Number(req.query.limit) || 100, 500);

    const rows = await getRecentHqsShadowMeta(limit);
    const total = rows.length;

    const modelCounts      = {};
    const shadowDeltaSum   = { sum: 0, count: 0 };
    let   shadowAvailable  = 0;
    let   pitReady         = 0;
    let   pitSnapshotBased = 0;
    const deltaDirectionCounts = {};

    for (const row of rows) {
      // ── Model distribution ─────────────────────────────────────────
      const modelId = row.scoringModelId || "unknown";
      modelCounts[modelId] = (modelCounts[modelId] || 0) + 1;

      // ── Shadow availability ────────────────────────────────────────
      if (row.shadowHqsScore != null) {
        shadowAvailable++;
        if (row.shadowDelta != null) {
          shadowDeltaSum.sum   += Number(row.shadowDelta);
          shadowDeltaSum.count += 1;
        }
      }

      // ── Comparison meta: delta direction distribution ──────────────
      const cm = row.comparisonMeta || {};
      if (cm.deltaDirection) {
        deltaDirectionCounts[cm.deltaDirection] = (deltaDirectionCounts[cm.deltaDirection] || 0) + 1;
      }

      // ── Point-in-time readiness ────────────────────────────────────
      const pit = row.pointInTimeContext || {};
      if (pit.modelTimestamp) {
        pitReady++;
      }
      if (pit.usesOnlySnapshotInputs === true) {
        pitSnapshotBased++;
      }
    }

    const avgShadowDelta =
      shadowDeltaSum.count > 0
        ? Math.round((shadowDeltaSum.sum / shadowDeltaSum.count) * 100) / 100
        : null;

    const toDistribution = (counts) =>
      Object.entries(counts)
        .map(([label, count]) => ({
          label,
          count,
          pct: total > 0 ? Math.round((count / total) * 100) : 0,
        }))
        .sort((a, b) => b.count - a.count);

    const summary = {
      total,
      modelDistribution:       toDistribution(modelCounts),
      shadowAvailableCount:    shadowAvailable,
      shadowAvailablePct:      total > 0 ? Math.round((shadowAvailable / total) * 100) : 0,
      avgShadowDelta,
      deltaDirectionDistribution: toDistribution(deltaDirectionCounts),
      pointInTimeReadiness: {
        pitReadyCount:       pitReady,
        pitReadyPct:         total > 0 ? Math.round((pitReady / total) * 100) : 0,
        snapshotBasedCount:  pitSnapshotBased,
        snapshotBasedPct:    total > 0 ? Math.round((pitSnapshotBased / total) * 100) : 0,
      },
    };

    const entries = rows.map((row) => ({
      symbol:             row.symbol,
      hqsScore:           row.hqsScore,
      regime:             row.regime,
      hqsVersion:         row.hqsVersion ?? null,
      scoringModelId:     row.scoringModelId ?? null,
      shadowHqsScore:     row.shadowHqsScore ?? null,
      shadowDelta:        row.shadowDelta ?? null,
      comparisonMeta:     row.comparisonMeta ?? null,
      pointInTimeContext: row.pointInTimeContext ?? null,
      createdAt:          row.createdAt,
    }));

    return res.json({
      success:           true,
      generatedAt:       new Date().toISOString(),
      governanceContext: governanceCtx,
      summary,
      entries,
    });
  } catch (error) {
    logger.error("Admin hqs-shadow-meta route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

/* =========================================================
   STEP 10 BLOCK 1: COMPANION OUTPUT META (read-only)
   GET /api/admin/companion-meta
   Returns clarity mode distribution, companion status summary,
   and output reason tags across recent HQS explainability data.
========================================================= */
router.get("/companion-meta", async (req, res) => {
  try {
    const governanceCtx = computeGovernanceContext(req);
    const limit = Math.min(Number(req.query.limit) || 100, 500);

    const rows = await getRecentHqsExplainabilityMeta(limit);
    const total = rows.length;

    // ── Tag distribution (from explainableTags) ───────────────────────────
    const tagCounts = {};
    const COMPANION_TAG_LABELS = {
      quality_leader:     "Qualitätsführer im Sektor",
      stable_uptrend:     "stabiler Aufwärtstrend",
      regime_tailwind:    "Marktlage unterstützt das Signal",
      regime_headwind:    "Marktlage belastet das Signal",
      liquidity_watch:    "Liquidität wird beobachtet",
      low_confidence:     "Datenlage noch unsicher",
      sector_adjusted:    "sektorbereinigt bewertet",
      event_caution:      "kurzfristig erhöhte Unsicherheit",
      elevated_volatility:"erhöhte Schwankungsbreite",
      data_imputed:       "Datenlücken wurden geschlossen",
    };
    for (const row of rows) {
      const tags = Array.isArray(row.explainableTags) ? row.explainableTags : [];
      for (const tag of tags) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }

    // ── Companion status distribution (derived from HQS scores) ──────────
    let highSignalCount    = 0;
    let neutralSignalCount = 0;
    let weakSignalCount    = 0;
    let lowConfidenceCount = 0;
    let eventCautionCount  = 0;

    for (const row of rows) {
      const score = Number(row.hqsScore) || 50;
      const tags  = Array.isArray(row.explainableTags) ? row.explainableTags : [];
      if (tags.includes("low_confidence"))     lowConfidenceCount++;
      if (tags.includes("event_caution"))      eventCautionCount++;
      if (score >= 70)                         highSignalCount++;
      else if (score >= 50)                    neutralSignalCount++;
      else                                     weakSignalCount++;
    }

    // ── Plain-language reason tag summary ────────────────────────────────
    const reasonTagSummary = Object.entries(tagCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([tag, count]) => ({
        tag,
        plainLabel: COMPANION_TAG_LABELS[tag] ?? tag,
        count,
        pct: total > 0 ? Math.round((count / total) * 100) : 0,
      }));

    const summary = {
      total,
      // Companion status distribution across scored stocks
      companionStatusDistribution: {
        highSignal:    highSignalCount,
        neutralSignal: neutralSignalCount,
        weakSignal:    weakSignalCount,
        highSignalPct:    total > 0 ? Math.round((highSignalCount    / total) * 100) : 0,
        neutralSignalPct: total > 0 ? Math.round((neutralSignalCount / total) * 100) : 0,
        weakSignalPct:    total > 0 ? Math.round((weakSignalCount    / total) * 100) : 0,
      },
      // Clarity signal distribution
      claritySignals: {
        lowConfidenceCount,
        eventCautionCount,
        lowConfidencePct: total > 0 ? Math.round((lowConfidenceCount / total) * 100) : 0,
        eventCautionPct:  total > 0 ? Math.round((eventCautionCount  / total) * 100) : 0,
      },
      // Top plain-language output reason tags
      reasonTagSummary,
      companionBasis: "step10_block1",
    };

    const entries = rows.map((row) => ({
      symbol:          row.symbol,
      hqsScore:        row.hqsScore,
      hqsVersion:      row.hqsVersion ?? null,
      explainableTags: row.explainableTags ?? [],
      plainReasonTags: (row.explainableTags ?? [])
        .map((t) => COMPANION_TAG_LABELS[t])
        .filter(Boolean),
      createdAt:       row.createdAt,
    }));

    return res.json({
      success:           true,
      generatedAt:       new Date().toISOString(),
      governanceContext: governanceCtx,
      summary,
      entries,
    });
  } catch (error) {
    logger.error("Admin companion-meta route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

// ── Step 10 Block 2: Attention Management / Delivery Intelligence meta ────────
// Read-only endpoint: delivers interrupt vs briefing vs bundle vs silent distribution
// and attention summary tags. No execution, no write, defensive defaults.
//
// GET /api/admin/attention-delivery-meta
router.get("/attention-delivery-meta", async (req, res) => {
  try {
    const governanceCtx = computeGovernanceContext({ role: req.user?.role, tenantScope: req.user?.tenantScope });

    // Fetch top opportunities (re-uses existing pipeline, same as other admin meta endpoints).
    let opps = [];
    try {
      opps = await getTopOpportunities({ limit: 50, userId: null, actorRole: "viewer" });
    } catch (oppErr) {
      logger.warn("Admin attention-delivery-meta: getTopOpportunities failed (ignored)", { message: oppErr.message });
    }

    // Aggregate attention/delivery meta from opportunity signals.
    const summary = computeAttentionDeliveryMeta(opps);

    // Build per-opportunity delivery reason tags for admin visibility.
    const entries = opps.slice(0, 30).map((o) => {
      const ado = o.attentionDeliveryOutput ?? null;
      return {
        symbol:          o.symbol ?? null,
        deliveryMode:    ado?.deliveryMode    ?? "monitor_silently",
        deliveryUrgency: ado?.deliveryUrgency ?? null,
        shouldInterrupt: ado?.shouldInterrupt ?? false,
        bundleCandidate: ado?.bundleCandidate ?? false,
        quietMode:       ado?.quietModeRecommended ?? true,
        attentionReason: ado?.deliveryReason  ?? null,
        attentionSummary: ado?.attentionSummary ?? null,
      };
    });

    return res.json({
      success:           true,
      generatedAt:       new Date().toISOString(),
      governanceContext: governanceCtx,
      summary,
      entries,
    });
  } catch (error) {
    logger.error("Admin attention-delivery-meta route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

// ── Step 10 Block 3: Autonomy Preview / Companion Trust Layer meta ─────────────
// Read-only endpoint: delivers autonomy-state distribution, confidence-band summary
// and confirmation/stop counts for admin observability.
// No execution, no write, defensive defaults.
//
// GET /api/admin/autonomy-preview-meta
router.get("/autonomy-preview-meta", async (req, res) => {
  try {
    const governanceCtx = computeGovernanceContext({ role: req.user?.role, tenantScope: req.user?.tenantScope });

    // Fetch top opportunities (re-uses existing pipeline, same as other admin meta endpoints).
    let opps = [];
    try {
      opps = await getTopOpportunities({ limit: 50, userId: null, actorRole: "viewer" });
    } catch (oppErr) {
      logger.warn("Admin autonomy-preview-meta: getTopOpportunities failed (ignored)", { message: oppErr.message });
    }

    // Aggregate autonomy-preview / trust meta from opportunity signals.
    const summary = computeAutonomyPreviewSummary(opps);

    // Build per-opportunity autonomy-state entries for admin visibility.
    const entries = opps.slice(0, 30).map((o) => {
      const apv = o.autonomyPreview ?? null;
      return {
        symbol:                o.symbol ?? null,
        autonomyState:         apv?.autonomyState         ?? "suggestion",
        autonomyPreview:       apv?.autonomyPreview       ?? "Vorschlag",
        confidenceBand:        apv?.confidenceBand        ?? null,
        autonomyConfidence:    apv?.autonomyConfidence    ?? null,
        trustReason:           apv?.trustReason           ?? null,
        stopAvailable:         apv?.stopAvailable         ?? false,
        needsUserConfirmation: apv?.needsUserConfirmation ?? false,
        previewSummary:        apv?.previewSummary        ?? null,
      };
    });

    return res.json({
      success:           true,
      generatedAt:       new Date().toISOString(),
      governanceContext: governanceCtx,
      summary,
      entries,
    });
  } catch (error) {
    logger.error("Admin autonomy-preview-meta route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

// ── Step 10 Block 4: Adaptive UX / Feedback Layer meta ─────────────────────────
// Read-only endpoint: delivers style-profile distribution, density/tone/fit summary
// and feedback signal counts for admin observability.
// No execution, no write, defensive defaults.
//
// GET /api/admin/adaptive-ux-meta
router.get("/adaptive-ux-meta", async (req, res) => {
  try {
    const governanceCtx = computeGovernanceContext({ role: req.user?.role, tenantScope: req.user?.tenantScope });

    // Fetch top opportunities (re-uses existing pipeline, same as other admin meta endpoints).
    let opps = [];
    try {
      opps = await getTopOpportunities({ limit: 50, userId: null, actorRole: "viewer" });
    } catch (oppErr) {
      logger.warn("Admin adaptive-ux-meta: getTopOpportunities failed (ignored)", { message: oppErr.message });
    }

    // Aggregate adaptive UX / feedback meta from opportunity signals.
    const summary = computeAdaptiveUXSummary(opps);

    // Build per-opportunity adaptive UX entries for admin visibility.
    const entries = opps.slice(0, 30).map((o) => {
      const aux = o.adaptiveUXOutput ?? null;
      return {
        symbol:              o.symbol ?? null,
        styleProfile:        aux?.styleProfile        ?? "analyst",
        communicationDensity: aux?.communicationDensity ?? "medium",
        adaptiveTone:        aux?.adaptiveTone        ?? "neutral",
        outputFit:           aux?.outputFit           ?? "standard",
        adaptationReason:    aux?.adaptationReason    ?? null,
        userPreferenceHint:  aux?.userPreferenceHint  ?? null,
        adaptiveUXSummary:   aux?.adaptiveUXSummary   ?? null,
        feedbackSignal:      aux?.feedbackSignal       ?? null,
      };
    });

    return res.json({
      success:           true,
      generatedAt:       new Date().toISOString(),
      governanceContext: governanceCtx,
      summary,
      entries,
    });
  } catch (error) {
    logger.error("Admin adaptive-ux-meta route error", { message: error.message });
    return res.status(500).json({ success: false, dataStatus: "error", error: error.message });
  }
});

/* =========================================================
   STEP 4 + STEP 5 – UI SUMMARY REFRESH ORCHESTRATION ADMIN ENDPOINTS
   (replaces Step 3 individual endpoints; now uses central service)
   Step 5 additions: richer status fields, health snapshot endpoint,
   backoff/cooldown visibility, and per-type failure metadata.
========================================================= */

/**
 * GET /api/admin/ui-summaries
 * Lists all known summary types with full freshness + Step 5 operational diagnostics:
 *   freshnessLabel, operationalStatus, ageMs, builtAt, isPartial, buildDurationMs,
 *   rebuilding, lastSuccessAt, lastFailureAt, failureCount, consecutiveFailures,
 *   lastErrorMessage, lastErrorAt, lastRebuildStartedAt, lastRebuildFinishedAt,
 *   cooldownRemainingMs, maxAgeMs.
 * Payloads are excluded for brevity.
 */
router.get("/ui-summaries", async (_req, res) => {
  try {
    const summaries = await listSummaryStatuses();
    return res.json({
      success:           true,
      generatedAt:       new Date().toISOString(),
      architecture:      "db-first",
      note:              "All summaries are written by dedicated cron jobs. The API only reads.",
      count:             summaries.length,
      supportedTypes:    SUPPORTED_TYPES,
      summaries,
    });
  } catch (error) {
    logger.error("Admin ui-summaries route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/admin/ui-summary-detail/:type
 * Returns detailed status for a single summary type including the stored payload.
 * DB-first: includes writer info, operationalStatus (healthy/stale/empty), writtenByJob flag.
 */
router.get("/ui-summary-detail/:type", async (req, res) => {
  const { type } = req.params;
  if (!SUPPORTED_TYPES.includes(type)) {
    return res.status(400).json({
      success: false,
      error:   `Unknown summary type '${type}'. Supported: ${SUPPORTED_TYPES.join(", ")}`,
    });
  }
  try {
    const status = await getSummaryStatus(type, { includePayload: true });
    return res.json({
      success:     true,
      generatedAt: new Date().toISOString(),
      ...status,
    });
  } catch (error) {
    logger.error(`Admin ui-summary-detail/${type} route error`, { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/admin/ui-summaries-health
 * Compact health snapshot for all summary types.
 * DB-first architecture: all summaries written by dedicated jobs.
 * Returns operationalStatus (healthy/stale/empty), freshnessLabel,
 * writer, writtenByJob per type.
 *
 * Overall health is "ok" if all types are healthy,
 * "degraded" if any type is stale, "empty" if any type has no data.
 */
router.get("/ui-summaries-health", async (_req, res) => {
  try {
    const snapshots = await getHealthSnapshot();

    const hasEmptyType   = snapshots.some((s) => s.operationalStatus === "empty");
    const hasStaleType   = snapshots.some((s) => s.operationalStatus === "stale");
    const overallHealth  = hasEmptyType ? "empty"
      : hasStaleType ? "stale"
      : "healthy";

    return res.json({
      success:       true,
      generatedAt:   new Date().toISOString(),
      architecture:  "db-first",
      overallHealth,
      types:         snapshots,
    });
  } catch (error) {
    logger.error("Admin ui-summaries-health route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/admin/guardian-status-summary
 * Returns the prepared guardian/system status summary (worldState + pipeline health).
 * Read-only from ui_summaries – written by job:ui-guardian-status.
 * Falls back to a live build when the summary has not yet been written by the job.
 */
router.get("/guardian-status-summary", async (_req, res) => {
  try {
    const result = await readSummary("guardian_status");
    if (result.payload) {
      return res.json({
        success:           true,
        freshnessLabel:    result.freshnessLabel,
        operationalStatus: result.operationalStatus,
        ageMs:             result.ageMs,
        builtAt:           result.builtAt,
        isPartial:         result.isPartial,
        rebuilding:        false,
        writer:            result.writer,
        ...result.payload,
      });
    }

    // ui_summaries not yet written by job – fall back to live build
    logger.warn("Admin guardian-status-summary: ui_summary empty, falling back to live build");
    const liveSummary = await refreshGuardianStatusSummary();
    return res.json({
      success:           true,
      freshnessLabel:    "live",
      operationalStatus: liveSummary ? "healthy" : "empty",
      ageMs:             0,
      builtAt:           new Date().toISOString(),
      isPartial:         false,
      rebuilding:        false,
      writer:            "guardianStatusSummary.builder (on-demand fallback)",
      ...(liveSummary ?? {}),
    });
  } catch (error) {
    logger.error("Admin guardian-status-summary route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/refresh-summary/:type
 * DEPRECATED – In DB-first architecture, summaries are written by dedicated jobs.
 * This endpoint now returns a message directing the user to trigger the corresponding job.
 */
router.post("/refresh-summary/:type", async (req, res) => {
  const { type } = req.params;

  if (!SUPPORTED_TYPES.includes(type)) {
    return res.status(400).json({
      success: false,
      error:   `Unknown summary type '${type}'. Supported: ${SUPPORTED_TYPES.join(", ")}`,
    });
  }

  // Read current status instead of rebuilding
  try {
    const status = await getSummaryStatus(type);
    return res.json({
      success:           false,
      summaryType:       type,
      message:           `API no longer rebuilds summaries. Trigger the dedicated job instead: job:ui-${type.replace(/_/g, "-")}`,
      currentStatus:     status?.operationalStatus ?? "unknown",
      freshnessLabel:    status?.freshnessLabel ?? "unknown",
      builtAt:           status?.builtAt ?? null,
      writer:            status?.writer ?? null,
      generatedAt:       new Date().toISOString(),
    });
  } catch (error) {
    logger.error(`Admin refresh-summary/${type} route error`, { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   SERVICE DIAGNOSTICS
   GET /api/admin/service-diagnostics
   Comprehensive Railway service mapping, job health, table freshness,
   demo_portfolio Pflichtquellen, and Writer→Reader matrix.

   Answers:
     - Which job last ran and when
     - Which table was last written to
     - Which Pflichtquelle for demo_portfolio is stale/empty
     - Whether a problem comes from: writer missing / stale data / wrong mapping
========================================================= */

router.get("/service-diagnostics", async (_req, res) => {
  try {
    const report = await getServiceDiagnostics();
    return res.json({ success: true, ...report });
  } catch (error) {
    logger.error("Admin service-diagnostics route error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   GET /api/admin/learning-diagnostics
   Diagnose-/Status-Block für die Learning-Schicht:
   feature_history, discovery_labels, outcome_tracking
========================================================= */

router.get("/learning-diagnostics", async (_req, res) => {
  try {
    const diagnostics = await getLearningDiagnostics();
    return res.json({ success: true, data: diagnostics });
  } catch (error) {
    logger.error("[admin] learning-diagnostics error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   GET /api/admin/reference-portfolio
   Canonical admin reference basket – loads the
   admin_reference_portfolio table and enriches each entry
   with live backend data (snapshot, HQS score, advanced
   metrics, news count, latest outcome).

   Response shape:
     { success, generatedAt, items[], summary{} }

   No dependency on demo/briefing/watchlist tables.
========================================================= */

router.get("/reference-portfolio", async (_req, res) => {
  try {
    const activeEntries = await getActiveReferenceSymbols();
    if (!activeEntries.length) {
      return res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        items: [],
        summary: {
          totalSymbols: 0,
          fullyServed: 0,
          partiallyServed: 0,
          missingComponents: {},
          mostMissingComponent: null,
          lastUpdate: new Date().toISOString(),
        },
      });
    }

    const { items, summary } = await enrichReferencePortfolio(activeEntries);
    return res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      items,
      summary,
    });
  } catch (error) {
    logger.error("[admin] reference-portfolio GET error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   PUT /api/admin/reference-portfolio/:symbol
   Upsert a single entry in the reference portfolio.
   Body: { name?, position_order?, is_active?, note? }
========================================================= */

router.put("/reference-portfolio/:symbol", async (req, res) => {
  const symbol = String(req.params.symbol || "").trim().toUpperCase();
  if (!symbol) {
    return res.status(400).json({ success: false, error: "symbol is required" });
  }
  try {
    const { name, position_order, is_active, note } = req.body || {};
    await upsertReferencePortfolioEntry({ symbol, name, position_order, is_active, note });
    return res.json({ success: true, symbol });
  } catch (error) {
    logger.error("[admin] reference-portfolio PUT error", { message: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   POST /api/admin/openai/test
   Sends a simple test prompt to the OpenAI API and returns
   the result.  Used for connectivity / key validation only.
========================================================= */

const { testOpenAIConnection } = require("../services/openai.service");

router.post("/openai/test", async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({
      success: false,
      error: "OPENAI_API_KEY is not configured",
    });
  }

  try {
    const { model, result } = await testOpenAIConnection();
    return res.json({ success: true, model, result });
  } catch (error) {
    logger.error("[admin] openai/test error", { message: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
   POST /api/admin/deepseek/test
   Sends a simple test prompt to the DeepSeek API and returns
   the result.  Used for connectivity / key validation only.
========================================================= */

const {
  isDeepSeekConfigured,
  createDeepSeekChatCompletion,
} = require("../services/deepseek.service");

router.post("/deepseek/test", async (req, res) => {
  if (!isDeepSeekConfigured()) {
    return res.status(503).json({
      success: false,
      error: "DEEPSEEK_API_KEY is not configured",
    });
  }

  try {
    const completion = await createDeepSeekChatCompletion({
      tier: "fast",
      messages: [
        {
          role: "system",
          content:
            "You are a concise JSON diagnostics assistant. Always reply with valid JSON.",
        },
        {
          role: "user",
          content:
            'Return a JSON object with exactly these keys: "status" (string "ok"), "message" (a short greeting), "timestamp" (current ISO-8601 UTC).',
        },
      ],
      temperature: 0,
    });

    const raw = completion?.choices?.[0]?.message?.content || "";
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      /* keep parsed null – raw is returned below */
    }

    return res.json({
      success: true,
      model: completion?.model || null,
      result: parsed || raw,
    });
  } catch (error) {
    logger.error("[admin] deepseek/test error", { message: error.message });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
   POST /api/admin/deepseek/change-intelligence
   Change Intelligence V1 – structured change-impact analysis
   powered by the existing DeepSeek integration.
========================================================= */

const { analyzeChangeImpact } = require("../services/changeIntelligence.service");
const {
  saveChangeMemoryEntry,
  listChangeMemoryEntries,
  getChangeMemoryEntryById,
  updateChangeMemoryFeedback,
} = require("../services/changeMemory.repository");

router.post("/deepseek/change-intelligence", async (req, res) => {
  if (!isDeepSeekConfigured()) {
    return res.status(503).json({
      success: false,
      error: "DEEPSEEK_API_KEY is not configured",
    });
  }

  try {
    const result = await analyzeChangeImpact(req.body);

    // ── persist to Change Memory (fire-and-forget, never blocks response) ──
    try {
      await saveChangeMemoryEntry({
        changedFiles: req.body.changedFiles || [],
        logs: req.body.logs || [],
        errorMessage: req.body.errorMessage || null,
        affectedArea: req.body.affectedArea || null,
        suspectedFiles: req.body.suspectedFiles || [],
        notes: req.body.notes || null,
        analysisResult: result,
        riskLevel: result?.riskLevel || "medium",
        status: "new",
        tags: req.body.tags || [],
      });
    } catch (memErr) {
      logger.warn("[admin] change-memory save failed (non-blocking)", {
        message: memErr.message,
      });
    }

    return res.json({ success: true, result });
  } catch (error) {
    logger.error("[admin] deepseek/change-intelligence error", {
      message: error.message,
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/change-memory
   List stored Change Memory entries with optional filters.
========================================================= */

router.get("/deepseek/change-memory", async (req, res) => {
  try {
    const entries = await listChangeMemoryEntries({
      status: req.query.status,
      riskLevel: req.query.riskLevel,
      wasHelpful: req.query.wasHelpful,
      limit: req.query.limit,
    });
    return res.json({ success: true, count: entries.length, entries });
  } catch (error) {
    logger.error("[admin] deepseek/change-memory list error", {
      message: error.message,
    });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   GET /api/admin/deepseek/change-memory/:id
   Retrieve a single Change Memory entry by ID.
========================================================= */

router.get("/deepseek/change-memory/:id", async (req, res) => {
  try {
    const entry = await getChangeMemoryEntryById(req.params.id);
    if (!entry) {
      return res.status(404).json({ success: false, error: "Entry not found" });
    }
    return res.json({ success: true, entry });
  } catch (error) {
    logger.error("[admin] deepseek/change-memory detail error", {
      message: error.message,
    });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   PATCH /api/admin/deepseek/change-memory/:id
   Update feedback fields on a Change Memory entry.
========================================================= */

router.patch("/deepseek/change-memory/:id", async (req, res) => {
  try {
    const updated = await updateChangeMemoryFeedback(req.params.id, {
      wasHelpful: req.body.wasHelpful,
      finalFix: req.body.finalFix,
      status: req.body.status,
      notes: req.body.notes,
    });
    if (!updated) {
      return res.status(404).json({ success: false, error: "Entry not found" });
    }
    return res.json({ success: true, entry: updated });
  } catch (error) {
    logger.error("[admin] deepseek/change-memory patch error", {
      message: error.message,
    });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   GET /api/admin/deepseek/dependency-mapping
   Debug endpoint – returns the full Dependency Mapping Light
   configuration for admin inspection.
========================================================= */

const { getAllDependencyMappings } = require("../services/dependencyMapping.service");

router.get("/deepseek/dependency-mapping", async (_req, res) => {
  try {
    const mappings = getAllDependencyMappings();
    return res.json({
      success: true,
      version: "light-v1",
      count: mappings.length,
      mappings,
    });
  } catch (error) {
    logger.error("[admin] deepseek/dependency-mapping error", {
      message: error.message,
    });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   POST /api/admin/deepseek/chat
   Admin DeepSeek Console V1 – free-form admin chat with
   optional mode (chat | diagnose | change_review), context,
   logs, changedFiles, notes.

   Request body:
   {
     "message":      "...",            // required
     "mode":         "chat",           // optional – default "chat"
     "context":      "...",            // optional
     "logs":         ["...", "..."],   // optional string or array
     "changedFiles": ["...", "..."],   // optional array
     "notes":        "..."            // optional
   }

   Response:
   {
     "success": true,
     "mode":    "chat",
     "model":   "deepseek-chat",
     "result": {
       "answer":             "...",
       "warnings":           [],
       "suggestedNextSteps": []
     }
   }
========================================================= */

const { runAdminDeepseekChat } = require("../services/adminDeepseekConsole.service");
const { runMathLogicReview } = require("../services/mathLogicReview.service");
const { runControllerGuard } = require("../services/controllerGuard.service");
const { buildHumanReviewSummary } = require("../services/reviewToHuman.service");
const {
  buildBridgePackage,
  getCurrentBridgePackage,
  receiveFrontendFeedback,
  getPendingFrontendFeedback,
  getPatternMemorySummary,
  getActionReadinessSummary,
  // Step 7: Recommendation Feedback / Improvement Loop Light
  submitRecommendationFeedback,
  getRecommendationImprovementSummary,
  // Step 8: Governance Policy / Visibility Light
  getGovernancePolicySummary,
  // Step 10: Issue Intelligence / Error Detection Light
  getIssueIntelligenceSummary,
  // Step 11: Case / Resolution / Operator Loop Light
  updateCaseStatus,
  getCaseResolutionSummary,
  // Step 12: Attention / Priority / Operator Focus Light
  getAttentionPrioritySummary,
  // Step 13: Decision Maturity / Resolution Confidence Light
  getDecisionMaturitySummary,
  // Step 14: Agent Problem Detection / Solution Proposal / Approval Chat Foundation
  buildAgentCaseFromBridgePackage,
  submitAgentCaseFeedback,
  getAgentCaseSummary,
  getAgentChatMessages,
  // Step 15: Agent Approval / Plan Refinement / Controlled Preparation
  getRefinedPlanSummary,
  // Step 16: Controlled Action Draft / Fix Bundle Preparation
  getActionDraftSummary,
  // Step 17: Controlled Execution Proposal / Apply-Readiness / Final Approval Layer
  getApplyReadinessSummary,
  // Step 18: Controlled Apply Simulation / Execution Preview / Reversal Safety
  getExecutionPreviewSummary,
  // Step 19: Controlled Apply Candidate / Action Package / Approval Gate
  getApplyCandidateSummary,
  // Step 20: Controlled Execution Orchestrator / Apply Runtime / Audit & Kill Switch
  getExecutionRuntimeSummary,
  // Step 21: Agent Conversation Runtime / Persistent Case Chat / Freeform Admin Dialogue
  sendUserMessage,
  getConversationThread,
  getConversationSummary,
  // Step 22: Multi-Agent Handoff / Cross-Agent Dialogue / Coordinated Case Exchange Light
  triggerHandoff,
  getHandoffSummary,
  // Step 23: Conversation Memory / Case Continuity / Agent Memory Anchors
  getCaseMemory,
  getCaseMemorySummary,
  // Step 24: Action Negotiation / Option Comparison / Decision Framing
  getDecisionFrame,
  getDecisionFrameSummary,
  // Konferenz Step A: DeepSeek ↔ Gemini – Conference Session / Targeting / Mode / Summary
  openConferenceSession,
  sendConferenceMessage,
  updateConferenceSession,
  closeConferenceSession,
  getConferenceSession,
  getConferenceSummary,
  getConferenceWorkspace,
  getConferenceAdminSummary,
  // Konferenz Step B: Coordination / Moderation / Coordinated Reply Flow
  sendCoordinatedConferenceMessage,
  getConferenceCoordinationSummary,
  getConferencePhaseDigest,
  // Konferenz Step C: Conference Phases / Decision Room / Result Cards / Strategic Expansion
  advanceConferencePhase,
  getConferenceResultCard,
  getConferenceDecisionRoom,
  getConferencePerspectiveComparison,
  getConferenceStepCSummary,
  VALID_CONFERENCE_WORK_PHASES,
  VALID_CONFERENCE_DECISION_ROOM_STATES,
  VALID_CONFERENCE_CONSENSUS_STATES,
  VALID_CONFERENCE_HANDOFF_DIRECTIONS,
  VALID_CONFERENCE_MODERATION_SIGNALS,
} = require("../services/agentBridge.service");
const {
  isGeminiConfigured,
  runGeminiArchitectReview,
  VALID_MODES: GEMINI_ARCHITECT_MODES,
  RESULT_TYPES: GEMINI_RESULT_TYPES,
  FALLBACK_LABELS: GEMINI_FALLBACK_LABELS,
} = require("../services/geminiArchitect.service");

/* =========================================================
   POST /api/admin/deepseek/math-logic-review
   Math & Logic Review Light V1 – plausibility / consistency
   review of HQS scoring and assessment logic via DeepSeek.

   Request body (all fields optional):
   {
     "message":      "...",               // free-form review request
     "changedFiles": ["...", "..."],      // relevant files
     "logs":         ["...", "..."],      // logs or metric samples
     "context":      "...",              // additional context
     "notes":        "...",              // extra notes
     "focusAreas":   ["score_consistency", "null_nan_risk", ...]
                     // valid values: score_consistency, missing_metrics,
                     //              weighting, fallback_logic,
                     //              range_clamp, null_nan_risk
   }

   Response:
   {
     "success": true,
     "version": "light-v1",
     "result": {
       "reviewLevel":       "low|medium|high",
       "detectedRisks":     [],
       "consistencyChecks": [],
       "missingSignals":    [],
       "recommendedChecks": [],
       "notes":             []
     }
   }
========================================================= */

router.post("/deepseek/math-logic-review", async (req, res) => {
  if (!isDeepSeekConfigured()) {
    return res.status(503).json({
      success: false,
      error: "DEEPSEEK_API_KEY is not configured",
    });
  }

  try {
    const result = await runMathLogicReview(req.body);
    return res.json({ success: true, version: "light-v1", result });
  } catch (error) {
    logger.error("[admin] deepseek/math-logic-review error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error during Math & Logic Review",
    });
  }
});

/* =========================================================
   POST /api/admin/deepseek/controller-guard
   Controller-/Guard Layer V1 – structured detection of
   system breaks, contract violations, and follow-up errors
   in the HQS backend via DeepSeek.

   Request body (all fields optional):
   {
     "mode":             "...",               // optional mode label
     "message":          "...",               // free-form guard request
     "changedFiles":     ["...", "..."],      // relevant files
     "logs":             ["...", "..."],      // logs or error messages
     "context":          "...",              // additional context
     "notes":            "...",              // extra notes
     "result":           { ... },            // existing analysis result
     "dependencyHints":  ["...", "..."],     // dependency hints
     "focusAreas":       ["missing_required_fields", "response_contract", ...]
                         // valid values: missing_required_fields,
                         //              response_contract, mapper_viewmodel,
                         //              route_service_followup,
                         //              read_model_staleness,
                         //              symbol_label_id,
                         //              schema_change_propagation
     "affectedArea":     "..."              // affected system area
   }

   Response:
   {
     "success": true,
     "version": "v1",
     "result": {
       "guardLevel":            "low|medium|high",
       "contractWarnings":      [],
       "missingRequiredChecks": [],
       "likelyBreakpoints":     [],
       "followupVerifications": [],
       "stalenessRisks":        [],
       "notes":                 []
     }
   }
========================================================= */

router.post("/deepseek/controller-guard", async (req, res) => {
  if (!isDeepSeekConfigured()) {
    return res.status(503).json({
      success: false,
      error: "DEEPSEEK_API_KEY is not configured",
    });
  }

  try {
    const result = await runControllerGuard(req.body);
    return res.json({ success: true, version: "v1", result });
  } catch (error) {
    logger.error("[admin] deepseek/controller-guard error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error during Controller Guard",
    });
  }
});

router.post("/deepseek/chat", async (req, res) => {
  if (!isDeepSeekConfigured()) {
    return res.status(503).json({
      success: false,
      error: "DEEPSEEK_API_KEY is not configured",
    });
  }

  try {
    const result = await runAdminDeepseekChat(req.body);

    // Service returns { success: false, error } when message is missing
    if (!result.success) {
      return res.status(400).json(result);
    }

    return res.json(result);
  } catch (error) {
    logger.error("[admin] deepseek/chat error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error during admin DeepSeek chat",
    });
  }
});

/* =========================================================
   POST /api/admin/deepseek/review-to-human
   Review-to-Human Layer V1 – translate a structured DeepSeek
   analysis / review result into a short, plain-language summary.

   Request body:
   {
     "mode":             "diagnose|change_review|math_logic_review|chat",
     "message":          "...",           // original query (optional)
     "result":           { ... },         // structured DeepSeek result object
     "dependencyHints":  ["...", "..."],  // optional dependency hints
     "version":          "...",           // optional version label
     "notes":            "..."           // optional extra notes
   }

   Response:
   {
     "success": true,
     "version": "v1",
     "humanSummary": {
       "summaryTitle":      "...",
       "summaryText":       "...",
       "severity":          "low|medium|high",
       "whatMattersNow":    [],
       "recommendedAction": "...",
       "confidenceNote":    "..."
     }
   }
========================================================= */

router.post("/deepseek/review-to-human", async (req, res) => {
  // No early 503 guard here – buildHumanReviewSummary has a static fallback
  // that works even when DeepSeek is not configured.
  try {
    const humanSummary = await buildHumanReviewSummary(req.body);
    return res.json({ success: true, version: "v1", humanSummary });
  } catch (error) {
    logger.error("[admin] deepseek/review-to-human error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error during Review-to-Human translation",
    });
  }
});

/* =========================================================
   POST /api/admin/gemini/architect-review
   Gemini Architect V1 – Frontend-Architekt / Präsentationsassistent.
   Beantwortet UI-/Layout-/Darstellungsfragen strukturiert über Gemini.

   Request body (all fields optional):
   {
     "mode":                  "layout_review|presentation_review|frontend_guard|priority_review",
     "message":               "...",             // free-form review request
     "context":               "...",             // additional context
     "notes":                 "...",             // extra notes
     "affectedAreas":         ["...", "..."],    // affected system areas
     "affectedViews":         ["...", "..."],    // affected views / pages
     "affectedComponents":    ["...", "..."],    // affected UI components
     "bridgeContext":         { ... },           // agent-bridge context object
     "frontendObservations":  ["...", "..."],    // frontend observations
     "priorityContext":       "...",             // UI priority context description
     "layoutState":           "...|{ ... }"     // current layout state
   }

   Response:
   {
     "success": true,
     "version": "v1",
     "validModes": [...],
     "mode": "layout_review",
     "result": {
       "summaryTitle":            "...",
       "summaryText":             "...",
       "severity":                "low|medium|high",
       "uiFindings":              [],
       "layoutRecommendations":   [],
       "priorityRecommendations": [],
       "frontendGuardNotes":      [],
       "recommendedAction":       "...",
       "confidenceNote":          "..."
     }
   }
========================================================= */

router.post("/gemini/architect-review", async (req, res) => {
  logger.info("[admin] gemini/architect-review request received", {
    mode: req.body?.mode || "not_specified",
    hasMessage: Boolean(req.body?.message),
    hasContext: Boolean(req.body?.context),
    hasBridgeContext: Boolean(req.body?.bridgeContext),
  });

  if (!isGeminiConfigured()) {
    const rt = GEMINI_RESULT_TYPES.NOT_CONFIGURED;
    logger.warn("[admin] gemini/architect-review – not configured");
    return res.status(503).json({
      success: false,
      version: "v1",
      validModes: GEMINI_ARCHITECT_MODES,
      mode: req.body?.mode || null,
      resultType: rt,
      error: GEMINI_FALLBACK_LABELS[rt] || "Gemini ist nicht konfiguriert",
      message: "GEMINI_API_KEY is not configured",
      result: null,
    });
  }

  try {
    const review = await runGeminiArchitectReview(req.body);
    const isSuccess = review.resultType === GEMINI_RESULT_TYPES.SUCCESS;
    const resultType = review.resultType || GEMINI_RESULT_TYPES.FALLBACK;

    logger.info("[admin] gemini/architect-review response", {
      success: isSuccess,
      resultType,
      mode: review.mode,
    });

    return res.json({
      success: isSuccess,
      version: "v1",
      validModes: GEMINI_ARCHITECT_MODES,
      mode: review.mode,
      resultType,
      error: isSuccess ? null : (GEMINI_FALLBACK_LABELS[resultType] || GEMINI_FALLBACK_LABELS[GEMINI_RESULT_TYPES.FALLBACK]),
      message: isSuccess ? null : (review.result?.summaryText || GEMINI_FALLBACK_LABELS[resultType] || null),
      result: review.result,
    });
  } catch (error) {
    const safeMsg = String(error.message || "").slice(0, 120);
    const isTimeout = safeMsg.toLowerCase().includes("timeout") ||
                      safeMsg.toLowerCase().includes("deadline") ||
                      safeMsg.includes("GEMINI_TIMEOUT");
    const resultType = isTimeout ? GEMINI_RESULT_TYPES.TIMEOUT : GEMINI_RESULT_TYPES.ROUTE_ERROR;
    const fallbackLabel = GEMINI_FALLBACK_LABELS[resultType] || GEMINI_FALLBACK_LABELS[GEMINI_RESULT_TYPES.FALLBACK];

    logger.error("[admin] gemini/architect-review error", {
      resultType,
      isTimeout,
      reason: safeMsg,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      version: "v1",
      validModes: GEMINI_ARCHITECT_MODES,
      mode: req.body?.mode || null,
      resultType,
      error: fallbackLabel,
      message: safeMsg || "Internal error during Gemini Architect Review",
      result: null,
    });
  }
});

/* =========================================================
   DeepSeek ↔ Gemini Agent Bridge V1 (Workflow Step 1)
   =========================================================

   Three endpoints form the structured communication layer
   between the backend (DeepSeek) and frontend (Gemini):

   GET  /api/admin/deepseek/agent-bridge
        Returns the current in-memory bridge package.
        Safe to call at any time; returns an empty shell
        when no package has been generated yet.

   POST /api/admin/deepseek/agent-bridge/hints
        Accepts a structured DeepSeek analysis result and
        builds (or rebuilds) the bridge package from it.

        Request body:
        {
          "lastKnownArea": "...",          // e.g. "hqs_assessment"
          "lastKnownMode": "...",          // e.g. "change_review"
          "sourceMode":    "...",          // originating service label
          "result":        { ... },        // raw DeepSeek result object
          "hints":         [ ... ]         // optional explicit hint overrides
        }

        Response:
        {
          "success":  true,
          "version":  "v1",
          "bridge": {
            "version":      "v1",
            "generatedAt":  "...",
            "backendState": {
              "activeAgent":   "deepseek_backend",
              "lastKnownArea": "...",
              "lastKnownMode": "..."
            },
            "bridgeHints": [ ... ],
            "workflow": {
              "sourceAgent":          "deepseek_backend",
              "sourceMode":           "...",
              "reviewIntent":         "binding_guard|structure_check|display_check|priority_check|general_review",
              "recommendedGeminiMode":"layout_review|presentation_review|frontend_guard|priority_review",
              "inspectionFocus": {
                "category":            "guard|layout|priority|presentation|general",
                "affectedViews":       [],
                "affectedComponents":  [],
                "affectedFields":      [],
                "needsFollowup":       false
              },
              "workflowStage":        "bridge_ready"
            }
          }
        }

   POST /api/admin/deepseek/agent-bridge/frontend-feedback
        Accepts structured Gemini / frontend feedback and
        stores it in memory for backend inspection.

        Request body:
        {
          "source": "gemini_frontend",     // identifier of the sending agent
          "area":   "...",                 // frontend area that generated this
          "hints":  [ ... ],               // array of frontend hint objects
          "notes":  "..."                  // optional plain-text note
        }

        Response:
        {
          "success":          true,
          "version":          "v1",
          "accepted":         true,
          "hintsReceived":    0,
          "hintsKept":        0,
          "hintsDropped":     0,
          "stored":           true,
          "receivedAt":       "...",
          "feedbackCategory": "guard|layout|priority|presentation|general",
          "needsFollowup":    false
        }
========================================================= */

router.get("/deepseek/agent-bridge", (req, res) => {
  try {
    const bridge = getCurrentBridgePackage();
    return res.json({ success: true, version: "v1", bridge });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge GET error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading Agent Bridge state",
    });
  }
});

router.post("/deepseek/agent-bridge/hints", (req, res) => {
  try {
    const bridge = buildBridgePackage(req.body || {});
    return res.json({ success: true, version: "v1", bridge });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/hints error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error building Agent Bridge package",
    });
  }
});

router.post("/deepseek/agent-bridge/frontend-feedback", (req, res) => {
  try {
    const ack = receiveFrontendFeedback(req.body || {});
    return res.json({ success: true, version: "v1", ...ack });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/frontend-feedback error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error accepting frontend feedback",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/pattern-memory
   Step 4: Pattern Memory Light – returns an aggregated
   summary of recurring learning-signal patterns observed
   by the agent bridge.  In-memory only, no persistence.

   Response:
     {
       "success":       true,
       "version":       "v1",
       "patternMemory": {
         "totalPatterns": 5,
         "topPatterns":   [ ... ],
         "generatedAt":   "2025-..."
       }
     }
========================================================= */
router.get("/deepseek/agent-bridge/pattern-memory", (_req, res) => {
  try {
    const summary = getPatternMemorySummary();
    return res.json({ success: true, version: "v1", patternMemory: summary });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/pattern-memory error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading pattern memory",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/action-readiness
   Step 6: Action Readiness Summary – returns a lightweight
   overview of how signals are distributed across readiness
   bands and action types.  Helps the HQS system understand
   how many signals are exploratory vs. actionable, without
   triggering any auto-execution.

   Response:
     {
       "success":            true,
       "version":            "v1",
       "actionReadiness": {
         "totalPatterns":          5,
         "readinessDistribution":  { "observation": 3, "useful_next_step": 2 },
         "actionTypeDistribution": { "observe": 3, "check_binding": 2 },
         "patternsPerReadiness":   { "observation": 2, "useful_next_step": 1 },
         "confidenceVsReadiness":  { "medium→observation": 2, "high→useful_next_step": 1 },
         "generatedAt":            "2026-..."
       }
     }
========================================================= */
router.get("/deepseek/agent-bridge/action-readiness", (_req, res) => {
  try {
    const summary = getActionReadinessSummary();
    return res.json({ success: true, version: "v1", actionReadiness: summary });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/action-readiness error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading action readiness summary",
    });
  }
});

/* =========================================================
   POST /api/admin/deepseek/agent-bridge/recommendation-feedback
   Step 7: Recommendation Feedback / Improvement Loop Light –
   accepts retrospective feedback on a recommendation so the
   HQS system can learn which recommendation types proved
   helpful, too early, unclear, etc.

   Readiness (Step 6) and improvement feedback (Step 7) are
   deliberately separate:
   - Readiness = how action-ready something currently looks
   - Feedback  = how well this kind of recommendation worked
                  in retrospect

   Body:
     {
       "patternKey":              "guard:backend_schema:schema_followup:frontend_guard",
       "recommendationFeedback":  "helpful|usable|too_early|unclear|not_needed|followup_was_better",
       "improvementSignal":       "none|needs_more_context|too_generic|timing_off|wrong_layer|followup_preferred",
       "notes":                   "optional free-text",
       "originalActionType":      "check_binding",
       "originalReadinessBand":   "useful_next_step",
       "followupCategory":        "schema_followup",
       "sourceCategory":          "guard"
     }

   Response:
     {
       "success":                  true,
       "version":                  "v1",
       "accepted":                 true,
       "recommendationFeedback":   "helpful",
       "improvementSignal":        "none",
       "patternKey":               "...",
       "patternFound":             true
     }
========================================================= */
router.post("/deepseek/agent-bridge/recommendation-feedback", (req, res) => {
  try {
    const ack = submitRecommendationFeedback(req.body || {});
    return res.json({ success: true, version: "v1", ...ack });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/recommendation-feedback error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error processing recommendation feedback",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/recommendation-improvement
   Step 7: Recommendation Improvement Summary – returns a
   lightweight overview of how recommendations performed in
   retrospect.  Shows feedback distribution, improvement
   signals, and cross-references between readiness and
   actual outcome.

   Helps the HQS system understand:
   - which recommendation types tend to be helpful
   - which are often too early or unclear
   - how readiness relates to actual outcome
   - which follow-up types produce better results

   Purely observational – no auto-adjustment.

   Response:
     {
       "success":                      true,
       "version":                      "v1",
       "recommendationImprovement": {
         "totalFeedbackEntries":        12,
         "feedbackDistribution":        { "helpful": 5, "too_early": 3, ... },
         "improvementDistribution":     { "timing_off": 3, ... },
         "actionTypeVsFeedback":        { "check_binding→helpful": 2, ... },
         "readinessVsFeedback":         { "useful_next_step→helpful": 3, ... },
         "followupVsFeedback":          { "schema_followup→helpful": 2, ... },
         "sourceVsFeedback":            { "guard→helpful": 2, ... },
         "patternImprovementInsights":  [ ... ],
         "generatedAt":                 "2026-..."
       }
     }
========================================================= */
router.get("/deepseek/agent-bridge/recommendation-improvement", (_req, res) => {
  try {
    const summary = getRecommendationImprovementSummary();
    return res.json({ success: true, version: "v1", recommendationImprovement: summary });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/recommendation-improvement error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading recommendation improvement summary",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/governance-policy
   Step 8: Governance Policy Summary – returns a lightweight
   overview of how recommendations are distributed across
   governance / policy / visibility classes.

   Helps the HQS system understand:
   - how many signals remain shadow-only (internal observation)
   - how many are internal-only
   - how many need more evidence before surfacing
   - how many are admin-visible
   - how many are guardian candidates
   - how governance relates to readiness and confidence

   Important:
   - This is purely observational – no auto-promotion
   - Governance is deliberately separate from readiness
     (Step 6) and improvement (Step 7)
   - Guardian candidates are only marked, never
     auto-activated

   Response:
     {
       "success":              true,
       "version":              "v1",
       "governancePolicy": {
         "totalPatterns":           5,
         "governanceDistribution":  { "shadow_only": 2, "admin_visible": 1, ... },
         "patternsPerGovernance":   { "shadow_only": 2, "internal_only": 1, ... },
         "readinessVsGovernance":   { "observation→shadow_only": 2, ... },
         "confidenceVsGovernance":  { "low→shadow_only": 2, ... },
         "guardianCandidates":      [ ... ],
         "generatedAt":             "2026-..."
       }
     }
========================================================= */
router.get("/deepseek/agent-bridge/governance-policy", (_req, res) => {
  try {
    const summary = getGovernancePolicySummary();
    return res.json({ success: true, version: "v1", governancePolicy: summary });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/governance-policy error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading governance policy summary",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/issue-intelligence
   Step 10: Issue Intelligence / Error Detection Light –
   returns a lightweight overview of recurring technical
   Auffälligkeiten, problem categories, affected layers,
   severity distribution and conservative follow-up hints.

   Important:
   - purely observational, no auto-fix
   - deliberately separate from governance / policy
   - deliberately separate from routing / surface logic

   Response:
     {
       "success": true,
       "version": "v1",
       "issueIntelligence": {
         "totalPatterns": 5,
         "currentBridgeIssue": { ... },
         "issueCategoryDistribution": { "mapping_schema_issue": 2 },
         "affectedLayerDistribution": { "mapping": 2 },
         "issueSeverityDistribution": { "medium": 2 },
         "suspectedCauseDistribution": { "schema_mapping_drift": 2 },
         "suggestedFixDistribution": { "review_schema_mapping": 2 },
         "patternsPerIssueCategory": { "mapping_schema_issue": 1 },
         "patternsPerAffectedLayer": { "mapping": 1 },
         "patternsNeedingFollowup": 1,
         "generatedAt": "2026-..."
       }
     }
========================================================= */
router.get("/deepseek/agent-bridge/issue-intelligence", (_req, res) => {
  try {
    const summary = getIssueIntelligenceSummary();
    return res.json({ success: true, version: "v1", issueIntelligence: summary });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/issue-intelligence error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading issue intelligence summary",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/case-resolution
   Step 11: Case / Resolution / Operator Loop Light –
   returns a lightweight overview of the operative
   Bearbeitungszustand of recognised hints, issues and
   recommendations.  Shows how many cases are open,
   watching, confirmed, resolved, dismissed or need
   follow-up.

   Important:
   - purely observational, no auto-resolve
   - deliberately separate from issue intelligence
   - deliberately separate from readiness / governance
   - no ticket-system, no heavy persistence

   Response:
     {
       "success": true,
       "version": "v1",
       "caseResolution": {
         "totalCases": 5,
         "totalPatternsTracked": 12,
         "statusDistribution": { "open": 2, "watching": 1 },
         "outcomeDistribution": { "pending": 3 },
         "helpfulnessDistribution": { "too_early_to_tell": 3 },
         "casesNeedingFollowup": 1,
         "casesWithManualOverride": 0,
         "casesHelpful": 0,
         "casesNotHelpful": 0,
         "patternCaseOverview": { "open": 8, "watching": 4 },
         "recentCases": [ ... ],
         "generatedAt": "2026-..."
       }
     }
========================================================= */
router.get("/deepseek/agent-bridge/case-resolution", (_req, res) => {
  try {
    const summary = getCaseResolutionSummary();
    return res.json({ success: true, version: "v1", caseResolution: summary });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/case-resolution error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading case resolution summary",
    });
  }
});

/* =========================================================
   POST /api/admin/deepseek/agent-bridge/case-status-update
   Step 11: Case / Resolution / Operator Loop Light –
   allows the operator/admin to update the operative
   Bearbeitungszustand of a case.

   The system does NOT auto-resolve or auto-dismiss.
   All status transitions are operator-driven.

   Request body:
     {
       "patternKey": "guard:backend_schema:schema_followup:frontend_guard",
       "caseStatus": "watching",
       "caseOutcome": "needs_further_review",
       "caseNote": "Wird weiter beobachtet",
       "wasHelpful": true,
       "followupNeeded": false
     }

   Response:
     {
       "success": true,
       "patternKey": "...",
       "caseStatus": "watching",
       "caseOutcome": "needs_further_review",
       "helpfulnessBand": "clearly_helpful",
       "wasHelpful": true,
       "followupNeeded": false,
       "manualOverride": true,
       "updatedAt": "2026-...",
       "statusHistory": [ ... ]
     }
========================================================= */
router.post("/deepseek/agent-bridge/case-status-update", (req, res) => {
  try {
    const result = updateCaseStatus(req.body || {});
    return res.json(result);
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/case-status-update error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error updating case status",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/attention-priority
   Step 12: Attention / Priority / Operator Focus Light –
   returns a lightweight overview of how attention / priority
   is distributed across recognised patterns and cases.

   Helps the operator understand:
   - how many patterns require immediate focus (focus_now)
   - how many should be reviewed today (review_today)
   - how many can be watched next (watch_next)
   - how many are in the background (background)
   - which issue / case / readiness combinations tend to
     drive higher attention
   - which focus drivers appear most frequently
   - recent high-priority entries with reasons

   Purely observational – no auto-dispatch, no auto-execute.
   The system recommends attention – the operator decides.

   Response:
     {
       "success": true,
       "version": "v1",
       "attentionPriority": {
         "totalPatterns": 12,
         "totalCases": 8,
         "bandDistribution": { "focus_now": 1, "review_today": 3, ... },
         "driverFrequency": { "issue_severity_high": 2, ... },
         "issueVsAttention": { "high→focus_now": 1, ... },
         "caseVsAttention": { ... },
         "readinessVsAttention": { ... },
         "highPriorityEntries": [ ... ],
         "currentBridgeAttention": { ... },
         "generatedAt": "2026-..."
       }
     }
========================================================= */
router.get("/deepseek/agent-bridge/attention-priority", (_req, res) => {
  try {
    const summary = getAttentionPrioritySummary();
    return res.json({ success: true, version: "v1", attentionPriority: summary });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/attention-priority error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading attention priority summary",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/decision-maturity
   Step 13: Decision Maturity / Resolution Confidence Light –
   returns a lightweight overview of how decision maturity /
   resolution confidence is distributed across recognised
   patterns and cases.

   Helps the operator understand:
   - how many patterns are still early signals (early_signal)
   - how many are building substance (building)
   - how many have gained credibility (credible)
   - how many are robustly confirmed (confirmed)
   - which dimensions frequently drive higher maturity
   - which patterns are early despite high attention
   - recent high-maturity entries with reasons

   Purely observational – no auto-dispatch, no auto-execute.
   The system assesses robustness – the operator decides.

   Response:
     {
       "success": true,
       "version": "v1",
       "decisionMaturity": {
         "totalPatterns": 12,
         "totalCases": 8,
         "bandDistribution": { "early_signal": 3, "building": 4, ... },
         "driverFrequency": { "observations_recurring": 5, ... },
         "readinessVsMaturity": { ... },
         "caseVsMaturity": { ... },
         "attentionVsMaturity": { ... },
         "highMaturityEntries": [ ... ],
         "earlyDespiteAttention": [ ... ],
         "currentBridgeMaturity": { ... },
         "generatedAt": "2026-..."
       }
     }
========================================================= */
router.get("/deepseek/agent-bridge/decision-maturity", (_req, res) => {
  try {
    const summary = getDecisionMaturitySummary();
    return res.json({ success: true, version: "v1", decisionMaturity: summary });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/decision-maturity error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading decision maturity summary",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/agent-cases
   Step 14: Agent Problem Detection / Solution Proposal /
   Approval Chat Foundation – returns an overview of all
   agent cases including:
   - total cases by role / status / problem type
   - cases with clear fix proposals
   - cases needing approval
   - recent agent cases with summaries

   Helps the operator understand:
   - how many agentische Problemfälle exist
   - how many have concrete solution proposals
   - how many need approval
   - what the next suggested steps are

   Cooperative, not autonomous.

   Response:
     {
       "success": true,
       "version": "v1",
       "agentCases": {
         "totalAgentCases": 5,
         "totalChatMessages": 12,
         "casesByRole": { "deepseek_backend": 3, "gemini_frontend": 2 },
         "casesByStatus": { "proposed": 3, "approved": 1, ... },
         "casesByProblemType": { ... },
         "withClearFixes": 4,
         "needsApproval": 3,
         "recentCases": [ ... ],
         "generatedAt": "2026-..."
       }
     }
========================================================= */
router.get("/deepseek/agent-bridge/agent-cases", (_req, res) => {
  try {
    const summary = getAgentCaseSummary();
    return res.json({ success: true, version: "v1", agentCases: summary });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/agent-cases error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading agent cases summary",
    });
  }
});

/* =========================================================
   POST /api/admin/deepseek/agent-bridge/agent-case-feedback
   Step 14: Submit user feedback on an agent case.

   Supports feedback types:
   - approve         → start preparation
   - reject          → hold back proposal
   - modify          → adjust plan
   - narrow_scope    → limit to backend/frontend only
   - suggest_alternative → user has a different idea
   - request_more_info   → deepen diagnosis
   - defer           → postpone
   - approve_partial → approve only part

   Request body:
     {
       "agentCaseId": "ac-...",
       "feedbackType": "approve",
       "userMessage": "optional user comment",
       "preferredScope": "backend_only",
       "alternativeSuggestion": "optional alternative"
     }

   Response:
     {
       "success": true,
       "agentCaseId": "ac-...",
       "feedbackType": "approve",
       "newStatus": "approved",
       "planVersion": 1,
       "approvalScope": "backend_only",
       "nextSuggestedStep": "...",
       "agentResponse": "Verstanden – ..."
     }
========================================================= */
router.post("/deepseek/agent-bridge/agent-case-feedback", (req, res) => {
  try {
    const {
      agentCaseId,
      feedbackType,
      userMessage,
      preferredScope,
      alternativeSuggestion,
    } = req.body || {};

    if (!agentCaseId) {
      return res.status(400).json({
        success: false,
        error: "agentCaseId is required",
      });
    }
    if (!feedbackType) {
      return res.status(400).json({
        success: false,
        error: "feedbackType is required",
      });
    }

    const result = submitAgentCaseFeedback({
      agentCaseId,
      feedbackType,
      userMessage: userMessage || null,
      preferredScope: preferredScope || null,
      alternativeSuggestion: alternativeSuggestion || null,
    });

    if (!result.success) {
      return res.status(400).json(result);
    }

    return res.json(result);
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/agent-case-feedback error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error processing agent case feedback",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/agent-chat-messages
   Step 14: Returns agent chat messages, optionally filtered
   by case or role.

   Query params:
   - agentCaseId (optional) – filter by specific case
   - agentRole   (optional) – filter by role
   - limit       (optional) – max messages (default 50)

   Response:
     {
       "success": true,
       "version": "v1",
       "chat": {
         "totalMessages": 25,
         "filteredCount": 10,
         "messages": [ ... ],
         "generatedAt": "2026-..."
       }
     }
========================================================= */
router.get("/deepseek/agent-bridge/agent-chat-messages", (req, res) => {
  try {
    const { agentCaseId, agentRole, limit } = req.query || {};
    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    const chat = getAgentChatMessages({
      agentCaseId: agentCaseId || undefined,
      agentRole: agentRole || undefined,
      limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50,
    });
    return res.json({ success: true, version: "v1", chat });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/agent-chat-messages error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading agent chat messages",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/plan-refinement-summary
   Step 15: Plan Refinement / Controlled Preparation Summary.

   Returns an overview of all agent cases with Step 15
   plan refinement and preparation statistics:
   - How many cases have a refined plan
   - How many are ready to prepare
   - Preparation type distribution
   - Approval decision stage distribution
   - Plan phase distribution
   - Cross-agent coordination counts
   - Per-case refinement status

   Cooperative, not autonomous.

   Response:
     {
       "success": true,
       "version": "v1",
       "planRefinement": {
         "totalAgentCases": 5,
         "withRefinedPlan": 3,
         "readyToPrepare": 2,
         "awaitingDecision": 1,
         "diagnosisOnly": 1,
         "byPreparationType": { "backend_prepare": 1, ... },
         "byApprovalDecisionStage": { "approved_full": 1, ... },
         "byPlanPhase": { "preparation_phase": 2, ... },
         "crossAgentStatus": { "needsCrossAgentReview": 1, ... },
         "refinedCases": [ ... ],
         "generatedAt": "2026-..."
       }
     }
========================================================= */
router.get("/deepseek/agent-bridge/plan-refinement-summary", (_req, res) => {
  try {
    const planRefinement = getRefinedPlanSummary();
    return res.json({ success: true, version: "v1", planRefinement });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/plan-refinement-summary error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading plan refinement summary",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/action-draft-summary
   Step 16: Controlled Action Draft / Fix Bundle Summary.

   Returns an overview of all agent cases with Step 16
   action drafts / fix bundles:
   - How many cases have drafts
   - Draft type / change category distribution
   - Preparation ownership distribution
   - Drafts awaiting further approval
   - Cross-agent / handoff status
   - Per-case draft status

   Cooperative, not autonomous.  Drafts are prepared,
   never executed automatically.

   Response:
     {
       "success": true,
       "version": "v1",
       "actionDrafts": {
         "totalAgentCases": 5,
         "totalWithDraft": 3,
         "totalDiagnosisOnly": 1,
         "totalAwaitingApproval": 2,
         "totalBackendDrafts": 1,
         "totalFrontendDrafts": 1,
         "byDraftType": { "backend_fix_draft": 1, ... },
         "byChangeCategory": { "backend_logic": 1, ... },
         "byPreparationOwner": { "deepseek_backend": 1, ... },
         "draftCases": [ ... ],
         "generatedAt": "2026-..."
       }
     }
========================================================= */
router.get("/deepseek/agent-bridge/action-draft-summary", (_req, res) => {
  try {
    const actionDrafts = getActionDraftSummary();
    return res.json({ success: true, version: "v1", actionDrafts });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/action-draft-summary error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading action draft summary",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/apply-readiness-summary
   Step 17: Controlled Execution Proposal /
   Apply-Readiness / Final Approval Summary.

   Returns an overview of all agent cases with Step 17
   apply-readiness assessments:
   - How many drafts are at each readiness band
   - How many are eligible for apply / blocked
   - Which blocking factors are most common
   - Which risk flags appear frequently
   - Which apply modes are recommended
   - Cross-agent review needs
   - Per-case readiness status

   Cooperative, not autonomous.  The system evaluates
   readiness and prepares a proposal – the user decides.

   Response:
     {
       "success": true,
       "version": "v1",
       "applyReadiness": {
         "totalAgentCases": 5,
         "totalWithReadiness": 3,
         "totalEligibleForApply": 1,
         "totalBlocked": 1,
         "totalFinalApprovalReady": 1,
         "byReadinessBand": { "review_ready": 2, ... },
         "byApplyMode": { "review_only": 2, ... },
         "byBlockingFactor": { "approval_pending": 1, ... },
         "byRiskFlag": { "scope_uncertainty": 1, ... },
         "readinessCases": [ ... ],
         "generatedAt": "2026-..."
       }
     }
========================================================= */
router.get("/deepseek/agent-bridge/apply-readiness-summary", (_req, res) => {
  try {
    const applyReadiness = getApplyReadinessSummary();
    return res.json({ success: true, version: "v1", applyReadiness });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/apply-readiness-summary error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading apply-readiness summary",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/execution-preview-summary
   Step 18: Controlled Apply Simulation /
   Execution Preview / Reversal Safety Summary.

   Returns an overview of all agent cases with Step 18
   execution previews:
   - How many cases have a preview
   - How many are preview-blocked / rollback-recommended
   - Safety band distribution
   - Preview state distribution
   - Reversal complexity distribution
   - Apply window distribution
   - Top preview warnings
   - Per-case preview status

   Cooperative, not autonomous.  The system prepares
   a preview – the user decides.

   Response:
     {
       "success": true,
       "version": "v1",
       "executionPreview": {
         "totalAgentCases": 5,
         "totalWithPreview": 3,
         "totalPreviewBlocked": 0,
         "totalRollbackRecommended": 1,
         "byPreviewState": { "low_impact_preview": 2, ... },
         "bySafetyBand": { "low_risk": 2, ... },
         "byReversalComplexity": { "simple": 2, ... },
         "byApplyWindow": { "safe_anytime": 1, ... },
         "topWarnings": [ ... ],
         "previewCases": [ ... ],
         "generatedAt": "2026-..."
       }
     }
========================================================= */
router.get("/deepseek/agent-bridge/execution-preview-summary", (_req, res) => {
  try {
    const executionPreview = getExecutionPreviewSummary();
    return res.json({ success: true, version: "v1", executionPreview });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/execution-preview-summary error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading execution-preview summary",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/apply-candidate-summary
   Step 19: Controlled Apply Candidate /
   Action Package / Approval Gate Summary.

   Returns an overview of all agent cases with Step 19
   apply candidates:
   - How many cases have a candidate
   - How many are ready for final approval
   - How many are blocked / need scope confirmation
   - Candidate status / mode distribution
   - Guardrail type distribution
   - Top missing approvals / preconditions
   - Per-case candidate status

   Cooperative, not autonomous.  The system prepares
   the candidate – the user decides.

   Response:
     {
       "success": true,
       "version": "v1",
       "applyCandidate": {
         "totalAgentCases": 5,
         "totalWithCandidate": 3,
         "totalReadyForFinalApproval": 1,
         "totalBlocked": 0,
         "byCandidateStatus": { ... },
         "byCandidateMode": { ... },
         "byCandidateOwner": { ... },
         "byGuardrailType": { ... },
         "topMissingApprovals": [ ... ],
         "topPreconditions": [ ... ],
         "candidateCases": [ ... ],
         "generatedAt": "2026-..."
       }
     }
========================================================= */
router.get("/deepseek/agent-bridge/apply-candidate-summary", (_req, res) => {
  try {
    const applyCandidate = getApplyCandidateSummary();
    return res.json({ success: true, version: "v1", applyCandidate });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/apply-candidate-summary error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading apply-candidate summary",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/execution-runtime-summary
   Step 20: Controlled Execution Orchestrator /
   Apply Runtime / Audit & Kill Switch

   Returns runtime / execution session summary across all
   agent cases.  Shows:
    - How many runtime sessions exist
    - How many are blocked / ready / awaiting start / running / completed / aborted / failed
    - Kill-switch / abort / rollback reservation counts
    - Runtime status / mode / state distribution
    - Runtime owner distribution
    - Guardrail type distribution
    - Top block reasons
    - Per-case runtime status

   Cooperative, not autonomous.  The system prepares
   the runtime session – the user decides when to start.

   Response:
     {
       "success": true,
       "version": "v1",
       "executionRuntime": {
         "totalAgentCases": 5,
         "totalWithRuntime": 3,
         "totalBlocked": 1,
         "totalAwaitingStart": 1,
         "byRuntimeStatus": { ... },
         "byRuntimeMode": { ... },
         "byExecutionState": { ... },
         "byRuntimeOwner": { ... },
         "byGuardrailType": { ... },
         "topBlockReasons": [ ... ],
         "runtimeCases": [ ... ],
         "generatedAt": "2026-..."
       }
     }
========================================================= */
router.get("/deepseek/agent-bridge/execution-runtime-summary", (_req, res) => {
  try {
    const executionRuntime = getExecutionRuntimeSummary();
    return res.json({ success: true, version: "v1", executionRuntime });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/execution-runtime-summary error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading execution-runtime summary",
    });
  }
});

/* =========================================================
   POST /api/admin/deepseek/agent-bridge/conversation-message

   Step 21 – Agent Conversation Runtime / Persistent Case Chat /
   Freeform Admin Dialogue

   Accepts a free-form user message for an agent case and returns
   a contextual agent reply (DeepSeek or Gemini, depending on
   the message content and case context).

   Request body:
   {
     "agentCaseId":      "ac-...",       // required
     "userMessage":      "...",          // required – free-form text
     "replyToMessageId": "conv-...",     // optional – reply reference
     "quotedMessageId":  "conv-..."      // optional – quoted message
   }

   Response:
   {
     "success": true,
     "version": "v1",
     "threadId": "ac-...",
     "threadStatus": "thread_waiting_for_user",
     "conversationState": "conversation_phase",
     "userMessage": { ... },
     "agentReply": { ... },
     "crossAgentNote": "..." | null,
     "routing": { "speakerAgent": "deepseek", ... },
     "awaitingUserReply": true,
     "messageCount": 2
   }

   Cooperative, not autonomous.  The system answers –
   the user decides the next step.
========================================================= */
router.post("/deepseek/agent-bridge/conversation-message", (req, res) => {
  try {
    const { agentCaseId, userMessage, replyToMessageId, quotedMessageId } = req.body || {};
    if (!agentCaseId || !userMessage) {
      return res.status(400).json({
        success: false,
        error: "agentCaseId and userMessage are required",
      });
    }
    const result = sendUserMessage({
      agentCaseId,
      userMessage,
      replyToMessageId: replyToMessageId || null,
      quotedMessageId: quotedMessageId || null,
    });
    return res.json({ success: result.success, version: "v1", ...result });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/conversation-message error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error processing conversation message",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/conversation-thread

   Step 21 – Retrieve a conversation thread with all messages.

   Query parameters:
     agentCaseId  – required
     limit        – optional (default 50)

   Response:
   {
     "success": true,
     "version": "v1",
     "thread": {
       "threadId": "ac-...",
       "threadStatus": "thread_waiting_for_user",
       "messages": [ ... ],
       ...
     }
   }
========================================================= */
router.get("/deepseek/agent-bridge/conversation-thread", (req, res) => {
  try {
    const agentCaseId = req.query.agentCaseId;
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200));
    if (!agentCaseId) {
      return res.status(400).json({ success: false, error: "agentCaseId query parameter is required" });
    }
    const thread = getConversationThread({ agentCaseId, limit });
    if (!thread) {
      return res.json({ success: true, version: "v1", thread: null });
    }
    return res.json({ success: true, version: "v1", thread });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/conversation-thread error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading conversation thread",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/conversation-summary

   Step 21 – Summary across all conversation threads.

   Shows:
     - Total threads / open / waiting
     - Thread status distribution
     - Dominant agent distribution
     - Conversation state distribution
     - Message intent frequency
     - Per-thread summaries (most recent first)

   Response:
   {
     "success": true,
     "version": "v1",
     "conversationSummary": {
       "totalThreads": 5,
       "totalOpen": 3,
       "totalWaitingForUser": 2,
       ...
     }
   }
========================================================= */
router.get("/deepseek/agent-bridge/conversation-summary", (_req, res) => {
  try {
    const conversationSummary = getConversationSummary();
    return res.json({ success: true, version: "v1", conversationSummary });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/conversation-summary error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading conversation summary",
    });
  }
});

/* =========================================================
   POST /api/admin/deepseek/agent-bridge/trigger-handoff

   Step 22 – Multi-Agent Handoff / Cross-Agent Dialogue /
   Coordinated Case Exchange Light

   Explicitly triggers a cross-agent handoff within a
   conversation thread.  The primary agent initiates
   the handoff, the supporting agent provides a
   complementary reply, and the handoff is completed.

   Request body:
   {
     "agentCaseId":  "ac-...",        // required
     "targetAgent":  "gemini",        // optional – "deepseek" or "gemini"
     "reason":       "cross_layer_issue" // optional – one of VALID_HANDOFF_REASONS
   }

   Response:
   {
     "success": true,
     "version": "v1",
     "threadId": "ac-...",
     "handoffStatus": "handoff_completed",
     "crossAgentState": "cross_agent_completed",
     "handoffFrom": "deepseek",
     "handoffTo": "gemini",
     "handoffReason": "cross_layer_issue",
     "handoffCount": 1,
     "messagesAdded": 3,
     "supportingAgentReply": { ... }
   }

   Cooperative, not autonomous.  The system executes
   the handoff – the user retains control.
========================================================= */
router.post("/deepseek/agent-bridge/trigger-handoff", (req, res) => {
  try {
    const { agentCaseId, targetAgent, reason } = req.body || {};
    if (!agentCaseId) {
      return res.status(400).json({
        success: false,
        error: "agentCaseId is required",
      });
    }
    const result = triggerHandoff({ agentCaseId, targetAgent, reason });
    return res.json({ success: result.success, version: "v1", ...result });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/trigger-handoff error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error triggering handoff",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/handoff-summary

   Step 22 – Cross-Agent Handoff / Coordinated Dialogue
   summary across all conversation threads.

   Shows:
     - Total threads / threads with handoffs
     - Handoff direction distribution (DeepSeek→Gemini vs. Gemini→DeepSeek)
     - Handoff status distribution
     - Cross-agent state distribution
     - Handoff reason frequency
     - Per-thread handoff summaries (most recent first)

   Response:
   {
     "success": true,
     "version": "v1",
     "handoffSummary": {
       "totalThreads": 5,
       "totalWithHandoffs": 2,
       "totalHandoffs": 3,
       "totalDeepseekToGemini": 2,
       "totalGeminiToDeepseek": 1,
       ...
     }
   }
========================================================= */
router.get("/deepseek/agent-bridge/handoff-summary", (_req, res) => {
  try {
    const handoffSummary = getHandoffSummary();
    return res.json({ success: true, version: "v1", handoffSummary });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/handoff-summary error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading handoff summary",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/case-memory/:agentCaseId

   Step 23 – Conversation Memory / Case Continuity /
   Agent Memory Anchors for a specific case/thread.

   Returns the structured case memory including:
     - Working summary (human-readable)
     - Agreed direction / discarded directions
     - Open questions / resolved points
     - Case decisions / user preferences
     - Memory anchors
     - Continuity status / memory freshness
     - Dominant memory owner / contributors
     - Next open step

   Response:
   {
     "success": true,
     "version": "v1",
     "caseMemory": { ... }
   }

   Cooperative, not autonomous.  The system tracks
   case continuity – the user retains full control.
========================================================= */
router.get("/deepseek/agent-bridge/case-memory/:agentCaseId", (req, res) => {
  try {
    const { agentCaseId } = req.params;
    if (!agentCaseId) {
      return res.status(400).json({
        success: false,
        error: "agentCaseId is required",
      });
    }
    const result = getCaseMemory({ agentCaseId });
    if (!result) {
      return res.status(404).json({
        success: false,
        error: "No conversation thread found for this case",
      });
    }
    return res.json({ success: true, version: "v1", ...result });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/case-memory error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading case memory",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/case-memory-summary

   Step 23 – Case Memory / Continuity analytics summary
   across all conversation threads.

   Shows:
     - Total threads with memory / working summaries
     - Continuity status distribution
     - Memory freshness distribution
     - Dominant memory owner distribution
     - Memory focus distribution
     - Threads with open questions / agreed directions
     - Per-thread memory summaries (most recent first)

   Response:
   {
     "success": true,
     "version": "v1",
     "caseMemorySummary": {
       "totalThreads": 5,
       "totalWithMemory": 3,
       "totalWithWorkingSummary": 2,
       ...
     }
   }
========================================================= */
router.get("/deepseek/agent-bridge/case-memory-summary", (_req, res) => {
  try {
    const caseMemorySummary = getCaseMemorySummary();
    return res.json({ success: true, version: "v1", caseMemorySummary });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/case-memory-summary error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading case memory summary",
    });
  }
});

/* =========================================================
   Step 24: Action Negotiation / Option Comparison / Decision Framing
   Endpoints:
     GET  /api/admin/deepseek/agent-bridge/decision-frame/:agentCaseId
     GET  /api/admin/deepseek/agent-bridge/decision-frame-summary
   ========================================================= */

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/decision-frame/:agentCaseId

   Retrieves the decision frame (action options, comparison,
   recommendation, tradeoff) for a specific case thread.

   Response:
   {
     "success": true,
     "version": "v1",
     "decisionFrame": {
       "threadId": "case-abc",
       "decisionFrameStatus": "options_stable",
       "optionCount": 3,
       "actionOptions": [...],
       "recommendedOptionId": "opt-case-abc-2",
       ...
     }
   }
========================================================= */
router.get("/deepseek/agent-bridge/decision-frame/:agentCaseId", (req, res) => {
  try {
    const { agentCaseId } = req.params;
    if (!agentCaseId) {
      return res.status(400).json({ success: false, error: "agentCaseId parameter required" });
    }

    const result = getDecisionFrame({ agentCaseId });
    if (!result) {
      return res.status(404).json({ success: false, error: "No decision frame found for this case" });
    }

    return res.json({ success: true, version: "v1", decisionFrame: result });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/decision-frame error", {
      message: error.message,
      stack: error.stack,
      agentCaseId: req.params.agentCaseId,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading decision frame",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/decision-frame-summary

   Returns analytics across all threads with decision frames:
   how many have stable options, recommendations, tradeoffs,
   user decisions needed, cross-agent decisions, etc.

   Response:
   {
     "success": true,
     "version": "v1",
     "decisionFrameSummary": {
       "totalThreads": 10,
       "totalWithOptions": 7,
       "totalWithRecommendation": 5,
       ...
     }
   }
========================================================= */
router.get("/deepseek/agent-bridge/decision-frame-summary", (_req, res) => {
  try {
    const decisionFrameSummary = getDecisionFrameSummary();
    return res.json({ success: true, version: "v1", decisionFrameSummary });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/decision-frame-summary error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading decision frame summary",
    });
  }
});

/* =========================================================
   Konferenz Step A: DeepSeek ↔ Gemini – Conference Session /
   Targeting / Mode / Summary
   Endpoints:
     POST /api/admin/deepseek/agent-bridge/conference-session
     POST /api/admin/deepseek/agent-bridge/conference-message
     PUT  /api/admin/deepseek/agent-bridge/conference-session
     POST /api/admin/deepseek/agent-bridge/conference-close
     GET  /api/admin/deepseek/agent-bridge/conference-session/:conferenceId
     GET  /api/admin/deepseek/agent-bridge/conference-summary/:conferenceId
     GET  /api/admin/deepseek/agent-bridge/conference-workspace
     GET  /api/admin/deepseek/agent-bridge/conference-admin-summary
   ========================================================= */

/* =========================================================
   POST /api/admin/deepseek/agent-bridge/conference-session

   Open a new conference session or resume an existing one.

   Request body:
   {
     "conferenceId":    "conf-...",      // optional – resume existing
     "conferenceMode":  "work_chat",     // optional – work_chat | problem_solving | decision_mode
     "relatedCaseId":   "ac-...",        // optional – link to agent case
     "conferenceFocus": "...",           // optional – human-readable focus
     "conferenceOwner": "admin"          // optional – who opens
   }

   Response:
   {
     "success": true,
     "conferenceId": "conf-...",
     "session": { ... },
     "resumed": false
   }
========================================================= */
router.post("/deepseek/agent-bridge/conference-session", (req, res) => {
  try {
    const { conferenceId, conferenceMode, relatedCaseId, conferenceFocus, conferenceOwner } = req.body || {};
    const result = openConferenceSession({
      conferenceId: conferenceId || null,
      conferenceMode: conferenceMode || "work_chat",
      relatedCaseId: relatedCaseId || null,
      conferenceFocus: conferenceFocus || null,
      conferenceOwner: conferenceOwner || "admin",
    });
    return res.json(result);
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/conference-session POST error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error opening conference session",
    });
  }
});

/* =========================================================
   POST /api/admin/deepseek/agent-bridge/conference-message

   Send a message to a conference session with clean agent targeting.

   Request body:
   {
     "conferenceId":     "conf-...",     // required
     "userMessage":      "...",          // required – free-form text
     "targetAgent":      "deepseek",     // optional – deepseek | gemini | both | system
     "replyToMessageId": "cfm-..."       // optional – reply reference
   }

   Response:
   {
     "success": true,
     "conferenceId": "conf-...",
     "conferenceStatus": "session_active",
     "conferenceMode": "work_chat",
     "userMessage": { ... },
     "agentReplies": [ ... ],
     "routing": { "targetAgent": "deepseek", "routingReason": "..." },
     "messageCount": 3
   }
========================================================= */
router.post("/deepseek/agent-bridge/conference-message", (req, res) => {
  try {
    const { conferenceId, userMessage, targetAgent, replyToMessageId } = req.body || {};
    if (!conferenceId || !userMessage) {
      return res.status(400).json({
        success: false,
        error: "conferenceId and userMessage are required",
      });
    }
    const result = sendConferenceMessage({
      conferenceId,
      userMessage,
      targetAgent: targetAgent || null,
      replyToMessageId: replyToMessageId || null,
    });
    if (!result.success) {
      return res.status(result.error === "Conference session not found" ? 404 : 400).json(result);
    }
    return res.json(result);
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/conference-message POST error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error sending conference message",
    });
  }
});

/* =========================================================
   PUT /api/admin/deepseek/agent-bridge/conference-session

   Update conference session status, mode, focus, or case binding.

   Request body:
   {
     "conferenceId":     "conf-...",       // required
     "conferenceStatus": "session_paused", // optional
     "conferenceMode":   "decision_mode",  // optional
     "conferenceFocus":  "...",            // optional
     "relatedCaseId":    "ac-..."          // optional
   }

   Response:
   {
     "success": true,
     "conferenceId": "conf-...",
     "session": { ... },
     "changes": [ "Modus: work_chat → decision_mode" ]
   }
========================================================= */
router.put("/deepseek/agent-bridge/conference-session", (req, res) => {
  try {
    const { conferenceId, conferenceStatus, conferenceMode, conferenceFocus, relatedCaseId } = req.body || {};
    if (!conferenceId) {
      return res.status(400).json({ success: false, error: "conferenceId is required" });
    }
    const result = updateConferenceSession({
      conferenceId,
      conferenceStatus: conferenceStatus || null,
      conferenceMode: conferenceMode || null,
      conferenceFocus: conferenceFocus !== undefined ? conferenceFocus : null,
      relatedCaseId: relatedCaseId !== undefined ? relatedCaseId : null,
    });
    if (!result.success) {
      return res.status(result.error === "Conference session not found" ? 404 : 400).json(result);
    }
    return res.json(result);
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/conference-session PUT error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error updating conference session",
    });
  }
});

/* =========================================================
   POST /api/admin/deepseek/agent-bridge/conference-close

   Close or archive a conference session.

   Request body:
   {
     "conferenceId": "conf-...",  // required
     "archive":      false        // optional – if true, archive instead of close
   }

   Response:
   {
     "success": true,
     "conferenceId": "conf-...",
     "conferenceStatus": "session_closed",
     "closedAt": "2026-04-07T..."
   }
========================================================= */
router.post("/deepseek/agent-bridge/conference-close", (req, res) => {
  try {
    const { conferenceId, archive } = req.body || {};
    if (!conferenceId) {
      return res.status(400).json({ success: false, error: "conferenceId is required" });
    }
    const result = closeConferenceSession({
      conferenceId,
      archive: !!archive,
    });
    if (!result.success) {
      return res.status(result.error === "Conference session not found" ? 404 : 400).json(result);
    }
    return res.json(result);
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/conference-close error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error closing conference session",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/conference-session/:conferenceId

   Retrieve a conference session with recent messages.

   Query params:
     limit – max messages to return (default 50)

   Response:
   {
     "success": true,
     "version": "v1",
     "session": { ... , messages: [ ... ] }
   }
========================================================= */
router.get("/deepseek/agent-bridge/conference-session/:conferenceId", (req, res) => {
  try {
    const { conferenceId } = req.params;
    const limit = parseInt(req.query.limit, 10) || 50;
    if (!conferenceId) {
      return res.status(400).json({ success: false, error: "conferenceId parameter required" });
    }
    const session = getConferenceSession({ conferenceId, limit });
    if (!session) {
      return res.status(404).json({ success: false, error: "Conference session not found" });
    }
    return res.json({ success: true, version: "v1", session });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/conference-session GET error", {
      message: error.message,
      stack: error.stack,
      conferenceId: req.params.conferenceId,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading conference session",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/conference-summary/:conferenceId

   Generate a human-readable conference summary.
   Not a raw data dump – structured, cooperative, readable.

   Response:
   {
     "success": true,
     "version": "v1",
     "summary": {
       "conferenceId": "conf-...",
       "status": "Aktiv",
       "modus": "Arbeitschat",
       "currentFocus": "...",
       "understood": "...",
       "direction": "...",
       "leadingAgent": "...",
       "openPoints": [...],
       "nextStep": "...",
       ...
     }
   }
========================================================= */
router.get("/deepseek/agent-bridge/conference-summary/:conferenceId", (req, res) => {
  try {
    const { conferenceId } = req.params;
    if (!conferenceId) {
      return res.status(400).json({ success: false, error: "conferenceId parameter required" });
    }
    const summary = getConferenceSummary({ conferenceId });
    if (!summary) {
      return res.status(404).json({ success: false, error: "Conference session not found" });
    }
    return res.json({ success: true, version: "v1", summary });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/conference-summary error", {
      message: error.message,
      stack: error.stack,
      conferenceId: req.params.conferenceId,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error generating conference summary",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/conference-workspace

   Load full conference workspace data for frontend:
   active sessions, paused sessions, recent closed sessions, stats.

   Response:
   {
     "success": true,
     "totalSessions": 5,
     "activeSessions": [...],
     "pausedSessions": [...],
     "recentClosed": [...],
     "activeCount": 2,
     "pausedCount": 1,
     ...
   }
========================================================= */
router.get("/deepseek/agent-bridge/conference-workspace", (_req, res) => {
  try {
    const workspace = getConferenceWorkspace();
    return res.json(workspace);
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/conference-workspace error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error loading conference workspace",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/conference-admin-summary

   Admin analytics across all conference sessions:
   how many active, paused, closed, in decision mode, etc.

   Response:
   {
     "success": true,
     "version": "v1",
     "conferenceSummary": {
       "totalSessions": 10,
       "totalActive": 3,
       "totalInDecisionMode": 2,
       ...
     }
   }
========================================================= */
router.get("/deepseek/agent-bridge/conference-admin-summary", (_req, res) => {
  try {
    const conferenceSummary = getConferenceAdminSummary();
    return res.json({ success: true, version: "v1", conferenceSummary });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/conference-admin-summary error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading conference admin summary",
    });
  }
});

/* =========================================================
   Konferenz Step B: Coordination / Moderation / Coordinated Reply Flow
   ========================================================= */

/* =========================================================
   POST /api/admin/deepseek/agent-bridge/conference-coordinated-message
   Send a coordinated conference message with reply pattern support.

   Request body:
   {
     "conferenceId":          "conf-1234",     // required
     "userMessage":           "...",            // required
     "targetAgent":           "both",           // optional
     "replyToMessageId":      "cfm-...",        // optional
     "requestedReplyPattern": "bundled_reply"   // optional – override
   }

   Response:
   {
     "success": true,
     "conferenceId": "conf-1234",
     "conferenceStatus": "session_active",
     "conferenceMode": "problem_solving",
     "userMessage": { ... },
     "agentReplies": [ ... ],
     "coordinatorMessages": [ ... ],
     "coordination": {
       "replyPattern": "supporting_reply",
       "coordinationState": "support_active",
       "leadAgent": "deepseek",
       "supportAgent": "gemini",
       "phaseStatus": "phase_open",
       "openPointCount": 0
     },
     "routing": { ... },
     "messageCount": 5
   }
========================================================= */
router.post("/deepseek/agent-bridge/conference-coordinated-message", (req, res) => {
  try {
    const {
      conferenceId,
      userMessage,
      targetAgent = null,
      replyToMessageId = null,
      requestedReplyPattern = null,
    } = req.body || {};

    const result = sendCoordinatedConferenceMessage({
      conferenceId,
      userMessage,
      targetAgent,
      replyToMessageId,
      requestedReplyPattern,
    });

    return res.json(result);
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/conference-coordinated-message error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error sending coordinated conference message",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/conference-coordination-summary
   Coordination analytics across all conference sessions.

   Response:
   {
     "success": true,
     "version": "v1",
     "coordinationSummary": {
       "totalSessions": 5,
       "byCoordinationState": { ... },
       "byReplyPattern": { ... },
       "byPhaseStatus": { ... },
       "replyStats": { ... },
       "coordinationStats": { ... }
     }
   }
========================================================= */
router.get("/deepseek/agent-bridge/conference-coordination-summary", (_req, res) => {
  try {
    const coordinationSummary = getConferenceCoordinationSummary();
    return res.json({ success: true, version: "v1", coordinationSummary });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/conference-coordination-summary error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading conference coordination summary",
    });
  }
});

/* =========================================================
   GET /api/admin/deepseek/agent-bridge/conference-phase-digest/:conferenceId
   Phase digest (Ergebnisverdichtung) for a specific conference session.

   Response:
   {
     "success": true,
     "version": "v1",
     "phaseDigest": {
       "conferenceId": "conf-1234",
       "phaseStatus": "recommendation_ready",
       "understood": "...",
       "direction": "...",
       "differences": "...",
       "decisionPending": false,
       "openPoints": [...],
       "nextStep": "...",
       ...
     }
   }
========================================================= */
router.get("/deepseek/agent-bridge/conference-phase-digest/:conferenceId", (req, res) => {
  try {
    const { conferenceId } = req.params;
    const phaseDigest = getConferencePhaseDigest({ conferenceId });
    if (!phaseDigest) {
      return res.status(404).json({ success: false, error: "Conference session not found or no digest available" });
    }
    return res.json({ success: true, version: "v1", phaseDigest });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/conference-phase-digest error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading conference phase digest",
    });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
   Konferenz Step C: Conference Phases / Decision Room / Result Cards / Strategic Expansion
   ─────────────────────────────────────────────────────────────────────────
   Endpoints:
     POST /api/admin/deepseek/agent-bridge/conference-advance-phase
     GET  /api/admin/deepseek/agent-bridge/conference-result-card/:conferenceId
     GET  /api/admin/deepseek/agent-bridge/conference-decision-room/:conferenceId
     GET  /api/admin/deepseek/agent-bridge/conference-perspective-comparison/:conferenceId
     GET  /api/admin/deepseek/agent-bridge/conference-step-c-summary
   ───────────────────────────────────────────────────────────────────────── */

/**
 * POST /api/admin/deepseek/agent-bridge/conference-advance-phase
 *
 * Manually advance a conference session to a specific work phase.
 * Operator/admin-controlled – no automatic execution.
 *
 * Body:
 *   "conferenceId":  "conf-...",     // required
 *   "targetPhase":   "option_room",  // required – one of VALID_CONFERENCE_WORK_PHASES
 *
 * Returns:
 *   { success, conferenceId, from, to, reason, workPhase, moderationSignal, handoffDirection }
 */
router.post("/deepseek/agent-bridge/conference-advance-phase", (req, res) => {
  try {
    const { conferenceId, targetPhase } = req.body || {};
    if (!conferenceId || !targetPhase) {
      return res.status(400).json({
        success: false,
        error: "conferenceId and targetPhase are required",
        validPhases: VALID_CONFERENCE_WORK_PHASES,
      });
    }
    const result = advanceConferencePhase({ conferenceId, targetPhase });
    if (!result.success) {
      return res.status(result.error === "Conference session not found" ? 404 : 400).json(result);
    }
    return res.json(result);
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/conference-advance-phase error", {
      error: error.message,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error advancing conference phase",
    });
  }
});

/**
 * GET /api/admin/deepseek/agent-bridge/conference-result-card/:conferenceId
 *
 * Get the current result card for a specific conference session.
 * Structured per-phase result: what was understood, consensus, differences, next step.
 *
 * Returns:
 *   { success, resultCard: { resultCardId, workPhase, understood, direction, consensusState,
 *     remainingDifferences, openPoints, nextStep, handoffNeeded, handoffDirection, ... } }
 */
router.get("/deepseek/agent-bridge/conference-result-card/:conferenceId", (req, res) => {
  try {
    const { conferenceId } = req.params;
    if (!conferenceId) {
      return res.status(400).json({ success: false, error: "conferenceId parameter required" });
    }
    const resultCard = getConferenceResultCard({ conferenceId });
    if (!resultCard) {
      return res.status(404).json({ success: false, error: "Conference session not found" });
    }
    return res.json({ success: true, version: "v1", resultCard });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/conference-result-card error", {
      error: error.message,
      conferenceId: req.params.conferenceId,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading conference result card",
    });
  }
});

/**
 * GET /api/admin/deepseek/agent-bridge/conference-decision-room/:conferenceId
 *
 * Get the decision room state for a specific conference session.
 * Includes: active options, recommended direction, tradeoff, consensus state, handoff direction.
 *
 * Returns:
 *   { success, decisionRoom: { decisionRoomActive, decisionRoomState, consensusState,
 *     handoffDirection, moderationSignal, optionRoomOptions, ... } }
 */
router.get("/deepseek/agent-bridge/conference-decision-room/:conferenceId", (req, res) => {
  try {
    const { conferenceId } = req.params;
    if (!conferenceId) {
      return res.status(400).json({ success: false, error: "conferenceId parameter required" });
    }
    const decisionRoom = getConferenceDecisionRoom({ conferenceId });
    if (!decisionRoom) {
      return res.status(404).json({ success: false, error: "Conference session not found" });
    }
    return res.json({ success: true, version: "v1", decisionRoom });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/conference-decision-room error", {
      error: error.message,
      conferenceId: req.params.conferenceId,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading conference decision room",
    });
  }
});

/**
 * GET /api/admin/deepseek/agent-bridge/conference-perspective-comparison/:conferenceId
 *
 * Get the lightweight perspective comparison between DeepSeek and Gemini for a conference session.
 * Not a model battle – a structured view of agreement and remaining differences.
 *
 * Returns:
 *   { success, perspectiveComparison: { deepseekView, geminiView, commonLine, dissent, consensusState } }
 */
router.get("/deepseek/agent-bridge/conference-perspective-comparison/:conferenceId", (req, res) => {
  try {
    const { conferenceId } = req.params;
    if (!conferenceId) {
      return res.status(400).json({ success: false, error: "conferenceId parameter required" });
    }
    const perspectiveComparison = getConferencePerspectiveComparison({ conferenceId });
    if (!perspectiveComparison) {
      return res.status(404).json({
        success: false,
        error: "Conference session not found or no perspective comparison available yet (both agents need at least one message each)",
      });
    }
    return res.json({ success: true, version: "v1", perspectiveComparison });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/conference-perspective-comparison error", {
      error: error.message,
      conferenceId: req.params.conferenceId,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading conference perspective comparison",
    });
  }
});

/**
 * GET /api/admin/deepseek/agent-bridge/conference-step-c-summary
 *
 * Admin analytics across all conference sessions – Step C extension.
 * Aggregates: work phase distribution, decision room stats, consensus/dissent,
 * handoff directions, moderation signals, result card counts.
 *
 * Returns:
 *   { success, stepCSummary: { totalSessions, byWorkPhase, byDecisionRoomState,
 *     byConsensusState, byHandoffDirection, byModerationSignal, highlights, ... } }
 */
router.get("/deepseek/agent-bridge/conference-step-c-summary", (_req, res) => {
  try {
    const stepCSummary = getConferenceStepCSummary();
    return res.json({ success: true, version: "v1", stepCSummary });
  } catch (error) {
    logger.error("[admin] deepseek/agent-bridge/conference-step-c-summary error", {
      error: error.message,
    });
    return res.status(500).json({
      success: false,
      error: error.message || "Internal error reading conference Step C summary",
    });
  }
});

module.exports = router;
