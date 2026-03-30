"use strict";

// jobs/universeRefresh.job.js
// Run: node jobs/universeRefresh.job.js

require("dotenv").config();

const logger = require("../utils/logger");
const { runJob } = require("../utils/jobRunner");
const {
  acquireLock,
  releaseLock,
  initJobLocksTable,
} = require("../services/jobLock.repository");
const { refreshUniverse } = require("../services/universe.service");
const { savePipelineStage } = require("../services/pipelineStatus.repository");
const { getSharedPool, closeAllPools } = require("../config/database");

const pool = getSharedPool();

// Lock TTL configurable via env, default 2 hours
const LOCK_TTL_SECS =
  Number.parseInt(process.env.UNIVERSE_REFRESH_LOCK_TTL_SECS || "7200", 10) || 7200;

async function run() {
  return runJob(
    "universeRefresh",
    async () => {
      await initJobLocksTable();

      const won = await acquireLock("universe_refresh_job", LOCK_TTL_SECS);
      if (!won) {
        logger.warn("[job:universeRefresh] skipped – lock held", {
          skipReason: "lock_held",
          lockTtlSecs: LOCK_TTL_SECS,
        });
        return { processedCount: 0, skipped: true, skipReason: "lock_held" };
      }

      const startMs = Date.now();
      let result = null;

      try {
        result = await refreshUniverse();

        const processedCount = result?.insertedOrUpdated ?? 0;
        const inputCount = result?.activeCount ?? processedCount;
        const durationMs = Date.now() - startMs;

        try {
          await savePipelineStage("universe_refresh", {
            inputCount,
            successCount: processedCount,
            failedCount: 0,
            skippedCount: 0,
            status: "success",
          });
        } catch (stageErr) {
          logger.warn("[job:universeRefresh] savePipelineStage failed", {
            message: stageErr?.message,
          });
        }

        logger.info("[job:universeRefresh] done", {
          activeSymbols: result?.activeCount ?? null,
          insertedOrUpdated: processedCount,
          durationMs,
        });

        return { processedCount, ...result };
      } catch (err) {
        const durationMs = Date.now() - startMs;

        logger.error("[job:universeRefresh] failed", {
          message: err?.message || String(err),
          durationMs,
          stack: err?.stack,
        });

        try {
          await savePipelineStage("universe_refresh", {
            inputCount: result?.activeCount ?? 0,
            successCount: 0,
            failedCount: 1,
            skippedCount: 0,
            status: "failed",
          });
        } catch (stageErr) {
          logger.warn("[job:universeRefresh] savePipelineStage failed after job error", {
            message: stageErr?.message,
          });
        }

        throw err;
      } finally {
        await releaseLock("universe_refresh_job").catch((lockErr) => {
          logger.warn("[job:universeRefresh] lock release failed", {
            message: lockErr?.message,
          });
        });
      }
    },
    { pool, dbRetries: 5, dbDelayMs: 3000 }
  );
}

module.exports = { run };

// ── Standalone entry point ──────────────────────────────────────────────────
if (require.main === module) {
  let exitCode = 0;

  run()
    .catch((err) => {
      exitCode = 1;
      logger.error("[job:universeRefresh] fatal", {
        message: err?.message || String(err),
        stack: err?.stack,
      });
    })
    .finally(async () => {
      await closeAllPools().catch(() => {});
      process.exit(exitCode);
    });
}
