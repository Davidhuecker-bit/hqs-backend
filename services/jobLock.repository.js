"use strict";

const { Pool } = require("pg");
let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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
 * - Update nur wenn abgelaufen (locked_until < NOW())
 * - Wenn Update/Insert passiert ist => gewonnen
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

  // rowCount === 1 => wir haben Insert gemacht ODER Update durchgeführt (also gewonnen)
  const won = res.rowCount === 1;

  if (logger?.info) logger.info("lock acquire", { name: lockName, won, ttlSeconds: ttl });
  return won;
}

module.exports = {
  initJobLocksTable,
  acquireLock,
};
