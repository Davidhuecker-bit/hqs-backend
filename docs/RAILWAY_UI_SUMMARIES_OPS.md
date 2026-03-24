# Betriebsanweisung: UI Summaries – DB-first Cron-Writer in Railway

> Stand: 2026-03-24 · Erstellt auf Basis der aktuellen Codebasis

---

## 1  Neue Railway Cron-Services anlegen

Die 3 neuen Services existieren **bereits im Code** (`start.sh`, `package.json`, `railway.toml`).
In Railway müssen sie als **Cron-Services** angelegt werden.

| # | Railway Service Name<br>(exakt so setzen) | `RAILWAY_SERVICE_NAME` | Start Command<br>(wird durch `start.sh` dispatcht) | npm Script | Empfohlener Cron Schedule | `/health` deaktivieren? |
|---|---|---|---|---|---|---|
| 1 | **UI Market List** | `UI Market List` | `bash start.sh` | `npm run job:ui-market-list` | `*/5 * * * *` (alle 5 Min) | ✅ Ja – **muss** deaktiviert werden¹ |
| 2 | **UI Demo Portfolio** | `UI Demo Portfolio` | `bash start.sh` | `npm run job:ui-demo-portfolio` | `*/10 * * * *` (alle 10 Min) | ✅ Ja – **muss** deaktiviert werden¹ |
| 3 | **UI Guardian Status** | `UI Guardian Status` | `bash start.sh` | `npm run job:ui-guardian-status` | `*/3 * * * *` (alle 3 Min) | ✅ Ja – **muss** deaktiviert werden¹ |

> ¹ `railway.toml` definiert `healthcheckPath = "/health"` global. Die Cron-Jobs starten **keinen** HTTP-Server, daher schlägt der Healthcheck fehl und Railway würde den Service als unhealthy markieren. → In Railway pro Service den Healthcheck **deaktivieren** (Toggle „Healthcheck" → off) oder den Service-Typ auf **Cron Job** setzen (dann wird kein Healthcheck angewendet).

### Umgebungsvariablen

Jeder neue Service benötigt **dieselben** Env-Vars wie der bestehende HQS-Backend-Service:
- `DATABASE_URL` (Postgres-Verbindung)
- `NODE_ENV=production`
- `RAILWAY_SERVICE_NAME` = wie oben angegeben
- Alle weiteren Secrets (API-Keys etc.) die auch HQS Backend nutzt

---

## 2  Altpfade bereinigen – Was darf nicht mehr schreiben?

### 2.1  Aktuelle Schreib-Architektur (verifiziert)

| `ui_summaries`-Typ | Einziger Writer | Trigger |
|---|---|---|
| `market_list` | `marketSummary.builder.js → refreshMarketSummary()` | `jobs/uiMarketList.job.js` (Cron) |
| `demo_portfolio` | `adminDemoPortfolio.service.js → refreshDemoPortfolio()` | `jobs/uiDemoPortfolio.job.js` (Cron) |
| `guardian_status` | `guardianStatusSummary.builder.js → refreshGuardianStatusSummary()` | `jobs/uiGuardianStatus.job.js` (Cron) |

### 2.2  Services die NICHT (mehr) schreiben

| Bestehender Service | Schreibt ui_summaries? | Status |
|---|---|---|
| **HQS Backend** (API-Server) | ❌ NEIN | `server.js` enthält **keine** `writeUiSummary`-Aufrufe. Warmup wurde entfernt. API ruft nur `readSummary()`. |
| **Cron tägliches Briefing** | ❌ NEIN | `dailyBriefing.job.js` schreibt in `daily_briefings`, nicht in `ui_summaries`. |
| **Scan Markt Snapshot** | ❌ NEIN | `snapshotScan.job.js` schreibt in `market_snapshots` + `fx_rates`, nicht in `ui_summaries`. |
| **POST /api/admin/refresh-summary/:type** | ❌ NEIN | Endpoint ist **deprecated** – gibt nur eine Info-Meldung zurück, triggert keinen Rebuild. |

### 2.3  Potentieller versteckter Pfad (entschärft)

Die Builder-Services exportieren auch `getOrBuildMarketSummary()` und `getOrBuildGuardianStatusSummary()` – das sind SWR-Funktionen die bei stale Data einen async Rebuild auslösen. **Allerdings werden diese Funktionen aktuell nirgends importiert oder aufgerufen** (weder in `server.js` noch in `routes/`). Sie sind Dead Code.

**Empfehlung (optional):** Diese Exports können in einem späteren Cleanup-Schritt entfernt werden, sind aber aktuell harmlos.

---

## 3  Doppelungen / Konflikte – Writer-Nachweis

### Ergebnis der globalen Code-Analyse

```
grep -rn "writeUiSummary" --include="*.js" (ohne node_modules)
```

| Datei | Schreibt Typ | Aufgerufen von |
|---|---|---|
| `services/uiSummary.repository.js` | (Definition) | – |
| `services/marketSummary.builder.js:89` | `market_list` | nur `jobs/uiMarketList.job.js` |
| `services/adminDemoPortfolio.service.js:1143` | `demo_portfolio` | nur `jobs/uiDemoPortfolio.job.js` |
| `services/guardianStatusSummary.builder.js:188` | `guardian_status` | nur `jobs/uiGuardianStatus.job.js` |

**✅ Jeder Typ hat exakt EINEN Writer. Keine Doppelschreiber.**

### Pipeline-Status-Stages

Die 3 neuen Stages (`ui_market_list`, `ui_demo_portfolio`, `ui_guardian_status`) werden ausschließlich von den jeweiligen Jobs via `savePipelineStage()` geschrieben:

| Stage | Writer-Job |
|---|---|
| `ui_market_list` | `jobs/uiMarketList.job.js:50` |
| `ui_demo_portfolio` | `jobs/uiDemoPortfolio.job.js:60` |
| `ui_guardian_status` | `jobs/uiGuardianStatus.job.js:49` |

---

## 4  SQL-Verifikation (nach Go-Live in Railway ausführen)

### 4.1  Letzte 10 UI Summaries

```sql
SELECT
  summary_type,
  built_at,
  NOW() - built_at AS age,
  is_partial,
  build_duration_ms,
  metadata
FROM ui_summaries
ORDER BY built_at DESC
LIMIT 10;
```

### 4.2  Pipeline-Status der 3 neuen Jobs

```sql
SELECT
  stage,
  status,
  updated_at,
  NOW() - updated_at AS age,
  error_message,
  metadata
FROM pipeline_status
WHERE stage IN ('ui_market_list', 'ui_demo_portfolio', 'ui_guardian_status')
ORDER BY updated_at DESC;
```

### 4.3  Writer-Nachweis / Freshness / Build Duration

```sql
-- Freshness-Check: Ist jeder Typ innerhalb seines Max-Age?
SELECT
  summary_type,
  built_at,
  EXTRACT(EPOCH FROM (NOW() - built_at)) AS age_seconds,
  CASE
    WHEN summary_type = 'market_list'     AND NOW() - built_at <= INTERVAL '5 minutes'  THEN '✅ fresh'
    WHEN summary_type = 'demo_portfolio'  AND NOW() - built_at <= INTERVAL '10 minutes' THEN '✅ fresh'
    WHEN summary_type = 'guardian_status' AND NOW() - built_at <= INTERVAL '3 minutes'  THEN '✅ fresh'
    ELSE '⚠️ stale'
  END AS freshness,
  build_duration_ms,
  is_partial,
  metadata->>'source' AS source
FROM ui_summaries
WHERE summary_type IN ('market_list', 'demo_portfolio', 'guardian_status')
ORDER BY summary_type;
```

### 4.4  Beweis: API liest nur (kein Write im Request-Pfad)

```sql
-- Überprüfung: Keine Schreibvorgänge während API-Requests
-- built_at sollte nur zu Cron-Zeiten aktualisiert werden, nicht bei API-Aufrufen
SELECT
  summary_type,
  built_at,
  EXTRACT(MINUTE FROM built_at) AS built_minute,
  build_duration_ms
FROM ui_summaries
WHERE summary_type IN ('market_list', 'demo_portfolio', 'guardian_status')
ORDER BY built_at DESC;

-- Wenn built_at nur alle 3/5/10 Minuten aktualisiert wird → Job-Only-Write bestätigt
-- Wenn built_at sich bei jedem API-Call aktualisiert → Problem: API schreibt noch!
```

### 4.5  Job-Lock-Prüfung (Dedup-Nachweis)

```sql
-- Aktive Locks prüfen (sollten nach Job-Abschluss leer sein)
SELECT *
FROM job_locks
WHERE lock_key LIKE 'ui_%'
ORDER BY acquired_at DESC;
```

---

## 5  Fallback- und Fehlerverhalten

### 5.1  Architektur-Prinzip

> **Kein Rebuild im Request.** Die API liest ausschließlich aus `ui_summaries`. Ist der Eintrag stale oder fehlt, liefert die API eine **degradierte Antwort** – sie versucht **niemals**, den Summary selbst zu bauen.

### 5.2  Szenario: Job fällt aus

| Szenario | `/api/market` | `/api/admin/demo-portfolio` | `/api/admin/guardian-status-summary` |
|---|---|---|---|
| **Job läuft normal** | Frische Daten (< 5 Min) | Frische Daten (< 10 Min) | Frische Daten (< 3 Min) |
| **Job fällt 1x aus** | Letzte Daten werden geliefert (stale, aber vorhanden). `freshnessLabel: "stale"` in Antwort. | Letzte Daten werden geliefert mit `freshnessLabel: "stale"`. | Letzte Daten werden geliefert mit `freshnessLabel: "stale"`. |
| **Job fällt dauerhaft aus** | Immer ältere Daten. Freshness-Label zeigt zunehmende Stale-Duration. UI kann darauf reagieren. | Dito – Holdings bleiben eingefroren, aber abrufbar. | Dito – Guardian-Status veraltet, aber abrufbar. |
| **Tabelle leer / erster Start** | `readSummary()` gibt `null` → API antwortet mit leerer Liste / Fallback-Response. | `readSummary()` gibt `null` → API antwortet mit Fallback (keine Holdings). | `readSummary()` gibt `null` → API antwortet mit Fallback (kein Guardian-Status). |

### 5.3  Erkennung im API-Response

Jede API-Antwort enthält Freshness-Metadaten:

```json
{
  "freshnessLabel": "fresh | stale | missing",
  "builtAt": "2026-03-24T14:55:00.000Z",
  "ageMs": 300000,
  "isPartial": false
}
```

### 5.4  Monitoring-Empfehlung

- **`/api/admin/ui-summaries`** – Listet alle Summary-Typen mit Freshness-Status
- **`/api/admin/ui-summaries-health`** – Kompakter Health-Snapshot (healthy/stale/degraded/failing)
- **`/api/admin/service-diagnostics`** – Umfassende Service-Übersicht inkl. Pipeline-Status

**Alert-Regeln (optional):**
- `market_list` älter als 15 Min → Warning
- `demo_portfolio` älter als 30 Min → Warning
- `guardian_status` älter als 10 Min → Warning
- Jeder Typ älter als 1 Stunde → Critical

---

## 6  Abschlussbericht – Umsetzungsreihenfolge

### ✅ SOFORT in Railway umsetzen

| Schritt | Aktion | Details |
|---|---|---|
| **1** | Service **"UI Guardian Status"** anlegen | Cron-Service, `RAILWAY_SERVICE_NAME=UI Guardian Status`, Schedule `*/3 * * * *`, Healthcheck **AUS** |
| **2** | Service **"UI Market List"** anlegen | Cron-Service, `RAILWAY_SERVICE_NAME=UI Market List`, Schedule `*/5 * * * *`, Healthcheck **AUS** |
| **3** | Service **"UI Demo Portfolio"** anlegen | Cron-Service, `RAILWAY_SERVICE_NAME=UI Demo Portfolio`, Schedule `*/10 * * * *`, Healthcheck **AUS** |
| **4** | Env-Vars kopieren | Für alle 3: `DATABASE_URL`, `NODE_ENV=production`, alle Secrets aus HQS Backend übernehmen |
| **5** | Ersten Lauf abwarten | Ca. 10 Minuten warten, dann SQL 4.1 + 4.2 ausführen |
| **6** | Freshness prüfen | SQL 4.3 ausführen – alle 3 Typen sollten `✅ fresh` sein |
| **7** | API-Endpunkte testen | `GET /api/market`, `GET /api/admin/demo-portfolio`, `GET /api/admin/guardian-status-summary` aufrufen und Daten + Freshness prüfen |

> **Reihenfolge Guardian → Market → Demo:** Guardian Status hat die kürzeste Laufzeit und gibt schnellstes Feedback. Demo Portfolio hat die meisten Dependencies und sollte zuletzt gestartet werden.

### 🔄 OPTIONAL SPÄTER

| Aktion | Begründung |
|---|---|
| Dead-Code entfernen: `getOrBuildMarketSummary()` + `getOrBuildGuardianStatusSummary()` aus Buildern | Sind aktuell nicht aufgerufen, aber exportiert. Kein Risiko, aber sauberer ohne sie. |
| `POST /api/admin/refresh-summary/:type` Endpoint entfernen | Bereits deprecated (gibt nur Info-Message). Kann in einem Cleanup entfernt werden. |
| Alert-Rules im Monitoring einrichten | Stale-Warnings für die 3 Summary-Typen (siehe 5.4) |
| Cron-Schedules feintunen | Nach 1-2 Wochen Betrieb: Build-Durations aus `build_duration_ms` und Traffic-Muster analysieren |

### 🗑️ ALTSERVICE LÖSCHEN / DEAKTIVIEREN

| Service | Aktion | Begründung |
|---|---|---|
| **HQS Backend** | ⚠️ **NICHT ändern** | Bleibt API-Server. Schreibt bereits NICHT in ui_summaries. Keine Änderung nötig. |
| **Cron tägliches Briefing** | ⚠️ **NICHT ändern** | Schreibt in `daily_briefings`, NICHT in `ui_summaries`. Kein Konflikt. |
| **Scan Markt Snapshot** | ⚠️ **NICHT ändern** | Schreibt in `market_snapshots` + `fx_rates`, NICHT in `ui_summaries`. Kein Konflikt. Liefert Rohdaten für UI Market List. |
| Alle anderen bestehenden Cron-Jobs | ⚠️ **NICHT ändern** | Keiner der bestehenden Jobs schreibt in `ui_summaries`. |

> **Fazit: Es muss kein bestehender Service gelöscht oder deaktiviert werden.** Die Altpfade sind bereits sauber. Die 3 neuen Services sind rein additiv.

---

## Zusammenfassung

```
┌─────────────────────────────────────────────────────────────────┐
│  ARCHITEKTUR-STATUS: ✅ PRODUKTIONSBEREIT                      │
│                                                                 │
│  Writers (Cron-Jobs):                                          │
│    market_list     → UI Market List      (*/5 * * * *)         │
│    demo_portfolio  → UI Demo Portfolio   (*/10 * * * *)        │
│    guardian_status → UI Guardian Status  (*/3 * * * *)         │
│                                                                 │
│  Reader (API):                                                  │
│    HQS Backend → readSummary() → ui_summaries (read-only)     │
│                                                                 │
│  Doppelschreiber:     ❌ KEINE                                 │
│  Versteckte Altpfade: ❌ KEINE (SWR-Exports unused)           │
│  API-Rebuilds:        ❌ KEINE (warmup entfernt)               │
│  Altservices löschen: ❌ NICHT NÖTIG                           │
│                                                                 │
│  Nächster Schritt: 3 Cron-Services in Railway anlegen          │
│                    (siehe Schritt 1-7 oben)                    │
└─────────────────────────────────────────────────────────────────┘
```
