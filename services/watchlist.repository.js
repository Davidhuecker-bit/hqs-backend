"use strict";

const { Pool } = require("pg");
let logger = null;
try { logger = require("../utils/logger"); } catch (_) { logger = null; }

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initWatchlistTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS watchlist_symbols (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      is_active BOOLEAN DEFAULT TRUE,
      priority INT DEFAULT 100,
      region TEXT DEFAULT 'us',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  if (logger?.info) logger.info("watchlist_symbols ready");
}

async function seedDefaultWatchlist() {
  // Seed nur wenn noch leer
  const res = await pool.query(`SELECT COUNT(*)::int AS c FROM watchlist_symbols;`);
  if ((res.rows?.[0]?.c ?? 0) > 0) return;

  const defaults = [
    ["AAPL", true, 10, "us"],
    ["MSFT", true, 20, "us"],
    ["NVDA", true, 30, "us"],
    ["AMD",  true, 40, "us"],
  ];

  for (const [symbol, is_active, priority, region] of defaults) {
    await pool.query(
      `INSERT INTO watchlist_symbols(symbol, is_active, priority, region)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT(symbol) DO NOTHING`,
      [symbol, is_active, priority, region]
    );
  }

  if (logger?.info) logger.info("watchlist_symbols seeded");
}

async function getActiveWatchlistSymbols(limit = 200) {
  const res = await pool.query(
    `
    SELECT symbol
    FROM watchlist_symbols
    WHERE is_active = TRUE
    ORDER BY priority ASC, symbol ASC
    LIMIT $1
    `,
    [limit]
  );

  return res.rows.map(r => String(r.symbol).toUpperCase());
}

module.exports = {
  initWatchlistTable,
  seedDefaultWatchlist,
  getActiveWatchlistSymbols,
};
