"use strict";

/**
 * Market Summary Builder  (Step 3 – Read-Model Layer)
 * -----------------------------------------------------
 * Separates the heavy 4-query aggregation (builder/refresh path) from the
 * hot read path (single SELECT on ui_summaries) for /api/market.
 *
 * Read path  : readMarketSummary()          → single DB read, returns prepared data
 * Build path : refreshMarketSummary()       → calls getStoredMarketList() + writes to DB
 * Smart path : getOrBuildMarketSummary()    → SWR-like: fresh=serve, stale=serve+async-refresh, missing=build
 *
 * Fresh threshold: 5 minutes (MARKET_SUMMARY_MAX_AGE_MS)
 * The existing 30 s in-memory cache in marketService is preserved and still
 * operates at the function level.  This layer adds DB persistence so cold
 * restarts can immediately serve data without re-running all 4 batch queries.
 *
 * Parallel-refresh guard: _isRefreshing flag prevents concurrent builder runs.
 */

const logger = require("../utils/logger");
const { readUiSummary, writeUiSummary } = require("./uiSummary.repository");
const { getStoredMarketList } = require("./marketService");

const SUMMARY_TYPE = "market_list";

// DB-persisted summary is considered fresh for 5 minutes.
// Intentionally longer than the 30 s in-memory cache – the goal is to survive
// cold restarts without rerunning 4 batch queries.
const MARKET_SUMMARY_MAX_AGE_MS = 5 * 60 * 1000; // 5 min

// Parallel-refresh guard
let _isRefreshing = false;

/* =========================================================
   READ PATH
========================================================= */

/**
 * Read the prepared market summary from ui_summaries (single DB query).
 * Returns enriched metadata alongside the stock list, or null if not found.
 *
 * @returns {Promise<{stocks: object[], symbolCount: number, builtAt: string|null, isPartial: boolean, buildDurationMs: number|null, ageMs: number, freshness: string}|null>}
 */
async function readMarketSummary() {
  const row = await readUiSummary(SUMMARY_TYPE);
  if (!row) return null;

  const ageMs = row.builtAt ? Date.now() - new Date(row.builtAt).getTime() : Infinity;
  const freshness = ageMs < MARKET_SUMMARY_MAX_AGE_MS ? "fresh" : "stale";

  return {
    stocks:          Array.isArray(row.payload?.stocks) ? row.payload.stocks : [],
    symbolCount:     Number(row.payload?.symbolCount) || 0,
    builtAt:         row.builtAt,
    isPartial:       row.isPartial,
    buildDurationMs: row.buildDurationMs,
    ageMs,
    freshness,
  };
}

/* =========================================================
   BUILD / REFRESH PATH
========================================================= */

/**
 * Build the market summary from raw DB sources and persist to ui_summaries.
 * This is the heavy path – runs 4 parallel batch queries via getStoredMarketList.
 * Protected by a parallel-refresh guard to prevent duplicate work.
 *
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<object[]|null>} The built stock array, or null on failure/skip.
 */
async function refreshMarketSummary({ limit = 250 } = {}) {
  if (_isRefreshing) {
    logger.info("[marketSummary] refresh already in progress, skipping");
    return null;
  }

  _isRefreshing = true;
  const t0 = Date.now();
  try {
    logger.info("[marketSummary] building market list summary", { limit });

    const stocks = await getStoredMarketList({ limit });
    const durationMs = Date.now() - t0;

    await writeUiSummary(
      SUMMARY_TYPE,
      { stocks: Array.isArray(stocks) ? stocks : [], symbolCount: Array.isArray(stocks) ? stocks.length : 0 },
      { buildDurationMs: durationMs, isPartial: false }
    );

    logger.info("[marketSummary] summary built and persisted", {
      symbolCount: Array.isArray(stocks) ? stocks.length : 0,
      durationMs,
    });

    return Array.isArray(stocks) ? stocks : [];
  } catch (err) {
    logger.warn("[marketSummary] refresh failed", { message: err.message });
    return null;
  } finally {
    _isRefreshing = false;
  }
}

/* =========================================================
   SMART PATH  (SWR-like, used by /api/market)
========================================================= */

/**
 * Get market summary with stale-while-revalidate logic:
 *   1. Fresh DB summary → return immediately (fast path, no aggregation).
 *   2. Stale DB summary → return stale data + trigger async refresh.
 *   3. No DB summary    → build synchronously and return.
 *
 * The returned stocks are raw (pre-formatMarketItem) so the caller can
 * apply its own formatting and limit slicing unchanged.
 *
 * @param {{ maxAgeMs?: number, limit?: number }} [opts]
 * @returns {Promise<{ stocks: object[], builtAt: string|null, freshness: string, isPartial: boolean }>}
 */
async function getOrBuildMarketSummary({ maxAgeMs = MARKET_SUMMARY_MAX_AGE_MS, limit = 250 } = {}) {
  const summary = await readMarketSummary();

  if (summary && summary.ageMs <= maxAgeMs) {
    // Fast path: prepared data is fresh enough
    return {
      stocks:    summary.stocks,
      builtAt:   summary.builtAt,
      freshness: "fresh",
      isPartial: summary.isPartial,
    };
  }

  if (summary) {
    // Stale: return existing data immediately, trigger async rebuild
    if (!_isRefreshing) {
      setImmediate(() =>
        refreshMarketSummary({ limit }).catch((err) =>
          logger.warn("[marketSummary] async SWR refresh failed", { message: err.message })
        )
      );
    }
    return {
      stocks:    summary.stocks,
      builtAt:   summary.builtAt,
      freshness: "stale",
      isPartial: summary.isPartial,
    };
  }

  // Cold path: no DB summary – build synchronously (first startup)
  const stocks = await refreshMarketSummary({ limit });
  return {
    stocks:    stocks ?? [],
    builtAt:   new Date().toISOString(),
    freshness: stocks !== null ? "fresh" : "error",
    isPartial: stocks === null,
  };
}

module.exports = {
  readMarketSummary,
  refreshMarketSummary,
  getOrBuildMarketSummary,
  MARKET_SUMMARY_MAX_AGE_MS,
};
