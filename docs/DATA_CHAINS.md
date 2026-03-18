# HQS Backend Data Chains - Production Guide

This document explains the core data flows, table relationships, and intentionally empty tables in the HQS backend.

## Critical Understanding: Separate Tables by Design

### ✅ CORRECT: market_snapshots + hqs_scores are SEPARATE tables

**This is NOT a bug.** These tables are intentionally separate and must be JOINed when both are needed.

- **market_snapshots**: Stores raw market data (price, volume, currency, fx_rate)
- **hqs_scores**: Stores calculated quality scores (hqs_score, momentum, quality, stability, relative, regime)

**Why separate?**
- Different update frequencies (snapshots = real-time, scores = periodic calculation)
- Different retention policies (snapshots = time-series, scores = latest-only for most use cases)
- Cleaner schema (market data vs. analytical scores)

**How they link:** Both tables have `symbol` and `created_at` columns. JOIN on `symbol` to get both.

**Example correct read:**
```sql
SELECT 
  ms.symbol, ms.price, ms.currency, ms.created_at AS snapshot_created,
  hs.hqs_score, hs.momentum, hs.quality, hs.created_at AS score_created
FROM market_snapshots ms
LEFT JOIN hqs_scores hs ON hs.symbol = ms.symbol
WHERE ms.symbol = 'AAPL'
ORDER BY ms.created_at DESC, hs.created_at DESC
LIMIT 1;
```

**Services that correctly JOIN these tables:**
- `adminDemoPortfolio.service.js` - Uses separate `loadSnapshotsBatch()` and `loadScoresBatch()`
- `portfolioTwin.service.js` - Reads from `hqs_scores` for scoring logic
- `opportunityScanner.service.js` - Reads from `hqs_scores` for opportunity detection

## Core Data Chain 1: Universe → Snapshot → HQS

```
┌─────────────────────┐
│ universe_symbols    │  ← Refreshed daily by universeRefresh.job
│ (all active stocks) │     Source: Massive API or internal fallback
└──────────┬──────────┘
           │
           ▼ (getUniverseBatch with cursor pagination)
┌─────────────────────┐
│ Snapshot Batch      │  ← Selected by getSnapshotCandidates()
│ (80 symbols/run)    │     Filter: is_active=true, country=SNAPSHOT_REGION
└──────────┬──────────┘
           │
           ▼ (fetchQuote for each symbol)
┌─────────────────────┐
│ Raw Quotes          │  ← From Massive/FMP/Finnhub API
│ (price, volume...)  │     ⚠️ SKIP if provider returns empty
└──────────┬──────────┘
           │
           ▼ (convertSnapshotToEur)
┌─────────────────────┐
│ EUR Normalization   │  ← USD→EUR conversion via fx.service
│                     │     ⚠️ SKIP if FX rate unavailable
└──────────┬──────────┘
           │
           ├─────────────────────────────────────┐
           ▼                                     ▼
┌─────────────────────┐             ┌─────────────────────┐
│ market_snapshots    │             │ hqs_scores          │
│ (price, currency,   │             │ (hqs_score,         │
│  fx_rate, volume)   │             │  momentum, quality) │
└─────────────────────┘             └─────────────────────┘
```

**Bottleneck Detection:**

1. **Universe → Batch**: If `pipeline_status.universe.input_count` >> `pipeline_status.snapshot.input_count`
   - **Cause**: SNAPSHOT_BATCH_SIZE too small
   - **Fix**: Increase `SNAPSHOT_BATCH_SIZE` env var (default: 80, max: 250)

2. **Batch → Quotes**: If many symbols skipped with "no_quote_from_provider"
   - **Cause**: Delisted symbols in universe_symbols or provider API down
   - **Fix**: Check provider API status, review universe refresh logic

3. **Quotes → Snapshots**: If many symbols skipped with "FX_conversion_failed"
   - **Cause**: FX API down and no static fallback configured
   - **Fix**: Set `FX_STATIC_USD_EUR=0.92` in env vars (CRITICAL)

## Core Data Chain 2: FX Rates (USD → EUR)

```
┌─────────────────────┐
│ FX Rate Request     │  ← Called during convertSnapshotToEur()
└──────────┬──────────┘
           │
           ▼ 4-Tier Fallback (fx.service.js)
           │
    ┌──────┴──────┬──────────────┬──────────────┬──────────────┐
    ▼             ▼              ▼              ▼              ▼
  Cache       Live API      fx_rates      FX_STATIC_   ❌ NULL
 (15min)   (exchangerate.  (last known    USD_EUR     (skip
           host or custom)    good)       env var    snapshot)

┌─────────────────────┐
│ fx_rates table      │  ← Written when live API succeeds
│ (persistent store)  │     OR manually set via backfill
└─────────────────────┘
         ↓
    ┌────────────────┐
    │ PERSIST only   │  ← persistLastKnownGood() called on live success
    │ on live success│     Errors logged but not fatal
    └────────────────┘
```

**Why fx_rates might be empty:**
- Live FX API never succeeded since deployment
- No FX_STATIC_USD_EUR env var configured
- FX persistence failed (logged as warning, not fatal)

**How to fix:**
1. Set `FX_STATIC_USD_EUR=0.92` in Railway env vars (emergency fallback)
2. Set `FX_USD_EUR_URL` if using custom FX provider
3. Run backfillSnapshotFx.job to populate fx_rates from existing snapshots

**Verification:**
```sql
-- Check if fx_rates has any entries
SELECT COUNT(*), MAX(fetched_at), MAX(rate) FROM fx_rates;

-- Check recent snapshots for FX usage
SELECT symbol, currency, fx_rate, price, price_usd, created_at 
FROM market_snapshots 
WHERE currency = 'EUR' AND fx_rate IS NOT NULL
ORDER BY created_at DESC LIMIT 10;
```

## Intentionally Empty Tables (Features Not Yet Active)

### 1. `prices_daily` - NOT IMPLEMENTED YET
**Purpose**: Daily OHLCV historical data for backtesting
**Current State**: Table exists but NO write path implemented
**Reason**: Historical data currently loaded on-demand via `loadHistoricalPrices()`, not persisted
**Action**: None needed - feature planned for future

### 2. `sec_edgar_companies` + `sec_edgar_filing_signals` - CONDITIONAL
**Purpose**: SEC filing analysis for fundamental signals
**Current State**: Tables created by `secEdgar.repository.js` but rarely populated
**Write Path**: `upsertCompany()` and `upsertFilingSignal()` exist but not called in main pipeline
**Reason**: SEC scraping requires opt-in (ENABLE_SEC_EDGAR env var or manual trigger)
**Action**: Enable if needed via `/api/admin/sec-edgar/*` endpoints

### 3. `agents` - ACTIVE but low volume
**Purpose**: Track wisdom scores for debate agents (GROWTH_BIAS, RISK_SKEPTIC, MACRO_JUDGE)
**Current State**: Written by `opportunityScanner.service.js` via `logAgentForecasts()`
**Low Volume Reason**: Only written when agentic debate runs (selective symbols only)
**Verification**: Should have 3 rows (one per agent) with wisdom_score calculated daily

### 4. `agent_forecasts` - ACTIVE but selective
**Purpose**: Log each agent's 24h forecast for accuracy tracking
**Current State**: Written when debate runs on a symbol
**Low Volume Reason**: Debate is selective (high-conviction opportunities only)
**Verification**: Check `verified_at IS NULL` count - should increase when debate runs

### 5. `automation_audit` + `autonomy_audit` - ACTIVE but low frequency
**Purpose**: Audit log for autonomous trading decisions
**Current State**: Written by `autonomyAudit.repository.js`
**Write Trigger**: Only when autonomous mode makes actual trade decisions
**Low Volume Reason**: Autonomous mode must be explicitly enabled (ENV or feature flag)
**Verification**: Empty is normal unless AUTO_TRADE_ENABLED=true

## Pipeline Status Metrics Explained

```sql
SELECT * FROM pipeline_status ORDER BY stage;
```

| Stage | input_count | success_count | Meaning |
|-------|-------------|---------------|---------|
| universe | 5000 | 80 | 5000 active symbols in DB → 80 selected for this batch |
| snapshot | 80 | 65 | 80 attempted → 65 successfully saved to market_snapshots |
| hqsScoring | 75 | 73 | 75 normalized → 73 HQS scores saved to hqs_scores |
| advancedMetrics | 70 | 68 | 70 quotes → 68 advanced metrics calculated |
| outcome | 65 | 60 | 65 snapshots → 60 outcome tracking entries |

**Normal Gaps:**
- **universe input >> snapshot input**: Expected - batch pagination (80/run out of 5000 total)
- **snapshot skipped (80 - 65 = 15)**: Normal - FX conversion failed or quote unavailable
- **hqsScoring success ≈ snapshot success**: Should be nearly equal (both written in same loop)

**Red Flags:**
- **snapshot skipped > 30%**: FX issue - set FX_STATIC_USD_EUR immediately
- **hqsScoring << snapshot**: Logic error in buildHQSResponse() - investigate
- **universe success growing slowly**: Check universeRefresh.job success rate

## Production Health Checks

### 1. Data Chain Integrity
```sql
-- Should return similar counts (within 10% over 24h window)
SELECT 
  (SELECT COUNT(*) FROM market_snapshots WHERE created_at > NOW() - INTERVAL '24 hours') AS snapshots_24h,
  (SELECT COUNT(*) FROM hqs_scores WHERE created_at > NOW() - INTERVAL '24 hours') AS scores_24h,
  (SELECT success_count FROM pipeline_status WHERE stage = 'snapshot') AS pipeline_snapshot,
  (SELECT success_count FROM pipeline_status WHERE stage = 'hqsScoring') AS pipeline_hqs;
```

### 2. FX Health
```sql
-- Should have recent entries if live API is working
SELECT 
  COUNT(*) AS total_fx_entries,
  MAX(fetched_at) AS last_fx_fetch,
  MAX(rate) AS last_rate,
  AVG(rate) AS avg_rate_all_time
FROM fx_rates
WHERE base_currency = 'USD' AND quote_currency = 'EUR';

-- Should show mix of EUR (converted) and original currencies
SELECT 
  currency, 
  COUNT(*) AS count,
  AVG(fx_rate) AS avg_fx_rate
FROM market_snapshots 
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY currency;
```

### 3. Universe Coverage
```sql
-- Active symbols available vs. scanned per batch
SELECT 
  (SELECT COUNT(*) FROM universe_symbols WHERE is_active = true) AS total_active,
  (SELECT input_count FROM pipeline_status WHERE stage = 'snapshot') AS last_batch_size,
  (SELECT success_count FROM pipeline_status WHERE stage = 'snapshot') AS last_batch_saved;
```

### 4. Empty Tables Verification
```sql
-- These should be empty or low volume (OK to be zero)
SELECT 
  'prices_daily' AS table_name, COUNT(*) FROM prices_daily
UNION ALL
SELECT 'sec_edgar_companies', COUNT(*) FROM sec_edgar_companies
UNION ALL
SELECT 'sec_edgar_filing_signals', COUNT(*) FROM sec_edgar_filing_signals
UNION ALL
SELECT 'automation_audit', COUNT(*) FROM automation_audit
UNION ALL
SELECT 'autonomy_audit', COUNT(*) FROM autonomy_audit;

-- These should have data (agents table = 3 rows, forecasts = variable)
SELECT 
  'agents' AS table_name, COUNT(*) FROM agents
UNION ALL
SELECT 'agent_forecasts', COUNT(*) FROM agent_forecasts WHERE forecasted_at > NOW() - INTERVAL '7 days';
```

### 5. Admin Demo Portfolio Join Test
```sql
-- Verify admin views can JOIN snapshots + scores correctly
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
WHERE ms.symbol IN ('AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA')
  AND ms.created_at > NOW() - INTERVAL '48 hours'
ORDER BY ms.symbol, ms.created_at DESC
LIMIT 20;
```

## Common Issues & Solutions

### Issue: "market_snapshots has data but hqs_score is NULL"
**Diagnosis**: MISUNDERSTANDING - hqs_score is NOT a column in market_snapshots
**Reality**: Check `hqs_scores` table instead
**Solution**: Use JOIN query (see examples above)

### Issue: "fx_rates is empty but market_snapshots has fx_rate values"
**Diagnosis**: Live FX API worked during snapshots, but fx_rates persistence may have failed OR no static fallback
**Reality**: fx_rate column in market_snapshots is populated even if fx_rates table write fails
**Solution**: 
1. Set `FX_STATIC_USD_EUR=0.92` in env (prevents future snapshot loss)
2. Check Railway logs for "fx: could not persist last-known-good rate" warnings
3. Run backfillSnapshotFx.job to populate fx_rates from existing snapshots

### Issue: "Universe shows 5000 symbols but only 80 processed"
**Diagnosis**: NOT A BUG - This is batch pagination working correctly
**Reality**: Cursor-based pagination processes 80 symbols per run, cycles through all 5000 over multiple runs
**Solution**: None needed - this prevents memory issues and API rate limits

### Issue: "Many snapshots skipped with FX_conversion_failed"
**Diagnosis**: FX API down and no fallback configured
**Solution**: Set `FX_STATIC_USD_EUR=0.92` in Railway env vars (takes effect immediately)

### Issue: "prices_daily, sec_edgar_*, agents are empty"
**Diagnosis**: Features not active or low frequency
**Solution**: See "Intentionally Empty Tables" section above - mostly OK to be empty

## Environment Variables Checklist

### CRITICAL (Must Set)
- ✅ `FX_STATIC_USD_EUR=0.92` - Prevents snapshot loss when FX API down

### RECOMMENDED (Should Set)
- ✅ `SNAPSHOT_BATCH_SIZE=80` - Tune based on API rate limits (max: 250)
- ✅ `SNAPSHOT_REGION=us` - Filter universe by region (us, eu, etc.)
- ✅ `FX_USD_EUR_URL=<custom-url>` - If not using default exchangerate.host

### OPTIONAL (Feature Flags)
- ⚪ `ENABLE_SEC_EDGAR=true` - Enable SEC filing analysis
- ⚪ `AUTO_TRADE_ENABLED=true` - Enable autonomous trading audit logs

## Monitoring Queries for Railway

Run these in Railway Postgres plugin to verify health:

```sql
-- 1. Recent snapshot activity (should show continuous growth)
SELECT DATE_TRUNC('hour', created_at) AS hour, COUNT(*) AS snapshots
FROM market_snapshots
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY hour ORDER BY hour DESC LIMIT 24;

-- 2. HQS score freshness (should match snapshot counts)
SELECT DATE_TRUNC('hour', created_at) AS hour, COUNT(*) AS scores
FROM hqs_scores
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY hour ORDER BY hour DESC LIMIT 24;

-- 3. Pipeline bottleneck detection
SELECT 
  stage,
  input_count,
  success_count,
  skipped_count,
  failed_count,
  ROUND(100.0 * success_count / NULLIF(input_count, 0), 1) AS success_rate,
  last_run_at
FROM pipeline_status
ORDER BY 
  CASE stage 
    WHEN 'universe' THEN 1
    WHEN 'snapshot' THEN 2
    WHEN 'advancedMetrics' THEN 3
    WHEN 'hqsScoring' THEN 4
    WHEN 'outcome' THEN 5
  END;

-- 4. Currency distribution (should show EUR majority if FX working)
SELECT currency, COUNT(*) AS count
FROM market_snapshots
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY currency ORDER BY count DESC;

-- 5. FX rate availability
SELECT 
  COALESCE(MAX(fetched_at), '1970-01-01'::timestamptz) AS last_fx_fetch,
  EXTRACT(EPOCH FROM (NOW() - COALESCE(MAX(fetched_at), '1970-01-01'::timestamptz)))/3600 AS hours_since_last_fx,
  COUNT(*) AS total_fx_records
FROM fx_rates
WHERE base_currency = 'USD' AND quote_currency = 'EUR';
```

## Summary

**The system is working correctly when:**
1. ✅ market_snapshots and hqs_scores both grow at similar rates
2. ✅ market_snapshots.currency is mostly 'EUR' (shows FX working)
3. ✅ pipeline_status shows success_rate > 70% for snapshot stage
4. ✅ fx_rates has entries OR FX_STATIC_USD_EUR is set in env
5. ✅ universe_symbols count is stable (refreshed daily)

**Red flags requiring immediate action:**
1. 🔴 pipeline_status.snapshot.skipped_count > 30% → Set FX_STATIC_USD_EUR
2. 🔴 hqs_scores count << market_snapshots count → Check buildHQSResponse() logic
3. 🔴 market_snapshots.currency = 'USD' majority → FX completely broken
4. 🔴 No new snapshots in 24+ hours → Check snapshotScan.job scheduling
5. 🔴 universe_symbols empty or stale → Check universeRefresh.job

**Intentionally empty = OK:**
- prices_daily (feature not implemented)
- sec_edgar_* (feature not enabled)
- automation_audit (autonomous mode disabled)
- autonomy_audit (autonomous mode disabled)
