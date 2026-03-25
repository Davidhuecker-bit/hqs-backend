#!/usr/bin/env node
"use strict";

/**
 * DB Inventory Script
 *
 * Comprehensive cross-table integrity check for the HQS backend.
 * Checks:
 *   1. All production tables exist
 *   2. Expected columns exist per table
 *   3. Cross-table referential integrity (symbols in hqs_scores ↔ market_snapshots)
 *   4. Orphaned data detection
 *   5. Tables that should be populated but are empty
 *
 * Usage:
 *   node scripts/db-inventory.js              # Full inventory report
 *   node scripts/db-inventory.js --json       # Output as JSON
 *
 * Exit codes:
 *   0 = All checks passed
 *   1 = Connection failed or fatal error
 *   2 = Missing tables
 *   3 = Missing columns
 *   4 = Integrity issues (orphans / unexpected empties)
 */

require("dotenv").config();

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  connectionTimeoutMillis: 15000,
});

const JSON_MODE = process.argv.includes("--json");

// ── Table catalogue with expected columns ─────────────────────────────────────

const TABLE_CATALOGUE = [
  {
    name: "market_snapshots",
    expectedColumns: ["symbol", "price", "currency", "fx_rate", "created_at"],
    populated: "required",
    purpose: "Real-time price/volume snapshots from market data providers",
  },
  {
    name: "hqs_scores",
    expectedColumns: ["symbol", "hqs_score", "created_at"],
    populated: "required",
    purpose: "HQS scoring results calculated from market_snapshots",
  },
  {
    name: "market_advanced_metrics",
    expectedColumns: ["symbol", "updated_at"],
    populated: "required",
    purpose: "Regime/volatility/trend analytics per symbol",
  },
  {
    name: "factor_history",
    expectedColumns: ["symbol", "hqs_score", "created_at"],
    populated: "required",
    purpose: "Persistent factor history for HQS calculation audit trail",
  },
  {
    name: "fx_rates",
    expectedColumns: ["base_currency", "quote_currency", "rate", "fetched_at"],
    populated: "optional",
    purpose: "FX rates (USD/EUR) – may be empty if FX_STATIC_USD_EUR env is set",
  },
  {
    name: "outcome_tracking",
    expectedColumns: ["symbol", "predicted_at"],
    populated: "optional",
    purpose: "Strategy outcome tracking for forecast verification",
  },
  {
    name: "agent_forecasts",
    expectedColumns: ["symbol", "agent_name", "created_at"],
    populated: "optional",
    purpose: "Agent predictions written when agentic debate runs",
  },
  {
    name: "agents",
    expectedColumns: ["name"],
    populated: "required",
    purpose: "Agent definitions (GROWTH_BIAS, RISK_SKEPTIC, MACRO_JUDGE)",
  },
  {
    name: "weight_history",
    expectedColumns: ["created_at"],
    populated: "optional",
    purpose: "Weight adjustment history for HQS scoring",
  },
  {
    name: "dynamic_weights",
    expectedColumns: ["last_updated"],
    populated: "optional",
    purpose: "Causal memory weights for adaptive scoring",
  },
  {
    name: "pipeline_status",
    expectedColumns: ["stage", "last_run_at", "success_count", "updated_at"],
    populated: "required",
    purpose: "Pipeline stage tracking (universe → snapshot → scoring → outcome)",
  },
  {
    name: "job_locks",
    expectedColumns: ["job_name", "created_at"],
    populated: "optional",
    purpose: "Job deduplication locks to prevent concurrent runs",
  },
  {
    name: "admin_snapshots",
    expectedColumns: ["created_at"],
    populated: "optional",
    purpose: "JSONB admin state snapshots for diagnostics",
  },
  {
    name: "universe_symbols",
    expectedColumns: ["symbol", "is_active", "updated_at"],
    populated: "required",
    purpose: "Active stock universe – source for all market data scans",
  },
  {
    name: "universe_scan_state",
    expectedColumns: ["key", "updated_at"],
    populated: "optional",
    purpose: "Universe scan cursor tracking – may be empty before first scan",
  },
  {
    name: "watchlist_symbols",
    expectedColumns: ["symbol"],
    populated: "optional",
    purpose: "User watchlist symbols",
  },
  {
    name: "briefing_users",
    expectedColumns: ["email", "is_active"],
    populated: "optional",
    purpose: "Briefing subscribers",
  },
  {
    name: "briefing_watchlist",
    expectedColumns: ["user_id", "symbol"],
    populated: "optional",
    purpose: "Per-user briefing watchlist symbols",
  },
  {
    name: "user_devices",
    expectedColumns: ["user_id", "fcm_token"],
    populated: "optional",
    purpose: "User push notification devices",
  },
  {
    name: "notifications",
    expectedColumns: ["created_at"],
    populated: "optional",
    purpose: "User notifications",
  },
  {
    name: "market_news",
    expectedColumns: ["symbol", "headline", "updated_at"],
    populated: "required",
    purpose: "News articles with sentiment from FMP API",
  },
  {
    name: "entity_map",
    expectedColumns: ["updated_at"],
    populated: "optional",
    purpose: "News entity mapping – may be empty if buildEntityMap job hasn't run",
  },
  {
    name: "guardian_near_miss",
    expectedColumns: ["created_at"],
    populated: "optional",
    purpose: "Near-miss opportunity records from guardian system",
  },
  {
    name: "autonomy_audit",
    expectedColumns: ["created_at"],
    populated: "optional",
    purpose: "Autonomy audit trail – empty unless autonomous mode is enabled",
  },
  {
    name: "automation_audit",
    expectedColumns: ["created_at"],
    populated: "optional",
    purpose: "Automation tracking – empty unless autonomous mode is enabled",
  },
  {
    name: "discovery_history",
    expectedColumns: ["symbol", "created_at"],
    populated: "optional",
    purpose: "Discovery engine results from opportunity scanner",
  },
  {
    name: "learning_runtime_state",
    expectedColumns: ["key", "updated_at"],
    populated: "optional",
    purpose: "Discovery learning state – may be empty before first cycle",
  },
  {
    name: "virtual_positions",
    expectedColumns: ["symbol", "opened_at"],
    populated: "optional",
    purpose: "Virtual (paper) portfolio positions",
  },
  {
    name: "sec_edgar_companies",
    expectedColumns: ["symbol", "updated_at"],
    populated: "optional",
    purpose: "SEC EDGAR companies – only populated when SEC feature is active",
  },
  {
    name: "sec_edgar_company_facts",
    expectedColumns: ["symbol", "updated_at"],
    populated: "optional",
    purpose: "SEC EDGAR company facts – conditional feature",
  },
  {
    name: "sec_edgar_filing_signals",
    expectedColumns: ["symbol", "created_at"],
    populated: "optional",
    purpose: "SEC filing signals – conditional feature",
  },
  {
    name: "tech_radar_entries",
    expectedColumns: ["created_at"],
    populated: "optional",
    purpose: "Tech radar scan results from innovation scanner",
  },
  {
    name: "sis_history",
    expectedColumns: ["created_at"],
    populated: "optional",
    purpose: "System Intelligence Score history",
  },
  {
    name: "ui_summaries",
    expectedColumns: ["summary_type", "payload", "built_at"],
    populated: "required",
    purpose: "Pre-built UI summary cache for /api/market, /api/admin/demo-portfolio, /api/admin/guardian-status-summary",
  },
];

// ── Cross-table integrity checks ──────────────────────────────────────────────

const INTEGRITY_CHECKS = [
  {
    name: "hqs_scores ↔ market_snapshots symbol overlap (24h)",
    description: "Symbols with HQS scores should have matching snapshots within 24h",
    query: `
      SELECT COUNT(*) AS orphaned_scores
      FROM (
        SELECT DISTINCT symbol FROM hqs_scores
        WHERE created_at > NOW() - INTERVAL '24 hours'
      ) h
      WHERE NOT EXISTS (
        SELECT 1 FROM market_snapshots ms
        WHERE ms.symbol = h.symbol
          AND ms.created_at > NOW() - INTERVAL '24 hours'
      )
    `,
    expectation: "orphaned_scores should be 0 or very low (<5% of total)",
    severityIfFailed: "warning",
  },
  {
    name: "market_snapshots symbols in universe_symbols",
    description: "Symbols with recent snapshots should be present in the active universe",
    query: `
      SELECT COUNT(*) AS unknown_symbols
      FROM (
        SELECT DISTINCT symbol FROM market_snapshots
        WHERE created_at > NOW() - INTERVAL '24 hours'
      ) ms
      WHERE NOT EXISTS (
        SELECT 1 FROM universe_symbols us
        WHERE us.symbol = ms.symbol
      )
    `,
    expectation: "unknown_symbols should be 0 (all scanned symbols come from the universe)",
    severityIfFailed: "warning",
  },
  {
    name: "pipeline_status has all 5 required stages",
    description: "All 5 pipeline stages must be tracked in pipeline_status",
    query: `
      SELECT COUNT(*) AS stage_count FROM pipeline_status
      WHERE stage IN ('universe', 'snapshot', 'advancedMetrics', 'hqsScoring', 'outcome')
    `,
    expectation: "stage_count should be 5",
    severityIfFailed: "error",
    passCondition: (row) => Number(row.stage_count) >= 5,
  },
  {
    name: "ui_summaries has all 3 required types",
    description: "All 3 UI summary types must be present for frontend",
    query: `
      SELECT COUNT(*) AS type_count FROM ui_summaries
      WHERE summary_type IN ('market_list', 'demo_portfolio', 'guardian_status')
    `,
    expectation: "type_count should be 3",
    severityIfFailed: "warning",
    passCondition: (row) => Number(row.type_count) >= 3,
  },
  {
    name: "factor_history ↔ hqs_scores alignment (24h)",
    description: "factor_history should have entries for the same symbols as recent hqs_scores",
    query: `
      SELECT COUNT(*) AS missing_factor_entries
      FROM (
        SELECT DISTINCT symbol FROM hqs_scores
        WHERE created_at > NOW() - INTERVAL '24 hours'
      ) hs
      WHERE NOT EXISTS (
        SELECT 1 FROM factor_history fh
        WHERE fh.symbol = hs.symbol
          AND fh.created_at > NOW() - INTERVAL '48 hours'
      )
    `,
    expectation: "missing_factor_entries should be 0 or very low",
    severityIfFailed: "warning",
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function color(str, code) {
  if (JSON_MODE) return str;
  return `\x1b[${code}m${str}\x1b[0m`;
}

const c = {
  green:  (s) => color(s, 32),
  yellow: (s) => color(s, 33),
  red:    (s) => color(s, 31),
  cyan:   (s) => color(s, 36),
  dim:    (s) => color(s, 2),
};

function log(msg) {
  if (!JSON_MODE) console.log(msg);
}

function section(title) {
  log("\n" + c.cyan("=".repeat(72)));
  log(c.cyan(title));
  log(c.cyan("=".repeat(72)));
}

async function checkTableExists(tableName) {
  const res = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return Boolean(res.rows[0].exists);
}

async function getExistingColumns(tableName) {
  const res = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  return res.rows.map((r) => r.column_name);
}

async function getRowCount(tableName) {
  try {
    const res = await pool.query(`SELECT COUNT(*) AS cnt FROM "${tableName}"`);
    return Number(res.rows[0].cnt);
  } catch (_) {
    return -1;
  }
}

// ── Checks ────────────────────────────────────────────────────────────────────

async function checkAllTablesExist(catalogue) {
  section("CHECK 1: Table Existence");
  const results = [];

  for (const entry of catalogue) {
    const exists = await checkTableExists(entry.name);
    const icon = exists ? c.green("✅") : c.red("❌");
    log(`  ${icon} ${entry.name.padEnd(35)} ${c.dim(entry.purpose)}`);
    results.push({ table: entry.name, exists, purpose: entry.purpose });
  }

  const missing = results.filter((r) => !r.exists);
  if (missing.length === 0) {
    log(c.green(`\n  ✅ All ${catalogue.length} tables exist`));
  } else {
    log(c.red(`\n  ❌ ${missing.length} table(s) missing: ${missing.map((r) => r.name).join(", ")}`));
  }
  return results;
}

async function checkAllColumns(catalogue) {
  section("CHECK 2: Expected Column Existence");
  const results = [];

  for (const entry of catalogue) {
    const exists = await checkTableExists(entry.name);
    if (!exists) {
      results.push({ table: entry.name, exists: false, missingColumns: entry.expectedColumns });
      continue;
    }

    const actualCols = await getExistingColumns(entry.name);
    const actualSet  = new Set(actualCols);
    const missing    = entry.expectedColumns.filter((c) => !actualSet.has(c));

    if (missing.length === 0) {
      log(`  ${c.green("✅")} ${entry.name}`);
    } else {
      log(`  ${c.red("❌")} ${entry.name}: missing columns [${missing.join(", ")}]`);
    }
    results.push({ table: entry.name, exists: true, missingColumns: missing, actualColumns: actualCols });
  }

  const withMissing = results.filter((r) => r.missingColumns.length > 0);
  if (withMissing.length === 0) {
    log(c.green(`\n  ✅ All expected columns present in all existing tables`));
  } else {
    log(c.red(`\n  ❌ ${withMissing.length} table(s) have missing columns`));
  }
  return results;
}

async function checkPopulationStatus(catalogue) {
  section("CHECK 3: Population Status");
  const results = [];

  for (const entry of catalogue) {
    const exists = await checkTableExists(entry.name);
    if (!exists) {
      results.push({ table: entry.name, exists: false, rowCount: 0, status: "missing" });
      continue;
    }

    const rowCount = await getRowCount(entry.name);

    let status;
    let icon;
    if (entry.populated === "required" && rowCount === 0) {
      status = "empty_required";
      icon = c.red("❌");
    } else if (rowCount === 0) {
      status = "empty_optional";
      icon = c.yellow("⚪");
    } else {
      status = "populated";
      icon = c.green("✅");
    }

    const reqLabel = entry.populated === "required" ? c.red(" [REQUIRED]") : c.dim(" [optional]");
    log(`  ${icon} ${entry.name.padEnd(35)} ${String(rowCount).padStart(7)} rows${reqLabel}`);
    results.push({ table: entry.name, exists: true, rowCount, status, populated: entry.populated });
  }

  const emptyRequired = results.filter((r) => r.status === "empty_required");
  if (emptyRequired.length === 0) {
    log(c.green(`\n  ✅ All required tables are populated`));
  } else {
    log(c.red(`\n  ❌ Required tables that are empty: ${emptyRequired.map((r) => r.table).join(", ")}`));
    log(c.dim("     These tables need data before the system can function correctly."));
  }
  return results;
}

async function runIntegrityChecks() {
  section("CHECK 4: Cross-Table Referential Integrity");
  const results = [];

  for (const check of INTEGRITY_CHECKS) {
    try {
      const res  = await pool.query(check.query);
      const row  = res.rows[0];
      const pass = check.passCondition ? check.passCondition(row) : Object.values(row).every((v) => Number(v) === 0);

      const icon = pass ? c.green("✅") : (check.severityIfFailed === "error" ? c.red("❌") : c.yellow("⚠️ "));
      log(`  ${icon} ${check.name}`);
      if (!pass) {
        log(`     ${c.dim(check.description)}`);
        log(`     Result: ${JSON.stringify(row)}  |  Expected: ${c.yellow(check.expectation)}`);
      }
      results.push({ check: check.name, pass, row, severityIfFailed: check.severityIfFailed });
    } catch (err) {
      log(`  ${c.yellow("⚠️ ")} ${check.name}: ${c.dim(`SKIPPED (${err.message})`)}`);
      results.push({ check: check.name, pass: null, error: err.message });
    }
  }
  return results;
}

// ── Summary ───────────────────────────────────────────────────────────────────

function printSummary(tableExistence, columnChecks, populationChecks, integrityChecks) {
  section("SUMMARY");

  const missingTables  = tableExistence.filter((r) => !r.exists);
  const missingCols    = columnChecks.filter((r) => r.missingColumns?.length > 0);
  const emptyRequired  = populationChecks.filter((r) => r.status === "empty_required");
  const integrityFails = integrityChecks.filter((r) => r.pass === false && r.severityIfFailed === "error");
  const integrityWarns = integrityChecks.filter((r) => r.pass === false && r.severityIfFailed !== "error");

  const lines = [
    `  Tables checked:      ${tableExistence.length}`,
    `  Missing tables:      ${missingTables.length}  ${missingTables.length > 0 ? c.red("← ACTION REQUIRED") : c.green("✅")}`,
    `  Missing columns:     ${missingCols.length}  ${missingCols.length > 0 ? c.red("← ACTION REQUIRED") : c.green("✅")}`,
    `  Empty required:      ${emptyRequired.length}  ${emptyRequired.length > 0 ? c.red("← ACTION REQUIRED") : c.green("✅")}`,
    `  Integrity errors:    ${integrityFails.length}  ${integrityFails.length > 0 ? c.red("← ACTION REQUIRED") : c.green("✅")}`,
    `  Integrity warnings:  ${integrityWarns.length}  ${integrityWarns.length > 0 ? c.yellow("← review recommended") : c.green("✅")}`,
  ];
  lines.forEach((l) => log(l));

  const hasErrors = missingTables.length + missingCols.length + emptyRequired.length + integrityFails.length > 0;
  const hasWarnings = integrityWarns.length > 0;

  if (!hasErrors && !hasWarnings) {
    log(c.green("\n  🏥 INVENTORY STATUS: HEALTHY"));
  } else if (!hasErrors) {
    log(c.yellow("\n  🏥 INVENTORY STATUS: WARNINGS (review recommended, no critical failures)"));
  } else {
    log(c.red("\n  🏥 INVENTORY STATUS: ISSUES DETECTED (action required)"));
    if (missingTables.length > 0) {
      log(c.red("     → Missing tables: Start the backend to trigger CREATE TABLE IF NOT EXISTS init"));
    }
    if (emptyRequired.length > 0) {
      log(c.red(`     → Empty required tables: ${emptyRequired.map((r) => r.table).join(", ")}`));
      log(c.dim("       Run background jobs or trigger the snapshot scan to populate these tables"));
    }
  }

  log("");
  return { hasErrors, hasWarnings };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log(c.cyan("╔══════════════════════════════════════════════════════════════════════════╗"));
  log(c.cyan("║              HQS Backend – DB Inventory & Integrity Check              ║"));
  log(c.cyan("╚══════════════════════════════════════════════════════════════════════════╝"));

  if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL environment variable not set");
    process.exit(1);
  }

  let exitCode = 0;

  try {
    // Connection test
    await pool.query("SELECT 1");
    log(c.green("\n  ✅ Database connection OK"));

    const tableResults     = await checkAllTablesExist(TABLE_CATALOGUE);
    const columnResults    = await checkAllColumns(TABLE_CATALOGUE);
    const populationResults = await checkPopulationStatus(TABLE_CATALOGUE);
    const integrityResults = await runIntegrityChecks();

    const { hasErrors, hasWarnings } = printSummary(
      tableResults, columnResults, populationResults, integrityResults
    );

    if (JSON_MODE) {
      console.log(JSON.stringify({
        checkedAt:       new Date().toISOString(),
        tableResults,
        columnResults,
        populationResults,
        integrityResults,
        summary: { hasErrors, hasWarnings },
      }, null, 2));
    }

    const missingTables = tableResults.filter((r) => !r.exists);
    const missingCols   = columnResults.filter((r) => r.missingColumns?.length > 0);
    const emptyRequired = populationResults.filter((r) => r.status === "empty_required");

    if (missingTables.length > 0)  exitCode = 2;
    else if (missingCols.length > 0) exitCode = 3;
    else if (emptyRequired.length > 0) exitCode = 4;

  } catch (err) {
    console.error(c.red(`\n  ❌ Fatal error: ${err.message}`));
    if (err.stack) console.error(c.dim(err.stack));
    exitCode = 1;
  } finally {
    await pool.end();
  }

  process.exit(exitCode);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
}

module.exports = { TABLE_CATALOGUE, INTEGRITY_CHECKS };
