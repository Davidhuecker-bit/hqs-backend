# Architektur-Empfehlung: hqs-scraping-service Integration

**Datum:** 2026-03-18  
**Status:** ✅ Startup-Hänger behoben (PR #80 gemerged)  
**Autor:** GitHub Copilot Architecture Review

---

## 🎯 Executive Summary

Der Startup-Hänger durch concurrent `ALTER TABLE` Operations ist durch PR #80 **bestätigt behoben**. Diese Analyse bewertet die aktuelle Architektur von `hqs-backend` und `hqs-scraping-service` und liefert konkrete Empfehlungen für stabilen Produktionsbetrieb auf Railway.

**Kernempfehlung:** 
- ✅ hqs-backend als **einziger** Core/API-Service mit `RUN_JOBS=true`
- ❌ Separaten hqs-scraping-service **NICHT** dauerhaft parallel betreiben
- ⚠️ **Ein letzter Fix nötig:** `factorHistory.repository.js` verwendet noch gefährliche ALTER TABLE

---

## 📊 Aktuelle Situation

### 1. Repository-Status

| Aspekt | Status |
|--------|--------|
| **Repository** | `Davidhuecker-bit/hqs-backend` (öffentlich auf GitHub) |
| **hqs-scraping-service** | ❌ NICHT als separates Repository vorhanden |
| **Architektur** | Alle Jobs in hqs-backend integriert |
| **RUN_JOBS Flag** | Kontrolliert ob Jobs innerhalb API-Server laufen |

**Befund:** Es gibt **kein** separates `hqs-scraping-service` Repository. Die Code-Kommentare beziehen sich vermutlich auf:
- Einen geplanten aber nie implementierten Service, oder
- Eine frühere Architektur mit zwei Railway Services die dieselbe Codebase nutzen

### 2. Aktueller Zustand: Job-Scheduling in hqs-backend

**12 Background Jobs** sind in `/jobs` verfügbar:

| Job | Zweck | Scheduling | RUN_JOBS erforderlich? |
|-----|-------|-----------|----------------------|
| **universeRefresh.job.js** | Stock Universe von FMP API laden | Startup + täglich 2:10 AM | ✅ Ja |
| **marketNewsRefresh.job.js** | Market News sammeln/analysieren | Alle 15 Min (Warmup Cycle) | ✅ Ja |
| **newsLifecycleCleanup.job.js** | News Retention verwalten | Alle 15 Min (Warmup Cycle) | ✅ Ja |
| **forecastVerification.job.js** | Prediction Self-Audit | Täglich 3:00 AM | ✅ Ja |
| **causalMemory.job.js** | Meta-Learning Rekalibrierung | Täglich 4:00 AM | ✅ Ja |
| **techRadar.job.js** | Innovation Scanner | Täglich 6:00 AM | ✅ Ja |
| **discoveryLearning.job.js** | Discovery Evaluation | Täglich 11:00 AM | ✅ Ja |
| **snapshotScan.job.js** | Batch Snapshot Scanning | Ad-hoc via CLI | ❌ Nein |
| **dailyBriefing.job.js** | Daily Market Briefing | Ad-hoc via CLI | ❌ Nein |
| **buildEntityMap.job.js** | Entity Mapping | Ad-hoc via CLI | ❌ Nein |
| **backfillSnapshotFx.job.js** | FX Rates Backfill | Ad-hoc via CLI | ❌ Nein |
| **discoveryNotify.job.js** | Discovery Notifications | Ad-hoc via CLI | ❌ Nein |

**Warmup Cycle** (alle 15 Minuten wenn `RUN_JOBS=true`):
- `runMarketNewsRefreshJob()`
- `runNewsLifecycleCleanupJob()`  
- `buildMarketSnapshot()` (Market Data Updates)

**Scheduled Jobs** (täglich zu festen Zeiten):
- 02:10 AM - Universe Refresh
- 03:00 AM - Forecast Verification
- 04:00 AM - Causal Memory
- 06:00 AM - Tech Radar
- 09:00 AM - Discovery Scan
- 11:00 AM - Discovery Learning

### 3. Gefundene DB-Initialisierungs-Risiken

#### ✅ BEHOBEN (PR #80):
- `services/outcomeTracking.repository.js` - ALTER TABLE entfernt
- `services/marketNews.repository.js` - ALTER TABLE entfernt
- `services/advancedMetrics.repository.js` - ALTER TABLE entfernt  
- `services/portfolioTwin.service.js` - ALTER TABLE entfernt
- `services/marketService.js` - ALTER TABLE bereits korrekt

#### ⚠️ NOCH OFFEN:
- **`services/factorHistory.repository.js` (Zeilen 74-87)** - Verwendet noch **14 gefährliche ALTER TABLE Statements**:

```javascript
// Schema safe upgrade (idempotent) ← FALSCH! Nicht safe bei concurrent startup
await pool.query(`ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS momentum FLOAT;`);
await pool.query(`ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS quality FLOAT;`);
await pool.query(`ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS stability FLOAT;`);
await pool.query(`ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS relative FLOAT;`);
await pool.query(`ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS market_average FLOAT;`);
await pool.query(`ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS volatility FLOAT;`);
await pool.query(`ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS forward_return_1h FLOAT;`);
await pool.query(`ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS forward_return_1d FLOAT;`);
await pool.query(`ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS forward_return_3d FLOAT;`);
await pool.query(`ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS portfolio_return FLOAT;`);
await pool.query(`ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS factors JSONB;`);
```

**Problem:** Diese Statements verursachen `AccessExclusiveLock` auf die Tabelle - selbst wenn die Spalte bereits existiert. Bei concurrent startup von zwei Services führt das zu Deadlock/Hang.

---

## 🚨 Risiken beim Parallelbetrieb

### Szenario: Zwei Services mit selber Codebase

Falls Railway zwei separate Services betreibt (beide nutzen `hqs-backend` Code):
- **Service 1:** hqs-backend (API) mit `RUN_JOBS=false`
- **Service 2:** hqs-scraping-service (Jobs) mit `RUN_JOBS=true`

**Risiken:**

| Risk | Severity | Details |
|------|----------|---------|
| **DB Lock Contention** | 🔴 CRITICAL | Beide starten concurrent → ALTER TABLE deadlock in factorHistory |
| **Doppelte Job-Execution** | 🟡 MEDIUM | Falls beide `RUN_JOBS=true` haben → duplicate news refresh, forecasts |
| **Race Conditions** | 🟡 MEDIUM | Concurrent writes in market_snapshots, outcome_tracking |
| **Resource Waste** | 🟠 LOW | Zwei Container, aber nur einer nutzt API, nur einer Jobs |
| **Deployment Complexity** | 🟠 LOW | Zwei Services syncen, zwei ENV configs, zwei restarts |

### Szenario: Ein Service mit RUN_JOBS=true

**Vorteile:**
- ✅ Keine concurrent table initialization
- ✅ Keine doppelten Jobs
- ✅ Einfaches Deployment (ein Service)
- ✅ Weniger Railway Ressourcen

**Nachteile:**
- ⚠️ API Requests und Jobs konkurrieren um CPU/Memory im selben Container
- ⚠️ Hohe Last durch Jobs könnte API Latency erhöhen

**Mitigation:**
- Railway erlaubt **vertical scaling** (mehr vCPU/RAM für einen Service)
- Node.js Event Loop ist gut für I/O-bound Tasks (was die meisten Jobs sind)
- Jobs nutzen `acquireLock()` für Concurrency Control

---

## 🎯 Empfohlene Zielarchitektur auf Railway

### ✅ OPTION A: Single-Service (EMPFOHLEN)

```
┌─────────────────────────────────────┐
│   Railway Service: hqs-backend      │
│                                     │
│  PORT=8080                          │
│  RUN_JOBS=true ← Jobs integriert    │
│  DATABASE_URL=postgresql://...      │
│                                     │
│  Funktionen:                        │
│  ✓ REST API (Express)               │
│  ✓ Background Jobs (scheduled)      │
│  ✓ Warmup Cycle (15 min)            │
│  ✓ Daily Jobs (cron-like)           │
└─────────────────────────────────────┘
         ↓
    PostgreSQL (Railway Plugin)
```

**Vorteile:**
- ✅ Einfachste Architektur
- ✅ Keine Concurrency-Probleme
- ✅ Ein Deployment, ein ENV config
- ✅ Ausreichend für current scale

**Wann upgraden?**
- Wenn API Traffic > 1000 req/min
- Wenn Jobs > 30 Min CPU-Zeit pro Stunde

### ❌ OPTION B: Dual-Service (NICHT EMPFOHLEN)

```
┌─────────────────────────────┐    ┌──────────────────────────────┐
│  hqs-backend (API)          │    │  hqs-scraping-service (Jobs) │
│  RUN_JOBS=false             │    │  RUN_JOBS=true               │
└─────────────────────────────┘    └──────────────────────────────┘
         ↓                                    ↓
              PostgreSQL (Shared - CONCURRENCY RISK!)
```

**Nachteile:**
- ❌ Concurrent startup → DB lock risk
- ❌ Doppelte Infrastruktur
- ❌ Komplexeres Deployment
- ❌ Nicht nötig bei current scale

**Nur sinnvoll wenn:**
- API Service hat > 5000 req/min sustained
- Job Service braucht > 4 GB RAM dedicated

### 🔄 OPTION C: Cron Job Service (ZUKÜNFTIG)

Falls Railway zukünftig "Cron Services" unterstützt:

```
┌─────────────────────────────┐
│  hqs-backend (API)          │
│  RUN_JOBS=false             │
└─────────────────────────────┘
         ↓
    PostgreSQL
         ↑
┌─────────────────────────────┐
│  Railway Cron Jobs          │
│  - universeRefresh @ 02:10  │
│  - forecastVerify  @ 03:00  │
│  - causalMemory    @ 04:00  │
│  etc.                       │
└─────────────────────────────┘
```

**Vorteil:** Klare Trennung, keine Dauerprozess-Konkurrenz

**Nachteil:** Railway Cron ist Beta (Stand 2026), noch nicht production-ready

---

## 📋 Konkrete Änderungen (REQUIRED)

### 🔴 KRITISCH: Fix factorHistory.repository.js

**Datei:** `services/factorHistory.repository.js`

**Zeilen 74-87 ERSETZEN:**

```javascript
// VORHER (gefährlich):
await pool.query(`ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS momentum FLOAT;`);
await pool.query(`ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS quality FLOAT;`);
// ... 9 weitere ALTER TABLE statements
```

**NACHHER (safe):**

```javascript
// Alle Spalten bereits in CREATE TABLE (Zeilen 46-70) definiert
// ALTER TABLE Statements KOMPLETT LÖSCHEN (Zeilen 73-87)
```

**Änderung:** Die Spalten sind bereits alle in `CREATE TABLE IF NOT EXISTS` (Zeilen 46-70) definiert. Die ALTER TABLE Statements sind **redundant und gefährlich**.

**Konkret zu tun:**
1. Zeilen 73-87 komplett löschen
2. Kommentar `// Schema safe upgrade (idempotent)` entfernen
3. Warnung hinzufügen:

```javascript
// IMPORTANT: Do NOT add ALTER TABLE ... ADD COLUMN statements here.
// ALTER TABLE acquires AccessExclusiveLock even with IF NOT EXISTS.
// All columns must be defined in CREATE TABLE above.
```

### ✅ DEPLOYMENT: Railway ENV Vars

**Für Single-Service Architektur (Option A):**

```bash
# Railway Service: hqs-backend
RUN_JOBS=true          # ← WICHTIG: Jobs aktivieren
DATABASE_URL=...       # Auto-set by Railway PostgreSQL plugin
PORT=8080
CORS_ORIGINS=...
OPENAI_API_KEY=...
FMP_API_KEY=...        # Für Universe Refresh
TWELVE_DATA_API_KEY=...
```

**Falls dual-service (Option B - nicht empfohlen):**

```bash
# Service 1: hqs-backend
RUN_JOBS=false         # Nur API

# Service 2: hqs-scraping-service  
RUN_JOBS=true          # Nur Jobs
PORT=8081              # Anderer Port (Railway auto-assign)
# Aber: FIX factorHistory FIRST!
```

### 📝 DEPLOYMENT: railway.toml

**Aktuell:**
```toml
[deploy]
startCommand = "npm start"
healthcheckPath = "/health"
healthcheckTimeout = 100
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3
```

**Empfehlung:** ✅ Keine Änderung nötig

Falls dual-service gewollt (nach Fix):

```toml
# In hqs-scraping-service repo:
[deploy]
startCommand = "npm start"
# KEIN healthcheck (ist kein API service)
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3

[build]
# Optional: Run migrations nur in einem Service
```

---

## 🔍 Merge-Status: Branch → main

**Aktueller Stand:**

```
Current Branch: copilot/merge-fix-init-outcome-tracking-table
Latest Commit:  ca431a2 "Initial plan" (2026-03-18)
Parent Commit:  3704bb2 "Merge PR #80 fix-init-outcome-tracking-table"
```

**PR #80 Status:** ✅ **BEREITS GEMERGED** (Commit 3704bb2)

**Was wurde in PR #80 gemerged:**
1. ✅ `outcomeTracking.repository.js` - ALTER TABLE entfernt
2. ✅ `advancedMetrics.repository.js` - ALTER TABLE entfernt
3. ✅ `marketNews.repository.js` - ALTER TABLE entfernt
4. ✅ `portfolioTwin.service.js` - ALTER TABLE entfernt

**Was fehlt noch:**
- ⚠️ `factorHistory.repository.js` - ALTER TABLE noch vorhanden (siehe oben)

**Empfehlung:** 
- Dieser Branch (`copilot/merge-fix-init-outcome-tracking-table`) hat nur einen "Initial plan" Commit
- Vermutlich ist das der aktuelle working branch für diese Analyse
- Nach dem factorHistory Fix: Merge in main (falls main branch existiert) oder direkt auf diesem Branch weiterarbeiten

**Railway Deployment:**
- Railway deployt automatisch wenn `main` branch updated wird (Standard-Config)
- Oder: Railway kann auf jeden Branch zeigen (in Service Settings konfigurierbar)
- Check: Railway Dashboard → Service Settings → Source → Branch

---

## ✅ Finales Empfehlungs-Checklist

### Sofort (Sprint 1):

- [x] ✅ Startup-Hänger Analyse (PR #80 bestätigt)
- [ ] 🔴 Fix `factorHistory.repository.js` (ALTER TABLE entfernen)
- [ ] ✅ Syntax-Check: `node --check services/factorHistory.repository.js`
- [ ] ✅ Railway ENV setzen: `RUN_JOBS=true` im hqs-backend Service
- [ ] ✅ Deployment triggern (git push to main)
- [ ] ✅ Health Check prüfen: `GET https://<railway-domain>/health`
- [ ] ✅ Logs prüfen: Keine "lock-contention" oder "deadlock" errors

### Mittelfristig (Sprint 2-3):

- [ ] 📊 Monitoring: Railway Metrics beobachten (CPU, Memory, Response Time)
- [ ] 🧪 Load Test: API unter Job-Last testen
- [ ] 📝 Dokumentation: DEPLOYMENT.md updaten mit RUN_JOBS=true Empfehlung
- [ ] 🔍 Code Audit: Alle `ALTER TABLE` in Repo finden: `grep -r "ALTER TABLE" services/`

### Langfristig (wenn nötig):

- [ ] 🚀 Scaling: Railway vertical scaling wenn API+Jobs zu viel Last
- [ ] 🔄 Architektur: Dual-Service nur bei nachweisbarem Bedarf
- [ ] 📈 Railway Cron: Evaluieren sobald stable

---

## 📚 Anhang: Technische Details

### Job-Lock Mechanismus

Alle scheduled Jobs nutzen **`acquireLock()`** aus `services/jobLock.repository.js`:

```javascript
// Verhindert doppelte Ausführung bei dual-service:
const locked = await acquireLock(lockName, maxAgeSeconds);
if (!locked) {
  logger.warn(`${lockName} already running, skipping`);
  return;
}
// ... job logic
```

**Zweck:** Selbst wenn zwei Services `RUN_JOBS=true` haben, verhindert das Lock doppelte Jobs.

**Aber:** Das Lock schützt NICHT vor concurrent table initialization! Darum müssen ALTER TABLE Statements weg.

### Railway Auto-Deploy

Railway deployt automatisch bei:
- Git Push to configured branch (default: `main`)
- Manual Deploy Button in Dashboard
- Railway CLI: `railway up`

**Check current deployment:**
```bash
# In Railway Dashboard:
Service → Deployments → Latest
```

### Health Check Details

`GET /health` Response:

```json
{
  "ready": true,
  "dbConnected": true,
  "jobsEnabled": true,
  "version": "8.1.0",
  "uptime": 3600,
  "lastError": null
}
```

**Railway nutzt das für:**
- Initial health check (100s timeout)
- Restart on failure policy
- Deployment success validation

---

## 🎬 Zusammenfassung

**Aktuelle Aufgabe des "Scraping Service":**
- ❌ Kein separater Service vorhanden
- ✅ Alle Jobs sind in hqs-backend integriert
- ✅ `RUN_JOBS=true` aktiviert Job-Scheduling

**Risiken beim Parallelbetrieb:**
- 🔴 DB Lock Deadlock (factorHistory noch offen)
- 🟡 Doppelte Job-Execution (durch Lock-Mechanismus minimiert)
- 🟠 Resource-Verschwendung

**Empfohlene Zielstruktur auf Railway:**
- ✅ **Ein Service** (hqs-backend) mit `RUN_JOBS=true`
- ❌ Kein separater scraping-service nötig
- 🔄 Dual-Service nur bei nachweisbarem Scale-Bedarf

**Exakte Änderungen:**
1. 🔴 `services/factorHistory.repository.js` Zeilen 73-87 löschen
2. ✅ Railway ENV: `RUN_JOBS=true` setzen
3. ✅ Git push → Auto-deploy
4. ✅ Health check verifizieren

**Nächste Schritte:**
1. factorHistory.repository.js fixen
2. Code Review + Syntax Check
3. Deploy to Railway main
4. 24h Monitoring
5. Done! ✅

---

*Generiert am: 2026-03-18 09:32 UTC*  
*Repository: Davidhuecker-bit/hqs-backend*  
*Branch: copilot/merge-fix-init-outcome-tracking-table*
