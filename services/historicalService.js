"use strict";

const { getPricesDaily, upsertPricesDailyBatch } = require("./pricesDaily.repository");
const { fetchMassiveHistoricalCandles } = require("./providerService");

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

// Minimum data points required by advancedMetrics.
// Must match the threshold in marketService.js (prices.length >= 30).
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

// Newest-first comparator for ISO date strings ("YYYY-MM-DD").
const newestFirst = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);

/**
 * historicalService – Historical price data provider.
 *
 * Source of truth: prices_daily table.
 * Writer:          this service (lazy Massive backfill on first request).
 *
 * Flow:
 *   1. Read from prices_daily (DB-first).
 *   2. If >= MIN_POINTS → return immediately (no external call).
 *   3. If < MIN_POINTS → fetch up to `days` calendar days of OHLCV
 *      from Massive historical candles endpoint.
 *   4. Upsert fetched rows into prices_daily (idempotent).
 *   5. Re-read from prices_daily and return the merged result.
 *
 * No Finnhub. No market_snapshots dependency for this path.
 */
async function getHistoricalPrices(symbol, period) {
  const sym = String(symbol || "").toUpperCase();
  const days = parsePeriodToDays(period);

  // --- Step 1: DB-first read from prices_daily ---
  let rows = [];
  try {
    rows = await getPricesDaily(sym, days);
  } catch (err) {
    if (logger?.warn) {
      logger.warn("[historicalService] prices_daily read failed", {
        symbol: sym,
        message: err.message,
      });
    }
    return [];
  }

  // Sufficient data already stored — return immediately.
  if (rows.length >= MIN_POINTS) {
    return rows.map((r) => ({ close: r.close }));
  }

  // --- Step 3: Backfill from Massive ---
  if (!process.env.MASSIVE_API_KEY) {
    if (logger?.warn) {
      logger.warn(
        "[historicalService] prices_daily insufficient and MASSIVE_API_KEY not set – cannot backfill",
        { symbol: sym, storedPoints: rows.length }
      );
    }
    return rows.map((r) => ({ close: r.close }));
  }

  const toDate   = new Date().toISOString().slice(0, 10);
  const fromDate = (() => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
  })();

  let candles = [];
  try {
    const raw = await fetchMassiveHistoricalCandles(sym, fromDate, toDate);
    candles = (raw || []).filter(
      (c) => Number.isFinite(Number(c.close)) && Number(c.close) > 0
    );
  } catch (err) {
    if (logger?.warn) {
      logger.warn("[historicalService] Massive historical backfill failed", {
        symbol: sym,
        message: err.message,
      });
    }
    // Return whatever we have from DB even without backfill.
    return rows.map((r) => ({ close: r.close }));
  }

  if (candles.length === 0) {
    return rows.map((r) => ({ close: r.close }));
  }

  // --- Step 4: Persist to prices_daily ---
  try {
    await upsertPricesDailyBatch(sym, candles);
  } catch (err) {
    if (logger?.warn) {
      logger.warn("[historicalService] prices_daily upsert failed after Massive backfill", {
        symbol: sym,
        message: err.message,
      });
    }
    // Serve candles directly from memory rather than failing entirely.
    return candles
      .slice()
      .sort(newestFirst)
      .map((c) => ({ close: String(c.close) }));
  }

  // --- Step 5: Re-read from DB (authoritative) ---
  let refreshed = [];
  try {
    refreshed = await getPricesDaily(sym, days);
  } catch (err) {
    if (logger?.warn) {
      logger.warn("[historicalService] prices_daily re-read after backfill failed", {
        symbol: sym,
        message: err.message,
      });
    }
    // Graceful degradation: return in-memory candles.
    return candles
      .slice()
      .sort(newestFirst)
      .map((c) => ({ close: String(c.close) }));
  }

  if (logger?.info) {
    logger.info("[historicalService] Massive backfill applied and persisted", {
      symbol: sym,
      storedBefore: rows.length,
      massiveCandles: candles.length,
      storedAfter: refreshed.length,
    });
  }

  return refreshed.map((r) => ({ close: r.close }));
}

module.exports = {
  getHistoricalPrices,
};

