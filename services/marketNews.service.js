"use strict";

const axios = require("axios");

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

const marketNewsRepository = require("./marketNews.repository");
const { loadEntityMapBySymbols } = require("./entityMap.repository");
const { buildMarketSentiment } = require("./marketSentiment.service");

const {
  analyzeNewsArticle,
  buildNewsLifecycle,
} = require("./newsIntelligence.service");

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_NEWS_URL = "https://financialmodelingprep.com/api/v3/stock_news";
const FMP_NEWS_TIMEOUT_MS = Number(process.env.FMP_NEWS_TIMEOUT_MS || 20000);
// Prepared opportunity news context keeps the article-level weighting balanced at 1.0
// so relevance stays primary while confidence, impact, freshness and persistence remain supportive.
const NEWS_CONTEXT_MIN_WEIGHT = 0.2;
const NEWS_CONTEXT_MAX_WEIGHT = 1.4;
const NEWS_CONTEXT_RELEVANCE_WEIGHT = 0.32;
const NEWS_CONTEXT_CONFIDENCE_WEIGHT = 0.18;
const NEWS_CONTEXT_MARKET_IMPACT_WEIGHT = 0.22;
const NEWS_CONTEXT_FRESHNESS_WEIGHT = 0.12;
const NEWS_CONTEXT_PERSISTENCE_WEIGHT = 0.16;
const NEWS_CONTEXT_MAX_PERSISTENCE_SCORE = 160;
const NEWS_CONTEXT_PERSISTENCE_TO_SCORE_RATIO = 1.6;
const NEWS_CONTEXT_EVENT_LIMIT = 3;
const NEWS_CONTEXT_HEADLINE_LIMIT = 2;
const NEWS_CONTEXT_REASON_LIMIT = 3;
const NEWS_CONTEXT_DIRECTION_THRESHOLD = 12;

function cleanText(value) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length ? text : null;
}

function cleanSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  return symbol.length ? symbol : null;
}

function cleanPublishedAt(value) {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString();
}

function safeJson(value, fallback = {}) {
  if (value == null) return fallback;

  if (typeof value === "object") {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return fallback;
    }
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return parsed;
      return fallback;
    } catch (_) {
      return fallback;
    }
  }

  return fallback;
}

function normalizeSymbols(symbols) {
  return [
    ...new Set(
      (Array.isArray(symbols) ? symbols : [])
        .map(cleanSymbol)
        .filter(Boolean)
    ),
  ];
}

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

function normalizeDirection(value) {
  const direction = String(value || "").trim().toLowerCase();
  if (direction === "bullish") return "bullish";
  if (direction === "bearish") return "bearish";
  return "neutral";
}

function buildFmpNewsUrl(symbol, limitPerSymbol) {
  return `${FMP_NEWS_URL}?tickers=${encodeURIComponent(symbol)}&limit=${encodeURIComponent(
    limitPerSymbol
  )}&apikey=${encodeURIComponent(FMP_API_KEY || "")}`;
}

function maskFmpUrl(url) {
  return String(url || "").replace(/apikey=[^&]*/i, "apikey=***");
}

function extractSentimentRaw(rawItem) {
  if (rawItem?.sentiment_raw !== undefined && rawItem?.sentiment_raw !== null) {
    return cleanText(rawItem.sentiment_raw);
  }

  if (rawItem?.sentiment !== undefined && rawItem?.sentiment !== null) {
    return cleanText(rawItem.sentiment);
  }

  if (rawItem?.sentimentScore !== undefined && rawItem?.sentimentScore !== null) {
    return cleanText(rawItem.sentimentScore);
  }

  return null;
}

function extractCategory(rawItem) {
  if (rawItem?.category !== undefined && rawItem?.category !== null) {
    return cleanText(rawItem.category);
  }

  if (rawItem?.type !== undefined && rawItem?.type !== null) {
    return cleanText(rawItem.type);
  }

  return null;
}

function normalizeFmpNewsItem(rawItem, fallbackSymbol) {
  const symbol = cleanSymbol(
    rawItem?.symbol ??
      rawItem?.ticker ??
      rawItem?.stockSymbol ??
      (Array.isArray(rawItem?.tickers) ? rawItem.tickers[0] : null) ??
      fallbackSymbol
  );
  const title = cleanText(rawItem?.title ?? rawItem?.headline);
  const url = cleanText(rawItem?.url ?? rawItem?.link);

  if (!symbol || !title || !url) return null;

  return {
    symbol,
    title,
    source: cleanText(rawItem?.site ?? rawItem?.source ?? rawItem?.publisher),
    url,
    publishedAt: cleanPublishedAt(
      rawItem?.publishedDate ?? rawItem?.published_at ?? rawItem?.date
    ),
    summaryRaw: cleanText(rawItem?.text ?? rawItem?.summary ?? rawItem?.content),
    sentimentRaw: extractSentimentRaw(rawItem),
    category: extractCategory(rawItem),
    sourceType: "fmp",
    entityHint: {},
    rawPayload: safeJson(rawItem, {}),
    intelligence: {},
  };
}

async function fetchFmpMarketNewsForSymbols(symbols, limitPerSymbol = 5) {
  const requestedSymbols = normalizeSymbols(symbols);
  const limit = normalizeLimit(limitPerSymbol);
  const items = [];
  const failedSymbols = [];

  if (!requestedSymbols.length) {
    return { items, failedSymbols };
  }

  if (!FMP_API_KEY) {
    if (logger?.warn) logger.warn("FMP market news fetch skipped: missing FMP_API_KEY");
    return {
      items,
      failedSymbols: requestedSymbols,
    };
  }

  for (const symbol of requestedSymbols) {
    const url = buildFmpNewsUrl(symbol, limit);

    try {
      const response = await axios.get(url, {
        timeout: FMP_NEWS_TIMEOUT_MS,
        headers: {
          "User-Agent": "HQS-Backend/1.0",
          Accept: "application/json",
        },
      });

      if (!Array.isArray(response?.data)) {
        failedSymbols.push(symbol);
        if (logger?.warn) {
          logger.warn("FMP market news returned non-array response", {
            symbol,
            url: maskFmpUrl(url),
          });
        }
        continue;
      }

      for (const rawItem of response.data) {
        items.push({
          rawItem,
          fallbackSymbol: symbol,
        });
      }
    } catch (error) {
      failedSymbols.push(symbol);
      if (logger?.warn) {
        logger.warn("FMP market news fetch failed", {
          symbol,
          message: error.message,
          status: error?.response?.status ?? null,
          url: maskFmpUrl(url),
        });
      }
    }
  }

  return {
    items,
    failedSymbols: [...new Set(failedSymbols)],
  };
}

async function collectAndStoreMarketNews(symbols, limitPerSymbol = 5) {
  const requestedSymbols = normalizeSymbols(symbols);
  const summary = {
    requestedSymbols,
    fetchedItems: 0,
    storedItems: 0,
    cooledItems: 0,
    expiredItems: 0,
    failedSymbols: [],
  };

  if (!requestedSymbols.length) {
    return summary;
  }

  const { items, failedSymbols } = await fetchFmpMarketNewsForSymbols(
    requestedSymbols,
    limitPerSymbol
  );
  const failedSymbolsSet = new Set(failedSymbols);

  summary.fetchedItems = items.length;
  summary.failedSymbols = [...failedSymbolsSet];

  let entityMapBySymbol = {};
  try {
    entityMapBySymbol = await loadEntityMapBySymbols(requestedSymbols);
  } catch (error) {
    if (logger?.warn) {
      logger.warn("FMP market news entity map load failed; intelligence analysis will continue without entity map", {
        message: error.message,
        requestedSymbols,
      });
    }
  }

  const normalizedItems = [];
  for (const entry of items) {
    try {
      const normalized = normalizeFmpNewsItem(entry?.rawItem, entry?.fallbackSymbol);
      if (!normalized) continue;

      const intelligence = analyzeNewsArticle(normalized, entityMapBySymbol) || {};
      const lifecycle = buildNewsLifecycle(normalized, intelligence);
      normalizedItems.push({
        ...normalized,
        intelligence,
        retentionClass: lifecycle.retentionClass,
        expiresAt: lifecycle.expiresAt,
        isActiveForScoring: lifecycle.isActiveForScoring,
        lifecycleState: lifecycle.lifecycleState,
      });
    } catch (error) {
      const failedSymbol = cleanSymbol(entry?.fallbackSymbol);
      if (failedSymbol) failedSymbolsSet.add(failedSymbol);
      summary.failedSymbols = [...failedSymbolsSet];
      if (logger?.warn) {
        logger.warn("FMP market news item normalization failed", {
          symbol: failedSymbol,
          message: error.message,
        });
      }
    }
  }

  if (!normalizedItems.length) {
    return summary;
  }

  try {
    await marketNewsRepository.initMarketNewsTable();
    const result = await marketNewsRepository.upsertMarketNews(normalizedItems);
    summary.storedItems = Number(result?.insertedOrUpdated ?? 0) || 0;
    const lifecycleSummary = await marketNewsRepository.syncMarketNewsLifecycleStates();
    summary.cooledItems = Number(lifecycleSummary?.cooled ?? 0) || 0;
    summary.expiredItems = Number(lifecycleSummary?.expired ?? 0) || 0;
  } catch (error) {
    summary.failedSymbols = requestedSymbols.slice();

    if (logger?.error) {
      logger.error("collectAndStoreMarketNews store failed", {
        message: error.message,
        requestedSymbols,
      });
    }
  }

  return summary;
}

function extractRelevance(item) {
  const score = Number(item?.intelligence?.relevanceScore ?? 0);
  return Number.isFinite(score) ? score : 0;
}

function extractConfidence(item) {
  const score = Number(item?.intelligence?.confidence ?? 0);
  return Number.isFinite(score) ? score : 0;
}

function extractPublishedTimestamp(item) {
  const timestamp = item?.publishedAt ? new Date(item.publishedAt).getTime() : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function extractFreshnessScore(item) {
  return safeNumber(item?.intelligence?.freshnessScore, 0);
}

function extractMarketImpactScore(item) {
  return safeNumber(item?.intelligence?.marketImpactScore, 0);
}

function extractSentimentScore(item) {
  const embeddedScore = item?.intelligence?.marketSentiment?.sentimentScore;
  if (Number.isFinite(Number(embeddedScore))) {
    return clamp(Number(embeddedScore), -100, 100);
  }

  const direction = normalizeDirection(item?.intelligence?.direction);
  const sentimentStrength = clamp(
    safeNumber(item?.intelligence?.sentimentStrength, direction === "neutral" ? 0 : 50),
    0,
    100
  );

  if (direction === "bullish") return sentimentStrength;
  if (direction === "bearish") return -sentimentStrength;
  return 0;
}

function extractBuzzScore(item) {
  return clamp(
    safeNumber(item?.intelligence?.marketSentiment?.buzzScore, 0),
    0,
    100
  );
}

function extractEventType(item) {
  return cleanText(item?.intelligence?.eventType)?.toLowerCase() || null;
}

function createEmptyNewsContext() {
  return {
    activeCount: 0,
    weightedRelevance: 0,
    weightedConfidence: 0,
    weightedFreshness: 0,
    weightedMarketImpact: 0,
    weightedPersistence: 0,
    strengthScore: 0,
    direction: "neutral",
    directionScore: 0,
    bullishCount: 0,
    bearishCount: 0,
    neutralCount: 0,
    dominantEventType: null,
    topEventTypes: [],
    topHeadline: null,
    topHeadlines: [],
    summary: null,
    reasons: [],
    marketSentiment: buildMarketSentiment({}),
  };
}

function buildNewsItemWeight(item = {}) {
  const relevance = clamp(extractRelevance(item), 0, 100) / 100;
  const confidence = clamp(extractConfidence(item), 0, 100) / 100;
  const freshness = clamp(extractFreshnessScore(item), 0, 100) / 100;
  const marketImpact = clamp(extractMarketImpactScore(item), 0, 100) / 100;
  const persistence = clamp(
    safeNumber(item?.persistenceScore, 0) / NEWS_CONTEXT_MAX_PERSISTENCE_SCORE,
    0,
    1
  );

  const weight =
    NEWS_CONTEXT_MIN_WEIGHT +
    relevance * NEWS_CONTEXT_RELEVANCE_WEIGHT +
    confidence * NEWS_CONTEXT_CONFIDENCE_WEIGHT +
    marketImpact * NEWS_CONTEXT_MARKET_IMPACT_WEIGHT +
    freshness * NEWS_CONTEXT_FRESHNESS_WEIGHT +
    persistence * NEWS_CONTEXT_PERSISTENCE_WEIGHT;

  return clamp(roundNumber(weight, 4), NEWS_CONTEXT_MIN_WEIGHT, NEWS_CONTEXT_MAX_WEIGHT);
}

function buildNewsSummary({
  activeCount = 0,
  direction = "neutral",
  dominantEventType = null,
  weightedRelevance = 0,
  weightedMarketImpact = 0,
}) {
  if (!activeCount) return null;

  const parts = [`${activeCount} aktive News`];

  if (direction === "bullish") {
    parts.push("bullische Tendenz");
  } else if (direction === "bearish") {
    parts.push("bearische Tendenz");
  } else {
    parts.push("neutrale Tendenz");
  }

  if (dominantEventType) {
    parts.push(`Fokus ${dominantEventType}`);
  }

  if (weightedRelevance >= 70 || weightedMarketImpact >= 70) {
    parts.push("hohe News-Relevanz");
  }

  return parts.join(" · ");
}

function calculateContextStrengthScore({
  weightedRelevance = 0,
  weightedConfidence = 0,
  weightedMarketImpact = 0,
  weightedFreshness = 0,
  weightedPersistence = 0,
  totalWeight = 1,
}) {
  const safeWeight = totalWeight > 0 ? totalWeight : 1;

  return roundNumber(
    clamp(
      weightedRelevance / safeWeight * NEWS_CONTEXT_RELEVANCE_WEIGHT +
        weightedConfidence / safeWeight * NEWS_CONTEXT_CONFIDENCE_WEIGHT +
        weightedMarketImpact / safeWeight * NEWS_CONTEXT_MARKET_IMPACT_WEIGHT +
        weightedFreshness / safeWeight * NEWS_CONTEXT_FRESHNESS_WEIGHT +
        clamp(weightedPersistence / safeWeight, 0, NEWS_CONTEXT_MAX_PERSISTENCE_SCORE) /
          NEWS_CONTEXT_PERSISTENCE_TO_SCORE_RATIO *
          NEWS_CONTEXT_PERSISTENCE_WEIGHT,
      0,
      100
    )
  );
}

function normalizeLoadedNewsItem(item) {
  const intelligence = safeJson(item?.intelligence, {});
  const lifecycle = buildNewsLifecycle(item, intelligence);
  const explicitActiveForScoring =
    typeof item?.isActiveForScoring === "boolean"
      ? item.isActiveForScoring
      : typeof item?.is_active_for_scoring === "boolean"
        ? item.is_active_for_scoring
        : null;
  const explicitLifecycleState = cleanText(
    item?.lifecycleState ?? item?.lifecycle_state
  )?.toLowerCase();

  return {
    symbol: cleanSymbol(item?.symbol),
    title: cleanText(item?.title),
    source: cleanText(item?.source),
    url: cleanText(item?.url),
    publishedAt: cleanPublishedAt(item?.publishedAt ?? item?.published_at),
    summaryRaw: cleanText(item?.summaryRaw ?? item?.summary_raw ?? item?.summary),
    sentimentRaw: cleanText(item?.sentimentRaw ?? item?.sentiment_raw),
    category: cleanText(item?.category),
    sourceType: cleanText(item?.sourceType ?? item?.source_type),
    entityHint: safeJson(item?.entityHint ?? item?.entity_hint, {}),
    rawPayload: safeJson(item?.rawPayload ?? item?.raw_payload, {}),
    intelligence,
    retentionClass:
      cleanText(item?.retentionClass ?? item?.retention_class)?.toLowerCase() ||
      lifecycle.retentionClass,
    expiresAt: cleanPublishedAt(item?.expiresAt ?? item?.expires_at ?? lifecycle.expiresAt),
    isActiveForScoring:
      explicitActiveForScoring === false ? false : lifecycle.isActiveForScoring,
    lifecycleState:
      explicitLifecycleState === "expired"
        ? "expired"
        : lifecycle.lifecycleState,
  };
}

function buildScoringNewsContext(items = []) {
  const normalized = items
    .map(normalizeLoadedNewsItem)
    .filter((item) => item?.symbol && item?.title && item?.url)
    .filter((item) => item?.isActiveForScoring === true);

  if (!normalized.length) {
    return createEmptyNewsContext();
  }

  const weightedEventCounts = {};
  const headlineCandidates = [];
  const reasonCandidates = [];

  let totalWeight = 0;
  let weightedRelevance = 0;
  let weightedConfidence = 0;
  let weightedFreshness = 0;
  let weightedMarketImpact = 0;
  let weightedPersistence = 0;
  let weightedSentimentScore = 0;
  let weightedBuzzScore = 0;
  let bullishCount = 0;
  let bearishCount = 0;
  let neutralCount = 0;

  for (const item of normalized) {
    const lifecycle = buildNewsLifecycle(item, item.intelligence || {});
    const decoratedItem = {
      ...item,
      persistenceScore: safeNumber(lifecycle?.persistenceScore, 0),
    };
    const weight = buildNewsItemWeight(decoratedItem);
    const direction = normalizeDirection(decoratedItem?.intelligence?.direction);
    const eventType = extractEventType(decoratedItem);
    const articleReasons = Array.isArray(decoratedItem?.intelligence?.reasons)
      ? decoratedItem.intelligence.reasons
      : [];

    totalWeight += weight;
    weightedRelevance += extractRelevance(decoratedItem) * weight;
    weightedConfidence += extractConfidence(decoratedItem) * weight;
    weightedFreshness += extractFreshnessScore(decoratedItem) * weight;
    weightedMarketImpact += extractMarketImpactScore(decoratedItem) * weight;
    weightedPersistence += decoratedItem.persistenceScore * weight;
    weightedSentimentScore += extractSentimentScore(decoratedItem) * weight;
    weightedBuzzScore += extractBuzzScore(decoratedItem) * weight;

    if (direction === "bullish") bullishCount += 1;
    else if (direction === "bearish") bearishCount += 1;
    else neutralCount += 1;

    if (eventType) {
      weightedEventCounts[eventType] = safeNumber(weightedEventCounts[eventType], 0) + weight;
    }

    headlineCandidates.push({
      title: decoratedItem.title,
      weight,
      relevance: extractRelevance(decoratedItem),
      publishedAt: extractPublishedTimestamp(decoratedItem),
    });

    reasonCandidates.push(...articleReasons);
  }

  const safeWeight = totalWeight > 0 ? totalWeight : 1;
  const averageSentiment = roundNumber(weightedSentimentScore / safeWeight);
  const averageBuzz = roundNumber(weightedBuzzScore / safeWeight);
  const directionScore = clamp(roundNumber(averageSentiment / 100, 2), -1, 1);
  const direction =
    averageSentiment >= NEWS_CONTEXT_DIRECTION_THRESHOLD
      ? "bullish"
      : averageSentiment <= -NEWS_CONTEXT_DIRECTION_THRESHOLD
        ? "bearish"
        : "neutral";

  const rankedEventTypes = Object.entries(weightedEventCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, NEWS_CONTEXT_EVENT_LIMIT)
    .map(([eventType]) => eventType);

  const topHeadlines = headlineCandidates
    .sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      if (b.relevance !== a.relevance) return b.relevance - a.relevance;
      return b.publishedAt - a.publishedAt;
    })
    .slice(0, NEWS_CONTEXT_HEADLINE_LIMIT)
    .map((item) => item.title);

  const context = {
    activeCount: normalized.length,
    weightedRelevance: roundNumber(weightedRelevance / safeWeight),
    weightedConfidence: roundNumber(weightedConfidence / safeWeight),
    weightedFreshness: roundNumber(weightedFreshness / safeWeight),
    weightedMarketImpact: roundNumber(weightedMarketImpact / safeWeight),
    weightedPersistence: roundNumber(weightedPersistence / safeWeight),
    strengthScore: calculateContextStrengthScore({
      weightedRelevance,
      weightedConfidence,
      weightedMarketImpact,
      weightedFreshness,
      weightedPersistence,
      totalWeight: safeWeight,
    }),
    direction,
    directionScore,
    bullishCount,
    bearishCount,
    neutralCount,
    dominantEventType: rankedEventTypes[0] || null,
    topEventTypes: rankedEventTypes,
    topHeadline: topHeadlines[0] || null,
    topHeadlines,
    summary: null,
    reasons: [],
    marketSentiment: buildMarketSentiment({
      sentimentScore: averageSentiment,
      buzzScore: averageBuzz,
      mentionCount: normalized.length,
      reasons: reasonCandidates,
    }),
  };

  context.summary = buildNewsSummary(context);
  const sentimentReasons = Array.isArray(context?.marketSentiment?.reasons)
    ? context.marketSentiment.reasons
    : [];
  context.reasons = [
    context.summary,
    context.topHeadline ? `Top Headline: ${context.topHeadline}` : null,
    ...sentimentReasons,
  ]
    .filter(Boolean)
    .slice(0, NEWS_CONTEXT_REASON_LIMIT);

  return context;
}

function buildTopNewsSummary(items = []) {
  const normalized = items
    .map(normalizeLoadedNewsItem)
    .filter((item) => item?.symbol && item?.title && item?.url);

  if (!normalized.length) {
    return {
      count: 0,
      avgRelevance: 0,
      avgConfidence: 0,
      bullishCount: 0,
      bearishCount: 0,
      neutralCount: 0,
      dominantEventType: null,
      topHeadline: null,
      topRelevanceScore: 0,
    };
  }

  let totalRelevance = 0;
  let totalConfidence = 0;
  let bullishCount = 0;
  let bearishCount = 0;
  let neutralCount = 0;
  const eventCounts = {};

  const sorted = [...normalized].sort((a, b) => {
    const scoreDiff = extractRelevance(b) - extractRelevance(a);
    if (scoreDiff !== 0) return scoreDiff;
    return extractPublishedTimestamp(b) - extractPublishedTimestamp(a);
  });

  for (const item of normalized) {
    const relevance = extractRelevance(item);
    const confidence = extractConfidence(item);
    const direction = String(item?.intelligence?.direction || "neutral").toLowerCase();
    const eventType = cleanText(item?.intelligence?.eventType);

    totalRelevance += relevance;
    totalConfidence += confidence;

    if (direction === "bullish") bullishCount += 1;
    else if (direction === "bearish") bearishCount += 1;
    else neutralCount += 1;

    if (eventType) {
      eventCounts[eventType] = (eventCounts[eventType] || 0) + 1;
    }
  }

  let dominantEventType = null;
  let dominantEventCount = 0;
  for (const [eventType, count] of Object.entries(eventCounts)) {
    if (count > dominantEventCount) {
      dominantEventType = eventType;
      dominantEventCount = count;
    }
  }

  return {
    count: normalized.length,
    avgRelevance: Math.round(totalRelevance / normalized.length),
    avgConfidence: Math.round(totalConfidence / normalized.length),
    bullishCount,
    bearishCount,
    neutralCount,
    dominantEventType,
    topHeadline: sorted[0]?.title ?? null,
    topRelevanceScore: extractRelevance(sorted[0]),
  };
}

function filterAndSortNewsItems(items = [], options = {}) {
  const minRelevance = normalizeMinRelevance(options?.minRelevance);
  const activeForScoring = options?.activeForScoring === true;
  const allowedDirections = Array.isArray(options?.directions)
    ? options.directions.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean)
    : [];

  return items
    .map(normalizeLoadedNewsItem)
    .filter((item) => item?.symbol && item?.title && item?.url)
    .filter((item) => extractRelevance(item) >= minRelevance)
    .filter((item) => !activeForScoring || item?.isActiveForScoring === true)
    .filter((item) => {
      if (!allowedDirections.length) return true;
      const direction = String(item?.intelligence?.direction || "neutral").toLowerCase();
      return allowedDirections.includes(direction);
    })
    .sort((a, b) => {
      const relevanceDiff = extractRelevance(b) - extractRelevance(a);
      if (relevanceDiff !== 0) return relevanceDiff;

      const confidenceDiff = extractConfidence(b) - extractConfidence(a);
      if (confidenceDiff !== 0) return confidenceDiff;

      return extractPublishedTimestamp(b) - extractPublishedTimestamp(a);
    });
}

async function getStructuredMarketNewsBySymbols(symbols, limitPerSymbol = 5, options = {}) {
  const normalizedSymbols = normalizeSymbols(symbols);
  if (!normalizedSymbols.length) return {};

  const grouped = await marketNewsRepository.loadLatestMarketNewsBySymbols(
    normalizedSymbols,
    normalizeLimit(limitPerSymbol),
    {
      onlyScoringActive: options?.activeForScoring === true,
    }
  );

  const result = {};
  for (const symbol of normalizedSymbols) {
    const items = Array.isArray(grouped?.[symbol]) ? grouped[symbol] : [];
    const filteredItems = filterAndSortNewsItems(items, options);

    result[symbol] = {
      items: filteredItems,
      summary: buildTopNewsSummary(filteredItems),
    };
  }

  return result;
}

async function getScoringActiveMarketNewsBySymbols(symbols, limitPerSymbol = 5, options = {}) {
  const normalizedSymbols = normalizeSymbols(symbols);
  if (!normalizedSymbols.length) return {};

  const grouped = await marketNewsRepository.loadScoringActiveMarketNewsBySymbols(
    normalizedSymbols,
    normalizeLimit(limitPerSymbol)
  );

  const result = {};
  for (const symbol of normalizedSymbols) {
    const items = Array.isArray(grouped?.[symbol]) ? grouped[symbol] : [];
    result[symbol] = filterAndSortNewsItems(items, {
      ...options,
      activeForScoring: true,
    });
  }

  return result;
}

async function getScoringActiveNewsContextBySymbols(
  symbols,
  limitPerSymbol = 5,
  options = {}
) {
  const normalizedSymbols = normalizeSymbols(symbols);
  if (!normalizedSymbols.length) return {};

  const grouped = await getScoringActiveMarketNewsBySymbols(
    normalizedSymbols,
    limitPerSymbol,
    options
  );

  const result = {};
  for (const symbol of normalizedSymbols) {
    result[symbol] = buildScoringNewsContext(grouped?.[symbol] || []);
  }

  return result;
}

async function getPortfolioSymbols() {
  // Customer-specific portfolio symbols require a user_id that is not available
  // in this code path. A global query across all users' open positions would produce
  // a mixed data set that must not be served as customer-specific news.
  return [];
}

async function getWatchlistNewsSymbols() {
  // Customer-specific watchlist symbols require a user_id that is not available
  // in this code path. A global query across all users' active watchlist entries
  // would produce a mixed data set that must not be served as customer-specific news.
  return [];
}

module.exports = {
  fetchFmpMarketNewsForSymbols,
  normalizeFmpNewsItem,
  collectAndStoreMarketNews,
  normalizeSymbols,
  normalizeLimit,
  normalizeMinRelevance,
  buildTopNewsSummary,
  buildScoringNewsContext,
  filterAndSortNewsItems,
  getStructuredMarketNewsBySymbols,
  getScoringActiveMarketNewsBySymbols,
  getScoringActiveNewsContextBySymbols,
  getPortfolioSymbols,
  getWatchlistNewsSymbols,
};
