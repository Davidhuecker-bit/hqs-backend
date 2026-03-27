"use strict";

/*
  Autonomy Audit Repository
  Every autonomous decision made by the system is recorded here with:
    - A digital timestamp (decided_at)
    - The exact snapshot of the decision basis (raw_input_snapshot)
    - The market regime context at the time of the decision
    - Whether the Guardian Protocol suppressed the signal

  Records are append-only and must not be deleted or updated.
*/

const logger = require("../utils/logger");

const { getSharedPool } = require("../config/database");
const pool = getSharedPool();
/* =========================================================
   TABLE INIT
========================================================= */

async function initAutonomyAuditTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS autonomy_audit (
      id                 BIGSERIAL PRIMARY KEY,
      symbol             TEXT        NOT NULL,
      decision_type      TEXT        NOT NULL,
      decision_value     TEXT        NOT NULL,
      market_cluster     TEXT        NOT NULL,
      robustness_score   NUMERIC(5,4) NOT NULL CHECK (robustness_score >= 0 AND robustness_score <= 1),
      guardian_applied   BOOLEAN     NOT NULL DEFAULT FALSE,
      suppressed         BOOLEAN     NOT NULL DEFAULT FALSE,
      suppression_reason TEXT,
      raw_input_snapshot JSONB       NOT NULL,
      decided_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_autonomy_audit_symbol
    ON autonomy_audit (symbol, decided_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_autonomy_audit_decided_at
    ON autonomy_audit (decided_at DESC);
  `);

  if (logger?.info) logger.info("autonomy_audit table ready");
}

async function initAutomationAuditTable() {
  // IMPORTANT: Do NOT add ALTER TABLE ... ADD COLUMN statements here.
  // ALTER TABLE acquires AccessExclusiveLock even with IF NOT EXISTS.
  // All columns MUST be in the CREATE TABLE statement.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS automation_audit (
      id                       SERIAL PRIMARY KEY,
      symbol                   TEXT,
      action                   TEXT,
      saved_capital_potential  FLOAT DEFAULT 0.0,
      created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  if (logger?.info) logger.info("automation_audit table ready");
}

/* =========================================================
   RECORD A DECISION
========================================================= */

/**
 * Appends one immutable audit record.
 *
 * @param {object} params
 * @param {string}  params.symbol
 * @param {string}  params.decisionType   e.g. 'opportunity_signal'
 * @param {string}  params.decisionValue  e.g. 'AGGRESSIV PRÜFEN' | 'SUPPRESSED'
 * @param {string}  params.marketCluster  'Safe' | 'Volatile' | 'Danger'
 * @param {number}  params.robustnessScore 0.0 – 1.0
 * @param {boolean} params.guardianApplied
 * @param {boolean} params.suppressed
 * @param {string|null} params.suppressionReason
 * @param {object}  params.rawInputSnapshot  full raw-input snapshot object
 * @returns {Promise<number|null>} inserted row id
 */
async function recordAutonomyDecision({
  symbol,
  decisionType,
  decisionValue,
  marketCluster,
  robustnessScore,
  guardianApplied,
  suppressed,
  suppressionReason,
  rawInputSnapshot,
}) {
  try {
    const res = await pool.query(
      `
      INSERT INTO autonomy_audit
        (symbol, decision_type, decision_value, market_cluster,
         robustness_score, guardian_applied, suppressed, suppression_reason,
         raw_input_snapshot, decided_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb, NOW())
      RETURNING id
      `,
      [
        String(symbol || "").trim().toUpperCase(),
        String(decisionType || "unknown"),
        String(decisionValue || ""),
        String(marketCluster || "Unknown"),
        Number(robustnessScore) || 0,
        Boolean(guardianApplied),
        Boolean(suppressed),
        suppressionReason ? String(suppressionReason) : null,
        JSON.stringify(rawInputSnapshot || {}),
      ]
    );

    return res.rows?.[0]?.id ?? null;
  } catch (error) {
    logger.warn("autonomyAudit: failed to record decision", {
      symbol,
      decisionType,
      message: error.message,
    });
    return null;
  }
}

/* =========================================================
   VIRTUAL CAPITAL PROTECTOR  –  near-miss table
========================================================= */

/**
 * Creates the guardian_near_miss table if it does not exist.
 * Stores every signal that was blocked (suppressed) by the Guardian or
 * Agentic Debate so that a 48-hour saved_capital estimate can be computed.
 */
async function initNearMissTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guardian_near_miss (
      id                BIGSERIAL PRIMARY KEY,
      symbol            TEXT        NOT NULL,
      blocked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      market_cluster    TEXT        NOT NULL,
      robustness_score  NUMERIC(5,4) NOT NULL,
      entry_price_ref   NUMERIC(12,4),
      debate_approved   BOOLEAN,
      debate_summary    TEXT,
      debate_result     JSONB,
      saved_capital     NUMERIC(12,2),
      evaluated_at      TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_gnm_symbol
    ON guardian_near_miss (symbol, blocked_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_gnm_blocked_at
    ON guardian_near_miss (blocked_at DESC);
  `);

  if (logger?.info) logger.info("guardian_near_miss table ready");
}

/**
 * Logs a blocked ("near miss") signal for Virtual Capital Protector tracking.
 *
 * @param {object} params
 * @param {string}  params.symbol
 * @param {string}  params.marketCluster
 * @param {number}  params.robustnessScore
 * @param {number|null} params.entryPriceRef
 * @param {boolean|null} params.debateApproved
 * @param {string|null}  params.debateSummary
 * @param {object|null}  params.debateResult
 * @returns {Promise<number|null>} inserted row id
 */
async function logNearMiss({
  symbol,
  marketCluster,
  robustnessScore,
  entryPriceRef = null,
  debateApproved = null,
  debateSummary = null,
  debateResult = null,
}) {
  try {
    const res = await pool.query(
      `
      INSERT INTO guardian_near_miss
        (symbol, market_cluster, robustness_score, entry_price_ref,
         debate_approved, debate_summary, debate_result, blocked_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb, NOW())
      RETURNING id
      `,
      [
        String(symbol || "").trim().toUpperCase(),
        String(marketCluster || "Unknown"),
        Number(robustnessScore) || 0,
        entryPriceRef !== null ? Number(entryPriceRef) : null,
        debateApproved !== null ? Boolean(debateApproved) : null,
        debateSummary ? String(debateSummary) : null,
        JSON.stringify(debateResult || null),
      ]
    );
    return res.rows?.[0]?.id ?? null;
  } catch (error) {
    logger.warn("nearMiss: failed to log near miss", {
      symbol,
      message: error.message,
    });
    return null;
  }
}

/**
 * Calculates and persists saved_capital for near-miss records that are
 * at least 48 hours old and have not yet been evaluated.
 *
 * The saved_capital estimate is deterministic and rule-based (virtual /
 * fictional) since no live price feed is required:
 *   saved_capital = VIRTUAL_POSITION_EUR * lossRisk * (1 - robustnessScore)
 *
 * Where lossRisk reflects the expected 48-hour downside per cluster:
 *   Danger   → 8 %
 *   Volatile → 5 %
 *   Safe     → 2 %
 *
 * @returns {Promise<number>} count of records evaluated
 */
const VIRTUAL_POSITION_EUR = 1000;
const LOSS_RISK_BY_CLUSTER = {
  Danger: 0.08,
  Volatile: 0.05,
  Safe: 0.02,
};

async function evaluateSavedCapital() {
  try {
    const pending = await pool.query(`
      SELECT id, symbol, market_cluster, robustness_score
      FROM guardian_near_miss
      WHERE saved_capital IS NULL
        AND blocked_at <= NOW() - INTERVAL '48 hours'
      LIMIT 100
    `);

    if (!pending.rows.length) return 0;

    let updated = 0;
    for (const row of pending.rows) {
      const cluster = String(row.market_cluster || "Safe");
      const robustness = Number(row.robustness_score) || 0;
      const lossRisk = LOSS_RISK_BY_CLUSTER[cluster] ?? 0.02;

      // Virtual (fictional) saved-capital formula:
      //   saved_capital = VIRTUAL_POSITION_EUR × lossRisk × (1 − robustness)
      //
      // Rationale:
      //   • VIRTUAL_POSITION_EUR  – assumed notional position size (EUR)
      //   • lossRisk              – expected 48 h downside per market cluster
      //   • (1 − robustness)      – vulnerability multiplier: signals with low
      //                             robustness scores carry proportionally higher
      //                             expected drawdown, so more capital is "saved"
      //                             by blocking them
      const savedCapital = Number(
        (VIRTUAL_POSITION_EUR * lossRisk * (1 - robustness)).toFixed(2)
      );

      await pool.query(
        `UPDATE guardian_near_miss
         SET saved_capital = $1, evaluated_at = NOW()
         WHERE id = $2`,
        [savedCapital, row.id]
      );
      updated++;
    }

    return updated;
  } catch (error) {
    logger.warn("nearMiss: evaluateSavedCapital failed", {
      message: error.message,
    });
    return 0;
  }
}

/**
 * Returns the most recent near-miss records, optionally evaluated.
 *
 * @param {{ limit?: number, evaluatedOnly?: boolean }} options
 * @returns {Promise<object[]>}
 */
async function getNearMisses({ limit = 25, evaluatedOnly = false } = {}) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  try {
    const whereClause = evaluatedOnly ? "WHERE saved_capital IS NOT NULL" : "";
    const res = await pool.query(
      `SELECT id, symbol, blocked_at, market_cluster, robustness_score,
              entry_price_ref, debate_approved, debate_summary,
              saved_capital, evaluated_at
       FROM guardian_near_miss
       ${whereClause}
       ORDER BY blocked_at DESC
       LIMIT $1`,
      [safeLimit]
    );
    return res.rows;
  } catch (error) {
    logger.warn("nearMiss: getNearMisses failed", { message: error.message });
    return [];
  }
}

/* =========================================================
   FEATURE HISTORY TABLE
========================================================= */

async function initFeatureHistoryTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feature_history (
      id              BIGSERIAL PRIMARY KEY,
      symbol          TEXT        NOT NULL,
      timestamp       TIMESTAMPTZ NOT NULL,
      indicator       TEXT        NOT NULL,
      value           NUMERIC,
      median          NUMERIC,
      mad             NUMERIC,
      zscore_robust   NUMERIC,
      regime_context  TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (symbol, timestamp, indicator)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_feature_history_symbol_ts
    ON feature_history (symbol, timestamp DESC);
  `);

  if (logger?.info) logger.info("feature_history table ready");
}

/* =========================================================
   DISCOVERY LABELS TABLE
========================================================= */

async function initDiscoveryLabelsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discovery_labels (
      id                  BIGSERIAL PRIMARY KEY,
      symbol              TEXT        NOT NULL,
      signal_time         TIMESTAMPTZ NOT NULL,
      pattern_type        TEXT,
      forward_return_5d   NUMERIC,
      forward_return_20d  NUMERIC,
      max_drawdown_20d    NUMERIC,
      success_label       BOOLEAN,
      regime_context      TEXT,
      discovery_score     NUMERIC,
      label_version       INT         DEFAULT 1,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_discovery_labels_symbol_signal
    ON discovery_labels (symbol, signal_time DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_discovery_labels_regime
    ON discovery_labels (regime_context);
  `);

  if (logger?.info) logger.info("discovery_labels table ready");
}

/* =========================================================
   ML MODELS TABLE
========================================================= */

async function initMlModelsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ml_models (
      id                       SERIAL PRIMARY KEY,
      model_type               TEXT    NOT NULL,
      version                  INT     NOT NULL,
      features_used            JSONB,
      weights                  JSONB,
      performance_validation   JSONB,
      active                   BOOLEAN DEFAULT FALSE,
      trained_at               TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Prevent duplicate (model_type, version) registrations
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ml_models_type_version
    ON ml_models (model_type, version);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ml_models_active
    ON ml_models (model_type, active) WHERE active = TRUE;
  `);

  if (logger?.info) logger.info("ml_models table ready");
}

/* =========================================================
   ROBUST STATISTICS
========================================================= */

/**
 * Computes median, MAD (median absolute deviation) and a robust z-score
 * function from a numeric array.
 *
 * @param {number[]} values
 * @returns {{ median: number, mad: number, zScore: (v: number) => number } | null}
 */
function computeRobustStats(values) {
  if (!Array.isArray(values)) return null;

  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;

  const sorted = [...nums].sort((a, b) => a - b);
  const median = medianOf(sorted);

  const absDevs = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = medianOf(absDevs);

  /**
   * Robust z-score: (value − median) / (1.4826 × MAD)
   * Factor 1.4826 makes MAD consistent with σ for normal distributions.
   * Returns 0 when MAD is zero (all values identical → no deviation).
   */
  const scaledMad = mad * 1.4826;
  const zScore = (v) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return 0;
    if (scaledMad === 0) return 0;
    return (v - median) / scaledMad;
  };

  return { median, mad, zScore };
}

/** Median of a *pre-sorted* numeric array. */
function medianOf(sorted) {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* =========================================================
   FEATURE UPSERT
========================================================= */

/**
 * Upserts one or more feature-history rows using ON CONFLICT.
 * Expects the feature_history table (with UNIQUE(symbol, timestamp, indicator))
 * to exist already.
 *
 * @param {Array<{
 *   symbol: string,
 *   timestamp: string|Date,
 *   indicator: string,
 *   value?: number,
 *   median?: number,
 *   mad?: number,
 *   zscore_robust?: number,
 *   regime_context?: string
 * }>} features
 * @returns {Promise<number>} count of rows upserted
 */
async function upsertFeatureHistory(features) {
  if (!Array.isArray(features) || features.length === 0) return 0;

  const client = await pool.connect();
  let upserted = 0;
  let skipped = 0;

  try {
    await client.query("BEGIN");

    for (const f of features) {
      // --- defensive normalisation ---
      const symbol = String(f.symbol || "").trim().toUpperCase();
      if (!symbol) { skipped++; continue; }

      const indicator = String(f.indicator || "").trim();
      if (!indicator) { skipped++; continue; }

      // timestamp: must resolve to a valid Date
      if (f.timestamp == null) { skipped++; continue; }
      const tsDate = f.timestamp instanceof Date ? f.timestamp : new Date(f.timestamp);
      if (!Number.isFinite(tsDate.getTime())) { skipped++; continue; }
      const ts = tsDate.toISOString();

      // numeric fields: only finite numbers, otherwise null
      const val     = typeof f.value === "number" && Number.isFinite(f.value) ? f.value : null;
      const med     = typeof f.median === "number" && Number.isFinite(f.median) ? f.median : null;
      const madVal  = typeof f.mad === "number" && Number.isFinite(f.mad) ? f.mad : null;
      const zs      = typeof f.zscore_robust === "number" && Number.isFinite(f.zscore_robust) ? f.zscore_robust : null;
      const regime  = f.regime_context ? String(f.regime_context) : null;

      await client.query(
        `INSERT INTO feature_history
           (symbol, timestamp, indicator, value, median, mad, zscore_robust, regime_context)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (symbol, timestamp, indicator) DO UPDATE SET
           value          = EXCLUDED.value,
           median         = EXCLUDED.median,
           mad            = EXCLUDED.mad,
           zscore_robust  = EXCLUDED.zscore_robust,
           regime_context = EXCLUDED.regime_context`,
        [symbol, ts, indicator, val, med, madVal, zs, regime]
      );
      upserted++;
    }

    await client.query("COMMIT");
  } catch (error) {
    // Rollback best-effort: if the connection is already broken the rollback
    // itself may fail, which is harmless since the transaction is aborted anyway.
    await client.query("ROLLBACK").catch(() => {});
    logger.warn("upsertFeatureHistory: transaction failed", { message: error.message });
    upserted = 0;
  } finally {
    client.release();
  }

  if (skipped > 0) {
    logger.warn("upsertFeatureHistory: skipped invalid rows", { skipped, total: features.length });
  }

  return upserted;
}

/* =========================================================
   REGIME PERFORMANCE
========================================================= */

/**
 * Aggregates forward-label success rate for a given regime context
 * from `discovery_labels`.
 *
 * Uses `regime_context` stored alongside the labels – no fragile
 * cross-table timestamp join required.
 *
 * @param {string} regimeCluster  e.g. "Safe", "Volatile", "Danger"
 * @returns {Promise<number>} success rate 0..1 (fallback 0.5)
 */
async function getRegimePerformance(regimeCluster) {
  const regime = String(regimeCluster || "").trim();
  if (!regime) return 0.5;

  try {
    const res = await pool.query(
      `SELECT
         COUNT(*)::int                                     AS total,
         COUNT(*) FILTER (WHERE success_label = TRUE)::int AS successes
       FROM discovery_labels
       WHERE regime_context = $1`,
      [regime]
    );

    const row = res.rows?.[0];
    const total = Number(row?.total) || 0;
    if (total === 0) return 0.5;

    return Number(row.successes) / total;
  } catch (error) {
    logger.warn("getRegimePerformance: query failed", { regime, message: error.message });
    return 0.5;
  }
}

/* =========================================================
   ACTIVE MODEL / MODEL REGISTRY
========================================================= */

/**
 * Returns the currently active model of a given type, or null.
 *
 * @param {string} modelType
 * @returns {Promise<object|null>}
 */
async function getActiveModel(modelType) {
  const type = String(modelType || "").trim();
  if (!type) return null;

  try {
    const res = await pool.query(
      `SELECT id, model_type, version, features_used, weights,
              performance_validation, active, trained_at
       FROM ml_models
       WHERE model_type = $1 AND active = TRUE
       ORDER BY trained_at DESC
       LIMIT 1`,
      [type]
    );
    return res.rows?.[0] ?? null;
  } catch (error) {
    logger.warn("getActiveModel: query failed", { modelType: type, message: error.message });
    return null;
  }
}

/**
 * Registers a new model and atomically deactivates all previous active
 * models of the same type.
 *
 * @param {{
 *   modelType: string,
 *   version: number,
 *   featuresUsed?: object,
 *   weights?: object,
 *   performanceValidation?: object
 * }} model
 * @returns {Promise<number|null>} inserted model id
 */
async function registerModel(model) {
  const type = String(model?.modelType || "").trim();
  const version = Number(model?.version);
  if (!type || !Number.isFinite(version)) {
    logger.warn("registerModel: invalid modelType or version", { type, version });
    return null;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Deactivate all current active models of this type
    await client.query(
      `UPDATE ml_models SET active = FALSE WHERE model_type = $1 AND active = TRUE`,
      [type]
    );

    const res = await client.query(
      `INSERT INTO ml_models
         (model_type, version, features_used, weights, performance_validation, active, trained_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, TRUE, NOW())
       RETURNING id`,
      [
        type,
        version,
        JSON.stringify(model.featuresUsed ?? null),
        JSON.stringify(model.weights ?? null),
        JSON.stringify(model.performanceValidation ?? null),
      ]
    );

    await client.query("COMMIT");
    const id = res.rows?.[0]?.id ?? null;
    if (logger?.info) logger.info("registerModel: registered", { modelType: type, version, id });
    return id;
  } catch (error) {
    // Rollback best-effort: if the connection is already broken the rollback
    // itself may fail, which is harmless since the transaction is aborted anyway.
    await client.query("ROLLBACK").catch(() => {});
    logger.warn("registerModel: transaction failed", { modelType: type, message: error.message });
    return null;
  } finally {
    client.release();
  }
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  // existing
  initAutonomyAuditTable,
  initAutomationAuditTable,
  recordAutonomyDecision,
  initNearMissTable,
  logNearMiss,
  evaluateSavedCapital,
  getNearMisses,

  // new learning components
  initFeatureHistoryTable,
  initDiscoveryLabelsTable,
  initMlModelsTable,
  computeRobustStats,
  upsertFeatureHistory,
  getRegimePerformance,
  getActiveModel,
  registerModel,
};
