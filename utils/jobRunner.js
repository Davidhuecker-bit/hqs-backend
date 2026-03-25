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
 *
 * Error alerting:
 *   When a job throws an unhandled error, a Slack alert is sent if
 *   ALERT_SLACK_WEBHOOK_URL is configured (env var).  The alert is fire-and-
 *   forget: a delivery failure never masks the original job error.
 */

let logger = null;
try {
  logger = require("./logger");
} catch (_) {
  logger = console;
}

// ── Slack alerting ──────────────────────────────────────────────────────────
const SLACK_WEBHOOK_URL = String(process.env.ALERT_SLACK_WEBHOOK_URL || "").trim();

async function sendSlackAlert(name, err, durationMs) {
  if (!SLACK_WEBHOOK_URL) return;

  let axios;
  try {
    axios = require("axios");
  } catch (_) {
    return;
  }

  const env    = String(process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV || "unknown");
  const svcName = String(process.env.RAILWAY_SERVICE_NAME || "HQS Backend");
  const text = [
    `:rotating_light: *Job failed* · \`${name}\``,
    `*Service:* ${svcName}  |  *Env:* ${env}`,
    `*Duration:* ${durationMs} ms`,
    `*Error:* ${String(err?.message || err).slice(0, 500)}`,
  ].join("\n");

  try {
    await axios.post(SLACK_WEBHOOK_URL, { text }, { timeout: 5000 });
  } catch (_) {
    // Fire-and-forget: never let alerting crash the job runner
  }
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

    // Propagate skip signals from the job body (e.g. lock-blocked runs)
    const bodySkipped = result && typeof result === "object" && result.skipped === true;
    const bodySkipReason = bodySkipped ? result.skipReason : undefined;

    if (bodySkipped) {
      logger.warn(`[job:${name}] skipped`, {
        startedAt,
        finishedAt,
        durationMs,
        processedCount,
        skipReason: bodySkipReason,
      });
      return { success: true, durationMs, processedCount, skipped: true, skipReason: bodySkipReason };
    }

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

    let errorType = "UNKNOWN";
    try {
      const { classifyDbError } = require("./dbHealth");
      errorType = classifyDbError(err);
    } catch (_) {
      // dbHealth unavailable – keep UNKNOWN
    }

    logger.error(`[job:${name}] failed`, {
      startedAt,
      finishedAt,
      durationMs,
      errorType,
      error: err.message,
    });

    // Fire-and-forget Slack alert (does not block the return value)
    sendSlackAlert(name, err, durationMs).catch(() => {});

    return {
      success: false,
      durationMs,
      processedCount: 0,
      skipped: false,
      errorType,
      error: err.message,
    };
  }
}

module.exports = { runJob };
