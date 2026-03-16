"use strict";

/**
 * Table Health Diagnostics
 *
 * Checks the 8 admin-relevant tables and assigns a traffic-light status:
 *   green  = exists, populated, recently written
 *   yellow = exists but sparse or stale
 *   red    = missing / empty / query failed
 *
 * Usage:
 *   const { runTableHealthCheck } = require('./tableHealth.service');
 *   const report = await runTableHealthCheck();
 *   // { overallStatus, green, yellow, red, tables: [...], checkedAt, durationMs }
 */

const { Pool } = require("pg");

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = console;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// A table with fewer rows is "yellow" unless it also has recent writes
const MIN_ROWS_GREEN  = Number(process.env.TABLE_HEALTH_MIN_ROWS_GREEN  || 5);
const MIN_ROWS_YELLOW = Number(process.env.TABLE_HEALTH_MIN_ROWS_YELLOW || 1);
// Hours without a new row before downgrading to yellow
const STALE_HOURS     = Number(process.env.TABLE_HEALTH_STALE_HOURS     || 48);

// Allowlist of table and column names used by this service.
// Any interpolation into raw SQL is validated against these sets so that
// dynamically constructed identifiers cannot be used for injection.
const ALLOWED_TABLES = new Set([
  "market_snapshots",
  "market_advanced_metrics",
  "hqs_scores",
  "outcome_tracking",
  "admin_snapshots",
  "factor_history",
  "weight_history",
  "watchlist_symbols",
]);
const ALLOWED_TS_COLUMNS = new Set([
  "created_at", "updated_at", "evaluated_at", "checked_at",
]);

// ── helpers ─────────────────────────────────────────────────────────────────

async function tableExists(name) {
  try {
    const r = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1
       ) AS exists`,
      [name]
    );
    return Boolean(r.rows?.[0]?.exists);
  } catch (_) {
    return false;
  }
}

async function getRowCount(name) {
  if (!ALLOWED_TABLES.has(name)) {
    logger.warn(`[tableHealth] getRowCount: table '${name}' not in allowlist – skipped`);
    return -1;
  }
  try {
    const r = await pool.query(`SELECT COUNT(*) AS cnt FROM "${name}"`);
    return Number(r.rows?.[0]?.cnt || 0);
  } catch (_) {
    return -1; // signals query failure
  }
}

async function getLastTimestamp(name, candidates) {
  if (!ALLOWED_TABLES.has(name)) return null;

  for (const col of candidates) {
    if (!ALLOWED_TS_COLUMNS.has(col)) continue;

    try {
      const colCheck = await pool.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name   = $1
           AND column_name  = $2`,
        [name, col]
      );
      if (!colCheck.rows.length) continue;

      const r = await pool.query(`SELECT MAX("${col}") AS ts FROM "${name}"`);
      const ts = r.rows?.[0]?.ts;
      if (ts) return new Date(ts).toISOString();
    } catch (_) {
      // try next candidate
    }
  }
  return null;
}

function computeStatus(exists, rowCount, lastTimestampIso) {
  if (!exists || rowCount === -1) return "red";
  if (rowCount === 0) return "red";

  const isStale =
    lastTimestampIso
      ? (Date.now() - new Date(lastTimestampIso).getTime()) / 3_600_000 > STALE_HOURS
      : false; // unknown timestamp → don't penalise

  if (rowCount >= MIN_ROWS_GREEN && !isStale) return "green";
  return "yellow"; // exists + rows > 0 but sparse or stale
}

// ── table catalogue ──────────────────────────────────────────────────────────

const TABLE_CONFIGS = [
  {
    name: "market_snapshots",
    tsColumns: ["created_at"],
  },
  {
    name: "market_advanced_metrics",
    tsColumns: ["updated_at", "created_at"],
  },
  {
    name: "hqs_scores",
    tsColumns: ["created_at"],
  },
  {
    name: "outcome_tracking",
    tsColumns: ["created_at", "evaluated_at"],
  },
  {
    name: "admin_snapshots",
    tsColumns: ["created_at"],
  },
  {
    name: "factor_history",
    tsColumns: ["created_at"],
  },
  {
    name: "weight_history",
    tsColumns: ["created_at"],
  },
  {
    name: "watchlist_symbols",
    tsColumns: ["created_at", "updated_at"],
  },
];

// ── per-table check ──────────────────────────────────────────────────────────

async function checkTable({ name, tsColumns }) {
  const exists = await tableExists(name);

  if (!exists) {
    return {
      table: name,
      exists: false,
      rowCount: 0,
      lastTimestamp: null,
      status: "red",
      detail: "table_missing",
    };
  }

  const rowCount      = await getRowCount(name);
  const lastTimestamp = await getLastTimestamp(name, tsColumns);
  const status        = computeStatus(exists, rowCount, lastTimestamp);

  let detail;
  if (status === "green")  detail = "healthy";
  else if (status === "yellow") {
    const ageH = lastTimestamp
      ? (Date.now() - new Date(lastTimestamp).getTime()) / 3_600_000
      : null;
    detail = (ageH !== null && ageH > STALE_HOURS) ? "stale" : "sparse";
  } else {
    detail = rowCount === 0 ? "empty" : "degraded";
  }

  return { table: name, exists: true, rowCount, lastTimestamp, status, detail };
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Run health checks on all 8 admin-relevant tables.
 * Logs result + per-table status.
 *
 * @returns {Promise<{
 *   overallStatus: 'green'|'yellow'|'red',
 *   green: number, yellow: number, red: number,
 *   tables: Array<object>,
 *   checkedAt: string,
 *   durationMs: number
 * }>}
 */
async function runTableHealthCheck() {
  const startMs = Date.now();
  const tables  = [];
  let green = 0, yellow = 0, red = 0;

  for (const cfg of TABLE_CONFIGS) {
    try {
      const r = await checkTable(cfg);
      tables.push(r);
      if (r.status === "green")        green++;
      else if (r.status === "yellow")  yellow++;
      else                             red++;
    } catch (err) {
      logger.warn(`[tableHealth] error checking ${cfg.name}`, { message: err.message });
      tables.push({
        table: cfg.name,
        exists: false,
        rowCount: 0,
        lastTimestamp: null,
        status: "red",
        detail: "check_failed",
      });
      red++;
    }
  }

  function determineOverallStatus(g, y, r) {
    if (r === 0) return "green";
    if (g > 0 || y > 0) return "yellow";
    return "red";
  }

  const overallStatus = determineOverallStatus(green, yellow, red);
  const checkedAt     = new Date().toISOString();
  const durationMs    = Date.now() - startMs;

  // Structured log so it shows up clearly in Railway/stdout
  logger.info("[tableHealth] check complete", {
    overallStatus,
    green,
    yellow,
    red,
    durationMs,
    tables: tables.map((t) => ({ table: t.table, status: t.status, rowCount: t.rowCount, detail: t.detail })),
  });

  return { overallStatus, green, yellow, red, tables, checkedAt, durationMs };
}

module.exports = { runTableHealthCheck };
