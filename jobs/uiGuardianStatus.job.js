"use strict";

/**
 * UI Guardian Status Writer Job
 *
 * Dedicated job that builds and persists the `guardian_status` UI summary
 * to the `ui_summaries` table.  The API server only reads this data —
 * it never rebuilds the summary on demand.
 *
 * Pipeline stage: ui_guardian_status
 *
 * Schedule recommendation: every 3 minutes (Railway cron or external trigger).
 */

require("dotenv").config();

const logger = require("../utils/logger");
const { runJob } = require("../utils/jobRunner");
const { initJobLocksTable, acquireLock, releaseLock } = require("../services/jobLock.repository");
const { savePipelineStage } = require("../services/pipelineStatus.repository");
const { refreshGuardianStatusSummary } = require("../services/guardianStatusSummary.builder");

const { getSharedPool, closeAllPools } = require("../config/database");
const pool = getSharedPool();
const LOCK_TTL_SECONDS = 5 * 60; // 5 min

// ── Job entry point ───────────────────────────────────────────────────────────

async function run() {
  return runJob("ui-guardian-status", async () => {
    await initJobLocksTable();

    const won = await acquireLock("ui_guardian_status_job", LOCK_TTL_SECONDS);
    if (!won) {
      logger.warn("[job:ui-guardian-status] skipped – lock held");
      return { skipped: true };
    }

    try {
    logger.info("[job:ui-guardian-status] building guardian_status summary");

    const summary = await refreshGuardianStatusSummary();
    const success = summary !== null && summary !== undefined;

    await savePipelineStage("ui_guardian_status", {
      inputCount:   1,
      successCount: success ? 1 : 0,
      failedCount:  success ? 0 : 1,
    });

    logger.info("[job:ui-guardian-status] complete", {
      systemHealth: summary?.systemHealth ?? "unknown",
      pipelineOk:   summary?.pipeline?.ok ?? false,
    });
    return { processedCount: success ? 1 : 0 };
    } finally {
      await releaseLock("ui_guardian_status_job").catch(() => {});
    }
  }, { pool });
}

if (require.main === module) {
  run()
    .then(() => {
      closeAllPools();
      process.exit(0);
    })
    .catch((error) => {
      logger.error("ui-guardian-status job failed", {
        message: error.message,
        stack: error.stack,
      });
      closeAllPools();
      process.exit(1);
    });
}

module.exports = { run };
