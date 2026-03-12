"use strict";

require("dotenv").config();

const { Pool } = require("pg");
const logger = require("../utils/logger");
const { acquireLock, initJobLocksTable } = require("../services/jobLock.repository");
const { collectNewsForSymbols } = require("../services/marketNewsCollector.service");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const LOCK_DURATION_SECONDS = 2 * 60 * 60;

function cleanSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  return symbol.length ? symbol : null;
}

async function loadUniverseSymbols() {
  const result = await pool.query(`
    SELECT symbol
    FROM universe_symbols
    WHERE is_active = TRUE
    ORDER BY priority DESC, symbol ASC
  `);

  return [...new Set(result.rows.map((row) => cleanSymbol(row?.symbol)).filter(Boolean))];
}

async function run() {
  await initJobLocksTable();

  const won = await acquireLock("market_news_refresh_job", LOCK_DURATION_SECONDS);
  if (!won) {
    logger.warn("Market news refresh skipped (lock held)");
    return {
      requestedSymbols: [],
      fetchedItems: 0,
      storedItems: 0,
      failedSymbols: [],
    };
  }

  const symbols = await loadUniverseSymbols();
  if (!symbols.length) {
    logger.warn("Market news refresh skipped (no active universe symbols)");
    return {
      requestedSymbols: [],
      fetchedItems: 0,
      storedItems: 0,
      failedSymbols: [],
    };
  }

  const result = await collectNewsForSymbols(symbols);
  logger.info("Market news refresh job done", {
    universeSymbols: symbols.length,
    ...result,
  });

  return result;
}

async function closePool() {
  await pool.end().catch(() => {});
}

if (require.main === module) {
  (async () => {
    try {
      await run();
      process.exitCode = 0;
    } catch (err) {
      logger.error("Market news refresh job failed", { message: err.message });
      process.exitCode = 1;
    } finally {
      await closePool();
    }
  })();
}

module.exports = {
  run,
  loadUniverseSymbols,
};
