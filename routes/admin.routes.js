"use strict";

const express = require("express");

const { getAdminInsights } = require("../services/adminInsights.service");
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

async function buildAdminStack() {
  const insights = await getAdminInsights();
  const diagnostics = buildAdminDiagnostics(insights);
  const validation = buildAdminValidation(insights, diagnostics);
  const tuning = buildAdminTuning(insights, diagnostics, validation);

  // V1: echte Admin-Historie ist noch nicht persistent gespeichert.
  // Deshalb nutzen wir vorerst den aktuellen Stand als Platzhalter
  // für 24h / 7d / 30d, damit die Struktur schon vollständig steht.
  const trends = buildAdminTrends({
    current: { insights, diagnostics, validation, tuning },
    previous24h: { insights, diagnostics, validation, tuning },
    previous7d: { insights, diagnostics, validation, tuning },
    previous30d: { insights, diagnostics, validation, tuning },
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
    const data = await buildAdminStack();

    return res.json({
      success: true,
      ...data,
    });
  } catch (error) {
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
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;
