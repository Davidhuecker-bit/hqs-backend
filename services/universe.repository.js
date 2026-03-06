"use strict";

// services/universe.repository.js
// Universe = Symbol-Liste (Telefonbuch)
// - 1x täglich per Provider (z.B. FMP) refreshen
// - Scanner zieht batchweise Symbole aus DB (Cursor) -> schützt vor API Limits

const { Pool } = require("pg");
const logger = require("../utils/logger");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Cursor Keys
const CURSOR_KEY_SNAPSHOT = "snapshot_scanner_cursor";

async function initUniverseTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS universe_symbols (
      id SERIAL PRIMARY KEY,
      symbol TEXT UNIQUE NOT NULL,
      name TEXT,
      exchange TEXT,
      type TEXT,
      country TEXT,
      currency TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      priority INT DEFAULT 1,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_universe_symbols_active
      ON universe_symbols (is_active);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_universe_symbols_priority
      ON universe_symbols (priority);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS universe_scan_state (
      key TEXT PRIMARY KEY,
      cursor BIGINT DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // ensure default cursor row exists
  await pool.query(
    `INSERT INTO universe_scan_state (key, cursor)
     VALUES ($1, 0)
     ON CONFLICT (key) DO NOTHING`,
    [CURSOR_KEY_SNAPSHOT]
  );

  logger.info("Universe tables ensured");
}

function cleanText(v) {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}

function cleanSymbol(v) {
  const s = String(v ?? "").trim().toUpperCase();
  return s.length ? s : null;
}

/**
 * Upsert many symbols in chunks.
 * Each item can have: symbol,name,exchange,type,country,currency,is_active,priority
 */
async function upsertUniverseSymbols(items, chunkSize = 500) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return { insertedOrUpdated: 0 };

  let total = 0;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);

    const values = [];
    const params = [];
    let p = 1;

    for (const it of chunk) {
      const symbol = cleanSymbol(it.symbol);
      if (!symbol) continue;

      values.push(
        `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, NOW())`
      );
      params.push(
        symbol,
        cleanText(it.name),
        cleanText(it.exchange),
        cleanText(it.type),
        cleanText(it.country),
        cleanText(it.currency),
        typeof it.is_active === "boolean" ? it.is_active : true,
        Number.isFinite(Number(it.priority)) ? Number(it.priority) : 1
      );
    }
