"use strict";

const express = require("express");
const router = express.Router();

const { loadLatestMarketNewsBySymbols } = require("../services/marketNews.repository");
const { normalizeSymbols } = require("../services/marketNews.service");
const logger = require("../utils/logger");

function clampNewsLimit(value) {
  const limit = Number(value);
  if (!Number.isFinite(limit)) return 5;
  return Math.max(1, Math.min(Math.trunc(limit), 25));
}

function formatNewsItem(item) {
  return {
    symbol: item?.symbol ?? null,
    title: item?.title ?? null,
    url: item?.url ?? null,
    source: item?.source ?? null,
    publishedAt: item?.publishedAt ?? null,
    summary: item?.summaryRaw ?? null,
  };
}

router.get("/", async (req, res) => {
  try {
    const rawSymbols = Array.isArray(req.query.symbols)
      ? req.query.symbols
      : String(req.query.symbols || "").split(",");
    const symbols = normalizeSymbols(rawSymbols);
    if (!symbols.length) {
      return res.status(400).json({
        success: false,
        message: "symbols query parameter is required",
      });
    }

    const limit = clampNewsLimit(req.query.limit);

    const groupedNews = await loadLatestMarketNewsBySymbols(symbols, limit);
    const news = symbols.reduce((acc, symbol) => {
      for (const item of groupedNews[symbol] || []) {
        acc.push(formatNewsItem(item));
      }
      return acc;
    }, []);

    return res.json({
      success: true,
      symbols,
      count: news.length,
      limit,
      news,
    });
  } catch (error) {
    logger.error("Market news route error", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      message:
        "An unexpected error occurred while fetching market news. Please try again later.",
    });
  }
});

module.exports = router;
