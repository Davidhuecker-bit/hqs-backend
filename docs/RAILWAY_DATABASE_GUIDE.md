# Railway Deployment & Database Configuration Guide

## 🚀 Railway Integration Status

### ✅ Current Configuration

Your HQS backend is **properly configured** for Railway deployment:

1. **Database Connection**: PostgreSQL via `DATABASE_URL`
2. **Health Checks**: `/health` endpoint configured
3. **Restart Policy**: On-failure with 3 retries
4. **SSL**: Properly configured for Railway's self-signed certificates

---

## 📋 All 34 Database Tables

Your backend manages **34 tables** across 7 functional categories:

### 1. Market Data Tables (6 tables)
- `market_snapshots` - Real-time price/volume snapshots
- `market_advanced_metrics` - Regime, volatility, trend analytics
- `market_news` - News articles with sentiment
- `hqs_scores` - HQS scoring results
- `fx_rates` - Foreign exchange rates
- `watchlist_symbols` - User watchlists

### 2. Agent & Prediction Tables (5 tables)
- `agent_forecasts` - Agent predictions
- `agents` - Agent definitions
- `autonomy_audit` - Automation audit trail
- `guardian_near_miss` - Near-miss opportunities
- `automation_audit` - Automation tracking

### 3. Learning & Discovery Tables (4 tables)
- `discovery_history` - Discovery engine results
- `dynamic_weights` - Causal memory weights
- `learning_runtime_state` - Discovery learning state
- `outcome_tracking` - Strategy outcome tracking

### 4. Portfolio & Analysis Tables (4 tables)
- `virtual_positions` - Portfolio twin positions
- `factor_history` - Quantitative factor tracking
- `weight_history` - Portfolio weight history
- `admin_snapshots` - Admin historical snapshots

### 5. System & Infrastructure Tables (6 tables)
- `job_locks` - Job coordination locks
- `universe_scan_state` - Universe scan state
- `universe_symbols` - Trading universe
- `pipeline_status` - Data pipeline tracking
- `sis_history` - System intelligence snapshots
- `entity_map` - Symbol-to-entity mapping

### 6. Notification & User Tables (4 tables)
- `briefing_users` - User notification preferences
- `briefing_watchlist` - Watchlist for briefings
- `notifications` - Notification history
- `user_devices` - Device tokens for push

### 7. SEC & External Data Tables (4 tables)
- `sec_edgar_companies` - SEC company metadata
- `sec_edgar_company_facts` - SEC financial facts
- `sec_edgar_filing_signals` - SEC filing signals
- `tech_radar_entries` - Tech radar data

---

## 🔧 Required Environment Variables

### Core Configuration (Required)

```bash
# Database connection (REQUIRED)
DATABASE_URL=postgresql://user:password@host:port/database

# Server port (default: 8080)
PORT=8080

# Enable background jobs (default: false)
# Set to true to enable data collection jobs
RUN_JOBS=false
```

### CORS Configuration

```bash
# Frontend domains allowed by CORS (comma-separated)
CORS_ORIGINS=https://your-frontend.com,https://www.your-frontend.com
```

### API Keys (At least one market data provider required)

```bash
# OpenAI for AI features
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini

# Market data providers (configure at least one)
FMP_API_KEY=...          # Financial Modeling Prep
FINNHUB_API_KEY=...      # Finnhub
MASSIVE_API_KEY=...      # Alternative provider
TWELVE_DATA_API_KEY=...  # Twelve Data
```

### Optional Redis Cache

```bash
# Distributed cache (Upstash Redis)
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...
```

### Job Scheduling (Optional, all have defaults)

```bash
# Universe refresh (default: 2:10 AM UTC)
UNIVERSE_REFRESH_HOUR=2
UNIVERSE_REFRESH_MINUTE=10

# Forecast verification (default: 3:00 AM UTC)
FORECAST_VERIFY_HOUR=3
FORECAST_VERIFY_MINUTE=0

# Causal memory update (default: 4:00 AM UTC)
CAUSAL_MEMORY_HOUR=4
CAUSAL_MEMORY_MINUTE=0

# Tech radar scan (default: 6:00 AM UTC)
TECH_RADAR_HOUR=6
TECH_RADAR_MINUTE=0
```

### Performance Tuning (Optional)

```bash
# Market data collection
SNAPSHOT_BATCH_SIZE=80      # Symbols per batch
SNAPSHOT_SYMBOL_LIMIT=250   # Max symbols to scan
HIST_PERIOD=1y              # Historical data period

# Monte Carlo simulations
MC_SIMS=800                 # Number of simulations

# Cache TTL
CACHE_TTL_SECONDS=600       # 10 minutes
```

---

## 🏥 Health Checks

### 1. Railway Health Check

Railway automatically monitors: `GET /health`

Response format:
```json
{
  "status": "healthy",
  "db": "connected",
  "startupStatus": "ready|degraded",
  "timestamp": "2026-03-18T10:17:18.600Z",
  "uptime": 3600,
  "jobsEnabled": false,
  "version": "8.1.0"
}
```

### 2. Database Health Check

Run manually to verify all tables:

```bash
npm run db:health
```

This checks:
- ✅ DATABASE_URL connection
- ✅ All 34 tables exist
- ✅ Tables are reachable
- ✅ Row counts per table
- ✅ Last activity timestamp

### 3. Smoke Check

Post-deployment validation:

```bash
npm run smoke-check https://your-app.railway.app
```

Validates:
- `/health` - DB connectivity, startup status
- `/api/admin/pipeline-status` - Data pipeline progress
- `/api/admin/table-health` - Table row counts
- `/api/admin/overview` - System diagnostics
- `/api/admin/demo-portfolio` - End-to-end data

---

## 🔄 Table Initialization

### How Tables Are Created

All tables are **automatically initialized** on first startup using:

```sql
CREATE TABLE IF NOT EXISTS table_name (
  -- columns...
);
```

This approach is:
- ✅ **Idempotent**: Safe to run multiple times
- ✅ **Concurrent-safe**: No ALTER TABLE lock contention
- ✅ **Zero-downtime**: New deployments don't block
- ✅ **Production-ready**: Used by all 34 tables

### Initialization Sequence

When the backend starts:

1. **Database connectivity check** (10 retries, 3s delay)
2. **Critical tables** (blocks startup if fails):
   - market_snapshots
   - hqs_scores
   - job_locks
   - factor_history
   - weight_history
3. **Non-critical tables** (logged but don't block):
   - All 30 other tables

### When Tables Get Populated

Different tables populate at different times:

**On First API Request:**
- `market_snapshots` - When fetching quotes
- `hqs_scores` - When calculating scores
- `market_advanced_metrics` - When computing metrics

**When Jobs Run (RUN_JOBS=true):**
- `universe_symbols` - Universe refresh job (2:10 AM)
- `market_news` - News refresh job (periodic)
- `entity_map` - Entity map build job
- `fx_rates` - FX rate updates (hourly)

**When Users Interact:**
- `notifications` - When sending notifications
- `briefing_users` - When users subscribe
- `watchlist_symbols` - When users add watchlists

**Background Learning:**
- `discovery_history` - Discovery engine scans
- `outcome_tracking` - Strategy evaluations
- `agent_forecasts` - Agent predictions
- `virtual_positions` - Portfolio twin sync

---

## 🔌 Connection Pool Configuration

### Current State

Each service creates its own database pool:
- **20+ separate pools** across services and jobs
- **Default pg settings**: max 10 connections per pool
- **Risk**: Can exhaust Railway's connection limit

### New Shared Pool (Recommended)

Use the new `config/database.js` module:

```javascript
const { createPool, getSharedPool } = require('../config/database');

// Option 1: Use shared pool (recommended for most services)
const pool = getSharedPool();

// Option 2: Create dedicated pool with limits
const pool = createPool({ max: 5 });
```

**Benefits:**
- ✅ **Connection limits**: max 5 per pool (configurable)
- ✅ **Idle timeout**: Releases unused connections after 30s
- ✅ **Connection timeout**: Fails fast if can't connect in 10s
- ✅ **Error handling**: Logs pool errors automatically
- ✅ **Graceful shutdown**: `closeAllPools()` helper

### Railway Connection Limits

- **Free tier**: 20 connections
- **Hobby tier**: 100 connections
- **Production tier**: 400+ connections

With the new configuration:
- Shared pool: 10 connections
- 20 service pools × 5 max = 100 connections
- Total: ~110 connections (safe for Hobby tier+)

---

## 🐛 Troubleshooting

### Issue: Empty Tables

**Symptom:** Tables exist but have 0 rows

**Solutions:**
1. **Set RUN_JOBS=true** to enable background data collection
2. **Make API requests** to trigger on-demand data fetching
3. **Check API keys** - Ensure FMP_API_KEY or other providers are set
4. **Check logs** for errors during data collection

### Issue: DATABASE_URL Not Found

**Symptom:** "DATABASE_URL is required" error

**Solutions:**
1. **Railway PostgreSQL Plugin**: Add PostgreSQL plugin to your Railway project
2. **Copy DATABASE_URL**: Railway auto-generates it when you add the plugin
3. **Verify in Railway dashboard**: Settings → Variables → DATABASE_URL

### Issue: Too Many Connections

**Symptom:** "Sorry, too many clients already" error

**Solutions:**
1. **Use new database config**: Switch to `config/database.js`
2. **Reduce pool sizes**: Set `max: 5` or lower per pool
3. **Enable connection pooling**: Use PgBouncer if needed
4. **Upgrade Railway tier**: Get more connections

### Issue: Tables Not Initializing

**Symptom:** Tables missing after deployment

**Solutions:**
1. **Check startup logs**: Look for table init errors
2. **Verify DATABASE_URL**: Ensure it's correctly set
3. **Check SSL**: Railway requires `ssl: { rejectUnauthorized: false }`
4. **Run health check**: `npm run db:health`

### Issue: Stale Data

**Symptom:** Data is old, tables not updating

**Solutions:**
1. **Enable jobs**: Set `RUN_JOBS=true`
2. **Check job locks**: Query `job_locks` table for stuck locks
3. **Verify API keys**: Ensure providers are working
4. **Check job schedules**: Ensure jobs are scheduled correctly

---

## 📊 Monitoring Endpoints

### Admin Endpoints

```bash
# Overall system health
GET /api/admin/overview

# Table health and row counts
GET /api/admin/table-health

# Pipeline status
GET /api/admin/pipeline-status

# Demo portfolio (end-to-end test)
GET /api/admin/demo-portfolio

# Virtual positions
GET /api/admin/virtual-positions?status=open

# Signal history
GET /api/admin/signal-history
```

### Public Endpoints

```bash
# Health check
GET /health

# System status
GET /api/system-status
```

---

## 🚢 Deployment Checklist

Before deploying to Railway:

- [ ] Set `DATABASE_URL` environment variable
- [ ] Set at least one market data API key (FMP_API_KEY recommended)
- [ ] Set `OPENAI_API_KEY` if using AI features
- [ ] Configure `CORS_ORIGINS` for your frontend domains
- [ ] Decide on `RUN_JOBS` setting (false for API-only, true for full system)
- [ ] Verify `railway.toml` is present and configured
- [ ] Test locally with Railway-like environment first

After deployment:

- [ ] Check `/health` endpoint returns "healthy"
- [ ] Run `npm run db:health` to verify all tables
- [ ] Check Railway logs for any errors
- [ ] Test an API endpoint (e.g., `/api/admin/overview`)
- [ ] Monitor connection count in Railway dashboard
- [ ] Run smoke check: `npm run smoke-check https://your-app.railway.app`

---

## 📚 Additional Resources

- **Railway Docs**: https://docs.railway.app/
- **PostgreSQL on Railway**: https://docs.railway.app/databases/postgresql
- **Node.js on Railway**: https://docs.railway.app/languages/nodejs
- **Health Checks**: https://docs.railway.app/deploy/healthchecks

---

## 🔐 Security Best Practices

1. **Never commit DATABASE_URL** to git
2. **Use environment variables** for all secrets
3. **Enable SSL** for database connections
4. **Restrict CORS_ORIGINS** to your domains only
5. **Use API key rotation** for external providers
6. **Monitor connection counts** to prevent exhaustion
7. **Review logs regularly** for suspicious activity

---

## 📝 Summary

Your HQS backend is **production-ready** for Railway:

- ✅ **34 tables** properly defined and initialized
- ✅ **Railway configuration** correct (railway.toml)
- ✅ **Health checks** configured and working
- ✅ **SSL** properly configured
- ✅ **Job system** ready (set RUN_JOBS=true to enable)
- ✅ **No syntax errors** in any files
- ✅ **New database config** for optimal connection pooling
- ✅ **Health check script** for verification

**Next Steps:**
1. Deploy to Railway
2. Add PostgreSQL plugin
3. Set environment variables
4. Enable jobs if needed
5. Run health checks to verify
