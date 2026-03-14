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

const { Pool } = require("pg");
const logger = require("../utils/logger");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS automation_audit (
      id         SERIAL PRIMARY KEY,
      symbol     TEXT,
      action     TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(
    `ALTER TABLE automation_audit ADD COLUMN IF NOT EXISTS saved_capital_potential FLOAT DEFAULT 0.0;`
  );

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
   EXPORTS
========================================================= */

module.exports = {
  initAutonomyAuditTable,
  initAutomationAuditTable,
  recordAutonomyDecision,
  initNearMissTable,
  logNearMiss,
  evaluateSavedCapital,
  getNearMisses,
};
