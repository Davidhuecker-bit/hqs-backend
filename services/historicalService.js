"use strict";

const { getPricesDaily, upsertPricesDailyBatch } = require("./pricesDaily.repository");
const { fetchMassiveHistoricalCandles } = require("./providerService");

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

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

// Minimum price points required for advanced metrics (must match marketService threshold)
const MIN_POINTS = 30;

// How far back to fetch from Massive when backfilling (2 years)
const BACKFILL_FETCH_DAYS = 730;

// Milliseconds per calendar day (24 * 60 * 60 * 1000)
const MS_PER_DAY = 86400000;

/**
 * historicalService – Historical price data reader with lazy backfill.
 *
 * Source of truth : prices_daily table.
 * Canonical writer: THIS service (lazy backfill via Massive API).
 * Optional writer : python/historical-backfill/ (batch pre-warming, not required).
 *
 * When prices_daily has insufficient data for a symbol (< MIN_POINTS rows),
 * this service fetches historical candles from the Massive API and writes them
 * to prices_daily before returning the result. Subsequent calls are served
 * directly from the table without any API calls.
 *
 * No Finnhub. No market_snapshots dependency for this path.
 */
async function getHistoricalPrices(symbol, period) {
  const sym  = String(symbol || "").toUpperCase();
  const days = parsePeriodToDays(period);

  try {
    let rows = await getPricesDaily(sym, days);

    // Lazy backfill: if prices_daily has insufficient data, fetch from Massive
    // and write to prices_daily, then re-read.
    if (rows.length < MIN_POINTS) {
      if (logger?.info) {
        logger.info("[historicalService] lazy backfill triggered", {
          symbol: sym,
          existingRows: rows.length,
          minRequired: MIN_POINTS,
        });
      }

      try {
        const today = new Date();
        const toDate   = today.toISOString().slice(0, 10);
        const fromDate = new Date(today.getTime() - BACKFILL_FETCH_DAYS * MS_PER_DAY)
          .toISOString().slice(0, 10);

        const candles = await fetchMassiveHistoricalCandles(sym, fromDate, toDate);

        if (candles && candles.length > 0) {
          await upsertPricesDailyBatch(sym, candles);
          if (logger?.info) {
            logger.info("[historicalService] lazy backfill complete", {
              symbol: sym,
              candlesFetched: candles.length,
            });
          }
          // Re-read from DB after backfill
          rows = await getPricesDaily(sym, days);
        } else {
          if (logger?.warn) {
            logger.warn("[historicalService] lazy backfill: Massive returned no candles", {
              symbol: sym,
              fromDate,
              toDate,
            });
          }
        }
      } catch (backfillErr) {
        // Backfill failed – log but still return whatever rows we have (may be empty).
        // This ensures the pipeline degrades gracefully instead of crashing.
        if (logger?.warn) {
          logger.warn("[historicalService] lazy backfill failed", {
            symbol: sym,
            message: backfillErr.message,
          });
        }
      }
    }

    return rows.map((r) => ({ close: r.close }));
  } catch (err) {
    if (logger?.warn) {
      logger.warn("[historicalService] prices_daily read failed", {
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

