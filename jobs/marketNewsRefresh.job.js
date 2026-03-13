"use strict";

require("dotenv").config();

const axios = require("axios");
const { Pool } = require("pg");

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = console;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const FMP_API_KEY = String(process.env.FMP_API_KEY || "").trim();
const NEWS_LIMIT_PER_SYMBOL = Math.max(
  1,
  Math.min(Number(process.env.MARKET_NEWS_LIMIT_PER_SYMBOL || 5), 10)
);
const SYMBOL_LIMIT = Math.max(
  1,
  Math.min(Number(process.env.MARKET_NEWS_SYMBOL_LIMIT || 100), 500)
);
const REQUEST_DELAY_MS = Math.max(
  0,
  Math.min(Number(process.env.MARKET_NEWS_REQUEST_DELAY_MS || 250), 5000)
);
const REQUEST_TIMEOUT_MS = Math.max(
  3000,
  Math.min(Number(process.env.MARKET_NEWS_REQUEST_TIMEOUT_MS || 12000), 30000)
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSymbol(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeText(value, maxLength = 5000) {
  const text = String(value || "").trim();
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

  if (logger?.info) logger.info("market_news table ready");
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

async function fetchFmpNewsForSymbol(symbol, limit = NEWS_LIMIT_PER_SYMBOL) {
  if (!FMP_API_KEY) {
    throw new Error("FMP_API_KEY fehlt");
  }

  const url = "https://financialmodelingprep.com/api/v3/stock_news";

  const response = await axios.get(url, {
    params: {
      tickers: symbol,
      limit,
      apikey: FMP_API_KEY,
    },
    timeout: REQUEST_TIMEOUT_MS,
  });

  return Array.isArray(response.data) ? response.data : [];
}

function normalizeNewsItem(rawItem, fallbackSymbol) {
  const symbol = normalizeSymbol(
    rawItem?.symbol || rawItem?.ticker || rawItem?.tickers || fallbackSymbol
  );

  const title = normalizeText(rawItem?.title, 1000);
  const url = normalizeUrl(rawItem?.url || rawItem?.link);
  const source = normalizeText(rawItem?.site || rawItem?.source || "FMP", 255);
  const publishedAt = parsePublishedAt(
    rawItem?.publishedDate || rawItem?.published_at || rawItem?.date
  );
  const summary = normalizeText(rawItem?.text || rawItem?.summary, 5000);

  if (!symbol || !title || !url) return null;

  return {
    symbol,
    title,
    url,
    source,
    publishedAt,
    summary,
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
      created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
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
    ]
  );

  return result.rowCount > 0;
}

async function run() {
  const summary = {
    symbolsLoaded: 0,
    symbolsProcessed: 0,
    fetchErrors: 0,
    rowsFetched: 0,
    rowsNormalized: 0,
    inserted: 0,
    duplicatesSkipped: 0,
  };

  try {
    await ensureMarketNewsTable();

    const symbols = await loadUniverseSymbols(SYMBOL_LIMIT);
    summary.symbolsLoaded = symbols.length;

    if (!symbols.length) {
      if (logger?.warn) logger.warn("No symbols found in universe_symbols");
      return;
    }

    if (logger?.info) {
      logger.info("Market news refresh started", {
        symbolsLoaded: symbols.length,
        perSymbolLimit: NEWS_LIMIT_PER_SYMBOL,
      });
    }

    for (const symbol of symbols) {
      try {
        const rows = await fetchFmpNewsForSymbol(symbol, NEWS_LIMIT_PER_SYMBOL);
        summary.symbolsProcessed += 1;
        summary.rowsFetched += rows.length;

        for (const rawItem of rows) {
          const item = normalizeNewsItem(rawItem, symbol);
          if (!item) continue;

          summary.rowsNormalized += 1;

          const inserted = await insertNewsItem(item);
          if (inserted) summary.inserted += 1;
          else summary.duplicatesSkipped += 1;
        }

        if (REQUEST_DELAY_MS > 0) {
          await sleep(REQUEST_DELAY_MS);
        }
      } catch (error) {
        summary.fetchErrors += 1;

        if (logger?.warn) {
          logger.warn("Market news fetch failed", {
            symbol,
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
