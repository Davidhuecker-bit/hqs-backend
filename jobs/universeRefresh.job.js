"use strict";

// jobs/universeRefresh.job.js
// Run: node jobs/universeRefresh.job.js

require("dotenv").config();

const logger = require("../utils/logger");
const { acquireLock, initJobLocksTable } = require("../services/jobLock.repository");
const { refreshUniverse } = require("../services/universe.service");

async function run() {
  await initJobLocksTable();

  // 2h TTL -> schützt gegen doppelte Cron-Runs
  const won = await acquireLock("universe_refresh_job", 2 * 60 * 60);
  if (!won) {
    logger.warn("Universe refresh skipped (lock held)");
    return;
  }

  const result = await refreshUniverse();
  logger.info("Universe refresh job done", result);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error("Universe refresh job failed", { message: err.message });
    process.exit(1);
  });
