"use strict";

/*
  Forecast Verification Job  –  Prediction-Self-Audit
  -----------------------------------------------------
  Runs daily to check 24-h-old agent forecasts against real
  market prices and record whether each agent was correct.

  Also checks outcome_tracking rows that are ≥7 days old and
  fills in the performance_7d window for Pattern Memory stats.

  Called from server.js via scheduleDailyForecastVerification().
*/

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
      verified24h = await verifyAgentForecasts(fetchQuote);
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
            const quote = await fetchQuote(row.symbol);
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
