"use strict";

/*
  MARKET SERVICE
  Snapshot-First Architektur
  DB → API nur wenn nötig
*/

const { fetchQuote } = require("./providerService");
const { Pool } = require("pg");

// ============================
// DATABASE
// ============================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ============================
// CONFIG
// ============================

const SNAPSHOT_TTL_SECONDS = 60; // 60 Sekunden Cache

// ============================
// INIT TABLE
// ============================

async function ensureSnapshotTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_snapshots (
      symbol TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

// ============================
// GET SNAPSHOT
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

  if (ageSeconds > SNAPSHOT_TTL_SECONDS) {
    return null;
  }

  return row.data;
}

// ============================
// SAVE SNAPSHOT
// ============================

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
// MAIN FUNCTION
// ============================

async function getMarketData(symbol) {
  if (!symbol) return [];

  await ensureSnapshotTable();

  const upperSymbol = String(symbol).toUpperCase();

  // 1️⃣ Prüfen ob Snapshot existiert
  const cached = await getSnapshot(upperSymbol);

  if (cached) {
    console.log(`🟢 Cache hit for ${upperSymbol}`);
    return [cached];
  }

  console.log(`🔵 Cache miss for ${upperSymbol} → Fetching API`);

  // 2️⃣ API Call nur wenn nötig
  const fresh = await fetchQuote(upperSymbol);

  if (!fresh || !fresh.length) {
    console.warn(`⚠️ No data returned for ${upperSymbol}`);
    return [];
  }

  // 3️⃣ Snapshot speichern
  await saveSnapshot(upperSymbol, fresh[0]);

  return fresh;
}

module.exports = {
  getMarketData
};
