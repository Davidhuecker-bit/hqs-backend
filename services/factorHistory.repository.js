"use strict";

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* =========================================================
   TABLE INIT (Hardened)
========================================================= */

async function initFactorTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS factor_history (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      hqs_score FLOAT,
      momentum FLOAT,
      quality FLOAT,
      volatility_adj FLOAT,
      relative_score FLOAT,
      regime TEXT NOT NULL,
      portfolio_return FLOAT,
      factors JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_factor_symbol
    ON factor_history(symbol);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_factor_created_at
    ON factor_history(created_at);
  `);

  console.log("✅ factor_history table ready");
}

/* =========================================================
   SAVE SINGLE STOCK SNAPSHOT
========================================================= */

async function saveScoreSnapshot({
  symbol,
  hqsScore,
  momentum,
  quality,
  volatilityAdj,
  relative,
  regime
}) {
  if (!symbol) return;

  await pool.query(
    `
    INSERT INTO factor_history
    (symbol, hqs_score, momentum, quality,
     volatility_adj, relative_score, regime)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    `,
    [
      String(symbol).toUpperCase(),
      Number.isFinite(hqsScore) ? hqsScore : null,
      Number.isFinite(momentum) ? momentum : null,
      Number.isFinite(quality) ? quality : null,
      Number.isFinite(volatilityAdj) ? volatilityAdj : null,
      Number.isFinite(relative) ? relative : null,
      regime || "neutral"
    ]
  );
}

/* =========================================================
   SAVE PORTFOLIO SNAPSHOT (Learning Data)
========================================================= */

async function saveFactorSnapshot(regime, portfolioReturn, factors) {
  await pool.query(
    `
    INSERT INTO factor_history
    (symbol, regime, portfolio_return, factors)
    VALUES ($1,$2,$3,$4)
    `,
    [
      "PORTFOLIO",
      regime || "neutral",
      Number.isFinite(portfolioReturn) ? portfolioReturn : 0,
      factors || {}
    ]
  );
}

/* =========================================================
   LOAD HISTORY (GLOBAL)
========================================================= */

async function loadFactorHistory(limit = 500) {
  const res = await pool.query(
    `
    SELECT *
    FROM factor_history
    ORDER BY created_at ASC
    LIMIT $1
    `,
    [limit]
  );

  return res.rows || [];
}

/* =========================================================
   LOAD HISTORY BY SYMBOL
========================================================= */

async function loadSymbolHistory(symbol, limit = 200) {
  if (!symbol) return [];

  const res = await pool.query(
    `
    SELECT *
    FROM factor_history
    WHERE symbol = $1
    ORDER BY created_at ASC
    LIMIT $2
    `,
    [String(symbol).toUpperCase(), limit]
  );

  return res.rows || [];
}

module.exports = {
  initFactorTable,
  saveScoreSnapshot,
  saveFactorSnapshot,
  loadFactorHistory,
  loadSymbolHistory
};
