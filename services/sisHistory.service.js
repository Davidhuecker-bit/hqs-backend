"use strict";

/*
  SIS History Service  –  Low-Budget Trend Layer for System Intelligence Score
  ─────────────────────────────────────────────────────────────────────────────
  Persists periodic SIS snapshots to a tiny `sis_history` table and provides
  trend/regression analysis without any external dependencies or heavy jobs.

  Design principles (low-budget, 2030–2035 vision):
  ──────────────────────────────────────────────────
  1. Minimal new table: sis_history with 6 columns only.
  2. No background polling – snapshots are saved during existing warmup/refresh
     cycles (already scheduled) and optionally on admin page loads.
  3. All trend logic is O(small-N) SQL aggregation – no in-memory heavy lifting.
  4. Pure read for summary/trend endpoints – no side effects.
  5. learning_runtime_state checked first – we reuse it for current snapshot
     caching; the new table only stores the time-series rows.

  Table: sis_history
  ──────────────────
    id              SERIAL PRIMARY KEY
    sis_score       INTEGER NOT NULL
    layer_scores    JSONB                (per-layer {id, score, max, status})
    recommended_mode VARCHAR(50)
    biggest_blocker TEXT
    next_step       TEXT
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()

  Functions exported:
  ────────────────────
    ensureSisHistoryTable()          → creates table + index if needed
    saveSisSnapshot(report)          → inserts one row (deduped: skip if last
                                       snapshot within MIN_SNAPSHOT_INTERVAL_MIN)
    getSisHistory(range)             → returns rows for '24h' | '7d' | '30d'
    getSisTrendSummary()             → delta + direction + top causes
    detectSisRegression()            → list of episodes where SIS dropped ≥ threshold
    detectSisImprovement()           → list of episodes where SIS rose ≥ threshold

  NOT BUILT:
  ──────────
  • No external chart library (plain data returned; admin.html renders inline)
  • No heavy scheduler (hooks into existing warmup cycle)
  • No duplicate system-intelligence logic (calls getSystemIntelligenceReport())
*/

const { Pool } = require("pg");
const logger = require("../utils/logger");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =========================================================
   CONSTANTS
========================================================= */

// Minimum minutes between two persisted snapshots (budget guard: ~4×/day max)
const MIN_SNAPSHOT_INTERVAL_MINUTES = 60 * 6; // 6 hours

// Minimum SIS drop/rise to flag as regression/improvement
const REGRESSION_THRESHOLD  = 5;
const IMPROVEMENT_THRESHOLD = 5;

/* =========================================================
   TABLE INIT
========================================================= */

/**
 * Creates the sis_history table if it does not yet exist.
 * Called once on server startup – idempotent.
 */
async function ensureSisHistoryTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sis_history (
      id               SERIAL PRIMARY KEY,
      sis_score        INTEGER NOT NULL,
      layer_scores     JSONB,
      recommended_mode VARCHAR(50),
      biggest_blocker  TEXT,
      next_step        TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sis_history_created_at
      ON sis_history (created_at DESC);
  `);
  logger.info("sisHistory: sis_history table ensured");
}

/* =========================================================
   SNAPSHOT SAVE  (deduped)
========================================================= */

/**
 * Persists a SIS snapshot derived from getSystemIntelligenceReport() output.
 * Skips the write if a snapshot already exists within MIN_SNAPSHOT_INTERVAL_MIN.
 *
 * @param {object} report - result of getSystemIntelligenceReport()
 * @param {object} [releaseStatus] - optional result of getOperationalReleaseStatus()
 * @returns {Promise<boolean>} true if a row was inserted, false if skipped
 */
async function saveSisSnapshot(report, releaseStatus) {
  try {
    // ── Dedup guard: skip if a recent snapshot already exists ───────────────
    const recent = await pool.query(`
      SELECT id FROM sis_history
      WHERE created_at >= NOW() - INTERVAL '1 minute' * $1
      LIMIT 1
    `, [MIN_SNAPSHOT_INTERVAL_MINUTES]);

    if (recent.rows.length > 0) {
      logger.debug("sisHistory: snapshot skipped – recent entry within interval");
      return false;
    }

    const layerScores = Array.isArray(report.layers)
      ? report.layers.map((l) => ({ id: l.id, score: l.score, max: l.max, status: l.status }))
      : null;

    const recommendedMode = releaseStatus?.recommendedMode?.mode
      ?? report.maturity?.key
      ?? null;

    const biggestBlocker = releaseStatus?.biggestBlockers?.[0]?.reason
      ?? report.recommendations?.[0]?.action
      ?? null;

    const nextStep = releaseStatus?.nextStep
      ?? report.recommendations?.[0]?.howTo
      ?? null;

    await pool.query(`
      INSERT INTO sis_history
        (sis_score, layer_scores, recommended_mode, biggest_blocker, next_step)
      VALUES ($1, $2, $3, $4, $5)
    `, [
      report.sis ?? 0,
      layerScores ? JSON.stringify(layerScores) : null,
      recommendedMode,
      biggestBlocker,
      nextStep,
    ]);

    logger.info("sisHistory: snapshot saved", { sis: report.sis });
    return true;
  } catch (err) {
    logger.warn("sisHistory: saveSisSnapshot failed", { message: err.message });
    return false;
  }
}

/* =========================================================
   HISTORY QUERY
========================================================= */

const RANGE_TO_INTERVAL = {
  "24h":  "24 hours",
  "7d":   "7 days",
  "30d":  "30 days",
};

/**
 * Returns the raw snapshot rows for the requested time window.
 *
 * @param {'24h'|'7d'|'30d'} range
 * @returns {Promise<object[]>}
 */
async function getSisHistory(range) {
  const interval = RANGE_TO_INTERVAL[range] || RANGE_TO_INTERVAL["7d"];
  try {
    const res = await pool.query(`
      SELECT
        id,
        sis_score,
        layer_scores,
        recommended_mode,
        biggest_blocker,
        next_step,
        created_at
      FROM sis_history
      WHERE created_at >= NOW() - ($1)::INTERVAL
      ORDER BY created_at ASC
    `, [interval]);
    return res.rows;
  } catch (err) {
    logger.warn("sisHistory: getSisHistory failed", { message: err.message });
    return [];
  }
}

/* =========================================================
   TREND SUMMARY
========================================================= */

/**
 * Derives a compact trend summary from the stored snapshots.
 *
 * Returns:
 *   current        – latest SIS score (or null if no data)
 *   delta24h        – change vs 24h ago
 *   delta7d         – change vs 7d ago
 *   delta30d        – change vs 30d ago
 *   direction       – 'improving' | 'declining' | 'stable'
 *   directionLabel  – German label
 *   topDeclineLayer – layer with largest negative delta (if any)
 *   topGainLayer    – layer with largest positive delta (if any)
 *   snapshotCount   – total rows in table
 *   lastUpdated     – ISO timestamp of latest snapshot
 *
 * @returns {Promise<object>}
 */
async function getSisTrendSummary() {
  try {
    // ── Fetch latest snapshot ────────────────────────────────────────────────
    const latestRes = await pool.query(`
      SELECT sis_score, layer_scores, created_at
      FROM sis_history
      ORDER BY created_at DESC
      LIMIT 1
    `);
    if (!latestRes.rows.length) {
      return _emptyTrend();
    }
    const latest = latestRes.rows[0];
    const current = Number(latest.sis_score);
    const lastUpdated = latest.created_at;

    // ── Fetch reference points in one query ──────────────────────────────────
    const refRes = await pool.query(`
      SELECT
        (SELECT sis_score FROM sis_history
          WHERE created_at <= NOW() - INTERVAL '24 hours'
          ORDER BY created_at DESC LIMIT 1)  AS score_24h,
        (SELECT sis_score FROM sis_history
          WHERE created_at <= NOW() - INTERVAL '7 days'
          ORDER BY created_at DESC LIMIT 1)  AS score_7d,
        (SELECT sis_score FROM sis_history
          WHERE created_at <= NOW() - INTERVAL '30 days'
          ORDER BY created_at DESC LIMIT 1)  AS score_30d,
        (SELECT COUNT(*) FROM sis_history)   AS total_count
    `);
    const ref = refRes.rows[0] || {};

    const delta24h  = ref.score_24h  != null ? current - Number(ref.score_24h)  : null;
    const delta7d   = ref.score_7d   != null ? current - Number(ref.score_7d)   : null;
    const delta30d  = ref.score_30d  != null ? current - Number(ref.score_30d)  : null;

    // ── Direction from 7d delta (most representative), fall back to 24h ──────
    const primaryDelta = delta7d ?? delta24h ?? 0;
    const direction = primaryDelta > 2
      ? "improving"
      : primaryDelta < -2
        ? "declining"
        : "stable";

    const DIRECTION_LABEL = {
      improving: "Verbessert sich ↑",
      declining: "Verschlechtert sich ↓",
      stable:    "Stabil →",
    };

    // ── Layer-level deltas (from latest snapshot vs 7d-ago snapshot) ─────────
    let topDeclineLayer = null;
    let topGainLayer    = null;

    if (latest.layer_scores && ref.score_7d != null) {
      const refLayerRes = await pool.query(`
        SELECT layer_scores FROM sis_history
        WHERE created_at <= NOW() - INTERVAL '7 days'
        ORDER BY created_at DESC LIMIT 1
      `);
      const refLayerRow = refLayerRes.rows[0];
      if (refLayerRow?.layer_scores) {
        const refLayers = refLayerRow.layer_scores;
        const curLayers = latest.layer_scores;
        let maxDecline = 0;
        let maxGain    = 0;
        for (const cur of curLayers) {
          const ref7 = refLayers.find((r) => r.id === cur.id);
          if (!ref7) continue;
          const diff = cur.score - ref7.score;
          if (diff < maxDecline) { maxDecline = diff; topDeclineLayer = { id: cur.id, delta: diff }; }
          if (diff > maxGain)    { maxGain    = diff; topGainLayer    = { id: cur.id, delta: diff }; }
        }
      }
    }

    return {
      current,
      delta24h,
      delta7d,
      delta30d,
      direction,
      directionLabel: DIRECTION_LABEL[direction],
      topDeclineLayer,
      topGainLayer,
      snapshotCount: Number(ref.total_count || 0),
      lastUpdated,
    };
  } catch (err) {
    logger.warn("sisHistory: getSisTrendSummary failed", { message: err.message });
    return _emptyTrend();
  }
}

function _emptyTrend() {
  return {
    current:        null,
    delta24h:       null,
    delta7d:        null,
    delta30d:       null,
    direction:      "stable",
    directionLabel: "Keine Daten",
    topDeclineLayer: null,
    topGainLayer:    null,
    snapshotCount:   0,
    lastUpdated:     null,
  };
}

/* =========================================================
   REGRESSION DETECTION
========================================================= */

/**
 * Returns episodes where SIS dropped by ≥ REGRESSION_THRESHOLD points
 * within the last 30 days.  Each episode has: from, to, delta, at, layer.
 *
 * @returns {Promise<object[]>}
 */
async function detectSisRegression() {
  try {
    // Compare each snapshot to the previous one – look for drops
    const res = await pool.query(`
      SELECT
        sis_score,
        layer_scores,
        created_at,
        LAG(sis_score) OVER (ORDER BY created_at) AS prev_score
      FROM sis_history
      WHERE created_at >= NOW() - INTERVAL '30 days'
      ORDER BY created_at
    `);

    const episodes = [];
    for (const row of res.rows) {
      if (row.prev_score == null) continue;
      const delta = Number(row.sis_score) - Number(row.prev_score);
      if (delta <= -REGRESSION_THRESHOLD) {
        episodes.push({
          from:  Number(row.prev_score),
          to:    Number(row.sis_score),
          delta,
          at:    row.created_at,
          topLayer: _findTopChangedLayer(row.layer_scores, "decline"),
        });
      }
    }
    return episodes;
  } catch (err) {
    logger.warn("sisHistory: detectSisRegression failed", { message: err.message });
    return [];
  }
}

/* =========================================================
   IMPROVEMENT DETECTION
========================================================= */

/**
 * Returns episodes where SIS rose by ≥ IMPROVEMENT_THRESHOLD points
 * within the last 30 days.
 *
 * @returns {Promise<object[]>}
 */
async function detectSisImprovement() {
  try {
    const res = await pool.query(`
      SELECT
        sis_score,
        layer_scores,
        created_at,
        LAG(sis_score) OVER (ORDER BY created_at) AS prev_score
      FROM sis_history
      WHERE created_at >= NOW() - INTERVAL '30 days'
      ORDER BY created_at
    `);

    const episodes = [];
    for (const row of res.rows) {
      if (row.prev_score == null) continue;
      const delta = Number(row.sis_score) - Number(row.prev_score);
      if (delta >= IMPROVEMENT_THRESHOLD) {
        episodes.push({
          from:  Number(row.prev_score),
          to:    Number(row.sis_score),
          delta,
          at:    row.created_at,
          topLayer: _findTopChangedLayer(row.layer_scores, "gain"),
        });
      }
    }
    return episodes;
  } catch (err) {
    logger.warn("sisHistory: detectSisImprovement failed", { message: err.message });
    return [];
  }
}

/* =========================================================
   HELPERS
========================================================= */

/**
 * From a layer_scores JSONB array, return the layer id that most likely
 * caused a decline or gain (highest absolute score value proportional to max).
 */
function _findTopChangedLayer(layerScores, direction) {
  if (!Array.isArray(layerScores) || !layerScores.length) return null;
  // For now: flag the layer with highest/lowest fill ratio
  const sorted = [...layerScores].sort((a, b) => {
    const ratioA = a.max > 0 ? a.score / a.max : 0;
    const ratioB = b.max > 0 ? b.score / b.max : 0;
    return direction === "decline" ? ratioA - ratioB : ratioB - ratioA;
  });
  return sorted[0]?.id ?? null;
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  ensureSisHistoryTable,
  saveSisSnapshot,
  getSisHistory,
  getSisTrendSummary,
  detectSisRegression,
  detectSisImprovement,
};
