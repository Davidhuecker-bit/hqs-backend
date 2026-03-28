"use strict";

/**
 * Generate Labels Job
 *
 * Reads evaluated (or sufficiently old) signals from outcome_tracking and
 * writes supervised training labels into the discovery_labels table.
 *
 * For each qualifying signal the job:
 *   1. Determines the canonical entry price (entry_price from outcome_tracking;
 *      falls back to the first available close on or after signal_time only when
 *      entry_price is absent or zero).
 *   2. Fetches actual OHLCV prices for the 30 calendar days following the
 *      signal date – anchored to signal_time, NOT to today.
 *   3. Computes:
 *        forward_return_5d   – return at the 5th available trading day
 *        forward_return_20d  – return at the 20th available trading day
 *        max_drawdown_20d    – maximum close-based drawdown over those 20 days
 *   4. Assigns success_label:
 *        TRUE  when forward_return_20d > +2 %  AND  max_drawdown_20d > −5 %
 *        FALSE otherwise (including when either metric is unavailable)
 *
 * Hardening vs. DeepSeek proposal:
 *   – forward price window is anchored to signal_time (not to CURRENT_DATE)
 *     so historical signals are labelled correctly
 *   – entry_price from outcome_tracking is the canonical basis; first-close
 *     fallback is only used when the stored price is zero/null
 *   – ON CONFLICT (symbol, signal_time) requires – and uses – the unique index
 *     idx_discovery_labels_uniq_symbol_signal added in initDiscoveryLabelsTable
 *   – signals are only processed when the full 20-day window is available
 *     (signal must be at least FORWARD_CALENDAR_DAYS old)
 *   – success_label is clearly documented below; NULL when data is insufficient
 *   – batch processing with a brief pause between batches
 *   – summary-level logging only; no per-symbol log flood
 *
 * Schedule: deploy as a Railway cron service (e.g. daily, e.g. 0 7 * * *).
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
  initDiscoveryLabelsTable,
} = require("../services/autonomyAudit.repository");
const { initOutcomeTrackingTable } = require("../services/outcomeTracking.repository");
const {
  getPricesDailyInRange,
} = require("../services/pricesDaily.repository");

const pool = getSharedPool();

// ── Configuration ─────────────────────────────────────────────────────────────
const BATCH_SIZE = 50;
// 20 trading days ≈ 28 calendar days; use 30 to be safe across holidays/weekends
const FORWARD_CALENDAR_DAYS = 30;
// Extra calendar buffer when fetching forward prices (weekends, holidays)
const FETCH_CALENDAR_BUFFER = 35;
// Minimum trading-day rows required for a 20-day return to be computable
const MIN_TRADING_DAYS_20D = 20;
const MIN_TRADING_DAYS_5D = 5;
const BATCH_PAUSE_MS = 300;

// ── Success label thresholds ──────────────────────────────────────────────────
// success_label = TRUE  iff
//   forward_return_20d  > SUCCESS_RETURN_THRESHOLD   (+2 %)
//   AND
//   max_drawdown_20d    > SUCCESS_DRAWDOWN_THRESHOLD (−5 %)
const SUCCESS_RETURN_THRESHOLD   =  0.02;   // +2 %
const SUCCESS_DRAWDOWN_THRESHOLD = -0.05;   // −5 %

// ── Math helpers ──────────────────────────────────────────────────────────────

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Add `days` calendar days to a Date, returning a new Date.
 */
function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// ── Forward metrics computation ───────────────────────────────────────────────

/**
 * Compute forward return and drawdown metrics anchored to `entryPrice`.
 *
 * Prices must be sorted ASC by price_date and represent the trading days
 * immediately following (and including) the signal date.
 *
 * @param {number} entryPrice  canonical entry price (> 0)
 * @param {Array<{close:string|number}>} prices  ASC-sorted forward prices
 * @returns {{
 *   forward_return_5d:  number|null,
 *   forward_return_20d: number|null,
 *   max_drawdown_20d:   number|null,
 *   success_label:      boolean|null
 * }}
 */
function computeForwardMetrics(entryPrice, prices) {
  const result = {
    forward_return_5d: null,
    forward_return_20d: null,
    max_drawdown_20d: null,
    success_label: null,
  };

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return result;

  // 5-day return: close of the 5th available trading day (0-indexed: [4])
  if (prices.length >= MIN_TRADING_DAYS_5D) {
    const close5 = safeNum(prices[MIN_TRADING_DAYS_5D - 1].close);
    if (close5 !== null && close5 > 0) {
      result.forward_return_5d = (close5 - entryPrice) / entryPrice;
    }
  }

  // 20-day return and max drawdown require the full window
  if (prices.length >= MIN_TRADING_DAYS_20D) {
    const slice20 = prices.slice(0, MIN_TRADING_DAYS_20D);

    const close20 = safeNum(slice20[MIN_TRADING_DAYS_20D - 1].close);
    if (close20 !== null && close20 > 0) {
      result.forward_return_20d = (close20 - entryPrice) / entryPrice;
    }

    // Max drawdown: worst (most negative) close-based return over the 20 days
    let worstReturn = 0;
    for (const row of slice20) {
      const c = safeNum(row.close);
      if (c === null || c <= 0) continue;
      const ret = (c - entryPrice) / entryPrice;
      if (ret < worstReturn) worstReturn = ret;
    }
    result.max_drawdown_20d = worstReturn;

    // success_label is only assigned when both 20-day metrics are available
    if (result.forward_return_20d !== null && result.max_drawdown_20d !== null) {
      result.success_label =
        result.forward_return_20d > SUCCESS_RETURN_THRESHOLD &&
        result.max_drawdown_20d  > SUCCESS_DRAWDOWN_THRESHOLD;
    }
  }

  return result;
}

// ── Signal query ──────────────────────────────────────────────────────────────

/**
 * Fetch outcome_tracking rows that are ready for labelling:
 *   – predicted_at is at least FORWARD_CALENDAR_DAYS old (full 20d window)
 *   – entry_price >= 0 (we accept 0 and handle it via first-close fallback)
 *   – not already present in discovery_labels for (symbol, predicted_at)
 *
 * @param {number} limit
 * @returns {Promise<Array<object>>}
 */
async function getUnlabeledSignals(limit) {
  const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : BATCH_SIZE, 1), 500);

  const res = await pool.query(
    `
    SELECT
      ot.id,
      ot.symbol,
      ot.predicted_at         AS signal_time,
      ot.entry_price,
      ot.regime               AS regime_context,
      ot.prediction_type      AS pattern_type,
      ot.hqs_score            AS discovery_score
    FROM outcome_tracking ot
    WHERE ot.predicted_at <= NOW() - ($1 || ' days')::interval
      AND ot.entry_price IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM discovery_labels dl
        WHERE dl.symbol      = ot.symbol
          AND dl.signal_time = ot.predicted_at
      )
    ORDER BY ot.predicted_at ASC
    LIMIT $2
    `,
    [String(FORWARD_CALENDAR_DAYS), safeLimit]
  );

  return res.rows || [];
}

// ── Per-signal processing ─────────────────────────────────────────────────────

/**
 * Resolve the canonical entry price for a signal row.
 *
 * Canonical order:
 *   1. entry_price from outcome_tracking (if finite and > 0)
 *   2. First available close price on or after signal_time (fallback)
 *
 * Returns null when no valid price can be determined.
 *
 * @param {object} signal   row from outcome_tracking
 * @param {Array}  prices   ASC-sorted forward prices already fetched
 * @returns {number|null}
 */
function resolveEntryPrice(signal, prices) {
  const stored = safeNum(signal.entry_price);
  if (stored !== null && stored > 0) return stored;

  // Fallback: first available close after signal_time
  if (prices.length > 0) {
    const firstClose = safeNum(prices[0].close);
    if (firstClose !== null && firstClose > 0) return firstClose;
  }

  return null;
}

/**
 * Label a single signal and upsert into discovery_labels.
 *
 * @param {object} signal
 * @returns {Promise<boolean>} true if a row was upserted, false if skipped
 */
async function labelSignal(signal) {
  const symbol     = String(signal.symbol || "").toUpperCase();
  const signalTime = new Date(signal.signal_time);

  if (!symbol || !Number.isFinite(signalTime.getTime())) return false;

  const fromDate = signalTime;
  const toDate   = addDays(signalTime, FETCH_CALENDAR_BUFFER);

  const prices = await getPricesDailyInRange(
    symbol,
    fromDate,
    toDate,
    MIN_TRADING_DAYS_20D + 5  // fetch a few extra in case some days are missing
  );

  if (prices.length < MIN_TRADING_DAYS_5D) return false; // not enough data yet

  const entryPrice = resolveEntryPrice(signal, prices);
  if (entryPrice === null) return false;

  const metrics = computeForwardMetrics(entryPrice, prices);

  const patternType    = signal.pattern_type    || null;
  const regimeContext  = signal.regime_context  || null;
  const discoveryScore = safeNum(signal.discovery_score);

  await pool.query(
    `
    INSERT INTO discovery_labels
      (symbol, signal_time, pattern_type,
       forward_return_5d, forward_return_20d, max_drawdown_20d,
       success_label, regime_context, discovery_score, label_version, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, NOW())
    ON CONFLICT (symbol, signal_time) DO UPDATE SET
      forward_return_5d  = EXCLUDED.forward_return_5d,
      forward_return_20d = EXCLUDED.forward_return_20d,
      max_drawdown_20d   = EXCLUDED.max_drawdown_20d,
      success_label      = EXCLUDED.success_label,
      regime_context     = EXCLUDED.regime_context,
      discovery_score    = EXCLUDED.discovery_score,
      label_version      = discovery_labels.label_version + 1
    `,
    [
      symbol,
      signalTime.toISOString(),
      patternType,
      metrics.forward_return_5d,
      metrics.forward_return_20d,
      metrics.max_drawdown_20d,
      metrics.success_label,
      regimeContext,
      discoveryScore,
    ]
  );

  return true;
}

// ── Job body ──────────────────────────────────────────────────────────────────

async function run() {
  return runJob(
    "generateLabels",
    async () => {
      await initJobLocksTable();
      await initOutcomeTrackingTable();
      await initDiscoveryLabelsTable();

      const won = await acquireLock("generate_labels_job", 60 * 60);
      if (!won) {
        logger.warn("[job:generateLabels] skipped – lock held");
        return { skipped: true, skipReason: "lock_held", processedCount: 0 };
      }

      try {
        // Fetch in pages of BATCH_SIZE until no signals remain
        let totalLabelled = 0;
        let totalSkipped = 0;
        let totalErrors = 0;
        let pageIndex = 0;

        // Safety cap: process at most 2 000 signals per run to stay predictable
        const MAX_SIGNALS_PER_RUN = 2000;

        while (totalLabelled + totalSkipped + totalErrors < MAX_SIGNALS_PER_RUN) {
          const signals = await getUnlabeledSignals(BATCH_SIZE);
          if (signals.length === 0) break;

          for (const signal of signals) {
            try {
              const ok = await labelSignal(signal);
              if (ok) totalLabelled++;
              else totalSkipped++;
            } catch (err) {
              totalErrors++;
              logger.warn("[job:generateLabels] signal error", {
                symbol: signal.symbol,
                signalTime: signal.signal_time,
                message: err.message,
              });
            }
          }

          pageIndex++;
          logger.info("[job:generateLabels] batch done", {
            page: pageIndex,
            labelled: totalLabelled,
            skipped: totalSkipped,
            errors: totalErrors,
          });

          if (signals.length < BATCH_SIZE) break; // last page

          await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
        }

        logger.info("[job:generateLabels] done", {
          labelled: totalLabelled,
          skipped: totalSkipped,
          errors: totalErrors,
        });

        await savePipelineStage("generate_labels", {
          inputCount: totalLabelled + totalSkipped + totalErrors,
          successCount: totalLabelled,
          failedCount: totalErrors,
          skippedCount: totalSkipped,
        });

        return { processedCount: totalLabelled };
      } finally {
        await releaseLock("generate_labels_job").catch((err) => {
          logger.warn("[job:generateLabels] lock release failed", {
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
      logger.error("[job:generateLabels] fatal", {
        message: err?.message || String(err),
        stack: err?.stack,
      });
      closeAllPools().catch(() => {});
      process.exit(1);
    });
}

module.exports = { run };
