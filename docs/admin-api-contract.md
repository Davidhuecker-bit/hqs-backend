# HQS Backend – Admin API Contract

> **Version:** 2.0 (as of stability round 2)
> **Purpose:** Definitive reference for the Admin / Overview endpoints consumed by
> `AdminControlCenterView` and any monitoring tooling.  The frontend may rely on
> every field marked **guaranteed** without defensive null-checks.

---

## Table of Contents

1. [GET /health](#get-health)
2. [GET /api/admin/pipeline-status](#get-apiadminpipeline-status)
3. [GET /api/admin/table-health](#get-apiadmintable-health)
4. [GET /api/admin/overview](#get-apiadminoverview)
5. [Data-Status Values](#data-status-values)
6. [Persistent vs. Runtime Data](#persistent-vs-runtime-data)
7. [Frontend Safe-Consumption Guide](#frontend-safe-consumption-guide)

---

## GET /health

**Purpose:** Quick liveness / readiness probe. Returns 200 once the startup
callback has completed, 503 only during the brief initial startup window.

### Response shape

```json
{
  "success":     true,                   // boolean – guaranteed
  "ready":       true,                   // boolean – guaranteed
  "generatedAt": "2026-01-01T00:00:00Z", // ISO timestamp – guaranteed
  "db":          "ok",                   // "ok" | "error" – guaranteed
  "dbReady":     true,                   // boolean – guaranteed
  "dbError":     null,                   // string | undefined
  "dbErrorType": null,                   // string | undefined  (e.g. "CONN_REFUSED")
  "startedAt":   "2026-01-01T00:00:00Z", // ISO timestamp – guaranteed
  "completedAt": "2026-01-01T00:00:01Z", // ISO timestamp | null
  "startupError": null,                  // string | undefined
  "lastCriticalError": null,             // object | undefined
  "initErrors":  null,                   // array | undefined
  "jobsEnabled": false                   // boolean – guaranteed
}
```

### Guaranteed fields (frontend may consume without null-check)

| Field | Type | Notes |
|---|---|---|
| `success` | boolean | `true` once startup is complete |
| `ready` | boolean | `true` when all init steps passed |
| `generatedAt` | ISO string | Timestamp of this response |
| `db` | `"ok"` \| `"error"` | Current DB ping result |
| `dbReady` | boolean | Same as `db === "ok"` |
| `startedAt` | ISO string | Process start time |
| `jobsEnabled` | boolean | Whether scheduled jobs are active |

### HTTP status codes

| Code | Meaning |
|---|---|
| `200` | Server alive (startup complete). DB may still be `"error"`. |
| `503` | Server still in startup window. |

---

## GET /api/admin/pipeline-status

**Purpose:** Per-stage counts from the last `buildMarketSnapshot` run.
Merges live runtime data (non-zero after a run) with DB-persisted data
(survives Railway restarts).

### Response shape

```json
{
  "success":          true,
  "generatedAt":      "2026-01-01T00:00:00Z",
  "statusGeneratedAt":"2026-01-01T00:00:00Z",
  "lastRunMs":        null,
  "stages": {
    "universe": {
      "inputCount":   1000,
      "successCount": 1000,
      "failedCount":  0,
      "skippedCount": 0,
      "lastUpdated":  "2026-01-01T00:00:00Z",
      "source":       "persisted"
    },
    "snapshot":       { ... },
    "advancedMetrics":{ ... },
    "hqsScoring":     { ... },
    "outcome":        { ... }
  }
}
```

### Guaranteed stage keys

`universe`, `snapshot`, `advancedMetrics`, `hqsScoring`, `outcome`

### Stage object – guaranteed fields

| Field | Type | Notes |
|---|---|---|
| `inputCount` | number | ≥ 0 |
| `successCount` | number | ≥ 0 |
| `failedCount` | number | ≥ 0 |
| `skippedCount` | number | ≥ 0 |
| `lastUpdated` | ISO string \| null | null if never run |
| `source` | `"runtime"` \| `"persisted"` \| `"empty"` | Origin of the counts |

### `source` semantics

| Value | Meaning |
|---|---|
| `"runtime"` | Counts come from the current in-memory run (server not restarted since last run) |
| `"persisted"` | Counts come from the DB (server restarted; last-known values shown) |
| `"empty"` | No data yet (fresh install, first run not complete) |

---

## GET /api/admin/table-health

**Purpose:** Traffic-light (green/yellow/red) status for all admin-relevant
DB tables.

### Response shape

```json
{
  "success":       true,
  "generatedAt":   "2026-01-01T00:00:00Z",
  "checkedAt":     "2026-01-01T00:00:00Z",
  "overallStatus": "green",
  "green":         9,
  "yellow":        0,
  "red":           0,
  "durationMs":    120,
  "tables": [
    {
      "table":         "market_snapshots",
      "exists":        true,
      "rowCount":      5000,
      "lastTimestamp": "2026-01-01T00:00:00Z",
      "status":        "green",
      "detail":        "healthy"
    }
  ]
}
```

### Guaranteed top-level fields

| Field | Type | Notes |
|---|---|---|
| `success` | boolean | |
| `generatedAt` | ISO string | Same as `checkedAt` |
| `checkedAt` | ISO string | When check ran |
| `overallStatus` | `"green"` \| `"yellow"` \| `"red"` | Aggregate |
| `green` / `yellow` / `red` | number | Table counts per status |
| `tables` | array | Per-table detail |
| `durationMs` | number | Check duration |

### Checked tables (as of v2.0)

`market_snapshots`, `market_advanced_metrics`, `hqs_scores`, `outcome_tracking`,
`admin_snapshots`, `factor_history`, `weight_history`, `watchlist_symbols`,
`pipeline_status`

### `overallStatus` logic

| Condition | Status |
|---|---|
| 0 red tables | `green` |
| ≥ 1 red but also ≥ 1 green or yellow | `yellow` |
| All tables red | `red` |

### `detail` values

`healthy`, `sparse`, `stale`, `empty`, `degraded`, `table_missing`, `check_failed`

---

## GET /api/admin/overview

**Purpose:** Full admin stack snapshot – insights, diagnostics, validation,
tuning, trends, alerts, priorities, targets, causality, release, recommendations,
briefing.  Used by `AdminControlCenterView`.

### Response shape

```json
{
  "success":       true,
  "generatedAt":   "2026-01-01T00:00:00Z",
  "dataStatus":    "full",
  "partialErrors": [],
  "emptyFields":   [],
  "insights": {
    "generatedAt":     "...",
    "lookbackHours":   24,
    "longLookbackDays": 30,
    "system":          { "snapshotState": {}, "jobLocks": {}, "notifications": {} },
    "universe":        { "active": 250, ... },
    "activity":        { "snapshots": {}, "hqs": {}, ... },
    "coverage":        {},
    "quickFacts":      {
      "activeUniverse":             250,
      "recentProcessedSymbols":     [],
      "latestSnapshotAt":           "...",
      "latestFactorUpdateAt":       "...",
      "latestWeightUpdateAt":       "...",
      "latestDiscoveryAt":          "...",
      "latestAdvancedMetricsAt":    "...",
      "latestOutcomeTrackingAt":    "..."
    },
    "_meta": {
      "dataStatus":    "full",
      "partialErrors": [],
      "emptyFields":   []
    }
  },
  "diagnostics":     {},
  "validation":      {},
  "tuning":          {},
  "trends":          {},
  "alerts":          {},
  "priorities":      {},
  "targets":         {},
  "causality":       {},
  "release":         {},
  "recommendations": {},
  "briefing":        {}
}
```

### Top-level – guaranteed fields

| Field | Type | Notes |
|---|---|---|
| `success` | boolean | `true` = at least partial data returned |
| `generatedAt` | ISO string | Timestamp of this response |
| `dataStatus` | string | See [Data-Status Values](#data-status-values) |
| `partialErrors` | array | Errors from individual engines (may be empty) |
| `emptyFields` | array | Table names with 0 rows (may be empty) |
| `insights` | object | Always present (fallback object on error) |
| `diagnostics` | object | Always present (fallback `{}` on engine error) |
| `validation` | object | Always present |
| `tuning` | object | Always present |
| `trends` | object | Always present |
| `alerts` | object | Always present |
| `priorities` | object | Always present |
| `targets` | object | Always present |
| `causality` | object | Always present |
| `release` | object | Always present |
| `recommendations` | object | Always present |
| `briefing` | object | Always present |

### `insights.quickFacts` – guaranteed fields

| Field | Type |
|---|---|
| `activeUniverse` | number |
| `recentProcessedSymbols` | array |
| `latestSnapshotAt` | ISO string \| null |
| `latestFactorUpdateAt` | ISO string \| null |
| `latestWeightUpdateAt` | ISO string \| null |
| `latestDiscoveryAt` | ISO string \| null |
| `latestAdvancedMetricsAt` | ISO string \| null |
| `latestOutcomeTrackingAt` | ISO string \| null |

### Error response (HTTP 500)

```json
{
  "success":     false,
  "generatedAt": "2026-01-01T00:00:00Z",
  "dataStatus":  "error",
  "error":       "Error message"
}
```

---

## Data-Status Values

Applies to `dataStatus` in `/api/admin/overview` and `insights._meta.dataStatus`.

| Value | Meaning | Frontend behaviour |
|---|---|---|
| `"full"` | All data sources returned data | Show all panels normally |
| `"partial"` | ≥ 1 data source failed | Show available panels, highlight `partialErrors` |
| `"empty"` | ≥ threshold of tables are empty (fresh install) | Show empty state with setup guidance |
| `"error"` | Top-level exception; no data available | Show global error banner |

---

## Persistent vs. Runtime Data

### `pipeline_status` table

Stores the counts of the **last completed** `buildMarketSnapshot` run per stage.

- **Populated by:** `savePipelineStage()` in `services/pipelineStatus.repository.js` after every `updatePipelineStage()` call in `services/marketService.js`
- **Read by:** `getPipelineStatusWithPersistence()` which merges runtime + DB
- **Survives Railway restarts:** Yes – Railway logs where to confirm:
  - Look for: `[pipelineStatus] stage persisted` with fields `stage`, `lastRunAt`, `successCount`, `failedCount`

### How to identify persistent data in Railway logs

```
[pipelineStatus] stage persisted  { stage: "snapshot", lastRunAt: "...", successCount: 450, ... }
```

If the server just restarted and you see `source: "persisted"` in `/api/admin/pipeline-status`,
the counts come from the DB, not a live run.

---

## Frontend Safe-Consumption Guide

### Fields the `AdminControlCenterView` may access without null-check

```js
// From /health
response.success
response.generatedAt
response.db           // "ok" | "error"
response.ready
response.jobsEnabled

// From /api/admin/pipeline-status
response.success
response.generatedAt
response.stages.universe.successCount
response.stages.snapshot.successCount
response.stages.snapshot.failedCount
response.stages.snapshot.source

// From /api/admin/table-health
response.success
response.generatedAt
response.overallStatus
response.green
response.yellow
response.red

// From /api/admin/overview
response.success
response.generatedAt
response.dataStatus   // "full" | "partial" | "empty" | "error"
response.insights.quickFacts.activeUniverse
response.insights.quickFacts.latestSnapshotAt
response.insights._meta.dataStatus
response.insights._meta.partialErrors   // array (may be empty)
response.insights._meta.emptyFields     // array (may be empty)
```

### Recommended frontend pattern

```js
const overview = await fetch('/api/admin/overview').then(r => r.json());

if (!overview.success) {
  // Show global error banner – overview.dataStatus === "error"
  return;
}

if (overview.dataStatus === "empty") {
  // Show setup / first-run guidance
  return;
}

if (overview.dataStatus === "partial") {
  // Show warning banner listing overview.partialErrors
}

// Safe to render all panels using overview.insights / overview.diagnostics etc.
```

---

*Last updated: 2026-03-16. Keep this file in sync with `routes/admin.routes.js` and `services/adminInsights.service.js`.*
