"use strict";

// services/pricesDaily.repository.js
// Repository for the prices_daily table – canonical historical daily prices.
//
// Canonical readers:
//   - historicalService.js (lazy backfill)
//   - featureHistory.service.js (Z-score & gleitende Statistiken)
//   - backtest engine, etc.
//
// Canonical writers:
//   - historicalService.js (lazy backfill via Flatfiles / Massive REST)
//   - separate backfill jobs (e.g., bulk historical import)

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

const { getSharedPool } = require("../config/database");
const pool = getSharedPool();

/* ============================================================
   TABLE SETUP & MIGRATIONS
============================================================ */

async function ensurePricesDailyTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prices_daily (
      id            BIGSERIAL PRIMARY KEY,
      symbol        TEXT        NOT NULL,
      price_date    DATE        NOT NULL,
      close         NUMERIC     NOT NULL,
      open          NUMERIC,
      high          NUMERIC,
      low           NUMERIC,
      volume        BIGINT,
      transactions  BIGINT,
      source        TEXT        DEFAULT 'MASSIVE',
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (symbol, price_date)
    )
  `);

  // Migration: rename legacy "date" column -> "price_date"
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'prices_daily'
          AND column_name = 'date'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'prices_daily'
          AND column_name = 'price_date'
      ) THEN
        ALTER TABLE prices_daily RENAME COLUMN "date" TO price_date;
      END IF;
    END $$;
  `);

  // Migration: add missing columns for newer historical pipeline
  await pool.query(`
    ALTER TABLE prices_daily
      ADD COLUMN IF NOT EXISTS transactions BIGINT,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
  `);

  // Indizes für schnelle Abfragen
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_prices_daily_symbol_date
    ON prices_daily(symbol, price_date DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_prices_daily_date
    ON prices_daily(price_date DESC)
  `);
}

let _tableReady = false;

async function _ensureOnce() {
  if (_tableReady) return;
  await ensurePricesDailyTable();
  _tableReady = true;
}

/* ============================================================
   READ OPERATIONS
============================================================ */

/**
 * Retrieve historical daily prices for a symbol, newest first.
 *
 * @param {string} symbol
 * @param {number} days - number of days to look back
 * @returns {Promise<Array<{price_date: Date, close: string, open: string|null, high: string|null, low: string|null, volume: string|null, transactions: string|null, source: string|null}>>}
 */
async function getPricesDaily(symbol, days) {
  await _ensureOnce();

  const safeDays = Number.isFinite(Number(days)) ? Number(days) : 365;

  const res = await pool.query(
    `
    SELECT
      price_date,
      close,
      open,
      high,
      low,
      volume,
      transactions,
      source
    FROM prices_daily
    WHERE symbol = $1
      AND price_date >= CURRENT_DATE - $2::int
      AND close IS NOT NULL
      AND close > 0
    ORDER BY price_date DESC
    `,
    [String(symbol || "").toUpperCase(), safeDays]
  );

  return res.rows;
}

/**
 * Retrieve only the dates that already exist for a symbol within a list.
 *
 * @param {string} symbol
 * @param {string[]} dates - array of YYYY-MM-DD
 * @returns {Promise<Date[]>}
 */
async function getExistingDatesForSymbol(symbol, dates) {
  await _ensureOnce();

  const sym = String(symbol || "").toUpperCase();
  const dateValues = Array.isArray(dates) ? dates.filter(Boolean) : [];

  if (!sym || !dateValues.length) return [];

  const res = await pool.query(
    `
    SELECT price_date
    FROM prices_daily
    WHERE symbol = $1
      AND price_date = ANY($2::date[])
    ORDER BY price_date DESC
    `,
    [sym, dateValues]
  );

  return res.rows.map((r) => r.price_date);
}

/**
 * Get all existing price_date values for a symbol within a date range.
 *
 * @param {string} symbol
 * @param {Date|string} fromDate - inclusive
 * @param {Date|string} toDate - inclusive
 * @returns {Promise<Date[]>}
 */
async function getDateRangeForSymbol(symbol, fromDate, toDate) {
  await _ensureOnce();

  const sym = String(symbol || "").toUpperCase();

  const res = await pool.query(
    `
    SELECT price_date
    FROM prices_daily
    WHERE symbol = $1
      AND price_date BETWEEN $2::date AND $3::date
    ORDER BY price_date
    `,
    [sym, fromDate, toDate]
  );

  return res.rows.map((r) => r.price_date);
}

/**
 * Count valid daily price rows for a symbol within a lookback window.
 *
 * @param {string} symbol
 * @param {number} days
 * @returns {Promise<number>}
 */
async function countPricesDaily(symbol, days = 365) {
  await _ensureOnce();

  const sym = String(symbol || "").toUpperCase();
  const safeDays = Number.isFinite(Number(days)) ? Number(days) : 365;

  const res = await pool.query(
    `
    SELECT COUNT(*)::int AS count
    FROM prices_daily
    WHERE symbol = $1
      AND price_date >= CURRENT_DATE - $2::int
      AND close IS NOT NULL
      AND close > 0
    `,
    [sym, safeDays]
  );

  return res.rows[0]?.count || 0;
}

/**
 * Check if a symbol has at least N price points within the last lookbackDays.
 *
 * @param {string} symbol
 * @param {number} minPoints
 * @param {number} lookbackDays
 * @returns {Promise<boolean>}
 */
async function hasSufficientData(symbol, minPoints, lookbackDays = 365) {
  const count = await countPricesDaily(symbol, lookbackDays);
  return count >= minPoints;
}

/**
 * Get the earliest date for which we have a price for a symbol.
 *
 * @param {string} symbol
 * @returns {Promise<Date|null>}
 */
async function getEarliestDateForSymbol(symbol) {
  await _ensureOnce();

  const sym = String(symbol || "").toUpperCase();

  const res = await pool.query(
    `
    SELECT MIN(price_date) AS earliest
    FROM prices_daily
    WHERE symbol = $1
    `,
    [sym]
  );

  return res.rows[0]?.earliest || null;
}

/**
 * Retrieve daily prices for a symbol within a calendar date range, oldest first.
 * Designed for forward-return calculations anchored to a specific historical date.
 *
 * @param {string}       symbol
 * @param {Date|string}  fromDate  inclusive start date (e.g. signal_time)
 * @param {Date|string}  toDate    inclusive end date
 * @param {number}       [limit=40] max rows to return
 * @returns {Promise<Array<{price_date: Date, close: string, open: string|null, high: string|null, low: string|null, volume: string|null}>>}
 */
async function getPricesDailyInRange(symbol, fromDate, toDate, limit = 40) {
  await _ensureOnce();

  const sym = String(symbol || "").toUpperCase();
  const safeLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(Number(limit), 200)
    : 40;

  const res = await pool.query(
    `
    SELECT
      price_date,
      close,
      open,
      high,
      low,
      volume
    FROM prices_daily
    WHERE symbol = $1
      AND price_date >= $2::date
      AND price_date <= $3::date
      AND close IS NOT NULL
      AND close > 0
    ORDER BY price_date ASC
    LIMIT $4
    `,
    [sym, fromDate, toDate, safeLimit]
  );

  return res.rows;
}

/**
 * Get the latest date for which we have a price for a symbol.
 *
 * @param {string} symbol
 * @returns {Promise<Date|null>}
 */
async function getLatestPriceDateForSymbol(symbol) {
  await _ensureOnce();

  const sym = String(symbol || "").toUpperCase();

  const res = await pool.query(
    `
    SELECT MAX(price_date) AS latest
    FROM prices_daily
    WHERE symbol = $1
    `,
    [sym]
  );

  return res.rows[0]?.latest || null;
}

/* ============================================================
   WRITE OPERATIONS
============================================================ */

/**
 * Bulk upsert daily candle rows into prices_daily.
 * Uses a single INSERT ... ON CONFLICT DO UPDATE for all rows.
 *
 * @param {string} symbol
 * @param {Array<{date: string, close: number, open?: number, high?: number, low?: number, volume?: number, transactions?: number, source?: string}>} rows
 * @returns {Promise<number>} number of rows inserted/updated
 */
async function upsertPricesDailyBatch(symbol, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  await _ensureOnce();

  const sym = String(symbol || "").toUpperCase();
  const COL_COUNT = 9; // symbol, price_date, close, open, high, low, volume, transactions, source
  const values = [];
  const params = [];

  for (const r of rows) {
    if (!r || !r.date) continue;

    const close = Number(r.close);
    if (!Number.isFinite(close) || close <= 0) continue;

    const base = params.length + 1;
    const placeholders = Array.from({ length: COL_COUNT }, (_, i) => `$${base + i}`).join(", ");
    values.push(`(${placeholders})`);

    params.push(
      sym,
      r.date,
      close,
      r.open != null && Number.isFinite(Number(r.open)) ? Number(r.open) : null,
      r.high != null && Number.isFinite(Number(r.high)) ? Number(r.high) : null,
      r.low != null && Number.isFinite(Number(r.low)) ? Number(r.low) : null,
      r.volume != null && Number.isFinite(Number(r.volume)) ? Number(r.volume) : null,
      r.transactions != null && Number.isFinite(Number(r.transactions)) ? Number(r.transactions) : null,
      String(r.source || "MASSIVE")
    );
  }

  if (values.length === 0) return 0;

  await pool.query(
    `
    INSERT INTO prices_daily
      (symbol, price_date, close, open, high, low, volume, transactions, source)
    VALUES ${values.join(", ")}
    ON CONFLICT (symbol, price_date)
    DO UPDATE SET
      close        = EXCLUDED.close,
      open         = EXCLUDED.open,
      high         = EXCLUDED.high,
      low          = EXCLUDED.low,
      volume       = EXCLUDED.volume,
      transactions = EXCLUDED.transactions,
      source       = EXCLUDED.source,
      updated_at   = NOW()
    `,
    params
  );

  if (logger?.info) {
    logger.info("[pricesDaily] upserted rows", {
      symbol: sym,
      count: values.length,
    });
  }

  return values.length;
}

module.exports = {
  ensurePricesDailyTable,
  getPricesDaily,
  getPricesDailyInRange,
  getExistingDatesForSymbol,
  getDateRangeForSymbol,
  countPricesDaily,
  hasSufficientData,
  upsertPricesDailyBatch,
  getEarliestDateForSymbol,
  getLatestPriceDateForSymbol,
};
