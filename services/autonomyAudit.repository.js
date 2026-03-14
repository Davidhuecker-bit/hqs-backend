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
   EXPORTS
========================================================= */

module.exports = {
  initAutonomyAuditTable,
  recordAutonomyDecision,
};
