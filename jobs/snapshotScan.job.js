"use strict";

/**
 * jobs/snapshotScan.job.js
 * One-off Cron Job:
 * - ensures tables exist
 * - runs one snapshot batch (watchlist OR universe depending on env)
 *
 * Required ENV:
 * - DATABASE_URL
 * - MASSIVE_API_KEY
 *
 * Optional ENV:
 * - SNAPSHOT_SOURCE=universe
 * - SNAPSHOT_BATCH_SIZE=150
 * - HIST_PERIOD=1y|max
 */

require("dotenv").config();

const logger = require("../utils/logger");

const { ensureTablesExist, buildMarketSnapshot } = require("../services/marketService");
const { initJobLocksTable } = require("../services/jobLock.repository");

async function run() {
  logger.info("snapshotScan job started");

  // Safety: make sure lock table exists
  await initJobLocksTable();

  // Safety: ensure required tables exist (including universe/watchlist/advanced metrics)
  await ensureTablesExist();

  // Run exactly one batch (lock inside buildMarketSnapshot prevents overlapping runs)
  await buildMarketSnapshot();

  logger.info("snapshotScan job finished");
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error("snapshotScan job failed", {
      message: err?.message || String(err),
      stack: err?.stack,
    });
    process.exit(1);
  });
