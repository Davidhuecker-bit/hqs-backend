"use strict";

/**
 * Data Flow Health Service
 *
 * Provides a comprehensive view of all critical data-flow chains in the system.
 * For each chain it reports:
 *   - lastWriteAt    : most recent row timestamp in the key table
 *   - rowCount       : approximate total row count
 *   - rowCount24h    : rows written/updated in the last 24 hours
 *   - freshnessLabel : fresh | stale | empty
 *   - ageHours       : hours since last write (null if no data)
 *   - writtenBy      : job / service that writes to this table
 *   - readBy         : endpoint / service that reads from this table
 *
 * Chains tracked:
 *   market        – snapshotScan → market_snapshots + hqs_scores → /api/market
 *   portfolio     – market_snapshots + hqs_scores → ui_summaries(demo_portfolio) → /api/admin/demo-portfolio
 *   guardian      – hqs_scores + autonomy_audit → ui_summaries(guardian_status) → /api/admin/guardian-status-summary
 *   world_state   – hqs_scores + market_advanced_metrics → worldState service → /api/admin/world-state
 *   news          – marketNewsRefresh → market_news + entity_map → /api/market-news
 *   pipeline      – snapshotScan → pipeline_status → /api/admin/pipeline-status
 *   ui_summaries  – builders → ui_summaries → /api/market + /api/admin/*
 *   universe      – universeRefresh → universe_symbols → snapshotScan
 *   forecasts     – forecastVerification → agent_forecasts + outcome_tracking → /api/admin/*
 */

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = console;
}

const { getSharedPool } = require("../config/database");
const pool = getSharedPool();
// ── Freshness thresholds (hours) ──────────────────────────────────────────────

const FRESHNESS_THRESHOLDS = {
  market_snapshots:       { staleAfterHours: 2,  criticalAfterHours: 6   },
  hqs_scores:             { staleAfterHours: 2,  criticalAfterHours: 6   },
  market_advanced_metrics:{ staleAfterHours: 4,  criticalAfterHours: 12  },
  factor_history:         { staleAfterHours: 4,  criticalAfterHours: 12  },
  ui_summaries:           { staleAfterHours: 0.25, criticalAfterHours: 1 },
  market_news:            { staleAfterHours: 6,  criticalAfterHours: 24  },
  entity_map:             { staleAfterHours: 24, criticalAfterHours: 72  },
  pipeline_status:        { staleAfterHours: 6,  criticalAfterHours: 24  },
  universe_symbols:       { staleAfterHours: 48, criticalAfterHours: 168 },
  agent_forecasts:        { staleAfterHours: 48, criticalAfterHours: 168 },
  outcome_tracking:       { staleAfterHours: 48, criticalAfterHours: 168 },
};

function classifyFreshness(ageHours, tableName) {
  if (ageHours === null) return "empty";
  const th = FRESHNESS_THRESHOLDS[tableName];
  if (!th) return ageHours < 24 ? "fresh" : ageHours < 72 ? "stale" : "critical";
  if (ageHours < th.staleAfterHours) return "fresh";
  if (ageHours < th.criticalAfterHours) return "stale";
  return "critical";
}

// ── Safe DB helpers ───────────────────────────────────────────────────────────

async function safeQuery(sql, params = []) {
  try {
    const res = await pool.query(sql, params);
    return res.rows;
  } catch (err) {
    logger.warn("[dataFlowHealth] query failed", { sql: sql.slice(0, 80), message: err.message });
    return null;
  }
}

async function tableExists(name) {
  const rows = await safeQuery(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [name]
  );
  return Boolean(rows?.[0]?.exists);
}

async function getTableStats(tableName, tsColumn) {
  if (!(await tableExists(tableName))) {
    return { exists: false, rowCount: 0, rowCount24h: 0, lastWriteAt: null, ageHours: null };
  }

  // Validate tsColumn before interpolation
  const SAFE_TS_COLS = new Set(["created_at", "updated_at", "fetched_at", "built_at", "last_run_at", "last_updated", "opened_at"]);
  const safeCol = SAFE_TS_COLS.has(tsColumn) ? tsColumn : null;

  let rowCount = 0;
  let rowCount24h = 0;
  let lastWriteAt = null;

  const countRows = await safeQuery(`SELECT COUNT(*) AS cnt FROM "${tableName}"`);
  rowCount = Number(countRows?.[0]?.cnt ?? 0);

  if (safeCol) {
    const maxRows = await safeQuery(`SELECT MAX("${safeCol}") AS ts FROM "${tableName}"`);
    const ts = maxRows?.[0]?.ts;
    lastWriteAt = ts ? new Date(ts).toISOString() : null;

    const recentRows = await safeQuery(
      `SELECT COUNT(*) AS cnt FROM "${tableName}" WHERE "${safeCol}" > NOW() - INTERVAL '24 hours'`
    );
    rowCount24h = Number(recentRows?.[0]?.cnt ?? 0);
  }

  const ageHours = lastWriteAt
    ? (Date.now() - new Date(lastWriteAt).getTime()) / 3_600_000
    : null;

  return { exists: true, rowCount, rowCount24h, lastWriteAt, ageHours: ageHours !== null ? Math.round(ageHours * 10) / 10 : null };
}

// ── Chain definitions ─────────────────────────────────────────────────────────

async function buildChain(name, description, tables, writtenBy, readBy) {
  const tableStats = {};
  for (const [tname, tcol] of Object.entries(tables)) {
    const stats = await getTableStats(tname, tcol);
    tableStats[tname] = {
      ...stats,
      freshnessLabel: classifyFreshness(stats.ageHours, tname),
    };
  }

  // The chain freshness is driven by the "most critical" table in the chain
  const allLabels = Object.values(tableStats).map((s) => s.freshnessLabel);
  const overallFreshness =
    allLabels.includes("critical") ? "critical" :
    allLabels.includes("empty")    ? "empty"    :
    allLabels.includes("stale")    ? "stale"    :
    "fresh";

  return { chain: name, description, overallFreshness, tables: tableStats, writtenBy, readBy };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Build a full data-flow health report for all critical chains.
 *
 * @returns {Promise<{
 *   overallHealth: 'fresh'|'stale'|'empty'|'critical',
 *   chains: object[],
 *   generatedAt: string,
 *   durationMs: number
 * }>}
 */
async function getDataFlowHealth() {
  const startMs = Date.now();

  const chains = await Promise.all([

    buildChain(
      "market",
      "Market data pipeline: provider API → snapshots → HQS scores → /api/market",
      {
        market_snapshots:        "created_at",
        hqs_scores:              "created_at",
        market_advanced_metrics: "updated_at",
        factor_history:          "created_at",
      },
      "snapshotScan.job → marketService.buildMarketSnapshot()",
      "/api/market (via ui_summaries:market_list)"
    ),

    buildChain(
      "portfolio",
      "Demo portfolio: market_snapshots + hqs_scores → ui_summaries → /api/admin/demo-portfolio",
      {
        market_snapshots: "created_at",
        hqs_scores:       "created_at",
        ui_summaries:     "built_at",
      },
      "adminDemoPortfolio.service.refreshDemoPortfolio()",
      "/api/admin/demo-portfolio"
    ),

    buildChain(
      "guardian",
      "Guardian status: hqs_scores + pipeline_status → ui_summaries → /api/admin/guardian-status-summary",
      {
        hqs_scores:        "created_at",
        ui_summaries:      "built_at",
      },
      "guardianStatusSummary.builder.refreshGuardianStatusSummary()",
      "/api/admin/guardian-status-summary"
    ),

    buildChain(
      "world_state",
      "World state: hqs_scores + market_advanced_metrics → worldState service → /api/admin/world-state",
      {
        hqs_scores:              "created_at",
        market_advanced_metrics: "updated_at",
      },
      "worldState.service.buildWorldState() (in-memory cache)",
      "/api/admin/world-state"
    ),

    buildChain(
      "news",
      "News intelligence: marketNewsRefresh → market_news + entity_map → /api/market-news",
      {
        market_news: "updated_at",
        entity_map:  "updated_at",
      },
      "marketNewsRefresh.job → marketNews.repository",
      "/api/market-news (newsIntelligence.service)"
    ),

    buildChain(
      "pipeline",
      "Pipeline tracking: snapshotScan writes per-stage counts → pipeline_status → /api/admin/pipeline-status",
      {
        pipeline_status: "last_run_at",
      },
      "pipelineStatus.repository.savePipelineStage() (written by snapshotScan.job)",
      "/api/admin/pipeline-status"
    ),

    buildChain(
      "universe",
      "Universe refresh: universeRefresh job → universe_symbols → snapshotScan cursor",
      {
        universe_symbols:    "updated_at",
        universe_scan_state: "updated_at",
      },
      "universeRefresh.job → universe.repository",
      "snapshotScan.job reads universe_symbols as source list"
    ),

    buildChain(
      "forecasts",
      "Forecasts & outcomes: forecastVerification job → agent_forecasts + outcome_tracking",
      {
        agent_forecasts:  "created_at",
        outcome_tracking: "created_at",
      },
      "forecastVerification.job, opportunityScanner (agent debate)",
      "/api/admin/* (hqs-shadow-meta, hqs-explainability-meta)"
    ),

  ]);

  const allFreshness = chains.map((c) => c.overallFreshness);
  const overallHealth =
    allFreshness.includes("critical") ? "critical" :
    allFreshness.includes("empty")    ? "empty"    :
    allFreshness.includes("stale")    ? "stale"    :
    "fresh";

  return {
    overallHealth,
    chains,
    generatedAt: new Date().toISOString(),
    durationMs:  Date.now() - startMs,
  };
}

module.exports = { getDataFlowHealth };
