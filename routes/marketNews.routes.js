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

function normalizeMinRelevance(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(Math.trunc(score), 100));
}

function formatNewsItem(item) {
  const intelligence =
    item?.intelligence && typeof item.intelligence === "object"
      ? item.intelligence
      : {};

  return {
    symbol: item?.symbol ?? null,
    title: item?.title ?? null,
    url: item?.url ?? null,
    source: item?.source ?? null,
    publishedAt: item?.publishedAt ?? item?.published_at ?? null,
    summary: item?.summaryRaw ?? item?.summary ?? null,
    sourceType: item?.sourceType ?? item?.source_type ?? null,

    intelligence: {
      eventType: intelligence?.eventType ?? null,
      direction: intelligence?.direction ?? null,
      horizon: intelligence?.horizon ?? null,
      relevanceScore: intelligence?.relevanceScore ?? null,
      confidence: intelligence?.confidence ?? null,
      eventStrength: intelligence?.eventStrength ?? null,
      freshnessScore: intelligence?.freshnessScore ?? null,
      sourceQuality: intelligence?.sourceQuality ?? null,
      sentimentStrength: intelligence?.sentimentStrength ?? null,
      symbols: Array.isArray(intelligence?.symbols) ? intelligence.symbols : [],
      sectors: Array.isArray(intelligence?.sectors) ? intelligence.sectors : [],
      industries: Array.isArray(intelligence?.industries) ? intelligence.industries : [],
      themes: Array.isArray(intelligence?.themes) ? intelligence.themes : [],
      reasons: Array.isArray(intelligence?.reasons) ? intelligence.reasons : [],
      entityMatches: Array.isArray(intelligence?.entityMatches)
        ? intelligence.entityMatches
        : [],
    },

    entityHint:
      item?.entityHint && typeof item.entityHint === "object"
        ? item.entityHint
        : item?.entity_hint && typeof item.entity_hint === "object"
          ? item.entity_hint
          : {},
  };
}

router.get("/", async (req, res) => {
  try {
    const symbols = normalizeSymbols(String(req.query.symbols || "").split(","));
    const limit = normalizeLimit(req.query.limit);
    const minRelevance = normalizeMinRelevance(req.query.minRelevance);

    if (!symbols.length) {
      return res.status(400).json({
        success: false,
        message: 'The "symbols" query parameter is required',
      });
    }

    const newsBySymbol = await loadLatestMarketNewsBySymbols(symbols, limit);

    const formattedBySymbol = {};

    for (const symbol of symbols) {
      const rawItems = Array.isArray(newsBySymbol?.[symbol]) ? newsBySymbol[symbol] : [];
      const formattedItems = rawItems
        .map(formatNewsItem)
        .filter((item) => {
          const score = Number(item?.intelligence?.relevanceScore ?? 0);
          return score >= minRelevance;
        })
        .sort((a, b) => {
          const aScore = Number(a?.intelligence?.relevanceScore ?? 0);
          const bScore = Number(b?.intelligence?.relevanceScore ?? 0);
          if (bScore !== aScore) return bScore - aScore;

          const aDate = a?.publishedAt ? new Date(a.publishedAt).getTime() : 0;
          const bDate = b?.publishedAt ? new Date(b.publishedAt).getTime() : 0;
          return bDate - aDate;
        });

      formattedBySymbol[symbol] = formattedItems;
    }

    const count = Object.values(formattedBySymbol).reduce(
      (sum, items) => sum + (Array.isArray(items) ? items.length : 0),
      0
    );

    return res.json({
      success: true,
      symbols,
      limit,
      minRelevance,
      count,
      newsBySymbol: formattedBySymbol,
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
