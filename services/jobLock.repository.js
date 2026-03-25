"use strict";

const { Pool } = require("pg");
let logger = null;

try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

const connectionString =
  process.env.DATABASE_URL ||
  `postgresql://${process.env.PGUSER}:${process.env.PGPASSWORD}@${process.env.PGHOST}:${process.env.PGPORT}/${process.env.PGDATABASE}`;

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

async function initJobLocksTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_locks (
      name TEXT PRIMARY KEY,
      locked_until TIMESTAMP NOT NULL
    );
  `);

  if (logger?.info) logger.info("job_locks ready");
}

/**
 * Atomarer Lock:
 * - Insert wenn nicht vorhanden
 * - Update nur wenn abgelaufen
 */
async function acquireLock(name, ttlSeconds = 600) {
  const lockName = String(name || "").trim();
  const ttl = Number(ttlSeconds);

  if (!lockName) return false;
  if (!Number.isFinite(ttl) || ttl <= 0) return false;

  const res = await pool.query(
    `
    INSERT INTO job_locks(name, locked_until)
    VALUES ($1, NOW() + ($2 || ' seconds')::interval)
    ON CONFLICT(name) DO UPDATE
      SET locked_until = NOW() + ($2 || ' seconds')::interval
      WHERE job_locks.locked_until < NOW()
    `,
    [lockName, String(ttl)]
  );

  const won = res.rowCount === 1;

  if (logger?.info)
    logger.info("lock acquire", { name: lockName, won, ttlSeconds: ttl });

  return won;
}

/**
 * Explicitly release a lock so the next run can proceed immediately
 * instead of waiting for TTL expiry.
 */
async function releaseLock(name) {
  const lockName = String(name || "").trim();
  if (!lockName) return false;

  try {
    const res = await pool.query(
      `DELETE FROM job_locks WHERE name = $1`,
      [lockName]
    );
    const released = res.rowCount >= 1;
    if (logger?.info)
      logger.info("lock release", { name: lockName, released });
    return released;
  } catch (err) {
    if (logger?.warn)
      logger.warn("lock release failed", { name: lockName, message: err.message });
    return false;
  }
}

module.exports = {
  initJobLocksTable,
  acquireLock,
  releaseLock,
};
