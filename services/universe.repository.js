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

    if (!values.length) continue;

    const sql = `
      INSERT INTO universe_symbols
        (symbol, name, exchange, type, country, currency, is_active, priority, updated_at)
      VALUES
        ${values.join(",\n")}
      ON CONFLICT (symbol) DO UPDATE SET
        name = EXCLUDED.name,
        exchange = EXCLUDED.exchange,
        type = EXCLUDED.type,
        country = EXCLUDED.country,
        currency = EXCLUDED.currency,
        is_active = EXCLUDED.is_active,
        priority = EXCLUDED.priority,
        updated_at = NOW()
    `;

    await pool.query(sql, params);
    total += values.length;
  }

  return { insertedOrUpdated: total };
}

async function getCursor(key = CURSOR_KEY_SNAPSHOT) {
  const res = await pool.query(
    `SELECT cursor FROM universe_scan_state WHERE key = $1 LIMIT 1`,
    [key]
  );
  if (!res.rows.length) return 0;
  const c = Number(res.rows[0].cursor);
  return Number.isFinite(c) && c >= 0 ? c : 0;
}

async function setCursor(cursor, key = CURSOR_KEY_SNAPSHOT) {
  const c = Number(cursor);
  const safe = Number.isFinite(c) && c >= 0 ? c : 0;
  await pool.query(
    `INSERT INTO universe_scan_state (key, cursor, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = NOW()`,
    [key, safe]
  );
}

async function countActiveUniverse() {
  const res = await pool.query(
    `SELECT COUNT(*)::bigint AS c FROM universe_symbols WHERE is_active = TRUE`
  );
  const n = Number(res.rows?.[0]?.c ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Get next batch of active symbols, using OFFSET cursor.
 * If end reached, cursor resets to 0 and batch starts from beginning.
 */
async function getUniverseBatch(limit = 150, key = CURSOR_KEY_SNAPSHOT) {
  const lim = Number(limit);
  const safeLimit = Number.isFinite(lim) && lim > 0 ? Math.min(lim, 500) : 150;

  let cursor = await getCursor(key);

  async function fetchBatch(offset) {
    const res = await pool.query(
      `
      SELECT symbol
      FROM universe_symbols
      WHERE is_active = TRUE
      ORDER BY priority DESC, symbol ASC
      LIMIT $1 OFFSET $2
      `,
      [safeLimit, offset]
    );
    return res.rows.map((r) => String(r.symbol).toUpperCase());
  }

  let symbols = await fetchBatch(cursor);

  // If we hit the end, wrap around
  if (!symbols.length && cursor > 0) {
    cursor = 0;
    symbols = await fetchBatch(cursor);
  }

  const nextCursor = cursor + symbols.length;
  await setCursor(nextCursor, key);

  return { symbols, cursor, nextCursor };
}

module.exports = {
  CURSOR_KEY_SNAPSHOT,
  initUniverseTables,
  upsertUniverseSymbols,
  countActiveUniverse,
  getUniverseBatch,
  getCursor,
  setCursor,
};
