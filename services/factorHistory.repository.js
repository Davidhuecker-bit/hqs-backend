"use strict";

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/* =========================================================
   TABLE INIT
========================================================= */

async function initFactorTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS factor_history (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      hqs_score FLOAT NOT NULL,
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
}

/* =========================================================
   SAVE SINGLE STOCK SNAPSHOT (HQS)
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
  await pool.query(
    `
    INSERT INTO factor_history
    (symbol, hqs_score, momentum, quality, volatility_adj,
     relative_score, regime)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    `,
    [
      symbol,
      hqsScore,
      momentum,
      quality,
      volatilityAdj,
      relative,
      regime
    ]
  );
}

/* =========================================================
   SAVE PORTFOLIO SNAPSHOT
========================================================= */

async function saveFactorSnapshot(regime, portfolioReturn, factors) {
  await pool.query(
    `
    INSERT INTO factor_history
    (symbol, hqs_score, regime, portfolio_return, factors)
    VALUES ($1,$2,$3,$4,$5)
    `,
    [
      "PORTFOLIO",
      0,
      regime,
      portfolioReturn,
      factors
    ]
  );
}

/* =========================================================
   LOAD HISTORY
========================================================= */

async function loadFactorHistory(limit = 500) {
  const res = await pool.query(
    `
    SELECT symbol,
           hqs_score,
           momentum,
           quality,
           volatility_adj,
           relative_score,
           regime,
           portfolio_return,
           factors,
           created_at
    FROM factor_history
    ORDER BY created_at ASC
    LIMIT $1
    `,
    [limit]
  );

  return res.rows;
}

/* =========================================================
   LOAD HISTORY BY SYMBOL
========================================================= */

async function loadSymbolHistory(symbol, limit = 200) {
  const res = await pool.query(
    `
    SELECT *
    FROM factor_history
    WHERE symbol = $1
    ORDER BY created_at ASC
    LIMIT $2
    `,
    [symbol, limit]
  );

  return res.rows;
}

module.exports = {
  initFactorTable,
  saveScoreSnapshot,
  saveFactorSnapshot,
  loadFactorHistory,
  loadSymbolHistory
};
