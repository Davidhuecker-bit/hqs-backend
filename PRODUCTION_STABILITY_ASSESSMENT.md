# Production Stability Assessment - hqs-backend
**Datum:** 2026-03-18  
**Status:** Produktionsnah geprüft  
**Railway Service:** hqs-backend

---

## 🎯 Executive Summary

Die **hqs-backend** Architektur ist grundsätzlich stabil für den Produktionsbetrieb auf Railway. Alle kritischen ALTER TABLE Fixes sind in `main` enthalten. Die Job-Scheduling-Architektur verwendet Locks und ein Self-Rescheduling Pattern, das doppelte Ausführungen auf einer einzelnen Instanz verhindert.

**Empfehlung:** ✅ **Für Railway Production bereit mit `RUN_JOBS=true`**

---

## Teil 1: Was ist bereits korrekt?

### ✅ 1.1 Alle relevanten Fixes in `main` enthalten

**Status:** BESTÄTIGT

Überprüfung der kritischen Repositories:
- ✅ `services/factorHistory.repository.js` - Alle Spalten in CREATE TABLE, keine ALTER TABLE (Zeilen 54-79)
- ✅ `services/outcomeTracking.repository.js` - Keine gefährlichen ALTER TABLE
- ✅ `services/marketService.js` - Alle Spalten in CREATE TABLE definiert
- ✅ `services/portfolioTwin.service.js` - Keine ALTER TABLE in init
- ✅ `services/advancedMetrics.repository.js` - Keine ALTER TABLE in init
- ✅ `services/agentForecast.repository.js` - Keine ALTER TABLE in init
- ✅ `services/autonomyAudit.repository.js` - Keine ALTER TABLE in init
- ✅ `services/discoveryLearning.repository.js` - Keine ALTER TABLE in init

**Noch vorhandene ALTER TABLE Statements** (aber SAFE):
- `services/marketNews.repository.js:234` - ALTER TABLE ADD CONSTRAINT (wrapped in DO block mit IF NOT EXISTS Check)
- `services/secEdgar.repository.js:130,145` - ALTER TABLE DROP CONSTRAINT (wrapped in DO block mit IF EXISTS Check)

Diese sind **unkritisch**, da:
1. Sie nur in PL/pgSQL Blöcken laufen (DO $$)
2. Existenz-Checks durchführen BEVOR ALTER ausgeführt wird
3. Constraints hinzufügen/entfernen statt Spalten

### ✅ 1.2 Railway Konfiguration korrekt

**railway.toml:**
```toml
[deploy]
startCommand = "npm start"              # ✅ Korrekt
healthcheckPath = "/health"             # ✅ Korrekt
healthcheckTimeout = 100                # ✅ 100s ausreichend
restartPolicyType = "on_failure"        # ✅ Korrekt
restartPolicyMaxRetries = 3             # ✅ Verhindert Restart-Loop
```

**Deployment Flow:**
1. Railway detected Node.js via package.json ✅
2. Führt automatisch `npm install` aus ✅
3. Startet mit `npm start` (prestart Syntax-Check via `npm run check`) ✅
4. Überwacht `/health` Endpoint ✅

### ✅ 1.3 RUN_JOBS Konfiguration validiert

**server.js Zeilen 148-149:**
```javascript
const RUN_JOBS =
  String(process.env.RUN_JOBS || "false").toLowerCase() === "true";
```

**Verwendung:**
- Zeile 342: Health Endpoint gibt `jobsEnabled: RUN_JOBS` zurück
- Zeile 1040: `if (RUN_JOBS)` Gate für alle Background Jobs
- Zeile 1041: Logger bestätigt: "RUN_JOBS=true -> starting background jobs inside API server"

**Environment Variable Setting:**
Railway Dashboard → Service Settings → Variables → `RUN_JOBS=true` setzen

### ✅ 1.4 Health Endpoint validiert

**Endpoint:** `GET /health`

**Expected Response (200 OK wenn Server läuft):**
```json
{
  "success": true,
  "ready": true,
  "generatedAt": "2026-03-18T09:50:00.000Z",
  "db": "ok",
  "dbReady": true,
  "startedAt": "2026-03-18T09:49:45.123Z",
  "completedAt": "2026-03-18T09:49:58.456Z",
  "jobsEnabled": true,
  "initErrors": null,
  "startupError": null,
  "lastCriticalError": null
}
```

**Expected Response (200 OK aber degraded startup):**
```json
{
  "success": true,
  "ready": true,
  "db": "ok",
  "dbReady": true,
  "jobsEnabled": true,
  "initErrors": [
    {
      "label": "initDiscoveryTable",
      "error": "...",
      "critical": false
    }
  ],
  "startupError": "1 init step(s) failed: initDiscoveryTable"
}
```

**Railway Restart Loop Prevention:**
- 503 wird nur während startup (vor listen callback completion) zurückgegeben
- Nach erfolgreichem Server-Start immer 200, auch bei DB-Fehlern
- Verhindert infinite restart loops bei temporären DB-Issues

### ✅ 1.5 Background Jobs mit Lock-Protection

**Jobs mit acquireLock:**
1. ✅ `universe_refresh_job` (2h TTL) - server.js:759
2. ✅ `forward_learning_job` (12min TTL) - server.js:743
3. ✅ `discovery_scan_job` (30min TTL) - server.js:777
4. ✅ `discovery_learning_eval_job` (30min TTL) - server.js:800
5. ✅ `market_news_refresh_job` (1h TTL) - jobs/marketNewsRefresh.job.js:237
6. ✅ `news_lifecycle_cleanup_job` (1h TTL) - jobs/newsLifecycleCleanup.job.js:21
7. ✅ `daily_briefing_job` (15min TTL) - jobs/dailyBriefing.job.js:68
8. ✅ `discovery_notify_job` (20min TTL) - jobs/discoveryNotify.job.js:15
9. ✅ `discovery_learning_job` (20min TTL) - jobs/discoveryLearning.job.js:23

**Lock Mechanism** (`services/jobLock.repository.js`):
```sql
INSERT INTO job_locks(name, locked_until)
VALUES ($1, NOW() + ($2 || ' seconds')::interval)
ON CONFLICT(name) DO UPDATE
  SET locked_until = NOW() + ($2 || ' seconds')::interval
  WHERE job_locks.locked_until < NOW()
```
- Atomare Operation via `INSERT ... ON CONFLICT`
- Nur erfolgreich wenn Lock abgelaufen ist
- TTL verhindert ewige Locks bei Absturz

### ✅ 1.6 Job Scheduling Pattern verhindert Doppelausführung

**Pattern:** Self-Reschedule nach Completion
```javascript
setTimeout(async () => {
  try {
    await runJobLocked();
  } catch (err) {
    logger.error("Job failed", { message: err.message });
  } finally {
    scheduleJobAgain();  // Reschedule NACH completion
  }
}, delay);
```

**Verwendet bei:**
- `scheduleDailyUniverseRefresh()` - Zeile 1108-1127
- `scheduleDailyForecastVerification()` - Zeile 1133-1149
- `scheduleCausalMemoryRecalibration()` - Zeile 1155-1171
- `scheduleTechRadarScan()` - Zeile 1177-1193
- `scheduleDailyDiscoveryScan()` - Zeile 1199-1216
- `scheduleDailyDiscoveryLearning()` - Zeile 1222-1238

**Warmup Cycle** (15-Minuten Interval):
```javascript
setInterval(async () => {
  try {
    await runIntegratedWarmupCycle();
    logger.info("Warmup executed");
  } catch (err) {
    logger.error("Warmup Fehler", { message: err.message });
  }
}, 15 * 60 * 1000);
```

**Schutz gegen Doppelausführung:**
1. ✅ setTimeout/setInterval = nur 1 Timer pro Instance
2. ✅ finally-Block = Reschedule erst nach Completion
3. ✅ acquireLock() in Jobs = zusätzliche DB-Ebene Protection

### ✅ 1.7 Startup Init Pattern ist robust

**DB Readiness Check** (server.js:934-950):
- Wartet bis zu `STARTUP_DB_MAX_RETRIES * STARTUP_DB_RETRY_DELAY_MS` auf DB
- Überspringt alle Table Inits wenn DB nicht erreichbar
- Verhindert Crash bei temporären DB-Problemen

**Init Steps kategorisiert** (server.js:965-990):
- **CRITICAL:** `ensureTablesExist`, `initJobLocksTable`, `initFactorTable`, `initWeightTable`
- **NON-CRITICAL:** Alle anderen Tables

**Error Handling:**
- Einzelne Init-Fehler stoppen Startup nicht
- `initErrors` Array wird in `/health` Response zurückgegeben
- Railway kann Deployment entscheiden basierend auf `lastCriticalError`

---

## Teil 2: Was ist noch offen?

### ⚠️ 2.1 Fehlende Locks bei einigen Daily Jobs

**Problem:** Forecast Verification, Causal Memory und Tech Radar Jobs haben KEINE acquireLock() Aufrufe.

**Betroffene Jobs:**
- `jobs/forecastVerification.job.js` - KEIN Lock
- `jobs/causalMemory.job.js` - KEIN Lock  
- `jobs/techRadar.job.js` - KEIN Lock

**Risiko bei Multi-Instance Deployment:**
Wenn Railway mehrere Instances von `hqs-backend` mit `RUN_JOBS=true` deployed:
- Jede Instance scheduled den gleichen Job zur gleichen Zeit
- Ohne Lock könnten Jobs parallel laufen
- Potentielle Race Conditions bei DB-Writes

**Aktuelles Risiko:** ❌ LOW
- Nur relevant wenn Railway > 1 Instance deployed
- Aktuell vermutlich 1 Instance = kein Problem
- setTimeout pattern verhindert Doppelausführung auf DERSELBEN Instance

**Empfohlene Lösung:** Jobs mit Locks nachrüsten (siehe Teil 3)

### ⚠️ 2.2 Keine Railway Environment Variables Dokumentation

**Fehlend:**
- Welche `RUN_JOBS` Wert ist aktuell in Railway gesetzt?
- Sind alle API Keys (FMP, OPENAI, MASSIVE, etc.) konfiguriert?
- Ist `CORS_ORIGINS` für Frontend gesetzt?

**Empfehlung:** Railway Dashboard → Variables Screenshot oder Export

### ⚠️ 2.3 Keine Log-Analyse der aktuellen Production Instance

**Fehlend:**
- Zeigen die Railway Logs dass Jobs sauber genau einmal starten?
- Gibt es Hinweise auf Lock Contention?
- Gibt es Hinweise auf DB Connection Pool Exhaustion?

**Empfehlung:** Railway Dashboard → Logs analysieren nach Deployment

---

## Teil 3: Nächster kleinster sicherer Schritt

### 🎯 Schritt 1: Lock Protection für fehlende Jobs hinzufügen

**Ziel:** Alle scheduled Jobs mit DB-Locks absichern

**Änderung 1:** `jobs/forecastVerification.job.js`
```javascript
// VORHER (Zeile 31):
async function runForecastVerificationJob() {
  return runJob("forecastVerification", async () => {
    let verified24h = 0;
    // ...
  });
}

// NACHHER:
const { acquireLock, initJobLocksTable } = require("../services/jobLock.repository");

async function runForecastVerificationJob() {
  return runJob("forecastVerification", async () => {
    await initJobLocksTable();
    
    const won = await acquireLock("forecast_verification_job", 30 * 60);
    if (!won) {
      logger.warn("Forecast verification skipped (lock held)");
      return { verified24h: 0, verified7d: 0, processedCount: 0 };
    }
    
    let verified24h = 0;
    let verified7d  = 0;
    // ... rest bleibt gleich
  });
}
```

**Änderung 2:** `jobs/causalMemory.job.js`
```javascript
// VORHER (Zeile 20):
async function runCausalMemoryJob() {
  return runJob("causalMemory", async () => {
    const result = await adjustAgentWeights();
    return { processedCount: result.adjusted ?? 0, weights: result.weights };
  });
}

// NACHHER:
const { acquireLock, initJobLocksTable } = require("../services/jobLock.repository");

async function runCausalMemoryJob() {
  return runJob("causalMemory", async () => {
    await initJobLocksTable();
    
    const won = await acquireLock("causal_memory_job", 30 * 60);
    if (!won) {
      logger.warn("Causal memory recalibration skipped (lock held)");
      return { processedCount: 0 };
    }
    
    const result = await adjustAgentWeights();
    return { processedCount: result.adjusted ?? 0, weights: result.weights };
  });
}
```

**Änderung 3:** `jobs/techRadar.job.js`
```javascript
// VORHER (Zeile 23):
async function runTechRadarJob() {
  return runJob("techRadar", async () => {
    const result = await scanTechRadar();
    return { processedCount: result.inserted ?? 0, feeds: result.feeds, scanned: result.scanned };
  });
}

// NACHHER:
const { acquireLock, initJobLocksTable } = require("../services/jobLock.repository");

async function runTechRadarJob() {
  return runJob("techRadar", async () => {
    await initJobLocksTable();
    
    const won = await acquireLock("tech_radar_job", 60 * 60);
    if (!won) {
      logger.warn("Tech-Radar scan skipped (lock held)");
      return { processedCount: 0 };
    }
    
    const result = await scanTechRadar();
    return { processedCount: result.inserted ?? 0, feeds: result.feeds, scanned: result.scanned };
  });
}
```

**Warum sicher:**
- ✅ Minimale Änderung (nur Lock-Guard hinzufügen)
- ✅ Keine Änderung an Job-Logik
- ✅ Konsistent mit existierenden Jobs
- ✅ Schützt gegen zukünftiges Multi-Instance Deployment

### 🎯 Schritt 2: Railway Deployment verifizieren

**Nach dem Lock-Fix Merge:**

1. **Health Check prüfen:**
   ```bash
   curl https://<railway-domain>/health
   ```
   Erwartung: `"ready": true, "jobsEnabled": true`

2. **Logs beobachten** (erste 10 Minuten nach Deployment):
   ```
   ✅ Suchen nach: "RUN_JOBS=true -> starting background jobs"
   ✅ Suchen nach: "Warmup executed" (alle 15 Min)
   ✅ Suchen nach: "lock acquire" (mit won: true)
   ❌ Suchen nach: Keine Duplikate bei "lock acquire ... won: true"
   ❌ Suchen nach: Keine "AccessExclusiveLock" Errors
   ```

3. **Nach 24h prüfen:**
   - Universe Refresh log (02:10)
   - Forecast Verification log (03:00)
   - Causal Memory log (04:00)
   - Tech Radar log (06:00)
   - Discovery Scan log (09:00)
   - Discovery Learning log (11:00)

### 🎯 Schritt 3: Produktionsstabilitäts-Monitor einrichten

**Optional aber empfohlen:**

Neues Script: `scripts/production-health-check.js`
```javascript
// Prüft:
// 1. /health endpoint
// 2. jobsEnabled === true
// 3. DB readiness
// 4. Anzahl aktiver Locks in job_locks Tabelle
// 5. Letzte Job-Ausführung Timestamps
```

Kann als Railway Cron Job konfiguriert werden oder von externem Monitoring aufgerufen.

---

## 📊 Deployment Checklist

### Pre-Deployment:
- [x] Alle ALTER TABLE Fixes in main
- [x] Syntax Check passed (`npm run check`)
- [x] Railway.toml korrekt konfiguriert
- [ ] Lock Protection für Forecast/Causal/TechRadar Jobs hinzugefügt
- [ ] Code Review durchgeführt
- [ ] Changes committed und gepusht

### Railway Configuration:
- [ ] `RUN_JOBS=true` gesetzt
- [ ] `DATABASE_URL` automatisch von Railway Postgres Plugin gesetzt
- [ ] `FMP_API_KEY` für Universe Refresh gesetzt
- [ ] `OPENAI_API_KEY` für AI Analysis gesetzt
- [ ] `MASSIVE_API_KEY` oder `TWELVE_DATA_API_KEY` für Market Data gesetzt
- [ ] `CORS_ORIGINS` für Frontend Domains gesetzt (falls erforderlich)

### Post-Deployment:
- [ ] Health Check `/health` gibt 200 OK zurück
- [ ] `jobsEnabled: true` in Health Response
- [ ] Logs zeigen "RUN_JOBS=true -> starting background jobs"
- [ ] Warmup Cycle startet alle 15 Min
- [ ] Keine ALTER TABLE Errors in Logs
- [ ] Keine Lock Contention Errors in Logs
- [ ] Nach 24h: Alle Daily Jobs liefen genau einmal

---

## 🔍 Troubleshooting Guide

### Problem: Health Check gibt 503
**Lösung:** Server ist noch im Startup. Warte 30-60 Sekunden.

### Problem: `"ready": false` in Health Response
**Lösung:** Check `initErrors` und `lastCriticalError` in Response. Prüfe DB Connection.

### Problem: `"jobsEnabled": false` trotz RUN_JOBS=true
**Lösung:** Railway Environment Variable nicht korrekt gesetzt. Prüfe Service Settings → Variables.

### Problem: Jobs laufen nicht
**Lösung:** 
1. Prüfe `jobsEnabled: true` in /health
2. Prüfe Logs für "RUN_JOBS=true" Message
3. Prüfe ob FMP_API_KEY gesetzt (für Universe Refresh)

### Problem: "lock held" Messages in Logs
**Lösung:** 
- Normal wenn vorheriger Job noch läuft
- Abnormal wenn immer "lock held" → Prüfe `job_locks` Tabelle auf stale locks
- Query: `SELECT * FROM job_locks WHERE locked_until > NOW();`

### Problem: ALTER TABLE Errors beim Startup
**Lösung:** SOLLTE NICHT MEHR AUFTRETEN. Falls doch:
1. Prüfe welche Datei (aus Error Stack Trace)
2. Vergleiche mit main Branch
3. Report als Bug

---

## ✅ Fazit

**hqs-backend ist produktionsbereit** mit folgender Konfiguration:
- ✅ Railway mit **1 Service** (`hqs-backend`)
- ✅ `RUN_JOBS=true` Environment Variable
- ✅ PostgreSQL Plugin attached
- ✅ Alle erforderlichen API Keys gesetzt

**Empfohlener Hotfix vor Production:**
- Lock Protection für forecastVerification, causalMemory, techRadar Jobs hinzufügen

**Kein separater hqs-scraping-service erforderlich** - alle Jobs integriert.

**Fokus:** Railway Production Stabilität ✅ ERREICHT
