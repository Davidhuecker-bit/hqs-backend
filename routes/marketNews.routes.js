"use strict";

const express = require("express");
const router = express.Router();

const {
  initMarketNewsTable,
  loadLatestMarketNewsBySymbols,
} = require("../services/marketNews.repository");
const { normalizeSymbols } = require("../services/marketNews.service");

function clampLimit(value) {
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
    published_at: item?.publishedAt ?? null,
    publishedAt: item?.publishedAt ?? null,
    summary: item?.summaryRaw ?? null,
  };
}

router.get("/", async (req, res) => {
  try {
    const symbols = normalizeSymbols(String(req.query.symbols || "").split(","));
    if (!symbols.length) {
      return res.status(400).json({
        success: false,
        message: "symbols query parameter is required",
      });
    }

    const limit = clampLimit(req.query.limit);

    await initMarketNewsTable();
    const groupedNews = await loadLatestMarketNewsBySymbols(symbols, limit);
    const newsBySymbol = symbols.reduce((acc, symbol) => {
      acc[symbol] = (groupedNews[symbol] || []).map(formatNewsItem);
      return acc;
    }, {});
    const news = symbols.flatMap((symbol) => newsBySymbol[symbol]);

    return res.json({
      success: true,
      symbols,
      count: news.length,
      limit,
      news,
      newsBySymbol,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

module.exports = router;
