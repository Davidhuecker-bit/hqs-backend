"use strict";

/**
 * UI Demo Portfolio Writer Job
 *
 * Dedicated job that builds and persists the `demo_portfolio` UI summary
 * to the `ui_summaries` table. The API server only reads this data —
 * it never rebuilds the summary on demand.
 *
 * Pflichtquellen (mandatory):
 *   - market_snapshots  (price data)
 *   - hqs_scores        (scoring data)
 *   - ui_summaries.demo_portfolio  (this output)
 *
 * Supplementary / fallback only:
 *   - market_news
 *   - market_advanced_metrics
 *   - fx_rates
 *
 * Pipeline stage: ui_demo_portfolio
 *
 * Schedule recommendation: every 10 minutes (Railway cron or external trigger).
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
const { refreshDemoPortfolio } = require("../services/adminDemoPortfolio.service");
const { getSharedPool, closeAllPools } = require("../config/database");

const pool = getSharedPool();

// Lock TTL configurable via env, default 15 minutes
const LOCK_TTL_SECONDS =
  Number.parseInt(process.env.UI_DEMO_PORTFOLIO_LOCK_TTL_SECS || "900", 10) || 900;

// ── Job entry point ───────────────────────────────────────────────────────────

async function run() {
  return runJob(
    "ui-demo-portfolio",
    async () => {
      await initJobLocksTable();

      const won = await acquireLock("ui_demo_portfolio_job", LOCK_TTL_SECONDS);
      if (!won) {
        logger.warn("[job:ui-demo-portfolio] skipped – lock held", {
          lockTtlSeconds: LOCK_TTL_SECONDS,
          skipReason: "lock_held",
        });
        return { skipped: true, skipReason: "lock_held", processedCount: 0 };
      }

      const startMs = Date.now();

      try {
        logger.info("[job:ui-demo-portfolio] building demo_portfolio summary");

        const result = await refreshDemoPortfolio();
        const holdingCount = result?.holdings?.length ?? 0;
        const success = result !== null && result !== undefined;
        const durationMs = Date.now() - startMs;

        try {
          await savePipelineStage("ui_demo_portfolio", {
            inputCount: holdingCount,
            successCount: success ? 1 : 0,
            failedCount: success ? 0 : 1,
            skippedCount: 0,
            status: success ? "success" : "failed",
          });
        } catch (stageErr) {
          logger.warn("[job:ui-demo-portfolio] savePipelineStage failed", {
            message: stageErr?.message,
          });
        }

        logger.info("[job:ui-demo-portfolio] complete", {
          holdingCount,
          dataStatus: result?.dataStatus ?? "unknown",
          freshness: result?.freshness ?? "unknown",
          durationMs,
        });

        return {
          processedCount: holdingCount,
          durationMs,
        };
      } catch (err) {
        const durationMs = Date.now() - startMs;

        try {
          await savePipelineStage("ui_demo_portfolio", {
            inputCount: 0,
            successCount: 0,
            failedCount: 1,
            skippedCount: 0,
            status: "failed",
          });
        } catch (stageErr) {
          logger.warn("[job:ui-demo-portfolio] savePipelineStage failed after job error", {
            message: stageErr?.message,
          });
        }

        logger.error("[job:ui-demo-portfolio] failed", {
          message: err?.message || String(err),
          durationMs,
          stack: err?.stack,
        });

        throw err;
      } finally {
        await releaseLock("ui_demo_portfolio_job").catch((lockErr) => {
          logger.warn("[job:ui-demo-portfolio] lock release failed", {
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
      logger.error("[job:ui-demo-portfolio] fatal", {
        message: err?.message || String(err),
        stack: err?.stack,
      });
    })
    .finally(async () => {
      await closeAllPools().catch(() => {});
      process.exit(exitCode);
    });
}
