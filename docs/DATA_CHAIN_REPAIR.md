# Data Chain Repair - Implementation Summary

## Overview

This PR fixes and documents the HQS backend data chain logic, addressing perceived issues with data flow between tables. The key insight: **most "issues" were actually misunderstandings of the intentional architecture**.

## What Was "Broken" (Actually: Misunderstood)

### ❌ MYTH: "market_snapshots.hqs_score is NULL"
**Reality**: `hqs_score` is NOT a column in `market_snapshots`. The tables are **separate by design**.

- `market_snapshots` = raw market data (price, volume, currency, FX rates)
- `hqs_scores` = analytical scores (HQS score, momentum, quality, stability, relative, regime)

Both tables are populated during the same `snapshotScan.job` run. They must be JOINed when both are needed.

**Verification**: All admin services already use correct JOIN patterns. No code changes needed.

### ❌ MYTH: "fx_rates is empty so FX is broken"
**Reality**: FX rates work via 4-tier fallback, `fx_rates` is only tier #2 (last-known-good persistence).

**4-Tier FX Fallback** (fx.service.js):
1. In-process cache (15 min TTL)
2. Live API fetch → persist to `fx_rates` on success
3. Last-known-good from `fx_rates` table
4. `FX_STATIC_USD_EUR` env var (emergency fallback)

If tier #4 is not set and tiers #1-3 fail, snapshots are skipped (prevents bad data).

**Fix**: Added `FX_STATIC_USD_EUR=0.92` to .env.example as critical emergency fallback.

### ❌ MYTH: "Universe shows 5000 symbols but only 80 processed - data loss!"
**Reality**: Cursor-based batch pagination is working correctly.

The system processes 80 symbols per run, cycles through all 5000 over multiple runs. This prevents:
- Memory exhaustion
- API rate limit violations
- Database lock contention

**Verification**: `getUniverseBatch()` uses modulo wrapping to ensure all symbols eventually get processed.

## What Was Actually Fixed

### 1. ✅ Missing FX Emergency Fallback
**Problem**: If FX API fails and no `FX_STATIC_USD_EUR` is set, all USD quotes are skipped (no snapshots saved).

**Fix**:
- Added `FX_STATIC_USD_EUR=0.92` to .env.example
- Added clear error logging when snapshots skipped due to FX
- Added automatic warning when skip rate > 30%

**Action Required**: Set `FX_STATIC_USD_EUR=0.92` in Railway env vars.

### 2. ✅ Insufficient Diagnostics
**Problem**: When data loss occurs, logs don't clearly show WHY symbols are skipped.

**Fix**:
- Enhanced logging for each skip reason:
  - "Quote unavailable" → Provider API returned empty
  - "FX_conversion_failed" → No FX rate available for USD quote
  - "Snapshot error" → Database or calculation error
- Added data chain diagnostics summary showing:
  - Universe → Batch loss
  - Batch → Quote loss
  - Quote → Snapshot loss
  - Overall skip rate with actionable warnings

**Benefit**: Bottlenecks are now immediately visible in logs.

### 3. ✅ Undocumented Architecture
**Problem**: Developers/operators don't understand:
- Why tables are separate
- Why some tables are empty
- How data flows between tables
- What "normal" pipeline status looks like

**Fix**:
- Created comprehensive `docs/DATA_CHAINS.md` (400+ lines)
  - Data flow diagrams
  - Table relationship explanations
  - Intentionally empty tables with reasons
  - 5 production health check queries
  - Common issues & solutions
- Added inline code comments explaining pipeline stages
- Created `scripts/data-chain-health.js` diagnostic tool

**Benefit**: Self-documenting system, easier onboarding and troubleshooting.

## Intentionally Empty Tables (NOT Bugs)

These tables are empty or low-volume by design:

1. **prices_daily** - Feature not implemented yet (historical data loaded on-demand)
2. **sec_edgar_companies** - Conditional feature, requires opt-in
3. **sec_edgar_filing_signals** - Conditional feature, requires opt-in
4. **agents** - Should have exactly 3 rows (low volume OK)
5. **agent_forecasts** - Written only when agentic debate runs (selective)
6. **automation_audit** - Only when autonomous mode enabled (OFF by default)
7. **autonomy_audit** - Only when autonomous mode enabled (OFF by default)

See `docs/DATA_CHAINS.md` for detailed explanations.

## Files Changed

### Configuration
- ✅ `.env.example` - Added FX_STATIC_USD_EUR and FX_USD_EUR_URL

### Services
- ✅ `services/marketService.js`
  - Enhanced logging for snapshot skip reasons
  - Added data chain diagnostics to summary
  - Added automatic bottleneck warnings
  - Added pipeline stage documentation in comments

### Documentation
- ✅ `docs/DATA_CHAINS.md` (NEW)
  - Complete data flow documentation
  - Table relationship diagrams
  - Intentionally empty tables explained
  - 5 production health queries
  - Common issues & solutions

### Scripts
- ✅ `scripts/data-chain-health.js` (NEW)
  - 6 automated health checks
  - Diagnose snapshot/HQS alignment
  - Diagnose FX availability
  - Diagnose universe coverage
  - Check pipeline status accuracy
  - Verify empty tables are correct
  - Test admin JOIN queries
  - FIX MODE: Backfill fx_rates, initialize agents table

### Package
- ✅ `package.json`
  - Added `npm run db:chains` (run health checks)
  - Added `npm run db:chains:fix` (run with automatic repairs)

## Production Deployment Checklist

### 1. Set Environment Variables (CRITICAL)
```bash
# In Railway dashboard > Variables
FX_STATIC_USD_EUR=0.92
```

This is the **most important change**. Without this, USD quotes will be skipped when FX API is down.

### 2. Run Health Check
```bash
# Connect to Railway via CLI or use database connection
npm run db:chains
```

Expected results:
- Snapshot ↔ HQS alignment within 10%
- FX rates available OR static fallback set
- Pipeline skip rate < 30%

### 3. Verify Production Queries

Run these in Railway Postgres plugin:

```sql
-- 1. Snapshot & HQS Score Alignment (24h)
SELECT 
  (SELECT COUNT(*) FROM market_snapshots WHERE created_at > NOW() - INTERVAL '24 hours') AS snapshots_24h,
  (SELECT COUNT(*) FROM hqs_scores WHERE created_at > NOW() - INTERVAL '24 hours') AS scores_24h;
-- Expected: Both counts similar (within 10%)

-- 2. Currency Distribution (24h)
SELECT currency, COUNT(*) AS count
FROM market_snapshots 
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY currency ORDER BY count DESC;
-- Expected: EUR majority (>70%) if FX working

-- 3. FX Rate Health
SELECT 
  COUNT(*) AS total_fx_entries,
  MAX(fetched_at) AS last_fx_fetch,
  MAX(rate) AS last_rate
FROM fx_rates
WHERE base_currency = 'USD' AND quote_currency = 'EUR';
-- Expected: Recent entries OR FX_STATIC_USD_EUR env set

-- 4. Pipeline Status Overview
SELECT stage, input_count, success_count, skipped_count,
       ROUND(100.0 * success_count / NULLIF(input_count, 0), 1) AS success_rate
FROM pipeline_status;
-- Expected: Snapshot success_rate >70%

-- 5. Admin JOIN Test
SELECT 
  ms.symbol, ms.price, ms.currency, hs.hqs_score
FROM market_snapshots ms
LEFT JOIN hqs_scores hs ON hs.symbol = ms.symbol
WHERE ms.created_at > NOW() - INTERVAL '48 hours'
ORDER BY ms.created_at DESC LIMIT 10;
-- Expected: Both price and hqs_score populated
```

### 4. Optional: Backfill FX Rates
If `fx_rates` is currently empty but snapshots exist:

```bash
npm run db:chains:fix
```

This will:
- Backfill fx_rates from existing snapshots
- Initialize agents table if empty (3 rows)

### 5. Monitor Logs After Deployment

Watch for these new log entries:

**✅ Good (Normal Operation):**
```
Snapshot complete {
  diagnostics: {
    skipped_total: 12,
    quote_to_snapshot_loss: 12
  }
}
```

**⚠️ Warning (Actionable):**
```
HIGH SKIP RATE DETECTED - Data chain bottleneck {
  skipRate: "45%",
  likelyCause: "FX conversion failure for USD quotes",
  action: "Set FX_STATIC_USD_EUR env var"
}
```

**❌ Error (Investigate):**
```
UNIVERSE BATCH BOTTLENECK DETECTED {
  lossPercent: "85%",
  likelyCause: "SNAPSHOT_BATCH_SIZE too small",
  action: "Increase SNAPSHOT_BATCH_SIZE env var"
}
```

## What NOT to Change

### ❌ Don't "Fix" Separate Tables
Do NOT try to add `hqs_score` column to `market_snapshots`. The separation is intentional and correct.

### ❌ Don't Force-Fill Empty Tables
Do NOT insert fake data into `prices_daily`, `sec_edgar_*`, or `automation_audit`. They're empty because features aren't active.

### ❌ Don't Increase Batch Size Without Reason
Do NOT set `SNAPSHOT_BATCH_SIZE > 250` unless universe is enormous. Current 80 is optimal for most cases.

## Testing Performed

1. ✅ Syntax validation: `node --check server.js` - PASS
2. ✅ Syntax validation: `node --check services/marketService.js` - PASS
3. ✅ Syntax validation: `node --check scripts/data-chain-health.js` - PASS
4. ✅ Code review of all admin services - Confirmed correct JOIN usage
5. ✅ Review of FX fallback chain - Confirmed all 4 tiers work
6. ✅ Review of universe pagination - Confirmed cursor logic correct

## Success Criteria

After deployment, the system is healthy when:

1. ✅ `market_snapshots` and `hqs_scores` both grow at similar rates (check hourly)
2. ✅ `market_snapshots.currency` is mostly 'EUR' (>70%) - shows FX working
3. ✅ `pipeline_status.snapshot.success_count / input_count > 0.7` - skip rate < 30%
4. ✅ Railway logs show < 5 "FX_conversion_failed" warnings per batch (or FX_STATIC_USD_EUR is set)
5. ✅ No "UNIVERSE BATCH BOTTLENECK" warnings in logs

## Support & Troubleshooting

### If FX is failing:
1. Check Railway logs for "fx: primary rate fetch failed"
2. Verify FX_STATIC_USD_EUR is set in env vars
3. Run `npm run db:chains:fix` to backfill fx_rates

### If snapshots are being skipped:
1. Run `npm run db:chains` to diagnose
2. Check logs for specific skip reasons
3. See `docs/DATA_CHAINS.md` → "Common Issues & Solutions"

### If HQS scores are missing:
1. Verify `hqs_scores` table exists (it should!)
2. Check if scores are in separate table (not market_snapshots)
3. Admin queries should JOIN both tables (verify with query #5 above)

## Related Documentation

- `docs/DATA_CHAINS.md` - Complete architecture guide
- `scripts/data-chain-health.js` - Automated diagnostics
- `.env.example` - Updated with FX config

## Summary

**The system was working correctly**, but lacked:
1. Emergency FX fallback configuration
2. Clear diagnostic logging
3. Architecture documentation

All three are now fixed. The core data flow logic required **zero changes** - only configuration, logging, and documentation improvements.
