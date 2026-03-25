"use strict";

// jobs/universeRefresh.job.js
// Run: node jobs/universeRefresh.job.js

require("dotenv").config();

const logger = require("../utils/logger");
const { runJob } = require("../utils/jobRunner");
const { acquireLock, releaseLock, initJobLocksTable } = require("../services/jobLock.repository");
const { refreshUniverse } = require("../services/universe.service");
const { savePipelineStage } = require("../services/pipelineStatus.repository");

const { getSharedPool, closeAllPools } = require("../config/database");
const pool = getSharedPool();
async function run() {
  await runJob(
    "universeRefresh",
    async () => {
      await initJobLocksTable();

      // 2h TTL – protects against duplicate cron runs
      const won = await acquireLock("universe_refresh_job", 2 * 60 * 60);
      if (!won) {
        logger.warn("[job:universeRefresh] skipped – lock held", { skipReason: "lock_held" });
        return { processedCount: 0, skipped: true, skipReason: "lock_held" };
      }

      try {
      const result = await refreshUniverse();
      const processedCount = result?.insertedOrUpdated ?? 0;

      // Persist pipeline status for monitoring
      // refreshUniverse() throws on any failure so failedCount/skippedCount are always 0 here
      savePipelineStage("universe_refresh", {
        inputCount:   result?.activeCount ?? processedCount,
        successCount: processedCount,
        failedCount:  0,
        skippedCount: 0,
        status:       "success",
      }).catch(() => {});

      return { processedCount, ...result };
      } finally {
        await releaseLock("universe_refresh_job").catch(() => {});
      }
    },
    { pool, dbRetries: 5, dbDelayMs: 3000 }
  );
}

run()
  .then(() => {
    closeAllPools().catch(() => {});
    process.exit(0);
  })
  .catch((err) => {
    logger.error("[job:universeRefresh] fatal", { message: err.message });
    closeAllPools().catch(() => {});
    process.exit(1);
  });
