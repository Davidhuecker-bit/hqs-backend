"use strict";

const express = require("express");
const router = express.Router();

const { getTopOpportunities } = require("../services/opportunityScanner.service");

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

/**
 * GET /api/opportunities?limit=10&minHqs=70&regime=bull
 */
router.get("/", async (req, res) => {
  try {
    const limit = clamp(Number(req.query.limit || 10), 1, 25);

    const minHqsRaw = req.query.minHqs;
    const minHqs = minHqsRaw === undefined ? null : clamp(Number(minHqsRaw), 0, 100);

    const regimeRaw = String(req.query.regime || "").trim().toLowerCase();
    const regime = regimeRaw ? regimeRaw : null;

    // Service ist abwärts-kompatibel:
    // - wenn er nur (limit) erwartet, ignoriert er die extra args nicht,
    //   weil wir sie als options übergeben.
    const opportunities = await getTopOpportunities({
      limit,
      minHqs,
      regime,
    });

    return res.json({
      success: true,
      count: opportunities.length,
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
