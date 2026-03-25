"use strict";

// services/pricesDaily.repository.js
// Repository for the prices_daily table – canonical historical daily close prices.
// Writer: historicalService.js (lazy backfill from Massive on demand).
// Reader: historicalService.js (getHistoricalPrices).

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

/**
 * Ensure the prices_daily table exists.
 * Called once on first use (lazy DDL).
 */
async function ensurePricesDailyTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prices_daily (
      id          SERIAL PRIMARY KEY,
      symbol      TEXT        NOT NULL,
      price_date  DATE        NOT NULL,
      close       NUMERIC     NOT NULL,
      open        NUMERIC,
      high        NUMERIC,
      low         NUMERIC,
      volume      BIGINT,
      source      TEXT        DEFAULT 'MASSIVE',
      created_at  TIMESTAMP   DEFAULT NOW(),
      UNIQUE (symbol, price_date)
    )
  `);
}

let _tableReady = false;
async function _ensureOnce() {
  if (_tableReady) return;
  await ensurePricesDailyTable();
  _tableReady = true;
}

/**
 * Read historical daily closes for a symbol, newest-first.
 *
 * @param {string} symbol
 * @param {number} days  – look-back window in calendar days
 * @returns {Promise<Array<{price_date: Date, close: string}>>}
 */
async function getPricesDaily(symbol, days) {
  await _ensureOnce();
  const res = await pool.query(
    `SELECT price_date, close
       FROM prices_daily
      WHERE symbol     = $1
        AND price_date >= CURRENT_DATE - $2::int
        AND close      IS NOT NULL
        AND close      > 0
      ORDER BY price_date DESC`,
    [String(symbol).toUpperCase(), days]
  );
  return res.rows;
}

/**
 * Bulk-upsert daily candle rows into prices_daily.
 * Existing (symbol, price_date) pairs are updated only when the incoming
 * close value is newer (idempotent on repeated backfills).
 *
 * @param {string} symbol
 * @param {Array<{date: string, close: number, open?: number, high?: number, low?: number, volume?: number, source?: string}>} rows
 */
async function upsertPricesDailyBatch(symbol, rows) {
  if (!rows || rows.length === 0) return;
  await _ensureOnce();

  const sym = String(symbol).toUpperCase();

  // Build a single multi-row upsert for efficiency.
  const COL_COUNT = 8; // symbol, price_date, close, open, high, low, volume, source
  const values = [];
  const params = [];

  for (const r of rows) {
    if (!r.date || !Number.isFinite(Number(r.close)) || Number(r.close) <= 0) continue;
    const base = params.length + 1;
    const placeholders = Array.from({ length: COL_COUNT }, (_, i) => `$${base + i}`).join(", ");
    values.push(`(${placeholders})`);
    params.push(
      sym,
      r.date,
      Number(r.close),
      r.open   != null ? Number(r.open)   : null,
      r.high   != null ? Number(r.high)   : null,
      r.low    != null ? Number(r.low)    : null,
      r.volume != null ? Number(r.volume) : null,
      String(r.source || "MASSIVE")
    );
  }

  if (values.length === 0) return;

  await pool.query(
    `INSERT INTO prices_daily (symbol, price_date, close, open, high, low, volume, source)
     VALUES ${values.join(", ")}
     ON CONFLICT (symbol, price_date)
     DO UPDATE SET
       close  = EXCLUDED.close,
       open   = EXCLUDED.open,
       high   = EXCLUDED.high,
       low    = EXCLUDED.low,
       volume = EXCLUDED.volume,
       source = EXCLUDED.source`,
    params
  );

  if (logger?.info) {
    logger.info("[pricesDaily] upserted rows", { symbol: sym, count: values.length });
  }
}

module.exports = {
  ensurePricesDailyTable,
  getPricesDaily,
  upsertPricesDailyBatch,
};
