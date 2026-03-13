"use strict";

/*
  Public Market Sentiment Scaffold
*/

function safeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundNumber(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeScore(value, fallback = 0) {
  const score = safeNumber(value, fallback);
  return roundNumber(clamp(score, -100, 100));
}

function normalizeBuzzScore(value, fallback = 0) {
  const score = safeNumber(value, fallback);
  return roundNumber(clamp(score, 0, 100));
}

function normalizeMentionCount(value, fallback = 0) {
  const count = safeNumber(value, fallback);
  return Math.max(0, Math.trunc(count));
}

function normalizeSourceName(value) {
  const name = String(value || "").trim();
  return name || null;
}

function uniqueStrings(values = [], maxItems = 20) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const text = String(value || "")
      .replace(/\s+/g, " ")
      .trim();

    if (!text) continue;

    const key = text.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(text);

    if (result.length >= maxItems) break;
  }

  return result;
}

function normalizeSourceEntry(entry = {}, fallbackName = null) {
  return {
    sentimentScore: normalizeScore(entry?.sentimentScore, 0),
    buzzScore: normalizeBuzzScore(entry?.buzzScore, 0),
    mentionCount: normalizeMentionCount(entry?.mentionCount, 0),
    reasons: uniqueStrings(entry?.reasons, 10),
    sourceName: normalizeSourceName(entry?.sourceName ?? fallbackName),
  };
}

function buildSourceBreakdown(input = {}) {
  const breakdown = {};
  const sourceBreakdown = input?.sourceBreakdown;
  const sources = Array.isArray(input?.sources) ? input.sources : [];

  if (sourceBreakdown && typeof sourceBreakdown === "object" && !Array.isArray(sourceBreakdown)) {
    for (const [sourceName, entry] of Object.entries(sourceBreakdown)) {
      const normalizedName = normalizeSourceName(sourceName);
      if (!normalizedName) continue;
      breakdown[normalizedName] = normalizeSourceEntry(entry, normalizedName);
    }
  }

  for (const entry of Array.isArray(sourceBreakdown) ? sourceBreakdown : sources) {
    const sourceName = normalizeSourceName(entry?.sourceName ?? entry?.source ?? entry?.name);
    if (!sourceName) continue;
    breakdown[sourceName] = normalizeSourceEntry(entry, sourceName);
  }

  return breakdown;
}

function computeMentionCount(input = {}, sourceBreakdown = {}) {
  const explicit = safeNumber(input?.mentionCount, null);
  if (explicit !== null) return normalizeMentionCount(explicit, 0);

  return Object.values(sourceBreakdown).reduce((sum, entry) => {
    return sum + normalizeMentionCount(entry?.mentionCount, 0);
  }, 0);
}

function computeWeightedAverage(sourceBreakdown = {}, fieldName, fallback = 0) {
  let weightedTotal = 0;
  let weightSum = 0;

  for (const entry of Object.values(sourceBreakdown)) {
    const value = safeNumber(entry?.[fieldName], null);
    if (value === null) continue;

    const weight = Math.max(1, normalizeMentionCount(entry?.mentionCount, 0));
    weightedTotal += value * weight;
    weightSum += weight;
  }

  if (!weightSum) return fallback;
  return weightedTotal / weightSum;
}

function computeSentimentScore(input = {}, sourceBreakdown = {}) {
  const explicit = safeNumber(input?.sentimentScore, null);
  if (explicit !== null) return normalizeScore(explicit, 0);

  return normalizeScore(computeWeightedAverage(sourceBreakdown, "sentimentScore", 0), 0);
}

function computeBuzzScore(input = {}, sourceBreakdown = {}) {
  const explicit = safeNumber(input?.buzzScore, null);
  if (explicit !== null) return normalizeBuzzScore(explicit, 0);

  return normalizeBuzzScore(computeWeightedAverage(sourceBreakdown, "buzzScore", 0), 0);
}

function buildReasons(input = {}, sourceBreakdown = {}) {
  const directReasons = uniqueStrings(input?.reasons, 10);
  if (directReasons.length) return directReasons;

  return uniqueStrings(
    Object.entries(sourceBreakdown).flatMap(([sourceName, entry]) =>
      uniqueStrings(entry?.reasons, 5).map((reason) => `${sourceName}: ${reason}`)
    ),
    10
  );
}

function buildMarketSentiment(input = {}) {
  const sourceBreakdown = buildSourceBreakdown(input);

  return {
    sentimentScore: computeSentimentScore(input, sourceBreakdown),
    buzzScore: computeBuzzScore(input, sourceBreakdown),
    mentionCount: computeMentionCount(input, sourceBreakdown),
    sourceBreakdown,
    reasons: buildReasons(input, sourceBreakdown),
  };
}

module.exports = {
  buildMarketSentiment,
};
