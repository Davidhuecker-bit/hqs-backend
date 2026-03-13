"use strict";

const express = require("express");
const router = express.Router();

const {
  normalizeSymbols,
  normalizeLimit,
  normalizeMinRelevance,
  getStructuredMarketNewsBySymbols,
} = require("../services/marketNews.service");

const logger = require("../utils/logger");

function normalizeDirections(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];

  return [...new Set(
    raw
      .split(",")
      .map((item) => String(item || "").trim().toLowerCase())
      .filter((item) => ["bullish", "bearish", "neutral"].includes(item))
  )];
}

function extractRelevanceScore(item) {
  const score = Number(item?.intelligence?.relevanceScore ?? 0);
  return Number.isFinite(score) ? score : 0;
}

function extractPublishedTimestamp(item) {
  const timestamp = item?.publishedAt ? new Date(item.publishedAt).getTime() : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatNewsItem(item) {
  const intelligence =
    item?.intelligence && typeof item.intelligence === "object"
      ? item.intelligence
      : {};
  const marketSentiment =
    intelligence?.marketSentiment && typeof intelligence.marketSentiment === "object"
      ? intelligence.marketSentiment
      : null;

  return {
    symbol: item?.symbol ?? null,
    title: item?.title ?? null,
    url: item?.url ?? null,
    source: item?.source ?? null,
    publishedAt: item?.publishedAt ?? item?.published_at ?? null,
    summary: item?.summaryRaw ?? item?.summary ?? null,
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
      marketSentiment,
      symbols: Array.isArray(intelligence?.symbols) ? intelligence.symbols : [],
      sectors: Array.isArray(intelligence?.sectors) ? intelligence.sectors : [],
      industries: Array.isArray(intelligence?.industries) ? intelligence.industries : [],
      themes: Array.isArray(intelligence?.themes) ? intelligence.themes : [],
      reasons: Array.isArray(intelligence?.reasons) ? intelligence.reasons : [],
      entityMatches: Array.isArray(intelligence?.entityMatches)
        ? intelligence.entityMatches
        : [],
    },
  };
}

function formatSummary(summary) {
  const safe = summary && typeof summary === "object" ? summary : {};

  return {
    count: Number(safe?.count ?? 0) || 0,
    avgRelevance: Number(safe?.avgRelevance ?? 0) || 0,
    avgConfidence: Number(safe?.avgConfidence ?? 0) || 0,
    bullishCount: Number(safe?.bullishCount ?? 0) || 0,
    bearishCount: Number(safe?.bearishCount ?? 0) || 0,
    neutralCount: Number(safe?.neutralCount ?? 0) || 0,
    dominantEventType: safe?.dominantEventType ?? null,
    topHeadline: safe?.topHeadline ?? null,
    topRelevanceScore: Number(safe?.topRelevanceScore ?? 0) || 0,
  };
}

router.get("/", async (req, res) => {
  try {
    const symbols = normalizeSymbols(String(req.query.symbols || "").split(","));
    const limit = normalizeLimit(req.query.limit);
    const minRelevance = normalizeMinRelevance(req.query.minRelevance);
    const directions = normalizeDirections(req.query.direction);

    if (!symbols.length) {
      return res.status(400).json({
        success: false,
        message: 'The "symbols" query parameter is required',
      });
    }

    const structured = await getStructuredMarketNewsBySymbols(symbols, limit, {
      minRelevance,
      directions,
    });

    const newsBySymbol = {};
    let count = 0;

    for (const symbol of symbols) {
      const bucket = structured?.[symbol] || { items: [], summary: {} };
      const items = Array.isArray(bucket.items)
        ? bucket.items
            .map(formatNewsItem)
            .sort((a, b) => {
              const relevanceDiff = extractRelevanceScore(b) - extractRelevanceScore(a);
              if (relevanceDiff !== 0) return relevanceDiff;
              return extractPublishedTimestamp(b) - extractPublishedTimestamp(a);
            })
        : [];
      const summary = formatSummary(bucket.summary);

      newsBySymbol[symbol] = {
        summary,
        items,
      };

      count += items.length;
    }

    return res.json({
      success: true,
      symbols,
      limit,
      minRelevance,
      directions,
      count,
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
