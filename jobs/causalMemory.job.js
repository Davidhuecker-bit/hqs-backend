"use strict";

/*
  Causal Memory Job  –  Recursive Meta-Learning
  -----------------------------------------------
  Runs periodically to evaluate 48-h-old verified forecasts and adjust
  the dynamic agent weights via causalMemory.repository.adjustAgentWeights().

  Scheduled from server.js via scheduleCausalMemoryJob().
*/

const { runJob } = require("../utils/jobRunner");
const { adjustAgentWeights } = require("../services/causalMemory.repository");
const {
  acquireLock,
  initJobLocksTable,
} = require("../services/jobLock.repository");

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = console;
}

/**
 * Runs one adjustment cycle.
 *
 * @returns {Promise<object>}  runJob result ({ success, durationMs, processedCount, … })
 */
async function runCausalMemoryJob() {
  return runJob("causalMemory", async () => {
    await initJobLocksTable();

    const won = await acquireLock("causal_memory_job", 30 * 60);
    if (!won) {
      if (logger?.warn) {
        logger.warn("Causal memory recalibration skipped (lock held)");
      }
      return { processedCount: 0 };
    }

    const result = await adjustAgentWeights();
    return { processedCount: result.adjusted ?? 0, weights: result.weights };
  });
}

module.exports = { runCausalMemoryJob };
