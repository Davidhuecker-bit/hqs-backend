"use strict";

/**
 * Change Memory Light – Repository
 *
 * Persists diagnostic cases from Change Intelligence analysis
 * so the HQS system can learn from past diagnoses over time.
 *
 * Schema (created on first use):
 *   change_memory (
 *     id              SERIAL PRIMARY KEY,
 *     created_at      TIMESTAMPTZ DEFAULT NOW(),
 *     updated_at      TIMESTAMPTZ DEFAULT NOW(),
 *     changed_files   JSONB DEFAULT '[]',
 *     logs            JSONB DEFAULT '[]',
 *     error_message   TEXT,
 *     affected_area   TEXT,
 *     suspected_files JSONB DEFAULT '[]',
 *     notes           TEXT,
 *     analysis_result JSONB,
 *     risk_level      TEXT,
 *     was_helpful     BOOLEAN,
 *     final_fix       TEXT,
 *     status          TEXT DEFAULT 'new',
 *     tags            JSONB DEFAULT '[]'
 *   )
 */

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = console;
}

const { getSharedPool } = require("../config/database");
const pool = getSharedPool();

let tableReady = false;
let tableInitPromise = null;

/* ─────────────────────────────────────────────
   Table initialisation
   ───────────────────────────────────────────── */

async function initChangeMemoryTable() {
  if (tableReady) return;
  if (!tableInitPromise) {
    tableInitPromise = pool
      .query(
        `
      CREATE TABLE IF NOT EXISTS change_memory (
        id              SERIAL PRIMARY KEY,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        changed_files   JSONB DEFAULT '[]'::jsonb,
        logs            JSONB DEFAULT '[]'::jsonb,
        error_message   TEXT,
        affected_area   TEXT,
        suspected_files JSONB DEFAULT '[]'::jsonb,
        notes           TEXT,
        analysis_result JSONB,
        risk_level      TEXT DEFAULT 'medium',
        was_helpful     BOOLEAN,
        final_fix       TEXT,
        status          TEXT NOT NULL DEFAULT 'new',
        tags            JSONB DEFAULT '[]'::jsonb
      )
      `
      )
      .then(() =>
        pool.query(`
        CREATE INDEX IF NOT EXISTS ix_change_memory_status
          ON change_memory(status);
        CREATE INDEX IF NOT EXISTS ix_change_memory_risk_level
          ON change_memory(risk_level);
        CREATE INDEX IF NOT EXISTS ix_change_memory_created_at
          ON change_memory(created_at DESC);
      `)
      )
      .then(() => {
        tableReady = true;
        if (logger?.info) logger.info("[changeMemory] change_memory table ready");
      });
  }
  await tableInitPromise;
}

/* ─────────────────────────────────────────────
   Helpers
   ───────────────────────────────────────────── */

/** Safely serialise a value to JSONB-compatible string. */
function toJsonb(value, fallback = "[]") {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    // Already a JSON string – validate it
    try {
      JSON.parse(value);
      return value;
    } catch (_) {
      return fallback;
    }
  }
  try {
    return JSON.stringify(value);
  } catch (_) {
    return fallback;
  }
}

/** Coerce to trimmed string or null. */
function toText(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s || null;
}

const VALID_STATUSES = ["new", "reviewed", "resolved"];
const VALID_RISK_LEVELS = ["low", "medium", "high"];

/* ─────────────────────────────────────────────
   CRUD functions
   ───────────────────────────────────────────── */

/**
 * Save a new Change Memory entry.
 *
 * @param {Object} payload
 * @returns {Promise<Object>} the inserted row (camelCase)
 */
async function saveChangeMemoryEntry(payload = {}) {
  await initChangeMemoryTable();

  const changedFiles = toJsonb(payload.changedFiles, "[]");
  const logs = toJsonb(payload.logs, "[]");
  const errorMessage = toText(payload.errorMessage);
  const affectedArea = toText(payload.affectedArea);
  const suspectedFiles = toJsonb(payload.suspectedFiles, "[]");
  const notes = toText(payload.notes);
  const analysisResult = toJsonb(payload.analysisResult, "null");
  const riskLevel = VALID_RISK_LEVELS.includes(toText(payload.riskLevel))
    ? toText(payload.riskLevel)
    : "medium";
  const status = VALID_STATUSES.includes(toText(payload.status))
    ? toText(payload.status)
    : "new";
  const tags = toJsonb(payload.tags, "[]");

  const res = await pool.query(
    `INSERT INTO change_memory
       (changed_files, logs, error_message, affected_area, suspected_files,
        notes, analysis_result, risk_level, status, tags,
        created_at, updated_at)
     VALUES ($1::jsonb, $2::jsonb, $3, $4, $5::jsonb,
             $6, $7::jsonb, $8, $9, $10::jsonb,
             NOW(), NOW())
     RETURNING *`,
    [
      changedFiles,
      logs,
      errorMessage,
      affectedArea,
      suspectedFiles,
      notes,
      analysisResult,
      riskLevel,
      status,
      tags,
    ]
  );

  const row = res.rows[0];
  return mapRow(row);
}

/**
 * List Change Memory entries with optional filters.
 *
 * @param {Object} [filters]
 * @param {string} [filters.status]
 * @param {string} [filters.riskLevel]
 * @param {boolean|string} [filters.wasHelpful]
 * @param {number} [filters.limit]
 * @returns {Promise<Object[]>}
 */
async function listChangeMemoryEntries(filters = {}) {
  await initChangeMemoryTable();

  const conditions = [];
  const params = [];
  let idx = 1;

  if (filters.status && VALID_STATUSES.includes(filters.status)) {
    conditions.push(`status = $${idx++}`);
    params.push(filters.status);
  }

  if (filters.riskLevel && VALID_RISK_LEVELS.includes(filters.riskLevel)) {
    conditions.push(`risk_level = $${idx++}`);
    params.push(filters.riskLevel);
  }

  if (filters.wasHelpful !== undefined && filters.wasHelpful !== null && filters.wasHelpful !== "") {
    const boolVal = filters.wasHelpful === "true" || filters.wasHelpful === true;
    conditions.push(`was_helpful = $${idx++}`);
    params.push(boolVal);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);

  const res = await pool.query(
    `SELECT id, created_at, risk_level, affected_area, error_message,
            status, was_helpful
     FROM change_memory
     ${where}
     ORDER BY created_at DESC
     LIMIT ${limit}`,
    params
  );

  return res.rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at ? row.created_at.toISOString() : null,
    riskLevel: row.risk_level || null,
    affectedArea: row.affected_area || null,
    errorMessage: row.error_message || null,
    status: row.status || "new",
    wasHelpful: row.was_helpful ?? null,
  }));
}

/**
 * Get a single Change Memory entry by ID.
 *
 * @param {number|string} id
 * @returns {Promise<Object|null>}
 */
async function getChangeMemoryEntryById(id) {
  await initChangeMemoryTable();

  const numId = Number(id);
  if (!numId || numId < 1) return null;

  const res = await pool.query(
    `SELECT * FROM change_memory WHERE id = $1`,
    [numId]
  );

  if (!res.rows.length) return null;
  return mapRow(res.rows[0]);
}

/**
 * Update feedback fields on an existing Change Memory entry.
 *
 * @param {number|string} id
 * @param {Object} payload
 * @param {boolean}  [payload.wasHelpful]
 * @param {string}   [payload.finalFix]
 * @param {string}   [payload.status]
 * @param {string}   [payload.notes]
 * @returns {Promise<Object|null>} updated row or null if not found
 */
async function updateChangeMemoryFeedback(id, payload = {}) {
  await initChangeMemoryTable();

  const numId = Number(id);
  if (!numId || numId < 1) return null;

  const sets = [];
  const params = [];
  let idx = 1;

  if (payload.wasHelpful !== undefined && payload.wasHelpful !== null) {
    sets.push(`was_helpful = $${idx++}`);
    params.push(payload.wasHelpful === true || payload.wasHelpful === "true");
  }

  if (payload.finalFix !== undefined) {
    sets.push(`final_fix = $${idx++}`);
    params.push(toText(payload.finalFix));
  }

  if (payload.status && VALID_STATUSES.includes(payload.status)) {
    sets.push(`status = $${idx++}`);
    params.push(payload.status);
  }

  if (payload.notes !== undefined) {
    sets.push(`notes = $${idx++}`);
    params.push(toText(payload.notes));
  }

  if (!sets.length) return getChangeMemoryEntryById(numId);

  sets.push(`updated_at = NOW()`);
  params.push(numId);

  const res = await pool.query(
    `UPDATE change_memory
     SET ${sets.join(", ")}
     WHERE id = $${idx}
     RETURNING *`,
    params
  );

  if (!res.rows.length) return null;
  return mapRow(res.rows[0]);
}

/* ─────────────────────────────────────────────
   Row mapper (DB → camelCase)
   ───────────────────────────────────────────── */

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at ? row.created_at.toISOString() : null,
    updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
    changedFiles: row.changed_files ?? [],
    logs: row.logs ?? [],
    errorMessage: row.error_message ?? null,
    affectedArea: row.affected_area ?? null,
    suspectedFiles: row.suspected_files ?? [],
    notes: row.notes ?? null,
    analysisResult: row.analysis_result ?? null,
    riskLevel: row.risk_level ?? null,
    wasHelpful: row.was_helpful ?? null,
    finalFix: row.final_fix ?? null,
    status: row.status ?? "new",
    tags: row.tags ?? [],
  };
}

/* ─────────────────────────────────────────────
   Exports
   ───────────────────────────────────────────── */

module.exports = {
  initChangeMemoryTable,
  saveChangeMemoryEntry,
  listChangeMemoryEntries,
  getChangeMemoryEntryById,
  updateChangeMemoryFeedback,
};
