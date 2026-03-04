"use strict";

const { Pool } = require("pg");
let logger = null;
try { logger = require("../utils/logger"); } catch (_) { logger = null; }

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initAdvancedMetricsTable() {
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
      scenarios,
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
  return {
    regime: row.regime ?? null,
    trend: row.trend !== null ? Number(row.trend) : null,
    volatility: row.volatility_annual !== null ? Number(row.volatility_annual) : null,
    volatilityDaily: row.volatility_daily !== null ? Number(row.volatility_daily) : null,
    scenarios: row.scenarios ?? null,
    advancedUpdatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

module.exports = {
  initAdvancedMetricsTable,
  upsertAdvancedMetrics,
  loadAdvancedMetrics,
};
