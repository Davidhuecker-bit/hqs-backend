"use strict";

const express = require("express");
const router = express.Router();

const {
  getTopOpportunities,
} = require("../services/opportunityScanner.service");

/**
 * GET /api/opportunities
 */
router.get("/", async (req, res) => {
  try {
    const limit = Number(req.query.limit || 10);

    const opportunities = await getTopOpportunities(limit);

    return res.json({
      success: true,
      count: opportunities.length,
      opportunities,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

module.exports = router;
