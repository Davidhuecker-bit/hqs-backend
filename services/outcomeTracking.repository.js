"use strict";

const logger = require("../utils/logger");

const { getSharedPool } = require("../config/database");
const pool = getSharedPool();
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
   STRUCTURED PATTERN SIGNATURE  (machine-readable, bucketed)
   ----------------------------------------------------------
   Converts continuous signal values into discrete bucket labels
   so identical market setups produce the same deterministic key.
   Stored in outcome_tracking.pattern_key for historical lookup.
========================================================= */

// Bucket threshold arrays (each index = upper bound of that bucket)
const PATTERN_VOL_THRESHOLDS    = [0.2,  0.5,  0.7 ];  // low|mid|high|extreme
const PATTERN_TREND_THRESHOLDS  = [0,    0.3,  0.6 ];  // negative|flat|rising|strong
const PATTERN_SENT_THRESHOLDS   = [-20,  10,   40  ];  // negative|neutral|positive|bullish
const PATTERN_BUZZ_THRESHOLDS   = [25,   50,   75  ];  // low|mid|high|hot
const PATTERN_ROBUST_THRESHOLDS = [0.35, 0.55, 0.80];  // low|moderate|solid|antifragile
const PATTERN_HQS_THRESHOLDS    = [50,   65,   80  ];  // weak|base|strong|elite
const PATTERN_CONV_THRESHOLDS   = [45,   58,   72  ];  // low|moderate|high|elite

function stepBucket(value, thresholds, labels) {
  const v = Number.isFinite(Number(value)) ? Number(value) : 0;
  for (let i = 0; i < thresholds.length; i++) {
    if (v <= thresholds[i]) return labels[i];
  }
  return labels[labels.length - 1];
}

// Normalise a value that may arrive on a 0-100 OR 0-1 scale to 0-1.
function norm0to1Pattern(x) {
  const n = Number.isFinite(Number(x)) ? Number(x) : 0;
  if (n > 1.5) return Math.min(1, Math.max(0, n / 100));
  return Math.min(1, Math.max(0, n));
}

/**
 * Build a deterministic, machine-readable pattern signature from a set of
 * bucketed signal dimensions.  Used as `pattern_key` in outcome_tracking.
 *
 * Returns both the compact string key and the structured context object.
 *
 * @param {object} params
 * @returns {{ patternKey: string, patternContext: object }}
 */
function buildStructuredPatternSignature({
  regime = "neutral",
  volatility = 0,        // 0-1 (annual vol)
  trendStrength = 0,     // 0-1 or 0-100 (auto-normalised)
  sentimentScore = 0,    // -100 to +100
  newsDirection = null,  // "bullish"|"bearish"|"neutral"|null
  buzzScore = 0,         // 0-100
  signalDirection = "neutral",  // "bullish"|"bearish"|"neutral"
  robustnessScore = 0,   // 0-1
  hqsScore = 0,          // 0-100
  finalConviction = 0,   // 0-100
} = {}) {
  const volBand    = stepBucket(norm0to1Pattern(volatility),    PATTERN_VOL_THRESHOLDS,    ["low",    "mid",      "high",    "extreme"    ]);
  const trendBand  = stepBucket(norm0to1Pattern(trendStrength), PATTERN_TREND_THRESHOLDS,  ["negative","flat",    "rising",  "strong"     ]);
  const sentBand   = stepBucket(safe(sentimentScore),           PATTERN_SENT_THRESHOLDS,   ["negative","neutral", "positive","bullish"     ]);
  const buzzBand   = stepBucket(safe(buzzScore),                PATTERN_BUZZ_THRESHOLDS,   ["low",    "mid",      "high",    "hot"         ]);
  const robustBand = stepBucket(safe(robustnessScore),          PATTERN_ROBUST_THRESHOLDS, ["low",    "moderate", "solid",   "antifragile" ]);
  const hqsBand    = stepBucket(safe(hqsScore),                 PATTERN_HQS_THRESHOLDS,    ["weak",   "base",     "strong",  "elite"       ]);
  const convBand   = stepBucket(safe(finalConviction),          PATTERN_CONV_THRESHOLDS,   ["low",    "moderate", "high",    "elite"       ]);

  const newsDir = String(newsDirection || "none").toLowerCase();
  const sigDir  = String(signalDirection || "neutral").toLowerCase();
  const regStr  = String(regime || "neutral").toLowerCase();

  const patternKey = [
    `regime:${regStr}`,
    `vol:${volBand}`,
    `trend:${trendBand}`,
    `sent:${sentBand}`,
    `news:${newsDir}`,
    `buzz:${buzzBand}`,
    `sig:${sigDir}`,
    `robust:${robustBand}`,
    `hqs:${hqsBand}`,
    `conv:${convBand}`,
  ].join("|");

  const patternContext = {
    regime: regStr,
    volatilityBand:   volBand,
    trendBand,
    sentimentBand:    sentBand,
    newsDirection:    newsDir,
    buzzBand,
    signalDirection:  sigDir,
    robustnessBand:   robustBand,
    hqsBand,
    convictionBand:   convBand,
  };

  return { patternKey, patternContext };
}

/* =========================================================
   PATTERN STATS  (historical aggregation by pattern_key)
========================================================= */

/**
 * For a given pattern key compute aggregated performance statistics
 * from all matching historical outcome_tracking rows.
 *
 * Returns null when no rows exist for this pattern key.
 *
 * @param {string} patternKey
 * @returns {Promise<{
 *   patternKey: string,
 *   sampleSize: number,
 *   evaluated24hCount: number,
 *   evaluated7dCount: number,
 *   hitRate24h: number|null,
 *   hitRate7d: number|null,
 *   avgReturn24h: number|null,
 *   avgReturn7d: number|null,
 *   patternConfidence: number
 * }|null>}
 */
async function getPatternStats(patternKey) {
  if (!patternKey || typeof patternKey !== "string") return null;

  try {
    const res = await pool.query(
      `
      SELECT
        COUNT(*)                                                                              AS sample_size,
        COUNT(CASE WHEN performance_24h IS NOT NULL THEN 1 END)                              AS evaluated_24h_count,
        COUNT(CASE WHEN performance_7d  IS NOT NULL THEN 1 END)                              AS evaluated_7d_count,
        AVG(CASE WHEN performance_24h IS NOT NULL
                 THEN (performance_24h->>'success_rate')::numeric END)                       AS hit_rate_24h,
        AVG(CASE WHEN performance_7d  IS NOT NULL
                 THEN (performance_7d ->>'success_rate')::numeric END)                       AS hit_rate_7d,
        AVG(CASE WHEN performance_24h IS NOT NULL
                 THEN (performance_24h->>'price_delta')::numeric END)                        AS avg_return_24h,
        AVG(CASE WHEN performance_7d  IS NOT NULL
                 THEN (performance_7d ->>'price_delta')::numeric END)                        AS avg_return_7d
      FROM outcome_tracking
      WHERE pattern_key = $1
      `,
      [patternKey]
    );

    const row = res.rows?.[0];
    if (!row) return null;

    const sampleSize       = Number(row.sample_size      || 0);
    const evaluated24hCount= Number(row.evaluated_24h_count || 0);
    const evaluated7dCount = Number(row.evaluated_7d_count  || 0);

    if (sampleSize === 0) return null;

    const hitRate24h   = evaluated24hCount > 0 ? Number(Number(row.hit_rate_24h   || 0).toFixed(4)) : null;
    const hitRate7d    = evaluated7dCount  > 0 ? Number(Number(row.hit_rate_7d    || 0).toFixed(4)) : null;
    const avgReturn24h = evaluated24hCount > 0 ? Number(Number(row.avg_return_24h || 0).toFixed(6)) : null;
    const avgReturn7d  = evaluated7dCount  > 0 ? Number(Number(row.avg_return_7d  || 0).toFixed(6)) : null;

    // patternConfidence: how reliably does this pattern predict outcomes?
    // Scales with sample size (max at 20) × clarity of historical hit rate
    // (a hit rate far from 0.5 = clearer signal, regardless of direction)
    const sampleFactor = Math.min(1.0, sampleSize / 20.0);
    const hitFactor    = hitRate24h !== null
      ? Math.abs(hitRate24h - 0.5) * 2.0   // 0 = random, 1 = perfect
      : 0.0;
    const patternConfidence = Number((sampleFactor * (0.4 + hitFactor * 0.6)).toFixed(4));

    return {
      patternKey,
      sampleSize,
      evaluated24hCount,
      evaluated7dCount,
      hitRate24h,
      hitRate7d,
      avgReturn24h,
      avgReturn7d,
      patternConfidence,
    };
  } catch (err) {
    logger.warn("getPatternStats: DB error", { message: err.message });
    return null;
  }
}

/* =========================================================
   7-DAY VERIFICATION CANDIDATES
========================================================= */

/**
 * Returns outcome_tracking rows that are at least 7 days old,
 * have a known entry price, and have not yet been verified at the 7d window.
 *
 * Used by forecastVerification.job to fill in performance_7d.
 *
 * @param {number} [limit=50]
 * @returns {Promise<Array<{ id: number, symbol: string, entry_price: number }>>}
 */
async function getDue7dVerifications(limit = 50) {
  try {
    const res = await pool.query(
      `
      SELECT id, symbol, entry_price
      FROM outcome_tracking
      WHERE predicted_at  <= NOW() - INTERVAL '7 days'
        AND performance_7d IS NULL
        AND entry_price    >  0
      ORDER BY predicted_at ASC
      LIMIT $1
      `,
      [clamp(safe(limit, 50), 1, 200)]
    );
    return res.rows || [];
  } catch (err) {
    logger.warn("getDue7dVerifications: DB error", { message: err.message });
    return [];
  }
}

/* =========================================================
   TABLE INIT
========================================================= */

async function initOutcomeTrackingTable() {
  // ── outcome_tracking ──────────────────────────────────────────────────────
  // All required columns (including raw_input_snapshot, analysis_rationale,
  // performance_24h, performance_7d, pattern_key, pattern_context) are defined
  // inline in CREATE TABLE so that ALTER TABLE ADD COLUMN migrations are never
  // needed at runtime.
  //
  // IMPORTANT: Do NOT add ALTER TABLE ... ADD COLUMN statements here.
  // ALTER TABLE acquires an AccessExclusiveLock on the table, even when the
  // column already exists (IF NOT EXISTS only skips the write, not the lock).
  // Running these on every startup causes lock-contention hangs when
  // HQS-Backend and hqs-scraping-service start concurrently.
  logger.info("[outcomeTracking] initOutcomeTrackingTable: CREATE TABLE start");
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
      performance_7d JSONB,
      pattern_key TEXT,
      pattern_context JSONB
    );
  `);
  logger.info("[outcomeTracking] initOutcomeTrackingTable: CREATE TABLE ok");

  logger.info("[outcomeTracking] initOutcomeTrackingTable: INDEX idx_outcome_tracking_symbol_due start");
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_outcome_tracking_symbol_due
    ON outcome_tracking(symbol, evaluation_due_at);
  `);
  logger.info("[outcomeTracking] initOutcomeTrackingTable: INDEX idx_outcome_tracking_symbol_due ok");

  logger.info("[outcomeTracking] initOutcomeTrackingTable: INDEX idx_outcome_tracking_eval start");
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_outcome_tracking_eval
    ON outcome_tracking(is_evaluated, evaluation_due_at);
  `);
  logger.info("[outcomeTracking] initOutcomeTrackingTable: INDEX idx_outcome_tracking_eval ok");

  logger.info("[outcomeTracking] initOutcomeTrackingTable: INDEX idx_outcome_tracking_setup_signature start");
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_outcome_tracking_setup_signature
    ON outcome_tracking(setup_signature);
  `);
  logger.info("[outcomeTracking] initOutcomeTrackingTable: INDEX idx_outcome_tracking_setup_signature ok");

  logger.info("[outcomeTracking] initOutcomeTrackingTable: INDEX idx_outcome_tracking_predicted_at start");
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_outcome_tracking_predicted_at
    ON outcome_tracking(predicted_at DESC);
  `);
  logger.info("[outcomeTracking] initOutcomeTrackingTable: INDEX idx_outcome_tracking_predicted_at ok");

  logger.info("[outcomeTracking] initOutcomeTrackingTable: INDEX idx_outcome_tracking_pattern_key start");
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_outcome_tracking_pattern_key
    ON outcome_tracking(pattern_key);
  `);
  logger.info("[outcomeTracking] initOutcomeTrackingTable: INDEX idx_outcome_tracking_pattern_key ok");

  logger.info("[outcomeTracking] Outcome tracking table ensured");
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
  patternKey = null,
  patternContext = null,
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
        analysis_rationale,
        pattern_key,
        pattern_context
      )
      VALUES (
        $1,$2,$3,$4,
        $5,$6,$7,$8,
        $9,$10,$11,
        $12,$13,$14,
        $15,$16,
        $17,$18,
        $19,$20
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
        patternKey || null,
        patternContext || null,
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

/* =========================================================
   STEP 6: ADAPTIVE PRODUCT SIGNALS – RECOMMENDATION OUTCOME
========================================================= */

/**
 * computeRecommendationOutcome – derives a normalized recommendation quality
 * score (0..100) for a symbol from existing evaluated outcome_tracking records.
 *
 * Uses only already-evaluated rows (is_evaluated = TRUE, performance data
 * present). No schema changes. Defensive: returns null when no data available.
 *
 * @param {string} symbol
 * @param {object} [opts]
 * @param {number} [opts.limit=10] - max recent evaluated records to consider
 * @returns {Promise<{
 *   symbol: string,
 *   recommendationOutcome: number,  // 0..100: signal track-record quality
 *   avgActualReturn: number|null,   // average price-delta across evaluated windows
 *   successRate: number|null,       // fraction of signals that moved in predicted direction
 *   sampleSize: number,
 *   computedAt: string,
 * }|null>}
 */
async function computeRecommendationOutcome(symbol, { limit = 10 } = {}) {
  if (!symbol || typeof symbol !== "string") return null;
  const sym = String(symbol).trim().toUpperCase();
  if (!sym) return null;

  const lim = Math.min(Math.max(Number(limit) || 10, 1), 50);
  try {
    const res = await pool.query(
      `SELECT
         (performance_24h->>'success_rate')::numeric AS success_24h,
         (performance_7d ->>'success_rate')::numeric AS success_7d,
         (performance_24h->>'price_delta')::numeric  AS delta_24h,
         (performance_7d ->>'price_delta')::numeric  AS delta_7d
       FROM outcome_tracking
       WHERE symbol = $1
         AND is_evaluated = TRUE
         AND (performance_24h IS NOT NULL OR performance_7d IS NOT NULL)
       ORDER BY predicted_at DESC
       LIMIT $2`,
      [sym, lim]
    );

    if (!res.rows.length) return null;

    let successSum = 0, successCount = 0, returnSum = 0, returnCount = 0;
    for (const r of res.rows) {
      const s24 = r.success_24h != null ? Number(r.success_24h) : null;
      const s7d = r.success_7d  != null ? Number(r.success_7d)  : null;
      const d24 = r.delta_24h   != null ? Number(r.delta_24h)   : null;
      const d7d = r.delta_7d    != null ? Number(r.delta_7d)    : null;

      // Prefer 7d data; fall back to 24h
      const successRate = s7d ?? s24;
      const priceDelta  = d7d ?? d24;
      if (successRate !== null) { successSum += successRate; successCount++; }
      if (priceDelta  !== null) { returnSum  += priceDelta;  returnCount++;  }
    }

    const avgSuccessRate  = successCount > 0 ? successSum / successCount : null;
    const avgActualReturn = returnCount  > 0 ? returnSum  / returnCount  : null;

    // recommendationOutcome: 0..100 composite score
    //   50 = neutral baseline (no data advantage over random)
    //   > 50 = solid historical track record
    //   < 50 = poor historical accuracy
    //
    // Formula: successRate * 60  (0..60 pts, reflects direction accuracy)
    //        + returnPts          (0..40 pts, reflects magnitude quality)
    //
    // returnPts scaling:
    //   avgActualReturn is a price-delta fraction (e.g. +0.05 = +5%).
    //   Multiplying by 200 maps ±10% returns to ±20 pts range.
    //   Clamping to [-20, +20] prevents outlier distortion.
    //   Adding 20 shifts the range from [-20, +20] → [0, 40] pts.
    //   When no return data is available, returnPts defaults to 20 (neutral mid-point).
    let outcome = 50;
    if (avgSuccessRate !== null) {
      const returnPts = avgActualReturn !== null
        ? Math.min(Math.max(avgActualReturn * 200, -20), 20) + 20
        : 20; // neutral mid-point when return data is absent
      outcome = Math.max(0, Math.min(100, Math.round(avgSuccessRate * 60 + returnPts)));
    }

    return {
      symbol: sym,
      recommendationOutcome: outcome,
      avgActualReturn: avgActualReturn !== null ? Number(avgActualReturn.toFixed(6)) : null,
      successRate:     avgSuccessRate  !== null ? Number(avgSuccessRate.toFixed(4))  : null,
      sampleSize:      res.rows.length,
      computedAt:      new Date().toISOString(),
    };
  } catch (err) {
    logger.warn("computeRecommendationOutcome error", { symbol: sym, message: err.message });
    return null;
  }
}

/**
 * computeRecommendationOutcomeBySymbols – batch version of
 * computeRecommendationOutcome. Issues a single DB query for multiple symbols.
 *
 * Returns a map of { [SYMBOL]: recommendationOutcomeObject | null }.
 * Symbols with no evaluated data are mapped to null.
 *
 * @param {string[]} symbols
 * @param {object}   [opts]
 * @param {number}   [opts.limit=10] - per-symbol record limit
 * @returns {Promise<Record<string, object|null>>}
 */
async function computeRecommendationOutcomeBySymbols(symbols = [], { limit = 10 } = {}) {
  const normalized = symbols
    .map((s) => String(s || "").trim().toUpperCase())
    .filter(Boolean);
  if (!normalized.length) return {};

  const lim = Math.min(Math.max(Number(limit) || 10, 1), 50);
  try {
    // Fetch last `lim` evaluated records per symbol in one query.
    const res = await pool.query(
      `SELECT symbol,
         (performance_24h->>'success_rate')::numeric AS success_24h,
         (performance_7d ->>'success_rate')::numeric AS success_7d,
         (performance_24h->>'price_delta')::numeric  AS delta_24h,
         (performance_7d ->>'price_delta')::numeric  AS delta_7d,
         row_number() OVER (PARTITION BY symbol ORDER BY predicted_at DESC) AS rn
       FROM outcome_tracking
       WHERE symbol = ANY($1::text[])
         AND is_evaluated = TRUE
         AND (performance_24h IS NOT NULL OR performance_7d IS NOT NULL)`,
      [normalized]
    );

    // Group rows by symbol, respect per-symbol limit
    const bySymbol = {};
    for (const r of res.rows) {
      const sym = String(r.symbol || "").trim().toUpperCase();
      if (!sym) continue;
      if (Number(r.rn) > lim) continue;
      if (!bySymbol[sym]) bySymbol[sym] = [];
      bySymbol[sym].push(r);
    }

    const result = {};
    for (const sym of normalized) {
      const rows = bySymbol[sym];
      if (!rows || !rows.length) { result[sym] = null; continue; }

      let successSum = 0, successCount = 0, returnSum = 0, returnCount = 0;
      for (const r of rows) {
        const s24 = r.success_24h != null ? Number(r.success_24h) : null;
        const s7d = r.success_7d  != null ? Number(r.success_7d)  : null;
        const d24 = r.delta_24h   != null ? Number(r.delta_24h)   : null;
        const d7d = r.delta_7d    != null ? Number(r.delta_7d)    : null;
        const successRate = s7d ?? s24;
        const priceDelta  = d7d ?? d24;
        if (successRate !== null) { successSum += successRate; successCount++; }
        if (priceDelta  !== null) { returnSum  += priceDelta;  returnCount++;  }
      }

      const avgSuccessRate  = successCount > 0 ? successSum / successCount : null;
      const avgActualReturn = returnCount  > 0 ? returnSum  / returnCount  : null;

      // Same scoring formula as computeRecommendationOutcome (see that function for full rationale).
      // successRate * 60 pts (direction accuracy) + returnPts 0..40 pts (magnitude quality).
      let outcome = 50;
      if (avgSuccessRate !== null) {
        const returnPts = avgActualReturn !== null
          ? Math.min(Math.max(avgActualReturn * 200, -20), 20) + 20
          : 20; // neutral mid-point when return data is absent
        outcome = Math.max(0, Math.min(100, Math.round(avgSuccessRate * 60 + returnPts)));
      }

      result[sym] = {
        symbol: sym,
        recommendationOutcome: outcome,
        avgActualReturn: avgActualReturn !== null ? Number(avgActualReturn.toFixed(6)) : null,
        successRate:     avgSuccessRate  !== null ? Number(avgSuccessRate.toFixed(4))  : null,
        sampleSize:      rows.length,
        computedAt:      new Date().toISOString(),
      };
    }
    return result;
  } catch (err) {
    logger.warn("computeRecommendationOutcomeBySymbols error", { message: err.message });
    // Return nulls for all symbols on error to keep caller non-fatal
    return Object.fromEntries(normalized.map((s) => [s, null]));
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
  buildStructuredPatternSignature,
  getPatternStats,
  getDue7dVerifications,
  // ✅ Step 6: adaptive product signals
  computeRecommendationOutcome,
  computeRecommendationOutcomeBySymbols,
};
