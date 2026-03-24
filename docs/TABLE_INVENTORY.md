# HQS Backend – Complete Table Inventory

> Last updated: 2026-03-24  
> Source: `scripts/db-inventory.js`, `services/tableHealth.service.js`

---

## Overview

The HQS backend uses a Railway-hosted PostgreSQL database with **36 production tables** (including the `ui_summaries` read-model and `snapshot_scan_state` tracking table). Tables are organized into logical groups corresponding to the major data-flow chains.

---

## Quick Health Reference

| Status | Meaning |
|--------|---------|
| 🟢 Required & Populated | Table must have data for system to function |
| 🟡 Optional / Low | Table may be empty depending on features active |
| ⚪ Expected Empty | Table is empty by design unless a specific feature is enabled |
| ❌ Missing | Table not yet created (run server startup to initialize) |

---

## 1. Core Market Data

| Table | Purpose | Written By | Read By | Required |
|-------|---------|-----------|---------|---------|
| `market_snapshots` | Real-time price/volume snapshots from FMP/TwelveData API | `snapshotScan.job` → `marketService.buildMarketSnapshot()` | `marketSummary.builder`, `adminDemoPortfolio.service`, `worldState.service` | ✅ Yes |
| `hqs_scores` | HQS scoring results per symbol, calculated from snapshot data | `hqsEngine.buildHQSResponse()` (inside snapshotScan) | `marketSummary.builder`, `guardianStatusSummary.builder`, `worldState.service` | ✅ Yes |
| `market_advanced_metrics` | Regime/volatility/trend analytics per symbol | `snapshotScan.job` → `marketService` | `worldState.service`, `opportunityScanner.service` | ✅ Yes |
| `factor_history` | Persistent HQS factor audit trail with shadow-HQS and explainability | `factorHistory.repository.saveScoreSnapshot()` | `/api/admin/hqs-*-meta` endpoints | ✅ Yes |
| `fx_rates` | FX rates (USD/EUR) for currency conversion | `fx.service` (during snapshot scan) | `marketService` (fallback to `FX_STATIC_USD_EUR` env if empty) | ⚠️ Optional (env fallback) |

### Data Flow: Market Chain
```
FMP/TwelveData API
    → snapshotScan.job
        → market_snapshots (raw OHLCV + price)
        → hqs_scores (composite quality score)
        → market_advanced_metrics (regime/volatility)
        → factor_history (audit trail)
        → pipeline_status (run counts)
    → ui_summaries (type=market_list)
    → /api/market
```

---

## 2. Scoring & Forecasts

| Table | Purpose | Written By | Read By | Required |
|-------|---------|-----------|---------|---------|
| `outcome_tracking` | Strategy outcome tracking for forecast verification | `opportunityScanner.service` | `forecastVerification.job`, `signalHistory.repository` | ⚠️ Optional |
| `agent_forecasts` | Agent predictions from agentic debate | `agentForecast.repository` (during debate) | `forecastVerification.job`, `/api/admin/*` | ⚪ Optional |
| `agents` | Agent definitions (GROWTH_BIAS, RISK_SKEPTIC, MACRO_JUDGE) | Server startup (`initAgentsTable`) | `agentForecast.repository`, `causalMemory.repository` | ✅ Yes (3 rows expected) |
| `weight_history` | Historical record of HQS weight adjustments | `weightHistory.repository` | `/api/admin/weight-history` | ⚠️ Optional |
| `dynamic_weights` | Current causal memory weights for adaptive HQS scoring | `causalMemory.job` | `hqsEngine` (via worldState context) | ⚠️ Optional |

---

## 3. Pipeline & Operations

| Table | Purpose | Written By | Read By | Required |
|-------|---------|-----------|---------|---------|
| `pipeline_status` | Per-stage run counts (universe→snapshot→scoring→outcome) | `pipelineStatus.repository.savePipelineStage()` | `/api/admin/pipeline-status` | ✅ Yes (5 rows expected) |
| `job_locks` | Distributed job deduplication locks | `jobLock.repository.acquireLock()` | All background jobs | ⚠️ Optional (transient) |
| `admin_snapshots` | JSONB admin state snapshots for diagnostics | `adminSnapshots.repository` | `/api/admin/snapshots` | ⚠️ Optional |

### `pipeline_status` Columns
- `stage` – one of: `universe`, `snapshot`, `advancedMetrics`, `hqsScoring`, `outcome`
- `last_run_at` – timestamp of most recent run (any result)
- `last_healthy_run` – timestamp of most recent run with `success_count > 0` (**new**)
- `input_count`, `success_count`, `failed_count`, `skipped_count` – last run counts
- `updated_at` – row update timestamp

---

## 4. Universe & Scan State

| Table | Purpose | Written By | Read By | Required |
|-------|---------|-----------|---------|---------|
| `universe_symbols` | Active stock universe – source for all market data scans | `universeRefresh.job` | `snapshotScan.job`, `opportunityScanner.service` | ✅ Yes (100+ rows expected) |
| `universe_scan_state` | Cursor/offset tracking for rolling universe scans | `universe.repository.saveCursor()` | `snapshotScan.job` | ⚠️ Optional |

---

## 5. User & Notifications

| Table | Purpose | Written By | Read By | Required |
|-------|---------|-----------|---------|---------|
| `watchlist_symbols` | User watchlist symbols | API endpoints | `marketService`, briefing jobs | ⚪ Optional |
| `briefing_users` | Briefing subscribers (email + push preferences) | `notifications.repository` | `dailyBriefing.job` | ⚪ Optional |
| `briefing_watchlist` | Per-user briefing watchlist symbols | `notifications.repository` | `dailyBriefing.job` | ⚪ Optional |
| `user_devices` | User push notification device tokens | `notifications.repository` | `discoveryNotify.job` | ⚪ Optional |
| `notifications` | System notifications for users | `notifications.repository` | `/api/notifications` | ⚪ Optional |

---

## 6. News & Entity Intelligence

| Table | Purpose | Written By | Read By | Required |
|-------|---------|-----------|---------|---------|
| `market_news` | News articles with sentiment scores from FMP API | `marketNewsRefresh.job` → `marketNews.repository` | `newsIntelligence.service`, `/api/market-news` | ✅ Yes |
| `entity_map` | Symbol-to-entity mapping for news enrichment | `buildEntityMap.job` → `entityMap.repository` | `newsIntelligence.service` | ⚠️ Optional (may be empty if job hasn't run) |

---

## 7. Guardian & Autonomy

| Table | Purpose | Written By | Read By | Required |
|-------|---------|-----------|---------|---------|
| `guardian_near_miss` | Near-miss opportunity records from guardian system | `autonomyAudit.repository.saveNearMiss()` | `guardianService`, `/api/admin/guardian-status-summary` | ⚪ Optional |
| `autonomy_audit` | Autonomy decision audit trail | `autonomyAudit.repository` | `guardianService`, `/api/admin/guardian-status-summary` | ⚪ Optional (empty unless autonomous mode enabled) |
| `automation_audit` | Automation action tracking | `autonomyAudit.repository` | `/api/admin/*` | ⚪ Optional (empty unless autonomous mode enabled) |

---

## 8. Discovery & Learning

| Table | Purpose | Written By | Read By | Required |
|-------|---------|-----------|---------|---------|
| `discovery_history` | Discovery engine results (scanned stocks and signals) | `discoveryLearning.job` | `discoveryEngine.service`, `forwardLearning.service` | ⚪ Optional |
| `learning_runtime_state` | Discovery learning runtime state (key/value store) | `discoveryLearning.repository` | `discoveryLearning.job` | ⚪ Optional (empty until first learning cycle) |

---

## 9. Portfolio

| Table | Purpose | Written By | Read By | Required |
|-------|---------|-----------|---------|---------|
| `virtual_positions` | Virtual (paper) portfolio positions | `portfolioTwin.service` | `/api/admin/virtual-positions`, `portfolioTwin.service` | ⚪ Optional |

---

## 10. SEC EDGAR (Conditional Feature)

| Table | Purpose | Written By | Read By | Required |
|-------|---------|-----------|---------|---------|
| `sec_edgar_companies` | SEC EDGAR company registry | `secEdgar.repository` | `/api/sec-edgar/*` | ⚪ Optional (feature must be explicitly activated) |
| `sec_edgar_company_facts` | SEC EDGAR financial facts per company | `secEdgar.repository` | `/api/sec-edgar/*` | ⚪ Optional |
| `sec_edgar_filing_signals` | Derived signals from SEC filings | `secEdgar.repository` | `/api/sec-edgar/signals` | ⚪ Optional |

---

## 11. Tech & Evolution

| Table | Purpose | Written By | Read By | Required |
|-------|---------|-----------|---------|---------|
| `tech_radar_entries` | Tech radar scan results (innovation tracking) | `techRadar.job` → `techRadar.service` | `/api/admin/tech-radar` | ⚪ Optional |
| `system_evolution_proposals` | System evolution proposals from tech radar | `techRadar.service` | `/api/admin/tech-radar` | ⚪ Optional |

---

## 12. History & Intelligence Score

| Table | Purpose | Written By | Read By | Required |
|-------|---------|-----------|---------|---------|
| `sis_history` | System Intelligence Score (SIS) history | `sisHistory.service` | `systemIntelligence.service`, `/api/admin/sis` | ⚪ Optional |

---

## 13. Read Model (UI Summaries)

| Table | Purpose | Written By | Read By | Required |
|-------|---------|-----------|---------|---------|
| `ui_summaries` | Pre-built UI summary cache keyed by type | `uiSummaryRefresh.service` via builder functions | `/api/market`, `/api/admin/demo-portfolio`, `/api/admin/guardian-status-summary` | ✅ Yes (3 types expected: `market_list`, `demo_portfolio`, `guardian_status`) |

### `ui_summaries` Types
| `summary_type` | Built By | Consumed By | Max Age |
|----------------|----------|-------------|---------|
| `market_list` | `marketSummary.builder.refreshMarketSummary()` | `/api/market` | 5 minutes |
| `demo_portfolio` | `adminDemoPortfolio.service.refreshDemoPortfolio()` | `/api/admin/demo-portfolio` | 10 minutes |
| `guardian_status` | `guardianStatusSummary.builder.refreshGuardianStatusSummary()` | `/api/admin/guardian-status-summary` | 3 minutes |

---

## Admin Diagnostic Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/admin/table-health` | Traffic-light status for all 36 tables (green/yellow/red) |
| `GET /api/admin/data-flow-health` | Comprehensive chain-level freshness for all 8 data flows |
| `GET /api/admin/pipeline-status` | Per-stage pipeline run counts with `last_healthy_run` |
| `GET /api/admin/ui-summaries` | Freshness + rebuild status for all 3 UI summary types |
| `GET /api/admin/ui-summaries-health` | Compact health snapshot for all summary types |
| `GET /api/admin/world-state` | Current world state with freshness metadata |

---

## Scripts

| Script | Description |
|--------|-------------|
| `node scripts/database-health-check.js` | Connection check + row counts for all 34 base tables |
| `node scripts/data-chain-health.js` | Deep diagnostic: snapshot↔HQS alignment, FX, pipeline |
| `node scripts/data-chain-health.js --fix` | Auto-repair: backfill FX, init agents, clean pipeline |
| `node scripts/db-inventory.js` | Full integrity check: existence, columns, cross-table integrity |
| `node scripts/db-inventory.js --json` | JSON output for programmatic consumption |

---

## Troubleshooting Guide

### `/api/market` returns empty or stale data
1. Check `GET /api/admin/table-health` – `market_snapshots` and `hqs_scores` should be green
2. Check `GET /api/admin/ui-summaries` – `market_list` should be fresh (< 5 min)
3. Check `GET /api/admin/pipeline-status` – `snapshot` and `hqsScoring` stages should have recent `last_run_at`
4. If `RUN_JOBS=false`, the snapshot scan won't run automatically – trigger via `POST /api/admin/snapshot`
5. If `FX_STATIC_USD_EUR` is not set and `fx_rates` is empty, some symbols may be skipped

### `/api/admin/demo-portfolio` shows degraded data
1. Check `GET /api/admin/data-flow-health` – `portfolio` chain should show "fresh"
2. Force refresh: `POST /api/admin/refresh-summary/demo_portfolio`
3. Check `market_snapshots` freshness – portfolio reads prices from there

### Guardian status is stale
1. Check `GET /api/admin/ui-summaries-health` – `guardian_status` operational status
2. Force refresh: `POST /api/admin/refresh-summary/guardian_status`
3. Check `hqs_scores` freshness – guardian reads quality scores from there

### Missing entity_map data (news not enriched)
- Run `buildEntityMap.job` manually or ensure `RUN_JOBS=true` is set
- `entity_map` is empty until this job completes at least one cycle

### pipeline_status shows stale stages
- Check `last_healthy_run` column – if NULL, the stage has never completed successfully
- If `last_run_at` is old (> 24h), jobs are not running – check `RUN_JOBS` env var
- Run `node scripts/data-chain-health.js` for a detailed diagnosis

---

## Data Cleanup Job

The `jobs/dataCleanup.job.js` runs daily (default: 02:00 AM) when `RUN_JOBS=true`:
- **`universe_scan_state`**: Removes duplicate/stale cursor entries older than 7 days (keeps newest per key)
- **`job_locks`**: Removes expired locks older than 6 hours (crashed process cleanup)
- **`pipeline_status`**: Audits staleness but does NOT delete entries (they persist as historical markers)

Configure via environment variables:
```
DATA_CLEANUP_HOUR=2                    # Hour to run (default: 2)
DATA_CLEANUP_MINUTE=0                  # Minute to run (default: 0)
DATA_CLEANUP_LOCK_EXPIRY_HOURS=6       # Remove job_locks older than N hours
DATA_CLEANUP_UNIVERSE_SCAN_KEEP_DAYS=7 # Keep universe_scan_state for N days
DATA_CLEANUP_PIPELINE_STALE_HOURS=72   # Warn if pipeline stage older than N hours
```
