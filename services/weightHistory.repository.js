"use strict";

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =========================================================
   INIT TABLE
========================================================= */

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

  console.log("✅ weight_history ready");
}

/* =========================================================
   SAVE WEIGHTS
========================================================= */

async function saveWeightSnapshot(regime, weights, performance) {
  try {
    await pool.query(
      `
      INSERT INTO weight_history (regime, weights, performance)
      VALUES ($1, $2, $3)
      `,
      [regime, weights, performance],
    );
  } catch (err) {
    console.error("❌ saveWeightSnapshot error:", err.message);
  }
}

/* =========================================================
   LOAD LAST WEIGHTS
========================================================= */

async function loadLastWeights() {
  try {
    const res = await pool.query(`
      SELECT weights
      FROM weight_history
      ORDER BY created_at DESC
      LIMIT 1
    `);

    if (!res.rows.length) return null;

    return res.rows[0].weights;
  } catch (err) {
    console.error("❌ loadLastWeights error:", err.message);
    return null;
  }
}

module.exports = {
  initWeightTable,
  saveWeightSnapshot,
  loadLastWeights,
};
