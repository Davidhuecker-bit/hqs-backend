"use strict";

/**
 * @deprecated
  Legacy/parallel opportunity utility path.
  The productive live integration stays on
  opportunityScanner -> marketOrchestrator -> integrationEngine
  until this module is intentionally consolidated.
 */

const { buildEarlySignals } = require("./earlySignal.service");
const { buildMarketSentiment } = require("./marketSentiment.service");
const { buildTrendingStock } = require("./trendingStocks.service");

const SCORE_MIN = 0;
const SCORE_MAX = 100;
const HQS_WEIGHT = 0.35;
const BUZZ_WEIGHT = 0.2;
const TREND_WEIGHT = 0.25;
const SENTIMENT_WEIGHT = 0.1;
const POTENTIAL_BREAKOUT_BONUS = 10;
const EARLY_INTEREST_BONUS = 5;
const HIGH_CONVICTION_THRESHOLD = 85;
const STRONG_CONVICTION_THRESHOLD = 70;
const MODERATE_CONVICTION_THRESHOLD = 50;
const HIGH_SCORE_THRESHOLD = 80;
const STRONG_SCORE_THRESHOLD = 70;
const EXPLODING_TREND_THRESHOLD = 85;
const MAX_REASONS = 4;

function normalizeItems(items) {
  if (Array.isArray(items)) return items;
  if (items && typeof items === "object") return [items];
  return [];
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundNumber(value, digits = 2) {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function normalizeSymbol(value) {
  const symbol = String(value || "").trim().toUpperCase();
  return symbol || null;
}

function normalizeScore(value, fallback = 0) {
  return roundNumber(clamp(safeNumber(value, fallback), SCORE_MIN, SCORE_MAX));
}

function normalizeSentimentScore(value, fallback = 0) {
  return roundNumber(clamp(safeNumber(value, fallback), -SCORE_MAX, SCORE_MAX));
}

function normalizeEarlySignal(value) {
  const earlySignal = String(value || "").trim().toLowerCase();
  return earlySignal || null;
}

function getEarlySignalBonus(signal) {
  if (signal === "potential_breakout") return POTENTIAL_BREAKOUT_BONUS;
  if (signal === "early_interest") return EARLY_INTEREST_BONUS;
  return 0;
}

function deriveEarlySignal(input = {}, trendData = null) {
  const hasMomentumData =
    Number.isFinite(Number(input?.priceMomentum)) ||
    Number.isFinite(Number(input?.changePercent));

  if (!hasMomentumData || !trendData?.symbol) return null;

  const earlySignals = buildEarlySignals([
    {
      symbol: trendData.symbol,
      buzzScore: trendData.buzzScore,
      priceMomentum: trendData.priceMomentum,
      trendScore: trendData.trendScore,
      trendLevel: trendData.trendLevel,
    },
  ]);

  return earlySignals[0]?.signal || null;
}

function normalizeInputItem(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const symbol = normalizeSymbol(input.symbol);
  if (!symbol) return null;

  const trendData = buildTrendingStock({
    symbol,
    buzzScore: input.buzzScore,
    priceMomentum: input.priceMomentum,
    volumeSpike: input.volumeSpike,
    changePercent: input.changePercent,
    volume: input.volume,
  });

  const marketSentiment = buildMarketSentiment(input.marketSentiment);
  const hqsScore = normalizeScore(input.hqsScore, 0);
  const buzzScore = normalizeScore(input.buzzScore, trendData?.buzzScore ?? 0);
  const trendScore = normalizeScore(input.trendScore, trendData?.trendScore ?? 0);
  const earlySignal =
    normalizeEarlySignal(input.earlySignal) || deriveEarlySignal(input, trendData);

  return {
    symbol,
    hqsScore,
    buzzScore,
    trendScore,
    earlySignal,
    marketSentiment: {
      ...marketSentiment,
      sentimentScore: normalizeSentimentScore(marketSentiment?.sentimentScore, 0),
    },
    trendLevel: trendData?.trendLevel || null,
  };
}

function determineConviction(finalOpportunityScore) {
  const normalizedScore = normalizeScore(finalOpportunityScore, 0);

  if (normalizedScore > HIGH_CONVICTION_THRESHOLD) return "high";
  if (normalizedScore > STRONG_CONVICTION_THRESHOLD) return "strong";
  if (normalizedScore > MODERATE_CONVICTION_THRESHOLD) return "moderate";
  return "low";
}

function buildReasons(item = {}) {
  const reasons = [];

  if (item.hqsScore >= HIGH_SCORE_THRESHOLD) {
    reasons.push("High HQS score");
  }

  if (item.buzzScore >= HIGH_SCORE_THRESHOLD) {
    reasons.push("Strong buzz");
  }

  if (
    item.trendScore > EXPLODING_TREND_THRESHOLD ||
    item.trendLevel === "exploding"
  ) {
    reasons.push("Exploding trend");
  } else if (item.trendScore > STRONG_SCORE_THRESHOLD) {
    reasons.push("Strong trend");
  }

  if (item.earlySignal === "potential_breakout") {
    reasons.push("Early breakout signal");
  } else if (item.earlySignal === "early_interest") {
    reasons.push("Early interest signal");
  }

  if (item.marketSentiment?.sentimentScore >= STRONG_SCORE_THRESHOLD) {
    reasons.push("Positive market sentiment");
  }

  if (!reasons.length) {
    if (item.hqsScore > MODERATE_CONVICTION_THRESHOLD) {
      reasons.push("Solid HQS foundation");
    } else if (item.buzzScore > MODERATE_CONVICTION_THRESHOLD) {
      reasons.push("Building buzz");
    } else if (item.trendScore > MODERATE_CONVICTION_THRESHOLD) {
      reasons.push("Trend support");
    }
  }

  return Array.from(new Set(reasons)).slice(0, MAX_REASONS);
}

function calculateFinalOpportunityScore(item = {}) {
  const weightedScore =
    item.hqsScore * HQS_WEIGHT +
    item.buzzScore * BUZZ_WEIGHT +
    item.trendScore * TREND_WEIGHT +
    normalizeSentimentScore(item.marketSentiment?.sentimentScore, 0) *
      SENTIMENT_WEIGHT +
    getEarlySignalBonus(item.earlySignal);

  return roundNumber(clamp(weightedScore, SCORE_MIN, SCORE_MAX));
}

function buildOpportunityScores(items = []) {
  return normalizeItems(items).reduce((results, item) => {
    const normalizedItem = normalizeInputItem(item);
    if (!normalizedItem) return results;

    const finalOpportunityScore = calculateFinalOpportunityScore(normalizedItem);

    results.push({
      symbol: normalizedItem.symbol,
      hqsScore: normalizedItem.hqsScore,
      buzzScore: normalizedItem.buzzScore,
      trendScore: normalizedItem.trendScore,
      finalOpportunityScore,
      conviction: determineConviction(finalOpportunityScore),
      earlySignal: normalizedItem.earlySignal,
      reasons: buildReasons(normalizedItem),
    });

    return results;
  }, []);
}

module.exports = {
  buildOpportunityScores,
  buildReasons,
  determineConviction,
  normalizeInputItem,
};
