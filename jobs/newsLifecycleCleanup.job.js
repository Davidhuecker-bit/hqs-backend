"use strict";

require("dotenv").config();

const logger = require("../utils/logger");
const { runJob } = require("../utils/jobRunner");
const {
  initJobLocksTable,
  acquireLock,
} = require("../services/jobLock.repository");
const {
  initMarketNewsTable,
  syncMarketNewsLifecycleStates,
  cleanupExpiredMarketNews,
} = require("../services/marketNews.repository");
const { savePipelineStage } = require("../services/pipelineStatus.repository");

async function run() {
  return runJob("newsLifecycleCleanup", async () => {
    await initJobLocksTable();

    const won = await acquireLock("news_lifecycle_cleanup_job", 60 * 60);
    if (!won) {
      logger.warn("[job:newsLifecycleCleanup] skipped – lock held");
      return { processedCount: 0 };
    }

    await initMarketNewsTable();

    const lifecycleSummary = await syncMarketNewsLifecycleStates();
    const cleanupSummary   = await cleanupExpiredMarketNews();

    const processedCount = (lifecycleSummary?.updated ?? 0) + (cleanupSummary?.deleted ?? 0);
    await savePipelineStage("news_lifecycle_cleanup", {
      inputCount: processedCount,
      successCount: processedCount,
      failedCount: 0,
    });
    return { processedCount, ...lifecycleSummary, ...cleanupSummary };
  });
}

async function runNewsLifecycleCleanupJob() {
  return run();
}

if (require.main === module) {
  runNewsLifecycleCleanupJob()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error("News lifecycle cleanup failed", {
        message: error.message,
        stack: error.stack,
      });
      process.exit(1);
    });
}

module.exports = {
  runNewsLifecycleCleanupJob,
};
