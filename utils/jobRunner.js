"use strict";

/**
 * Standardised job execution wrapper.
 *
 * Logs per run:
 *   job name · started_at · finished_at · duration_ms
 *   processed_count · success/failure · skip_reason
 *
 * Optional DB readiness guard: if `pool` is supplied the job is skipped
 * (not thrown) when the DB is not reachable.
 */

let logger = null;
try {
  logger = require("./logger");
} catch (_) {
  logger = console;
}

/**
 * @param {string}   name     Job identifier used in every log line
 * @param {Function} fn       Async job body; may return an object with
 *                            { processedCount, processed, count } for logging
 * @param {object}  [opts]
 * @param {import('pg').Pool|null} [opts.pool]       If set, check DB before running
 * @param {number}  [opts.dbRetries=3]               Retries for waitForDb
 * @param {number}  [opts.dbDelayMs=2000]            ms between retries
 *
 * @returns {Promise<{
 *   success:        boolean,
 *   durationMs:     number,
 *   processedCount: number,
 *   skipped:        boolean,
 *   skipReason?:    string,
 *   error?:         string
 * }>}
 */
async function runJob(name, fn, opts = {}) {
  const { pool = null, dbRetries = 3, dbDelayMs = 2000 } = opts;

  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  logger.info(`[job:${name}] started`, { startedAt });

  // ── DB readiness guard ──────────────────────────────────────────────────
  if (pool) {
    const { waitForDb } = require("./dbHealth");
    const isReady = await waitForDb(pool, {
      maxRetries: dbRetries,
      delayMs: dbDelayMs,
      label: `job:${name}`,
    });

    if (!isReady) {
      const durationMs = Date.now() - startMs;
      logger.warn(`[job:${name}] skipped – DB not ready`, {
        startedAt,
        durationMs,
        skipReason: "db_not_ready",
      });
      return {
        success: false,
        durationMs,
        processedCount: 0,
        skipped: true,
        skipReason: "db_not_ready",
      };
    }
  }

  // ── Execute job body ────────────────────────────────────────────────────
  try {
    const result = await fn();
    const durationMs = Date.now() - startMs;
    const finishedAt = new Date().toISOString();

    // Accept several conventional result shapes
    const processedCount =
      result && typeof result === "object"
        ? (result.processedCount ?? result.processed ?? result.count ?? 0)
        : 0;

    logger.info(`[job:${name}] finished`, {
      startedAt,
      finishedAt,
      durationMs,
      processedCount,
      success: true,
    });

    return { success: true, durationMs, processedCount, skipped: false };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const finishedAt = new Date().toISOString();

    logger.error(`[job:${name}] failed`, {
      startedAt,
      finishedAt,
      durationMs,
      error: err.message,
    });

    return {
      success: false,
      durationMs,
      processedCount: 0,
      skipped: false,
      error: err.message,
    };
  }
}

module.exports = { runJob };
