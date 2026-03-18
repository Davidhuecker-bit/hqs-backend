"use strict";

const { Pool } = require("pg");
let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/**
 * JSONB Safety:
 * - entfernt undefined
 * - verhindert crash bei nicht-serialisierbaren Werten
 */
function safeJson(value) {
  if (value === undefined) return null;
  if (value === null) return null;

  try {
    // JSON stringify/parse macht es "clean"
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return null;
  }
}

async function initAdvancedMetricsTable() {
  // ── market_advanced_metrics ───────────────────────────────────────────────
  // All required columns (regime, trend, volatility_annual, volatility_daily,
  // scenarios, updated_at) are defined inline in CREATE TABLE so that
  // ALTER TABLE ADD COLUMN migrations are never needed at runtime.
  //
  // IMPORTANT: Do NOT add ALTER TABLE ... ADD COLUMN statements here.
  // ALTER TABLE acquires an AccessExclusiveLock on the table, even when the
  // column already exists (IF NOT EXISTS only skips the write, not the lock).
  // Running these on every startup causes lock-contention hangs when
  // HQS-Backend and hqs-scraping-service start concurrently.
  if (logger?.info) logger.info("[advancedMetrics] initAdvancedMetricsTable: CREATE TABLE start");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_advanced_metrics (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      regime TEXT,
      trend FLOAT,
      volatility_annual FLOAT,
      volatility_daily FLOAT,
      scenarios JSONB,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  if (logger?.info) logger.info("[advancedMetrics] initAdvancedMetricsTable: CREATE TABLE ok");

  // Index (optional, aber hilft)
  if (logger?.info) logger.info("[advancedMetrics] initAdvancedMetricsTable: INDEX start");
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_market_advanced_metrics_symbol
    ON market_advanced_metrics(symbol);
  `);
  if (logger?.info) logger.info("[advancedMetrics] initAdvancedMetricsTable: INDEX ok");

  if (logger?.info) logger.info("market_advanced_metrics ready");
}

async function upsertAdvancedMetrics(symbol, payload) {
  const sym = String(symbol || "").toUpperCase();

  const {
    regime = null,
    trend = null,
    volatilityAnnual = null,
    volatilityDaily = null,
    scenarios = null,
  } = payload || {};

  const cleanScenarios = safeJson(scenarios);

  await pool.query(
    `
    INSERT INTO market_advanced_metrics
      (symbol, regime, trend, volatility_annual, volatility_daily, scenarios, updated_at)
    VALUES
      ($1,$2,$3,$4,$5,$6,NOW())
    ON CONFLICT(symbol) DO UPDATE SET
      regime = EXCLUDED.regime,
      trend = EXCLUDED.trend,
      volatility_annual = EXCLUDED.volatility_annual,
      volatility_daily = EXCLUDED.volatility_daily,
      scenarios = EXCLUDED.scenarios,
      updated_at = NOW()
    `,
    [
      sym,
      regime,
      trend,
      volatilityAnnual,
      volatilityDaily,
      cleanScenarios,
    ]
  );

  if (logger?.info) logger.info("advanced metrics upserted", { symbol: sym, regime });
}

async function loadAdvancedMetrics(symbol) {
  const sym = String(symbol || "").toUpperCase();

  const res = await pool.query(
    `
    SELECT regime, trend, volatility_annual, volatility_daily, scenarios, updated_at
    FROM market_advanced_metrics
    WHERE symbol = $1
    `,
    [sym]
  );

  if (!res.rows.length) return null;

  const row = res.rows[0];

  const volAnnual = row.volatility_annual !== null ? Number(row.volatility_annual) : null;
  const volDaily = row.volatility_daily !== null ? Number(row.volatility_daily) : null;

  return {
    regime: row.regime ?? null,
    trend: row.trend !== null ? Number(row.trend) : null,

    // ✅ bestehendes Feld (frontend-friendly)
    volatility: volAnnual,

    // ✅ neue Aliase (falls du später genauer nutzen willst)
    volatilityAnnual: volAnnual,
    volatilityDaily: volDaily,

    scenarios: row.scenarios ?? null,
    advancedUpdatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

module.exports = {
  initAdvancedMetricsTable,
  upsertAdvancedMetrics,
  loadAdvancedMetrics,
};
