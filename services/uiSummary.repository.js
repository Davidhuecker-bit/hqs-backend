"use strict";

/**
 * UI Summary Repository  (Step 3 – Read-Model Layer)
 * ----------------------------------------------------
 * Thin DB layer for the `ui_summaries` table.
 * Stores prepared, compact UI/Read-Model payloads keyed by summary_type.
 *
 * Schema:
 *   ui_summaries (
 *     summary_type      TEXT PRIMARY KEY,
 *     payload           JSONB NOT NULL,
 *     built_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     is_partial        BOOLEAN NOT NULL DEFAULT false,
 *     build_duration_ms INT,
 *     metadata          JSONB
 *   )
 *
 * Summary types:
 *   market_list     → prepared market stock list for /api/market
 *   demo_portfolio  → prepared admin demo portfolio for /api/admin-demo-portfolio
 *   guardian_status → prepared system/guardian status for admin diagnostics
 *
 * Read path:  readUiSummary(type)  → single SELECT, no aggregation
 * Write path: writeUiSummary(type, payload, opts)  → UPSERT after builder completes
 */

const { Pool } = require("pg");
const logger = require("../utils/logger");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let _tableReady = false;
let _tableInitPromise = null;

async function ensureUiSummariesTable() {
  if (_tableReady) return;
  if (!_tableInitPromise) {
    _tableInitPromise = pool
      .query(`
        CREATE TABLE IF NOT EXISTS ui_summaries (
          summary_type      TEXT PRIMARY KEY,
          payload           JSONB NOT NULL,
          built_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          is_partial        BOOLEAN NOT NULL DEFAULT false,
          build_duration_ms INT,
          metadata          JSONB
        )
      `)
      .then(() => {
        _tableReady = true;
      });
  }
  await _tableInitPromise;
}

/**
 * Read a single UI summary by type.
 * Returns null if not found or on DB error (never throws).
 *
 * @param {string} summaryType
 * @returns {Promise<{payload: object, builtAt: string, isPartial: boolean, buildDurationMs: number|null, metadata: object|null}|null>}
 */
async function readUiSummary(summaryType) {
  try {
    await ensureUiSummariesTable();
    const res = await pool.query(
      `SELECT payload, built_at, is_partial, build_duration_ms, metadata
       FROM ui_summaries
       WHERE summary_type = $1`,
      [summaryType]
    );
    if (!res.rows.length) return null;
    const row = res.rows[0];
    return {
      payload:         row.payload,
      builtAt:         row.built_at ? row.built_at.toISOString() : null,
      isPartial:       Boolean(row.is_partial),
      buildDurationMs: row.build_duration_ms ?? null,
      metadata:        row.metadata ?? null,
    };
  } catch (err) {
    logger.warn("[uiSummary] readUiSummary failed", {
      summaryType,
      message: err.message,
    });
    return null;
  }
}

/**
 * Upsert a UI summary.  Never throws – errors are logged and swallowed
 * so that a builder failure never blocks the main request path.
 *
 * @param {string} summaryType
 * @param {object} payload
 * @param {{ isPartial?: boolean, buildDurationMs?: number, metadata?: object }} [opts]
 */
async function writeUiSummary(summaryType, payload, opts = {}) {
  try {
    await ensureUiSummariesTable();
    await pool.query(
      `INSERT INTO ui_summaries
         (summary_type, payload, built_at, is_partial, build_duration_ms, metadata)
       VALUES ($1, $2, NOW(), $3, $4, $5)
       ON CONFLICT (summary_type) DO UPDATE SET
         payload           = EXCLUDED.payload,
         built_at          = NOW(),
         is_partial        = EXCLUDED.is_partial,
         build_duration_ms = EXCLUDED.build_duration_ms,
         metadata          = EXCLUDED.metadata`,
      [
        summaryType,
        JSON.stringify(payload),
        Boolean(opts.isPartial),
        opts.buildDurationMs != null ? Number(opts.buildDurationMs) : null,
        opts.metadata != null ? JSON.stringify(opts.metadata) : null,
      ]
    );
  } catch (err) {
    logger.warn("[uiSummary] writeUiSummary failed", {
      summaryType,
      message: err.message,
    });
  }
}

/**
 * List all summary types with freshness metadata (payloads excluded for brevity).
 * Returns [] on error.
 *
 * @returns {Promise<Array<{summaryType: string, builtAt: string|null, isPartial: boolean, buildDurationMs: number|null, metadata: object|null, ageMs: number}>>}
 */
async function listUiSummaries() {
  try {
    await ensureUiSummariesTable();
    const res = await pool.query(`
      SELECT summary_type, built_at, is_partial, build_duration_ms, metadata
      FROM ui_summaries
      ORDER BY built_at DESC
    `);
    const now = Date.now();
    return res.rows.map((row) => ({
      summaryType:     row.summary_type,
      builtAt:         row.built_at ? row.built_at.toISOString() : null,
      ageMs:           row.built_at ? now - new Date(row.built_at).getTime() : null,
      isPartial:       Boolean(row.is_partial),
      buildDurationMs: row.build_duration_ms ?? null,
      metadata:        row.metadata ?? null,
    }));
  } catch (err) {
    logger.warn("[uiSummary] listUiSummaries failed", { message: err.message });
    return [];
  }
}

module.exports = {
  ensureUiSummariesTable,
  readUiSummary,
  writeUiSummary,
  listUiSummaries,
};
