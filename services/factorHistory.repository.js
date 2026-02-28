"use strict";

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function initFactorTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS factor_history (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMP DEFAULT NOW(),
      regime TEXT NOT NULL,
      portfolio_return FLOAT NOT NULL,
      factors JSONB NOT NULL
    );
  `);
}

async function saveFactorSnapshot(regime, portfolioReturn, factors) {
  await pool.query(
    `
    INSERT INTO factor_history (regime, portfolio_return, factors)
    VALUES ($1, $2, $3)
    `,
    [regime, portfolioReturn, factors]
  );
}

async function loadFactorHistory(limit = 500) {
  const res = await pool.query(
    `
    SELECT regime, portfolio_return as return, factors
    FROM factor_history
    ORDER BY created_at ASC
    LIMIT $1
    `,
    [limit]
  );

  return res.rows.map(r => ({
    regime: r.regime,
    return: r.return,
    factors: r.factors
  }));
}

module.exports = {
  initFactorTable,
  saveFactorSnapshot,
  loadFactorHistory
};
