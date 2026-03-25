"use strict";

const { getPricesDaily } = require("./pricesDaily.repository");

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

/**
 * historicalService – Historical price data reader.
 *
 * Source of truth : prices_daily table.
 * Writer          : jobs/historicalBackfill.job.py (separate scheduled job).
 *
 * This service is a pure reader. It never calls external APIs and never
 * writes to prices_daily. Backfilling is handled exclusively by the
 * Historical Backfill cron job.
 *
 * No Finnhub. No market_snapshots dependency for this path.
 */
async function getHistoricalPrices(symbol, period) {
  const sym  = String(symbol || "").toUpperCase();
  const days = parsePeriodToDays(period);

  try {
    const rows = await getPricesDaily(sym, days);
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

