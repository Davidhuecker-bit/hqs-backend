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
  const text = String(value ?? "").trim();
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

function normalizeSymbols(symbols) {
  return [...new Set(
    (Array.isArray(symbols) ? symbols : [])
      .map(cleanSymbol)
      .filter(Boolean)
  )];
}

function normalizeLimit(limitPerSymbol) {
  const limit = Number(limitPerSymbol);
  if (!Number.isFinite(limit)) return 5;
  return Math.max(1, Math.min(Math.trunc(limit), 25));
}

function buildFmpNewsUrl(symbol, limitPerSymbol) {
  return `${FMP_NEWS_URL}?tickers=${encodeURIComponent(symbol)}&limit=${encodeURIComponent(
    limitPerSymbol
  )}&apikey=${encodeURIComponent(FMP_API_KEY || "")}`;
}

function maskFmpUrl(url) {
  return String(url || "").replace(/apikey=[^&]+/i, "apikey=***");
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
    published_at: cleanPublishedAt(
      rawItem?.publishedDate ?? rawItem?.published_at ?? rawItem?.date
    ),
    summary_raw: cleanText(rawItem?.text ?? rawItem?.summary ?? rawItem?.content),
    sentiment_raw: extractSentimentRaw(rawItem),
    category: extractCategory(rawItem),
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

  summary.fetchedItems = items.length;
  summary.failedSymbols = failedSymbols;

  const normalizedItems = [];
  for (const entry of items) {
    try {
      const normalized = normalizeFmpNewsItem(entry?.rawItem, entry?.fallbackSymbol);
      if (normalized) normalizedItems.push(normalized);
    } catch (error) {
      const failedSymbol = cleanSymbol(entry?.fallbackSymbol);
      if (failedSymbol && !summary.failedSymbols.includes(failedSymbol)) {
        summary.failedSymbols.push(failedSymbol);
      }
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
    summary.failedSymbols = requestedSymbols.filter(
      (symbol) => !summary.failedSymbols.includes(symbol)
    ).concat(summary.failedSymbols);

    if (logger?.error) {
      logger.error("collectAndStoreMarketNews store failed", {
        message: error.message,
        requestedSymbols,
      });
    }
  }

  return summary;
}

module.exports = {
  fetchFmpMarketNewsForSymbols,
  normalizeFmpNewsItem,
  collectAndStoreMarketNews,
};
