"use strict";

/**
 * Evaluate Discoveries Job
 *
 * Evaluates 7-day and 30-day returns for discovery picks that have not yet
 * been verified.  This closes the discovery learning loop: picks are made by
 * discoveryNotify, and this job retroactively validates their quality.
 *
 * Schedule: daily (deployed as a dedicated Railway cron service).
 */

require("dotenv").config();

const logger = require("../utils/logger");
const { runJob } = require("../utils/jobRunner");
const { evaluateDiscoveries } = require("../services/discoveryLearning.service");
const {
  initJobLocksTable,
  acquireLock,
  releaseLock,
} = require("../services/jobLock.repository");
const { initDiscoveryTable } = require("../services/discoveryLearning.repository");
const { savePipelineStage } = require("../services/pipelineStatus.repository");

const { getSharedPool, closeAllPools } = require("../config/database");
const pool = getSharedPool();

async function run() {
  return runJob(
    "evaluateDiscoveries",
    async () => {
      await initJobLocksTable();
      await initDiscoveryTable();

      const won = await acquireLock("evaluate_discoveries_job", 30 * 60);
      if (!won) {
        logger.warn("[job:evaluateDiscoveries] skipped – lock held");
        return { skipped: true, skipReason: "lock_held", processedCount: 0 };
      }

      try {
        logger.info("[job:evaluateDiscoveries] starting evaluation");
        const result = await evaluateDiscoveries();

        const processedCount = (result.updated7d ?? 0) + (result.updated30d ?? 0);

        await savePipelineStage("evaluate_discoveries", {
          inputCount: processedCount,
          successCount: processedCount,
          failedCount: 0,
        });

        logger.info("[job:evaluateDiscoveries] done", result);
        return { ...result, processedCount };
      } finally {
        await releaseLock("evaluate_discoveries_job").catch((err) => {
          logger.warn("[job:evaluateDiscoveries] lock release failed", {
            message: err?.message,
          });
        });
      }
    },
    { pool, dbRetries: 3, dbDelayMs: 2000 }
  );
}

if (require.main === module) {
  run()
    .then(() => {
      closeAllPools().catch(() => {});
      process.exit(0);
    })
    .catch((err) => {
      logger.error("evaluateDiscoveries job failed", {
        message: err?.message || String(err),
        stack: err?.stack,
      });
      closeAllPools().catch(() => {});
      process.exit(1);
    });
}

module.exports = { run };
