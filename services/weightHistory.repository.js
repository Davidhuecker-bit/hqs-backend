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
   LOAD LAST WEIGHTS
   Reads FACTOR_* rows from dynamic_weights (the live canonical
   store) instead of the decommissioned weight_history table.
========================================================= */

async function loadLastWeights() {
  try {
    const res = await pool.query(`
      SELECT agent_name, weight
      FROM dynamic_weights
      WHERE agent_name IN (
        'FACTOR_MOMENTUM', 'FACTOR_QUALITY',
        'FACTOR_STABILITY', 'FACTOR_RELATIVE'
      )
    `);

    if (!res.rows.length) return null;

    const weights = {};
    for (const row of res.rows) {
      // agent_name is one of FACTOR_MOMENTUM / FACTOR_QUALITY / FACTOR_STABILITY / FACTOR_RELATIVE
      const match = String(row.agent_name).match(/^FACTOR_([A-Z]+)$/);
      if (!match) continue;
      const factor = match[1].toLowerCase();
      weights[factor] = Number(row.weight);
    }

    const required = ["momentum", "quality", "stability", "relative"];
    if (required.some((k) => !Number.isFinite(weights[k]))) return null;

    return weights;
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
  loadLastWeights,
  computeAdaptiveWeights,
  normalizeRegime,
};
