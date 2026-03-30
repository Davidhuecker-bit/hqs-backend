"use strict";

/**
 * One-off Cron Job:
 * - ensures tables exist
 * - runs one snapshot batch (from universe_symbols)
 *
 * Required ENV:
 * - DATABASE_URL
 * - MASSIVE_API_KEY
 *
 * Optional ENV:
 * - SNAPSHOT_BATCH_SIZE=80  (default, max SNAPSHOT_SYMBOL_LIMIT)
 * - SNAPSHOT_REGION=us      (filter universe_symbols by region)
 * - HIST_PERIOD=1y|max
 * - SNAPSHOT_SCAN_LOCK_TTL_SECS=1800 (default 30 min)
 */

require("dotenv").config();

const logger = require("../utils/logger");
const { runJob } = require("../utils/jobRunner");
const {
  ensureTablesExist,
  buildMarketSnapshot,
} = require("../services/marketService");
const {
  initJobLocksTable,
  acquireLock,
  releaseLock,
} = require("../services/jobLock.repository");
const { savePipelineStage } = require("../services/pipelineStatus.repository");
const {
  initOutcomeTrackingTable,
} = require("../services/outcomeTracking.repository");
const { refreshAndPersistFxRate } = require("../services/fx.service");

const { getSharedPool, closeAllPools } = require("../config/database");

const pool = getSharedPool();

// Lock TTL – configurable via env (default 30 minutes)
const LOCK_TTL_SECONDS = Number.parseInt(
  process.env.SNAPSHOT_SCAN_LOCK_TTL_SECS || "1800",
  10
);

async function run() {
  return runJob(
    "snapshotScan",
    async () => {
      await initJobLocksTable();

      const won = await acquireLock("snapshot_scan_job", LOCK_TTL_SECONDS);
      if (!won) {
        logger.warn("[job:snapshotScan] skipped – lock held", {
          lockTtlSeconds: LOCK_TTL_SECONDS,
        });
        return { skipped: true, skipReason: "lock_held", processedCount: 0 };
      }

      const startMs = Date.now();
      let processedCount = 0;
      let failedSteps = 0;

      try {
        logger.info("[job:snapshotScan] starting snapshot scan");

        // Step 1: init outcome tracking table
        try {
          logger.info("[job:snapshotScan] initOutcomeTrackingTable start");
          await initOutcomeTrackingTable();
          logger.info("[job:snapshotScan] initOutcomeTrackingTable done");
        } catch (err) {
          failedSteps++;
          logger.error("[job:snapshotScan] initOutcomeTrackingTable failed", {
            message: err.message,
          });
          throw err; // critical, abort job
        }

        // Step 2: ensure tables exist
        try {
          logger.info("[job:snapshotScan] ensureTablesExist start");
          await ensureTablesExist();
          logger.info("[job:snapshotScan] ensureTablesExist done");
        } catch (err) {
          failedSteps++;
          logger.error("[job:snapshotScan] ensureTablesExist failed", {
            message: err.message,
          });
          throw err;
        }

        // Step 3: refresh FX rate (non‑critical, but we log warning if fails)
        let fxRate = null;
        try {
          logger.info("[job:snapshotScan] refreshAndPersistFxRate start");
          fxRate = await refreshAndPersistFxRate();
          logger.info("[job:snapshotScan] refreshAndPersistFxRate done", {
            fxRate,
          });
        } catch (err) {
          logger.warn("[job:snapshotScan] refreshAndPersistFxRate failed", {
            message: err.message,
          });
          // Non‑critical, continue
        }

        // Step 4: build market snapshot
        let result = null;
        try {
          logger.info("[job:snapshotScan] buildMarketSnapshot start");
          result = await buildMarketSnapshot();
          processedCount = result?.processedCount ?? 0;
          logger.info("[job:snapshotScan] buildMarketSnapshot done", {
            processedCount,
            skipped: result?.skipped ?? false,
            skipReason: result?.skipReason,
          });
        } catch (err) {
          failedSteps++;
          logger.error("[job:snapshotScan] buildMarketSnapshot failed", {
            message: err.message,
          });
          throw err;
        }

        const durationMs = Date.now() - startMs;

        // Save pipeline stage with success
        await savePipelineStage("snapshot_scan", {
          inputCount: result?.totalSymbols ?? processedCount,
          successCount: processedCount,
          failedCount: failedSteps,
          status: "success",
        }).catch((err) => {
          logger.warn("[job:snapshotScan] savePipelineStage failed", {
            message: err.message,
          });
        });

        logger.info("[job:snapshotScan] done", {
          processedCount,
          durationMs,
          failedSteps,
        });

        return {
          processedCount,
          durationMs,
          failedSteps,
          skipped: result?.skipped ?? false,
          skipReason: result?.skipReason,
        };
      } catch (err) {
        const durationMs = Date.now() - startMs;

        // Save pipeline stage with failure
        await savePipelineStage("snapshot_scan", {
          inputCount: 0,
          successCount: 0,
          failedCount: 1,
          status: "failed",
        }).catch(() => {});

        logger.error("[job:snapshotScan] failed", {
          message: err.message,
          durationMs,
          stack: err.stack,
        });

        throw err; // let runJob handle the error
      } finally {
        await releaseLock("snapshot_scan_job").catch((err) => {
          logger.warn("[job:snapshotScan] lock release failed", {
            message: err.message,
          });
        });
      }
    },
    { pool, dbRetries: 5, dbDelayMs: 3000 }
  );
}

module.exports = { run };

// ── Standalone entry point (Railway cron) ──────────────────────────────────
if (require.main === module) {
  let exitCode = 0;

  run()
    .catch((err) => {
      exitCode = 1;
      logger.error("[job:snapshotScan] fatal", {
        message: err?.message || String(err),
        stack: err?.stack,
      });
    })
    .finally(async () => {
      await closeAllPools().catch(() => {});
      process.exit(exitCode);
    });
}
