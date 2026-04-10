"use strict";

/**
 * ═══════════════════════════════════════════════════════════════
 *  HQS Audit Trail Service
 * ═══════════════════════════════════════════════════════════════
 *
 *  Structured, centralized audit logging with correlation IDs.
 *  Every agent interaction, approval, execution and conference
 *  event is logged here with consistent structure.
 *
 *  Dual-write strategy:
 *    ① In-memory ring buffer for quick access / recent history
 *    ② PostgreSQL table for persistence (when DB is available)
 * ═══════════════════════════════════════════════════════════════
 */

const crypto = require("crypto");
const logger = require("../utils/logger");

/* ─────────────────────────────────────────────
   Constants
   ───────────────────────────────────────────── */

const MAX_AUDIT_ENTRIES = 2000;

const VALID_EVENT_TYPES = [
  "conversation_start",
  "conversation_followup",
  "conversation_end",
  "action_intent_change",
  "proposal_created",
  "patch_prepared",
  "dry_run_executed",
  "execute_requested",
  "execute_approved",
  "execute_rejected",
  "execute_completed",
  "execute_failed",
  "conference_opened",
  "conference_message",
  "conference_agent_reply",
  "conference_closed",
  "agent_error",
  "agent_timeout",
  "agent_empty_response",
  "classification",
  "path_rejected",
  "approval_required",
  "safety_violation",
];

/* ─────────────────────────────────────────────
   In-memory audit ring buffer
   ───────────────────────────────────────────── */

/** @type {Array<object>} */
const _auditLog = [];

/* ─────────────────────────────────────────────
   ID generators
   ───────────────────────────────────────────── */

function generateRequestId() {
  return `req-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function generateTraceId() {
  return `trace-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
}

/* ─────────────────────────────────────────────
   Core audit function
   ───────────────────────────────────────────── */

/**
 * Records an audit event.
 *
 * @param {Object} event
 * @param {string}      event.eventType        - one of VALID_EVENT_TYPES
 * @param {string}      [event.requestId]      - unique request ID
 * @param {string}      [event.traceId]        - correlation / trace ID
 * @param {string}      [event.conversationId] - conversation ID
 * @param {string}      [event.conferenceId]   - conference ID
 * @param {string}      [event.agent]          - agent that handled the event
 * @param {string}      [event.mode]           - agent mode
 * @param {string}      [event.actionIntent]   - action intent
 * @param {string}      [event.safetyLevel]    - safety level
 * @param {boolean}     [event.approved]        - approval state
 * @param {boolean}     [event.dryRun]          - dry-run flag
 * @param {number}      [event.historyLength]   - conversation history length
 * @param {string[]}    [event.changedFiles]    - changed file paths
 * @param {string}      [event.provider]        - AI provider (deepseek / google)
 * @param {string}      [event.model]           - AI model name
 * @param {string}      [event.errorClass]      - error classification
 * @param {string}      [event.errorMessage]    - error detail
 * @param {number}      [event.durationMs]      - request duration
 * @param {object}      [event.metadata]        - arbitrary extra data
 */
function recordAuditEvent(event = {}) {
  const entry = {
    id: crypto.randomBytes(8).toString("hex"),
    timestamp: new Date().toISOString(),
    eventType: event.eventType || "unknown",
    requestId: event.requestId || null,
    traceId: event.traceId || null,
    conversationId: event.conversationId || null,
    conferenceId: event.conferenceId || null,
    agent: event.agent || null,
    mode: event.mode || null,
    actionIntent: event.actionIntent || null,
    safetyLevel: event.safetyLevel || null,
    approved: event.approved ?? null,
    dryRun: event.dryRun ?? null,
    historyLength: event.historyLength ?? null,
    changedFiles: event.changedFiles || null,
    provider: event.provider || null,
    model: event.model || null,
    errorClass: event.errorClass || null,
    errorMessage: event.errorMessage || null,
    durationMs: event.durationMs ?? null,
    metadata: event.metadata || null,
  };

  // In-memory ring buffer
  _auditLog.push(entry);
  if (_auditLog.length > MAX_AUDIT_ENTRIES) {
    _auditLog.splice(0, _auditLog.length - MAX_AUDIT_ENTRIES);
  }

  // Structured log output
  logger.info("[audit]", {
    eventType: entry.eventType,
    requestId: entry.requestId,
    traceId: entry.traceId,
    conversationId: entry.conversationId,
    conferenceId: entry.conferenceId,
    agent: entry.agent,
    actionIntent: entry.actionIntent,
    errorClass: entry.errorClass,
    durationMs: entry.durationMs,
  });

  // Async DB persistence (fire and forget – never blocks the main flow)
  _persistToDb(entry).catch((err) => {
    logger.debug("[audit] db persist failed", { error: String(err.message).slice(0, 80) });
  });

  return entry;
}

/* ─────────────────────────────────────────────
   DB persistence (optional – degrades gracefully)
   ───────────────────────────────────────────── */

let _pool = null;
let _tableChecked = false;

async function _getPool() {
  if (_pool) return _pool;
  try {
    const { getSharedPool } = require("../config/database");
    _pool = getSharedPool();
    return _pool;
  } catch {
    return null;
  }
}

async function _ensureTable(pool) {
  if (_tableChecked) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hqs_audit_log (
        id              TEXT PRIMARY KEY,
        timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        event_type      TEXT NOT NULL,
        request_id      TEXT,
        trace_id        TEXT,
        conversation_id TEXT,
        conference_id   TEXT,
        agent           TEXT,
        mode            TEXT,
        action_intent   TEXT,
        safety_level    TEXT,
        approved        BOOLEAN,
        dry_run         BOOLEAN,
        history_length  INTEGER,
        changed_files   JSONB,
        provider        TEXT,
        model           TEXT,
        error_class     TEXT,
        error_message   TEXT,
        duration_ms     INTEGER,
        metadata        JSONB
      )
    `);
    _tableChecked = true;
  } catch (err) {
    logger.warn("[audit] table creation skipped", { error: String(err.message).slice(0, 100) });
  }
}

async function _persistToDb(entry) {
  const pool = await _getPool();
  if (!pool) return;
  await _ensureTable(pool);
  if (!_tableChecked) return;

  try {
    await pool.query(
      `INSERT INTO hqs_audit_log
        (id, timestamp, event_type, request_id, trace_id, conversation_id, conference_id,
         agent, mode, action_intent, safety_level, approved, dry_run, history_length,
         changed_files, provider, model, error_class, error_message, duration_ms, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        entry.id, entry.timestamp, entry.eventType, entry.requestId, entry.traceId,
        entry.conversationId, entry.conferenceId, entry.agent, entry.mode,
        entry.actionIntent, entry.safetyLevel, entry.approved, entry.dryRun,
        entry.historyLength,
        entry.changedFiles ? JSON.stringify(entry.changedFiles) : null,
        entry.provider, entry.model, entry.errorClass, entry.errorMessage,
        entry.durationMs,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      ],
    );
  } catch {
    // Silently fail – in-memory is the primary store
  }
}

/* ─────────────────────────────────────────────
   Query functions
   ───────────────────────────────────────────── */

function getRecentAuditEvents(limit = 50) {
  return _auditLog.slice(-limit);
}

function getAuditEventsByConversation(conversationId) {
  return _auditLog.filter((e) => e.conversationId === conversationId);
}

function getAuditEventsByConference(conferenceId) {
  return _auditLog.filter((e) => e.conferenceId === conferenceId);
}

function getAuditEventsByType(eventType) {
  return _auditLog.filter((e) => e.eventType === eventType);
}

function getAuditSummary() {
  const byType = {};
  const byAgent = {};
  let errorCount = 0;
  let totalDuration = 0;
  let durationCount = 0;

  for (const entry of _auditLog) {
    byType[entry.eventType] = (byType[entry.eventType] || 0) + 1;
    if (entry.agent) {
      byAgent[entry.agent] = (byAgent[entry.agent] || 0) + 1;
    }
    if (entry.errorClass) errorCount++;
    if (entry.durationMs != null) {
      totalDuration += entry.durationMs;
      durationCount++;
    }
  }

  return {
    totalEvents: _auditLog.length,
    byType,
    byAgent,
    errorCount,
    avgDurationMs: durationCount > 0 ? Math.round(totalDuration / durationCount) : null,
    oldestEvent: _auditLog[0]?.timestamp || null,
    newestEvent: _auditLog[_auditLog.length - 1]?.timestamp || null,
  };
}

/* ─────────────────────────────────────────────
   Exports
   ───────────────────────────────────────────── */

module.exports = {
  recordAuditEvent,
  generateRequestId,
  generateTraceId,
  getRecentAuditEvents,
  getAuditEventsByConversation,
  getAuditEventsByConference,
  getAuditEventsByType,
  getAuditSummary,
  VALID_EVENT_TYPES,
  MAX_AUDIT_ENTRIES,
};
