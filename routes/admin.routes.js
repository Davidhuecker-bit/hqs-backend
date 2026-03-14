"use strict";

const express = require("express");
const logger = require("../utils/logger");

const { getAdminInsights } = require("../services/adminInsights.service");
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

module.exports = router;
