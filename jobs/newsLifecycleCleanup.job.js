"use strict";

require("dotenv").config();

const logger = require("../utils/logger");
const {
  initJobLocksTable,
  acquireLock,
} = require("../services/jobLock.repository");
const {
  initMarketNewsTable,
  syncMarketNewsLifecycleStates,
  cleanupExpiredMarketNews,
} = require("../services/marketNews.repository");

async function run() {
  await initJobLocksTable();

  const won = await acquireLock("news_lifecycle_cleanup_job", 60 * 60);
  if (!won) {
    logger.warn("News lifecycle cleanup skipped (lock held)");
    return;
  }

  await initMarketNewsTable();

  const lifecycleSummary = await syncMarketNewsLifecycleStates();
  const cleanupSummary = await cleanupExpiredMarketNews();

  logger.info("News lifecycle cleanup completed", {
    ...lifecycleSummary,
    ...cleanupSummary,
  });

  return {
    ...lifecycleSummary,
    ...cleanupSummary,
  };
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
