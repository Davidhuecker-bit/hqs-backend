"use strict";

/*
  Causal Memory Repository  –  Recursive Meta-Learning
  ------------------------------------------------------
  After a signal's forecast window closes (48 h), the system automatically
  evaluates the gap between each agent's prediction and market reality.

  Result: the three agents' relative influence (their "weight") is adjusted
  in the `dynamic_weights` table so that the most accurate agents gain more
  say in future debates.

  Weight adjustment rules
  -----------------------
  • A correct forecast increases the agent's weight by LEARN_STEP.
  • An incorrect forecast decreases it by LEARN_STEP.
  • Weights are clamped to [WEIGHT_MIN, WEIGHT_MAX] and are normalised so
    that the three weights sum to 1.0 after every update cycle.
  • The adjustment looks at all forecasts verified during the last
    REVIEW_WINDOW_HOURS hours that were at least 48 h old.

  The adjusted weights are persisted and returned by getAgentWeights(),
  which is called by runAgenticDebate() to scale each agent's influence.

  Meta-Rationale helper
  ---------------------
  buildMetaRationale(symbol) returns a short German sentence (or null)
  describing a previous mistake for the given symbol that can be prepended
  to the debate summary.
*/

const { Pool } = require("pg");
const logger = require("../utils/logger");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =========================================================
   CONSTANTS
========================================================= */

const AGENTS = ["GROWTH_BIAS", "RISK_SKEPTIC", "MACRO_JUDGE"];

// How much a correct / incorrect forecast changes the weight
const LEARN_STEP = 0.05;

// Clamp boundaries for individual agent weights (before normalisation)
const WEIGHT_MIN = 0.10;
const WEIGHT_MAX = 0.60;

// Default equal weights
const DEFAULT_WEIGHT = parseFloat((1 / AGENTS.length).toFixed(4));

// Only look at forecasts verified in the last N hours during each run
const REVIEW_WINDOW_HOURS = 6;

// Minimum forecasts needed per agent before adjusting that agent's weight
const MIN_SAMPLE_SIZE = 3;

/* =========================================================
   TABLE INIT
========================================================= */

async function initDynamicWeightsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dynamic_weights (
      id          BIGSERIAL    PRIMARY KEY,
      agent_name  TEXT         NOT NULL UNIQUE,
      weight      NUMERIC(8,4) NOT NULL DEFAULT ${DEFAULT_WEIGHT},
      sample_size INTEGER      NOT NULL DEFAULT 0,
      last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
  `);

  // Seed default rows once
  for (const agent of AGENTS) {
    await pool.query(
      `INSERT INTO dynamic_weights (agent_name, weight)
       VALUES ($1, $2)
       ON CONFLICT (agent_name) DO NOTHING`,
      [agent, DEFAULT_WEIGHT]
    );
  }

  if (logger?.info) logger.info("dynamic_weights table ready");
}

/* =========================================================
   GET CURRENT WEIGHTS
========================================================= */

/**
 * Returns the current influence weight for each agent.
 *
 * @returns {Promise<{ GROWTH_BIAS: number, RISK_SKEPTIC: number, MACRO_JUDGE: number }>}
 */
async function getAgentWeights() {
  try {
    const res = await pool.query(
      `SELECT agent_name, weight FROM dynamic_weights WHERE agent_name = ANY($1)`,
      [AGENTS]
    );

    const map = {};
    for (const row of res.rows) {
      map[row.agent_name] = Number(row.weight);
    }

    // Fill missing agents with default
    for (const agent of AGENTS) {
      if (!Number.isFinite(map[agent])) {
        map[agent] = DEFAULT_WEIGHT;
      }
    }

    return map;
  } catch (err) {
    logger.warn("causalMemory.getAgentWeights: DB error – using defaults", {
      message: err.message,
    });
    return Object.fromEntries(AGENTS.map((a) => [a, DEFAULT_WEIGHT]));
  }
}

/* =========================================================
   NORMALISE WEIGHTS  (sum → 1.0)
========================================================= */

function normaliseWeights(raw) {
  const clamped = {};
  for (const agent of AGENTS) {
    clamped[agent] = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, raw[agent] ?? DEFAULT_WEIGHT));
  }

  const total = Object.values(clamped).reduce((s, v) => s + v, 0);
  const normalised = {};
  for (const agent of AGENTS) {
    normalised[agent] = parseFloat((clamped[agent] / total).toFixed(4));
  }

  return normalised;
}

/* =========================================================
   ADJUST AGENT WEIGHTS  (48-h Causal-Memory cycle)
========================================================= */

/**
 * Reviews recently verified forecasts (≥48 h old, verified in the last
 * REVIEW_WINDOW_HOURS) and adjusts each agent's weight accordingly.
 *
 * @returns {Promise<{ adjusted: number, weights: object }>}
 */
async function adjustAgentWeights() {
  // Fetch newly verified forecasts that are at least 48 h old
  let rows;
  try {
    const res = await pool.query(`
      SELECT agent_name,
             COUNT(*) FILTER (WHERE was_correct = true)  AS correct,
             COUNT(*)                                     AS total
      FROM agent_forecasts
      WHERE was_correct IS NOT NULL
        AND forecasted_at <= NOW() - INTERVAL '48 hours'
        AND verified_at   >= NOW() - INTERVAL '${REVIEW_WINDOW_HOURS} hours'
      GROUP BY agent_name
    `);
    rows = res.rows;
  } catch (err) {
    logger.warn("causalMemory.adjustAgentWeights: fetch failed", { message: err.message });
    return { adjusted: 0, weights: await getAgentWeights() };
  }

  if (!rows.length) {
    return { adjusted: 0, weights: await getAgentWeights() };
  }

  const current = await getAgentWeights();
  let adjusted = 0;

  for (const row of rows) {
    const agent = row.agent_name;
    if (!AGENTS.includes(agent)) continue;

    const total   = Number(row.total);
    const correct = Number(row.correct);
    if (total < MIN_SAMPLE_SIZE) continue;

    const accuracy  = correct / total;
    const delta     = accuracy >= 0.5 ? LEARN_STEP : -LEARN_STEP;
    current[agent]  = (current[agent] ?? DEFAULT_WEIGHT) + delta;
    adjusted++;

    logger.info(`causalMemory: adjusted ${agent} by ${delta > 0 ? "+" : ""}${delta} (accuracy ${(accuracy * 100).toFixed(0)}%)`);
  }

  if (!adjusted) {
    return { adjusted: 0, weights: current };
  }

  const normalised = normaliseWeights(current);

  // Persist updated weights
  try {
    for (const agent of AGENTS) {
      const sampleRow = rows.find((r) => r.agent_name === agent);
      await pool.query(
        `UPDATE dynamic_weights
         SET weight       = $1,
             sample_size  = sample_size + $2,
             last_updated = NOW()
         WHERE agent_name = $3`,
        [normalised[agent], sampleRow ? Number(sampleRow.total) : 0, agent]
      );
    }
  } catch (err) {
    logger.warn("causalMemory.adjustAgentWeights: persist failed", { message: err.message });
  }

  return { adjusted, weights: normalised };
}

/* =========================================================
   META-RATIONALE HELPER
========================================================= */

const MS_PER_DAY = 86_400_000;

/**
 * Generates a concise German sentence describing a recent agent mistake
 * for the given symbol, to be prepended to the debate rationale.
 *
 * Returns null when no relevant history is found.
 *
 * @param {string} symbol
 * @returns {Promise<string|null>}
 */
async function buildMetaRationale(symbol) {
  if (!symbol) return null;

  try {
    // Find the most recent incorrect 48-h-verified forecast for this symbol
    const res = await pool.query(
      `SELECT agent_name, forecast_dir, actual_dir, forecasted_at
       FROM agent_forecasts
       WHERE symbol      = $1
         AND was_correct = false
         AND forecasted_at <= NOW() - INTERVAL '48 hours'
       ORDER BY forecasted_at DESC
       LIMIT 1`,
      [String(symbol).toUpperCase()]
    );

    if (!res.rows.length) return null;

    const row = res.rows[0];
    const agent     = row.agent_name;
    const wrongDir  = row.forecast_dir;
    const actualDir = row.actual_dir;

    const dirLabel = (d) =>
      d === "bullish" ? "bullisch" : d === "bearish" ? "bärisch" : "neutral";

    const daysDiff = Math.round(
      (Date.now() - new Date(row.forecasted_at).getTime()) / MS_PER_DAY
    );
    const timeLabel = daysDiff <= 1 ? "gestern" : `vor ${daysDiff} Tagen`;

    const agentLabel = {
      GROWTH_BIAS:  "Wachstums-Bias",
      RISK_SKEPTIC: "Risiko-Skeptiker",
      MACRO_JUDGE:  "Makro-Richter",
    }[agent] || agent;

    return (
      `📚 Historisches Lerngedächtnis: ${agentLabel} lag ${timeLabel} falsch ` +
      `(Prognose: ${dirLabel(wrongDir)}, Realität: ${dirLabel(actualDir)}) – ` +
      `erhöhte Wachsamkeit für ${String(symbol).toUpperCase()} aktiviert.`
    );
  } catch (err) {
    logger.warn("causalMemory.buildMetaRationale: DB error", { message: err.message });
    return null;
  }
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  initDynamicWeightsTable,
  getAgentWeights,
  adjustAgentWeights,
  buildMetaRationale,
  AGENTS,
  DEFAULT_WEIGHT,
};
