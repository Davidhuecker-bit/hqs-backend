"use strict";

const express = require("express");

const { getAdminInsights } = require("../services/adminInsights.service");
const { buildAdminDiagnostics } = require("../engines/adminDiagnostics.engine");
const { buildAdminValidation } = require("../engines/adminValidation.engine");
const { buildAdminTuning } = require("../engines/adminTuning.engine");
const { buildAdminRecommendations } = require("../engines/adminRecommendations.engine");

const router = express.Router();

router.get("/overview", async (req, res) => {
  try {
    const insights = await getAdminInsights();
    const diagnostics = buildAdminDiagnostics(insights);
    const validation = buildAdminValidation(insights, diagnostics);
    const tuning = buildAdminTuning(insights, diagnostics, validation);
    const recommendations = buildAdminRecommendations({
      insights,
      diagnostics,
      validation,
      tuning,
    });

    return res.json({
      success: true,
      insights,
      diagnostics,
      validation,
      tuning,
      recommendations,
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
    const insights = await getAdminInsights();
    const diagnostics = buildAdminDiagnostics(insights);

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
    const insights = await getAdminInsights();
    const diagnostics = buildAdminDiagnostics(insights);
    const validation = buildAdminValidation(insights, diagnostics);

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
    const insights = await getAdminInsights();
    const diagnostics = buildAdminDiagnostics(insights);
    const validation = buildAdminValidation(insights, diagnostics);
    const tuning = buildAdminTuning(insights, diagnostics, validation);

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

router.get("/recommendations", async (req, res) => {
  try {
    const insights = await getAdminInsights();
    const diagnostics = buildAdminDiagnostics(insights);
    const validation = buildAdminValidation(insights, diagnostics);
    const tuning = buildAdminTuning(insights, diagnostics, validation);
    const recommendations = buildAdminRecommendations({
      insights,
      diagnostics,
      validation,
      tuning,
    });

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

module.exports = router;
