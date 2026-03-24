"use strict";

/*
  Forecast Verification Job  –  Prediction-Self-Audit
  -----------------------------------------------------
  Runs daily to check 24-h-old agent forecasts against real
  market prices and record whether each agent was correct.

  Also checks outcome_tracking rows that are ≥7 days old and
  fills in the performance_7d window for Pattern Memory stats.

  Run: node jobs/forecastVerification.job.js
*/

require("dotenv").config();

const { Pool } = require("pg");
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
  initJobLocksTable,
} = require("../services/jobLock.repository");

// Module-level pool for DB-first price lookups (avoids live API calls when
// a recent market_snapshots entry is available).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

/**
 * Reads the most recent price for a symbol from market_snapshots (last 4 hours).
 * Returns { price } on success, null when no recent snapshot exists.
 *
 * @param {string} symbol
 * @returns {Promise<{price:number}|null>}
 */
async function fetchStoredPrice(symbol) {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) return null;
  try {
    const res = await pool.query(
      `SELECT price
       FROM market_snapshots
       WHERE symbol = $1
         AND created_at > NOW() - INTERVAL '4 hours'
       ORDER BY created_at DESC
       LIMIT 1`,
      [sym]
    );
    if (!res.rows.length) return null;
    const p = Number(res.rows[0].price);
    return Number.isFinite(p) && p > 0 ? { price: p } : null;
  } catch (err) {
    logger.warn("[forecastVerification] fetchStoredPrice failed", { symbol, message: err.message });
    return null;
  }
}

/**
 * DB-first price lookup: tries market_snapshots first, falls back to live fetchQuote.
 * Satisfies the DB-first architecture while keeping live fallback for cold starts.
 *
 * @param {string} symbol
 * @returns {Promise<object|null>}
 */
async function fetchPriceDbFirst(symbol) {
  const stored = await fetchStoredPrice(symbol);
  if (stored) return stored;
  return fetchQuote(symbol);
}

/**
 * Verifies all pending agent forecasts that are ≥24 hours old,
 * then fills in the 7-day performance window for outcome_tracking rows
 * that are ≥7 days old and have not yet been evaluated at the 7d window.
 *
 * @returns {Promise<{ verified24h: number, verified7d: number, processedCount: number }>}
 */
async function runForecastVerificationJob() {
  return runJob("forecastVerification", async () => {
    await initJobLocksTable();

    const won = await acquireLock("forecast_verification_job", 30 * 60);
    if (!won) {
      logger.warn("Forecast verification skipped (lock held)");
      return { verified24h: 0, verified7d: 0, failedCount: 0, processedCount: 0 };
    }

    let verified24h = 0;
    let verified7d  = 0;
    let failedCount = 0;

    // ── 24-hour agent forecast verification ──────────────────────────────────
    try {
      verified24h = await verifyAgentForecasts(fetchPriceDbFirst);
      logger.info("forecastVerification: 24h pass done", { verified24h });
    } catch (error) {
      failedCount++;
      logger.warn("forecastVerification: 24h pass failed", { message: error.message });
    }

    // ── 7-day outcome_tracking performance window (Pattern Memory) ──────────
    try {
      const due7d = await getDue7dVerifications(50);
      if (due7d.length > 0) {
        for (const row of due7d) {
          try {
            const quote = await fetchPriceDbFirst(row.symbol);
            const currentPrice =
              quote?.price ??
              quote?.regularMarketPrice ??
              quote?.close ??
              null;

            if (currentPrice && Number.isFinite(Number(currentPrice)) && Number(currentPrice) > 0) {
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
        logger.info("forecastVerification: 7d pass done", { verified7d, due: due7d.length });
      }
    } catch (err7d) {
      failedCount++;
      logger.warn("forecastVerification: 7d pass failed", { message: err7d.message });
    }

    return { verified24h, verified7d, failedCount, processedCount: verified24h + verified7d };
  });
}

module.exports = { runForecastVerificationJob };

// ── Standalone entry point (Railway cron) ──────────────────────────────────
if (require.main === module) {
  runForecastVerificationJob()
    .then(() => {
      pool.end().catch(() => {});
      process.exit(0);
    })
    .catch((err) => {
      const log = require("../utils/logger");
      log.error("forecastVerification fatal", { message: err.message, stack: err.stack });
      pool.end().catch(() => {});
      process.exit(1);
    });
}
