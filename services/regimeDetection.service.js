"use strict";

/*
  Regime Detection Engine
  Classifies the overall market into three clusters:
    - 'Safe'     : market conditions support high-quality signals
    - 'Volatile' : elevated risk, additional caution required
    - 'Danger'   : conditions are unfavourable; all signals suppressed by Guardian
*/

const logger = require("../utils/logger");

const { getSharedPool } = require("../config/database");
const pool = getSharedPool();
/* =========================================================
   THRESHOLDS
========================================================= */

const SAFE_AVG_HQS_MIN = 55;
const VOLATILE_AVG_HQS_MIN = 38;

const SAFE_BEAR_RATIO_MAX = 0.25;
const VOLATILE_BEAR_RATIO_MAX = 0.50;

const SAFE_HIGH_VOL_RATIO_MAX = 0.20;
const VOLATILE_HIGH_VOL_RATIO_MAX = 0.45;

const HIGH_VOLATILITY_THRESHOLD = 0.60;

/* =========================================================
   UTIL
========================================================= */

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/* =========================================================
   AGGREGATE MARKET METRICS FROM DB
========================================================= */

async function loadMarketMetrics() {
  try {
    const hqsRes = await pool.query(`
      WITH latest_hqs AS (
        SELECT DISTINCT ON (symbol)
          symbol,
          hqs_score,
          regime,
          created_at
        FROM hqs_scores
        ORDER BY symbol, created_at DESC
      )
      SELECT
        COUNT(*)                                                   AS total_symbols,
        AVG(hqs_score)                                             AS avg_hqs,
        SUM(CASE WHEN LOWER(regime) IN ('bear','crash','bearish') THEN 1 ELSE 0 END)
                                                                   AS bear_count
      FROM latest_hqs
    `);

    const volRes = await pool.query(`
      WITH latest_metrics AS (
        SELECT DISTINCT ON (symbol)
          symbol,
          COALESCE(volatility_annual, volatility_daily, 0) AS vol
        FROM market_advanced_metrics
        ORDER BY symbol, updated_at DESC
      )
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN vol >= $1 THEN 1 ELSE 0 END) AS high_vol_count
      FROM latest_metrics
    `, [HIGH_VOLATILITY_THRESHOLD]);

    const hqsRow = hqsRes.rows?.[0] || {};
    const volRow = volRes.rows?.[0] || {};

    const totalSymbols = safeNum(hqsRow.total_symbols, 0);
    const avgHqs = safeNum(hqsRow.avg_hqs, 0);
    const bearCount = safeNum(hqsRow.bear_count, 0);
    const bearRatio = totalSymbols > 0 ? clamp(bearCount / totalSymbols, 0, 1) : 0;

    const totalVol = safeNum(volRow.total, 0);
    const highVolCount = safeNum(volRow.high_vol_count, 0);
    const highVolRatio = totalVol > 0 ? clamp(highVolCount / totalVol, 0, 1) : 0;

    return { totalSymbols, avgHqs, bearRatio, highVolRatio };
  } catch (error) {
    logger.warn("regimeDetection: failed to load market metrics", {
      message: error.message,
    });
    return { totalSymbols: 0, avgHqs: 0, bearRatio: 0, highVolRatio: 0 };
  }
}

/* =========================================================
   CLASSIFY
========================================================= */

/**
 * Classify aggregate market conditions into one of three clusters:
 *   'Safe' | 'Volatile' | 'Danger'
 *
 * Rules (evaluated in order; first match wins):
 *   Danger  : avgHqs < VOLATILE_AVG_HQS_MIN
 *             OR bearRatio > VOLATILE_BEAR_RATIO_MAX
 *             OR highVolRatio > VOLATILE_HIGH_VOL_RATIO_MAX
 *   Volatile: avgHqs < SAFE_AVG_HQS_MIN
 *             OR bearRatio > SAFE_BEAR_RATIO_MAX
 *             OR highVolRatio > SAFE_HIGH_VOL_RATIO_MAX
 *   Safe    : all conditions within safe thresholds
 */
function classifyCluster({ avgHqs, bearRatio, highVolRatio }) {
  if (
    avgHqs < VOLATILE_AVG_HQS_MIN ||
    bearRatio > VOLATILE_BEAR_RATIO_MAX ||
    highVolRatio > VOLATILE_HIGH_VOL_RATIO_MAX
  ) {
    return "Danger";
  }

  if (
    avgHqs < SAFE_AVG_HQS_MIN ||
    bearRatio > SAFE_BEAR_RATIO_MAX ||
    highVolRatio > SAFE_HIGH_VOL_RATIO_MAX
  ) {
    return "Volatile";
  }

  return "Safe";
}

/* =========================================================
   PUBLIC API
========================================================= */

/**
 * Returns the current market-wide regime classification.
 *
 * @returns {Promise<{
 *   cluster: 'Safe' | 'Volatile' | 'Danger',
 *   avgHqs: number,
 *   bearRatio: number,
 *   highVolRatio: number,
 *   totalSymbols: number,
 *   capturedAt: string
 * }>}
 */
async function classifyMarketRegime() {
  const metrics = await loadMarketMetrics();
  const cluster = classifyCluster(metrics);

  const result = {
    cluster,
    avgHqs: Number(metrics.avgHqs.toFixed(2)),
    bearRatio: Number(metrics.bearRatio.toFixed(4)),
    highVolRatio: Number(metrics.highVolRatio.toFixed(4)),
    totalSymbols: metrics.totalSymbols,
    capturedAt: new Date().toISOString(),
  };

  logger.info("regimeDetection: market regime classified", {
    cluster: result.cluster,
    avgHqs: result.avgHqs,
    bearRatio: result.bearRatio,
    highVolRatio: result.highVolRatio,
  });

  return result;
}

module.exports = {
  classifyMarketRegime,
};
