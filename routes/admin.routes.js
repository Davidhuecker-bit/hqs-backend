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
const { getAgentWeights, adjustAgentWeights } = require("../services/causalMemory.repository");
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

const router = express.Router();

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
    const data = await buildAdminStack({ persistSnapshot: true });
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
    const rows = Array.isArray(portfolio) ? portfolio : (portfolio?.items || []);

    const ranked = rankPortfolioAntifragility(
      rows.map((item) => ({
        symbol: item.symbol,
        snapshot: {
          hqsScore:    item.hqs_score    ?? item.hqsScore    ?? 0,
          entryPrice:  item.entry_price  ?? item.entryPrice  ?? 0,
          features: {
            momentum:       item.momentum       ?? 0,
            quality:        item.quality        ?? 0,
            stability:      item.stability      ?? 0,
            relative:       item.relative       ?? 0,
            volatility:     item.volatility     ?? 0,
            trendStrength:  item.trend_strength ?? item.trendStrength  ?? 0,
            relativeVolume: item.relative_volume ?? item.relativeVolume ?? 0,
            liquidityScore: item.liquidity_score ?? item.liquidityScore ?? 0,
          },
          signalContext: {
            signalStrength:       item.signal_strength       ?? item.signalStrength       ?? 0,
            trendScore:           item.trend_score           ?? item.trendScore           ?? 0,
            signalDirectionScore: item.signal_direction_score ?? item.signalDirectionScore ?? 0,
            signalConfidence:     item.signal_confidence     ?? item.signalConfidence     ?? 0,
            buzzScore:            item.buzz_score            ?? item.buzzScore            ?? 50,
            sentimentScore:       item.sentiment_score       ?? item.sentimentScore       ?? 0,
          },
          orchestrator: {
            opportunityStrength:    item.opportunity_strength    ?? item.opportunityStrength    ?? 0,
            orchestratorConfidence: item.orchestrator_confidence ?? item.orchestratorConfidence ?? 0,
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

const { getPipelineStatus, getPipelineStatusWithPersistence } = require("../services/marketService");

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

const { runTableHealthCheck } = require("../services/tableHealth.service");

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

module.exports = router;
