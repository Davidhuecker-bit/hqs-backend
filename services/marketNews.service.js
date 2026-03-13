"use strict";

const axios = require("axios");

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

const marketNewsRepository = require("./marketNews.repository");

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_NEWS_URL = "https://financialmodelingprep.com/api/v3/stock_news";
const FMP_NEWS_TIMEOUT_MS = Number(process.env.FMP_NEWS_TIMEOUT_MS || 20000);

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

  const normalizedItems = [];
  for (const entry of items) {
    try {
      const normalized = normalizeFmpNewsItem(entry?.rawItem, entry?.fallbackSymbol);
      if (normalized) normalizedItems.push(normalized);
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

function normalizeLoadedNewsItem(item) {
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
    intelligence: safeJson(item?.intelligence, {}),
  };
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
  const allowedDirections = Array.isArray(options?.directions)
    ? options.directions.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean)
    : [];

  return items
    .map(normalizeLoadedNewsItem)
    .filter((item) => item?.symbol && item?.title && item?.url)
    .filter((item) => extractRelevance(item) >= minRelevance)
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
    normalizeLimit(limitPerSymbol)
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

module.exports = {
  fetchFmpMarketNewsForSymbols,
  normalizeFmpNewsItem,
  collectAndStoreMarketNews,
  normalizeSymbols,
  normalizeLimit,
  normalizeMinRelevance,
  buildTopNewsSummary,
  filterAndSortNewsItems,
  getStructuredMarketNewsBySymbols,
};
