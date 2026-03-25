"use strict";

/**
 * UI Market List Writer Job
 *
 * Dedicated job that builds and persists the `market_list` UI summary
 * to the `ui_summaries` table.  The API server only reads this data —
 * it never rebuilds the summary on demand.
 *
 * Pipeline stage: ui_market_list
 *
 * Schedule recommendation: every 5 minutes (Railway cron or external trigger).
 */

require("dotenv").config();

const logger = require("../utils/logger");
const { runJob } = require("../utils/jobRunner");
const { initJobLocksTable, acquireLock } = require("../services/jobLock.repository");
const { savePipelineStage } = require("../services/pipelineStatus.repository");
const { refreshMarketSummary } = require("../services/marketSummary.builder");

const { getSharedPool, closeAllPools } = require("../config/database");
const pool = getSharedPool();
const LOCK_TTL_SECONDS = 10 * 60; // 10 min
const MAX_MARKET_LIST_SYMBOLS = 250;

// ── Job entry point ───────────────────────────────────────────────────────────

async function run() {
  return runJob("ui-market-list", async () => {
    await initJobLocksTable();

    const won = await acquireLock("ui_market_list_job", LOCK_TTL_SECONDS);
    if (!won) {
      logger.warn("[job:ui-market-list] skipped – lock held");
      return { skipped: true };
    }

    logger.info("[job:ui-market-list] building market_list summary");

    const stocks = await refreshMarketSummary({ limit: MAX_MARKET_LIST_SYMBOLS });
    const symbolCount = Array.isArray(stocks) ? stocks.length : 0;

    await savePipelineStage("ui_market_list", {
      inputCount:   symbolCount,
      successCount: stocks !== null ? 1 : 0,
      failedCount:  stocks === null ? 1 : 0,
    });

    logger.info("[job:ui-market-list] complete", { symbolCount });
    return { processedCount: symbolCount };
  }, { pool });
}

if (require.main === module) {
  run()
    .then(() => {
      closeAllPools();
      process.exit(0);
    })
    .catch((error) => {
      logger.error("ui-market-list job failed", {
        message: error.message,
        stack: error.stack,
      });
      closeAllPools();
      process.exit(1);
    });
}

module.exports = { run };
