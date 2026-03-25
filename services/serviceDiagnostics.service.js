"use strict";

/**
 * Service Diagnostics  –  Railway Service Mapping & Job Health
 *
 * Provides a single comprehensive endpoint that answers:
 *   1. Which Railway service maps to which job (and its current start command)
 *   2. When each job last ran successfully (from pipeline_status)
 *   3. Which critical tables are fresh / stale / empty
 *   4. Which Pflichtquellen for the demo portfolio are healthy
 *   5. Whether a problem comes from a missing writer, stale data, or wrong mapping
 *
 * Called from:  GET /api/admin/service-diagnostics
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
  max: 3,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1.  SERVICE → JOB MAPPING (source of truth)
// ─────────────────────────────────────────────────────────────────────────────

const SERVICE_MAP = [
  {
    railwayService: "HQS Backend",
    startCommand: "npm start",
    type: "api",
    pipelineStage: null,
    description: "Express API server – the ONLY service that starts server.js",
  },
  {
    railwayService: "Scan Markt Snapshot",
    startCommand: "npm run job:snapshot-scan",
    type: "cron",
    pipelineStage: "snapshot",
    writesTo: ["market_snapshots", "hqs_scores", "market_advanced_metrics", "factor_history", "fx_rates", "pipeline_status"],
    description: "Core market data pipeline: prices, HQS scores, advanced metrics, FX rates",
  },
  {
    railwayService: "Cron Markt-News",
    startCommand: "npm run job:market-news-refresh",
    type: "cron",
    pipelineStage: "market_news_refresh",
    writesTo: ["market_news", "pipeline_status"],
    description: "Market news collection and sentiment scoring",
  },
  {
    railwayService: "cron-entity-map-erstellen",
    startCommand: "npm run job:build-entity-map",
    type: "cron",
    pipelineStage: "build_entity_map",
    writesTo: ["entity_map", "pipeline_status"],
    description: "Sector/industry/theme entity mapping for all symbols",
  },
  {
    railwayService: "Cron Aktien Universum",
    startCommand: "npm run job:universe-refresh",
    type: "cron",
    pipelineStage: "universe_refresh",
    writesTo: ["universe_symbols", "pipeline_status"],
    description: "Universe of tradeable stocks refresh",
  },
  {
    railwayService: "Cron tägliches Briefing",
    startCommand: "npm run job:daily-briefing",
    type: "cron",
    pipelineStage: "daily_briefing",
    writesTo: ["notifications", "pipeline_status"],
    description: "Daily portfolio briefing for all subscribed users",
  },
  {
    railwayService: "Discovery Notify",
    startCommand: "npm run job:discovery-notify",
    type: "cron",
    pipelineStage: "discovery_notify",
    writesTo: ["notifications", "pipeline_status"],
    description: "Push notifications for newly discovered stock picks",
  },
  {
    railwayService: "News Lifecycle Cleanup",
    startCommand: "npm run job:news-lifecycle-cleanup",
    type: "cron",
    pipelineStage: "news_lifecycle_cleanup",
    writesTo: ["market_news", "pipeline_status"],
    description: "Lifecycle state transitions and cleanup for expired market news",
  },
  {
    railwayService: "Forecast Verification",
    startCommand: "npm run job:forecast-verification",
    type: "cron",
    pipelineStage: "forecast_verification",
    writesTo: ["agent_forecasts", "outcome_tracking", "pipeline_status"],
    description: "24h and 7d prediction verification against real market prices",
  },
  {
    railwayService: "Causal Memory",
    startCommand: "npm run job:causal-memory",
    type: "cron",
    pipelineStage: "causal_memory",
    writesTo: ["dynamic_weights", "pipeline_status"],
    description: "Recursive meta-learning: adjusts agent weights from verified forecasts",
  },
  {
    railwayService: "Tech Radar",
    startCommand: "npm run job:tech-radar",
    type: "cron",
    pipelineStage: "tech_radar",
    writesTo: ["tech_radar_entries", "pipeline_status"],
    description: "RSS feed scanning for quant/AI research relevant to HQS",
  },
  {
    railwayService: "Data Cleanup",
    startCommand: "npm run job:data-cleanup",
    type: "cron",
    pipelineStage: "data_cleanup",
    writesTo: ["universe_scan_state", "job_locks", "fx_rates", "pipeline_status"],
    description: "Removes stale scan state rows, expired job locks, old FX rates, audits pipeline staleness",
  },
  {
    railwayService: "UI Market List",
    startCommand: "npm run job:ui-market-list",
    type: "cron",
    pipelineStage: "ui_market_list",
    writesTo: ["ui_summaries", "pipeline_status"],
    description: "Builds and persists market_list UI summary (DB-first writer)",
  },
  {
    railwayService: "UI Demo Portfolio",
    startCommand: "npm run job:ui-demo-portfolio",
    type: "cron",
    pipelineStage: "ui_demo_portfolio",
    writesTo: ["ui_summaries", "pipeline_status"],
    description: "Builds and persists demo_portfolio UI summary (DB-first writer)",
  },
  {
    railwayService: "UI Guardian Status",
    startCommand: "npm run job:ui-guardian-status",
    type: "cron",
    pipelineStage: "ui_guardian_status",
    writesTo: ["ui_summaries", "pipeline_status"],
    description: "Builds and persists guardian_status UI summary (DB-first writer)",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 2.  WRITER → READER MATRIX
// ─────────────────────────────────────────────────────────────────────────────

const WRITER_READER_MATRIX = {
  market_snapshots: {
    writer: "Scan Markt Snapshot (snapshotScan.job.js → marketService.buildMarketSnapshot)",
    readers: ["/api/market", "/api/hqs", "demo_portfolio", "worldState", "portfolioTwin", "forecastVerification (price lookup)"],
    role: "CORE – Pflichtquelle für demo_portfolio",
    staleThresholdHours: 48,
  },
  hqs_scores: {
    writer: "Scan Markt Snapshot (snapshotScan.job.js → hqsEngine)",
    readers: ["/api/market", "/api/hqs", "demo_portfolio", "guardian", "worldState", "opportunityScanner"],
    role: "CORE – Pflichtquelle für demo_portfolio",
    staleThresholdHours: 72,
  },
  factor_history: {
    writer: "Scan Markt Snapshot (snapshotScan.job.js → factorHistory.repository.saveScoreSnapshot)",
    readers: ["/api/admin/hqs-*-meta", "weightHistory", "adminInsights"],
    role: "Supplemental – HQS scoring audit trail",
    staleThresholdHours: 72,
  },
  market_advanced_metrics: {
    writer: "Scan Markt Snapshot (snapshotScan.job.js → advancedMetrics.repository)",
    readers: ["demo_portfolio", "worldState", "opportunityScanner", "regimeDetection"],
    role: "Supplemental – regime/trend/volatility",
    staleThresholdHours: 72,
  },
  market_news: {
    writer: "Cron Markt-News (marketNewsRefresh.job.js → marketNews.repository.upsertMarketNews)",
    readers: ["/api/market-news", "demo_portfolio", "newsIntelligence"],
    role: "Supplemental – news für demo_portfolio (nicht crash-kritisch)",
    staleThresholdHours: 168,
  },
  entity_map: {
    writer: "cron-entity-map-erstellen (buildEntityMap.job.js → entityMap.repository.upsertEntityMapEntries)",
    readers: ["newsIntelligence", "marketNewsRefresh", "sectorTemplate"],
    role: "Supplemental – sector/theme mapping",
    staleThresholdHours: 168,
  },
  ui_summaries: {
    writer: "Dedicated cron jobs (job:ui-market-list, job:ui-demo-portfolio, job:ui-guardian-status)",
    readers: ["/api/market", "/api/admin/demo-portfolio", "/api/admin/guardian-status-summary"],
    role: "PFLICHT Read-model – written by jobs, API reads only (DB-first)",
    staleThresholdHours: 1,
  },
  fx_rates: {
    writer: "Scan Markt Snapshot (snapshotScan.job.js → fx.service.refreshAndPersistFxRate)",
    readers: ["marketService (fallback)", "signalHistory", "discoveryEngine", "adminDemoPortfolio"],
    role: "CORE – USD/EUR conversion für alle EUR-Preise",
    staleThresholdHours: 72,
  },
  pipeline_status: {
    writer: "ALL cron jobs (via savePipelineStage)",
    readers: ["/api/admin/pipeline-status", "guardianStatusSummary", "tableHealth", "dataFlowHealth"],
    role: "Operational – job run tracking",
    staleThresholdHours: null,
  },
  job_locks: {
    writer: "ALL cron jobs (via acquireLock)",
    readers: ["All cron jobs (dedup check)"],
    role: "Operational – job deduplication",
    staleThresholdHours: null,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 3.  EMPTY / PROBLEMATIC TABLE ASSESSMENT
// ─────────────────────────────────────────────────────────────────────────────

const TABLE_ASSESSMENT = {
  agents: {
    status: "expected_empty_or_sparse",
    reason: "Populated by causalMemory.repository on first agent weight adjustment. May be empty until causalMemory job runs with verified forecasts.",
    demoCritical: false,
  },
  agent_forecasts: {
    status: "expected_empty_initially",
    reason: "Populated by agentForecast.repository during agentic debate (embedded in guardianService analysis). Empty until users trigger guardian analysis.",
    demoCritical: false,
  },
  autonomy_audit: {
    status: "expected_empty_initially",
    reason: "Populated by guardianService during live analysis. Expected empty on fresh deploy until guardian is used interactively.",
    demoCritical: false,
  },
  automation_audit: {
    status: "expected_empty_initially",
    reason: "Populated by autonomyAudit.repository. Empty until automated actions occur (future feature scope).",
    demoCritical: false,
  },
  guardian_near_miss: {
    status: "expected_empty_initially",
    reason: "Populated by autonomyAudit.repository.saveNearMiss during guardian analysis when near-miss conditions are detected.",
    demoCritical: false,
  },
  fx_rates: {
    status: "critical_writer_exists",
    reason: "Written by snapshotScan.job.js → fx.service.refreshAndPersistFxRate(). Should have rows if snapshot scan ran at least once.",
    demoCritical: true,
  },
  prices_daily: {
    status: "active",
    reason: "Canonical historical daily close table. Writer: Python Historical Backfill (separate Railway service). Reader: historicalService.getHistoricalPrices → advancedMetrics. Empty until Historical Backfill service has run.",
    demoCritical: false,
  },
  sec_edgar_companies: {
    status: "expected_empty_initially",
    reason: "Populated by SEC Edgar service (on-demand or background). No scheduled cron job populates it. Future expansion scope.",
    demoCritical: false,
  },
  sec_edgar_company_facts: {
    status: "expected_empty_initially",
    reason: "Populated by SEC Edgar service. Future expansion scope.",
    demoCritical: false,
  },
  sec_edgar_filing_signals: {
    status: "expected_empty_initially",
    reason: "Populated by SEC Edgar service. Future expansion scope.",
    demoCritical: false,
  },
  user_devices: {
    status: "expected_empty_initially",
    reason: "Populated when users register push notification devices. Empty until users interact with notification registration.",
    demoCritical: false,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 4.  DEMO PORTFOLIO DEPENDENCY CLASSIFICATION
// ─────────────────────────────────────────────────────────────────────────────

const DEMO_PORTFOLIO_DEPS = {
  pflichtquellen: [
    {
      table: "market_snapshots",
      writerJob: "Scan Markt Snapshot",
      weight: 35,
      description: "Price data – ohne Preis kein Portfolio-Bewertung",
      crashIfEmpty: true,
    },
    {
      table: "hqs_scores",
      writerJob: "Scan Markt Snapshot",
      weight: 35,
      description: "HQS Score – Kernbewertung für jede Aktie",
      crashIfEmpty: false,
      degradedIfEmpty: true,
    },
  ],
  optionaleQuellen: [
    {
      table: "market_advanced_metrics",
      writerJob: "Scan Markt Snapshot",
      weight: 15,
      description: "Regime/Trend/Volatilität – ergänzend, nicht crash-kritisch",
      crashIfEmpty: false,
    },
    {
      table: "market_news",
      writerJob: "Cron Markt-News",
      weight: 15,
      description: "News & Sentiment – ergänzend, nicht crash-kritisch",
      crashIfEmpty: false,
    },
  ],
  nichtCrashKritisch: [
    { table: "entity_map", note: null },
    { table: "factor_history", note: null },
    { table: "fx_rates", note: "Fallback auf statischen Kurs vorhanden" },
    { table: "ui_summaries", note: "Pflicht-Read-Model – geschrieben von job:ui-market-list, job:ui-demo-portfolio, job:ui-guardian-status" },
    { table: "pipeline_status", note: null },
    { table: "job_locks", note: null },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// 5.  DIAGNOSTICS QUERY FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch pipeline_status for all stages.
 */
async function fetchPipelineStatus() {
  try {
    const res = await pool.query(
      `SELECT stage, last_run_at, last_healthy_run, input_count,
              success_count, failed_count, skipped_count, status, error_message
       FROM pipeline_status
       ORDER BY last_run_at DESC NULLS LAST`
    );
    const map = {};
    for (const row of res.rows) {
      map[row.stage] = {
        lastRunAt: row.last_run_at ? row.last_run_at.toISOString() : null,
        lastHealthyRun: row.last_healthy_run ? row.last_healthy_run.toISOString() : null,
        inputCount: Number(row.input_count) || 0,
        successCount: Number(row.success_count) || 0,
        failedCount: Number(row.failed_count) || 0,
        skippedCount: Number(row.skipped_count) || 0,
        status: row.status || "unknown",
        errorMessage: row.error_message || null,
      };
    }
    return map;
  } catch (err) {
    logger.warn("[serviceDiagnostics] fetchPipelineStatus failed", { message: err.message });
    return {};
  }
}

/**
 * Fetch active and recent job locks.
 */
async function fetchJobLocks() {
  try {
    const res = await pool.query(
      `SELECT name, locked_until FROM job_locks ORDER BY locked_until DESC`
    );
    return res.rows.map((r) => ({
      name: r.name,
      lockedUntil: r.locked_until ? r.locked_until.toISOString() : null,
      isActive: r.locked_until ? new Date(r.locked_until) > new Date() : false,
    }));
  } catch (err) {
    logger.warn("[serviceDiagnostics] fetchJobLocks failed", { message: err.message });
    return [];
  }
}

/**
 * Fetch freshness data for critical tables.
 * Table names are from a hardcoded whitelist – validated via SAFE_TABLE_NAMES.
 */
const SAFE_TABLE_NAMES = new Set([
  "market_snapshots", "hqs_scores", "factor_history",
  "market_advanced_metrics", "market_news", "entity_map",
  "ui_summaries", "fx_rates", "pipeline_status", "job_locks",
]);

async function fetchTableFreshness() {
  const tables = [...SAFE_TABLE_NAMES];
  const results = {};

  for (const tbl of tables) {
    if (!SAFE_TABLE_NAMES.has(tbl)) continue;
    // pg identifier quoting: table names are from the hardcoded whitelist above
    // and contain only lowercase letters and underscores.
    const quoted = `"${tbl}"`;
    try {
      const countRes = await pool.query(
        `SELECT COUNT(*) AS cnt FROM ${quoted}`
      );
      const freshRes = await pool.query(
        `SELECT MAX(created_at) AS latest FROM ${quoted}`
      ).catch(() =>
        pool.query(`SELECT MAX(updated_at) AS latest FROM ${quoted}`)
      ).catch(() => ({ rows: [{ latest: null }] }));

      const rowCount = Number(countRes.rows[0]?.cnt) || 0;
      const latestAt = freshRes.rows[0]?.latest
        ? new Date(freshRes.rows[0].latest).toISOString()
        : null;
      const ageHours = latestAt
        ? Math.round((Date.now() - new Date(latestAt).getTime()) / 3600000 * 10) / 10
        : null;

      const threshold = WRITER_READER_MATRIX[tbl]?.staleThresholdHours;
      let freshnessLabel = "unknown";
      if (rowCount === 0) {
        freshnessLabel = "empty";
      } else if (ageHours === null) {
        freshnessLabel = "unknown";
      } else if (threshold && ageHours > threshold) {
        freshnessLabel = "stale";
      } else {
        freshnessLabel = "fresh";
      }

      results[tbl] = { rowCount, latestAt, ageHours, freshnessLabel, threshold };
    } catch (err) {
      results[tbl] = {
        rowCount: 0,
        latestAt: null,
        ageHours: null,
        freshnessLabel: "error",
        error: err.message,
      };
    }
  }
  return results;
}

/**
 * Evaluate demo_portfolio Pflichtquellen health.
 */
function evaluateDemoPortfolioHealth(tableFreshness) {
  const issues = [];
  let overallStatus = "green";

  for (const dep of DEMO_PORTFOLIO_DEPS.pflichtquellen) {
    const tf = tableFreshness[dep.table];
    if (!tf) {
      issues.push({
        table: dep.table,
        severity: "red",
        issue: "Tabelle nicht geprüft / nicht vorhanden",
        diagnosis: "writer_missing_or_table_missing",
      });
      overallStatus = "red";
      continue;
    }
    if (tf.freshnessLabel === "empty") {
      issues.push({
        table: dep.table,
        severity: dep.crashIfEmpty ? "red" : "yellow",
        issue: `Tabelle leer – Writer-Job "${dep.writerJob}" hat noch nicht geschrieben`,
        diagnosis: "writer_never_ran",
      });
      if (dep.crashIfEmpty) overallStatus = "red";
      else if (overallStatus !== "red") overallStatus = "yellow";
      continue;
    }
    if (tf.freshnessLabel === "stale") {
      issues.push({
        table: dep.table,
        severity: "yellow",
        issue: `Daten stale (${tf.ageHours}h alt, Threshold: ${tf.threshold}h) – Job "${dep.writerJob}" läuft nicht regelmäßig`,
        diagnosis: "stale_data",
      });
      if (overallStatus !== "red") overallStatus = "yellow";
      continue;
    }
  }

  for (const dep of DEMO_PORTFOLIO_DEPS.optionaleQuellen) {
    const tf = tableFreshness[dep.table];
    if (!tf || tf.freshnessLabel === "empty") {
      issues.push({
        table: dep.table,
        severity: "info",
        issue: `Optionale Quelle leer/fehlend – Portfolio funktioniert trotzdem`,
        diagnosis: "optional_empty",
      });
    } else if (tf.freshnessLabel === "stale") {
      issues.push({
        table: dep.table,
        severity: "info",
        issue: `Optionale Quelle stale (${tf.ageHours}h) – kein Crash-Risiko`,
        diagnosis: "optional_stale",
      });
    }
  }

  return { overallStatus, issues };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6.  MAIN DIAGNOSTICS FUNCTION
// ─────────────────────────────────────────────────────────────────────────────

async function getServiceDiagnostics() {
  const t0 = Date.now();

  const [pipelineStatus, jobLocks, tableFreshness] = await Promise.all([
    fetchPipelineStatus(),
    fetchJobLocks(),
    fetchTableFreshness(),
  ]);

  // Enrich service map with live pipeline data
  const services = SERVICE_MAP.map((svc) => {
    const ps = svc.pipelineStage ? pipelineStatus[svc.pipelineStage] : null;
    return {
      ...svc,
      lastRun: ps ? {
        lastRunAt: ps.lastRunAt,
        lastHealthyRun: ps.lastHealthyRun,
        inputCount: ps.inputCount,
        successCount: ps.successCount,
        failedCount: ps.failedCount,
        status: ps.status,
        errorMessage: ps.errorMessage,
      } : null,
      tracked: svc.type === "api" ? "n/a" : !!ps,
    };
  });

  // Evaluate demo portfolio health
  const demoHealth = evaluateDemoPortfolioHealth(tableFreshness);

  // Build table assessment with live data
  const emptyTableAssessment = {};
  for (const [tbl, assessment] of Object.entries(TABLE_ASSESSMENT)) {
    const tf = tableFreshness[tbl] || null;
    emptyTableAssessment[tbl] = {
      ...assessment,
      liveRowCount: tf?.rowCount ?? null,
      liveLatestAt: tf?.latestAt ?? null,
      liveFreshness: tf?.freshnessLabel ?? "not_checked",
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,

    // Section 1: Service → Job mapping with live status
    serviceMapping: services,

    // Section 2: Writer → Reader matrix
    writerReaderMatrix: WRITER_READER_MATRIX,

    // Section 3: Critical table freshness
    tableFreshness,

    // Section 4: Demo portfolio health
    demoPortfolio: {
      overallStatus: demoHealth.overallStatus,
      issues: demoHealth.issues,
      dependencies: DEMO_PORTFOLIO_DEPS,
    },

    // Section 5: Empty/problematic table assessment
    emptyTableAssessment,

    // Section 6: Active job locks
    jobLocks,

    // Section 7: Railway setup instructions
    railwaySetupNotes: {
      repoSolved: [
        "start.sh dispatches based on RAILWAY_SERVICE_NAME – no fallback to npm start",
        "All 12 services have npm scripts and standalone job entrypoints",
        "railway.toml uses 'bash start.sh' as global startCommand",
        "Unknown/empty RAILWAY_SERVICE_NAME aborts with exit 1",
        "No job file imports Express or does API warmups",
      ],
      manualRailwaySetup: [
        "Each Railway cron service MUST set RAILWAY_SERVICE_NAME env var to match start.sh case",
        "Each cron service MUST set its own cron schedule in Railway dashboard",
        "healthcheckPath=/health in railway.toml only applies to 'HQS Backend' – Railway will mark cron services as unhealthy (expected, no action needed)",
        "If Railway forces startCommand='npm start' globally, override per-service in Railway dashboard settings",
      ],
    },
  };
}

module.exports = { getServiceDiagnostics, SERVICE_MAP, WRITER_READER_MATRIX, DEMO_PORTFOLIO_DEPS, TABLE_ASSESSMENT };
