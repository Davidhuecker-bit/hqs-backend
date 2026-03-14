"use strict";

/*
  Causal Memory Job  –  Recursive Meta-Learning
  -----------------------------------------------
  Runs periodically to evaluate 48-h-old verified forecasts and adjust
  the dynamic agent weights via causalMemory.repository.adjustAgentWeights().

  Scheduled from server.js via scheduleCausalMemoryJob().
*/

const logger = require("../utils/logger");
const { adjustAgentWeights } = require("../services/causalMemory.repository");

/**
 * Runs one adjustment cycle.
 *
 * @returns {Promise<{ adjusted: number, weights: object }>}
 */
async function runCausalMemoryJob() {
  try {
    const result = await adjustAgentWeights();
    if (result.adjusted > 0) {
      logger.info(
        `causalMemory: adjusted weights for ${result.adjusted} agent(s)`,
        { weights: result.weights }
      );
    } else {
      logger.info("causalMemory: no new 48-h forecasts to evaluate");
    }
    return result;
  } catch (error) {
    logger.warn("causalMemory: job failed", { message: error.message });
    return { adjusted: 0, weights: {} };
  }
}

module.exports = { runCausalMemoryJob };
