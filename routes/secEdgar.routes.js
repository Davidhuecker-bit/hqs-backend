"use strict";

const express = require("express");

const {
  getSecEdgarSnapshotBySymbol,
} = require("../services/secEdgar.service");
const {
  badRequest,
  parseBoolean,
  parseInteger,
  parseSymbol,
} = require("../utils/requestValidation");

const logger = require("../utils/logger");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const symbolResult = parseSymbol(req.query.symbol, {
      required: true,
      label: "symbol",
    });
    if (symbolResult.error) {
      return badRequest(res, symbolResult.error);
    }

    const filingLimitResult = parseInteger(req.query.filingLimit, {
      defaultValue: 10,
      min: 1,
      max: 25,
      label: "filingLimit",
    });
    if (filingLimitResult.error) {
      return badRequest(res, filingLimitResult.error);
    }

    const factLimitResult = parseInteger(req.query.factLimit, {
      defaultValue: 25,
      min: 1,
      max: 100,
      label: "factLimit",
    });
    if (factLimitResult.error) {
      return badRequest(res, factLimitResult.error);
    }

    const refreshResult = parseBoolean(req.query.refresh, {
      defaultValue: false,
      label: "refresh",
    });
    if (refreshResult.error) {
      return badRequest(res, refreshResult.error);
    }

    const symbol = symbolResult.value;
    const filingLimit = filingLimitResult.value;
    const factLimit = factLimitResult.value;
    const refresh = refreshResult.value;

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
