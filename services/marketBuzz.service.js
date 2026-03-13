"use strict";

const SENTIMENT_MIN = 0;
const SENTIMENT_MAX = 100;
const BUZZ_SCORE_MIN = 0;
const BUZZ_SCORE_MAX = 100;

function normalizeSymbol(value) {
  const symbol = String(value || "").trim().toUpperCase();
  return symbol || null;
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundNumber(value, digits = 0) {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function normalizeSentimentScore(value, fallback = null) {
  const sentimentScore = safeNumber(value, fallback);
  if (sentimentScore === null) return null;

  return clamp(sentimentScore, SENTIMENT_MIN, SENTIMENT_MAX);
}

function normalizeMentionCount(value, fallback = 0) {
  const mentionCount = safeNumber(value, fallback);
  return Math.max(0, Math.trunc(mentionCount));
}

function normalizeSocialContribution(value) {
  if (value === undefined || value === null || value === "") {
    return 1;
  }

  return normalizeMentionCount(value, 0);
}

function normalizeBuzzScore(value, maxScore = BUZZ_SCORE_MAX) {
  const score = Math.max(0, safeNumber(value, 0));
  if (!score) return BUZZ_SCORE_MIN;

  if (maxScore <= BUZZ_SCORE_MAX) {
    return clamp(roundNumber(score), BUZZ_SCORE_MIN, BUZZ_SCORE_MAX);
  }

  return clamp(
    roundNumber((score / maxScore) * BUZZ_SCORE_MAX),
    BUZZ_SCORE_MIN,
    BUZZ_SCORE_MAX
  );
}

function normalizeSocialSymbols(symbols = []) {
  const normalizedSymbols = [];
  const seen = new Set();

  for (const symbol of Array.isArray(symbols) ? symbols : []) {
    const normalizedSymbol = normalizeSymbol(symbol);
    if (!normalizedSymbol || seen.has(normalizedSymbol)) continue;

    seen.add(normalizedSymbol);
    normalizedSymbols.push(normalizedSymbol);
  }

  return normalizedSymbols;
}

function createBucket() {
  return {
    symbol: null,
    socialMentions: 0,
    newsMentions: 0,
    sentimentTotal: 0,
    sentimentCount: 0,
  };
}

function getBucket(collection, symbol) {
  if (!collection[symbol]) {
    collection[symbol] = createBucket();
    collection[symbol].symbol = symbol;
  }

  return collection[symbol];
}

function aggregateBySymbol(input = {}) {
  const { newsItems = [], socialPosts = [] } =
    input && typeof input === "object" ? input : {};
  const buckets = {};

  for (const newsItem of Array.isArray(newsItems) ? newsItems : []) {
    const symbol = normalizeSymbol(newsItem?.symbol);
    if (!symbol) continue;

    const bucket = getBucket(buckets, symbol);
    bucket.newsMentions += 1;

    const sentimentScore = normalizeSentimentScore(
      newsItem?.intelligence?.marketSentiment?.sentimentScore,
      null
    );

    if (sentimentScore !== null) {
      bucket.sentimentTotal += sentimentScore;
      bucket.sentimentCount += 1;
    }
  }

  for (const socialPost of Array.isArray(socialPosts) ? socialPosts : []) {
    const symbols = normalizeSocialSymbols(socialPost?.symbols);
    if (!symbols.length) continue;

    const socialScore = normalizeSocialContribution(socialPost?.score);

    for (const symbol of symbols) {
      const bucket = getBucket(buckets, symbol);
      bucket.socialMentions += socialScore;
    }
  }

  return Object.values(buckets).map((bucket) => {
    const avgSentiment = bucket.sentimentCount
      ? roundNumber(bucket.sentimentTotal / bucket.sentimentCount)
      : 0;

    return {
      symbol: bucket.symbol,
      socialMentions: bucket.socialMentions,
      newsMentions: bucket.newsMentions,
      avgSentiment,
    };
  });
}

function calculateBuzzScore(input = {}) {
  const { socialMentions = 0, newsMentions = 0, avgSentiment = 0 } =
    input && typeof input === "object" ? input : {};

  return roundNumber(
    (normalizeMentionCount(socialMentions, 0) * 2) +
      normalizeMentionCount(newsMentions, 0) +
      normalizeSentimentScore(avgSentiment, 0)
  );
}

function buildMarketBuzz(input = {}) {
  const { newsItems = [], socialPosts = [] } =
    input && typeof input === "object" ? input : {};
  const aggregatedEntries = aggregateBySymbol({ newsItems, socialPosts });
  const scoredEntries = aggregatedEntries.map((entry) => ({
    ...entry,
    rawBuzzScore: calculateBuzzScore(entry),
  }));
  const maxRawBuzzScore = scoredEntries.reduce((maxScore, entry) => {
    return Math.max(maxScore, safeNumber(entry?.rawBuzzScore, 0));
  }, 0);

  return scoredEntries.map(({ rawBuzzScore, ...entry }) => ({
    ...entry,
    buzzScore: normalizeBuzzScore(rawBuzzScore, maxRawBuzzScore),
  }));
}

module.exports = {
  aggregateBySymbol,
  calculateBuzzScore,
  buildMarketBuzz,
};
