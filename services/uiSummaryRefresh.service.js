"use strict";

/**
 * UI Summary Refresh Orchestration  (Step 4 + Step 5)
 * -----------------------------------------------------
 * Central freshness-control and build-dedupe for all ui_summaries types.
 *
 * States per summary_type (Step 4):
 *   fresh      → DB snapshot is within maxAgeMs; serve directly (fast path)
 *   stale      → DB snapshot exists but is old; serve + trigger async rebuild
 *   missing    → no DB snapshot; build synchronously and return
 *   rebuilding → async rebuild in progress; serve last known data (no duplicate build)
 *
 * Operational health states (Step 5):
 *   healthy    → fresh snapshot, no consecutive failures
 *   stale      → snapshot exists but older than maxAgeMs, no active failures
 *   rebuilding → async/sync rebuild in progress
 *   degraded   → snapshot exists but consecutive failures > 0; last good data still served
 *   failing    → snapshot missing or too old AND consecutiveFailures ≥ FAILING_THRESHOLD
 *
 * Failure Backoff / Cooldown (Step 5):
 *   After repeated build failures, auto-rebuilds are suppressed for a cooldown period
 *   so the hot read-path is not hammered with expensive failing builds.
 *   Manual admin refreshes (forceRefresh) always bypass the cooldown.
 *   Cooldown duration scales with consecutiveFailures (see BACKOFF_THRESHOLDS).
 *
 * Build deduplication:
 *   One in-memory _state[type].rebuilding flag per type.
 *   No concurrent rebuilds are started for the same type.
 *
 * Freshness configuration is centralised in FRESHNESS_CONFIG.
 * Individual builder functions do the heavy work; this layer owns state.
 *
 * Public API:
 *   getOrBuild(type)                          → SWR-aware entry point for read endpoints
 *   forceRefresh(type)                        → admin-triggered synchronous rebuild (bypasses cooldown)
 *   getSummaryStatus(type, opts)              → single-type full diagnostic status
 *   listSummaryStatuses()                     → all types with freshness + rebuild + failure state
 *   getHealthSnapshot()                       → compact health map for all types
 *
 * Supported types: market_list, demo_portfolio, guardian_status
 */

const logger = require("../utils/logger");
const { readUiSummary, listUiSummaries } = require("./uiSummary.repository");

// Builder modules are required at load time (no circular dependencies).
const { refreshMarketSummary }        = require("./marketSummary.builder");
const { refreshDemoPortfolio }        = require("./adminDemoPortfolio.service");
const { refreshGuardianStatusSummary} = require("./guardianStatusSummary.builder");

/* =========================================================
   FRESHNESS CONFIGURATION  (per summary type)
   maxAgeMs: how long a DB snapshot is considered fresh
   builderFn: async fn that rebuilds the summary and writes to ui_summaries
========================================================= */

const FRESHNESS_CONFIG = {
  market_list: {
    maxAgeMs:  5 * 60 * 1000, // 5 min
    builderFn: () => refreshMarketSummary(),
  },
  demo_portfolio: {
    maxAgeMs:  10 * 60 * 1000, // 10 min
    builderFn: () => refreshDemoPortfolio(),
  },
  guardian_status: {
    maxAgeMs:  3 * 60 * 1000, // 3 min
    builderFn: () => refreshGuardianStatusSummary(),
  },
};

/* =========================================================
   FAILURE BACKOFF CONFIGURATION  (Step 5)
   Consecutive failure thresholds → cooldown before next auto-rebuild.
   Manual admin refresh always bypasses the cooldown.
========================================================= */

// IMPORTANT: thresholds must be ordered descending by minFailures so that
// Array.find() returns the most-specific (highest) applicable threshold first.
const BACKOFF_THRESHOLDS = [
  { minFailures: 5, cooldownMs: 5 * 60 * 1000  }, // 5+ failures → 5 min cooldown
  { minFailures: 3, cooldownMs: 2 * 60 * 1000  }, // 3-4 failures → 2 min cooldown
  { minFailures: 1, cooldownMs: 30 * 1000       }, // 1-2 failures → 30 s cooldown
];

// Types marked failing once consecutiveFailures reaches this level.
const FAILING_THRESHOLD = 5;

/* =========================================================
   PER-TYPE IN-MEMORY STATE  (Step 4 + Step 5)
   Step 4 fields:
     rebuilding            → true while a build is in progress
     rebuildStartedAt      → ISO ts when current build started
     lastError             → alias kept for backward compat (= lastErrorMessage)
   Step 5 additions:
     lastSuccessAt         → ISO ts of last successful rebuild
     lastFailureAt         → ISO ts of last failed rebuild
     failureCount          → total build failures since process start
     consecutiveFailures   → failures since the last success (reset on success)
     lastErrorMessage      → error message from the most recent failed build
     lastErrorAt           → ISO ts of the most recent build failure
     lastRebuildStartedAt  → ISO ts when the current/most-recent rebuild started
     lastRebuildFinishedAt → ISO ts when the most-recent rebuild finished (success or fail)
========================================================= */

const _state = {};
for (const type of Object.keys(FRESHNESS_CONFIG)) {
  _state[type] = {
    rebuilding:            false,
    // Step 4 compat alias – kept so existing callers using lastError still work
    lastError:             null,
    // Step 5 metadata
    lastSuccessAt:         null,
    lastFailureAt:         null,
    failureCount:          0,
    consecutiveFailures:   0,
    lastErrorMessage:      null,
    lastErrorAt:           null,
    lastRebuildStartedAt:  null,
    lastRebuildFinishedAt: null,
  };
}

/* =========================================================
   HELPERS
========================================================= */

/**
 * Derive a freshnessLabel from ageMs and maxAgeMs.
 *
 * @param {number|null} ageMs
 * @param {number} maxAgeMs
 * @returns {"fresh"|"stale"|"missing"}
 */
function _deriveFreshnessLabel(ageMs, maxAgeMs) {
  if (ageMs === null || ageMs === undefined) return "missing";
  return ageMs <= maxAgeMs ? "fresh" : "stale";
}

/**
 * Derive the operational health status for a summary type.  (Step 5)
 *
 * Levels (highest priority first):
 *   rebuilding → a build is currently running
 *   failing    → no usable snapshot + consecutiveFailures ≥ FAILING_THRESHOLD
 *   degraded   → snapshot exists but consecutiveFailures > 0 (serving stale under failure)
 *   healthy    → fresh snapshot with zero consecutive failures
 *   stale      → snapshot exists but age > maxAgeMs, no active failure streak
 *
 * @param {string} type
 * @param {number|null} ageMs
 * @param {number} maxAgeMs
 * @param {object|null} row  – DB row (null = no snapshot)
 * @returns {"healthy"|"stale"|"rebuilding"|"degraded"|"failing"}
 */
function _deriveOperationalStatus(type, ageMs, maxAgeMs, row) {
  const st = _state[type];

  if (st.rebuilding) return "rebuilding";

  const hasSnapshot  = row !== null && row !== undefined;
  const isFresh      = ageMs !== null && ageMs <= maxAgeMs;
  const hasFailures  = st.consecutiveFailures > 0;

  if (!hasSnapshot && st.consecutiveFailures >= FAILING_THRESHOLD) return "failing";
  if (hasFailures)  return "degraded";
  if (isFresh)      return "healthy";
  return "stale";
}

/**
 * Return the current cooldown duration (ms) for a type, or 0 if not in cooldown.
 * A type is in cooldown when its last failure was recent enough that we should
 * not attempt another automatic rebuild.  Manual admin refresh bypasses this.
 *
 * @param {string} type
 * @returns {number}  remaining cooldown in ms (0 = not cooling down)
 */
function _remainingCooldownMs(type) {
  const st = _state[type];
  if (!st.lastFailureAt || st.consecutiveFailures === 0) return 0;

  const applicable = BACKOFF_THRESHOLDS.find(
    (t) => st.consecutiveFailures >= t.minFailures
  );
  if (!applicable) return 0;

  const elapsed = Date.now() - new Date(st.lastFailureAt).getTime();
  const remaining = applicable.cooldownMs - elapsed;
  return remaining > 0 ? remaining : 0;
}

/**
 * Execute the builder for a given type, tracking dedup state and failure metadata.
 * Never throws – errors are caught and stored in _state[type].
 *
 * Step 5 additions:
 *   - tracks lastRebuildStartedAt / lastRebuildFinishedAt
 *   - on success: sets lastSuccessAt, resets consecutiveFailures
 *   - on failure: increments failureCount / consecutiveFailures, records lastErrorMessage /
 *                 lastErrorAt / lastFailureAt
 *
 * @param {string} type
 * @param {{ force?: boolean }} [opts]   force=true bypasses cooldown (admin path)
 * @returns {Promise<object|null>}
 */
async function _runRebuild(type, { force = false } = {}) {
  const st = _state[type];
  if (st.rebuilding) {
    logger.info(`[uiSummaryRefresh] rebuild already in progress for '${type}', skipping`);
    return null;
  }

  // Backoff cooldown check – skipped when forced by admin.
  if (!force) {
    const remaining = _remainingCooldownMs(type);
    if (remaining > 0) {
      logger.info(
        `[uiSummaryRefresh] '${type}' in backoff cooldown – skipping auto-rebuild` +
        ` (${Math.ceil(remaining / 1000)}s remaining, consecutiveFailures=${st.consecutiveFailures})`
      );
      return null;
    }
  }

  const cfg = FRESHNESS_CONFIG[type];
  st.rebuilding            = true;
  st.lastRebuildStartedAt  = new Date().toISOString();
  // Keep Step 4 compat alias in sync
  st.rebuildStartedAt      = st.lastRebuildStartedAt;
  st.lastError             = null;

  try {
    logger.info(`[uiSummaryRefresh] starting rebuild for '${type}'` +
      (force ? " (admin-forced)" : ""));
    const result = await cfg.builderFn();
    const now = new Date().toISOString();
    st.lastSuccessAt       = now;
    st.consecutiveFailures = 0;
    logger.info(`[uiSummaryRefresh] rebuild complete for '${type}'`);
    return result;
  } catch (err) {
    const msg = err.message ?? String(err);
    const now = new Date().toISOString();
    st.failureCount        += 1;
    st.consecutiveFailures += 1;
    st.lastErrorMessage     = msg;
    st.lastErrorAt          = now;
    st.lastFailureAt        = now;
    // Step 4 compat alias
    st.lastError            = msg;
    logger.warn(`[uiSummaryRefresh] rebuild failed for '${type}'`, {
      message:             msg,
      consecutiveFailures: st.consecutiveFailures,
      failureCount:        st.failureCount,
    });
    return null;
  } finally {
    st.rebuilding            = false;
    st.lastRebuildFinishedAt = new Date().toISOString();
    // Clear Step 4 compat alias
    st.rebuildStartedAt      = null;
  }
}

/* =========================================================
   CORE API
========================================================= */

/**
 * Get or build a UI summary with centralised freshness and dedup logic.
 *
 * State machine:
 *   fresh      → return DB payload immediately
 *   stale      → return DB payload + trigger async rebuild in background
 *   missing    → build synchronously, then return result
 *   rebuilding → already building; return last known DB payload (may be null)
 *
 * Step 5: auto-rebuild is skipped when the type is in backoff cooldown.
 *
 * Returned object shape:
 *   {
 *     payload:               object|null,
 *     freshnessLabel:        "fresh"|"stale"|"missing"|"rebuilding"|"error",
 *     operationalStatus:     "healthy"|"stale"|"rebuilding"|"degraded"|"failing",
 *     ageMs:                 number|null,
 *     builtAt:               string|null,
 *     isPartial:             boolean,
 *     buildDurationMs:       number|null,
 *     rebuilding:            boolean,
 *     lastError:             string|null,
 *     consecutiveFailures:   number,
 *     cooldownRemainingMs:   number,
 *   }
 *
 * @param {string} type
 * @returns {Promise<object>}
 */
async function getOrBuild(type) {
  if (!FRESHNESS_CONFIG[type]) {
    throw new Error(`[uiSummaryRefresh] Unknown summary type: '${type}'`);
  }

  const cfg = FRESHNESS_CONFIG[type];
  const st  = _state[type];
  const row = await readUiSummary(type);

  const ageMs = row?.builtAt ? Date.now() - new Date(row.builtAt).getTime() : null;
  const baseLabel = _deriveFreshnessLabel(ageMs, cfg.maxAgeMs);

  const base = {
    rebuilding:            st.rebuilding,
    lastError:             st.lastError,
    consecutiveFailures:   st.consecutiveFailures,
    cooldownRemainingMs:   _remainingCooldownMs(type),
    ageMs,
    builtAt:         row?.builtAt ?? null,
    isPartial:       row?.isPartial ?? false,
    buildDurationMs: row?.buildDurationMs ?? null,
  };

  // ── FRESH ───────────────────────────────────────────────────────────────────
  if (baseLabel === "fresh") {
    return {
      ...base,
      payload:           row.payload,
      freshnessLabel:    "fresh",
      operationalStatus: _deriveOperationalStatus(type, ageMs, cfg.maxAgeMs, row),
    };
  }

  // ── STALE ───────────────────────────────────────────────────────────────────
  if (baseLabel === "stale") {
    if (!st.rebuilding) {
      setImmediate(() => _runRebuild(type).catch(() => {}));
    }
    return {
      ...base,
      payload:           row.payload,
      freshnessLabel:    st.rebuilding ? "rebuilding" : "stale",
      operationalStatus: _deriveOperationalStatus(type, ageMs, cfg.maxAgeMs, row),
    };
  }

  // ── MISSING ─────────────────────────────────────────────────────────────────
  // Already a rebuild in progress → return null payload, no duplicate build
  if (st.rebuilding) {
    return {
      ...base,
      payload:           null,
      freshnessLabel:    "rebuilding",
      operationalStatus: "rebuilding",
    };
  }

  // Cold path: synchronous build (first startup or lost snapshot)
  await _runRebuild(type);
  const freshRow = await readUiSummary(type);
  const freshAge = freshRow?.builtAt
    ? Date.now() - new Date(freshRow.builtAt).getTime()
    : null;

  return {
    rebuilding:            false,
    lastError:             st.lastError,
    consecutiveFailures:   st.consecutiveFailures,
    cooldownRemainingMs:   _remainingCooldownMs(type),
    ageMs:                 freshAge,
    builtAt:               freshRow?.builtAt ?? null,
    isPartial:             freshRow?.isPartial ?? false,
    buildDurationMs:       freshRow?.buildDurationMs ?? null,
    payload:               freshRow?.payload ?? null,
    freshnessLabel:        freshRow ? "fresh" : "error",
    operationalStatus:     _deriveOperationalStatus(type, freshAge, cfg.maxAgeMs, freshRow ?? null),
  };
}

/**
 * Force a synchronous rebuild for a given type, ignoring freshness and cooldown.
 * Used by admin manual-refresh endpoints.
 *
 * @param {string} type
 * @returns {Promise<{success: boolean, freshnessLabel: string, operationalStatus: string, builtAt: string|null, buildDurationMs: number|null, lastError: string|null, consecutiveFailures: number, message?: string}>}
 */
async function forceRefresh(type) {
  if (!FRESHNESS_CONFIG[type]) {
    throw new Error(`[uiSummaryRefresh] Unknown summary type: '${type}'`);
  }

  const st = _state[type];
  if (st.rebuilding) {
    return {
      success:             false,
      freshnessLabel:      "rebuilding",
      operationalStatus:   "rebuilding",
      builtAt:             null,
      buildDurationMs:     null,
      lastError:           null,
      consecutiveFailures: st.consecutiveFailures,
      message:             "Rebuild already in progress",
    };
  }

  // force=true bypasses backoff cooldown
  await _runRebuild(type, { force: true });
  const row = await readUiSummary(type);
  const cfg = FRESHNESS_CONFIG[type];
  const ageMs = row?.builtAt ? Date.now() - new Date(row.builtAt).getTime() : null;

  return {
    success:             st.lastError === null,
    freshnessLabel:      row ? "fresh" : "error",
    operationalStatus:   _deriveOperationalStatus(type, ageMs, cfg.maxAgeMs, row ?? null),
    builtAt:             row?.builtAt ?? null,
    buildDurationMs:     row?.buildDurationMs ?? null,
    lastError:           st.lastError,
    consecutiveFailures: st.consecutiveFailures,
  };
}

/**
 * Get the current status of a single summary type.
 * Includes all diagnostic fields: freshnessLabel, operationalStatus, ageMs, rebuilding,
 * builtAt, isPartial, buildDurationMs, maxAgeMs, and all Step 5 failure/timing metadata.
 *
 * @param {string} type
 * @param {{ includePayload?: boolean }} [opts]
 * @returns {Promise<object|null>}
 */
async function getSummaryStatus(type, { includePayload = false } = {}) {
  const cfg = FRESHNESS_CONFIG[type];
  if (!cfg) return null;

  const st  = _state[type];
  const row = await readUiSummary(type);
  const ageMs = row?.builtAt ? Date.now() - new Date(row.builtAt).getTime() : null;

  const freshnessLabel = st.rebuilding
    ? "rebuilding"
    : _deriveFreshnessLabel(ageMs, cfg.maxAgeMs);

  const operationalStatus = _deriveOperationalStatus(type, ageMs, cfg.maxAgeMs, row ?? null);

  const status = {
    summaryType:           type,
    freshnessLabel,
    operationalStatus,
    ageMs,
    builtAt:               row?.builtAt ?? null,
    isPartial:             row?.isPartial ?? false,
    buildDurationMs:       row?.buildDurationMs ?? null,
    rebuilding:            st.rebuilding,
    // Step 5 fields
    lastSuccessAt:         st.lastSuccessAt,
    lastFailureAt:         st.lastFailureAt,
    failureCount:          st.failureCount,
    consecutiveFailures:   st.consecutiveFailures,
    lastErrorMessage:      st.lastErrorMessage,
    lastErrorAt:           st.lastErrorAt,
    lastRebuildStartedAt:  st.lastRebuildStartedAt,
    lastRebuildFinishedAt: st.lastRebuildFinishedAt,
    cooldownRemainingMs:   _remainingCooldownMs(type),
    // Step 4 compat
    lastError:             st.lastError,
    rebuildStartedAt:      st.rebuildStartedAt,
    maxAgeMs:              cfg.maxAgeMs,
  };

  if (includePayload) {
    status.payload = row?.payload ?? null;
  }

  return status;
}

/**
 * List statuses for all known summary types.
 * Augments listUiSummaries() DB data with in-memory freshness, rebuild state,
 * and all Step 5 failure/timing metadata.
 *
 * @returns {Promise<object[]>}
 */
async function listSummaryStatuses() {
  const dbRows = await listUiSummaries();
  const now    = Date.now();

  return Object.keys(FRESHNESS_CONFIG).map((type) => {
    const cfg = FRESHNESS_CONFIG[type];
    const st  = _state[type];
    const row = dbRows.find((r) => r.summaryType === type) ?? null;
    const ageMs = row?.builtAt ? now - new Date(row.builtAt).getTime() : null;

    const freshnessLabel = st.rebuilding
      ? "rebuilding"
      : _deriveFreshnessLabel(ageMs, cfg.maxAgeMs);

    const operationalStatus = _deriveOperationalStatus(type, ageMs, cfg.maxAgeMs, row);

    return {
      summaryType:           type,
      freshnessLabel,
      operationalStatus,
      ageMs:                 ageMs ?? row?.ageMs ?? null,
      builtAt:               row?.builtAt ?? null,
      isPartial:             row?.isPartial ?? false,
      buildDurationMs:       row?.buildDurationMs ?? null,
      rebuilding:            st.rebuilding,
      // Step 5 fields
      lastSuccessAt:         st.lastSuccessAt,
      lastFailureAt:         st.lastFailureAt,
      failureCount:          st.failureCount,
      consecutiveFailures:   st.consecutiveFailures,
      lastErrorMessage:      st.lastErrorMessage,
      lastErrorAt:           st.lastErrorAt,
      lastRebuildStartedAt:  st.lastRebuildStartedAt,
      lastRebuildFinishedAt: st.lastRebuildFinishedAt,
      cooldownRemainingMs:   _remainingCooldownMs(type),
      // Step 4 compat
      lastError:             st.lastError,
      rebuildStartedAt:      st.rebuildStartedAt,
      maxAgeMs:              cfg.maxAgeMs,
    };
  });
}

/**
 * Return a compact health snapshot for all summary types.  (Step 5)
 * Useful for lightweight health checks.
 *
 * Shape per type:
 *   { summaryType, operationalStatus, freshnessLabel, consecutiveFailures,
 *     cooldownRemainingMs, builtAt, rebuilding }
 *
 * @returns {Promise<object[]>}
 */
async function getHealthSnapshot() {
  const dbRows = await listUiSummaries();
  const now    = Date.now();

  return Object.keys(FRESHNESS_CONFIG).map((type) => {
    const cfg = FRESHNESS_CONFIG[type];
    const st  = _state[type];
    const row = dbRows.find((r) => r.summaryType === type) ?? null;
    const ageMs = row?.builtAt ? now - new Date(row.builtAt).getTime() : null;

    const freshnessLabel    = st.rebuilding
      ? "rebuilding"
      : _deriveFreshnessLabel(ageMs, cfg.maxAgeMs);
    const operationalStatus = _deriveOperationalStatus(type, ageMs, cfg.maxAgeMs, row);

    return {
      summaryType:         type,
      operationalStatus,
      freshnessLabel,
      consecutiveFailures: st.consecutiveFailures,
      cooldownRemainingMs: _remainingCooldownMs(type),
      builtAt:             row?.builtAt ?? null,
      ageMs,
      rebuilding:          st.rebuilding,
    };
  });
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  FRESHNESS_CONFIG,
  BACKOFF_THRESHOLDS,
  FAILING_THRESHOLD,
  SUPPORTED_TYPES: Object.keys(FRESHNESS_CONFIG),
  getOrBuild,
  forceRefresh,
  getSummaryStatus,
  listSummaryStatuses,
  getHealthSnapshot,
};
