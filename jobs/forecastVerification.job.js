"use strict";

/*
  Forecast Verification Job  –  Prediction-Self-Audit
  -----------------------------------------------------
  Runs daily to check 24-h-old agent forecasts against real
  market prices and record whether each agent was correct.

  Called from server.js via scheduleDailyForecastVerification().
*/

const logger = require("../utils/logger");
const { verifyAgentForecasts } = require("../services/agentForecast.repository");
const { fetchQuote } = require("../services/providerService");

/**
 * Verifies all pending agent forecasts that are ≥24 hours old.
 *
 * @returns {Promise<number>} count of verified forecasts
 */
async function runForecastVerificationJob() {
  try {
    const count = await verifyAgentForecasts(fetchQuote);
    if (count > 0) {
      logger.info(`forecastVerification: verified ${count} agent forecast(s)`);
    } else {
      logger.info("forecastVerification: no forecasts due for verification");
    }
    return count;
  } catch (error) {
    logger.warn("forecastVerification: job failed", { message: error.message });
    return 0;
  }
}

module.exports = { runForecastVerificationJob };
