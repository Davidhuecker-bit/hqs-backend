"use strict";

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const RUNTIME_STATE_MARKET_MEMORY_KEY = "market_memory_store";
const RUNTIME_STATE_META_LEARNING_KEY = "meta_learning_store";

/**
 * Init / Migration-safe:
 * - erstellt discovery_history, falls nicht vorhanden
 * - ergänzt fehlende Spalten (7d/30d getrennte Checks)
 * - legt Indexe an
 */
async function initDiscoveryTable() {
  // 1) Basis-Tabelle (neu)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discovery_history (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      discovery_score NUMERIC,
      price_at_discovery NUMERIC,
      created_at TIMESTAMP DEFAULT NOW(),

      -- getrennte Evaluations
      checked_7d BOOLEAN DEFAULT FALSE,
      checked_30d BOOLEAN DEFAULT FALSE,
      return_7d NUMERIC,
      return_30d NUMERIC
    );
  `);

  // 2) Migration, falls deine alte Tabelle schon existiert (mit checked, ohne checked_7d/30d)
  await pool.query(`
    ALTER TABLE discovery_history
      ADD COLUMN IF NOT EXISTS checked_7d BOOLEAN DEFAULT FALSE;
  `);

  await pool.query(`
    ALTER TABLE discovery_history
      ADD COLUMN IF NOT EXISTS checked_30d BOOLEAN DEFAULT FALSE;
  `);

  await pool.query(`
    ALTER TABLE discovery_history
      ADD COLUMN IF NOT EXISTS return_7d NUMERIC;
  `);

  await pool.query(`
    ALTER TABLE discovery_history
      ADD COLUMN IF NOT EXISTS return_30d NUMERIC;
  `);

  // Falls du früher "checked" hattest: wir lassen die Spalte optional existieren, aber nutzen sie nicht mehr aktiv.
  // (Nicht droppen, damit nichts kaputtgeht.)

  // 3) Indexe (Performance)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_discovery_history_created_at
      ON discovery_history(created_at);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_discovery_history_checked7d
      ON discovery_history(checked_7d, created_at);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_discovery_history_checked30d
      ON discovery_history(checked_30d, created_at);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_discovery_history_symbol_created
      ON discovery_history(symbol, created_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS learning_runtime_state (
      key TEXT PRIMARY KEY,
      payload JSONB DEFAULT '{}'::jsonb,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_learning_runtime_state_updated_at
      ON learning_runtime_state(updated_at DESC);
  `);
}

function normalizeStateKey(key) {
  const normalizedKey = String(key || "").trim().toLowerCase();
  return normalizedKey || null;
}

function safeJson(value, fallback = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }

  try {
    if (typeof structuredClone === "function") {
      return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return fallback;
  }
}

async function loadRuntimeState(key) {
  const normalizedKey = normalizeStateKey(key);
  if (!normalizedKey) return {};

  try {
    const res = await pool.query(
      `
      SELECT payload
      FROM learning_runtime_state
      WHERE key = $1
      LIMIT 1
      `,
      [normalizedKey]
    );

    if (!res.rows.length) return {};
    return safeJson(res.rows[0].payload, {});
  } catch (_) {
    return {};
  }
}

async function saveRuntimeState(key, payload = {}) {
  const normalizedKey = normalizeStateKey(key);
  if (!normalizedKey) return;

  await pool.query(
    `
    INSERT INTO learning_runtime_state (key, payload, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET
      payload = EXCLUDED.payload,
      updated_at = NOW()
    `,
    [normalizedKey, JSON.stringify(safeJson(payload, {}))]
  );
}

/**
 * Speichert eine Discovery (immer als "ungeprüft" für 7d/30d)
 */
async function saveDiscovery(symbol, score, price) {
  const sym = String(symbol || "").trim().toUpperCase();
  const s = Number(score);
  const p = Number(price);

  await pool.query(
    `
    INSERT INTO discovery_history
      (symbol, discovery_score, price_at_discovery, checked_7d, checked_30d)
    VALUES
      ($1, $2, $3, FALSE, FALSE)
    `,
    [
      sym,
      Number.isFinite(s) ? s : null,
      Number.isFinite(p) ? p : null,
    ]
  );
}

/**
 * Pending 7D:
 * - älter als 7 Tage
 * - noch nicht 7d gecheckt
 * - braucht price_at_discovery
 */
async function getPendingDiscoveries7d(limit = 50) {
  const lim = Number(limit);
  const res = await pool.query(
    `
    SELECT id, symbol, price_at_discovery, created_at
    FROM discovery_history
    WHERE checked_7d = FALSE
      AND price_at_discovery IS NOT NULL
      AND created_at < NOW() - INTERVAL '7 days'
    ORDER BY created_at ASC
    LIMIT $1
    `,
    [Number.isFinite(lim) && lim > 0 ? lim : 50]
  );

  return res.rows || [];
}

/**
 * Pending 30D:
 * - älter als 30 Tage
 * - noch nicht 30d gecheckt
 * - braucht price_at_discovery
 */
async function getPendingDiscoveries30d(limit = 50) {
  const lim = Number(limit);
  const res = await pool.query(
    `
    SELECT id, symbol, price_at_discovery, created_at
    FROM discovery_history
    WHERE checked_30d = FALSE
      AND price_at_discovery IS NOT NULL
      AND created_at < NOW() - INTERVAL '30 days'
    ORDER BY created_at ASC
    LIMIT $1
    `,
    [Number.isFinite(lim) && lim > 0 ? lim : 50]
  );

  return res.rows || [];
}

/**
 * Update 7D Ergebnis:
 * - setzt return_7d + checked_7d
 */
async function updateDiscoveryResult7d(id, return7d) {
  const rowId = Number(id);
  const r = Number(return7d);
  if (!Number.isFinite(rowId) || rowId <= 0) return;

  await pool.query(
    `
    UPDATE discovery_history
    SET return_7d = $1,
        checked_7d = TRUE
    WHERE id = $2
    `,
    [Number.isFinite(r) ? r : null, rowId]
  );
}

/**
 * Update 30D Ergebnis:
 * - setzt return_30d + checked_30d
 */
async function updateDiscoveryResult30d(id, return30d) {
  const rowId = Number(id);
  const r = Number(return30d);
  if (!Number.isFinite(rowId) || rowId <= 0) return;

  await pool.query(
    `
    UPDATE discovery_history
    SET return_30d = $1,
        checked_30d = TRUE
    WHERE id = $2
    `,
    [Number.isFinite(r) ? r : null, rowId]
  );
}

/**
 * BACKWARD COMPAT (falls irgendwo noch alte Funktionsnamen genutzt werden)
 * -> Diese mappen auf 7D
 */
async function getPendingDiscoveries(limit = 50) {
  return getPendingDiscoveries7d(limit);
}

async function updateDiscoveryResult(id, return7d) {
  return updateDiscoveryResult7d(id, return7d);
}

module.exports = {
  initDiscoveryTable,
  saveDiscovery,
  loadRuntimeState,
  saveRuntimeState,
  RUNTIME_STATE_MARKET_MEMORY_KEY,
  RUNTIME_STATE_META_LEARNING_KEY,

  // neu (sauber)
  getPendingDiscoveries7d,
  getPendingDiscoveries30d,
  updateDiscoveryResult7d,
  updateDiscoveryResult30d,

  // legacy (optional)
  getPendingDiscoveries,
  updateDiscoveryResult,
};
