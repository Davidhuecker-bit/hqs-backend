"use strict";

/**
 * DB Health utilities
 *
 * classifyDbError(err)        → typed error category string
 * checkDbReady(pool)          → { ready, errorType?, message? }
 * waitForDb(pool, opts)       → Promise<boolean>  (true = DB ready)
 */

let logger = null;
try {
  logger = require("./logger");
} catch (_) {
  logger = console;
}

const DB_ERROR_TYPES = {
  DB_DOWN: "DB_DOWN",
  DB_RECOVERING: "DB_RECOVERING",
  TLS_ISSUE: "TLS_ISSUE",
  TIMEOUT: "TIMEOUT",
  QUERY_ERROR: "QUERY_ERROR",
};

/**
 * Classify a pg / network error into a named category so callers can log
 * structured, distinguishable messages instead of raw stack traces.
 *
 * @param {Error|any} err
 * @returns {string}  one of DB_ERROR_TYPES
 */
function classifyDbError(err) {
  if (!err) return DB_ERROR_TYPES.QUERY_ERROR;

  const msg = String(err.message || err).toLowerCase();
  const code = String(err.code || "").toUpperCase();

  // Hard connection failures (DB down / unreachable)
  if (
    msg.includes("connection terminated unexpectedly") ||
    msg.includes("server closed the connection") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("connect econnreset") ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ECONNRESET"
  ) {
    return DB_ERROR_TYPES.DB_DOWN;
  }

  // Recovery mode (Postgres startup / WAL replay)
  if (msg.includes("recovery") || msg.includes("in recovery mode")) {
    return DB_ERROR_TYPES.DB_RECOVERING;
  }

  // TLS / SSL handshake failures
  if (
    msg.includes("tls") ||
    msg.includes("ssl") ||
    msg.includes("client network socket disconnected before secure") ||
    msg.includes("certificate") ||
    msg.includes("handshake")
  ) {
    return DB_ERROR_TYPES.TLS_ISSUE;
  }

  // Query / statement timeouts
  if (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    code === "ETIMEDOUT" ||
    code === "57014" // statement_timeout
  ) {
    return DB_ERROR_TYPES.TIMEOUT;
  }

  return DB_ERROR_TYPES.QUERY_ERROR;
}

/**
 * Single SELECT 1 probe.
 * @param {import('pg').Pool} pool
 * @returns {Promise<{ ready: boolean, errorType?: string, message?: string }>}
 */
async function checkDbReady(pool) {
  try {
    await pool.query("SELECT 1");
    return { ready: true };
  } catch (err) {
    const errorType = classifyDbError(err);
    return { ready: false, errorType, message: err.message };
  }
}

/**
 * Retry loop until DB is responsive or retries exhausted.
 *
 * @param {import('pg').Pool} pool
 * @param {object} [opts]
 * @param {number} [opts.maxRetries=5]
 * @param {number} [opts.delayMs=3000]
 * @param {string} [opts.label="waitForDb"]
 * @returns {Promise<boolean>}  true = DB became ready, false = gave up
 */
async function waitForDb(pool, { maxRetries = 5, delayMs = 3000, label = "waitForDb" } = {}) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await checkDbReady(pool);

    if (result.ready) {
      if (attempt > 1) {
        logger.info(`[${label}] DB ready after ${attempt} attempt(s)`);
      }
      return true;
    }

    logger.warn(`[${label}] DB not ready (attempt ${attempt}/${maxRetries})`, {
      errorType: result.errorType,
      message: result.message,
    });

    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  logger.error(`[${label}] DB not ready after ${maxRetries} attempts – giving up`, {
    label,
    maxRetries,
  });
  return false;
}

module.exports = {
  DB_ERROR_TYPES,
  classifyDbError,
  checkDbReady,
  waitForDb,
};
