"use strict";

/*
  Causal Memory Job  –  Recursive Meta-Learning
  -----------------------------------------------
  Runs periodically to evaluate 48-h-old verified forecasts and adjust
  the dynamic agent weights via causalMemory.repository.adjustAgentWeights().

  Run: node jobs/causalMemory.job.js
*/

require("dotenv").config();

const { runJob } = require("../utils/jobRunner");
const { adjustAgentWeights } = require("../services/causalMemory.repository");
const {
  acquireLock,
  releaseLock,
  initJobLocksTable,
} = require("../services/jobLock.repository");
const { savePipelineStage } = require("../services/pipelineStatus.repository");

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

    try {
    const result = await adjustAgentWeights();
    const processedCount = result.adjusted ?? 0;
    await savePipelineStage("causal_memory", {
      inputCount: processedCount,
      successCount: processedCount,
      failedCount: 0,
    });
    return { processedCount, weights: result.weights };
    } finally {
      await releaseLock("causal_memory_job").catch(() => {});
    }
  });
}

module.exports = { runCausalMemoryJob };

// ── Standalone entry point (Railway cron) ──────────────────────────────────
if (require.main === module) {
  runCausalMemoryJob()
    .then(() => process.exit(0))
    .catch((err) => {
      const log = require("../utils/logger");
      log.error("causalMemory fatal", { message: err.message, stack: err.stack });
      process.exit(1);
    });
}
