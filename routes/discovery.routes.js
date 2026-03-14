"use strict";

const express = require("express");
const router = express.Router();

const { discoverStocks } = require("../services/discoveryEngine.service");
const {
  badRequest,
  parseBoolean,
  parseInteger,
} = require("../utils/requestValidation");

/**
 * GET /api/discovery?limit=10&fresh=1
 * - fresh=1 ist optional (Alias; die Engine nutzt sowieso Cooldown)
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

    const freshResult = parseBoolean(req.query.fresh, {
      defaultValue: false,
      label: "fresh",
    });
    if (freshResult.error) {
      return badRequest(res, freshResult.error);
    }

    const limit = limitResult.value;
    const fresh = freshResult.value;

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
