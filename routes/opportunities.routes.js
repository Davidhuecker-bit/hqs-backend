"use strict";

const express = require("express");
const router = express.Router();

const { getTopOpportunities } = require("../services/opportunityScanner.service");
const { classifyMarketRegime } = require("../services/regimeDetection.service");
const {
  badRequest,
  parseEnum,
  parseInteger,
  parseNumber,
} = require("../utils/requestValidation");

/**
 * GET /api/opportunities?limit=10&minHqs=70&regime=bull
 */
router.get("/", async (req, res) => {
  try {
    const limitResult = parseInteger(req.query.limit, {
      defaultValue: 10,
      min: 1,
      max: 25,
      label: "limit",
    });
    if (limitResult.error) {
      return badRequest(res, limitResult.error);
    }

    const minHqsResult = parseNumber(req.query.minHqs, {
      defaultValue: null,
      min: 0,
      max: 100,
      label: "minHqs",
    });
    if (minHqsResult.error) {
      return badRequest(res, minHqsResult.error);
    }

    const regimeResult = parseEnum(
      req.query.regime,
      ["bull", "bear", "neutral", "expansion", "crash", "bullish", "bearish"],
      {
        defaultValue: null,
        label: "regime",
      }
    );
    if (regimeResult.error) {
      return badRequest(res, regimeResult.error);
    }

    const limit = limitResult.value;
    const minHqs = minHqsResult.value;
    const regime = regimeResult.value;

    // Fetch regime classification in parallel with opportunities
    const [opportunities, marketRegime] = await Promise.all([
      getTopOpportunities({ limit, minHqs, regime }),
      classifyMarketRegime().catch(() => null),
    ]);

    return res.json({
      success: true,
      count: opportunities.length,
      marketRegime: marketRegime
        ? {
            cluster: marketRegime.cluster,
            avgHqs: marketRegime.avgHqs,
            bearRatio: marketRegime.bearRatio,
            highVolRatio: marketRegime.highVolRatio,
            capturedAt: marketRegime.capturedAt,
          }
        : null,
      opportunities,
      meta: {
        limit,
        minHqs,
        regime,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

module.exports = router;
