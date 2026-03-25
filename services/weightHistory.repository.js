"use strict";

const { upsertDynamicWeight } = require("./causalMemory.repository");

// optional logger (falls vorhanden)
let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

const { getSharedPool } = require("../config/database");
const pool = getSharedPool();
/* =========================================================
   REGIME NORMALIZATION
========================================================= */

function normalizeRegime(regime) {
  const r = String(regime || "").trim().toLowerCase();

  // from advanced regime engine
  if (r === "bullish") return "bull";
  if (r === "bearish") return "bear";
  if (r === "neutral") return "neutral";

  // internal accepted
  if (["expansion", "bull", "bear", "crash", "neutral"].includes(r)) return r;

  // default
  return "neutral";
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

  if (logger?.info) logger.info("weight_history ready");
  else console.log("✅ weight_history ready");
}

/* =========================================================
   SAVE WEIGHTS
========================================================= */

async function saveWeightSnapshot(regime, weights, performance) {
  const normalizedRegime = normalizeRegime(regime);

  try {
    await pool.query(
      `
      INSERT INTO weight_history (regime, weights, performance)
      VALUES ($1, $2, $3)
      `,
      [normalizedRegime, weights, performance]
    );
  } catch (err) {
    if (logger?.error) logger.error("saveWeightSnapshot error", { message: err.message });
    else console.error("❌ saveWeightSnapshot error:", err.message);
  }
}

/* =========================================================
   LOAD LAST WEIGHTS
   - tries regime-specific first
   - falls back to latest global
========================================================= */

async function loadLastWeights(regime = null) {
  try {
    const normalizedRegime = regime ? normalizeRegime(regime) : null;

    if (normalizedRegime) {
      const res = await pool.query(
        `
        SELECT weights
        FROM weight_history
        WHERE regime = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [normalizedRegime]
      );

      if (res.rows.length) return res.rows[0].weights;
      // fallback to global if none found for regime
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
    if (logger?.error) logger.error("loadLastWeights error", { message: err.message });
    else console.error("❌ loadLastWeights error:", err.message);
    return null;
  }
}

/* =========================================================
   🚀 PERFORMANCE-BASED REINFORCEMENT LEARNING
   - uses factor_history
   - creates adaptive weights per regime
   Notes:
   - If there are no samples for the given regime, fallback to neutral, then global.
========================================================= */

async function computeAdaptiveWeights(regime = "neutral") {
  const normalizedRegime = normalizeRegime(regime);

  try {
    // 1) try requested regime
    let res = await pool.query(
      `
      SELECT momentum, quality, stability, relative, hqs_score
      FROM factor_history
      WHERE regime = $1
      ORDER BY created_at DESC
      LIMIT 300
      `,
      [normalizedRegime]
    );

    // 2) fallback to neutral if empty and not already neutral
    if (!res.rows.length && normalizedRegime !== "neutral") {
      res = await pool.query(
        `
        SELECT momentum, quality, stability, relative, hqs_score
        FROM factor_history
        WHERE regime = 'neutral'
        ORDER BY created_at DESC
        LIMIT 300
        `
      );
    }

    // 3) fallback to global (no regime filter)
    if (!res.rows.length) {
      res = await pool.query(
        `
        SELECT momentum, quality, stability, relative, hqs_score
        FROM factor_history
        ORDER BY created_at DESC
        LIMIT 300
        `
      );
    }

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

    const learningSamples = res.rows.length;

    await saveWeightSnapshot(normalizedRegime, weights, {
      learningSamples,
      mode: "reinforcement",
      updatedAt: new Date().toISOString(),
      usedRegime: normalizedRegime,
    });

    // ── Mirror current factor weights to dynamic_weights (live state) ──
    try {
      const factors = ["momentum", "quality", "stability", "relative"];
      let mirrored = 0;
      for (const f of factors) {
        await upsertDynamicWeight(
          `FACTOR_${f.toUpperCase()}`,
          Number(weights[f].toFixed(4)),
          learningSamples
        );
        mirrored++;
      }
      if (logger?.info) {
        logger.info("dynamic_weights: factor weights mirrored", {
          mirrored,
          regime: normalizedRegime,
          source: "factor_history",
          sampleSize: learningSamples,
          weights,
        });
      }
    } catch (mirrorErr) {
      if (logger?.warn) logger.warn("dynamic_weights: factor mirror failed (non-fatal)", { message: mirrorErr.message });
    }

    if (logger?.info) logger.info("Adaptive weights updated", { regime: normalizedRegime, weights });
    else console.log(`🧠 Adaptive weights updated for ${normalizedRegime}:`, weights);

    return weights;
  } catch (err) {
    if (logger?.error) logger.error("computeAdaptiveWeights error", { message: err.message });
    else console.error("❌ computeAdaptiveWeights error:", err.message);
    return null;
  }
}

module.exports = {
  initWeightTable,
  saveWeightSnapshot,
  loadLastWeights,
  computeAdaptiveWeights,
  normalizeRegime, // export for reuse if needed
};
