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
      [regime, weights, performance]
    );
  } catch (err) {
    console.error("❌ saveWeightSnapshot error:", err.message);
  }
}

/* =========================================================
   LOAD LAST WEIGHTS
========================================================= */

async function loadLastWeights(regime = null) {
  try {
    if (regime) {
      const res = await pool.query(
        `
        SELECT weights
        FROM weight_history
        WHERE regime = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [regime]
      );
      if (!res.rows.length) return null;
      return res.rows[0].weights;
    }

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

/* =========================================================
   🚀 PERFORMANCE-BASED REINFORCEMENT LEARNING
   - nutzt factor_history
   - erstellt adaptive weights pro Regime
========================================================= */

async function computeAdaptiveWeights(regime = "neutral") {
  try {
    const res = await pool.query(
      `
      SELECT momentum, quality, stability, relative, hqs_score
      FROM factor_history
      WHERE regime = $1
      ORDER BY created_at DESC
      LIMIT 300
      `,
      [regime]
    );

    if (!res.rows.length) return null;

    const reinforcement = {
      momentum: 0,
      quality: 0,
      stability: 0,
      relative: 0,
    };

    for (const row of res.rows) {
      const performanceSignal = Number(row.hqs_score) || 0;

      reinforcement.momentum += (Number(row.momentum) || 0) * performanceSignal;
      reinforcement.quality += (Number(row.quality) || 0) * performanceSignal;
      reinforcement.stability += (Number(row.stability) || 0) * performanceSignal;
      reinforcement.relative += (Number(row.relative) || 0) * performanceSignal;
    }

    const sum =
      reinforcement.momentum +
      reinforcement.quality +
      reinforcement.stability +
      reinforcement.relative;

    if (!sum) return null;

    const weights = {
      momentum: reinforcement.momentum / sum,
      quality: reinforcement.quality / sum,
      stability: reinforcement.stability / sum,
      relative: reinforcement.relative / sum,
    };

    await saveWeightSnapshot(regime, weights, {
      learningSamples: res.rows.length,
      mode: "reinforcement",
      updatedAt: new Date().toISOString(),
    });

    console.log(`🧠 Adaptive weights updated for ${regime}:`, weights);

    return weights;
  } catch (err) {
    console.error("❌ computeAdaptiveWeights error:", err.message);
    return null;
  }
}

module.exports = {
  initWeightTable,
  saveWeightSnapshot,
  loadLastWeights,
  computeAdaptiveWeights,
};
