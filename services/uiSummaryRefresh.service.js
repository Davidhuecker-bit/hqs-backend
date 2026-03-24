"use strict";

/**
 * UI Summary Refresh Orchestration  (Step 4)
 * -------------------------------------------
 * Central freshness-control and build-dedupe for all ui_summaries types.
 *
 * States per summary_type:
 *   fresh      → DB snapshot is within maxAgeMs; serve directly (fast path)
 *   stale      → DB snapshot exists but is old; serve + trigger async rebuild
 *   missing    → no DB snapshot; build synchronously and return
 *   rebuilding → async rebuild in progress; serve last known data (no duplicate build)
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
 *   forceRefresh(type)                        → admin-triggered synchronous rebuild
 *   getSummaryStatus(type, opts)              → single-type status with all diagnostic fields
 *   listSummaryStatuses()                     → all types with freshness + rebuild state
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
   PER-TYPE IN-MEMORY STATE
   rebuilding       → true while a build is in progress
   rebuildStartedAt → ISO timestamp of when the current build started
   lastError        → error message from the most recent failed build
========================================================= */

const _state = {};
for (const type of Object.keys(FRESHNESS_CONFIG)) {
  _state[type] = {
    rebuilding:       false,
    rebuildStartedAt: null,
    lastError:        null,
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
 * Execute the builder for a given type, tracking dedup state and errors.
 * Never throws – errors are caught and stored in _state[type].lastError.
 *
 * @param {string} type
 * @returns {Promise<object|null>}
 */
async function _runRebuild(type) {
  const st = _state[type];
  if (st.rebuilding) {
    logger.info(`[uiSummaryRefresh] rebuild already in progress for '${type}', skipping`);
    return null;
  }

  const cfg = FRESHNESS_CONFIG[type];
  st.rebuilding       = true;
  st.rebuildStartedAt = new Date().toISOString();
  st.lastError        = null;

  try {
    logger.info(`[uiSummaryRefresh] starting rebuild for '${type}'`);
    const result = await cfg.builderFn();
    logger.info(`[uiSummaryRefresh] rebuild complete for '${type}'`);
    return result;
  } catch (err) {
    st.lastError = err.message ?? String(err);
    logger.warn(`[uiSummaryRefresh] rebuild failed for '${type}'`, {
      message: st.lastError,
    });
    return null;
  } finally {
    st.rebuilding       = false;
    st.rebuildStartedAt = null;
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
 * Returned object shape:
 *   {
 *     payload:         object|null,
 *     freshnessLabel:  "fresh"|"stale"|"missing"|"rebuilding"|"error",
 *     ageMs:           number|null,
 *     builtAt:         string|null,
 *     isPartial:       boolean,
 *     buildDurationMs: number|null,
 *     rebuilding:      boolean,
 *     lastError:       string|null,
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
    rebuilding:      st.rebuilding,
    lastError:       st.lastError,
    ageMs,
    builtAt:         row?.builtAt ?? null,
    isPartial:       row?.isPartial ?? false,
    buildDurationMs: row?.buildDurationMs ?? null,
  };

  // ── FRESH ───────────────────────────────────────────────────────────────────
  if (baseLabel === "fresh") {
    return { ...base, payload: row.payload, freshnessLabel: "fresh" };
  }

  // ── STALE ───────────────────────────────────────────────────────────────────
  if (baseLabel === "stale") {
    if (!st.rebuilding) {
      setImmediate(() => _runRebuild(type).catch(() => {}));
    }
    return {
      ...base,
      payload:        row.payload,
      freshnessLabel: st.rebuilding ? "rebuilding" : "stale",
    };
  }

  // ── MISSING ─────────────────────────────────────────────────────────────────
  // Already a rebuild in progress → return null payload, no duplicate build
  if (st.rebuilding) {
    return { ...base, payload: null, freshnessLabel: "rebuilding" };
  }

  // Cold path: synchronous build (first startup or lost snapshot)
  await _runRebuild(type);
  const freshRow = await readUiSummary(type);
  const freshAge = freshRow?.builtAt
    ? Date.now() - new Date(freshRow.builtAt).getTime()
    : null;

  return {
    rebuilding:      false,
    lastError:       st.lastError,
    ageMs:           freshAge,
    builtAt:         freshRow?.builtAt ?? null,
    isPartial:       freshRow?.isPartial ?? false,
    buildDurationMs: freshRow?.buildDurationMs ?? null,
    payload:         freshRow?.payload ?? null,
    freshnessLabel:  freshRow ? "fresh" : "error",
  };
}

/**
 * Force a synchronous rebuild for a given type, ignoring freshness.
 * Used by admin manual-refresh endpoints.
 *
 * @param {string} type
 * @returns {Promise<{success: boolean, freshnessLabel: string, builtAt: string|null, buildDurationMs: number|null, lastError: string|null, message?: string}>}
 */
async function forceRefresh(type) {
  if (!FRESHNESS_CONFIG[type]) {
    throw new Error(`[uiSummaryRefresh] Unknown summary type: '${type}'`);
  }

  const st = _state[type];
  if (st.rebuilding) {
    return {
      success:         false,
      freshnessLabel:  "rebuilding",
      builtAt:         null,
      buildDurationMs: null,
      lastError:       null,
      message:         "Rebuild already in progress",
    };
  }

  await _runRebuild(type);
  const row = await readUiSummary(type);

  return {
    success:         st.lastError === null,
    freshnessLabel:  row ? "fresh" : "error",
    builtAt:         row?.builtAt ?? null,
    buildDurationMs: row?.buildDurationMs ?? null,
    lastError:       st.lastError,
  };
}

/**
 * Get the current status of a single summary type.
 * Includes all diagnostic fields: freshnessLabel, ageMs, rebuilding, builtAt,
 * isPartial, buildDurationMs, lastError, rebuildStartedAt, maxAgeMs.
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

  const status = {
    summaryType:      type,
    freshnessLabel,
    ageMs,
    builtAt:          row?.builtAt ?? null,
    isPartial:        row?.isPartial ?? false,
    buildDurationMs:  row?.buildDurationMs ?? null,
    rebuilding:       st.rebuilding,
    rebuildStartedAt: st.rebuildStartedAt,
    lastError:        st.lastError,
    maxAgeMs:         cfg.maxAgeMs,
  };

  if (includePayload) {
    status.payload = row?.payload ?? null;
  }

  return status;
}

/**
 * List statuses for all known summary types.
 * Augments listUiSummaries() DB data with in-memory freshness and rebuild state.
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

    return {
      summaryType:      type,
      freshnessLabel,
      ageMs:            ageMs ?? row?.ageMs ?? null,
      builtAt:          row?.builtAt ?? null,
      isPartial:        row?.isPartial ?? false,
      buildDurationMs:  row?.buildDurationMs ?? null,
      rebuilding:       st.rebuilding,
      rebuildStartedAt: st.rebuildStartedAt,
      lastError:        st.lastError,
      maxAgeMs:         cfg.maxAgeMs,
    };
  });
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  FRESHNESS_CONFIG,
  SUPPORTED_TYPES: Object.keys(FRESHNESS_CONFIG),
  getOrBuild,
  forceRefresh,
  getSummaryStatus,
  listSummaryStatuses,
};
