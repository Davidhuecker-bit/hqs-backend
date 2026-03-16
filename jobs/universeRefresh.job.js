"use strict";

// jobs/universeRefresh.job.js
// Run: node jobs/universeRefresh.job.js

require("dotenv").config();

const { Pool } = require("pg");
const logger = require("../utils/logger");
const { runJob } = require("../utils/jobRunner");
const { acquireLock, initJobLocksTable } = require("../services/jobLock.repository");
const { refreshUniverse } = require("../services/universe.service");

// Shared pool used for the DB readiness guard
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

async function run() {
  await runJob(
    "universeRefresh",
    async () => {
      await initJobLocksTable();

      // 2h TTL – protects against duplicate cron runs
      const won = await acquireLock("universe_refresh_job", 2 * 60 * 60);
      if (!won) {
        logger.warn("[job:universeRefresh] skipped – lock held", { skipReason: "lock_held" });
        return { processedCount: 0 };
      }

      const result = await refreshUniverse();
      return { processedCount: result?.inserted ?? result?.total ?? 0, ...result };
    },
    { pool, dbRetries: 5, dbDelayMs: 3000 }
  );
}

run()
  .then(() => {
    pool.end().catch(() => {});
    process.exit(0);
  })
  .catch((err) => {
    logger.error("[job:universeRefresh] fatal", { message: err.message });
    pool.end().catch(() => {});
    process.exit(1);
  });
