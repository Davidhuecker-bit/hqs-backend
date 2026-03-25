"use strict";

/*
  Agent Forecast Repository  –  Prediction-Self-Audit
  -----------------------------------------------------
  Every time the Agentic Debate runs, each of the three agents
  (GROWTH_BIAS, RISK_SKEPTIC, MACRO_JUDGE) logs a short-term
  forecast (next 24 h) for the symbol being evaluated.

  A daily verification job then checks these forecasts against
  the actual price movement and records whether each agent was
  correct.  The resulting accuracy ("Wisdom Score") is exposed
  via GET /api/admin/agent-wisdom.
*/

const logger = require("../utils/logger");

const { getSharedPool } = require("../config/database");
const pool = getSharedPool();
/* =========================================================
   TABLE INIT
========================================================= */

async function initAgentForecastTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_forecasts (
      id               BIGSERIAL    PRIMARY KEY,
      symbol           TEXT         NOT NULL,
      agent_name       TEXT         NOT NULL,
      forecast_dir     TEXT         NOT NULL,
      forecast_reason  TEXT,
      entry_price      NUMERIC(14,4),
      market_cluster   TEXT,
      debate_approved  BOOLEAN,
      forecasted_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      verified_at      TIMESTAMPTZ,
      actual_dir       TEXT,
      exit_price       NUMERIC(14,4),
      was_correct      BOOLEAN,
      created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_af_symbol_agent
    ON agent_forecasts (symbol, agent_name, forecasted_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_af_forecasted_at
    ON agent_forecasts (forecasted_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_af_unverified
    ON agent_forecasts (forecasted_at)
    WHERE verified_at IS NULL;
  `);

  if (logger?.info) logger.info("agent_forecasts table ready");
}

async function initAgentsTable() {
  // IMPORTANT: Do NOT add ALTER TABLE ... ADD COLUMN statements here.
  // ALTER TABLE acquires AccessExclusiveLock even with IF NOT EXISTS.
  // All columns MUST be in the CREATE TABLE statement.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id           SERIAL PRIMARY KEY,
      name         TEXT NOT NULL UNIQUE,
      wisdom_score FLOAT DEFAULT 0.0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  if (logger?.info) logger.info("agents table ready");
}

/* =========================================================
   LOG AGENT FORECASTS  (called after each debate run)
========================================================= */

/**
 * Persists one forecast row per agent for a given symbol.
 *
 * @param {object} params
 * @param {string}  params.symbol
 * @param {string}  params.marketCluster
 * @param {boolean} params.debateApproved
 * @param {number|null} params.entryPrice     current market price (may be null)
 * @param {object}  params.votes              debate votes: { growthBias, riskSkeptic, macroJudge }
 * @returns {Promise<void>}
 */
async function logAgentForecasts({
  symbol,
  marketCluster,
  debateApproved,
  entryPrice = null,
  votes,
}) {
  if (!votes) return;

  const sym = String(symbol || "").trim().toUpperCase();
  const cluster = String(marketCluster || "Unknown");
  const price = entryPrice !== null && Number.isFinite(Number(entryPrice)) && Number(entryPrice) > 0
    ? Number(entryPrice)
    : null;

  const rows = [
    { key: "growthBias",  agentName: "GROWTH_BIAS"  },
    { key: "riskSkeptic", agentName: "RISK_SKEPTIC" },
    { key: "macroJudge",  agentName: "MACRO_JUDGE"  },
  ];

  const inserts = rows
    .map(({ key, agentName }) => {
      const vote = votes[key];
      if (!vote) return null;
      // Use the forecastDirection already set by the agent in agenticDebate.service.js
      const dir = String(vote.forecastDirection || "neutral");
      return {
        agentName,
        dir,
        reason: String(vote.reason || ""),
      };
    })
    .filter(Boolean);

  if (!inserts.length) return;

  const now = new Date();

  try {
    await pool.query(
      `INSERT INTO agent_forecasts
         (symbol, agent_name, forecast_dir, forecast_reason,
          entry_price, market_cluster, debate_approved, forecasted_at)
       SELECT * FROM UNNEST(
         $1::text[], $2::text[], $3::text[], $4::text[],
         $5::numeric[], $6::text[], $7::boolean[], $8::timestamptz[]
       )`,
      [
        inserts.map(() => sym),
        inserts.map((r) => r.agentName),
        inserts.map((r) => r.dir),
        inserts.map((r) => r.reason),
        inserts.map(() => price),
        inserts.map(() => cluster),
        inserts.map(() => Boolean(debateApproved)),
        inserts.map(() => now),
      ]
    );
  } catch (error) {
    logger.warn("agentForecast: failed to log forecasts", {
      symbol: sym,
      message: error.message,
    });
  }
}

/* =========================================================
   VERIFY 24-HOUR FORECASTS  (called by daily job)
========================================================= */

/**
 * Fetches the current price for each unverified 24-h-old forecast and
 * records whether the agent's directional call was correct.
 *
 * Directional outcome:
 *   price change > +THRESHOLD  → actual_dir = 'bullish'
 *   price change < -THRESHOLD  → actual_dir = 'bearish'
 *   otherwise                  → actual_dir = 'neutral'
 *
 * was_correct = (forecast_dir === actual_dir)
 *
 * @param {Function} fetchQuoteFn  async (symbol) => { price: number, ... }
 * @returns {Promise<number>} count of rows verified
 */
const DIRECTION_THRESHOLD = 0.005; // 0.5 % move to count as directional

async function verifyAgentForecasts(fetchQuoteFn) {
  if (typeof fetchQuoteFn !== "function") {
    logger.warn("agentForecast.verifyAgentForecasts: fetchQuoteFn not provided");
    return 0;
  }

  // Only forecasts that have an entry_price and are ≥24h old
  let pending;
  try {
    const res = await pool.query(`
      SELECT id, symbol, agent_name, forecast_dir, entry_price
      FROM agent_forecasts
      WHERE verified_at IS NULL
        AND entry_price IS NOT NULL
        AND entry_price > 0
        AND forecasted_at <= NOW() - INTERVAL '24 hours'
      ORDER BY forecasted_at ASC
      LIMIT 200
    `);
    pending = res.rows;
  } catch (err) {
    logger.warn("agentForecast: failed to fetch pending forecasts", {
      message: err.message,
    });
    return 0;
  }

  if (!pending.length) return 0;

  // Deduplicate symbols to minimise API calls
  const uniqueSymbols = [...new Set(pending.map((r) => r.symbol))];
  const priceCache = {};

  for (const sym of uniqueSymbols) {
    try {
      const quote = await fetchQuoteFn(sym);
      const p = Number(quote?.price ?? quote?.close);
      if (Number.isFinite(p) && p > 0) {
        priceCache[sym] = p;
      }
    } catch (err) {
      logger.warn("agentForecast: price fetch failed for symbol", {
        symbol: sym,
        message: err.message,
      });
    }
  }

  let verified = 0;
  for (const row of pending) {
    const exitPrice = priceCache[row.symbol];
    if (!exitPrice) continue; // no quote → skip, will retry next run

    const entry = Number(row.entry_price);
    const change = (exitPrice - entry) / entry;

    let actualDir;
    if (change > DIRECTION_THRESHOLD)       actualDir = "bullish";
    else if (change < -DIRECTION_THRESHOLD) actualDir = "bearish";
    else                                     actualDir = "neutral";

    const wasCorrect = row.forecast_dir === actualDir;

    try {
      await pool.query(
        `UPDATE agent_forecasts
         SET verified_at = NOW(),
             exit_price  = $1,
             actual_dir  = $2,
             was_correct = $3
         WHERE id = $4`,
        [exitPrice, actualDir, wasCorrect, row.id]
      );
      verified++;
    } catch (err) {
      logger.warn("agentForecast: failed to update forecast row", {
        id: row.id,
        message: err.message,
      });
    }
  }

  return verified;
}

/* =========================================================
   WISDOM SCORES  (hit rate per agent)
========================================================= */

/**
 * Returns per-agent accuracy over all verified forecasts.
 *
 * @param {{ windowDays?: number }} options
 *   windowDays: limit to the last N calendar days (default: 30)
 * @returns {Promise<{
 *   scores: Array<{ agentName: string, accuracy: number, correct: number, total: number }>,
 *   consensus: boolean,
 *   bestAgent: string|null,
 *   windowDays: number,
 *   generatedAt: string
 * }>}
 */
async function getAgentWisdomScores({ windowDays = 30 } = {}) {
  const safeWindow = Math.min(365, Math.max(1, Number(windowDays) || 30));

  const AGENTS = ["GROWTH_BIAS", "RISK_SKEPTIC", "MACRO_JUDGE"];
  const scores = [];

  try {
    const res = await pool.query(
      `SELECT agent_name,
              COUNT(*)                                          AS total,
              COUNT(*) FILTER (WHERE was_correct = true)       AS correct
       FROM agent_forecasts
       WHERE was_correct IS NOT NULL
         AND forecasted_at >= NOW() - INTERVAL '1 day' * $1
       GROUP BY agent_name`,
      [safeWindow]
    );

    const rowMap = {};
    for (const row of res.rows) {
      rowMap[row.agent_name] = {
        correct: Number(row.correct),
        total: Number(row.total),
      };
    }

    for (const name of AGENTS) {
      const data = rowMap[name] || { correct: 0, total: 0 };
      scores.push({
        agentName: name,
        accuracy: data.total > 0
          ? Math.round((data.correct / data.total) * 100)
          : null,
        correct: data.correct,
        total: data.total,
      });
    }
  } catch (err) {
    logger.warn("agentForecast: getAgentWisdomScores failed", {
      message: err.message,
    });
    for (const name of AGENTS) {
      scores.push({ agentName: name, accuracy: null, correct: 0, total: 0 });
    }
  }

  // Consensus: at least two agents have ≥60% accuracy
  const withData = scores.filter((s) => s.accuracy !== null);
  const highAccuracy = withData.filter((s) => s.accuracy >= 60);
  const consensus = highAccuracy.length >= 2;

  // Best agent by accuracy (null if no data)
  let bestAgent = null;
  const ranked = scores
    .filter((s) => s.total >= 3 && s.accuracy !== null)
    .sort((a, b) => b.accuracy - a.accuracy);
  if (ranked.length) bestAgent = ranked[0].agentName;

  return {
    scores,
    consensus,
    bestAgent,
    windowDays: safeWindow,
    generatedAt: new Date().toISOString(),
  };
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  initAgentForecastTable,
  initAgentsTable,
  logAgentForecasts,
  verifyAgentForecasts,
  getAgentWisdomScores,
};
