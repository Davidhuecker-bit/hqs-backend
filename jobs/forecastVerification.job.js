"use strict";

/*
  Forecast Verification Job  –  Prediction-Self-Audit
  ---------------------------------------------------
  Runs daily to:
    1) verify 24h-old agent forecasts
    2) verify 7d outcome_tracking rows

  Improvements in this version:
    - DB-first price lookup remains
    - batch lookup for snapshot prices (reduces DB roundtrips)
    - in-memory price cache per run
    - configurable 7d verification limit (default 350)
    - clearer summary logging
*/

require("dotenv").config();

const logger = require("../utils/logger");
const { runJob } = require("../utils/jobRunner");
const { verifyAgentForecasts } = require("../services/agentForecast.repository");
const { fetchQuote } = require("../services/providerService");
const {
  getDue7dVerifications,
  verifyPerformance,
} = require("../services/outcomeTracking.repository");
const {
  acquireLock,
  releaseLock,
  initJobLocksTable,
} = require("../services/jobLock.repository");
const { savePipelineStage } = require("../services/pipelineStatus.repository");

const { getSharedPool, closeAllPools } = require("../config/database");
const pool = getSharedPool();

/**
 * Parses the 7d verification limit from env.
 * Defaults to 350 so the job can catch up faster.
 *
 * @returns {number}
 */
function getDue7dLimit() {
  const parsed = Number.parseInt(
    process.env.FORECAST_VERIFICATION_7D_LIMIT || "350",
    10
  );

  if (!Number.isFinite(parsed) || parsed < 1) return 350;
  return parsed;
}

/**
 * Normalizes a symbol to uppercase ticker form.
 *
 * @param {string} symbol
 * @returns {string}
 */
function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

/**
 * Batch-loads the most recent snapshot price per symbol from the last 4 hours.
 *
 * Returns a Map:
 *   symbol -> { price }
 *
 * @param {string[]} symbols
 * @returns {Promise<Map<string, {price:number}>>}
 */
async function fetchStoredPricesBatch(symbols) {
  const normalized = [
    ...new Set(symbols.map(normalizeSymbol).filter(Boolean)),
  ];

  const priceMap = new Map();
  if (!normalized.length) return priceMap;

  try {
    const res = await pool.query(
      `
      SELECT DISTINCT ON (symbol) symbol, price
      FROM market_snapshots
      WHERE symbol = ANY($1)
        AND created_at > NOW() - INTERVAL '4 hours'
      ORDER BY symbol, created_at DESC
      `,
      [normalized]
    );

    for (const row of res.rows || []) {
      const sym = normalizeSymbol(row.symbol);
      const price = Number(row.price);
      if (sym && Number.isFinite(price) && price > 0) {
        priceMap.set(sym, { price });
      }
    }

    return priceMap;
  } catch (err) {
    logger.warn("[forecastVerification] fetchStoredPricesBatch failed", {
      symbolCount: normalized.length,
      message: err.message,
    });
    return priceMap;
  }
}

/**
 * Reads the most recent price for a symbol from market_snapshots (last 4 hours).
 * Returns { price } on success, null when no recent snapshot exists.
 *
 * @param {string} symbol
 * @returns {Promise<{price:number}|null>}
 */
async function fetchStoredPrice(symbol) {
  const sym = normalizeSymbol(symbol);
  if (!sym) return null;

  try {
    const res = await pool.query(
      `
      SELECT price
      FROM market_snapshots
      WHERE symbol = $1
        AND created_at > NOW() - INTERVAL '4 hours'
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [sym]
    );

    if (!res.rows.length) return null;

    const price = Number(res.rows[0].price);
    return Number.isFinite(price) && price > 0 ? { price } : null;
  } catch (err) {
    logger.warn("[forecastVerification] fetchStoredPrice failed", {
      symbol: sym,
      message: err.message,
    });
    return null;
  }
}

/**
 * DB-first price lookup with per-run cache.
 * Order:
 *   1) local cache
 *   2) preloaded snapshot price map
 *   3) direct snapshot lookup
 *   4) provider fallback
 *
 * @param {string} symbol
 * @param {Map<string, {price:number}|null>} priceCache
 * @param {Map<string, {price:number}>} preloadedPriceMap
 * @returns {Promise<object|null>}
 */
async function fetchPriceDbFirst(symbol, priceCache, preloadedPriceMap) {
  const sym = normalizeSymbol(symbol);
  if (!sym) return null;

  if (priceCache.has(sym)) {
    return priceCache.get(sym);
  }

  if (preloadedPriceMap.has(sym)) {
    const stored = preloadedPriceMap.get(sym);
    priceCache.set(sym, stored);
    return stored;
  }

  const stored = await fetchStoredPrice(sym);
  if (stored) {
    priceCache.set(sym, stored);
    return stored;
  }

  const live = await fetchQuote(sym);
  const resolved =
    live?.price != null ||
    live?.regularMarketPrice != null ||
    live?.close != null
      ? live
      : null;

  priceCache.set(sym, resolved);
  return resolved;
}

/**
 * Verifies all pending agent forecasts that are ≥24 hours old,
 * then fills in the 7-day performance window for outcome_tracking rows
 * that are ≥7 days old and have not yet been evaluated at the 7d window.
 *
 * @returns {Promise<{ verified24h: number, verified7d: number, failedCount: number, processedCount: number }>}
 */
async function runForecastVerificationJob() {
  return runJob("forecastVerification", async () => {
    await initJobLocksTable();

    const won = await acquireLock("forecast_verification_job", 30 * 60);
    if (!won) {
      logger.warn("Forecast verification skipped (lock held)");
      return {
        verified24h: 0,
        verified7d: 0,
        failedCount: 0,
        processedCount: 0,
      };
    }

    let verified24h = 0;
    let verified7d = 0;
    let failedCount = 0;

    // per-run caches for 7d verification
    const priceCache = new Map();

    try {
      // ── 24h agent forecast verification ───────────────────────────────────
      try {
        // We keep repository API unchanged and pass a DB-first fetcher.
        verified24h = await verifyAgentForecasts((symbol) =>
          fetchPriceDbFirst(symbol, priceCache, new Map())
        );

        logger.info("forecastVerification: 24h pass done", {
          verified24h,
        });
      } catch (error) {
        failedCount++;
        logger.warn("forecastVerification: 24h pass failed", {
          message: error.message,
        });
      }

      // ── 7d outcome_tracking verification ──────────────────────────────────
      try {
        const due7dLimit = getDue7dLimit();
        const due7d = await getDue7dVerifications(due7dLimit);

        // preload latest snapshot prices for all due symbols in one query
        const dueSymbols = due7d.map((row) => row.symbol);
        const preloadedPriceMap = await fetchStoredPricesBatch(dueSymbols);

        if (due7d.length > 0) {
          for (const row of due7d) {
            try {
              const quote = await fetchPriceDbFirst(
                row.symbol,
                priceCache,
                preloadedPriceMap
              );

              const currentPrice =
                quote?.price ??
                quote?.regularMarketPrice ??
                quote?.close ??
                null;

              if (
                currentPrice &&
                Number.isFinite(Number(currentPrice)) &&
                Number(currentPrice) > 0
              ) {
                const result = await verifyPerformance({
                  id: row.id,
                  currentPrice: Number(currentPrice),
                  windowLabel: "7d",
                });

                if (result) verified7d++;
              }
            } catch (rowErr) {
              failedCount++;
              logger.warn("forecastVerification: 7d row failed", {
                id: row.id,
                symbol: row.symbol,
                message: rowErr.message,
              });
            }
          }

          logger.info("forecastVerification: 7d pass done", {
            verified7d,
            due: due7d.length,
            due7dLimit,
            cachedSymbols: priceCache.size,
            preloadedSnapshotPrices: preloadedPriceMap.size,
          });
        } else {
          logger.info("forecastVerification: 7d pass done", {
            verified7d: 0,
            due: 0,
            due7dLimit,
            cachedSymbols: priceCache.size,
            preloadedSnapshotPrices: 0,
          });
        }
      } catch (err7d) {
        failedCount++;
        logger.warn("forecastVerification: 7d pass failed", {
          message: err7d.message,
        });
      }

      const processedCount = verified24h + verified7d;

      await savePipelineStage("forecast_verification", {
        inputCount: processedCount + failedCount,
        successCount: processedCount,
        failedCount,
      });

      logger.info("forecastVerification: completed", {
        verified24h,
        verified7d,
        failedCount,
        processedCount,
      });

      return {
        verified24h,
        verified7d,
        failedCount,
        processedCount,
      };
    } finally {
      await releaseLock("forecast_verification_job").catch(() => {});
    }
  });
}

module.exports = { runForecastVerificationJob };

// ── Standalone entry point (Railway cron) ──────────────────────────────────
if (require.main === module) {
  runForecastVerificationJob()
    .then(() => {
      closeAllPools().catch(() => {});
      process.exit(0);
    })
    .catch((err) => {
      logger.error("forecastVerification fatal", {
        message: err.message,
        stack: err.stack,
      });
      closeAllPools().catch(() => {});
      process.exit(1);
    });
}
