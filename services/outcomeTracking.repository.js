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

      payload JSONB,
      raw_input_snapshot JSONB,
      analysis_rationale TEXT,
      performance_24h JSONB,
      performance_7d JSONB
    );
  `);

  await pool.query(`
    ALTER TABLE outcome_tracking
      -- These ADD COLUMN IF NOT EXISTS statements migrate existing deployments that were
      -- created before the intelligence columns were introduced. The columns are also
      -- declared inside CREATE TABLE above so that brand-new installations get them in
      -- a single CREATE statement without requiring a subsequent migration run.
      ADD COLUMN IF NOT EXISTS raw_input_snapshot JSONB,
      ADD COLUMN IF NOT EXISTS analysis_rationale TEXT,
      ADD COLUMN IF NOT EXISTS performance_24h JSONB,
      ADD COLUMN IF NOT EXISTS performance_7d JSONB;
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
  rawInputSnapshot = {},
  analysisRationale = null,
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
        payload,
        raw_input_snapshot,
        analysis_rationale
      )
      VALUES (
        $1,$2,$3,$4,
        $5,$6,$7,$8,
        $9,$10,$11,
        $12,$13,$14,
        $15,$16,
        $17,$18
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
        rawInputSnapshot || {},
        analysisRationale || null,
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

/* =========================================================
   ANALYSIS RATIONALE BUILDER
========================================================= */

/**
 * Generate a German-language textual rationale that explains why the
 * OpportunityEngine produced a signal. The text is human-readable but
 * also machine-parseable as a training label for future ML iterations.
 *
 * @param {object} params
 * @returns {string}
 */
function buildAnalysisRationale({
  hqsScore = 0,
  aiScore = 0,
  regime = null,
  strategy = null,
  features = {},
  signalContext = null,
  newsContext = null,
  orchestrator = null,
  discoveries = [],
  narratives = [],
} = {}) {
  const parts = [];

  const hqs = safe(hqsScore);
  const ai = safe(aiScore);
  const trendStrength = safe(features?.trendStrength, safe(features?.trend, 0));
  const relativeVolume = safe(features?.relativeVolume, 0);
  const liquidityScore = safe(features?.liquidityScore, 0);

  const direction = String(signalContext?.signalDirection || "neutral").toLowerCase();
  const earlySignal = signalContext?.earlySignalType || null;
  const buzzScore = safe(signalContext?.buzzScore, 0);
  const sentimentScore = safe(signalContext?.sentimentScore, 0);
  const trendLevel = signalContext?.trendLevel || null;

  const newsDirection = newsContext?.direction || null;
  const newsCount = safe(newsContext?.activeCount, 0);
  const newsDominantType = newsContext?.dominantEventType || null;
  const newsWeightedRelevance = safe(newsContext?.weightedRelevance, 0);

  const oppStrength = safe(orchestrator?.opportunityStrength, 0);
  const orchConfidence = safe(orchestrator?.orchestratorConfidence, 0);

  // --- HQS foundation ---
  if (hqs >= 80) {
    parts.push(`Elite-HQS-Grundlage (${Math.round(hqs)})`);
  } else if (hqs >= 65) {
    parts.push(`starke HQS-Grundlage (${Math.round(hqs)})`);
  } else if (hqs >= 50) {
    parts.push(`solide HQS-Basis (${Math.round(hqs)})`);
  }

  // --- Volume/price divergence pattern ---
  const hasMomentum = trendStrength > 0.5;
  const hasVolumeSpike = relativeVolume > 1.5;

  if (hasMomentum && hasVolumeSpike && sentimentScore > 20) {
    parts.push("Divergenz zwischen Volumen und Preis bei positivem Sentiment");
  } else if (hasVolumeSpike && direction === "bullish") {
    parts.push("Volumen-Divergenz mit bullischem Signal-Setup");
  } else if (hasVolumeSpike) {
    parts.push("überdurchschnittliches Volumen erkannt");
  }

  // --- Early / breakout signals ---
  if (earlySignal === "potential_breakout") {
    parts.push("frühes Breakout-Signal aktiv");
  } else if (earlySignal === "early_interest") {
    parts.push("frühes Marktinteresse erkannt");
  }

  // --- Trend level ---
  if (trendLevel === "exploding") {
    parts.push("Trend explodiert");
  } else if (trendLevel === "very_hot") {
    parts.push("sehr heißer Trend");
  } else if (trendLevel === "hot") {
    parts.push("heißer Trend");
  }

  // --- Sentiment / news confluence ---
  if (newsCount > 0 && sentimentScore > 20 && newsDirection === "bullish") {
    parts.push("Sentiment-Peak mit positiver News-Lage");
  } else if (newsCount > 0 && newsDirection === "bullish" && newsWeightedRelevance >= 60) {
    parts.push("hochrelevante bullische News");
  } else if (newsCount > 0 && newsDirection === "bearish") {
    parts.push("belastende News-Lage");
  } else if (newsCount > 0 && newsDominantType) {
    parts.push(`News-Fokus ${newsDominantType}`);
  }

  // --- Buzz ---
  if (buzzScore >= 75) {
    parts.push("starker Markt-Buzz");
  } else if (buzzScore >= 50) {
    parts.push("solider Markt-Buzz");
  }

  // --- AI confluence ---
  if (ai >= 80 && hqs >= 75) {
    parts.push("AI-HQS-Confluence");
  }

  // --- Strategy ---
  const strategyStr = String(strategy || "").toLowerCase();
  if (strategyStr === "momentum") {
    parts.push("Momentum-Strategie aktiv");
  } else if (strategyStr === "breakout") {
    parts.push("Breakout-Setup");
  } else if (strategyStr === "quality") {
    parts.push("Qualitätsstrategie");
  }

  // --- Discovery / narrative ---
  if (Array.isArray(discoveries) && discoveries.length > 0) {
    parts.push("aktives Marktsignal erkannt");
  }

  if (Array.isArray(narratives) && narratives.length > 0) {
    const narrativeType = narratives[0]?.type;
    if (narrativeType) {
      parts.push(`Narrativ: ${narrativeType}`);
    } else {
      parts.push("starkes Markt-Narrativ");
    }
  }

  // --- Opportunity strength ---
  if (oppStrength >= 85) {
    parts.push("maximale Opportunitätsstärke");
  } else if (oppStrength >= 70) {
    parts.push(`hohe Opportunitätsstärke (${Math.round(oppStrength)})`);
  }

  // --- Orchestrator confidence ---
  if (orchConfidence >= 80) {
    parts.push(`hohe Orchestrator-Konfidenz (${Math.round(orchConfidence)})`);
  }

  // --- Regime ---
  const regimeStr = String(regime || "").toLowerCase();
  if (regimeStr === "risk_on") {
    parts.push("Risk-On-Umfeld");
  } else if (regimeStr === "risk_off") {
    parts.push("Risk-Off-Umfeld");
  }

  // --- Liquidity ---
  if (liquidityScore >= 70) {
    parts.push("hohe Liquidität");
  }

  if (!parts.length) {
    parts.push("Standard-Marktbewertung ohne dominante Signale");
  }

  return parts.join(" · ");
}

/* =========================================================
   SELF-CORRECTION LOOP: verifyPerformance
========================================================= */

/**
 * Check the performance of a signal at a given time window (24h or 7d)
 * and persist the result directly in the original outcome_tracking record.
 *
 * @param {object} params
 * @param {number}  params.id            - outcome_tracking row id
 * @param {number}  params.currentPrice  - Current market price for the symbol
 * @param {string}  [params.windowLabel] - '24h' (default) or '7d'
 * @returns {Promise<{price_delta: number, success_rate: number, current_price: number, checked_at: string, window: string}|null>}
 */
async function verifyPerformance({ id, currentPrice, windowLabel = "24h" }) {
  const rowId = Number(id);
  const price = Number(currentPrice);

  if (!Number.isFinite(rowId) || rowId <= 0) return null;
  if (!Number.isFinite(price) || price <= 0) return null;

  const validWindows = ["24h", "7d"];
  const window = validWindows.includes(windowLabel) ? windowLabel : "24h";

  try {
    const entryRes = await pool.query(
      `
      SELECT id, entry_price, final_conviction
      FROM outcome_tracking
      WHERE id = $1
      `,
      [rowId]
    );

    const row = entryRes.rows?.[0];
    if (!row) return null;

    const entryPrice = safe(row.entry_price);
    if (!entryPrice || entryPrice <= 0) return null;

    const priceDelta = (price - entryPrice) / entryPrice;
    const conviction = safe(row.final_conviction, 0);

    // Success: a bullish signal (conviction >= 50) succeeds when price rises,
    // a bearish signal (conviction < 50) succeeds when price falls.
    const expectedBullish = conviction >= 50;
    const successRate = expectedBullish
      ? priceDelta > 0 ? 1.0 : 0.0
      : priceDelta < 0 ? 1.0 : 0.0;

    const perfData = {
      price_delta: Number(priceDelta.toFixed(6)),
      success_rate: successRate,
      current_price: price,
      checked_at: new Date().toISOString(),
      window,
    };

    await pool.query(
      `
      UPDATE outcome_tracking
      SET
        performance_24h = CASE WHEN $3 = '24h' THEN $2::jsonb ELSE performance_24h END,
        performance_7d  = CASE WHEN $3 = '7d'  THEN $2::jsonb ELSE performance_7d  END
      WHERE id = $1
      `,
      [rowId, JSON.stringify(perfData), window]
    );

    logger.info("verifyPerformance updated", {
      id: rowId,
      window,
      priceDelta: perfData.price_delta,
      successRate,
    });

    return perfData;
  } catch (err) {
    logger.error("verifyPerformance error", {
      message: err.message,
      id: rowId,
      windowLabel,
    });
    return null;
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
  buildAnalysisRationale,
  verifyPerformance,
};
