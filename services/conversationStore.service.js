"use strict";

/**
 * ═══════════════════════════════════════════════════════════════
 *  HQS Persistent Conversation Store
 * ═══════════════════════════════════════════════════════════════
 *
 *  Dual-layer conversation persistence:
 *    ① Fast in-memory Map (always available, primary path)
 *    ② PostgreSQL backing store (survives restarts)
 *
 *  On startup, conversations are loaded from DB into memory.
 *  Every write goes to both layers. If DB is unavailable,
 *  in-memory still works – data just won't survive restart.
 *
 *  Stores conversations for DeepSeek, Gemini, AND conference.
 * ═══════════════════════════════════════════════════════════════
 */

const logger = require("../utils/logger");

/* ─────────────────────────────────────────────
   Constants
   ───────────────────────────────────────────── */

const MAX_CONVERSATIONS = 500;
const MAX_MESSAGES_PER_CONVERSATION = 100;

/* ─────────────────────────────────────────────
   In-memory layer
   ───────────────────────────────────────────── */

/** @type {Map<string, object>} conversationId → conversation */
const _conversations = new Map();

/* ─────────────────────────────────────────────
   DB layer (lazy, non-blocking)
   ───────────────────────────────────────────── */

let _pool = null;
let _tableReady = false;

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

async function _ensureTable() {
  if (_tableReady) return true;
  const pool = await _getPool();
  if (!pool) return false;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hqs_conversations (
        conversation_id TEXT PRIMARY KEY,
        agent           TEXT NOT NULL,
        mode            TEXT,
        status          TEXT NOT NULL DEFAULT 'active',
        action_intent   TEXT,
        approved        BOOLEAN DEFAULT FALSE,
        message_count   INTEGER DEFAULT 0,
        messages        JSONB DEFAULT '[]'::jsonb,
        proposed_changes JSONB,
        prepared_patch  JSONB,
        execution_result JSONB,
        dry_run_result  JSONB,
        conference_id   TEXT,
        metadata        JSONB,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_hqs_conv_agent ON hqs_conversations(agent)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_hqs_conv_status ON hqs_conversations(status)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_hqs_conv_conference ON hqs_conversations(conference_id)
    `);
    _tableReady = true;
    return true;
  } catch (err) {
    logger.warn("[conversationStore] table creation failed", { error: String(err.message).slice(0, 100) });
    return false;
  }
}

/* ─────────────────────────────────────────────
   DB read/write helpers
   ───────────────────────────────────────────── */

async function _dbSave(conv) {
  const pool = await _getPool();
  if (!pool || !(await _ensureTable())) return;
  try {
    await pool.query(
      `INSERT INTO hqs_conversations
        (conversation_id, agent, mode, status, action_intent, approved,
         message_count, messages, proposed_changes, prepared_patch,
         execution_result, dry_run_result, conference_id, metadata,
         created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (conversation_id) DO UPDATE SET
         status = EXCLUDED.status,
         action_intent = EXCLUDED.action_intent,
         approved = EXCLUDED.approved,
         message_count = EXCLUDED.message_count,
         messages = EXCLUDED.messages,
         proposed_changes = EXCLUDED.proposed_changes,
         prepared_patch = EXCLUDED.prepared_patch,
         execution_result = EXCLUDED.execution_result,
         dry_run_result = EXCLUDED.dry_run_result,
         metadata = EXCLUDED.metadata,
         updated_at = EXCLUDED.updated_at`,
      [
        conv.conversationId,
        conv.agent || "unknown",
        conv.mode || null,
        conv.status || "active",
        conv.lastActionIntent || null,
        conv.approved || false,
        conv.messageCount || 0,
        JSON.stringify((conv.messages || []).slice(-MAX_MESSAGES_PER_CONVERSATION)),
        conv.proposedChanges ? JSON.stringify(conv.proposedChanges) : null,
        conv.preparedPatch ? JSON.stringify(conv.preparedPatch) : null,
        conv.executionResult ? JSON.stringify(conv.executionResult) : null,
        conv.dryRunResult ? JSON.stringify(conv.dryRunResult) : null,
        conv.conferenceId || null,
        conv.metadata ? JSON.stringify(conv.metadata) : null,
        conv.createdAt || new Date().toISOString(),
        conv.updatedAt || new Date().toISOString(),
      ],
    );
  } catch (err) {
    logger.warn("[conversationStore] db save failed", {
      conversationId: conv.conversationId,
      error: String(err.message).slice(0, 100),
    });
  }
}

async function _dbLoad(conversationId) {
  const pool = await _getPool();
  if (!pool || !(await _ensureTable())) return null;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM hqs_conversations WHERE conversation_id = $1`,
      [conversationId],
    );
    if (rows.length === 0) return null;
    return _rowToConversation(rows[0]);
  } catch (err) {
    logger.debug("[conversationStore] db load failed", { conversationId, error: String(err.message).slice(0, 100) });
    return null;
  }
}

async function _dbLoadAll(limit = MAX_CONVERSATIONS) {
  const pool = await _getPool();
  if (!pool || !(await _ensureTable())) return [];
  try {
    const { rows } = await pool.query(
      `SELECT * FROM hqs_conversations ORDER BY updated_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map(_rowToConversation);
  } catch (err) {
    logger.debug("[conversationStore] db load all failed", { error: String(err.message).slice(0, 100) });
    return [];
  }
}

function _rowToConversation(row) {
  return {
    conversationId: row.conversation_id,
    agent: row.agent,
    mode: row.mode,
    status: row.status,
    lastActionIntent: row.action_intent,
    approved: row.approved || false,
    messageCount: row.message_count || 0,
    messages: row.messages || [],
    proposedChanges: row.proposed_changes || null,
    preparedPatch: row.prepared_patch || null,
    executionResult: row.execution_result || null,
    dryRunResult: row.dry_run_result || null,
    conferenceId: row.conference_id || null,
    metadata: row.metadata || null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
  };
}

/* ─────────────────────────────────────────────
   Pruning
   ───────────────────────────────────────────── */

function _prune() {
  if (_conversations.size <= MAX_CONVERSATIONS) return;
  const sorted = [..._conversations.entries()].sort(
    (a, b) => new Date(a[1].createdAt) - new Date(b[1].createdAt),
  );
  const toRemove = sorted.length - MAX_CONVERSATIONS;
  for (let i = 0; i < toRemove; i++) {
    _conversations.delete(sorted[i][0]);
  }
}

/* ─────────────────────────────────────────────
   Public API
   ───────────────────────────────────────────── */

/**
 * Initialize the store – loads recent conversations from DB into memory.
 */
async function initialize() {
  const convs = await _dbLoadAll();
  for (const conv of convs) {
    _conversations.set(conv.conversationId, conv);
  }
  logger.info("[conversationStore] initialized", { loaded: convs.length });
}

/**
 * Save a conversation to both layers.
 * @param {object} conversation
 */
async function save(conversation) {
  if (!conversation?.conversationId) return;
  _conversations.set(conversation.conversationId, conversation);
  _prune();
  // Fire-and-forget DB save
  _dbSave(conversation).catch(() => {});
}

/**
 * Get a conversation by ID. Checks memory first, then DB.
 * @param {string} conversationId
 * @returns {Promise<object|null>}
 */
async function get(conversationId) {
  // Memory first
  const memConv = _conversations.get(conversationId);
  if (memConv) return memConv;

  // Try DB
  const dbConv = await _dbLoad(conversationId);
  if (dbConv) {
    _conversations.set(conversationId, dbConv);
    return dbConv;
  }

  return null;
}

/**
 * Get a conversation synchronously (memory only – for backwards compat).
 * @param {string} conversationId
 * @returns {object|null}
 */
function getSync(conversationId) {
  return _conversations.get(conversationId) || null;
}

/**
 * Delete a conversation.
 * @param {string} conversationId
 */
async function remove(conversationId) {
  _conversations.delete(conversationId);
  const pool = await _getPool();
  if (pool && _tableReady) {
    pool.query(`DELETE FROM hqs_conversations WHERE conversation_id = $1`, [conversationId]).catch((err) => {
      logger.debug("[conversationStore] db delete failed", { conversationId, error: String(err.message).slice(0, 100) });
    });
  }
}

/**
 * List conversations with optional filters.
 * @param {Object} [filters]
 * @param {string} [filters.agent]
 * @param {string} [filters.status]
 * @param {number} [filters.limit]
 * @returns {object[]}
 */
function list(filters = {}) {
  let convs = [..._conversations.values()];

  if (filters.agent) {
    convs = convs.filter((c) => c.agent === filters.agent);
  }
  if (filters.status) {
    convs = convs.filter((c) => c.status === filters.status);
  }

  convs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  if (filters.limit) {
    convs = convs.slice(0, filters.limit);
  }

  return convs;
}

/**
 * Get store statistics.
 */
function getStats() {
  const convs = [..._conversations.values()];
  const byAgent = {};
  const byStatus = {};

  for (const c of convs) {
    byAgent[c.agent || "unknown"] = (byAgent[c.agent || "unknown"] || 0) + 1;
    byStatus[c.status || "unknown"] = (byStatus[c.status || "unknown"] || 0) + 1;
  }

  return {
    total: convs.length,
    byAgent,
    byStatus,
    maxCapacity: MAX_CONVERSATIONS,
    dbAvailable: _tableReady,
  };
}

/**
 * Returns number of conversations in memory.
 */
function size() {
  return _conversations.size;
}

/* ─────────────────────────────────────────────
   Exports
   ───────────────────────────────────────────── */

module.exports = {
  initialize,
  save,
  get,
  getSync,
  remove,
  list,
  getStats,
  size,
  MAX_CONVERSATIONS,
  MAX_MESSAGES_PER_CONVERSATION,
};
