"use strict";

const { Pool } = require("pg");
let logger = null;
try { logger = require("../utils/logger"); } catch (_) { logger = null; }

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

async function acquireLock(name, ttlSeconds = 600) {
  const lockName = String(name || "").trim();
  if (!lockName) return false;

  const res = await pool.query(
    `
    INSERT INTO job_locks(name, locked_until)
    VALUES ($1, NOW() + ($2 || ' seconds')::interval)
    ON CONFLICT(name) DO UPDATE SET
      locked_until = CASE
        WHEN job_locks.locked_until < NOW()
          THEN NOW() + ($2 || ' seconds')::interval
        ELSE job_locks.locked_until
      END
    RETURNING locked_until
    `,
    [lockName, String(ttlSeconds)]
  );

  const lockedUntil = res.rows?.[0]?.locked_until ? new Date(res.rows[0].locked_until) : null;
  const ok = lockedUntil && lockedUntil > new Date();

  // ok heißt hier: lock existiert. Aber wir müssen prüfen, ob wir ihn gerade "neu" bekommen haben.
  // Trick: wenn locked_until schon vorher in der Zukunft war, bleibt es unverändert -> dann haben wir NICHT gewonnen.
  // Das können wir nur sicher prüfen, indem wir danach lesen:
  const check = await pool.query(`SELECT locked_until FROM job_locks WHERE name=$1`, [lockName]);
  const lu = new Date(check.rows[0].locked_until);

  // Wenn lock_until jetzt mindestens ttlSeconds-1 in der Zukunft liegt, dann waren wir der Setter.
  const threshold = new Date(Date.now() + (ttlSeconds - 1) * 1000);
  const won = lu > threshold;

  if (logger?.info) logger.info("lock acquire", { name: lockName, won, lockedUntil: lu.toISOString() });
  return won;
}

module.exports = {
  initJobLocksTable,
  acquireLock,
};
