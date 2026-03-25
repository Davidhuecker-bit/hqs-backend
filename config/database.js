"use strict";

const { Pool } = require("pg");

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

/**
 * Central shared database pool – the ONLY place in the codebase that
 * creates PostgreSQL connections.
 *
 * Railway PostgreSQL connection limits:
 *   Free tier  ~20 connections
 *   Hobby tier ~100 connections
 *
 * Strategy:
 *   - ONE shared pool per process (API server or cron job)
 *   - max 15 keeps headroom on hobby tier even with multiple services
 *   - idleTimeoutMillis 30 s releases idle connections quickly
 *   - connectionTimeoutMillis 10 s fails fast on unreachable DB
 *   - statement_timeout 30 s prevents runaway queries
 *   - allowExitOnIdle lets Node exit when the event loop is empty
 */

const DEFAULT_POOL_CONFIG = {
  max: 15,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 30000,
  allowExitOnIdle: true,
  ssl: { rejectUnauthorized: false },
};

/**
 * Validate DATABASE_URL is present
 */
function validateDatabaseUrl() {
  const url = process.env.DATABASE_URL;

  if (!url) {
    const fallbackVars = ['PGUSER', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGPASSWORD'];
    const hasFallback = fallbackVars.every(v => process.env[v]);

    if (!hasFallback) {
      throw new Error(
        'DATABASE_URL is required. ' +
        'Set DATABASE_URL or all of: PGUSER, PGHOST, PGPORT, PGDATABASE, PGPASSWORD'
      );
    }

    const { PGUSER, PGPASSWORD, PGHOST, PGPORT, PGDATABASE } = process.env;
    return `postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}`;
  }

  return url;
}

/**
 * Create a configured database pool
 * @param {Object} customConfig - Optional overrides (e.g. { max: 1 } for probe)
 * @returns {Pool} Configured PostgreSQL pool
 */
function createPool(customConfig = {}) {
  const connectionString = validateDatabaseUrl();

  const config = {
    connectionString,
    ...DEFAULT_POOL_CONFIG,
    ...customConfig,
  };

  if (logger?.debug) {
    logger.debug('Creating database pool', {
      max: config.max,
      idleTimeoutMillis: config.idleTimeoutMillis,
      connectionTimeoutMillis: config.connectionTimeoutMillis,
    });
  }

  const pool = new Pool(config);

  pool.on('error', (err) => {
    if (logger?.error) {
      logger.error('Unexpected pool error', {
        message: err.message,
        stack: err.stack,
      });
    } else {
      console.error('Unexpected pool error:', err);
    }
  });

  return pool;
}

/**
 * Shared application pool (singleton per process).
 * Every service, repository, and job in this process shares this pool.
 */
let _sharedPool = null;

function getSharedPool() {
  if (!_sharedPool) {
    _sharedPool = createPool();   // uses DEFAULT_POOL_CONFIG (max 15)
  }
  return _sharedPool;
}

/**
 * Gracefully close a pool
 * @param {Pool} pool - Pool to close
 */
async function closePool(pool) {
  if (!pool) return;

  try {
    await pool.end();
    if (logger?.debug) {
      logger.debug('Pool closed successfully');
    }
  } catch (err) {
    if (logger?.warn) {
      logger.warn('Error closing pool', {
        message: err.message,
      });
    }
  }
}

/**
 * Close the shared pool and reset the singleton.
 * Call this on process exit (graceful shutdown or job completion).
 */
async function closeAllPools() {
  if (_sharedPool) {
    await closePool(_sharedPool);
    _sharedPool = null;
  }
}

module.exports = {
  createPool,
  getSharedPool,
  closePool,
  closeAllPools,
  validateDatabaseUrl,
  DEFAULT_POOL_CONFIG,
};
