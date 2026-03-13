"use strict";

const express = require("express");

const {
  getSecEdgarSnapshotBySymbol,
} = require("../services/secEdgar.service");

const logger = require("../utils/logger");

const router = express.Router();

function normalizeLimit(value, fallback, maxValue) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(Math.trunc(numeric), maxValue));
}

router.get("/", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").trim().toUpperCase();
    const filingLimit = normalizeLimit(req.query.filingLimit, 10, 25);
    const factLimit = normalizeLimit(req.query.factLimit, 25, 100);
    const refresh = String(req.query.refresh || "false").toLowerCase() === "true";

    if (!symbol) {
      return res.status(400).json({
        success: false,
        message: 'The "symbol" query parameter is required',
      });
    }

    const snapshot = await getSecEdgarSnapshotBySymbol(symbol, {
      filingLimit,
      factLimit,
      refresh,
    });

    if (!snapshot) {
      return res.status(404).json({
        success: false,
        message: `No SEC EDGAR data stored for symbol ${symbol}. Retry with refresh=true.`,
      });
    }

    return res.json({
      success: true,
      symbol,
      filingLimit,
      factLimit,
      refreshed: refresh,
      data: snapshot,
    });
  } catch (error) {
    logger.error("SEC EDGAR route error", {
      message: error.message,
      stack: error.stack,
    });

    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to fetch SEC EDGAR data",
    });
  }
});

module.exports = router;
