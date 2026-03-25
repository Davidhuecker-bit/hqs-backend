# Writer → Reader Matrix

> Erzeugt mit PR 2 – "Writer-Kette für Demo-/Admin-Portfolio und Kern-Read-Modelle stabilisieren"

## Tabellen-Übersicht

| Tabelle | Writer (Service/Job) | Reader (Service/Endpoint) | Pflicht für Demo-Portfolio? | Anmerkung |
|---|---|---|---|---|
| `briefing_users` | Admin-Seed / manuell | `dailyBriefing.job.js` | ❌ Nein | Basis für Daily Briefing |
| `briefing_watchlist` | Admin-Seed / manuell | `dailyBriefing.job.js` | ❌ Nein | Symbol-Watchlist pro User |
| `watchlist_symbols` | `universeRefresh.job.js`, Admin-Seed | `snapshotScan`, `marketNewsRefresh`, `buildEntityMap` | ❌ Nein (Fallback) | Universe-Fallback für Symbolliste |
| `market_snapshots` | `snapshotScan.job.js` → `marketService.buildMarketSnapshot()` | `adminDemoPortfolio`, `marketSummary.builder`, `frontendAdapter` | ✅ **Pflicht** (Preis) | Liefert lastPrice, changePercent |
| `hqs_scores` | `snapshotScan.job.js` → `marketService.buildMarketSnapshot()` | `adminDemoPortfolio`, `marketSummary.builder`, `worldState` | ✅ **Pflicht** (Score) | Liefert hqsScore, momentum, quality |
| `market_news` | `marketNewsRefresh.job.js` → `marketNews.repository` | `adminDemoPortfolio`, `marketNews.routes` | ⚪ Optional | Fehlen degradiert nicht auf rot |
| `fx_rates` | `fx.service.refreshAndPersistFxRate()` (via snapshotScan), passive via `getUsdToEurRate()` | `adminDemoPortfolio`, `marketService`, `discoveryEngine` | ⚪ Optional (Fallback-Kette) | USD→EUR Kurs, 4-Tier Fallback |
| `ui_summaries` | `marketSummary.builder`, `adminDemoPortfolio.service`, `guardianStatusSummary.builder` | `/api/market`, `/api/admin/demo-portfolio`, `/api/admin/guardian-status-summary` | ✅ **Pflicht** (Cache) | Prepared Read-Modelle |
| `pipeline_status` | `marketService.updatePipelineStage()`, Jobs via `savePipelineStage()` | `/api/admin/pipeline-status`, `guardianStatusSummary.builder` | ⚪ Optional | Monitoring / Guardian Health |
| `job_locks` | `jobLock.repository.acquireLock()` (alle Jobs) | Alle Jobs (Dedup-Guard) | ⚪ Optional | Verhindert parallele Job-Runs |

## Demo-Portfolio Datenkette

```
                          ┌─────────────────────┐
                          │  universe_symbols    │ ← universeRefresh.job
                          │  (oder DEFAULT_20)   │
                          └──────────┬──────────┘
                                     │ Symbol-Liste
                                     ▼
              ┌──────────────────────────────────────────┐
              │      snapshotScan.job.js                  │
              │  (buildMarketSnapshot + refreshFxRate)     │
              └──────┬──────────┬──────────┬─────────────┘
                     │          │          │
                     ▼          ▼          ▼
            market_snapshots  hqs_scores  fx_rates
            (Preis, FX)      (Score)     (USD→EUR)
                     │          │          │
                     └──────┬───┘          │
                            ▼              │
              ┌─────────────────────────┐  │
              │ adminDemoPortfolio      │◄─┘
              │   .service.js           │
              │  (5 Batch-Loader)       │
              └──────────┬──────────────┘
                         │
                         ▼
              ┌─────────────────────────┐
              │ ui_summaries            │
              │ (demo_portfolio)        │
              └──────────┬──────────────┘
                         │
                         ▼
              /api/admin/demo-portfolio
```

## Pflicht vs. Optional für Demo-Portfolio

### Pflicht (Core):
- **market_snapshots** → Preis (`lastPrice`), Kursänderung (`changePercent`)
- **hqs_scores** → HQS-Score, Momentum, Quality, Stability

### Optional (Supplementary):
- **market_news** → Nachrichten (fehlen = degraded, nicht rot)
- **market_advanced_metrics** → Regime, Trend, Volatilität (fehlen = degraded, nicht rot)
- **fx_rates** → FX-Kurs (4-stufiger Fallback: Live → DB → Cache → Static)
- **outcome_tracking** → Signal, Confidence (optional enrichment)

## Freshness-Regeln (nach PR 2)

| Quelle | Stale nach | Hard-Stale nach | Auswirkung bei Stale |
|---|---|---|---|
| Snapshot (Preis) | 48h | 168h (7d) | yellow (vorher 24h/72h) |
| HQS Score | 72h | – | yellow (vorher 48h) |
| Advanced Metrics | 72h | – | keine Auswirkung (optional) |
| News | 168h (7d) | – | keine Auswirkung (optional) |

### Bisherige Ursachen für stale/hard-stale (behoben):
1. **Snapshot stale bei 24h** → Jetzt 48h (US-Markt Wochenende-sicher)
2. **Hard-stale bei 72h verwarf Preis** → Jetzt 168h, Preis wird behalten + Flag
3. **Fehlende News → yellow** → Jetzt: News optional, kein gelb nur wegen News
4. **Metrics als Core-Pflicht** → Jetzt supplementary
5. **fx_rates leer → FX-Konvertierung schlägt fehl** → Jetzt aktives Schreiben via Cron

## Pipeline-Status Tracking (nach PR 2)

| Stage | Job/Service | Neu? |
|---|---|---|
| `universe` | snapshotScan.job → marketService | bestehend |
| `snapshot` | snapshotScan.job → marketService | bestehend |
| `advancedMetrics` | snapshotScan.job → marketService | bestehend |
| `hqsScoring` | snapshotScan.job → marketService | bestehend |
| `outcome` | snapshotScan.job → marketService | bestehend |
| `market_news_refresh` | marketNewsRefresh.job | ✅ **Neu** |
| `universe_refresh` | universeRefresh.job | ✅ **Neu** |
| `build_entity_map` | buildEntityMap.job | ✅ **Neu** |
| `daily_briefing` | dailyBriefing.job | ✅ **Neu** |
| `summary_refresh` | uiSummaryRefresh (reserved) | ✅ **Neu** (Stage) |

## Guardian Status

Guardian-Status nutzt nur:
- `worldState.service` (Regime, Risk, Volatility)
- `pipeline_status` (Stage Health)

**Nicht** direkt: `autonomy_audit`, `guardian_near_miss` (diese sind optional und werden von der Guardian-Health-Chain nicht mehr als Pflicht-Input geführt).

## Offene Restprobleme

1. **market_advanced_metrics** wird nur via `snapshotScan → historicalService` geschrieben – benötigt gefüllte `prices_daily` (via Python Historical Backfill)
2. **outcome_tracking** wird passiv via snapshotScan geschrieben – Timing-abhängig
3. **FX API** (exchangerate.host) kann ausfallen → Static-Fallback (`FX_STATIC_USD_EUR` Env) empfohlen
4. **Daily Briefing** hängt von `briefing_users` ab – muss manuell/admin geseeded werden
5. **prices_daily** wird vom Python Historical Backfill Service befüllt (separater Railway Service). Ohne diesen Service sind `market_advanced_metrics` auf Snapshot-Daten begrenzt.
