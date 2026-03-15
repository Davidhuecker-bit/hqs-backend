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
const { verifyAgentForecasts } = require("../services/agentForecast.repository");
const { fetchQuote } = require("../services/providerService");
const {
  getDue7dVerifications,
  verifyPerformance,
} = require("../services/outcomeTracking.repository");

/**
 * Verifies all pending agent forecasts that are ≥24 hours old,
 * then fills in the 7-day performance window for outcome_tracking rows
 * that are ≥7 days old and have not yet been evaluated at the 7d window.
 *
 * @returns {Promise<{ verified24h: number, verified7d: number }>}
 */
async function runForecastVerificationJob() {
  let verified24h = 0;
  let verified7d  = 0;

  // ── 24-hour agent forecast verification (existing) ────────────────────────
  try {
    verified24h = await verifyAgentForecasts(fetchQuote);
    if (verified24h > 0) {
      logger.info(`forecastVerification: verified ${verified24h} agent forecast(s) at 24h`);
    } else {
      logger.info("forecastVerification: no 24h forecasts due for verification");
    }
  } catch (error) {
    logger.warn("forecastVerification: 24h pass failed", { message: error.message });
  }

  // ── 7-day outcome_tracking performance window (Pattern Memory) ────────────
  try {
    const due7d = await getDue7dVerifications(50);
    if (due7d.length > 0) {
      logger.info(`forecastVerification: ${due7d.length} outcome(s) due for 7d verification`);

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
          logger.warn("forecastVerification: 7d row failed", {
            id: row.id,
            symbol: row.symbol,
            message: rowErr.message,
          });
        }
      }

      if (verified7d > 0) {
        logger.info(`forecastVerification: filled ${verified7d} 7d performance window(s)`);
      }
    } else {
      logger.info("forecastVerification: no 7d outcomes due for verification");
    }
  } catch (err7d) {
    logger.warn("forecastVerification: 7d pass failed", { message: err7d.message });
  }

  return { verified24h, verified7d };
}

module.exports = { runForecastVerificationJob };
