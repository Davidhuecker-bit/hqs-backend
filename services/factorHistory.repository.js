"use strict";

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =========================================================
   INIT TABLE
========================================================= */

async function initFactorTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS factor_history (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      hqs_score FLOAT NOT NULL,

      momentum FLOAT,
      quality FLOAT,
      stability FLOAT,
      relative FLOAT,

      regime TEXT NOT NULL,

      portfolio_return FLOAT,
      factors JSONB,

      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log("✅ factor_history ready");
}

/* =========================================================
   SAVE SINGLE STOCK SNAPSHOT
========================================================= */

async function saveScoreSnapshot({
  symbol,
  hqsScore,
  momentum,
  quality,
  stability,
  relative,
  regime,
}) {
  try {
    await pool.query(
      `
      INSERT INTO factor_history
      (symbol, hqs_score, momentum, quality, stability, relative, regime)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      `,
      [
        symbol,
        hqsScore,
        momentum,
        quality,
        stability,
        relative,
        regime,
      ],
    );
  } catch (err) {
    console.error("❌ saveScoreSnapshot error:", err.message);
  }
}

/* =========================================================
   SAVE PORTFOLIO SNAPSHOT (Learning)
========================================================= */

async function saveFactorSnapshot(regime, portfolioReturn, factors) {
  try {
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
        factors,
      ],
    );
  } catch (err) {
    console.error("❌ saveFactorSnapshot error:", err.message);
  }
}

/* =========================================================
   LOAD HISTORY (for calibration)
========================================================= */

async function loadFactorHistory(limit = 500) {
  try {
    const res = await pool.query(
      `
      SELECT symbol,
             hqs_score,
             momentum,
             quality,
             stability,
             relative,
             regime,
             portfolio_return,
             factors,
             created_at
      FROM factor_history
      ORDER BY created_at ASC
      LIMIT $1
      `,
      [limit],
    );

    return res.rows;
  } catch (err) {
    console.error("❌ loadFactorHistory error:", err.message);
    return [];
  }
}

module.exports = {
  initFactorTable,
  saveScoreSnapshot,
  saveFactorSnapshot,
  loadFactorHistory,
};
