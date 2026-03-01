"use strict";

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =========================================================
   INIT TABLE (FULL QUANT + SAFE UPGRADE)
========================================================= */

async function initFactorTable() {

  // Basis-Tabelle erstellen falls nicht vorhanden
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

      market_average FLOAT,
      volatility FLOAT,

      forward_return_1h FLOAT,
      forward_return_1d FLOAT,
      forward_return_3d FLOAT,

      portfolio_return FLOAT,
      factors JSONB,

      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  /* =========================================================
     SCHEMA SAFE UPGRADE (für bestehende DBs)
  ========================================================= */

  await pool.query(`ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS momentum FLOAT;`);
  await pool.query(`ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS quality FLOAT;`);
  await pool.query(`ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS stability FLOAT;`);
  await pool.query(`ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS relative FLOAT;`);

  await pool.query(`ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS market_average FLOAT;`);
  await pool.query(`ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS volatility FLOAT;`);

  await pool.query(`ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS forward_return_1h FLOAT;`);
  await pool.query(`ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS forward_return_1d FLOAT;`);
  await pool.query(`ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS forward_return_3d FLOAT;`);

  await pool.query(`ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS portfolio_return FLOAT;`);
  await pool.query(`ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS factors JSONB;`);

  console.log("✅ factor_history ready (FULL QUANT MODE)");
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
  marketAverage,
  volatility
}) {
  try {
    await pool.query(
      `
      INSERT INTO factor_history
      (symbol, hqs_score, momentum, quality, stability, relative, regime,
       market_average, volatility)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `,
      [
        symbol,
        hqsScore,
        momentum ?? null,
        quality ?? null,
        stability ?? null,
        relative ?? null,
        regime,
        marketAverage ?? null,
        volatility ?? null
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
        portfolioReturn ?? null,
        factors ?? null,
      ],
    );
  } catch (err) {
    console.error("❌ saveFactorSnapshot error:", err.message);
  }
}

/* =========================================================
   UPDATE FORWARD RETURNS (LABELING)
========================================================= */

async function updateForwardReturns(symbol, hoursAhead, percentChange) {
  try {
    let column;

    if (hoursAhead === 1) column = "forward_return_1h";
    else if (hoursAhead === 24) column = "forward_return_1d";
    else column = "forward_return_3d";

    await pool.query(
      `
      UPDATE factor_history
      SET ${column} = $1
      WHERE symbol = $2
      AND ${column} IS NULL
      `,
      [percentChange, symbol]
    );

  } catch (err) {
    console.error("❌ updateForwardReturns error:", err.message);
  }
}

/* =========================================================
   LOAD HISTORY (für Calibration / Reinforcement)
========================================================= */

async function loadFactorHistory(limit = 500) {
  try {
    const res = await pool.query(
      `
      SELECT *
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
  updateForwardReturns
};
