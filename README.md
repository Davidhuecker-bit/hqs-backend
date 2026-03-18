# HQS Backend - Hyper-Quant System

Enterprise-grade quantitative trading backend with AI-powered market analysis, portfolio optimization, and automated decision-making.

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL database (Railway recommended)
- At least one market data API key (FMP recommended)

### Installation

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env and set required variables:
# - DATABASE_URL
# - FMP_API_KEY (or other market data provider)
# - OPENAI_API_KEY (optional, for AI features)
```

### Running Locally

```bash
# Development mode with auto-reload
npm run dev

# Production mode
npm start
```

The server will start on `http://localhost:8080` (or the port specified in `PORT` env var).

## 🏥 Health Checks

### Check Server Health

```bash
curl http://localhost:8080/health
```

### Check Database Health

```bash
# Verify all 35 tables exist and are populated
npm run db:health
```

### Full Smoke Test

```bash
# Test all admin endpoints
npm run smoke-check http://localhost:8080
```

## 📊 Database

The backend manages **35 PostgreSQL tables** across 7 categories:

- **Market Data** (6 tables): Real-time prices, metrics, news, FX rates
- **Agent & Prediction** (5 tables): Agent forecasts, audit trails
- **Learning & Discovery** (4 tables): Discovery engine, outcome tracking
- **Portfolio** (4 tables): Virtual positions, factor history, weights
- **Infrastructure** (7 tables): Job locks, pipeline status, entity mapping
- **Notifications** (4 tables): User preferences, watchlists, push tokens
- **External Data** (5 tables): SEC Edgar filings, tech radar

All tables are **automatically initialized** on first startup using idempotent `CREATE TABLE IF NOT EXISTS` statements.

For complete database documentation, see: [docs/RAILWAY_DATABASE_GUIDE.md](docs/RAILWAY_DATABASE_GUIDE.md)

## 🔧 Configuration

### Required Environment Variables

```bash
DATABASE_URL=postgresql://user:password@host:port/database
```

### Optional Environment Variables

```bash
# Server
PORT=8080                    # Default: 8080
RUN_JOBS=false              # Enable background jobs (default: false)

# CORS
CORS_ORIGINS=https://your-frontend.com

# Market Data (configure at least one)
FMP_API_KEY=...             # Financial Modeling Prep
FINNHUB_API_KEY=...         # Finnhub
TWELVE_DATA_API_KEY=...     # Twelve Data

# AI Features
OPENAI_API_KEY=...          # OpenAI
OPENAI_MODEL=gpt-4o-mini    # Default: gpt-4o-mini

# Cache (optional)
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...

# Performance Tuning
SNAPSHOT_BATCH_SIZE=80      # Default: 80
MC_SIMS=800                 # Monte Carlo simulations (default: 800)
CACHE_TTL_SECONDS=600       # Cache TTL (default: 600)
```

## 🌐 API Endpoints

### Public Endpoints

```bash
GET  /health                 # Server health check
GET  /api/system-status      # System status
POST /api/analyze            # Analyze a stock
POST /api/portfolio          # Analyze portfolio
GET  /api/segment/:segment   # Market segment data
```

### Admin Endpoints

```bash
GET /api/admin/overview              # System overview
GET /api/admin/table-health          # Database health
GET /api/admin/pipeline-status       # Data pipeline status
GET /api/admin/demo-portfolio        # Demo portfolio (20 symbols)
GET /api/admin/virtual-positions     # Portfolio twin positions
GET /api/admin/signal-history        # Signal tracking
GET /api/admin/outcome-analysis      # Outcome analytics
```

For complete API documentation, see: [docs/VERIFIZIERTE_ADMIN_ENDPUNKTE.md](docs/VERIFIZIERTE_ADMIN_ENDPUNKTE.md)

## 🤖 Background Jobs

Background jobs are **disabled by default**. Enable them by setting `RUN_JOBS=true`.

Available jobs:

- **Universe Refresh** (2:10 AM UTC) - Refresh trading universe from FMP
- **Snapshot Scan** (on-demand) - Collect market snapshots
- **Market News Refresh** (periodic) - Collect news articles
- **News Lifecycle Cleanup** (daily) - Clean up old news
- **Forecast Verification** (3:00 AM UTC) - Verify agent predictions
- **Causal Memory** (4:00 AM UTC) - Update agent weights
- **Tech Radar** (6:00 AM UTC) - Scan for system improvements

Run jobs manually:

```bash
npm run job:universe-refresh
npm run job:snapshot-scan
npm run job:market-news-refresh
```

## 🚢 Deployment to Railway

### Prerequisites

1. Create a Railway account at [railway.app](https://railway.app)
2. Install Railway CLI (optional): `npm i -g @railway/cli`

### Deployment Steps

1. **Create a new project** in Railway
2. **Add PostgreSQL plugin** to your project
3. **Deploy from GitHub**:
   - Connect your repository
   - Railway will auto-detect Node.js and use `railway.toml` config
4. **Set environment variables**:
   - `DATABASE_URL` - Auto-set by PostgreSQL plugin ✅
   - `FMP_API_KEY` - Your Financial Modeling Prep API key
   - `OPENAI_API_KEY` - Your OpenAI API key (optional)
   - `RUN_JOBS` - Set to `true` to enable background jobs
   - `CORS_ORIGINS` - Your frontend domain(s)

5. **Verify deployment**:
```bash
curl https://your-app.railway.app/health
npm run smoke-check https://your-app.railway.app
```

For detailed Railway deployment guide, see: [docs/RAILWAY_DATABASE_GUIDE.md](docs/RAILWAY_DATABASE_GUIDE.md)

## 🧪 Testing

### Syntax Validation

```bash
# Check server.js
npm run check

# Check all job scripts
npm run job:universe-refresh:check
npm run job:snapshot-scan:check
npm run job:market-news-refresh:check
```

### Integration Tests

```bash
# Database health check
npm run db:health

# Full smoke test (requires running server)
npm run smoke-check http://localhost:8080
```

## 📁 Project Structure

```
hqs-backend/
├── config/              # Configuration modules
│   ├── cache.js        # Cache configuration (Redis + local)
│   └── database.js     # Database pool configuration
├── docs/               # Documentation
│   └── RAILWAY_DATABASE_GUIDE.md
├── engines/            # Core quantitative engines
├── jobs/               # Background job scripts
├── public/             # Static files
├── routes/             # API route handlers
├── scripts/            # Utility scripts
│   ├── database-health-check.js
│   └── smoke-check.js
├── services/           # Business logic services (40+ services)
├── utils/              # Utility functions
├── hqsEngine.js        # Main HQS calculation engine
├── server.js           # Express server + startup logic
├── package.json        # Dependencies & scripts
└── railway.toml        # Railway deployment config
```

## 🔐 Security

- ✅ SSL/TLS configured for Railway PostgreSQL
- ✅ Environment variables for all secrets
- ✅ CORS protection
- ✅ Input validation on all endpoints
- ✅ Connection pooling with limits
- ✅ No hardcoded credentials

**Security Best Practices:**
- Never commit `.env` file
- Rotate API keys regularly
- Use Railway's secret management
- Monitor logs for suspicious activity
- Keep dependencies updated

## 🐛 Troubleshooting

### Empty Tables

**Problem:** Tables exist but have 0 rows

**Solutions:**
1. Set `RUN_JOBS=true` to enable background data collection
2. Make API requests to trigger on-demand data fetching
3. Verify API keys are set correctly
4. Check logs for errors

### Connection Issues

**Problem:** "Too many clients already"

**Solutions:**
1. Use shared pool configuration from `config/database.js`
2. Reduce pool size: `createPool({ max: 5 })`
3. Upgrade Railway tier for more connections

### Data Not Updating

**Problem:** Data is stale

**Solutions:**
1. Enable jobs with `RUN_JOBS=true`
2. Check job locks: `SELECT * FROM job_locks;`
3. Verify API keys are working
4. Check job schedules in environment variables

For more troubleshooting, see: [docs/RAILWAY_DATABASE_GUIDE.md](docs/RAILWAY_DATABASE_GUIDE.md#-troubleshooting)

## 📚 Documentation

- [Railway Database Guide](docs/RAILWAY_DATABASE_GUIDE.md) - Complete Railway setup
- [Admin API Contract](docs/admin-api-contract.md) - Admin endpoint documentation
- [Verified Admin Endpoints](docs/VERIFIZIERTE_ADMIN_ENDPUNKTE.md) - Endpoint catalog (German)
- [Signal & Agent Analysis](docs/BESTANDSAUFNAHME_SIGNAL_AGENTEN_OUTCOME.md) - Signal tracking (German)

## 🤝 Contributing

This is a private enterprise project. For questions or issues:

1. Check existing documentation in `/docs`
2. Run health checks: `npm run db:health`
3. Check logs for errors
4. Contact the development team

## 📄 License

Private & Proprietary

## 🎯 Version

**Current Version:** 8.1.0

**Node.js Requirement:** >= 18

---

**Built with:** Node.js, Express, PostgreSQL, OpenAI, Financial Market Data APIs
