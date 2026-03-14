"use strict";

require("dotenv").config();

const { Pool } = require("pg");

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = console;
}

const {
  collectFreeNewsForSymbols,
} = require("../services/freeNewsCollector.service");

const {
  loadEntityMapBySymbols,
} = require("../services/entityMap.repository");
const {
  initJobLocksTable,
  acquireLock,
} = require("../services/jobLock.repository");

const {
  analyzeNewsArticle,
  buildNewsLifecycle,
} = require("../services/newsIntelligence.service");

const marketNewsRepository = require("../services/marketNews.repository");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const NEWS_LIMIT_PER_SYMBOL = Math.max(
  1,
  Math.min(Number(process.env.MARKET_NEWS_LIMIT_PER_SYMBOL || 5), 20)
);

const SYMBOL_LIMIT = Math.max(
  1,
  Math.min(Number(process.env.MARKET_NEWS_SYMBOL_LIMIT || 100), 500)
);

const REQUEST_TIMEOUT_MS = Math.max(
  3000,
  Math.min(Number(process.env.MARKET_NEWS_REQUEST_TIMEOUT_MS || 20000), 60000)
);

const MAX_FEEDS_PER_SYMBOL = Math.max(
  1,
  Math.min(Number(process.env.MARKET_NEWS_MAX_FEEDS_PER_SYMBOL || 3), 10)
);

const MIN_MATCH_SCORE = Math.max(
  0,
  Math.min(Number(process.env.MARKET_NEWS_MIN_MATCH_SCORE || 2), 20)
);

function normalizeSymbol(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeText(value, maxLength = 5000) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return null;
  return text.slice(0, maxLength);
}

function normalizeUrl(value) {
  const url = String(value || "").trim();
  if (!url) return null;
  return url.slice(0, 2000);
}

function parsePublishedAt(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString();
}

async function loadUniverseSymbols(limit = SYMBOL_LIMIT) {
  try {
    const res = await pool.query(
      `
      SELECT symbol
      FROM universe_symbols
      ORDER BY symbol ASC
      LIMIT $1
      `,
      [limit]
    );

    return (res.rows || [])
      .map((row) => normalizeSymbol(row.symbol))
      .filter(Boolean);
  } catch (error) {
    if (logger?.warn) {
      logger.warn("Failed to load universe_symbols", {
        message: error.message,
      });
    }
    return [];
  }
}

async function loadWatchlistSymbols(limit = SYMBOL_LIMIT) {
  try {
    const res = await pool.query(
      `
      SELECT symbol
      FROM watchlist_symbols
      WHERE is_active = TRUE
      ORDER BY priority ASC, symbol ASC
      LIMIT $1
      `,
      [limit]
    );

    return (res.rows || [])
      .map((row) => normalizeSymbol(row.symbol))
      .filter(Boolean);
  } catch (error) {
    if (logger?.warn) {
      logger.warn("Failed to load watchlist_symbols", {
        message: error.message,
      });
    }
    return [];
  }
}

async function loadEntityMapSymbols(limit = SYMBOL_LIMIT) {
  try {
    const res = await pool.query(
      `
      SELECT symbol
      FROM entity_map
      WHERE is_active = TRUE
      ORDER BY symbol ASC
      LIMIT $1
      `,
      [limit]
    );

    return (res.rows || [])
      .map((row) => normalizeSymbol(row.symbol))
      .filter(Boolean);
  } catch (error) {
    if (logger?.warn) {
      logger.warn("Failed to load entity_map symbols", {
        message: error.message,
      });
    }
    return [];
  }
}

async function loadTargetSymbols(limit = SYMBOL_LIMIT) {
  const universeSymbols = await loadUniverseSymbols(limit);
  if (universeSymbols.length) {
    if (logger?.info) {
      logger.info("Loaded symbols from universe_symbols", {
        count: universeSymbols.length,
      });
    }
    return universeSymbols;
  }

  const watchlistSymbols = await loadWatchlistSymbols(limit);
  if (watchlistSymbols.length) {
    if (logger?.info) {
      logger.info("Universe empty - fallback to watchlist_symbols", {
        count: watchlistSymbols.length,
      });
    }
    return watchlistSymbols;
  }

  const entitySymbols = await loadEntityMapSymbols(limit);
  if (entitySymbols.length) {
    if (logger?.info) {
      logger.info("Universe + watchlist empty - fallback to entity_map", {
        count: entitySymbols.length,
      });
    }
    return entitySymbols;
  }

  return [];
}

function normalizeCollectedNewsItem(rawItem, fallbackSymbol, intelligence = {}) {
  const symbol = normalizeSymbol(rawItem?.symbol || fallbackSymbol);
  const title = normalizeText(rawItem?.title, 1000);
  const url = normalizeUrl(rawItem?.url);
  const source = normalizeText(rawItem?.source || "Free News Collector", 255);
  const publishedAt = parsePublishedAt(rawItem?.publishedAt);
  const summary = normalizeText(rawItem?.summaryRaw || rawItem?.summary, 5000);
  const sourceType = normalizeText(rawItem?.sourceType || "rss", 120);

  if (!symbol || !title || !url) return null;

  return {
    symbol,
    title,
    url,
    source,
    publishedAt,
    summaryRaw: summary,
    sourceType,
    entityHint: rawItem?.entityHint || {},
    rawPayload: rawItem?.rawPayload || {},
    intelligence: intelligence || {},
  };
}

async function run() {
  const summary = {
    symbolsLoaded: 0,
    symbolsWithEntityMap: 0,
    rowsFetched: 0,
    rowsNormalized: 0,
    intelligenceBuilt: 0,
    inserted: 0,
    duplicatesSkipped: 0,
    insertErrors: 0,
    cooled: 0,
    expired: 0,
  };

  await initJobLocksTable();

  const won = await acquireLock("market_news_refresh_job", 60 * 60);
  if (!won) {
    if (logger?.warn) {
      logger.warn("Market news refresh skipped (lock held)");
    }

    return {
      skipped: true,
      summary,
    };
  }

  await marketNewsRepository.initMarketNewsTable();

  const symbols = await loadTargetSymbols(SYMBOL_LIMIT);
  summary.symbolsLoaded = symbols.length;

  if (!symbols.length) {
    if (logger?.warn) {
      logger.warn("No symbols found in universe_symbols, watchlist_symbols or entity_map");
    }
    return {
      skipped: true,
      summary,
    };
  }

  const entityMapBySymbol = await loadEntityMapBySymbols(symbols);
  summary.symbolsWithEntityMap = Object.keys(entityMapBySymbol || {}).length;

  if (logger?.info) {
    logger.info("Market news refresh started", {
      symbolsLoaded: summary.symbolsLoaded,
      symbolsWithEntityMap: summary.symbolsWithEntityMap,
      perSymbolLimit: NEWS_LIMIT_PER_SYMBOL,
      maxFeedsPerSymbol: MAX_FEEDS_PER_SYMBOL,
      minMatchScore: MIN_MATCH_SCORE,
    });
  }

  const rows = await collectFreeNewsForSymbols(symbols, entityMapBySymbol, {
    maxFeedsPerSymbol: MAX_FEEDS_PER_SYMBOL,
    maxItemsPerSymbol: NEWS_LIMIT_PER_SYMBOL,
    minMatchScore: MIN_MATCH_SCORE,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  summary.rowsFetched = rows.length;

  const normalizedItems = [];

  for (const rawItem of rows) {
    try {
      const intelligence = analyzeNewsArticle(rawItem, entityMapBySymbol);
      summary.intelligenceBuilt += 1;

      const item = normalizeCollectedNewsItem(
        rawItem,
        rawItem?.symbol,
        intelligence
      );

      if (!item) continue;

      summary.rowsNormalized += 1;
      const lifecycle = buildNewsLifecycle(item, intelligence);

      normalizedItems.push({
        ...item,
        retentionClass: lifecycle.retentionClass,
        expiresAt: lifecycle.expiresAt,
        isActiveForScoring: lifecycle.isActiveForScoring,
        lifecycleState: lifecycle.lifecycleState,
      });
    } catch (error) {
      summary.insertErrors += 1;

      if (logger?.warn) {
        logger.warn("Market news insert failed", {
          symbol: rawItem?.symbol || null,
          url: rawItem?.url || null,
          message: error.message,
        });
      }
    }
  }

  if (normalizedItems.length) {
    const result = await marketNewsRepository.upsertMarketNews(normalizedItems);
    summary.inserted = Number(result?.insertedOrUpdated ?? 0) || 0;
    summary.duplicatesSkipped = Math.max(
      0,
      summary.rowsNormalized - summary.inserted
    );
    const lifecycleSummary = await marketNewsRepository.syncMarketNewsLifecycleStates();
    summary.cooled = Number(lifecycleSummary?.cooled ?? 0) || 0;
    summary.expired = Number(lifecycleSummary?.expired ?? 0) || 0;
  }

  if (logger?.info) {
    logger.info("Market news refresh completed", summary);
  }

  return {
    skipped: false,
    summary,
  };
}

async function runMarketNewsRefreshJob(options = {}) {
  try {
    return await run();
  } finally {
    if (options?.closePool !== false) {
      await pool.end().catch(() => {});
    }
  }
}

if (require.main === module) {
  runMarketNewsRefreshJob()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      if (logger?.error) {
        logger.error("Market news refresh job failed", {
          message: error.message,
          stack: error.stack,
        });
      } else {
        console.error(error);
      }

      process.exit(1);
    });
}

module.exports = {
  runMarketNewsRefreshJob,
};
