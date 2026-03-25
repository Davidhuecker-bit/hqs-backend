"use strict";

/**
 * UI Demo Portfolio Writer Job
 *
 * Dedicated job that builds and persists the `demo_portfolio` UI summary
 * to the `ui_summaries` table.  The API server only reads this data —
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
const { initJobLocksTable, acquireLock, releaseLock } = require("../services/jobLock.repository");
const { savePipelineStage } = require("../services/pipelineStatus.repository");
const { refreshDemoPortfolio } = require("../services/adminDemoPortfolio.service");

const { getSharedPool, closeAllPools } = require("../config/database");
const pool = getSharedPool();
const LOCK_TTL_SECONDS = 15 * 60; // 15 min

// ── Job entry point ───────────────────────────────────────────────────────────

async function run() {
  return runJob("ui-demo-portfolio", async () => {
    await initJobLocksTable();

    const won = await acquireLock("ui_demo_portfolio_job", LOCK_TTL_SECONDS);
    if (!won) {
      logger.warn("[job:ui-demo-portfolio] skipped – lock held");
      return { skipped: true };
    }

    try {
    logger.info("[job:ui-demo-portfolio] building demo_portfolio summary");

    const result = await refreshDemoPortfolio();
    const holdingCount = result?.holdings?.length ?? 0;
    const success = result !== null && result !== undefined;

    await savePipelineStage("ui_demo_portfolio", {
      inputCount:   holdingCount,
      successCount: success ? 1 : 0,
      failedCount:  success ? 0 : 1,
    });

    logger.info("[job:ui-demo-portfolio] complete", {
      holdingCount,
      dataStatus: result?.dataStatus ?? "unknown",
      freshness:  result?.freshness ?? "unknown",
    });
    return { processedCount: holdingCount };
    } finally {
      await releaseLock("ui_demo_portfolio_job").catch(() => {});
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
      logger.error("ui-demo-portfolio job failed", {
        message: error.message,
        stack: error.stack,
      });
      closeAllPools();
      process.exit(1);
    });
}

module.exports = { run };
