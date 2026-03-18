# Data Chain Repair - Production Deployment Checklist

## ✅ Code Changes Complete

All code changes have been committed and pushed to branch `copilot/fix-data-chain-logic`.

**Total Files Changed**: 7 files
- Configuration: `.env.example`
- Services: `services/marketService.js`
- Documentation: 3 new MD files
- Scripts: `scripts/data-chain-health.js`
- Package: `package.json`

**Total Lines**: ~1,700 lines added (mostly documentation)

## 🚀 Deployment Steps

### Step 1: Set Environment Variable (CRITICAL)

**In Railway Dashboard → Your App → Variables → Add:**

```
FX_STATIC_USD_EUR=0.92
```

**Why this is critical**:
- Prevents 100% data loss for USD quotes when FX API is down
- Without this, all USD snapshots will be skipped (causes high skip rates)
- Acts as emergency fallback when live FX API and fx_rates table both fail

**Alternative value**: You can use a different rate (e.g., 0.91, 0.93) based on current USD/EUR rate, but 0.92 is a safe middle ground.

### Step 2: Merge and Deploy

```bash
# Option A: Merge via GitHub PR
# → Railway will auto-deploy on merge to main

# Option B: Direct push to main (if you have permissions)
git checkout main
git merge copilot/fix-data-chain-logic
git push origin main
# → Railway will auto-deploy
```

**Railway auto-deploys** when you push to main branch (assuming you have auto-deploy enabled).

### Step 3: Wait for Deployment

Monitor Railway deployment logs for:
- ✅ "Build succeeded"
- ✅ "Deployment live"
- ✅ Server started on port 8080

### Step 4: Run Health Check

**Option A: Via Railway console**
```bash
npm run db:chains
```

**Option B: Locally with DATABASE_URL**
```bash
export DATABASE_URL="your-railway-postgres-url"
npm run db:chains
```

**Expected Output**:
```
✅ PASS: Snapshots and HQS scores are aligned
✅ PASS: Recent FX data available (or static fallback set)
✅ PASS: Reasonable skip rate (< 30%)
✅ PASS: Pipeline stages aligned
✅ PASS: Admin JOIN queries working correctly
```

### Step 5: Verify Production Data

**Connect to Railway Postgres** (Dashboard → Database → Query)

**Run these 5 queries:**

#### Query 1: Snapshot & HQS Alignment
```sql
SELECT 
  (SELECT COUNT(*) FROM market_snapshots WHERE created_at > NOW() - INTERVAL '24 hours') AS snapshots_24h,
  (SELECT COUNT(*) FROM hqs_scores WHERE created_at > NOW() - INTERVAL '24 hours') AS scores_24h;
```
**✅ Expected**: Both counts within 10% of each other

#### Query 2: Currency Distribution
```sql
SELECT currency, COUNT(*) AS count
FROM market_snapshots 
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY currency 
ORDER BY count DESC;
```
**✅ Expected**: EUR should be >70% (shows FX working)

#### Query 3: FX Rate Health
```sql
SELECT 
  COUNT(*) AS total_fx_entries,
  MAX(fetched_at) AS last_fx_fetch,
  MAX(rate) AS last_rate
FROM fx_rates
WHERE base_currency = 'USD' AND quote_currency = 'EUR';
```
**✅ Expected**: 
- Either: Has recent entries (within 48h)
- Or: Empty but FX_STATIC_USD_EUR is set in env (OK)

#### Query 4: Pipeline Status
```sql
SELECT 
  stage, 
  input_count, 
  success_count, 
  skipped_count,
  ROUND(100.0 * success_count / NULLIF(input_count, 0), 1) AS success_rate
FROM pipeline_status
ORDER BY 
  CASE stage 
    WHEN 'universe' THEN 1 
    WHEN 'snapshot' THEN 2 
    WHEN 'advancedMetrics' THEN 3 
    WHEN 'hqsScoring' THEN 4 
    WHEN 'outcome' THEN 5 
  END;
```
**✅ Expected**: Snapshot success_rate >70%

#### Query 5: Admin JOIN Test
```sql
SELECT 
  ms.symbol,
  ms.price AS snapshot_price,
  ms.currency,
  hs.hqs_score,
  ms.created_at AS snapshot_time,
  hs.created_at AS score_time
FROM market_snapshots ms
LEFT JOIN hqs_scores hs ON hs.symbol = ms.symbol
WHERE ms.created_at > NOW() - INTERVAL '48 hours'
ORDER BY ms.created_at DESC 
LIMIT 10;
```
**✅ Expected**: Both price and hqs_score populated (no NULLs in hqs_score column)

## 📊 Post-Deployment Monitoring (First 24 Hours)

### Watch Railway Logs For

**✅ Good Signs (Normal Operation):**
```
Snapshot complete {
  summary: {
    snapshotsSaved: 65,
    skipped: 8
  },
  diagnostics: {
    skipped_total: 8,
    quote_to_snapshot_loss: 8
  }
}
```
→ Skip rate 8/73 = ~11% (good)

**⚠️ Warning Signs (Monitor):**
```
HIGH SKIP RATE DETECTED - Data chain bottleneck {
  skipRate: "45%",
  likelyCause: "FX conversion failure for USD quotes",
  action: "Set FX_STATIC_USD_EUR env var"
}
```
→ Check if FX_STATIC_USD_EUR is actually set, verify it took effect

**❌ Error Signs (Investigate):**
```
Snapshot skipped for AAPL {
  reason: "FX_conversion_failed_or_null_price"
}
```
→ If you see many of these AND FX_STATIC_USD_EUR is set, check the env var value

### Success Metrics After 24h

Run `npm run db:chains` again and verify:

1. ✅ Snapshot count ≈ HQS score count (within 10%)
2. ✅ EUR currency >70% of snapshots
3. ✅ Pipeline skip rate <30%
4. ✅ fx_rates has entries OR FX_STATIC_USD_EUR confirmed set
5. ✅ No "column not found" errors in logs

## 🔧 Optional: Backfill FX Rates

If `fx_rates` table is currently empty AND you want to populate it with historical data:

```bash
npm run db:chains:fix
```

This will:
- Extract FX rates from existing EUR snapshots
- Insert up to 100 historical FX rate entries
- Initialize agents table (3 rows) if empty

**This is optional** - the system works fine without it as long as FX_STATIC_USD_EUR is set.

## 📚 Documentation Reference

All documentation is in the `docs/` folder:

1. **DATA_CHAINS.md** (400+ lines)
   - Complete architecture guide
   - Data flow diagrams
   - Table relationships
   - Intentionally empty tables explained
   - 5 production health queries
   - Common issues & solutions

2. **DATA_CHAIN_REPAIR.md** (300+ lines)
   - Implementation summary
   - What was "broken" vs what was actually happening
   - Changes made
   - What NOT to change
   - Testing performed

3. **FINAL_SUMMARY.md** (400+ lines)
   - Executive summary
   - Root cause analysis
   - Deployment checklist
   - Success metrics
   - Lessons learned
   - Future recommendations

## ❓ Troubleshooting

### If FX is failing after deployment:

1. Verify env var is set:
   ```bash
   # In Railway console
   echo $FX_STATIC_USD_EUR
   ```
   Should output: `0.92`

2. Check Railway logs for FX errors:
   ```
   grep "fx:" recent-logs.txt
   ```

3. Run health check:
   ```bash
   npm run db:chains
   ```

### If snapshots are being skipped:

1. Run health check to diagnose:
   ```bash
   npm run db:chains
   ```

2. Check logs for skip reasons:
   ```
   grep "Snapshot skipped" recent-logs.txt
   ```

3. Common causes:
   - FX_STATIC_USD_EUR not set → Set it in Railway env
   - Provider API down → Wait for provider to recover
   - Symbol delisted → Expected, will auto-stop after universe refresh

### If HQS scores are missing:

1. **DO NOT** try to add hqs_score column to market_snapshots
2. Verify hqs_scores table exists:
   ```sql
   SELECT COUNT(*) FROM hqs_scores;
   ```
3. Check if scores are in separate table (they should be):
   ```sql
   SELECT * FROM hqs_scores ORDER BY created_at DESC LIMIT 10;
   ```
4. Admin queries should JOIN both tables (run Query #5 above)

## 🎯 Summary

**What you need to do:**
1. ✅ Set `FX_STATIC_USD_EUR=0.92` in Railway env (CRITICAL)
2. ✅ Merge and deploy code
3. ✅ Run `npm run db:chains` to verify
4. ✅ Run 5 production queries to confirm health
5. ✅ Monitor logs for 24 hours

**What you should see:**
- Snapshot & HQS counts growing at same rate
- EUR currency as majority (>70%)
- Skip rate <30%
- No errors in logs

**If problems occur:**
- Start with `npm run db:chains` diagnostic
- Review `docs/DATA_CHAINS.md` → Common Issues section
- Check Railway logs for new diagnostic warnings

**Support:**
- All issues documented in `docs/DATA_CHAINS.md`
- Health check: `npm run db:chains`
- Auto-repair: `npm run db:chains:fix`

---

**System is production-ready. Deploy with confidence. 🚀**
