"use strict";

const express = require("express");
const router = express.Router();

const { discoverStocks } = require("../services/discoveryEngine.service");

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

/**
 * GET /api/discovery?limit=10&fresh=1
 * - fresh=1 ist optional (Alias; die Engine nutzt sowieso Cooldown)
 */
router.get("/", async (req, res) => {
  try {
    const limit = clamp(Number(req.query.limit || 10), 1, 25);

    // fresh ist optional; aktuell übernimmt das schon die Engine per Cooldown
    const fresh = String(req.query.fresh || "").trim() === "1";

    const stocks = await discoverStocks(limit);

    return res.json({
      success: true,
      count: stocks.length,
      discoveries: stocks,
      meta: {
        limit,
        fresh,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

module.exports = router;
