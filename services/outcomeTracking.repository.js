"use strict";

const { Pool } = require("pg");
const logger = require("../utils/logger");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function normalizeSymbols(symbols = []) {
  return [
    ...new Set(
      (Array.isArray(symbols) ? symbols : [])
        .map((symbol) => String(symbol || "").trim().toUpperCase())
        .filter(Boolean)
    ),
  ];
}

function safeJson(value, fallback = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }

  try {
    if (typeof structuredClone === "function") {
      return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return fallback;
  }
}

/* =========================================================
   TABLE INIT
========================================================= */

async function initOutcomeTrackingTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outcome_tracking (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      prediction_type TEXT,
      regime TEXT,
      strategy TEXT,

      hqs_score NUMERIC,
      ai_score NUMERIC,
      final_conviction NUMERIC,
      final_confidence NUMERIC,

      memory_score NUMERIC,
      opportunity_strength NUMERIC,
      orchestrator_confidence NUMERIC,

      setup_signature TEXT,
      horizon_days INTEGER DEFAULT 30,

      predicted_at TIMESTAMP DEFAULT NOW(),
      evaluation_due_at TIMESTAMP,
      is_evaluated BOOLEAN DEFAULT FALSE,

      entry_price NUMERIC,
      exit_price NUMERIC,
      actual_return NUMERIC,

      payload JSONB
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_outcome_tracking_symbol_due
    ON outcome_tracking(symbol, evaluation_due_at);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_outcome_tracking_eval
    ON outcome_tracking(is_evaluated, evaluation_due_at);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_outcome_tracking_setup_signature
    ON outcome_tracking(setup_signature);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_outcome_tracking_predicted_at
    ON outcome_tracking(predicted_at DESC);
  `);

  logger.info("Outcome tracking table ensured");
}

/* =========================================================
   CREATE TRACKING ENTRY
========================================================= */

async function createOutcomeTrackingEntry({
  symbol,
  predictionType = "market_view",
  regime = "neutral",
  strategy = "balanced",
  hqsScore = 0,
  aiScore = 0,
  finalConviction = 0,
  finalConfidence = 0,
  memoryScore = 0,
  opportunityStrength = 0,
  orchestratorConfidence = 0,
  setupSignature = null,
  horizonDays = 30,
  entryPrice = 0,
  payload = {},
}) {
  try {
    const dueAtRes = await pool.query(
      `
      SELECT NOW() + ($1 || ' days')::interval AS due_at
      `,
      [String(clamp(safe(horizonDays, 30), 1, 365))]
    );

    const dueAt = dueAtRes.rows?.[0]?.due_at || null;

    const res = await pool.query(
      `
      INSERT INTO outcome_tracking (
        symbol,
        prediction_type,
        regime,
        strategy,
        hqs_score,
        ai_score,
        final_conviction,
        final_confidence,
        memory_score,
        opportunity_strength,
        orchestrator_confidence,
        setup_signature,
        horizon_days,
        evaluation_due_at,
        entry_price,
        payload
      )
      VALUES (
        $1,$2,$3,$4,
        $5,$6,$7,$8,
        $9,$10,$11,
        $12,$13,$14,
        $15,$16
      )
      RETURNING id
      `,
      [
        String(symbol || "").toUpperCase(),
        predictionType,
        regime,
        strategy,
        safe(hqsScore),
        safe(aiScore),
        safe(finalConviction),
        safe(finalConfidence),
        safe(memoryScore),
        safe(opportunityStrength),
        safe(orchestratorConfidence),
        setupSignature,
        clamp(safe(horizonDays, 30), 1, 365),
        dueAt,
        safe(entryPrice),
        payload || {},
      ]
    );

    return res.rows?.[0] || null;
  } catch (err) {
    logger.error("createOutcomeTrackingEntry error", {
      message: err.message,
      symbol,
    });
    return null;
  }
}

/* =========================================================
   LOAD DUE PREDICTIONS
========================================================= */

async function getDueOutcomePredictions(limit = 100) {
  try {
    const res = await pool.query(
      `
      SELECT *
      FROM outcome_tracking
      WHERE is_evaluated = FALSE
        AND evaluation_due_at <= NOW()
      ORDER BY evaluation_due_at ASC
      LIMIT $1
      `,
      [clamp(safe(limit, 100), 1, 1000)]
    );

    return res.rows || [];
  } catch (err) {
    logger.error("getDueOutcomePredictions error", {
      message: err.message,
    });
    return [];
  }
}

/* =========================================================
   MARK AS EVALUATED
========================================================= */

async function completeOutcomePrediction({
  id,
  exitPrice = 0,
  actualReturn = 0,
}) {
  try {
    await pool.query(
      `
      UPDATE outcome_tracking
      SET
        exit_price = $2,
        actual_return = $3,
        is_evaluated = TRUE
      WHERE id = $1
      `,
      [id, safe(exitPrice), safe(actualReturn)]
    );

    return true;
  } catch (err) {
    logger.error("completeOutcomePrediction error", {
      message: err.message,
      id,
    });
    return false;
  }
}

/* =========================================================
   CALCULATE REAL RETURN
========================================================= */

function calculateActualReturn(entryPrice, exitPrice) {
  const entry = safe(entryPrice);
  const exit = safe(exitPrice);

  if (!entry || entry <= 0) return 0;

  return (exit - entry) / entry;
}

/* =========================================================
   SETUP HISTORY
========================================================= */

async function getSetupHistory(setupSignature, limit = 200) {
  try {
    if (!setupSignature) return [];

    const res = await pool.query(
      `
      SELECT
        symbol,
        actual_return,
        final_conviction,
        final_confidence,
        regime,
        strategy,
        predicted_at,
        evaluation_due_at
      FROM outcome_tracking
      WHERE setup_signature = $1
        AND is_evaluated = TRUE
      ORDER BY predicted_at DESC
      LIMIT $2
      `,
      [setupSignature, clamp(safe(limit, 200), 1, 2000)]
    );

    return res.rows || [];
  } catch (err) {
    logger.error("getSetupHistory error", {
      message: err.message,
    });
    return [];
  }
}

async function loadLatestOutcomeTrackingBySymbols(symbols = []) {
  try {
    const normalizedSymbols = normalizeSymbols(symbols);
    if (!normalizedSymbols.length) return {};

    const res = await pool.query(
      `
      SELECT DISTINCT ON (symbol)
        symbol,
        regime,
        final_conviction,
        final_confidence,
        opportunity_strength,
        orchestrator_confidence,
        payload,
        predicted_at
      FROM outcome_tracking
      WHERE symbol = ANY($1::text[])
        AND prediction_type = 'market_view'
      ORDER BY symbol, predicted_at DESC, id DESC
      `,
      [normalizedSymbols]
    );

    const result = res.rows.reduce((acc, row) => {
      const symbol = String(row?.symbol || "").trim().toUpperCase();
      if (!symbol) return acc;

      acc[symbol] = {
        symbol,
        regime: row?.regime ?? null,
        finalConviction: safe(row?.final_conviction, 0),
        finalConfidence: safe(row?.final_confidence, 0),
        opportunityStrength: safe(row?.opportunity_strength, 0),
        orchestratorConfidence: safe(row?.orchestrator_confidence, 0),
        predictedAt: row?.predicted_at
          ? new Date(row.predicted_at).toISOString()
          : null,
        payload: safeJson(row?.payload, {}),
      };
      return acc;
    }, {});

    for (const symbol of normalizedSymbols) {
      if (!Object.prototype.hasOwnProperty.call(result, symbol)) {
        result[symbol] = null;
      }
    }

    return result;
  } catch (err) {
    logger.error("loadLatestOutcomeTrackingBySymbols error", {
      message: err.message,
    });
    return {};
  }
}

module.exports = {
  initOutcomeTrackingTable,
  createOutcomeTrackingEntry,
  getDueOutcomePredictions,
  completeOutcomePrediction,
  calculateActualReturn,
  getSetupHistory,
  loadLatestOutcomeTrackingBySymbols,
};
