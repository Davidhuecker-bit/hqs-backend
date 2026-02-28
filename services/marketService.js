"use strict";

const { fetchQuote } = require("./providerService");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const SNAPSHOT_TTL_SECONDS = 60;

// ============================
// TABLE INIT
// ============================

async function ensureTablesExist() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_snapshots (
      symbol TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

// ============================
// CACHE
// ============================

async function getSnapshot(symbol) {
  const res = await pool.query(
    `SELECT data, updated_at FROM market_snapshots WHERE symbol = $1`,
    [symbol]
  );

  if (!res.rows.length) return null;

  const row = res.rows[0];
  const ageSeconds =
    (Date.now() - new Date(row.updated_at).getTime()) / 1000;

  if (ageSeconds > SNAPSHOT_TTL_SECONDS) return null;

  return row.data;
}

async function saveSnapshot(symbol, data) {
  await pool.query(
    `
    INSERT INTO market_snapshots (symbol, data, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (symbol)
    DO UPDATE SET
      data = EXCLUDED.data,
      updated_at = NOW()
    `,
    [symbol, data]
  );
}

// ============================
// MAIN
// ============================

async function getMarketData(symbol) {
  if (!symbol) return [];

  const upperSymbol = String(symbol).toUpperCase();

  const cached = await getSnapshot(upperSymbol);

  if (cached) {
    console.log(`🟢 Cache hit for ${upperSymbol}`);
    return [cached];
  }

  console.log(`🔵 Cache miss for ${upperSymbol}`);

  const fresh = await fetchQuote(upperSymbol);

  if (!fresh || !fresh.length) {
    console.warn(`⚠️ No data for ${upperSymbol}`);
    return [];
  }

  await saveSnapshot(upperSymbol, fresh[0]);

  return fresh;
}

module.exports = {
  getMarketData,
  ensureTablesExist
};
