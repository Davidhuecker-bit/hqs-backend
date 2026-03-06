"use strict";

/**
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

  await initJobLocksTable();
  await ensureTablesExist();
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
