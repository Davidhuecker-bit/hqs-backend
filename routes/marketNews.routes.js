"use strict";

const express = require("express");
const router = express.Router();

const { normalizeSymbols } = require("../services/marketNews.service");
const { loadLatestMarketNewsBySymbols } = require("../services/marketNews.repository");
const logger = require("../utils/logger");

function normalizeLimit(limitPerSymbol) {
  const limit = Number(limitPerSymbol);
  if (!Number.isFinite(limit)) return 5;
  return Math.max(1, Math.min(Math.trunc(limit), 25));
}

router.get("/", async (req, res) => {
  try {
    const symbols = normalizeSymbols(String(req.query.symbols || "").split(","));
    const limit = normalizeLimit(req.query.limit);

    if (!symbols.length) {
      return res.status(400).json({
        success: false,
        message: 'The "symbols" query parameter is required',
      });
    }

    const newsBySymbol = await loadLatestMarketNewsBySymbols(symbols, limit);

    return res.json({
      success: true,
      symbols,
      count: Object.values(newsBySymbol || {}).reduce(
        (sum, items) => sum + (Array.isArray(items) ? items.length : 0),
        0
      ),
      newsBySymbol,
    });
  } catch (error) {
    logger.error("Market news route error", {
      message: error.message,
      stack: error.stack,
    });

    return res.status(500).json({
      success: false,
      message: "An unexpected error occurred while fetching market news. Please try again later.",
    });
  }
});

module.exports = router;
