"use strict";

const { Pool } = require("pg");
const { fetchDailyCandles, toUnixSeconds } = require("./finnhubCandle.service");

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

// Minimum data points required by advancedMetrics before Finnhub backfill is
// attempted.  Must match the threshold in marketService.js (prices.length >= 30).
const MIN_POINTS = 30;

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
 * getHistoricalPrices: Primary source is market_snapshots (one price per
 * calendar day, newest-first).  When market_snapshots has fewer than MIN_POINTS
 * calendar days (i.e. the system is young), Finnhub daily candles are fetched
 * and used to fill the missing older days so that advancedMetrics can be
 * computed immediately rather than waiting 30 days for organic accumulation.
 *
 * Merge strategy:
 *   - market_snapshots rows take precedence for any date that exists in both.
 *   - Finnhub candles supply the remaining older dates.
 *   - Result is sorted newest-first (matches existing caller expectations).
 *
 * factor_history persistence is owned exclusively by factorHistory.repository.js.
 */
async function getHistoricalPrices(symbol, period) {
  const sym = String(symbol || "").toUpperCase();
  const days = parsePeriodToDays(period);

  // --- Primary: market_snapshots ---
  let snapshotRows = [];
  try {
    // DISTINCT ON (date) keeps one row per calendar day (the latest snapshot
    // of that day).  COALESCE(price_usd, price) provides a consistent USD-first
    // series; both columns are already validated positive by the snapshot job.
    const res = await pool.query(
      `SELECT DISTINCT ON (created_at::date)
         created_at::date AS day,
         COALESCE(price_usd, price) AS close
       FROM market_snapshots
       WHERE symbol        = $1
         AND created_at   >= NOW() - INTERVAL '1 day' * $2
         AND COALESCE(price_usd, price) IS NOT NULL
         AND COALESCE(price_usd, price) > 0
       ORDER BY created_at::date DESC, created_at DESC`,
      [sym, days]
    );
    snapshotRows = res.rows; // [{ day: Date, close: '123.45' }, ...]
  } catch (err) {
    if (logger?.warn) {
      logger.warn("[historicalService] getHistoricalPrices snapshot query failed", {
        symbol: sym,
        message: err.message,
      });
    }
    return [];
  }

  // Sufficient data from market_snapshots alone — no external call needed.
  if (snapshotRows.length >= MIN_POINTS) {
    return snapshotRows.map((r) => ({ close: r.close }));
  }

  // --- Fallback: Finnhub daily candles to backfill missing older days ---
  if (!process.env.FINNHUB_API_KEY) {
    if (logger?.warn) {
      logger.warn(
        "[historicalService] market_snapshots insufficient and FINNHUB_API_KEY not set — cannot backfill",
        { symbol: sym, snapshotPoints: snapshotRows.length }
      );
    }
    return snapshotRows.map((r) => ({ close: r.close }));
  }

  let candles = [];
  try {
    const toUnix = toUnixSeconds(new Date());
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);
    const fromUnix = toUnixSeconds(fromDate);

    const raw = await fetchDailyCandles(sym, fromUnix, toUnix);
    if (Array.isArray(raw)) {
      candles = raw.filter((c) => Number.isFinite(c.close) && c.close > 0);
    }
  } catch (err) {
    if (logger?.warn) {
      logger.warn("[historicalService] Finnhub candle backfill failed", {
        symbol: sym,
        message: err.message,
      });
    }
    // Return what we have from market_snapshots even without backfill.
    return snapshotRows.map((r) => ({ close: r.close }));
  }

  if (candles.length === 0) {
    return snapshotRows.map((r) => ({ close: r.close }));
  }

  // Merge: market_snapshots dates take precedence; Finnhub fills the rest.
  // Build a map: date → close (newest-first sort applied after merge)
  const merged = new Map();

  // Finnhub candles first (lower priority)
  for (const c of candles) {
    merged.set(c.date, String(c.close));
  }

  // market_snapshots override (higher priority)
  for (const r of snapshotRows) {
    const d = r.day instanceof Date ? r.day : new Date(r.day);
    const dateStr = d.toISOString().slice(0, 10);
    merged.set(dateStr, String(r.close));
  }

  // Sort newest-first (matches the ORDER BY … DESC of the original query)
  const sorted = Array.from(merged.entries())
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([, close]) => ({ close }));

  if (logger?.info) {
    logger.info("[historicalService] Finnhub backfill applied", {
      symbol: sym,
      snapshotPoints: snapshotRows.length,
      finnhubPoints: candles.length,
      mergedPoints: sorted.length,
    });
  }

  return sorted;
}

module.exports = {
  getHistoricalPrices,
};
