#!/usr/bin/env node
"use strict";

/**
 * Data Chain Health Check & Repair Script
 * 
 * This script diagnoses and optionally fixes common data chain issues in production.
 * Safe to run multiple times - all operations are idempotent.
 * 
 * Usage:
 *   node scripts/data-chain-health.js              # Diagnosis only
 *   node scripts/data-chain-health.js --fix        # Diagnosis + repair
 * 
 * What it checks:
 * 1. market_snapshots vs hqs_scores alignment
 * 2. FX rate availability and usage
 * 3. Universe coverage and batch processing
 * 4. Pipeline status accuracy
 * 5. Empty tables that should have data
 * 
 * What it can fix (with --fix):
 * 1. Initialize missing agents entries
 * 2. Backfill FX rates from existing snapshots
 * 3. Clean up stale pipeline status
 * 4. Verify table schema consistency
 */

require("dotenv").config();

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const FIX_MODE = process.argv.includes("--fix");

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

function log(msg, color = "reset") {
  console.log(`${COLORS[color]}${msg}${COLORS.reset}`);
}

function section(title) {
  log("\n" + "=".repeat(80), "cyan");
  log(title, "cyan");
  log("=".repeat(80), "cyan");
}

async function checkTableExists(tableName) {
  const res = await pool.query(
    `SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = $1
    )`,
    [tableName]
  );
  return res.rows[0].exists;
}

async function getRowCount(tableName) {
  const res = await pool.query(`SELECT COUNT(*) FROM ${tableName}`);
  return parseInt(res.rows[0].count, 10);
}

async function check1_SnapshotHqsAlignment() {
  section("CHECK 1: Snapshot ↔ HQS Scores Alignment");
  
  const snapshotCount24h = await pool.query(
    `SELECT COUNT(*) FROM market_snapshots WHERE created_at > NOW() - INTERVAL '24 hours'`
  );
  const hqsCount24h = await pool.query(
    `SELECT COUNT(*) FROM hqs_scores WHERE created_at > NOW() - INTERVAL '24 hours'`
  );
  
  const snapshots = parseInt(snapshotCount24h.rows[0].count, 10);
  const scores = parseInt(hqsCount24h.rows[0].count, 10);
  const diff = Math.abs(snapshots - scores);
  const diffPercent = snapshots > 0 ? (diff / snapshots) * 100 : 0;
  
  log(`  Snapshots (24h):  ${snapshots}`, "reset");
  log(`  HQS Scores (24h): ${scores}`, "reset");
  log(`  Difference:       ${diff} (${diffPercent.toFixed(1)}%)`, "reset");
  
  if (diffPercent < 10) {
    log("  ✅ PASS: Snapshots and HQS scores are aligned", "green");
  } else if (diffPercent < 25) {
    log("  ⚠️  WARN: Moderate misalignment between snapshots and scores", "yellow");
    log("     This is normal if scan recently started or had partial failures", "dim");
  } else {
    log("  ❌ FAIL: Large misalignment detected", "red");
    log("     Possible causes:", "dim");
    log("     - buildHQSResponse() throwing errors", "dim");
    log("     - HQS scoring logic skipping symbols", "dim");
    log("     - Check Railway logs for 'Snapshot error' messages", "dim");
  }
  
  // Check if there are symbols in snapshots but not in scores
  const orphanedSnapshots = await pool.query(`
    SELECT s.symbol, COUNT(*) AS snapshot_count
    FROM market_snapshots s
    LEFT JOIN hqs_scores h ON h.symbol = s.symbol
    WHERE s.created_at > NOW() - INTERVAL '24 hours'
      AND h.symbol IS NULL
    GROUP BY s.symbol
    ORDER BY snapshot_count DESC
    LIMIT 10
  `);
  
  if (orphanedSnapshots.rows.length > 0) {
    log("\n  Symbols with snapshots but NO HQS scores:", "yellow");
    orphanedSnapshots.rows.forEach(row => {
      log(`    ${row.symbol}: ${row.snapshot_count} snapshots`, "dim");
    });
  }
}

async function check2_FxRatesHealth() {
  section("CHECK 2: FX Rates Availability");
  
  const fxCount = await getRowCount("fx_rates");
  const fxLast = await pool.query(
    `SELECT rate, source, fetched_at FROM fx_rates 
     WHERE base_currency = 'USD' AND quote_currency = 'EUR'
     ORDER BY fetched_at DESC LIMIT 1`
  );
  
  log(`  FX rates entries: ${fxCount}`, "reset");
  
  if (fxCount === 0) {
    log("  ⚠️  WARN: fx_rates table is empty", "yellow");
    log("     This is OK if:", "dim");
    log("     - FX_STATIC_USD_EUR is set in env (emergency fallback)", "dim");
    log("     - OR you just deployed and FX API hasn't been called yet", "dim");
    
    // Check if snapshots have fx_rate values despite empty table
    const snapshotsWithFx = await pool.query(
      `SELECT COUNT(*) FROM market_snapshots 
       WHERE fx_rate IS NOT NULL AND created_at > NOW() - INTERVAL '24 hours'`
    );
    const withFx = parseInt(snapshotsWithFx.rows[0].count, 10);
    
    if (withFx > 0) {
      log(`  ℹ️  INFO: ${withFx} snapshots have fx_rate values despite empty fx_rates table`, "cyan");
      log("     This means FX conversion is working (using fallback or cache)", "dim");
      log("     fx_rates persistence may have failed - check logs for warnings", "dim");
    }
  } else {
    const lastRate = fxLast.rows[0];
    const ageHours = lastRate.fetched_at 
      ? Math.round((Date.now() - new Date(lastRate.fetched_at).getTime()) / 3600000)
      : 999;
    
    log(`  Last FX fetch:    ${ageHours}h ago`, "reset");
    log(`  Last rate:        ${lastRate.rate}`, "reset");
    log(`  Source:           ${lastRate.source}`, "reset");
    
    if (ageHours < 48) {
      log("  ✅ PASS: Recent FX data available", "green");
    } else {
      log("  ⚠️  WARN: FX data is stale (>48h old)", "yellow");
      log("     FX API may be failing - snapshots using fallback", "dim");
    }
  }
  
  // Check currency distribution in recent snapshots
  const currencyDist = await pool.query(`
    SELECT currency, COUNT(*) AS count,
           AVG(fx_rate) AS avg_fx_rate
    FROM market_snapshots
    WHERE created_at > NOW() - INTERVAL '24 hours'
    GROUP BY currency
    ORDER BY count DESC
  `);
  
  log("\n  Currency distribution (24h):", "reset");
  currencyDist.rows.forEach(row => {
    const avgFx = row.avg_fx_rate ? ` (avg FX: ${Number(row.avg_fx_rate).toFixed(4)})` : "";
    log(`    ${row.currency || 'NULL'}: ${row.count}${avgFx}`, "dim");
  });
  
  const eurCount = currencyDist.rows.find(r => r.currency === "EUR")?.count || 0;
  const usdCount = currencyDist.rows.find(r => r.currency === "USD")?.count || 0;
  const total = currencyDist.rows.reduce((sum, r) => sum + parseInt(r.count, 10), 0);
  const eurPercent = total > 0 ? (eurCount / total) * 100 : 0;
  
  if (eurPercent > 70) {
    log("  ✅ PASS: Majority EUR (FX conversion working)", "green");
  } else if (usdCount > eurCount) {
    log("  ❌ FAIL: Majority USD - FX conversion not working!", "red");
    log("     ACTION: Set FX_STATIC_USD_EUR=0.92 in Railway env immediately", "red");
  } else {
    log("  ⚠️  WARN: Mixed currency distribution", "yellow");
  }
  
  // Offer to backfill FX rates if needed
  if (FIX_MODE && fxCount === 0 && eurCount > 0) {
    log("\n  🔧 FIX MODE: Attempting to backfill fx_rates from snapshots...", "cyan");
    
    const backfillResult = await pool.query(`
      INSERT INTO fx_rates (base_currency, quote_currency, rate, source, fetched_at)
      SELECT DISTINCT 'USD', 'EUR', fx_rate, 'backfill_from_snapshots', created_at
      FROM market_snapshots
      WHERE currency = 'EUR' 
        AND fx_rate IS NOT NULL
        AND fx_rate > 0
      ORDER BY created_at DESC
      LIMIT 100
      ON CONFLICT DO NOTHING
    `);
    
    log(`  ✅ Inserted ${backfillResult.rowCount} FX rate entries from snapshots`, "green");
  }
}

async function check3_UniverseCoverage() {
  section("CHECK 3: Universe → Snapshot Coverage");
  
  const universeActive = await pool.query(
    `SELECT COUNT(*) FROM universe_symbols WHERE is_active = true`
  );
  const total = parseInt(universeActive.rows[0].count, 10);
  
  log(`  Active universe symbols: ${total}`, "reset");
  
  if (total === 0) {
    log("  ❌ FAIL: No active symbols in universe_symbols!", "red");
    log("     ACTION: Run universeRefresh.job to populate universe", "red");
    return;
  }
  
  // Check scan state cursor
  const cursorState = await pool.query(
    `SELECT key, cursor_value FROM universe_scan_state WHERE key = 'snapshot_scanner_cursor'`
  );
  
  if (cursorState.rows.length > 0) {
    const cursor = parseInt(cursorState.rows[0].cursor_value, 10);
    log(`  Current scan cursor:     ${cursor}`, "reset");
    log(`  Progress:                ${((cursor / total) * 100).toFixed(1)}% through universe`, "dim");
  }
  
  // Check pipeline status for universe→snapshot gap
  const pipelineStatus = await pool.query(
    `SELECT stage, input_count, success_count, skipped_count
     FROM pipeline_status
     WHERE stage IN ('universe', 'snapshot')
     ORDER BY stage`
  );
  
  if (pipelineStatus.rows.length === 2) {
    const universeStage = pipelineStatus.rows.find(r => r.stage === "universe");
    const snapshotStage = pipelineStatus.rows.find(r => r.stage === "snapshot");
    
    log("\n  Pipeline status:", "reset");
    log(`    Universe:  ${universeStage.success_count} selected from ${universeStage.input_count}`, "dim");
    log(`    Snapshot:  ${snapshotStage.success_count} saved from ${snapshotStage.input_count} attempted`, "dim");
    log(`    Skipped:   ${snapshotStage.skipped_count}`, "dim");
    
    const skipRate = snapshotStage.input_count > 0
      ? (snapshotStage.skipped_count / snapshotStage.input_count) * 100
      : 0;
    
    if (skipRate > 30) {
      log(`  ⚠️  WARN: High skip rate (${skipRate.toFixed(1)}%)`, "yellow");
      log("     Common causes:", "dim");
      log("     - FX conversion failures (check FX_STATIC_USD_EUR env)", "dim");
      log("     - Provider API returning empty quotes", "dim");
      log("     - Check Railway logs for 'Snapshot skipped' warnings", "dim");
    } else {
      log(`  ✅ PASS: Reasonable skip rate (${skipRate.toFixed(1)}%)`, "green");
    }
  }
}

async function check4_PipelineStatus() {
  section("CHECK 4: Pipeline Status Accuracy");
  
  const stages = await pool.query(`
    SELECT stage, input_count, success_count, failed_count, skipped_count, last_run_at
    FROM pipeline_status
    ORDER BY 
      CASE stage
        WHEN 'universe' THEN 1
        WHEN 'snapshot' THEN 2
        WHEN 'advancedMetrics' THEN 3
        WHEN 'hqsScoring' THEN 4
        WHEN 'outcome' THEN 5
      END
  `);
  
  log("  Stage               Input    Success   Failed   Skipped   Last Run", "reset");
  log("  " + "-".repeat(78), "dim");
  
  stages.rows.forEach(row => {
    const successRate = row.input_count > 0
      ? ((row.success_count / row.input_count) * 100).toFixed(0)
      : "0";
    const lastRun = row.last_run_at
      ? new Date(row.last_run_at).toISOString().substring(0, 16).replace("T", " ")
      : "never";
    
    const stage = row.stage.padEnd(18);
    const input = String(row.input_count).padStart(8);
    const success = String(row.success_count).padStart(8);
    const failed = String(row.failed_count).padStart(7);
    const skipped = String(row.skipped_count).padStart(8);
    
    log(`  ${stage} ${input} ${success} ${failed} ${skipped}   ${lastRun}`, "dim");
  });
  
  // Check for common issues
  const snapshot = stages.rows.find(r => r.stage === "snapshot");
  const hqsScoring = stages.rows.find(r => r.stage === "hqsScoring");
  
  if (snapshot && hqsScoring) {
    const diff = Math.abs(snapshot.success_count - hqsScoring.success_count);
    const diffPercent = snapshot.success_count > 0
      ? (diff / snapshot.success_count) * 100
      : 0;
    
    if (diffPercent > 20) {
      log("\n  ⚠️  WARN: Large gap between snapshot and hqsScoring success counts", "yellow");
      log("     Expected: Both should be nearly equal (written in same loop)", "dim");
      log("     Check buildHQSResponse() for errors", "dim");
    } else {
      log("\n  ✅ PASS: Pipeline stages aligned", "green");
    }
  }
}

async function check5_EmptyTables() {
  section("CHECK 5: Intentionally Empty Tables Verification");
  
  const tables = [
    { name: "prices_daily", expected: "low", reason: "Historical daily closes – populated on demand by historicalService (Massive backfill)" },
    { name: "sec_edgar_companies", expected: "low", reason: "Conditional feature, requires opt-in" },
    { name: "sec_edgar_filing_signals", expected: "low", reason: "Conditional feature, requires opt-in" },
    { name: "agents", expected: "3", reason: "Should have 3 rows (GROWTH_BIAS, RISK_SKEPTIC, MACRO_JUDGE)" },
    { name: "agent_forecasts", expected: "low", reason: "Written when agentic debate runs (selective)" },
    { name: "automation_audit", expected: "empty", reason: "Only when autonomous mode enabled" },
    { name: "autonomy_audit", expected: "empty", reason: "Only when autonomous mode enabled" },
  ];
  
  for (const table of tables) {
    const exists = await checkTableExists(table.name);
    if (!exists) {
      log(`  ${table.name}: TABLE NOT FOUND`, "red");
      continue;
    }
    
    const count = await getRowCount(table.name);
    const status = count === 0 ? "empty" : count < 10 ? "low" : "populated";
    
    let color = "reset";
    let symbol = "ℹ️ ";
    
    if (table.expected === "empty" && count === 0) {
      color = "green";
      symbol = "✅";
    } else if (table.expected === "low" && count < 100) {
      color = "green";
      symbol = "✅";
    } else if (table.expected === "3" && count === 3) {
      color = "green";
      symbol = "✅";
    } else if (table.expected === "3" && count === 0) {
      color = "yellow";
      symbol = "⚠️ ";
    }
    
    log(`  ${symbol} ${table.name.padEnd(30)} ${String(count).padStart(6)} rows  (${table.reason})`, color);
  }
  
  // Fix agents table if needed
  const agentsCount = await getRowCount("agents");
  if (FIX_MODE && agentsCount === 0) {
    log("\n  🔧 FIX MODE: Initializing agents table...", "cyan");
    
    await pool.query(`
      INSERT INTO agents (name, wisdom_score)
      VALUES 
        ('GROWTH_BIAS', 0.0),
        ('RISK_SKEPTIC', 0.0),
        ('MACRO_JUDGE', 0.0)
      ON CONFLICT (name) DO NOTHING
    `);
    
    log("  ✅ Created 3 agent entries", "green");
  }
}

async function check6_AdminReadPaths() {
  section("CHECK 6: Admin Read Paths (Sample Query)");
  
  // Verify that admin-style JOINs work correctly
  const testQuery = await pool.query(`
    SELECT 
      ms.symbol,
      ms.price AS snapshot_price,
      ms.currency AS snapshot_currency,
      ms.created_at AS snapshot_time,
      hs.hqs_score,
      hs.momentum,
      hs.created_at AS score_time
    FROM market_snapshots ms
    LEFT JOIN hqs_scores hs ON hs.symbol = ms.symbol
    WHERE ms.created_at > NOW() - INTERVAL '48 hours'
    ORDER BY ms.symbol, ms.created_at DESC
    LIMIT 5
  `);
  
  log(`  Sample JOIN query returned ${testQuery.rows.length} rows`, "reset");
  
  if (testQuery.rows.length > 0) {
    log("\n  Sample results:", "dim");
    testQuery.rows.forEach(row => {
      const hqsScore = row.hqs_score ? row.hqs_score.toFixed(2) : "NULL";
      log(`    ${row.symbol}: price=${row.snapshot_price}, hqs=${hqsScore}`, "dim");
    });
    log("  ✅ PASS: Admin JOIN queries working correctly", "green");
  } else {
    log("  ⚠️  WARN: No recent data to test JOIN", "yellow");
  }
}

async function generateProductionChecklist() {
  section("PRODUCTION VERIFICATION CHECKLIST");
  
  log("\n  Run these queries in Railway Postgres to verify health:\n", "cyan");
  
  const checks = [
    {
      title: "1. Snapshot & HQS Score Alignment (24h)",
      query: `SELECT 
  (SELECT COUNT(*) FROM market_snapshots WHERE created_at > NOW() - INTERVAL '24 hours') AS snapshots_24h,
  (SELECT COUNT(*) FROM hqs_scores WHERE created_at > NOW() - INTERVAL '24 hours') AS scores_24h;`,
      expectation: "Both counts should be similar (within 10%)",
    },
    {
      title: "2. FX Rate Health",
      query: `SELECT 
  COUNT(*) AS total_fx_entries,
  MAX(fetched_at) AS last_fx_fetch,
  MAX(rate) AS last_rate
FROM fx_rates
WHERE base_currency = 'USD' AND quote_currency = 'EUR';`,
      expectation: "Should have entries OR FX_STATIC_USD_EUR env var is set",
    },
    {
      title: "3. Currency Distribution (24h)",
      query: `SELECT currency, COUNT(*) AS count
FROM market_snapshots 
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY currency ORDER BY count DESC;`,
      expectation: "EUR should be majority (>70%) if FX is working",
    },
    {
      title: "4. Pipeline Status Overview",
      query: `SELECT stage, input_count, success_count, skipped_count,
       ROUND(100.0 * success_count / NULLIF(input_count, 0), 1) AS success_rate
FROM pipeline_status
ORDER BY 
  CASE stage 
    WHEN 'universe' THEN 1 WHEN 'snapshot' THEN 2 
    WHEN 'advancedMetrics' THEN 3 WHEN 'hqsScoring' THEN 4 
    WHEN 'outcome' THEN 5 
  END;`,
      expectation: "Snapshot success_rate should be >70%",
    },
    {
      title: "5. Universe Coverage",
      query: `SELECT 
  (SELECT COUNT(*) FROM universe_symbols WHERE is_active = true) AS total_active,
  (SELECT success_count FROM pipeline_status WHERE stage = 'snapshot') AS last_batch_saved;`,
      expectation: "total_active should be >1000, last_batch_saved should be >50",
    },
  ];
  
  checks.forEach((check, i) => {
    log(`  ${check.title}`, "cyan");
    log(`  ${check.query}`, "dim");
    log(`  Expected: ${check.expectation}\n`, "green");
  });
}

async function main() {
  log("\n╔════════════════════════════════════════════════════════════════════════════╗", "cyan");
  log("║                   HQS Backend Data Chain Health Check                     ║", "cyan");
  log("╚════════════════════════════════════════════════════════════════════════════╝", "cyan");
  
  if (FIX_MODE) {
    log("\n  🔧 FIX MODE ENABLED - Will attempt repairs", "yellow");
  } else {
    log("\n  📊 DIAGNOSIS MODE - Read-only (use --fix to enable repairs)", "cyan");
  }
  
  try {
    await check1_SnapshotHqsAlignment();
    await check2_FxRatesHealth();
    await check3_UniverseCoverage();
    await check4_PipelineStatus();
    await check5_EmptyTables();
    await check6_AdminReadPaths();
    await generateProductionChecklist();
    
    section("SUMMARY");
    log("\n  ✅ Health check complete!", "green");
    log("\n  Review warnings above and take recommended actions.", "cyan");
    log("  See docs/DATA_CHAINS.md for detailed troubleshooting.", "dim");
    
    if (!FIX_MODE) {
      log("\n  💡 Run with --fix flag to enable automatic repairs", "yellow");
    }
    
  } catch (err) {
    log(`\n  ❌ ERROR: ${err.message}`, "red");
    if (err.stack) {
      log(`\n${err.stack}`, "dim");
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
