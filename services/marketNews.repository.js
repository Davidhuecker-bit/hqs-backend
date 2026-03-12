"use strict";

const { Pool } = require("pg");
let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

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

function normalizeNewsItem(item) {
  const symbol = cleanSymbol(item?.symbol);
  const title = cleanText(item?.title);
  const url = cleanText(item?.url);

  if (!symbol || !title || !url) return null;

  return {
    symbol,
    title,
    source: cleanText(item?.source),
    url,
    publishedAt: cleanPublishedAt(item?.publishedAt ?? item?.published_at),
    summaryRaw: cleanText(item?.summaryRaw ?? item?.summary_raw),
    sentimentRaw: cleanText(item?.sentimentRaw ?? item?.sentiment_raw),
    category: cleanText(item?.category),
  };
}

async function initMarketNewsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS market_news (
        id SERIAL PRIMARY KEY,
        symbol TEXT NOT NULL,
        title TEXT NOT NULL,
        source TEXT,
        url TEXT NOT NULL,
        published_at TIMESTAMP,
        summary_raw TEXT,
        sentiment_raw TEXT,
        category TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`ALTER TABLE market_news ADD COLUMN IF NOT EXISTS symbol TEXT;`);
    await pool.query(`ALTER TABLE market_news ADD COLUMN IF NOT EXISTS title TEXT;`);
    await pool.query(`ALTER TABLE market_news ADD COLUMN IF NOT EXISTS source TEXT;`);
    await pool.query(`ALTER TABLE market_news ADD COLUMN IF NOT EXISTS url TEXT;`);
    await pool.query(`ALTER TABLE market_news ADD COLUMN IF NOT EXISTS published_at TIMESTAMP;`);
    await pool.query(`ALTER TABLE market_news ADD COLUMN IF NOT EXISTS summary_raw TEXT;`);
    await pool.query(`ALTER TABLE market_news ADD COLUMN IF NOT EXISTS sentiment_raw TEXT;`);
    await pool.query(`ALTER TABLE market_news ADD COLUMN IF NOT EXISTS category TEXT;`);
    await pool.query(`ALTER TABLE market_news ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);
    await pool.query(`ALTER TABLE market_news ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();`);

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'market_news_symbol_url_key'
        ) THEN
          ALTER TABLE market_news
          ADD CONSTRAINT market_news_symbol_url_key UNIQUE (symbol, url);
        END IF;
      END
      $$;
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_market_news_symbol_published_at
      ON market_news (symbol, published_at DESC);
    `);

    if (logger?.info) logger.info("market_news ready");
  } catch (error) {
    if (logger?.error) logger.error("initMarketNewsTable error", { message: error.message });
    throw error;
  }
}

async function upsertMarketNews(items) {
  try {
    const rows = Array.isArray(items) ? items : [];
    if (!rows.length) return { insertedOrUpdated: 0 };

    const deduped = new Map();

    for (const item of rows) {
      const normalized = normalizeNewsItem(item);
      if (!normalized) continue;
      deduped.set(`${normalized.symbol}::${normalized.url}`, normalized);
    }

    const values = [...deduped.values()];
    if (!values.length) return { insertedOrUpdated: 0 };

    const placeholders = [];
    const params = [];
    let index = 1;

    for (const item of values) {
      placeholders.push(
        `($${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, NOW(), NOW())`
      );
      params.push(
        item.symbol,
        item.title,
        item.source,
        item.url,
        item.publishedAt,
        item.summaryRaw,
        item.sentimentRaw,
        item.category
      );
    }

    await pool.query(
      `
      INSERT INTO market_news (
        symbol,
        title,
        source,
        url,
        published_at,
        summary_raw,
        sentiment_raw,
        category,
        created_at,
        updated_at
      )
      VALUES
        ${placeholders.join(",\n")}
      ON CONFLICT (symbol, url) DO UPDATE SET
        title = EXCLUDED.title,
        source = EXCLUDED.source,
        published_at = EXCLUDED.published_at,
        summary_raw = EXCLUDED.summary_raw,
        sentiment_raw = EXCLUDED.sentiment_raw,
        category = EXCLUDED.category,
        updated_at = NOW()
      `,
      params
    );

    if (logger?.info) logger.info("market news upserted", { count: values.length });
    return { insertedOrUpdated: values.length };
  } catch (error) {
    if (logger?.error) logger.error("upsertMarketNews error", { message: error.message });
    throw error;
  }
}

async function loadLatestMarketNewsBySymbols(symbols, limitPerSymbol = 5) {
  try {
    const normalizedSymbols = [...new Set(
      (Array.isArray(symbols) ? symbols : [])
        .map(cleanSymbol)
        .filter(Boolean)
    )];

    if (!normalizedSymbols.length) return {};

    const limit = Math.max(1, Math.min(Number(limitPerSymbol) || 5, 100));

    const res = await pool.query(
      `
      SELECT
        symbol,
        title,
        source,
        url,
        published_at,
        summary_raw,
        sentiment_raw,
        category
      FROM (
        SELECT
          symbol,
          title,
          source,
          url,
          published_at,
          summary_raw,
          sentiment_raw,
          category,
          ROW_NUMBER() OVER (
            PARTITION BY symbol
            ORDER BY published_at DESC NULLS LAST, updated_at DESC, id DESC
          ) AS row_num
        FROM market_news
        WHERE symbol = ANY($1::text[])
      ) ranked
      WHERE row_num <= $2
      ORDER BY symbol ASC, published_at DESC NULLS LAST, row_num ASC
      `,
      [normalizedSymbols, limit]
    );

    const grouped = normalizedSymbols.reduce((acc, symbol) => {
      acc[symbol] = [];
      return acc;
    }, {});

    for (const row of res.rows) {
      grouped[row.symbol].push({
        symbol: row.symbol,
        title: row.title,
        source: row.source ?? null,
        url: row.url,
        publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
        summaryRaw: row.summary_raw ?? null,
        sentimentRaw: row.sentiment_raw ?? null,
        category: row.category ?? null,
      });
    }

    return grouped;
  } catch (error) {
    if (logger?.error) logger.error("loadLatestMarketNewsBySymbols error", { message: error.message });
    return {};
  }
}

async function countMarketNewsBySymbol(symbol) {
  try {
    const normalizedSymbol = cleanSymbol(symbol);
    if (!normalizedSymbol) return 0;

    const res = await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM market_news
      WHERE symbol = $1
      `,
      [normalizedSymbol]
    );

    return Number(res.rows?.[0]?.count ?? 0) || 0;
  } catch (error) {
    if (logger?.error) logger.error("countMarketNewsBySymbol error", { message: error.message });
    return 0;
  }
}

module.exports = {
  initMarketNewsTable,
  upsertMarketNews,
  loadLatestMarketNewsBySymbols,
  countMarketNewsBySymbol,
};
