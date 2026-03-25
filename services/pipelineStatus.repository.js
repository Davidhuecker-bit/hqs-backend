"use strict";

/**
 * Pipeline Status Persistence
 *
 * Persists per-stage counts to the `pipeline_status` table so that
 * /api/admin/pipeline-status shows meaningful numbers even after a
 * Railway restart (instead of all-zeros).
 *
 * Schema (created on first use):
 *   pipeline_status (
 *     stage        TEXT PRIMARY KEY,
 *     last_run_at  TIMESTAMPTZ,
 *     input_count  INT DEFAULT 0,
 *     success_count INT DEFAULT 0,
 *     failed_count  INT DEFAULT 0,
 *     skipped_count INT DEFAULT 0,
 *     updated_at   TIMESTAMPTZ DEFAULT NOW()
 *   )
 */

const { Pool } = require("pg");

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = console;
}

// Module-level DB pool for pipelineStatus operations.
// This pool persists for the process lifetime and is shared across all
// calls to savePipelineStage / loadPipelineStatus.  It is intentionally
// not closed explicitly – the pg driver drains it on process exit / SIGTERM.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const ALLOWED_STAGES = new Set([
  "universe",
  "snapshot",
  "advancedMetrics",
  "hqsScoring",
  "outcome",
  "market_news_refresh",
  "universe_refresh",
  "build_entity_map",
  "daily_briefing",
  "summary_refresh",
  "forecast_verification",
  "causal_memory",
  "tech_radar",
  "news_lifecycle_cleanup",
  "discovery_notify",
  "data_cleanup",
  "ui_market_list",
  "ui_demo_portfolio",
  "ui_guardian_status",
  "historical_backfill",
]);

let tableReady = false;
let tableInitPromise = null;

async function ensurePipelineStatusTable() {
  if (tableReady) return;
  // Serialize concurrent calls with a single shared promise
  if (!tableInitPromise) {
    tableInitPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS pipeline_status (
        stage              TEXT PRIMARY KEY,
        last_run_at        TIMESTAMPTZ,
        last_healthy_run   TIMESTAMPTZ,
        input_count        INT  NOT NULL DEFAULT 0,
        success_count      INT  NOT NULL DEFAULT 0,
        failed_count       INT  NOT NULL DEFAULT 0,
        skipped_count      INT  NOT NULL DEFAULT 0,
        status             TEXT NOT NULL DEFAULT 'unknown',
        error_message      TEXT,
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    .then(() =>
      // Idempotent migration: add columns if they don't exist yet
      pool.query(`
        ALTER TABLE pipeline_status
          ADD COLUMN IF NOT EXISTS last_healthy_run TIMESTAMPTZ;
        ALTER TABLE pipeline_status
          ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'unknown';
        ALTER TABLE pipeline_status
          ADD COLUMN IF NOT EXISTS error_message TEXT;
      `)
    )
    .then(() => { tableReady = true; });
  }
  await tableInitPromise;
}

/**
 * Persist stage counts to DB.  Never throws – errors are logged and swallowed
 * so that a DB hiccup never blocks the main pipeline run.
 *
 * Sets last_healthy_run when the stage reports at least one successful item,
 * so it is always clear when the stage last processed data correctly.
 *
 * @param {string} stage
 * @param {{ inputCount?: number, successCount?: number, failedCount?: number, skippedCount?: number, status?: string, errorMessage?: string }} counts
 */
async function savePipelineStage(stage, counts) {
  if (!ALLOWED_STAGES.has(stage)) return;
  try {
    await ensurePipelineStatusTable();
    const successCount = Number(counts.successCount) || 0;
    const failedCount = Number(counts.failedCount) || 0;
    const derivedStatus = counts.status || (failedCount > 0 && successCount === 0 ? "failed" : successCount > 0 ? "success" : "unknown");
    const errorMessage = counts.errorMessage || null;
    await pool.query(
      `INSERT INTO pipeline_status
         (stage, last_run_at, last_healthy_run, input_count, success_count, failed_count, skipped_count, status, error_message, updated_at)
       VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (stage) DO UPDATE SET
         last_run_at        = NOW(),
         last_healthy_run   = CASE WHEN EXCLUDED.success_count > 0 THEN NOW()
                                   ELSE pipeline_status.last_healthy_run END,
         input_count        = EXCLUDED.input_count,
         success_count      = EXCLUDED.success_count,
         failed_count       = EXCLUDED.failed_count,
         skipped_count      = EXCLUDED.skipped_count,
         status             = EXCLUDED.status,
         error_message      = EXCLUDED.error_message,
         updated_at         = NOW()`,
      [
        stage,
        successCount > 0 ? new Date().toISOString() : null,
        Number(counts.inputCount)   || 0,
        successCount,
        failedCount,
        Number(counts.skippedCount) || 0,
        derivedStatus,
        errorMessage,
      ]
    );
    logger.info("[pipelineStatus] stage persisted", {
      stage,
      lastRunAt:     new Date().toISOString(),
      inputCount:    Number(counts.inputCount)   || 0,
      successCount,
      failedCount,
      skippedCount:  Number(counts.skippedCount) || 0,
      status:        derivedStatus,
    });
  } catch (err) {
    logger.warn("[pipelineStatus] savePipelineStage failed", {
      stage,
      message: err.message,
    });
  }
}

/**
 * Load persisted stage data from DB.
 * Returns a map  stage → { lastRunAt, inputCount, successCount, failedCount, skippedCount }
 * On any error returns an empty object (caller falls back to runtime data).
 *
 * @returns {Promise<Record<string,object>>}
 */
async function loadPipelineStatus() {
  try {
    await ensurePipelineStatusTable();
    const res = await pool.query(
      `SELECT stage, last_run_at, last_healthy_run, input_count, success_count, failed_count, skipped_count, status, error_message
       FROM pipeline_status`
    );
    const result = {};
    for (const row of res.rows) {
      result[row.stage] = {
        lastRunAt:      row.last_run_at      ? row.last_run_at.toISOString()      : null,
        lastHealthyRun: row.last_healthy_run ? row.last_healthy_run.toISOString() : null,
        inputCount:     Number(row.input_count)   || 0,
        successCount:   Number(row.success_count) || 0,
        failedCount:    Number(row.failed_count)  || 0,
        skippedCount:   Number(row.skipped_count) || 0,
        status:         row.status || "unknown",
        errorMessage:   row.error_message || null,
      };
    }
    return result;
  } catch (err) {
    logger.warn("[pipelineStatus] loadPipelineStatus failed", {
      message: err.message,
    });
    return {};
  }
}

module.exports = {
  ensurePipelineStatusTable,
  savePipelineStage,
  loadPipelineStatus,
};
