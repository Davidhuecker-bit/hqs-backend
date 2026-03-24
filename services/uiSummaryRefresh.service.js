"use strict";

/**
 * UI Summary Read Service  (DB-first architecture)
 * --------------------------------------------------
 * Read-only service for all ui_summaries types.
 *
 * IMPORTANT: This service NEVER rebuilds summaries.
 * All summaries are written by dedicated cron jobs:
 *   - market_list     → jobs/uiMarketList.job.js      (job:ui-market-list)
 *   - demo_portfolio  → jobs/uiDemoPortfolio.job.js    (job:ui-demo-portfolio)
 *   - guardian_status → jobs/uiGuardianStatus.job.js   (job:ui-guardian-status)
 *
 * The API server only reads from the ui_summaries table.
 *
 * Freshness configuration is centralised here for diagnostics and health checks.
 *
 * Public API:
 *   readSummary(type)                       → read a single summary from DB
 *   getSummaryStatus(type, opts)            → single-type full diagnostic status
 *   listSummaryStatuses()                   → all types with freshness + health state
 *   getHealthSnapshot()                     → compact health map for all types
 *
 * Supported types: market_list, demo_portfolio, guardian_status
 */

const logger = require("../utils/logger");
const { readUiSummary, listUiSummaries } = require("./uiSummary.repository");

/* =========================================================
   FRESHNESS CONFIGURATION  (per summary type)
   maxAgeMs: how long a DB snapshot is considered fresh
   writer:   description of the job that writes this type
========================================================= */

const FRESHNESS_CONFIG = {
  market_list: {
    maxAgeMs: 5 * 60 * 1000, // 5 min
    writer:   "job:ui-market-list (uiMarketList.job.js)",
  },
  demo_portfolio: {
    maxAgeMs: 10 * 60 * 1000, // 10 min
    writer:   "job:ui-demo-portfolio (uiDemoPortfolio.job.js)",
  },
  guardian_status: {
    maxAgeMs: 3 * 60 * 1000, // 3 min
    writer:   "job:ui-guardian-status (uiGuardianStatus.job.js)",
  },
};

const SUPPORTED_TYPES = Object.keys(FRESHNESS_CONFIG);

/* =========================================================
   HELPERS
========================================================= */

/**
 * Derive a freshnessLabel from ageMs and maxAgeMs.
 */
function _deriveFreshnessLabel(ageMs, maxAgeMs) {
  if (ageMs === null || ageMs === undefined) return "missing";
  return ageMs <= maxAgeMs ? "fresh" : "stale";
}

/**
 * Derive the operational health status for a summary type.
 *
 * Levels:
 *   healthy  → fresh snapshot written by job
 *   stale    → snapshot exists but age > maxAgeMs (job may be delayed)
 *   empty    → no snapshot found in DB
 */
function _deriveOperationalStatus(ageMs, maxAgeMs, row) {
  if (row === null || row === undefined) return "empty";
  if (ageMs !== null && ageMs <= maxAgeMs) return "healthy";
  return "stale";
}

/* =========================================================
   READ API
========================================================= */

/**
 * Read a single UI summary from the DB.  Never triggers a rebuild.
 *
 * Returns an enriched object with freshness metadata, or a degraded
 * fallback shape when no data exists (never throws).
 *
 * @param {string} type
 * @returns {Promise<object>}
 */
async function readSummary(type) {
  if (!FRESHNESS_CONFIG[type]) {
    throw new Error(`[uiSummaryRead] Unknown summary type: '${type}'`);
  }

  const cfg = FRESHNESS_CONFIG[type];
  const row = await readUiSummary(type);
  const ageMs = row?.builtAt ? Date.now() - new Date(row.builtAt).getTime() : null;

  return {
    payload:           row?.payload ?? null,
    freshnessLabel:    _deriveFreshnessLabel(ageMs, cfg.maxAgeMs),
    operationalStatus: _deriveOperationalStatus(ageMs, cfg.maxAgeMs, row),
    ageMs,
    builtAt:           row?.builtAt ?? null,
    isPartial:         row?.isPartial ?? false,
    buildDurationMs:   row?.buildDurationMs ?? null,
    writer:            cfg.writer,
    // Legacy compat fields (no longer tracked in-memory since API doesn't rebuild)
    rebuilding:          false,
    lastError:           null,
    consecutiveFailures: 0,
    cooldownRemainingMs: 0,
  };
}

/* =========================================================
   DIAGNOSTICS API
========================================================= */

/**
 * Get the current status of a single summary type.
 * Includes all diagnostic fields for admin surfaces.
 *
 * @param {string} type
 * @param {{ includePayload?: boolean }} [opts]
 * @returns {Promise<object|null>}
 */
async function getSummaryStatus(type, { includePayload = false } = {}) {
  const cfg = FRESHNESS_CONFIG[type];
  if (!cfg) return null;

  const row = await readUiSummary(type);
  const ageMs = row?.builtAt ? Date.now() - new Date(row.builtAt).getTime() : null;

  const freshnessLabel    = _deriveFreshnessLabel(ageMs, cfg.maxAgeMs);
  const operationalStatus = _deriveOperationalStatus(ageMs, cfg.maxAgeMs, row);

  const status = {
    summaryType:       type,
    freshnessLabel,
    operationalStatus,
    ageMs,
    builtAt:           row?.builtAt ?? null,
    isPartial:         row?.isPartial ?? false,
    buildDurationMs:   row?.buildDurationMs ?? null,
    maxAgeMs:          cfg.maxAgeMs,
    writer:            cfg.writer,
    writtenByJob:      true,
    metadata:          row?.metadata ?? null,
    // Legacy compat (no in-memory rebuild state)
    rebuilding:          false,
    lastSuccessAt:       null,
    lastFailureAt:       null,
    failureCount:        0,
    consecutiveFailures: 0,
    lastErrorMessage:    null,
    lastErrorAt:         null,
    lastRebuildStartedAt:  null,
    lastRebuildFinishedAt: null,
    cooldownRemainingMs: 0,
    lastError:           null,
    rebuildStartedAt:    null,
  };

  if (includePayload) {
    status.payload = row?.payload ?? null;
  }

  return status;
}

/**
 * List statuses for all known summary types.
 *
 * @returns {Promise<object[]>}
 */
async function listSummaryStatuses() {
  const dbRows = await listUiSummaries();
  const now = Date.now();

  return SUPPORTED_TYPES.map((type) => {
    const cfg = FRESHNESS_CONFIG[type];
    const row = dbRows.find((r) => r.summaryType === type) ?? null;
    const ageMs = row?.builtAt ? now - new Date(row.builtAt).getTime() : null;

    const freshnessLabel    = _deriveFreshnessLabel(ageMs, cfg.maxAgeMs);
    const operationalStatus = _deriveOperationalStatus(ageMs, cfg.maxAgeMs, row);

    return {
      summaryType:       type,
      freshnessLabel,
      operationalStatus,
      ageMs:             ageMs ?? row?.ageMs ?? null,
      builtAt:           row?.builtAt ?? null,
      isPartial:         row?.isPartial ?? false,
      buildDurationMs:   row?.buildDurationMs ?? null,
      maxAgeMs:          cfg.maxAgeMs,
      writer:            cfg.writer,
      writtenByJob:      true,
      // Legacy compat
      rebuilding:          false,
      lastSuccessAt:       null,
      lastFailureAt:       null,
      failureCount:        0,
      consecutiveFailures: 0,
      lastErrorMessage:    null,
      lastErrorAt:         null,
      lastRebuildStartedAt:  null,
      lastRebuildFinishedAt: null,
      cooldownRemainingMs: 0,
      lastError:           null,
      rebuildStartedAt:    null,
    };
  });
}

/**
 * Return a compact health snapshot for all summary types.
 *
 * @returns {Promise<object[]>}
 */
async function getHealthSnapshot() {
  const dbRows = await listUiSummaries();
  const now = Date.now();

  return SUPPORTED_TYPES.map((type) => {
    const cfg = FRESHNESS_CONFIG[type];
    const row = dbRows.find((r) => r.summaryType === type) ?? null;
    const ageMs = row?.builtAt ? now - new Date(row.builtAt).getTime() : null;

    const freshnessLabel    = _deriveFreshnessLabel(ageMs, cfg.maxAgeMs);
    const operationalStatus = _deriveOperationalStatus(ageMs, cfg.maxAgeMs, row);

    return {
      summaryType:         type,
      operationalStatus,
      freshnessLabel,
      builtAt:             row?.builtAt ?? null,
      ageMs,
      writer:              cfg.writer,
      writtenByJob:        true,
      // Legacy compat
      consecutiveFailures: 0,
      cooldownRemainingMs: 0,
      rebuilding:          false,
    };
  });
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  FRESHNESS_CONFIG,
  SUPPORTED_TYPES,
  // Backward-compat aliases (these were used by admin routes):
  BACKOFF_THRESHOLDS: [],
  FAILING_THRESHOLD:  5,
  // Core API – read-only, no rebuild
  readSummary,
  // Kept as alias for backward compatibility with admin routes / server.js
  getOrBuild: readSummary,
  getSummaryStatus,
  listSummaryStatuses,
  getHealthSnapshot,
};
