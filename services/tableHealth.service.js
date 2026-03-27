"use strict";

/**
 * Table Health Diagnostics
 *
 * Checks all 36 production tables and assigns a traffic-light status:
 *   green  = exists, populated, recently written
 *   yellow = exists but sparse or stale
 *   red    = missing / empty / query failed
 *
 * Usage:
 *   const { runTableHealthCheck } = require('./tableHealth.service');
 *   const report = await runTableHealthCheck();
 *   // { overallStatus, green, yellow, red, tables: [...], checkedAt, durationMs }
 */

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = console;
}

const { getSharedPool } = require("../config/database");
const pool = getSharedPool();
// A table with fewer rows is "yellow" unless it also has recent writes
const MIN_ROWS_GREEN  = Number(process.env.TABLE_HEALTH_MIN_ROWS_GREEN  || 5);
const MIN_ROWS_YELLOW = Number(process.env.TABLE_HEALTH_MIN_ROWS_YELLOW || 1);
// Hours without a new row before downgrading to yellow
const STALE_HOURS     = Number(process.env.TABLE_HEALTH_STALE_HOURS     || 48);

// Allowlist of table and column names used by this service.
// Any interpolation into raw SQL is validated against these sets so that
// dynamically constructed identifiers cannot be used for injection.
const ALLOWED_TABLES = new Set([
  // Core market data
  "market_snapshots",
  "market_advanced_metrics",
  "hqs_scores",
  "factor_history",
  "fx_rates",
  // Scoring / outcomes
  "outcome_tracking",
  "agent_forecasts",
  "agents",
  "dynamic_weights",
  // Pipeline / ops
  "pipeline_status",
  "job_locks",
  "admin_snapshots",
  // Universe / scan
  "universe_symbols",
  "universe_scan_state",
  // User / notification
  "briefing_users",
  "briefing_watchlist",
  "user_devices",
  "notifications",
  // News / entity
  "market_news",
  "entity_map",
  // Guardian / autonomy
  "guardian_near_miss",
  "autonomy_audit",
  "automation_audit",
  // Discovery / learning
  "discovery_history",
  "learning_runtime_state",
  // Portfolio
  "virtual_positions",
  // SEC Edgar
  "sec_edgar_companies",
  "sec_edgar_company_facts",
  "sec_edgar_filing_signals",
  // Tech / evolution
  "tech_radar_entries",
  // History / SIS
  "sis_history",
  // Read model
  "ui_summaries",
]);
const ALLOWED_TS_COLUMNS = new Set([
  "created_at", "updated_at", "evaluated_at", "checked_at",
  "last_run_at", "fetched_at", "last_updated", "opened_at",
  "built_at", "published_at",
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

function computeStatus(exists, rowCount, lastTimestampIso, opts = {}) {
  const minGreen  = opts.minRowsGreen  ?? MIN_ROWS_GREEN;
  // Default MIN_ROWS_YELLOW is 1, so `rowCount < 1` is equivalent to
  // the original `rowCount === 0` check for all existing tables.
  const minYellow = opts.minRowsYellow ?? MIN_ROWS_YELLOW;

  if (!exists || rowCount === -1) return "red";
  if (rowCount < minYellow) return "red";

  const isStale =
    lastTimestampIso
      ? (Date.now() - new Date(lastTimestampIso).getTime()) / 3_600_000 > STALE_HOURS
      : false; // unknown timestamp → don't penalise

  if (rowCount >= minGreen && !isStale) return "green";
  return "yellow"; // exists + rows > 0 but sparse or stale
}

// ── table catalogue ──────────────────────────────────────────────────────────

const TABLE_CONFIGS = [
  // ── Core market data ──────────────────────────────────────────────────────
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
    name: "factor_history",
    tsColumns: ["created_at"],
  },
  {
    name: "fx_rates",
    // fx_rates is intentionally sparse – 0 rows is OK if FX_STATIC_USD_EUR is set
    tsColumns: ["fetched_at", "created_at"],
    minRowsGreen:  1,
    minRowsYellow: 0,   // 0 rows = yellow (not red) because fallback env var exists
  },
  // ── Scoring / outcomes ────────────────────────────────────────────────────
  {
    name: "outcome_tracking",
    tsColumns: ["created_at", "evaluated_at"],
  },
  {
    name: "agent_forecasts",
    tsColumns: ["created_at"],
    minRowsGreen:  1,
    minRowsYellow: 0,   // written only when agentic debate runs
  },
  {
    name: "agents",
    // Expected: exactly 3 rows (GROWTH_BIAS, RISK_SKEPTIC, MACRO_JUDGE)
    tsColumns: ["created_at"],
    minRowsGreen:  3,
    minRowsYellow: 1,
  },
  {
    name: "dynamic_weights",
    tsColumns: ["last_updated", "created_at"],
  },
  // ── Pipeline / ops ────────────────────────────────────────────────────────
  {
    name: "pipeline_status",
    // pipeline_status has 5 rows max (one per stage); green = all 5 stages written recently
    tsColumns: ["last_run_at", "updated_at"],
    minRowsGreen:  5,
    minRowsYellow: 1,
  },
  {
    name: "job_locks",
    tsColumns: ["created_at"],
    minRowsGreen:  1,
    minRowsYellow: 0,   // may be empty between job runs
  },
  {
    name: "admin_snapshots",
    tsColumns: ["created_at"],
  },
  // ── Universe / scan ───────────────────────────────────────────────────────
  {
    name: "universe_symbols",
    tsColumns: ["updated_at", "created_at"],
    minRowsGreen:  100, // should have many active symbols
    minRowsYellow: 1,
  },
  {
    name: "universe_scan_state",
    tsColumns: ["updated_at"],
    minRowsGreen:  1,
    minRowsYellow: 0,
  },
  // ── User / notification ───────────────────────────────────────────────────
  {
    name: "briefing_users",
    tsColumns: ["created_at", "updated_at"],
    minRowsGreen:  1,
    minRowsYellow: 0,
  },
  {
    name: "briefing_watchlist",
    tsColumns: ["created_at"],
    minRowsGreen:  1,
    minRowsYellow: 0,
  },
  {
    name: "user_devices",
    tsColumns: ["created_at"],
    minRowsGreen:  1,
    minRowsYellow: 0,
  },
  {
    name: "notifications",
    tsColumns: ["created_at"],
    minRowsGreen:  1,
    minRowsYellow: 0,
  },
  // ── News / entity ─────────────────────────────────────────────────────────
  {
    name: "market_news",
    tsColumns: ["updated_at", "created_at"],
    minRowsGreen: 10,
    minRowsYellow: 1,
  },
  {
    name: "entity_map",
    tsColumns: ["updated_at", "created_at"],
    minRowsGreen: 5,
    minRowsYellow: 0,   // may be empty if buildEntityMap job hasn't run
  },
  // ── Guardian / autonomy ───────────────────────────────────────────────────
  {
    name: "guardian_near_miss",
    tsColumns: ["created_at"],
    minRowsGreen:  1,
    minRowsYellow: 0,
  },
  {
    name: "autonomy_audit",
    tsColumns: ["created_at"],
    minRowsGreen:  1,
    minRowsYellow: 0,   // empty unless autonomous mode is enabled
  },
  {
    name: "automation_audit",
    tsColumns: ["created_at"],
    minRowsGreen:  1,
    minRowsYellow: 0,   // empty unless autonomous mode is enabled
  },
  // ── Discovery / learning ──────────────────────────────────────────────────
  {
    name: "discovery_history",
    tsColumns: ["created_at"],
    minRowsGreen:  5,
    minRowsYellow: 0,
  },
  {
    name: "learning_runtime_state",
    tsColumns: ["updated_at"],
    minRowsGreen:  1,
    minRowsYellow: 0,
  },
  // ── Portfolio ─────────────────────────────────────────────────────────────
  {
    name: "virtual_positions",
    tsColumns: ["updated_at", "opened_at"],
    minRowsGreen:  1,
    minRowsYellow: 0,
  },
  // ── SEC Edgar ─────────────────────────────────────────────────────────────
  {
    name: "sec_edgar_companies",
    tsColumns: ["updated_at", "created_at"],
    minRowsGreen:  1,
    minRowsYellow: 0,   // only populated when SEC feature is active
  },
  {
    name: "sec_edgar_company_facts",
    tsColumns: ["updated_at", "created_at"],
    minRowsGreen:  1,
    minRowsYellow: 0,
  },
  {
    name: "sec_edgar_filing_signals",
    tsColumns: ["created_at"],
    minRowsGreen:  1,
    minRowsYellow: 0,
  },
  // ── Tech / evolution ──────────────────────────────────────────────────────
  {
    name: "tech_radar_entries",
    tsColumns: ["created_at"],
    minRowsGreen:  1,
    minRowsYellow: 0,
  },
  // ── History / SIS ─────────────────────────────────────────────────────────
  {
    name: "sis_history",
    tsColumns: ["created_at"],
    minRowsGreen:  5,
    minRowsYellow: 0,
  },
  // ── Read model ────────────────────────────────────────────────────────────
  {
    name: "ui_summaries",
    tsColumns: ["built_at"],
    minRowsGreen:  3,   // market_list + demo_portfolio + guardian_status
    minRowsYellow: 1,
  },
];

// ── per-table check ──────────────────────────────────────────────────────────

async function checkTable({ name, tsColumns, minRowsGreen, minRowsYellow }) {
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
  const status        = computeStatus(exists, rowCount, lastTimestamp, { minRowsGreen, minRowsYellow });

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
 * Run health checks on all 36 production tables.
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
