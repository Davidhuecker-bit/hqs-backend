"use strict";

/**
 * One-off Cron Job:
 * - ensures tables exist
 * - runs one snapshot batch (from universe_symbols)
 *
 * Required ENV:
 * - DATABASE_URL
 * - MASSIVE_API_KEY
 *
 * Optional ENV:
 * - SNAPSHOT_BATCH_SIZE=80  (default, max SNAPSHOT_SYMBOL_LIMIT)
 * - SNAPSHOT_REGION=us      (filter universe_symbols by region)
 * - HIST_PERIOD=1y|max
 */

require("dotenv").config();

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
const { refreshAndPersistFxRate } = require("../services/fx.service");

const { getSharedPool, closeAllPools } = require("../config/database");
const pool = getSharedPool();
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

      // Actively refresh FX rate so fx_rates table always has a recent row
      logger.info("snapshotScan: refreshAndPersistFxRate start");
      const fxRate = await refreshAndPersistFxRate();
      logger.info("snapshotScan: refreshAndPersistFxRate done", { fxRate });

      logger.info("snapshotScan: buildMarketSnapshot start");
      const result = await buildMarketSnapshot();
      logger.info("snapshotScan: buildMarketSnapshot done", {
        processedCount: result?.processedCount ?? 0,
        skipped: result?.skipped ?? false,
        skipReason: result?.skipReason,
      });

      return result;
    },
    { pool, dbRetries: 5, dbDelayMs: 3000 }
  );
}

run()
  .then(() => {
    closeAllPools().catch(() => {});
    process.exit(0);
  })
  .catch((err) => {
    logger.error("snapshotScan job failed", {
      message: err?.message || String(err),
      stack: err?.stack,
    });
    closeAllPools().catch(() => {});
    process.exit(1);
  });
