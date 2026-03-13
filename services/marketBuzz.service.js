"use strict";

function normalizeSymbol(value) {
  const symbol = String(value || "").trim().toUpperCase();
  return symbol || null;
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundNumber(value, digits = 0) {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
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

function aggregateBySymbol({ newsItems = [], socialPosts = [] } = {}) {
  const buckets = {};

  for (const newsItem of Array.isArray(newsItems) ? newsItems : []) {
    const symbol = normalizeSymbol(newsItem?.symbol);
    if (!symbol) continue;

    const bucket = getBucket(buckets, symbol);
    bucket.newsMentions += 1;

    const sentimentScore = safeNumber(
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

    const socialScore = Math.max(0, safeNumber(socialPost?.score, 0));

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

function calculateBuzzScore({
  socialMentions = 0,
  newsMentions = 0,
  avgSentiment = 0,
} = {}) {
  return roundNumber((safeNumber(socialMentions, 0) * 2) + safeNumber(newsMentions, 0) + safeNumber(avgSentiment, 0));
}

function buildMarketBuzz({ newsItems = [], socialPosts = [] } = {}) {
  return aggregateBySymbol({ newsItems, socialPosts }).map((entry) => ({
    ...entry,
    buzzScore: calculateBuzzScore(entry),
  }));
}

module.exports = {
  aggregateBySymbol,
  calculateBuzzScore,
  buildMarketBuzz,
};
