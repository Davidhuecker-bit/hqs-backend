"use strict";

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =========================================================
   HELPERS
========================================================= */

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeWeights(weights) {
  const w = {
    momentum: safeNumber(weights?.momentum, 0),
    quality: safeNumber(weights?.quality, 0),
    stability: safeNumber(weights?.stability, 0),
    relative: safeNumber(weights?.relative, 0),
  };

  const sum = w.momentum + w.quality + w.stability + w.relative;

  if (!sum) {
    // Default = gleichmäßig, falls DB Müll liefert
    return {
      momentum: 0.25,
      quality: 0.25,
      stability: 0.25,
      relative: 0.25,
    };
  }

  return {
    momentum: w.momentum / sum,
    quality: w.quality / sum,
    stability: w.stability / sum,
    relative: w.relative / sum,
  };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

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
    const normalized = normalizeWeights(weights);

    await pool.query(
      `
      INSERT INTO weight_history (regime, weights, performance)
      VALUES ($1, $2, $3)
      `,
      [String(regime || "neutral"), normalized, performance || {}]
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
        [String(regime)]
      );

      if (!res.rows.length) return null;
      return normalizeWeights(res.rows[0].weights);
    }

    // Fallback: letzter globaler Eintrag (egal welches Regime)
    const res = await pool.query(`
      SELECT weights
      FROM weight_history
      ORDER BY created_at DESC
      LIMIT 1
    `);

    if (!res.rows.length) return null;

    return normalizeWeights(res.rows[0].weights);
  } catch (err) {
    console.error("❌ loadLastWeights error:", err.message);
    return null;
  }
}

/* =========================================================
   🚀 PERFORMANCE-BASED REINFORCEMENT LEARNING
   - Nutzt factor_history + forward_return Labels
   - Erzeugt neue Weights je Regime
========================================================= */

async function computeAdaptiveWeights(regime = "neutral") {
  try {
    // Wir nutzen forward_return_1d primär, fallback 3d wenn 1d null ist
    const res = await pool.query(
      `
      SELECT
        momentum,
        quality,
        stability,
        relative,
        hqs_score,
        forward_return_1d,
        forward_return_3d,
        created_at
      FROM factor_history
      WHERE regime = $1
      ORDER BY created_at DESC
      LIMIT 400
      `,
      [String(regime)]
    );

    if (!res.rows.length) return null;

    // Reinforcement = Faktorwert * Outcome
    // Outcome = forward_return (besser) sonst hqs_score als schwacher Proxy
    const reinforcement = {
      momentum: 0,
      quality: 0,
      stability: 0,
      relative: 0,
    };

    let labeled = 0;

    for (const row of res.rows) {
      const m = safeNumber(row.momentum, 0);
      const q = safeNumber(row.quality, 0);
      const s = safeNumber(row.stability, 0);
      const r = safeNumber(row.relative, 0);

      const fr1d = row.forward_return_1d;
      const fr3d = row.forward_return_3d;

      // outcome:
      // - wenn forward labels vorhanden: nutzen wir die (stärker)
      // - sonst: hqs_score als schwacher Proxy (damit früh schon gelernt wird)
      let outcome;
      if (fr1d !== null && fr1d !== undefined) {
        outcome = safeNumber(fr1d, 0);
        labeled++;
      } else if (fr3d !== null && fr3d !== undefined) {
        outcome = safeNumber(fr3d, 0);
        labeled++;
      } else {
        // Proxy: score um 50 zentrieren
        outcome = (safeNumber(row.hqs_score, 50) - 50) / 10;
      }

      reinforcement.momentum += m * outcome;
      reinforcement.quality += q * outcome;
      reinforcement.stability += s * outcome;
      reinforcement.relative += r * outcome;
    }

    // Wir wollen positive Beiträge bevorzugen – negatives darf nicht komplett alles kippen:
    // shift: falls alles negativ -> trotzdem normalisierbar
    const shifted = {
      momentum: clamp(reinforcement.momentum, -1e9, 1e9),
      quality: clamp(reinforcement.quality, -1e9, 1e9),
      stability: clamp(reinforcement.stability, -1e9, 1e9),
      relative: clamp(reinforcement.relative, -1e9, 1e9),
    };

    // Absolutwerte zum Normalisieren (robust)
    const sumAbs =
      Math.abs(shifted.momentum) +
      Math.abs(shifted.quality) +
      Math.abs(shifted.stability) +
      Math.abs(shifted.relative);

    if (!sumAbs) return null;

    let weights = {
      momentum: Math.abs(shifted.momentum) / sumAbs,
      quality: Math.abs(shifted.quality) / sumAbs,
      stability: Math.abs(shifted.stability) / sumAbs,
      relative: Math.abs(shifted.relative) / sumAbs,
    };

    // Hard bounds (damit nie extrem)
    weights = {
      momentum: clamp(weights.momentum, 0.05, 0.60),
      quality: clamp(weights.quality, 0.05, 0.60),
      stability: clamp(weights.stability, 0.05, 0.60),
      relative: clamp(weights.relative, 0.05, 0.60),
    };

    weights = normalizeWeights(weights);

    await saveWeightSnapshot(regime, weights, {
      mode: "reinforcement",
      learningSamples: res.rows.length,
      labeledSamples: labeled,
      usedForward: labeled > 0,
      updatedAt: new Date().toISOString(),
    });

    console.log(`🧠 Adaptive weights updated for ${regime}:`, weights);

    return weights;
  } catch (err) {
    console.error("❌ computeAdaptiveWeights error:", err.message);
    return null;
  }
}

/* =========================================================
   RUN FOR ALL REGIMES
========================================================= */

async function computeAdaptiveWeightsAll() {
  const regimes = ["neutral", "bull", "bear", "expansion", "crash"];
  const results = {};

  for (const r of regimes) {
    const w = await computeAdaptiveWeights(r);
    if (w) results[r] = w;
  }

  return results;
}

module.exports = {
  initWeightTable,
  saveWeightSnapshot,
  loadLastWeights,
  computeAdaptiveWeights,
  computeAdaptiveWeightsAll,
};
