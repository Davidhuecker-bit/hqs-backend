"use strict";

/**
 * News Lifecycle Cleanup Job
 *
 * Periodically updates the lifecycle states of market news entries and
 * deletes expired ones. This job ensures that the market_news table
 * stays consistent and does not accumulate stale data.
 *
 * Pipeline stage: news_lifecycle_cleanup
 *
 * Schedule: every hour (recommended)
 *
 * Configuration (optional):
 *   NEWS_LIFECYCLE_LOCK_TTL_SECS – lock TTL in seconds (default: 3600 = 1 hour)
 */

require("dotenv").config();

const logger = require("../utils/logger");
const { runJob } = require("../utils/jobRunner");
const {
  initJobLocksTable,
  acquireLock,
  releaseLock,
} = require("../services/jobLock.repository");
const {
  initMarketNewsTable,
  syncMarketNewsLifecycleStates,
  cleanupExpiredMarketNews,
} = require("../services/marketNews.repository");
const { savePipelineStage } = require("../services/pipelineStatus.repository");
const { getSharedPool, closeAllPools } = require("../config/database");

const pool = getSharedPool();

// Lock TTL configurable via env, default 1 hour
const LOCK_TTL_SECS =
  Number.parseInt(process.env.NEWS_LIFECYCLE_LOCK_TTL_SECS || "3600", 10) || 3600;

async function run() {
  return runJob(
    "newsLifecycleCleanup",
    async () => {
      await initJobLocksTable();

      const won = await acquireLock("news_lifecycle_cleanup_job", LOCK_TTL_SECS);
      if (!won) {
        logger.warn("[job:newsLifecycleCleanup] skipped – lock held", {
          lockTtlSeconds: LOCK_TTL_SECS,
          skipReason: "lock_held",
        });
        return { skipped: true, skipReason: "lock_held", processedCount: 0 };
      }

      const startMs = Date.now();
      let lifecycleResult = null;
      let cleanupResult = null;
      let failedSteps = 0;

      try {
        logger.info("[job:newsLifecycleCleanup] starting lifecycle cleanup");

        await initMarketNewsTable();

        // Step 1: sync lifecycle states
        try {
          lifecycleResult = await syncMarketNewsLifecycleStates();
          logger.info("[job:newsLifecycleCleanup] lifecycle sync done", {
            updated: lifecycleResult?.updated ?? 0,
          });
        } catch (err) {
          failedSteps += 1;
          logger.error("[job:newsLifecycleCleanup] lifecycle sync failed", {
            message: err?.message || String(err),
            stack: err?.stack,
          });
        }

        // Step 2: cleanup expired news
        try {
          cleanupResult = await cleanupExpiredMarketNews();
          logger.info("[job:newsLifecycleCleanup] cleanup done", {
            deleted: cleanupResult?.deleted ?? 0,
          });
        } catch (err) {
          failedSteps += 1;
          logger.error("[job:newsLifecycleCleanup] cleanup failed", {
            message: err?.message || String(err),
            stack: err?.stack,
          });
        }

        const updated = lifecycleResult?.updated ?? 0;
        const deleted = cleanupResult?.deleted ?? 0;
        const processedCount = updated + deleted;
        const durationMs = Date.now() - startMs;

        try {
          await savePipelineStage("news_lifecycle_cleanup", {
            inputCount: processedCount,
            successCount: processedCount,
            failedCount: failedSteps,
            skippedCount: 0,
            status: "success",
          });
        } catch (stageErr) {
          logger.warn("[job:newsLifecycleCleanup] savePipelineStage failed", {
            message: stageErr?.message,
          });
        }

        logger.info("[job:newsLifecycleCleanup] done", {
          updated,
          deleted,
          processedCount,
          failedSteps,
          durationMs,
        });

        return {
          processedCount,
          updated,
          deleted,
          failedSteps,
          durationMs,
        };
      } catch (err) {
        const durationMs = Date.now() - startMs;

        try {
          await savePipelineStage("news_lifecycle_cleanup", {
            inputCount: 0,
            successCount: 0,
            failedCount: 1,
            skippedCount: 0,
            status: "failed",
          });
        } catch (stageErr) {
          logger.warn("[job:newsLifecycleCleanup] savePipelineStage failed after job error", {
            message: stageErr?.message,
          });
        }

        logger.error("[job:newsLifecycleCleanup] failed", {
          message: err?.message || String(err),
          durationMs,
          stack: err?.stack,
        });

        throw err;
      } finally {
        await releaseLock("news_lifecycle_cleanup_job").catch((lockErr) => {
          logger.warn("[job:newsLifecycleCleanup] lock release failed", {
            message: lockErr?.message,
          });
        });
      }
    },
    { pool, dbRetries: 3, dbDelayMs: 2000 }
  );
}

module.exports = { run, runNewsLifecycleCleanupJob: run };

// ── Standalone entry point (Railway cron) ────────────────────────────────────
if (require.main === module) {
  let exitCode = 0;

  run()
    .catch((err) => {
      exitCode = 1;
      logger.error("[job:newsLifecycleCleanup] fatal", {
        message: err?.message || String(err),
        stack: err?.stack,
      });
    })
    .finally(async () => {
      await closeAllPools().catch(() => {});
      process.exit(exitCode);
    });
}
