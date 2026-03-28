"use strict";

/**
 * Update Feature History Job
 *
 * Computes four core technical indicators for every active US symbol and
 * upserts them into the feature_history table.  Indicators stored per
 * (symbol, price_date):
 *
 *   price          – latest close price, z-scored against the 60-day window
 *   volume         – latest daily volume, z-scored against the 60-day window
 *   volatility     – 14-day Average True Range (ATR), z-scored against the
 *                    window of per-day TR values (fachlich korrekt: echter ATR,
 *                    nicht ein einzelner True Range)
 *   trend_intensity – percentage deviation of close from 20-day SMA,
 *                     z-scored against the rolling series of the same metric
 *
 * Hardening vs. DeepSeek proposal:
 *   – skips symbols with < 20 valid price rows (insufficient history)
 *   – validates close > 0 and volume > 0 before any calculation
 *   – trend_intensity is only computed when close > 0 and SMA > 0
 *   – ATR uses a proper rolling window average (not a single True Range value)
 *   – symbols processed in batches (BATCH_SIZE) with a short pause between
 *     batches to keep DB load predictable
 *   – summarised log output (one line per batch, not per symbol)
 *   – all numeric inputs are validated as finite before use
 *
 * Schedule: deploy as a Railway cron service (e.g. daily, e.g. 0 6 * * *).
 */

require("dotenv").config();

const logger = require("../utils/logger");
const { runJob } = require("../utils/jobRunner");
const { getSharedPool, closeAllPools } = require("../config/database");
const {
  acquireLock,
  releaseLock,
  initJobLocksTable,
} = require("../services/jobLock.repository");
const { savePipelineStage } = require("../services/pipelineStatus.repository");
const {
  initUniverseTables,
  listActiveUniverseSymbols,
} = require("../services/universe.repository");
const {
  initFeatureHistoryTable,
  upsertFeatureHistory,
  computeRobustStats,
} = require("../services/autonomyAudit.repository");
const { getPricesDaily } = require("../services/pricesDaily.repository");

const pool = getSharedPool();

// ── Configuration ────────────────────────────────────────────────────────────
const BATCH_SIZE = 50;       // symbols per DB batch flush
const LOOKBACK_DAYS = 65;    // calendar days of price history to fetch
const MIN_ROWS = 20;         // minimum valid price rows to proceed
const ATR_WINDOW = 14;       // trading days for ATR average
const SMA_WINDOW = 20;       // trading days for trend_intensity SMA baseline
const BATCH_PAUSE_MS = 300;  // ms pause between symbol batches

// ── Math helpers ─────────────────────────────────────────────────────────────

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Compute 14-day ATR (Average True Range) from an ASC-sorted OHLCV array.
 *
 * True Range for day i:
 *   TR[i] = max(high[i] - low[i],
 *               |high[i] - close[i-1]|,
 *               |low[i]  - close[i-1]|)
 *
 * ATR = simple average of TR values over the last `window` trading days.
 * Returns null when there are fewer than `window` valid TR values.
 *
 * @param {Array<{close:string|number, high:string|number, low:string|number}>} pricesAsc
 * @param {number} window
 * @returns {number|null}
 */
function computeATR(pricesAsc, window) {
  const trs = [];

  for (let i = 1; i < pricesAsc.length; i++) {
    const h = safeNum(pricesAsc[i].high);
    const l = safeNum(pricesAsc[i].low);
    const pc = safeNum(pricesAsc[i - 1].close);

    if (h === null || l === null || pc === null) continue;

    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    trs.push(tr);
  }

  if (trs.length < window) return null;

  const slice = trs.slice(-window);
  return slice.reduce((sum, v) => sum + v, 0) / slice.length;
}

/**
 * Compute simple moving average of the last `window` values from an array.
 * Returns null when the array is shorter than `window`.
 *
 * @param {number[]} values
 * @param {number}   window
 * @returns {number|null}
 */
function computeSMA(values, window) {
  if (values.length < window) return null;
  const slice = values.slice(-window);
  return slice.reduce((sum, v) => sum + v, 0) / slice.length;
}

/**
 * Build the rolling trend_intensity series over the entire price window.
 * trend_intensity[i] = (close[i] - SMA20) / SMA20 * 100
 * Only computed for indices where enough preceding rows exist.
 *
 * @param {number[]} closes  ASC-ordered close prices
 * @returns {number[]}
 */
function computeTrendIntensitySeries(closes) {
  const series = [];
  for (let i = SMA_WINDOW - 1; i < closes.length; i++) {
    const sma = closes
      .slice(i - SMA_WINDOW + 1, i + 1)
      .reduce((s, v) => s + v, 0) / SMA_WINDOW;
    if (sma > 0) {
      series.push((closes[i] - sma) / sma * 100);
    }
  }
  return series;
}

/**
 * Process a single symbol: fetch prices, compute indicators, return feature rows.
 *
 * Returns null (skip) when:
 *   – fewer than MIN_ROWS valid price rows
 *   – latest close is missing or ≤ 0
 *
 * @param {string} symbol
 * @returns {Promise<Array<object>|null>}
 */
async function processSymbol(symbol) {
  // getPricesDaily returns rows newest-first; we need ASC for time-series math
  const rawPrices = await getPricesDaily(symbol, LOOKBACK_DAYS);

  if (rawPrices.length < MIN_ROWS) return null;

  const pricesAsc = [...rawPrices].reverse();
  const latest = pricesAsc[pricesAsc.length - 1];

  const latestClose = safeNum(latest.close);
  if (latestClose === null || latestClose <= 0) return null;

  const latestDate = new Date(latest.price_date).toISOString();

  // ── Close prices (valid finite values) ─────────────────────────────────────
  const closes = pricesAsc
    .map((p) => safeNum(p.close))
    .filter((v) => v !== null && v > 0);

  // ── Volumes (valid finite, positive) ───────────────────────────────────────
  const latestVolume = safeNum(latest.volume);
  const volumes = pricesAsc
    .map((p) => safeNum(p.volume))
    .filter((v) => v !== null && v > 0);

  // ── True Range series (needed for ATR stats) ───────────────────────────────
  const trSeries = [];
  for (let i = 1; i < pricesAsc.length; i++) {
    const h = safeNum(pricesAsc[i].high);
    const l = safeNum(pricesAsc[i].low);
    const pc = safeNum(pricesAsc[i - 1].close);
    if (h === null || l === null || pc === null) continue;
    trSeries.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }

  // ── Robust statistics for each indicator dimension ─────────────────────────
  const priceStats = computeRobustStats(closes);

  const volumeStats =
    volumes.length >= MIN_ROWS ? computeRobustStats(volumes) : null;

  const atrValue =
    trSeries.length >= ATR_WINDOW
      ? computeATR(pricesAsc, ATR_WINDOW)
      : null;
  const atrStats =
    trSeries.length >= MIN_ROWS ? computeRobustStats(trSeries) : null;

  const sma20 = computeSMA(closes, SMA_WINDOW);
  const trendIntensity =
    sma20 !== null && sma20 > 0 && latestClose > 0
      ? (latestClose - sma20) / sma20 * 100
      : null;
  const trendSeries = computeTrendIntensitySeries(closes);
  const trendStats =
    trendSeries.length > 0 ? computeRobustStats(trendSeries) : null;

  // ── Assemble feature rows ──────────────────────────────────────────────────
  const features = [];

  // price
  if (priceStats) {
    features.push({
      symbol,
      timestamp: latestDate,
      indicator: "price",
      value: latestClose,
      median: priceStats.median,
      mad: priceStats.mad,
      zscore_robust: priceStats.zScore(latestClose),
    });
  }

  // volume
  if (latestVolume !== null && latestVolume > 0 && volumeStats) {
    features.push({
      symbol,
      timestamp: latestDate,
      indicator: "volume",
      value: latestVolume,
      median: volumeStats.median,
      mad: volumeStats.mad,
      zscore_robust: volumeStats.zScore(latestVolume),
    });
  }

  // volatility (ATR – 14-day Average True Range)
  if (atrValue !== null && atrStats) {
    features.push({
      symbol,
      timestamp: latestDate,
      indicator: "volatility",
      value: atrValue,
      median: atrStats.median,
      mad: atrStats.mad,
      zscore_robust: atrStats.zScore(atrValue),
    });
  }

  // trend_intensity: (close − SMA20) / SMA20 × 100
  if (trendIntensity !== null && trendStats) {
    features.push({
      symbol,
      timestamp: latestDate,
      indicator: "trend_intensity",
      value: trendIntensity,
      median: trendStats.median,
      mad: trendStats.mad,
      zscore_robust: trendStats.zScore(trendIntensity),
    });
  }

  return features.length > 0 ? features : null;
}

// ── Job body ─────────────────────────────────────────────────────────────────

async function run() {
  return runJob(
    "updateFeatureHistory",
    async () => {
      await initJobLocksTable();
      await initUniverseTables();
      await initFeatureHistoryTable();

      const won = await acquireLock("update_feature_history_job", 60 * 60);
      if (!won) {
        logger.warn("[job:updateFeatureHistory] skipped – lock held");
        return { skipped: true, skipReason: "lock_held", processedCount: 0 };
      }

      try {
        // All active US symbols (country filter matches universe.repository convention)
        const symbols = await listActiveUniverseSymbols(5000, { country: "US" });

        logger.info("[job:updateFeatureHistory] starting", {
          totalSymbols: symbols.length,
        });

        let totalUpserted = 0;
        let totalSkipped = 0;
        let totalErrors = 0;
        const pendingFeatures = [];

        for (let i = 0; i < symbols.length; i++) {
          const symbol = symbols[i];

          try {
            const features = await processSymbol(symbol);
            if (!features) {
              totalSkipped++;
            } else {
              pendingFeatures.push(...features);
            }
          } catch (err) {
            totalErrors++;
            logger.warn("[job:updateFeatureHistory] symbol error", {
              symbol,
              message: err.message,
            });
          }

          // Flush a batch when we have BATCH_SIZE symbols worth of features
          const batchDone = (i + 1) % BATCH_SIZE === 0 || i === symbols.length - 1;
          if (batchDone && pendingFeatures.length > 0) {
            const upserted = await upsertFeatureHistory(pendingFeatures);
            totalUpserted += upserted;

            logger.info("[job:updateFeatureHistory] batch flushed", {
              symbolsProcessed: Math.min(i + 1, symbols.length),
              featuresUpserted: upserted,
            });

            pendingFeatures.length = 0;

            // Brief pause between batches to keep DB load predictable
            if (i < symbols.length - 1) {
              await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
            }
          }
        }

        const processedCount = symbols.length - totalSkipped - totalErrors;

        logger.info("[job:updateFeatureHistory] done", {
          totalSymbols: symbols.length,
          processed: processedCount,
          skipped: totalSkipped,
          errors: totalErrors,
          featuresUpserted: totalUpserted,
        });

        await savePipelineStage("update_feature_history", {
          inputCount: symbols.length,
          successCount: processedCount,
          failedCount: totalErrors,
          skippedCount: totalSkipped,
        });

        return { processedCount };
      } finally {
        await releaseLock("update_feature_history_job").catch((err) => {
          logger.warn("[job:updateFeatureHistory] lock release failed", {
            message: err?.message,
          });
        });
      }
    },
    { pool, dbRetries: 3, dbDelayMs: 2000 }
  );
}

// ── Standalone entry point (Railway cron) ────────────────────────────────────
if (require.main === module) {
  run()
    .then(() => {
      closeAllPools().catch(() => {});
      process.exit(0);
    })
    .catch((err) => {
      logger.error("[job:updateFeatureHistory] fatal", {
        message: err?.message || String(err),
        stack: err?.stack,
      });
      closeAllPools().catch(() => {});
      process.exit(1);
    });
}

module.exports = { run };
