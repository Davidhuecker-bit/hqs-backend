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
  const insights = await getAdminInsights();
  const diagnostics = buildAdminDiagnostics(insights);
  const validation = buildAdminValidation(insights, diagnostics);
  const tuning = buildAdminTuning(insights, diagnostics, validation);

  const currentState = createAdminState({
    insights,
    diagnostics,
    validation,
    tuning,
  });

  const [previous24h, previous7d, previous30d] = await Promise.all([
    loadAdminSnapshotBefore("24 hours"),
    loadAdminSnapshotBefore("7 days"),
    loadAdminSnapshotBefore("30 days"),
  ]);

  const trends = buildAdminTrends({
    current: currentState,
    previous24h: previous24h || currentState,
    previous7d: previous7d || currentState,
    previous30d: previous30d || currentState,
  });

  const alerts = buildAdminAlerts({
    insights,
    diagnostics,
    validation,
    tuning,
    trends,
  });

  const priorities = buildAdminPriorities({
    insights,
    diagnostics,
    validation,
    tuning,
    alerts,
  });

  const targets = buildAdminTargets({
    insights,
    diagnostics,
    validation,
  });

  const causality = buildAdminCausality({
    insights,
    diagnostics,
    validation,
    targets,
  });

  const release = buildAdminRelease({
    diagnostics,
    validation,
    priorities,
    targets,
    causality,
  });

  const recommendations = buildAdminRecommendations({
    insights,
    diagnostics,
    validation,
    tuning,
  });

  const briefing = buildAdminBriefing({
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
  });

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

    return res.json({
      success: true,
      ...data,
    });
  } catch (error) {
    logger.error("Admin overview route error", { message: error.message });
    return res.status(500).json({
      success: false,
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
    markEntriesSeen().catch(() => {});
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

module.exports = router;
