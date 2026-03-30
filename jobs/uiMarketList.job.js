"use strict";

/**
 * UI Market List Writer Job
 *
 * Dedicated job that builds and persists the `market_list` UI summary
 * to the `ui_summaries` table. The API server only reads this data —
 * it never rebuilds the summary on demand.
 *
 * Pipeline stage: ui_market_list
 *
 * Schedule recommendation: every 5 minutes (Railway cron or external trigger).
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
const { refreshMarketSummary } = require("../services/marketSummary.builder");
const { getSharedPool, closeAllPools } = require("../config/database");

const pool = getSharedPool();

// Lock TTL configurable via env, default 10 minutes
const LOCK_TTL_SECONDS =
  Number.parseInt(process.env.UI_MARKET_LIST_LOCK_TTL_SECS || "600", 10) || 600;

// Max number of symbols to include in the market list
const MAX_MARKET_LIST_SYMBOLS =
  Number.parseInt(process.env.UI_MARKET_LIST_MAX_SYMBOLS || "250", 10) || 250;

// ── Job entry point ───────────────────────────────────────────────────────────

async function run() {
  return runJob(
    "ui-market-list",
    async () => {
      await initJobLocksTable();

      const won = await acquireLock("ui_market_list_job", LOCK_TTL_SECONDS);
      if (!won) {
        logger.warn("[job:ui-market-list] skipped – lock held", {
          lockTtlSeconds: LOCK_TTL_SECONDS,
          skipReason: "lock_held",
        });
        return { skipped: true, skipReason: "lock_held", processedCount: 0 };
      }

      const startMs = Date.now();

      try {
        logger.info("[job:ui-market-list] building market_list summary", {
          limit: MAX_MARKET_LIST_SYMBOLS,
        });

        const stocks = await refreshMarketSummary({
          limit: MAX_MARKET_LIST_SYMBOLS,
        });

        const symbolCount = Array.isArray(stocks) ? stocks.length : 0;
        const durationMs = Date.now() - startMs;

        try {
          await savePipelineStage("ui_market_list", {
            inputCount: symbolCount,
            successCount: 1,
            failedCount: 0,
            skippedCount: 0,
            status: "success",
          });
        } catch (stageErr) {
          logger.warn("[job:ui-market-list] savePipelineStage failed", {
            message: stageErr?.message,
          });
        }

        logger.info("[job:ui-market-list] complete", {
          symbolCount,
          durationMs,
        });

        return {
          processedCount: symbolCount,
          durationMs,
        };
      } catch (err) {
        const durationMs = Date.now() - startMs;

        try {
          await savePipelineStage("ui_market_list", {
            inputCount: 0,
            successCount: 0,
            failedCount: 1,
            skippedCount: 0,
            status: "failed",
          });
        } catch (stageErr) {
          logger.warn("[job:ui-market-list] savePipelineStage failed after job error", {
            message: stageErr?.message,
          });
        }

        logger.error("[job:ui-market-list] failed", {
          message: err?.message || String(err),
          durationMs,
          stack: err?.stack,
        });

        throw err;
      } finally {
        await releaseLock("ui_market_list_job").catch((lockErr) => {
          logger.warn("[job:ui-market-list] lock release failed", {
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
      logger.error("[job:ui-market-list] fatal", {
        message: err?.message || String(err),
        stack: err?.stack,
      });
    })
    .finally(async () => {
      await closeAllPools().catch(() => {});
      process.exit(exitCode);
    });
}
