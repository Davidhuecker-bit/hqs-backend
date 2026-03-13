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

async function ensureMarketNewsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_news (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      source TEXT,
      published_at TIMESTAMP NULL,
      summary TEXT,
      source_type TEXT,
      entity_hint JSONB DEFAULT '{}'::jsonb,
      raw_payload JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_market_news_url
    ON market_news(url);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_market_news_symbol_published
    ON market_news(symbol, published_at DESC, created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_market_news_source_type
    ON market_news(source_type);
  `);

  if (logger?.info) logger.info("market_news table ready");
}

async function ensureOptionalColumns() {
  const columns = [
    {
      name: "source_type",
      sql: `ALTER TABLE market_news ADD COLUMN IF NOT EXISTS source_type TEXT`,
    },
    {
      name: "entity_hint",
      sql: `ALTER TABLE market_news ADD COLUMN IF NOT EXISTS entity_hint JSONB DEFAULT '{}'::jsonb`,
    },
    {
      name: "raw_payload",
      sql: `ALTER TABLE market_news ADD COLUMN IF NOT EXISTS raw_payload JSONB DEFAULT '{}'::jsonb`,
    },
  ];

  for (const column of columns) {
    await pool.query(column.sql);
  }
}

async function loadUniverseSymbols(limit = SYMBOL_LIMIT) {
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
}

function normalizeCollectedNewsItem(rawItem, fallbackSymbol) {
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
    summary,
    sourceType,
    entityHint: rawItem?.entityHint || {},
    rawPayload: rawItem?.rawPayload || {},
  };
}

async function insertNewsItem(item) {
  const result = await pool.query(
    `
    INSERT INTO market_news (
      symbol,
      title,
      url,
      source,
      published_at,
      summary,
      source_type,
      entity_hint,
      raw_payload,
      created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, NOW())
    ON CONFLICT (url) DO NOTHING
    RETURNING id
    `,
    [
      item.symbol,
      item.title,
      item.url,
      item.source,
      item.publishedAt,
      item.summary,
      item.sourceType,
      JSON.stringify(item.entityHint || {}),
      JSON.stringify(item.rawPayload || {}),
    ]
  );

  return result.rowCount > 0;
}

async function run() {
  const summary = {
    symbolsLoaded: 0,
    symbolsWithEntityMap: 0,
    rowsFetched: 0,
    rowsNormalized: 0,
    inserted: 0,
    duplicatesSkipped: 0,
    insertErrors: 0,
  };

  try {
    await ensureMarketNewsTable();
    await ensureOptionalColumns();

    const symbols = await loadUniverseSymbols(SYMBOL_LIMIT);
    summary.symbolsLoaded = symbols.length;

    if (!symbols.length) {
      if (logger?.warn) logger.warn("No symbols found in universe_symbols");
      return;
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

    for (const rawItem of rows) {
      try {
        const item = normalizeCollectedNewsItem(rawItem, rawItem?.symbol);
        if (!item) continue;

        summary.rowsNormalized += 1;

        const inserted = await insertNewsItem(item);
        if (inserted) summary.inserted += 1;
        else summary.duplicatesSkipped += 1;
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

    if (logger?.info) {
      logger.info("Market news refresh completed", summary);
    }
  } catch (error) {
    if (logger?.error) {
      logger.error("Market news refresh job failed", {
        message: error.message,
        stack: error.stack,
      });
    } else {
      console.error(error);
    }

    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

run();
