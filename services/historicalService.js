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

/**
 * Parse a period string (e.g. "1y", "6m", "3m", "30d") into a number of days.
 */
function parsePeriodToDays(period) {
  const s = String(period || "1y").toLowerCase().trim();
  const num = parseFloat(s);
  if (s.endsWith("y")) return Math.round((isNaN(num) ? 1 : num) * 365);
  if (s.endsWith("m")) return Math.round((isNaN(num) ? 1 : num) * 30);
  if (s.endsWith("d")) return isNaN(num) ? 365 : Math.round(num);
  return 365;
}

/**
 * historicalService – Historical price data provider.
 *
 * getHistoricalPrices: Queries market_snapshots for one price per calendar day
 * (the latest snapshot of each day, newest-first) and returns an array of
 * { close } objects that buildTrendScore() expects.  Falls back to [] on error
 * so the caller's graceful-degradation path is still exercised.
 *
 * factor_history persistence is owned exclusively by factorHistory.repository.js.
 */
async function getHistoricalPrices(symbol, period) {
  const sym = String(symbol || "").toUpperCase();
  const days = parsePeriodToDays(period);

  try {
    // DISTINCT ON (date) keeps one row per calendar day (the latest snapshot
    // of that day).  COALESCE(price_usd, price) provides a consistent USD-first
    // series; both columns are already validated positive by the snapshot job.
    const res = await pool.query(
      `SELECT DISTINCT ON (created_at::date)
         COALESCE(price_usd, price) AS close
       FROM market_snapshots
       WHERE symbol        = $1
         AND created_at   >= NOW() - INTERVAL '1 day' * $2
         AND COALESCE(price_usd, price) IS NOT NULL
         AND COALESCE(price_usd, price) > 0
       ORDER BY created_at::date DESC, created_at DESC`,
      [sym, days]
    );
    return res.rows; // [{ close: '123.45' }, ...]
  } catch (err) {
    if (logger?.warn) {
      logger.warn("[historicalService] getHistoricalPrices failed", {
        symbol: sym,
        message: err.message,
      });
    }
    return [];
  }
}

module.exports = {
  getHistoricalPrices,
};
