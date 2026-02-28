"use strict";

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
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
}

/* =========================================================
   SAVE SNAPSHOT
========================================================= */

async function saveWeightSnapshot(regime, weights, performance) {
  try {
    const normalized = normalizeWeights(weights);

    await pool.query(
      `
      INSERT INTO weight_history (regime, weights, performance)
      VALUES ($1, $2, $3)
      `,
      [regime, normalized, performance]
    );
  } catch (err) {
    console.error("Weight snapshot save failed:", err.message);
  }
}

/* =========================================================
   LOAD LAST WEIGHTS (DEFENSIVE)
========================================================= */

async function loadLastWeights() {
  try {
    const res = await pool.query(`
      SELECT weights FROM weight_history
      ORDER BY created_at DESC
      LIMIT 1
    `);

    if (!res.rows.length) return null;

    const weights = res.rows[0].weights;

    if (!isValidWeights(weights)) {
      console.warn("Invalid weights found in DB. Falling back.");
      return null;
    }

    return normalizeWeights(weights);

  } catch (err) {
    console.error("Weight load failed:", err.message);
    return null;
  }
}

/* =========================================================
   VALIDATION
========================================================= */

function isValidWeights(w) {
  if (!w || typeof w !== "object") return false;

  const required = ["momentum", "quality", "stability", "relative"];

  for (const key of required) {
    if (typeof w[key] !== "number") return false;
  }

  return true;
}

/* =========================================================
   NORMALIZATION
========================================================= */

function normalizeWeights(w) {
  const safe = {
    momentum: Number(w.momentum) || 0,
    quality: Number(w.quality) || 0,
    stability: Number(w.stability) || 0,
    relative: Number(w.relative) || 0
  };

  const sum =
    safe.momentum +
    safe.quality +
    safe.stability +
    safe.relative;

  if (sum === 0) {
    return {
      momentum: 0.25,
      quality: 0.25,
      stability: 0.25,
      relative: 0.25
    };
  }

  return {
    momentum: safe.momentum / sum,
    quality: safe.quality / sum,
    stability: safe.stability / sum,
    relative: safe.relative / sum
  };
}

module.exports = {
  initWeightTable,
  saveWeightSnapshot,
  loadLastWeights
};
