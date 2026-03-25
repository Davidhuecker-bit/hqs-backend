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
 * Without this cron job the world_state only receives an initial build on
 * server startup and is never refreshed while the API server runs normally.
 * Stale world_state (> 20 min) degrades opportunity scoring quality.
 *
 * Writer:  this job (via buildWorldState())
 * Readers: opportunityScanner.service.js, marketService.js, GET /api/admin/world-state
 *
 * Schedule: every 15 minutes (configure in Railway cron: every-15-min  i.e. *\/15 * * * *)
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

// Lock TTL slightly above expected build time to prevent stacking runs
const LOCK_TTL_SECS = 10 * 60; // 10 minutes

async function run() {
  return runJob(
    "worldStateRefresh",
    async () => {
      await initJobLocksTable();

      const won = await acquireLock("world_state_refresh_job", LOCK_TTL_SECS);
      if (!won) {
        logger.warn("[job:worldStateRefresh] skipped – lock held");
        return { skipped: true, skipReason: "lock_held", processedCount: 0 };
      }

      try {
        logger.info("[job:worldStateRefresh] starting world state build");
        const startMs = Date.now();

        const ws = await buildWorldState();

        const durationMs = Date.now() - startMs;
        const age = ws?.created_at ? "fresh" : "unknown";

        await savePipelineStage("world_state_refresh", {
          inputCount: 1,
          successCount: 1,
          failedCount: 0,
        });

        logger.info("[job:worldStateRefresh] done", {
          durationMs,
          freshness: age,
          regime: ws?.regime?.regime ?? "unknown",
          version: ws?.version ?? null,
        });

        return { processedCount: 1 };
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

if (require.main === module) {
  run()
    .then(() => {
      closeAllPools().catch(() => {});
      process.exit(0);
    })
    .catch((err) => {
      logger.error("worldStateRefresh job failed", {
        message: err?.message || String(err),
        stack: err?.stack,
      });
      closeAllPools().catch(() => {});
      process.exit(1);
    });
}

module.exports = { run };
