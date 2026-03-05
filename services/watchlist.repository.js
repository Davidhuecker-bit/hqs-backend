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

  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_watchlist_active
    ON watchlist_symbols(is_active, priority, symbol);
  `);

  if (logger?.info) logger.info("watchlist_symbols ready");
}

function parseSymbolsFromEnv() {
  // Unterstützt: "AAPL,MSFT,NVDA" ODER Zeilen ODER Semikolon
  const raw = String(process.env.SYMBOLS || "").trim();
  if (!raw) return [];

  const parts = raw
    .split(/[\n,;]+/g)
    .map((s) => String(s || "").trim().toUpperCase())
    .filter(Boolean);

  // unique
  return [...new Set(parts)];
}

async function seedDefaultWatchlist() {
  // Wenn schon was drin ist -> nix überschreiben
  const r = await pool.query(`SELECT COUNT(*)::int AS c FROM watchlist_symbols;`);
  if ((r.rows?.[0]?.c ?? 0) > 0) {
    if (logger?.info) logger.info("watchlist already seeded", { count: r.rows[0].c });
    return;
  }

  // 1) Wenn SYMBOLS gesetzt -> nimm die
  const envSymbols = parseSymbolsFromEnv();

  // 2) Fallback
  const defaults = envSymbols.length ? envSymbols : ["AAPL", "MSFT", "NVDA", "AMD"];

  let prio = 10;
  for (const sym of defaults) {
    await pool.query(
      `
      INSERT INTO watchlist_symbols(symbol, is_active, priority, region)
      VALUES ($1, TRUE, $2, 'us')
      ON CONFLICT(symbol) DO NOTHING
      `,
      [sym, prio]
    );
    prio += 10;
  }

  if (logger?.info) logger.info("watchlist seeded", { count: defaults.length, usedEnv: envSymbols.length > 0 });
}

async function getActiveWatchlistSymbols(limit = 250) {
  const lim = Math.max(1, Math.min(Number(limit) || 250, 2000));

  const res = await pool.query(
    `
    SELECT symbol
    FROM watchlist_symbols
    WHERE is_active = TRUE
    ORDER BY priority ASC, symbol ASC
    LIMIT $1
    `,
    [lim]
  );

  return res.rows.map((r) => String(r.symbol).toUpperCase());
}

module.exports = {
  initWatchlistTable,
  seedDefaultWatchlist,
  getActiveWatchlistSymbols,
};
