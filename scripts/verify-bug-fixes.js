#!/usr/bin/env node
"use strict";

/**
 * E2E verification for bug fixes
 * Tests 5 symbols: 3 USA (AAPL, MSFT, TSLA) + 2 Europe (SAP.DE, VOW3.DE)
 */

require("dotenv").config();
const { getSharedPool, closeAllPools } = require("../config/database");
const pool = getSharedPool();
const TEST_SYMBOLS = ["AAPL", "MSFT", "TSLA", "SAP.DE", "VOW3.DE"];

async function verifySymbol(symbol) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Testing: ${symbol}`);
  console.log("=".repeat(60));
  
  const result = {
    symbol,
    snapshot: null,
    news: null,
    currency: null,
    issues: [],
  };

  // 1. Check market_snapshots
  try {
    const snap = await pool.query(`
      SELECT symbol, price, currency, price_usd, fx_rate, created_at, source
      FROM market_snapshots
      WHERE symbol = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [symbol]);
    
    if (snap.rows.length > 0) {
      const row = snap.rows[0];
      const ageHours = (Date.now() - new Date(row.created_at).getTime()) / 3600000;
      result.snapshot = {
        exists: true,
        price: row.price,
        currency: row.currency,
        priceUsd: row.price_usd,
        fxRate: row.fx_rate,
        ageHours: Math.round(ageHours * 10) / 10,
        source: row.source,
        stale: ageHours > 24,
        hardStale: ageHours > 72,
      };
      result.currency = row.currency;
      
      console.log(`✅ Snapshot found:`);
      console.log(`   Price: ${row.price} ${row.currency}`);
      console.log(`   Age: ${result.snapshot.ageHours}h (${result.snapshot.stale ? 'STALE' : 'fresh'})`);
      console.log(`   Source: ${row.source}`);
      
      // Verify currency handling
      if (row.currency === 'USD' && !row.price_usd) {
        result.issues.push("USD snapshot but price_usd is null");
      }
      if (row.currency === 'USD' && !row.fx_rate) {
        result.issues.push("USD snapshot but fx_rate is null");
      }
    } else {
      result.snapshot = { exists: false };
      result.issues.push("No snapshot found in database");
      console.log(`❌ No snapshot in database`);
    }
  } catch (err) {
    result.issues.push(`Snapshot query failed: ${err.message}`);
    console.log(`❌ Snapshot query error: ${err.message}`);
  }

  // 2. Check market_news
  try {
    const news = await pool.query(`
      SELECT title, published_at, is_active_for_scoring, lifecycle_state
      FROM market_news
      WHERE symbol = $1
        AND COALESCE(is_active_for_scoring, TRUE) = TRUE
        AND COALESCE(lifecycle_state, 'active') = 'active'
      ORDER BY published_at DESC
      LIMIT 3
    `, [symbol]);
    
    result.news = {
      count: news.rows.length,
      items: news.rows.map(r => ({
        title: r.title?.substring(0, 50),
        publishedAt: r.published_at,
      })),
    };
    
    if (news.rows.length > 0) {
      console.log(`✅ News found: ${news.rows.length} articles`);
      news.rows.forEach((r, i) => {
        console.log(`   ${i+1}. ${r.title?.substring(0, 50)}...`);
      });
    } else {
      console.log(`⚠️  No active news (might be genuine news gap)`);
    }
  } catch (err) {
    result.issues.push(`News query failed: ${err.message}`);
    console.log(`❌ News query error: ${err.message}`);
  }

  // 3. Check hqs_scores
  try {
    const score = await pool.query(`
      SELECT hqs_score, created_at
      FROM hqs_scores
      WHERE symbol = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [symbol]);
    
    if (score.rows.length > 0) {
      const ageHours = (Date.now() - new Date(score.rows[0].created_at).getTime()) / 3600000;
      console.log(`✅ HQS Score: ${score.rows[0].hqs_score} (${Math.round(ageHours * 10) / 10}h old)`);
    } else {
      console.log(`⚠️  No HQS score (requires API call)`);
    }
  } catch (err) {
    console.log(`⚠️  HQS score check failed: ${err.message}`);
  }

  return result;
}

async function main() {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  Bug Fix Verification - 5 Real Symbols                    ║
║  USA: AAPL, MSFT, TSLA                                    ║
║  Europe: SAP.DE, VOW3.DE                                  ║
╚════════════════════════════════════════════════════════════╝
`);

  const results = [];
  
  for (const symbol of TEST_SYMBOLS) {
    const result = await verifySymbol(symbol);
    results.push(result);
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("SUMMARY");
  console.log("=".repeat(60));
  
  const withSnapshots = results.filter(r => r.snapshot?.exists).length;
  const withNews = results.filter(r => r.news?.count > 0).length;
  const staleSnapshots = results.filter(r => r.snapshot?.stale).length;
  const hardStaleSnapshots = results.filter(r => r.snapshot?.hardStale).length;
  const totalIssues = results.reduce((sum, r) => sum + r.issues.length, 0);
  
  console.log(`Snapshots found:      ${withSnapshots}/${TEST_SYMBOLS.length}`);
  console.log(`Stale (>24h):         ${staleSnapshots}/${withSnapshots}`);
  console.log(`Hard-stale (>72h):    ${hardStaleSnapshots}/${withSnapshots}`);
  console.log(`With news:            ${withNews}/${TEST_SYMBOLS.length}`);
  console.log(`Total issues:         ${totalIssues}`);
  
  if (totalIssues > 0) {
    console.log(`\n⚠️  Issues found:`);
    results.forEach(r => {
      if (r.issues.length > 0) {
        console.log(`  ${r.symbol}:`);
        r.issues.forEach(issue => console.log(`    - ${issue}`));
      }
    });
  }
  
  console.log(`\n✅ Verification complete`);
  
  await closeAllPools();
  process.exit(totalIssues > 10 ? 1 : 0);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
