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

/* =========================================================
   TABLE INIT (AUTO)
========================================================= */

async function ensureDiscoveryTablesExist() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discovery_history (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      discovered_on DATE NOT NULL DEFAULT CURRENT_DATE,

      discovery_score NUMERIC,
      confidence INTEGER,
      reason TEXT,

      regime TEXT,
      hqs_score NUMERIC,

      price_at_discovery NUMERIC,

      checked BOOLEAN NOT NULL DEFAULT FALSE,
      return_7d NUMERIC,
      return_30d NUMERIC,

      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  // Ein Symbol nur 1x pro Tag speichern
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_discovery_history_symbol_day
    ON discovery_history(symbol, discovered_on);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_discovery_history_checked_created
    ON discovery_history(checked, created_at);
  `);

  if (logger?.info) logger.info("discovery_history ready");
}

/* =========================================================
   HELPERS
========================================================= */

function calculateDiscoveryScore(row) {
  const hqs = Number(row.hqs_score || 0);
  const momentum = Number(row.momentum || 0);
  const relative = Number(row.relative || 0);
  const trend = Number(row.trend || 0);
  const volatility = Number(row.volatility || 0);

  let score =
    hqs * 0.5 +
    momentum * 15 +
    relative * 10 +
    trend * 20 -
    volatility * 5;

  return Number(score.toFixed(2));
}

function generateReason(row) {
  const reasons = [];

  if (Number(row.momentum) > 0.7) reasons.push("Momentum breakout");
  if (Number(row.relative) > 0.7) reasons.push("Market outperformance");
  if (Number(row.trend) > 0.6) reasons.push("Strong trend");

  if (!reasons.length) reasons.push("Improving fundamentals");

  return reasons.join(" + ");
}

async function getCurrentPrice(symbol) {
  const res = await pool.query(
    `
    SELECT price
    FROM market_snapshots
    WHERE symbol = $1
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [symbol]
  );

  if (!res.rows.length) return null;

  const p = Number(res.rows[0].price);
  return Number.isFinite(p) ? p : null;
}

async function saveDiscovery(payload) {
  const symbol = String(payload?.symbol || "").trim().toUpperCase();
  if (!symbol) return;

  const discoveryScore = Number(payload?.discoveryScore);
  const confidence = Number(payload?.confidence);
  const reason = String(payload?.reason || "");
  const regime = payload?.regime ? String(payload.regime) : null;
  const hqsScore = Number(payload?.hqsScore);

  const priceNow = await getCurrentPrice(symbol);

  // Speichere pro Tag nur einmal je Symbol (Upsert)
  await pool.query(
    `
    INSERT INTO discovery_history
      (symbol, discovered_on, discovery_score, confidence, reason, regime, hqs_score, price_at_discovery)
    VALUES
      ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7)
    ON CONFLICT(symbol, discovered_on) DO UPDATE SET
      discovery_score = EXCLUDED.discovery_score,
      confidence      = EXCLUDED.confidence,
      reason          = EXCLUDED.reason,
      regime          = EXCLUDED.regime,
      hqs_score       = EXCLUDED.hqs_score,
      price_at_discovery = COALESCE(EXCLUDED.price_at_discovery, discovery_history.price_at_discovery)
    `,
    [
      symbol,
      Number.isFinite(discoveryScore) ? discoveryScore : null,
      Number.isFinite(confidence) ? confidence : null,
      reason || null,
      regime,
      Number.isFinite(hqsScore) ? hqsScore : null,
      Number.isFinite(priceNow) ? priceNow : null,
    ]
  );
}

/* =========================================================
   MAIN: DISCOVER
========================================================= */

async function discoverStocks(limit = 10) {
  await ensureDiscoveryTablesExist();

  const result = await pool.query(`
    SELECT
      symbol,
      hqs_score,
      momentum,
      relative,
      trend,
      volatility,
      regime
    FROM market_advanced_metrics
    ORDER BY trend DESC
    LIMIT 100
  `);

  const rows = result.rows || [];

  const discoveries = rows.map((row) => {
    const discoveryScore = calculateDiscoveryScore(row);

    return {
      symbol: row.symbol,
      regime: row.regime,
      hqsScore: Number(row.hqs_score || 0),
      discoveryScore,
      confidence: Math.min(100, Math.max(0, Math.round(discoveryScore * 0.9))),
      reason: generateReason(row),
    };
  });

  discoveries.sort((a, b) => b.discoveryScore - a.discoveryScore);

  const top = discoveries.slice(0, limit);

  // ✅ SAVE to DB (discovery_history)
  for (const d of top) {
    try {
      await saveDiscovery(d);
    } catch (e) {
      if (logger?.warn) logger.warn("saveDiscovery failed", { symbol: d.symbol, message: e.message });
    }
  }

  if (logger?.info) logger.info("discoverStocks done", { limit, saved: top.length });

  return top;
}

module.exports = {
  discoverStocks,
};
