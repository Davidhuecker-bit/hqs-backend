"use strict";

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initWeightTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS weight_history (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMP DEFAULT NOW(),
      regime TEXT NOT NULL,
      weights JSONB NOT NULL,
      performance JSONB NOT NULL
    );
  `);
}

async function saveWeightSnapshot(regime, weights, performance) {
  await pool.query(
    `
    INSERT INTO weight_history (regime, weights, performance)
    VALUES ($1, $2, $3)
    `,
    [regime, weights, performance]
  );
}

async function loadLastWeights() {
  const res = await pool.query(`
    SELECT weights FROM weight_history
    ORDER BY created_at DESC
    LIMIT 1
  `);

  if (!res.rows.length) return null;
  return res.rows[0].weights;
}

module.exports = {
  initWeightTable,
  saveWeightSnapshot,
  loadLastWeights
};
