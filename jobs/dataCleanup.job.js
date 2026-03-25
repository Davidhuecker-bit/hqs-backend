"use strict";

/**
 * Data Cleanup Job
 *
 * Periodically removes or archives stale data from scan-tracking and
 * status tables that accumulate unbounded rows over time.
 *
 * Targets:
 *   - universe_scan_state  : keep only the most recent entry per key
 *   - pipeline_status      : mark stages as stale when last_run_at is very old
 *   - job_locks            : remove expired locks left by crashed processes
 *   - fx_rates             : remove old rows to prevent unbounded growth
 *
 * Safe to run multiple times – all operations are idempotent.
 * Never touches market_snapshots, hqs_scores, market_news, factor_history,
 * or any other business data table.
 *
 * Schedule: daily (deployed as a dedicated Railway cron service).
 */

require("dotenv").config();

const { Pool } = require("pg");
const logger = require("../utils/logger");
const { runJob } = require("../utils/jobRunner");
const { initJobLocksTable, acquireLock } = require("../services/jobLock.repository");
const { savePipelineStage } = require("../services/pipelineStatus.repository");

// ── Configuration ─────────────────────────────────────────────────────────────

// Remove job_locks whose locked_until timestamp is in the past by more than
// this many hours – indicates a crashed process that held the lock.
const JOB_LOCK_EXPIRY_HOURS = Number(process.env.DATA_CLEANUP_LOCK_EXPIRY_HOURS || 6);

// universe_scan_state rows older than this many days (per key, beyond the newest)
// are considered stale and are removed.
const UNIVERSE_SCAN_KEEP_DAYS = Number(process.env.DATA_CLEANUP_UNIVERSE_SCAN_KEEP_DAYS || 7);

// pipeline_status stages whose last_run_at is older than this many hours are
// logged as stale (we do NOT delete them – they persist as historical markers).
const PIPELINE_STALE_HOURS = Number(process.env.DATA_CLEANUP_PIPELINE_STALE_HOURS || 72);

// fx_rates rows older than this many days are removed (keeps only recent
// history for lookups – the most recent row per pair is always preserved).
const FX_RATES_KEEP_DAYS = Number(process.env.DATA_CLEANUP_FX_RATES_KEEP_DAYS || 90);

// ── DB pool ───────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function tableExists(name) {
  try {
    const r = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1
       ) AS exists`,
      [name]
    );
    return Boolean(r.rows?.[0]?.exists);
  } catch (_) {
    return false;
  }
}

// ── Cleanup tasks ─────────────────────────────────────────────────────────────

/**
 * Remove duplicate / stale universe_scan_state rows, keeping one per key.
 * universe_scan_state only ever needs the latest cursor value per key.
 *
 * @returns {{ deleted: number }}
 */
async function cleanUniverseScanState() {
  if (!(await tableExists("universe_scan_state"))) {
    return { deleted: 0, skipped: true, reason: "table_missing" };
  }

  try {
    // Delete rows that are not the most recent for their key and are older than
    // UNIVERSE_SCAN_KEEP_DAYS days.
    const res = await pool.query(
      `DELETE FROM universe_scan_state
       WHERE updated_at < NOW() - ($1 || ' days')::INTERVAL
         AND ctid NOT IN (
           SELECT DISTINCT ON (key) ctid
           FROM universe_scan_state
           ORDER BY key, updated_at DESC
         )`,
      [String(UNIVERSE_SCAN_KEEP_DAYS)]
    );
    const deleted = res.rowCount ?? 0;
    logger.info("[dataCleanup] universe_scan_state cleaned", { deleted });
    return { deleted };
  } catch (err) {
    logger.warn("[dataCleanup] cleanUniverseScanState failed", { message: err.message });
    return { deleted: 0, error: err.message };
  }
}

/**
 * Remove expired job_locks (locked_until is in the past by more than JOB_LOCK_EXPIRY_HOURS).
 * These are locks left behind by processes that crashed without releasing them.
 *
 * NOTE: The job_locks table schema has columns (name TEXT, locked_until TIMESTAMP).
 * There is no created_at column, so we use locked_until for expiry detection.
 *
 * @returns {{ deleted: number }}
 */
async function cleanExpiredJobLocks() {
  if (!(await tableExists("job_locks"))) {
    return { deleted: 0, skipped: true, reason: "table_missing" };
  }

  try {
    // Delete locks whose locked_until is in the past by more than the configured
    // expiry window.  A lock with locked_until < NOW() is already expired (other
    // jobs can acquire it), but we give an extra grace period so that locks which
    // just expired aren't removed while a new run might be starting.
    const res = await pool.query(
      `DELETE FROM job_locks
       WHERE locked_until < NOW() - ($1 || ' hours')::INTERVAL`,
      [String(JOB_LOCK_EXPIRY_HOURS)]
    );
    const deleted = res.rowCount ?? 0;
    logger.info("[dataCleanup] job_locks cleaned", { deleted, expiryHours: JOB_LOCK_EXPIRY_HOURS });
    return { deleted };
  } catch (err) {
    logger.warn("[dataCleanup] cleanExpiredJobLocks failed", { message: err.message });
    return { deleted: 0, error: err.message };
  }
}

/**
 * Log a warning for pipeline_status stages that have not been updated recently.
 * Does NOT delete any rows – pipeline_status rows are keyed by stage and should
 * persist as historical markers even during idle periods.
 *
 * @returns {{ staleStages: string[] }}
 */
async function auditPipelineStatusStaleness() {
  if (!(await tableExists("pipeline_status"))) {
    return { staleStages: [], skipped: true, reason: "table_missing" };
  }

  try {
    const res = await pool.query(
      `SELECT stage, last_run_at, last_healthy_run
       FROM pipeline_status
       WHERE last_run_at < NOW() - ($1 || ' hours')::INTERVAL
          OR last_run_at IS NULL`,
      [String(PIPELINE_STALE_HOURS)]
    );
    const staleStages = res.rows.map((r) => r.stage);
    if (staleStages.length > 0) {
      logger.warn("[dataCleanup] pipeline_status stale stages detected", {
        staleStages,
        staleThresholdHours: PIPELINE_STALE_HOURS,
      });
    } else {
      logger.info("[dataCleanup] pipeline_status all stages recent");
    }
    return { staleStages };
  } catch (err) {
    logger.warn("[dataCleanup] auditPipelineStatusStaleness failed", { message: err.message });
    return { staleStages: [], error: err.message };
  }
}

/**
 * Remove old fx_rates rows to prevent unbounded table growth.
 * Always preserves at least one row per (base_currency, quote_currency) pair
 * so that the last-known-good FX rate remains available.
 *
 * @returns {{ deleted: number }}
 */
async function cleanOldFxRates() {
  if (!(await tableExists("fx_rates"))) {
    return { deleted: 0, skipped: true, reason: "table_missing" };
  }

  try {
    // Delete rows older than FX_RATES_KEEP_DAYS, but never the most recent row
    // per currency pair (so fallback lookups always have at least one value).
    const res = await pool.query(
      `DELETE FROM fx_rates
       WHERE created_at < NOW() - ($1 || ' days')::INTERVAL
         AND id NOT IN (
           SELECT DISTINCT ON (base_currency, quote_currency) id
           FROM fx_rates
           ORDER BY base_currency, quote_currency, created_at DESC
         )`,
      [String(FX_RATES_KEEP_DAYS)]
    );
    const deleted = res.rowCount ?? 0;
    logger.info("[dataCleanup] fx_rates cleaned", { deleted, keepDays: FX_RATES_KEEP_DAYS });
    return { deleted };
  } catch (err) {
    logger.warn("[dataCleanup] cleanOldFxRates failed", { message: err.message });
    return { deleted: 0, error: err.message };
  }
}

// ── Job entry point ───────────────────────────────────────────────────────────

async function run() {
  return runJob("dataCleanup", async () => {
    await initJobLocksTable();

    const won = await acquireLock("data_cleanup_job", 60 * 60 * 12); // 12-hour lock
    if (!won) {
      logger.warn("[job:dataCleanup] skipped – lock held");
      return { skipped: true };
    }

    logger.info("[job:dataCleanup] starting cleanup run");

    const [universeScan, jobLocks, pipelineAudit, fxRates] = await Promise.all([
      cleanUniverseScanState(),
      cleanExpiredJobLocks(),
      auditPipelineStatusStaleness(),
      cleanOldFxRates(),
    ]);

    const summary = {
      universeScanDeleted: universeScan.deleted ?? 0,
      jobLocksDeleted:     jobLocks.deleted     ?? 0,
      fxRatesDeleted:      fxRates.deleted      ?? 0,
      staleStages:         pipelineAudit.staleStages ?? [],
    };

    const totalCleaned = summary.universeScanDeleted + summary.jobLocksDeleted + summary.fxRatesDeleted;
    await savePipelineStage("data_cleanup", {
      inputCount: totalCleaned + summary.staleStages.length,
      successCount: totalCleaned,
      failedCount: 0,
    });

    logger.info("[job:dataCleanup] cleanup complete", summary);
    return summary;
  });
}

async function runDataCleanupJob() {
  return run();
}

if (require.main === module) {
  runDataCleanupJob()
    .then(() => {
      pool.end();
      process.exit(0);
    })
    .catch((error) => {
      logger.error("Data cleanup job failed", {
        message: error.message,
        stack: error.stack,
      });
      pool.end();
      process.exit(1);
    });
}

module.exports = { runDataCleanupJob };
