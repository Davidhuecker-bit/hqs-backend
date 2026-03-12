"use strict";

const express = require("express");
const router = express.Router();

const { normalizeSymbols } = require("../services/marketNews.service");
const { loadLatestMarketNewsBySymbols } = require("../services/marketNews.repository");

function normalizeLimit(limitPerSymbol) {
  const limit = Number(limitPerSymbol);
  if (!Number.isFinite(limit)) return 5;
  return Math.max(1, Math.min(Math.trunc(limit), 100));
}

router.get("/", async (req, res) => {
  try {
    const symbols = normalizeSymbols(String(req.query.symbols || "").split(","));
    const limit = normalizeLimit(req.query.limit);

    if (!symbols.length) {
      return res.status(400).json({
        success: false,
        message: "symbols query parameter is required",
      });
    }

    const newsBySymbol = await loadLatestMarketNewsBySymbols(symbols, limit);

    return res.json({
      success: true,
      symbols,
      count: Object.values(newsBySymbol).reduce((sum, items) => sum + items.length, 0),
      newsBySymbol,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;
