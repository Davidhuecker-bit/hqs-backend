"use strict";

/**
 * Update Feature History Job
 *
 * Computes four core technical indicators for every active US symbol and
 * upserts them into the feature_history table. Indicators stored per
 * (symbol, price_date):
 *
 *   price           – latest close price, z-scored against the rolling window
 *   volume          – latest daily volume, z-scored against the rolling window
 *   volatility      – 14-day ATR, z-scored against the rolling TR window
 *   trend_intensity – percentage deviation of close from 20-day SMA,
 *                     z-scored against the rolling trend_intensity series
 *
 * Improvements in this version:
 *   1) limited parallel symbol processing
 *   2) batch loading of price history (with safe fallback)
 *   3) safe robust-stats wrapper (MAD never breaks z-score usage)
 *   4) stricter missing-value handling
 *   5) configurable lock TTL
 *   6) isolated symbol error logging into feature_history_errors
 *   7) feature-based flush threshold instead of only symbol-based batches
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
const pricesDailyRepository = require("../services/pricesDaily.repository");

const pool = getSharedPool();

// ── Configuration (env-first, with safe defaults) ───────────────────────────
const SYMBOL_CHUNK_SIZE =
  Number.parseInt(process.env.FEATURE_HISTORY_SYMBOL_CHUNK_SIZE || "100", 10) || 100;

const SYMBOL_CONCURRENCY =
  Number.parseInt(process.env.FEATURE_HISTORY_SYMBOL_CONCURRENCY || "8", 10) || 8;

const LOOKBACK_DAYS =
  Number.parseInt(process.env.FEATURE_HISTORY_LOOKBACK_DAYS || "65", 10) || 65;

const MIN_ROWS =
  Number.parseInt(process.env.FEATURE_HISTORY_MIN_ROWS || "20", 10) || 20;

const ATR_WINDOW =
  Number.parseInt(process.env.FEATURE_HISTORY_ATR_WINDOW || "14", 10) || 14;

const SMA_WINDOW =
  Number.parseInt(process.env.FEATURE_HISTORY_SMA_WINDOW || "20", 10) || 20;

const MAX_FEATURES_PER_FLUSH =
  Number.parseInt(process.env.FEATURE_HISTORY_MAX_FEATURES_PER_FLUSH || "1000", 10) || 1000;

const BATCH_PAUSE_MS =
  Number.parseInt(process.env.FEATURE_HISTORY_BATCH_PAUSE_MS || "300", 10) || 300;

const LOCK_TTL_SECS =
  Number.parseInt(process.env.FEATURE_HISTORY_LOCK_TTL_SECS || "1800", 10) || 1800; // 30 min

const PRICE_BATCH_LOAD_ENABLED =
  String(process.env.FEATURE_HISTORY_BATCH_LOAD_ENABLED || "true").toLowerCase() !== "false";

// ── Math helpers ─────────────────────────────────────────────────────────────

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeSymbol(value) {
  return String(value || "").trim().toUpperCase();
}

function chunkArray(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Concurrency-limited async mapper.
 *
 * @template T,R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item:T, index:number)=>Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    () => runWorker()
  );

  await Promise.all(workers);
  return results;
}

/**
 * Wrap computeRobustStats so MAD / z-score never become unsafe.
 *
 * @param {number[]} values
 * @returns {{ median:number, mad:number, zScore:(v:number)=>number }|null}
 */
function computeSafeRobustStats(values) {
  const stats = computeRobustStats(values);
  if (!stats) return null;

  const median = safeNum(stats.median);
  const rawMad = safeNum(stats.mad);

  if (median === null || rawMad === null) return null;

  const mad = rawMad > 0 ? rawMad : Number.EPSILON;

  return {
    median,
    mad,
    zScore(value) {
      const n = safeNum(value);
      if (n === null) return 0;

      // Prefer repository zScore if it behaves, otherwise safe manual fallback.
      try {
        const z =
          typeof stats.zScore === "function" ? safeNum(stats.zScore(n)) : null;
        if (z !== null) return z;
      } catch (_) {
        // fall back below
      }

      return (n - median) / mad;
    },
  };
}

/**
 * Compute 14-day ATR (Average True Range) from an ASC-sorted OHLCV array.
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
 * @param {number[]} values
 * @param {number} window
 * @returns {number|null}
 */
function computeSMA(values, window) {
  if (values.length < window) return null;
  const slice = values.slice(-window);
  return slice.reduce((sum, v) => sum + v, 0) / slice.length;
}

/**
 * @param {number[]} closes
 * @returns {number[]}
 */
function computeTrendIntensitySeries(closes) {
  const series = [];
  for (let i = SMA_WINDOW - 1; i < closes.length; i++) {
    const sma =
      closes.slice(i - SMA_WINDOW + 1, i + 1).reduce((s, v) => s + v, 0) /
      SMA_WINDOW;

    if (sma > 0 && Number.isFinite(closes[i])) {
      series.push(((closes[i] - sma) / sma) * 100);
    }
  }
  return series;
}

// ── DB helpers ───────────────────────────────────────────────────────────────

async function ensureFeatureHistoryUniqueIndex() {
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_feature_history_symbol_ts_indicator
    ON feature_history (symbol, timestamp, indicator)
  `);
}

async function initFeatureHistoryErrorsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feature_history_errors (
      id BIGSERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      error_message TEXT NOT NULL,
      logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_feature_history_errors_symbol_logged_at
    ON feature_history_errors (symbol, logged_at DESC)
  `);
}

async function logFeatureHistoryError(symbol, message) {
  try {
    await pool.query(
      `
      INSERT INTO feature_history_errors (symbol, error_message)
      VALUES ($1, $2)
      `,
      [normalizeSymbol(symbol), String(message || "unknown error")]
    );
  } catch (err) {
    logger.warn("[job:updateFeatureHistory] failed to persist feature_history error", {
      symbol,
      message: err?.message,
    });
  }
}

/**
 * Batch-load prices for many symbols from prices_daily.
 * Returns a Map(symbol -> rows ASC by price_date).
 *
 * Falls back to per-symbol repository reads if the direct batch query fails.
 *
 * @param {string[]} symbols
 * @param {number} lookbackDays
 * @returns {Promise<Map<string, Array<object>>>}
 */
async function getPricesDailyBatchSafe(symbols, lookbackDays) {
  const map = new Map();
  const normalized = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))];

  if (!normalized.length) return map;

  if (PRICE_BATCH_LOAD_ENABLED) {
    try {
      const res = await pool.query(
        `
        SELECT
          symbol,
          price_date,
          close,
          high,
          low,
          volume
        FROM prices_daily
        WHERE symbol = ANY($1::text[])
          AND price_date >= CURRENT_DATE - ($2::int)
        ORDER BY symbol ASC, price_date ASC
        `,
        [normalized, lookbackDays]
      );

      for (const row of res.rows || []) {
        const sym = normalizeSymbol(row.symbol);
        if (!map.has(sym)) map.set(sym, []);
        map.get(sym).push(row);
      }

      // ensure all symbols exist in map even when empty
      for (const sym of normalized) {
        if (!map.has(sym)) map.set(sym, []);
      }

      return map;
    } catch (err) {
      logger.warn("[job:updateFeatureHistory] batch price load failed – falling back to per-symbol reads", {
        symbolCount: normalized.length,
        message: err?.message,
      });
    }
  }

  const getPricesDaily = pricesDailyRepository.getPricesDaily;
  for (const sym of normalized) {
    try {
      const rows = await getPricesDaily(sym, lookbackDays);
      map.set(sym, [...rows].reverse()); // normalize to ASC
    } catch (err) {
      logger.warn("[job:updateFeatureHistory] per-symbol price load failed", {
        symbol: sym,
        message: err?.message,
      });
      map.set(sym, []);
    }
  }

  return map;
}

// ── Feature computation ──────────────────────────────────────────────────────

/**
 * Process a single symbol from already loaded price rows (ASC expected).
 *
 * Returns null when the symbol should be skipped.
 *
 * @param {string} symbol
 * @param {Array<object>} pricesAsc
 * @returns {Array<object>|null}
 */
function processSymbolFromPrices(symbol, pricesAsc) {
  if (!Array.isArray(pricesAsc) || pricesAsc.length < MIN_ROWS) return null;

  const latest = pricesAsc[pricesAsc.length - 1];
  if (!latest) return null;

  const latestClose = safeNum(latest.close);
  const latestVolume = safeNum(latest.volume);

  // stricter missing-value handling
  if (latestClose === null || latestClose <= 0) return null;
  if (!latest.price_date) return null;

  const latestDate = new Date(latest.price_date).toISOString();

  const closes = pricesAsc
    .map((p) => safeNum(p.close))
    .filter((v) => v !== null && v > 0);

  if (closes.length < MIN_ROWS) return null;

  const volumes = pricesAsc
    .map((p) => safeNum(p.volume))
    .filter((v) => v !== null && v > 0);

  const trSeries = [];
  for (let i = 1; i < pricesAsc.length; i++) {
    const h = safeNum(pricesAsc[i]?.high);
    const l = safeNum(pricesAsc[i]?.low);
    const pc = safeNum(pricesAsc[i - 1]?.close);

    if (h === null || l === null || pc === null) continue;
    trSeries.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }

  const priceStats = computeSafeRobustStats(closes);
  const volumeStats = volumes.length >= MIN_ROWS ? computeSafeRobustStats(volumes) : null;
  const atrValue = trSeries.length >= ATR_WINDOW ? computeATR(pricesAsc, ATR_WINDOW) : null;
  const atrStats = trSeries.length >= MIN_ROWS ? computeSafeRobustStats(trSeries) : null;

  const sma20 = computeSMA(closes, SMA_WINDOW);
  const trendIntensity =
    sma20 !== null && sma20 > 0 && latestClose > 0
      ? ((latestClose - sma20) / sma20) * 100
      : null;

  const trendSeries = computeTrendIntensitySeries(closes);
  const trendStats = trendSeries.length > 0 ? computeSafeRobustStats(trendSeries) : null;

  const features = [];

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
      await ensureFeatureHistoryUniqueIndex();
      await initFeatureHistoryErrorsTable();

      const won = await acquireLock("update_feature_history_job", LOCK_TTL_SECS);
      if (!won) {
        logger.warn("[job:updateFeatureHistory] skipped – lock held", {
          lockTtlSecs: LOCK_TTL_SECS,
        });
        return { skipped: true, skipReason: "lock_held", processedCount: 0 };
      }

      try {
        const symbols = await listActiveUniverseSymbols(5000, { country: "US" });

        logger.info("[job:updateFeatureHistory] starting", {
          totalSymbols: symbols.length,
          symbolChunkSize: SYMBOL_CHUNK_SIZE,
          symbolConcurrency: SYMBOL_CONCURRENCY,
          lookbackDays: LOOKBACK_DAYS,
          maxFeaturesPerFlush: MAX_FEATURES_PER_FLUSH,
          batchPauseMs: BATCH_PAUSE_MS,
          lockTtlSecs: LOCK_TTL_SECS,
          batchPriceLoadEnabled: PRICE_BATCH_LOAD_ENABLED,
        });

        let totalUpserted = 0;
        let totalSkipped = 0;
        let totalErrors = 0;
        const pendingFeatures = [];

        const symbolChunks = chunkArray(symbols, SYMBOL_CHUNK_SIZE);

        for (let chunkIndex = 0; chunkIndex < symbolChunks.length; chunkIndex++) {
          const symbolChunk = symbolChunks[chunkIndex];
          const pricesBySymbol = await getPricesDailyBatchSafe(symbolChunk, LOOKBACK_DAYS);

          const results = await mapWithConcurrency(
            symbolChunk,
            SYMBOL_CONCURRENCY,
            async (symbol) => {
              try {
                const pricesAsc = pricesBySymbol.get(normalizeSymbol(symbol)) || [];
                const features = processSymbolFromPrices(symbol, pricesAsc);
                return { symbol, features, error: null };
              } catch (err) {
                return { symbol, features: null, error: err };
              }
            }
          );

          for (const result of results) {
            if (result.error) {
              totalErrors++;
              logger.warn("[job:updateFeatureHistory] symbol error", {
                symbol: result.symbol,
                message: result.error?.message,
              });
              await logFeatureHistoryError(result.symbol, result.error?.message || "unknown symbol error");
              continue;
            }

            if (!result.features) {
              totalSkipped++;
              continue;
            }

            pendingFeatures.push(...result.features);

            if (pendingFeatures.length >= MAX_FEATURES_PER_FLUSH) {
              const flushCount = pendingFeatures.length;
              const upserted = await upsertFeatureHistory(pendingFeatures);
              totalUpserted += upserted;

              logger.info("[job:updateFeatureHistory] batch flushed", {
                chunkIndex: chunkIndex + 1,
                totalChunks: symbolChunks.length,
                featuresInFlush: flushCount,
                featuresUpserted: upserted,
                totalFeaturesUpserted: totalUpserted,
              });

              pendingFeatures.length = 0;

              // pause only when something was actually written
              await sleep(BATCH_PAUSE_MS);
            }
          }

          logger.info("[job:updateFeatureHistory] chunk processed", {
            chunkIndex: chunkIndex + 1,
            totalChunks: symbolChunks.length,
            chunkSymbols: symbolChunk.length,
            pendingFeatures: pendingFeatures.length,
            totalUpserted,
            totalSkipped,
            totalErrors,
          });
        }

        if (pendingFeatures.length > 0) {
          const flushCount = pendingFeatures.length;
          const upserted = await upsertFeatureHistory(pendingFeatures);
          totalUpserted += upserted;

          logger.info("[job:updateFeatureHistory] final flush", {
            featuresInFlush: flushCount,
            featuresUpserted: upserted,
            totalFeaturesUpserted: totalUpserted,
          });

          pendingFeatures.length = 0;
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
  let exitCode = 0;

  run()
    .catch((err) => {
      exitCode = 1;
      logger.error("[job:updateFeatureHistory] fatal", {
        message: err?.message || String(err),
        stack: err?.stack,
      });
    })
    .finally(async () => {
      await closeAllPools().catch(() => {});
      process.exit(exitCode);
    });
}

module.exports = { run };
