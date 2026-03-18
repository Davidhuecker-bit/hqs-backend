#!/usr/bin/env node
"use strict";

/**
 * Database Health Check Script
 * 
 * Comprehensive verification of:
 * 1. DATABASE_URL connection
 * 2. All 35 tables exist
 * 3. Tables are reachable (can query)
 * 4. Tables have data (row counts)
 * 5. Recent activity (last insert/update timestamp)
 * 
 * Usage:
 *   node scripts/database-health-check.js
 * 
 * Exit codes:
 *   0 = All healthy
 *   1 = Connection failed
 *   2 = Some tables missing
 *   3 = Some tables unreachable
 */

const { Pool } = require("pg");

// All 35 tables that should exist
const ALL_TABLES = [
  'admin_snapshots',
  'agent_forecasts',
  'agents',
  'automation_audit',
  'autonomy_audit',
  'briefing_users',
  'briefing_watchlist',
  'discovery_history',
  'dynamic_weights',
  'entity_map',
  'factor_history',
  'fx_rates',
  'guardian_near_miss',
  'hqs_scores',
  'job_locks',
  'learning_runtime_state',
  'market_advanced_metrics',
  'market_news',
  'market_snapshots',
  'notifications',
  'outcome_tracking',
  'pipeline_status',
  'sec_edgar_companies',
  'sec_edgar_company_facts',
  'sec_edgar_filing_signals',
  'sis_history',
  'snapshot_scan_state',
  'system_evolution_proposals',
  'tech_radar_entries',
  'universe_scan_state',
  'universe_symbols',
  'user_devices',
  'virtual_positions',
  'watchlist_symbols',
  'weight_history',
];

const TIMESTAMP_COLUMNS = [
  'created_at',
  'updated_at',
  'last_updated',
  'checked_at',
  'evaluated_at',
  'predicted_at',
  'fetched_at',
  'last_run_at',
];

async function checkDatabaseConnection() {
  console.log('🔍 Checking DATABASE_URL connection...');
  
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL environment variable not set');
    return null;
  }
  
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: 10000,
  });
  
  try {
    const result = await pool.query('SELECT NOW() as now, version() as version');
    console.log('✅ Database connected successfully');
    console.log(`   PostgreSQL version: ${result.rows[0].version.split(',')[0]}`);
    console.log(`   Server time: ${result.rows[0].now}`);
    return pool;
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    return null;
  }
}

async function checkTableExists(pool, tableName) {
  try {
    const result = await pool.query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1
      ) AS exists`,
      [tableName]
    );
    return result.rows[0].exists;
  } catch (error) {
    console.error(`   Error checking ${tableName}:`, error.message);
    return false;
  }
}

async function getRowCount(pool, tableName) {
  try {
    const result = await pool.query(`SELECT COUNT(*) as count FROM "${tableName}"`);
    return parseInt(result.rows[0].count, 10);
  } catch (error) {
    return -1;
  }
}

async function getLastTimestamp(pool, tableName) {
  for (const col of TIMESTAMP_COLUMNS) {
    try {
      // Check if column exists
      const colCheck = await pool.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = $1
           AND column_name = $2`,
        [tableName, col]
      );
      
      if (colCheck.rows.length === 0) continue;
      
      // Get max timestamp
      const result = await pool.query(`SELECT MAX("${col}") as ts FROM "${tableName}"`);
      if (result.rows[0].ts) {
        return {
          column: col,
          timestamp: result.rows[0].ts,
          age_hours: (Date.now() - new Date(result.rows[0].ts).getTime()) / 3600000,
        };
      }
    } catch (error) {
      // Try next column
      continue;
    }
  }
  return null;
}

async function checkAllTables(pool) {
  console.log('\n📋 Checking all 35 tables...\n');
  
  const results = {
    total: ALL_TABLES.length,
    existing: 0,
    missing: 0,
    reachable: 0,
    unreachable: 0,
    populated: 0,
    empty: 0,
    tables: [],
  };
  
  for (const tableName of ALL_TABLES) {
    const exists = await checkTableExists(pool, tableName);
    
    if (!exists) {
      console.log(`❌ ${tableName}: MISSING`);
      results.missing++;
      results.tables.push({ name: tableName, status: 'missing' });
      continue;
    }
    
    results.existing++;
    
    const rowCount = await getRowCount(pool, tableName);
    
    if (rowCount === -1) {
      console.log(`⚠️  ${tableName}: EXISTS but UNREACHABLE`);
      results.unreachable++;
      results.tables.push({ name: tableName, status: 'unreachable' });
      continue;
    }
    
    results.reachable++;
    
    const lastTs = await getLastTimestamp(pool, tableName);
    
    let status = '✅';
    let statusText = 'OK';
    
    if (rowCount === 0) {
      status = '⚪';
      statusText = 'EMPTY';
      results.empty++;
    } else {
      results.populated++;
      
      if (lastTs && lastTs.age_hours > 48) {
        status = '🟡';
        statusText = 'STALE';
      } else if (rowCount < 5) {
        status = '🟡';
        statusText = 'LOW';
      }
    }
    
    const ageStr = lastTs 
      ? `${lastTs.age_hours.toFixed(1)}h ago`
      : 'no timestamp';
    
    console.log(`${status} ${tableName}: ${rowCount.toLocaleString()} rows (${ageStr})`);
    
    results.tables.push({
      name: tableName,
      status: statusText.toLowerCase(),
      rowCount,
      lastActivity: lastTs,
    });
  }
  
  return results;
}

async function printSummary(results) {
  console.log('\n' + '='.repeat(60));
  console.log('📊 SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total tables:       ${results.total}`);
  console.log(`✅ Existing:        ${results.existing} / ${results.total}`);
  console.log(`❌ Missing:         ${results.missing}`);
  console.log(`✅ Reachable:       ${results.reachable} / ${results.existing}`);
  console.log(`⚠️  Unreachable:    ${results.unreachable}`);
  console.log(`✅ Populated:       ${results.populated} / ${results.reachable}`);
  console.log(`⚪ Empty:           ${results.empty}`);
  console.log('='.repeat(60));
  
  if (results.missing > 0) {
    console.log('\n⚠️  Missing tables need to be initialized');
    console.log('   Run the backend with proper DATABASE_URL to initialize tables');
  }
  
  if (results.empty > 0) {
    console.log('\n⚪ Empty tables detected');
    console.log('   These tables may populate after:');
    console.log('   - First API requests (market_snapshots, hqs_scores)');
    console.log('   - Background jobs running (set RUN_JOBS=true)');
    console.log('   - User activity (notifications, watchlist)');
  }
  
  const healthScore = (
    (results.existing / results.total) * 40 +
    (results.reachable / Math.max(results.existing, 1)) * 30 +
    (results.populated / Math.max(results.reachable, 1)) * 30
  );
  
  console.log(`\n🏥 Health Score: ${healthScore.toFixed(1)}% / 100%`);
  
  if (healthScore >= 90) {
    console.log('   Status: EXCELLENT ✅');
  } else if (healthScore >= 70) {
    console.log('   Status: GOOD 🟢');
  } else if (healthScore >= 50) {
    console.log('   Status: FAIR 🟡');
  } else {
    console.log('   Status: POOR 🔴');
  }
  
  console.log('\n');
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         HQS Backend - Database Health Check               ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
  
  const pool = await checkDatabaseConnection();
  
  if (!pool) {
    console.log('\n❌ Cannot proceed without database connection');
    process.exit(1);
  }
  
  const results = await checkAllTables(pool);
  await printSummary(results);
  
  await pool.end();
  
  // Exit codes
  if (results.missing > 0) {
    process.exit(2);
  }
  if (results.unreachable > 0) {
    process.exit(3);
  }
  
  process.exit(0);
}

if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { checkDatabaseConnection, checkAllTables };
