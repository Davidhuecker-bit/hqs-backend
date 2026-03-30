"use strict";

/*
  Tech-Radar Job  –  Innovation Scanner
  ----------------------------------------
  Runs periodically to scan public RSS feeds (arXiv, quantitative finance,
  AI research) for new discoveries relevant to HQS signal quality.

  Discovered entries are persisted in `tech_radar_entries` and surfaced via
  GET /api/admin/tech-radar and GET /api/admin/evolution-board.

  Run: node jobs/techRadar.job.js
*/

require("dotenv").config();

const logger = require("../utils/logger");
const { runJob } = require("../utils/jobRunner");
const { scanTechRadar } = require("../services/techRadar.service");
const {
  acquireLock,
  releaseLock,
  initJobLocksTable,
} = require("../services/jobLock.repository");
const { savePipelineStage } = require("../services/pipelineStatus.repository");
const { getSharedPool, closeAllPools } = require("../config/database");

const pool = getSharedPool();

// Lock TTL configurable via env, default 60 minutes
const LOCK_TTL_SECONDS =
  Number.parseInt(process.env.TECH_RADAR_LOCK_TTL_SECS || "3600", 10) || 3600;

/**
 * Runs one Tech-Radar scan cycle.
 *
 * @returns {Promise<object>} runJob result
 */
async function runTechRadarJob() {
  return runJob(
    "techRadar",
    async () => {
      await initJobLocksTable();

      const won = await acquireLock("tech_radar_job", LOCK_TTL_SECONDS);
      if (!won) {
        logger.warn("[job:techRadar] skipped – lock held", {
          lockTtlSeconds: LOCK_TTL_SECONDS,
          skipReason: "lock_held",
        });
        return { skipped: true, skipReason: "lock_held", processedCount: 0 };
      }

      const startMs = Date.now();

      try {
        logger.info("[job:techRadar] starting scan");

        const result = await scanTechRadar();
        const processedCount = result?.inserted ?? 0;
        const scannedCount = result?.scanned ?? 0;
        const durationMs = Date.now() - startMs;

        try {
          await savePipelineStage("tech_radar", {
            inputCount: scannedCount,
            successCount: processedCount,
            failedCount: 0,
            skippedCount: 0,
            status: "success",
          });
        } catch (stageErr) {
          logger.warn("[job:techRadar] savePipelineStage failed", {
            message: stageErr?.message,
          });
        }

        logger.info("[job:techRadar] done", {
          scanned: scannedCount,
          inserted: processedCount,
          feeds: result?.feeds ?? null,
          durationMs,
        });

        return {
          processedCount,
          feeds: result?.feeds,
          scanned: scannedCount,
          durationMs,
        };
      } catch (err) {
        const durationMs = Date.now() - startMs;

        try {
          await savePipelineStage("tech_radar", {
            inputCount: 0,
            successCount: 0,
            failedCount: 1,
            skippedCount: 0,
            status: "failed",
          });
        } catch (stageErr) {
          logger.warn("[job:techRadar] savePipelineStage failed after job error", {
            message: stageErr?.message,
          });
        }

        logger.error("[job:techRadar] failed", {
          message: err?.message || String(err),
          durationMs,
          stack: err?.stack,
        });

        throw err;
      } finally {
        await releaseLock("tech_radar_job").catch((lockErr) => {
          logger.warn("[job:techRadar] lock release failed", {
            message: lockErr?.message,
          });
        });
      }
    },
    { pool, dbRetries: 3, dbDelayMs: 2000 }
  );
}

module.exports = { runTechRadarJob };

// ── Standalone entry point (Railway cron) ──────────────────────────────────
if (require.main === module) {
  let exitCode = 0;

  runTechRadarJob()
    .catch((err) => {
      exitCode = 1;
      logger.error("[job:techRadar] fatal", {
        message: err?.message || String(err),
        stack: err?.stack,
      });
    })
    .finally(async () => {
      await closeAllPools().catch(() => {});
      process.exit(exitCode);
    });
}
