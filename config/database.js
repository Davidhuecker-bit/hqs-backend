"use strict";

const { Pool } = require("pg");

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

/**
 * Shared database pool configuration for optimal Railway deployment
 * 
 * Railway PostgreSQL connection limits:
 * - Free tier: 20 connections
 * - Hobby tier: 100 connections
 * 
 * Configuration strategy:
 * - Limit each pool to max 5 connections to prevent exhaustion
 * - Set idle timeout to 30s to release unused connections
 * - Set connection timeout to 10s to fail fast
 * - SSL configured for Railway's self-signed certificates
 */

const DEFAULT_POOL_CONFIG = {
  max: 5,                      // Maximum connections per pool
  idleTimeoutMillis: 30000,    // Close idle connections after 30s
  connectionTimeoutMillis: 10000, // Fail fast if can't connect in 10s
  ssl: { rejectUnauthorized: false }, // Railway uses self-signed certs
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
    
    // Build connection string from individual parts
    const { PGUSER, PGPASSWORD, PGHOST, PGPORT, PGDATABASE } = process.env;
    return `postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}`;
  }
  
  return url;
}

/**
 * Create a configured database pool
 * @param {Object} customConfig - Optional custom configuration to override defaults
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
  
  // Log pool errors
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
 * Shared application pool for general use
 * Most services should use this instead of creating their own pool
 */
let _sharedPool = null;

function getSharedPool() {
  if (!_sharedPool) {
    _sharedPool = createPool({ max: 10 }); // Shared pool gets more connections
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
 * Close all pools gracefully
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
