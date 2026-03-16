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

const { Pool } = require("pg");
const logger = require("../utils/logger");
const { runJob } = require("../utils/jobRunner");
const {
  ensureTablesExist,
  buildMarketSnapshot,
} = require("../services/marketService");
const { initJobLocksTable } = require("../services/jobLock.repository");
const {
  initOutcomeTrackingTable,
} = require("../services/outcomeTracking.repository");

// Shared pool for DB readiness probe inside this job process
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

async function run() {
  await runJob(
    "snapshotScan",
    async () => {
      await initJobLocksTable();

      logger.info("snapshotScan: initOutcomeTrackingTable start");
      await initOutcomeTrackingTable();
      logger.info("snapshotScan: initOutcomeTrackingTable done");

      logger.info("snapshotScan: ensureTablesExist start");
      await ensureTablesExist();
      logger.info("snapshotScan: ensureTablesExist done");

      logger.info("snapshotScan: buildMarketSnapshot start");
      await buildMarketSnapshot();
      logger.info("snapshotScan: buildMarketSnapshot done");
    },
    { pool, dbRetries: 5, dbDelayMs: 3000 }
  );
}

run()
  .then(() => {
    pool.end().catch(() => {});
    process.exit(0);
  })
  .catch((err) => {
    logger.error("snapshotScan job failed", {
      message: err?.message || String(err),
      stack: err?.stack,
    });
    pool.end().catch(() => {});
    process.exit(1);
  });
