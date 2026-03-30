"use strict";

/**
 * UI Guardian Status Writer Job
 *
 * Dedicated job that builds and persists the `guardian_status` UI summary
 * to the `ui_summaries` table. The API server only reads this data —
 * it never rebuilds the summary on demand.
 *
 * Pipeline stage: ui_guardian_status
 *
 * Schedule recommendation: every 3 minutes (Railway cron or external trigger).
 */

require("dotenv").config();

const logger = require("../utils/logger");
const { runJob } = require("../utils/jobRunner");
const {
  initJobLocksTable,
  acquireLock,
  releaseLock,
} = require("../services/jobLock.repository");
const { savePipelineStage } = require("../services/pipelineStatus.repository");
const {
  refreshGuardianStatusSummary,
} = require("../services/guardianStatusSummary.builder");
const { getSharedPool, closeAllPools } = require("../config/database");

const pool = getSharedPool();

// Lock TTL configurable via env, default 5 minutes
const LOCK_TTL_SECONDS =
  Number.parseInt(process.env.UI_GUARDIAN_STATUS_LOCK_TTL_SECS || "300", 10) || 300;

// ── Job entry point ───────────────────────────────────────────────────────────

async function run() {
  return runJob(
    "ui-guardian-status",
    async () => {
      await initJobLocksTable();

      const won = await acquireLock("ui_guardian_status_job", LOCK_TTL_SECONDS);
      if (!won) {
        logger.warn("[job:ui-guardian-status] skipped – lock held", {
          lockTtlSeconds: LOCK_TTL_SECONDS,
          skipReason: "lock_held",
        });
        return { skipped: true, skipReason: "lock_held", processedCount: 0 };
      }

      const startMs = Date.now();

      try {
        logger.info("[job:ui-guardian-status] building guardian_status summary");

        const summary = await refreshGuardianStatusSummary();
        const success = summary !== null && summary !== undefined;
        const durationMs = Date.now() - startMs;

        try {
          await savePipelineStage("ui_guardian_status", {
            inputCount: 1,
            successCount: success ? 1 : 0,
            failedCount: success ? 0 : 1,
            skippedCount: 0,
            status: success ? "success" : "failed",
          });
        } catch (stageErr) {
          logger.warn("[job:ui-guardian-status] savePipelineStage failed", {
            message: stageErr?.message,
          });
        }

        logger.info("[job:ui-guardian-status] complete", {
          systemHealth: summary?.systemHealth ?? "unknown",
          pipelineOk: summary?.pipeline?.ok ?? false,
          durationMs,
        });

        return {
          processedCount: success ? 1 : 0,
          durationMs,
        };
      } catch (err) {
        const durationMs = Date.now() - startMs;

        try {
          await savePipelineStage("ui_guardian_status", {
            inputCount: 1,
            successCount: 0,
            failedCount: 1,
            skippedCount: 0,
            status: "failed",
          });
        } catch (stageErr) {
          logger.warn("[job:ui-guardian-status] savePipelineStage failed after job error", {
            message: stageErr?.message,
          });
        }

        logger.error("[job:ui-guardian-status] failed", {
          message: err?.message || String(err),
          durationMs,
          stack: err?.stack,
        });

        throw err;
      } finally {
        await releaseLock("ui_guardian_status_job").catch((lockErr) => {
          logger.warn("[job:ui-guardian-status] lock release failed", {
            message: lockErr?.message,
          });
        });
      }
    },
    { pool, dbRetries: 3, dbDelayMs: 2000 }
  );
}

module.exports = { run };

// ── Standalone entry point (Railway cron) ────────────────────────────────────
if (require.main === module) {
  let exitCode = 0;

  run()
    .catch((err) => {
      exitCode = 1;
      logger.error("[job:ui-guardian-status] fatal", {
        message: err?.message || String(err),
        stack: err?.stack,
      });
    })
    .finally(async () => {
      await closeAllPools().catch(() => {});
      process.exit(exitCode);
    });
}
