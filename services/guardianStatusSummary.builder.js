"use strict";

/**
 * Guardian Status Summary Builder  (Step 3 – Read-Model Layer)
 * --------------------------------------------------------------
 * Builds and persists a compact system/guardian status summary that covers:
 *   - World state freshness, regime, risk mode, volatility, early warnings
 *   - Pipeline stage health (last run times, success/failure counts)
 *   - Overall system health classification
 *
 * This replaces the need for live multi-source aggregation on guardian/admin
 * status surfaces.  The summary is persisted to ui_summaries under the key
 * 'guardian_status' so it can be read with a single DB query.
 *
 * Read path  : readGuardianStatusSummary()   → single DB read
 * Build path : refreshGuardianStatusSummary() → assembles from worldState + pipeline status
 *
 * Fresh threshold: 3 minutes (GUARDIAN_SUMMARY_MAX_AGE_MS)
 *
 * Parallel-refresh guard: _isRefreshing flag prevents duplicate work.
 */

const logger = require("../utils/logger");
const { readUiSummary, writeUiSummary } = require("./uiSummary.repository");
const { getWorldState, classifyWorldStateAge } = require("./worldState.service");
const { loadPipelineStatus } = require("./pipelineStatus.repository");

const SUMMARY_TYPE = "guardian_status";
const GUARDIAN_SUMMARY_MAX_AGE_MS = 3 * 60 * 1000; // 3 min

let _isRefreshing = false;

/* =========================================================
   HEALTH CLASSIFICATION HELPERS
========================================================= */

/**
 * Derive an overall system health label from component signals.
 *
 * @param {{ worldStateFreshness: string, pipelineOk: boolean, earlyWarning: boolean }} signals
 * @returns {"ok"|"degraded"|"critical"}
 */
function _deriveSystemHealth({ worldStateFreshness, pipelineOk, earlyWarning }) {
  if (worldStateFreshness === "hard_stale" || !pipelineOk) return "critical";
  if (worldStateFreshness === "stale" || earlyWarning) return "degraded";
  return "ok";
}

/**
 * Summarise pipeline stages into a compact health object.
 * Returns pipelineOk=true when at least the snapshot stage has a recent run.
 *
 * @param {Record<string, {lastRunAt: string|null, successCount: number, failedCount: number}>} stages
 * @returns {{ pipelineOk: boolean, stageSummary: object, oldestStageAgeMs: number|null }}
 */
function _summarisePipeline(stages) {
  const now = Date.now();
  let oldestAgeMs = null;
  const stageSummary = {};

  for (const [stage, info] of Object.entries(stages)) {
    const ageMs = info.lastRunAt ? now - new Date(info.lastRunAt).getTime() : null;
    if (ageMs !== null && (oldestAgeMs === null || ageMs > oldestAgeMs)) {
      oldestAgeMs = ageMs;
    }
    stageSummary[stage] = {
      lastRunAt:    info.lastRunAt ?? null,
      ageMs,
      successCount: info.successCount ?? 0,
      failedCount:  info.failedCount ?? 0,
    };
  }

  // Consider pipeline ok if the snapshot stage ran in the last 6 hours
  const snapshotInfo = stageSummary.snapshot;
  const pipelineOk =
    snapshotInfo != null &&
    snapshotInfo.ageMs !== null &&
    snapshotInfo.ageMs < 6 * 60 * 60 * 1000;

  return { pipelineOk, stageSummary, oldestStageAgeMs: oldestAgeMs };
}

/* =========================================================
   READ PATH
========================================================= */

/**
 * Read the prepared guardian status summary from ui_summaries.
 * Returns null if not found or on error.
 *
 * @returns {Promise<object|null>}
 */
async function readGuardianStatusSummary() {
  const row = await readUiSummary(SUMMARY_TYPE);
  if (!row) return null;

  const ageMs = row.builtAt ? Date.now() - new Date(row.builtAt).getTime() : Infinity;
  return {
    ...row.payload,
    builtAt:         row.builtAt,
    isPartial:       row.isPartial,
    buildDurationMs: row.buildDurationMs,
    ageMs,
    freshness:       ageMs < GUARDIAN_SUMMARY_MAX_AGE_MS ? "fresh" : "stale",
  };
}

/* =========================================================
   BUILD / REFRESH PATH
========================================================= */

/**
 * Build the guardian status summary and persist to ui_summaries.
 * Assembles worldState signals + pipeline stage health into one compact object.
 *
 * @returns {Promise<object|null>}
 */
async function refreshGuardianStatusSummary() {
  if (_isRefreshing) {
    logger.info("[guardianStatusSummary] refresh already in progress, skipping");
    return null;
  }

  _isRefreshing = true;
  const t0 = Date.now();
  try {
    logger.info("[guardianStatusSummary] building guardian status summary");

    // Gather sources in parallel; errors are caught defensively per source
    const [worldState, pipelineStages] = await Promise.all([
      getWorldState().catch((err) => {
        logger.warn("[guardianStatusSummary] getWorldState failed", { message: err.message });
        return null;
      }),
      loadPipelineStatus().catch((err) => {
        logger.warn("[guardianStatusSummary] loadPipelineStatus failed", { message: err.message });
        return {};
      }),
    ]);

    // World state signals
    const worldStateFreshness = worldState
      ? classifyWorldStateAge(worldState)
      : "unavailable";

    const worldStateSignals = worldState
      ? {
          version:          worldState.version ?? null,
          regime:           worldState.regime ?? null,
          riskMode:         worldState.riskMode ?? null,
          volatilityState:  worldState.volatilityState ?? null,
          earlyWarning:     Boolean(worldState.earlyWarning),
          sectorAlertCount: Array.isArray(worldState.sectorAlerts) ? worldState.sectorAlerts.length : 0,
          createdAt:        worldState.created_at ?? worldState.createdAt ?? null,
          staleWarning:     Boolean(worldState.staleWarning),
        }
      : null;

    // Pipeline signals
    const { pipelineOk, stageSummary, oldestStageAgeMs } = _summarisePipeline(
      pipelineStages ?? {}
    );

    // Overall system health
    const systemHealth = _deriveSystemHealth({
      worldStateFreshness,
      pipelineOk,
      earlyWarning: Boolean(worldState?.earlyWarning),
    });

    const durationMs = Date.now() - t0;

    const summary = {
      systemHealth,
      worldStateFreshness,
      worldStateSignals,
      pipeline: {
        ok:                pipelineOk,
        stageSummary,
        oldestStageAgeMs,
      },
      generatedAt: new Date().toISOString(),
    };

    const isPartial = worldState === null;

    await writeUiSummary(SUMMARY_TYPE, summary, {
      buildDurationMs: durationMs,
      isPartial,
    });

    logger.info("[guardianStatusSummary] summary built and persisted", {
      systemHealth,
      worldStateFreshness,
      pipelineOk,
      durationMs,
    });

    return summary;
  } catch (err) {
    logger.warn("[guardianStatusSummary] refresh failed", { message: err.message });
    return null;
  } finally {
    _isRefreshing = false;
  }
}

/* =========================================================
   SMART PATH  (SWR-like)
========================================================= */

/**
 * Get guardian status summary with stale-while-revalidate logic.
 * Returns the summary (fresh or stale) and triggers async refresh when stale.
 *
 * @param {{ maxAgeMs?: number }} [opts]
 * @returns {Promise<object>}
 */
async function getOrBuildGuardianStatusSummary({ maxAgeMs = GUARDIAN_SUMMARY_MAX_AGE_MS } = {}) {
  const summary = await readGuardianStatusSummary();

  if (summary && summary.ageMs <= maxAgeMs) {
    return summary;
  }

  if (summary) {
    // Stale: return existing data + trigger async refresh
    if (!_isRefreshing) {
      setImmediate(() =>
        refreshGuardianStatusSummary().catch((err) =>
          logger.warn("[guardianStatusSummary] async SWR refresh failed", { message: err.message })
        )
      );
    }
    return summary;
  }

  // Cold path: build synchronously
  const built = await refreshGuardianStatusSummary();
  return built ?? {
    systemHealth:         "unavailable",
    worldStateFreshness:  "unavailable",
    worldStateSignals:    null,
    pipeline:             { ok: false, stageSummary: {}, oldestStageAgeMs: null },
    generatedAt:          new Date().toISOString(),
    isPartial:            true,
    freshness:            "error",
  };
}

module.exports = {
  readGuardianStatusSummary,
  refreshGuardianStatusSummary,
  getOrBuildGuardianStatusSummary,
  GUARDIAN_SUMMARY_MAX_AGE_MS,
};
