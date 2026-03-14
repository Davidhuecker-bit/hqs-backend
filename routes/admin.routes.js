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

module.exports = router;
