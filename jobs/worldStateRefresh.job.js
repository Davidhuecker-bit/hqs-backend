"use strict";

/**
 * World State Refresh Job
 *
 * Rebuilds and persists the unified world_state snapshot:
 *   - Market regime (regime cluster, avgHqs, bearRatio)
 *   - Inter-market / cross-asset signals (BTC, Gold, macro cycle)
 *   - Sector coherence (sharpened sectors, active alerts)
 *   - Causal memory / agent weights
 *   - Capital flow summary
 *   - News pulse (24h aggregate)
 *
 * The world_state is persisted in learning_runtime_state under key 'world_state'
 * and held in-memory cache (2-min TTL) by worldState.service.js.
 *
 * Writer:  this job (via buildWorldState())
 * Readers: opportunityScanner.service.js, marketService.js, GET /api/admin/world-state
 *
 * Schedule: every 15 minutes
 */

require("dotenv").config();

const logger = require("../utils/logger");
const { runJob } = require("../utils/jobRunner");
const { buildWorldState } = require("../services/worldState.service");
const {
  initJobLocksTable,
  acquireLock,
  releaseLock,
} = require("../services/jobLock.repository");
const { savePipelineStage } = require("../services/pipelineStatus.repository");
const { getSharedPool, closeAllPools } = require("../config/database");

const pool = getSharedPool();

// Slightly more generous than before to avoid overlap on slower runs.
const LOCK_TTL_SECS =
  Number.parseInt(process.env.WORLD_STATE_REFRESH_LOCK_TTL_SECS || "1200", 10) || 1200; // 20 minutes

function validateWorldState(ws) {
  if (!ws || typeof ws !== "object") {
    throw new Error("Invalid world state: expected object");
  }

  if (!ws.created_at && !ws.version) {
    logger.warn("[job:worldStateRefresh] world state missing both created_at and version");
  }

  if (!ws?.regime?.regime) {
    logger.warn("[job:worldStateRefresh] world state missing regime info");
  }

  return true;
}

async function run() {
  return runJob(
    "worldStateRefresh",
    async () => {
      await initJobLocksTable();

      const won = await acquireLock("world_state_refresh_job", LOCK_TTL_SECS);
      if (!won) {
        logger.warn("[job:worldStateRefresh] skipped – lock held", {
          lockTtlSecs: LOCK_TTL_SECS,
        });
        return { skipped: true, skipReason: "lock_held", processedCount: 0 };
      }

      try {
        logger.info("[job:worldStateRefresh] starting world state build", {
          lockTtlSecs: LOCK_TTL_SECS,
        });

        const startMs = Date.now();

        try {
          const ws = await buildWorldState();
          validateWorldState(ws);

          const durationMs = Date.now() - startMs;
          const freshness = ws?.created_at ? "fresh" : "unknown";
          const regime = ws?.regime?.regime ?? "unknown";
          const version = ws?.version ?? null;

          // Keep payload conservative in case repository doesn't support rich metadata.
          await savePipelineStage("world_state_refresh", {
            inputCount: 1,
            successCount: 1,
            failedCount: 0,
          });

          logger.info("[job:worldStateRefresh] done", {
            durationMs,
            freshness,
            regime,
            version,
          });

          return {
            processedCount: 1,
            durationMs,
            freshness,
            regime,
            version,
          };
        } catch (err) {
          const durationMs = Date.now() - startMs;

          try {
            await savePipelineStage("world_state_refresh", {
              inputCount: 1,
              successCount: 0,
              failedCount: 1,
            });
          } catch (stageErr) {
            logger.warn("[job:worldStateRefresh] savePipelineStage failed after job error", {
              message: stageErr?.message,
            });
          }

          logger.error("[job:worldStateRefresh] failed", {
            durationMs,
            message: err?.message || String(err),
            stack: err?.stack,
          });

          throw err;
        }
      } finally {
        await releaseLock("world_state_refresh_job").catch((err) => {
          logger.warn("[job:worldStateRefresh] lock release failed", {
            message: err?.message,
          });
        });
      }
    },
    { pool, dbRetries: 3, dbDelayMs: 2000 }
  );
}

module.exports = { run };

// ── Standalone entry point (Railway cron) ──────────────────────────────────
if (require.main === module) {
  let exitCode = 0;

  run()
    .catch((err) => {
      exitCode = 1;
      logger.error("worldStateRefresh job failed", {
        message: err?.message || String(err),
        stack: err?.stack,
      });
    })
    .finally(async () => {
      await closeAllPools().catch(() => {});
      process.exit(exitCode);
    });
}
