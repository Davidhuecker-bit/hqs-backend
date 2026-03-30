"use strict";

const {
  getPricesDaily,
  upsertPricesDailyBatch,
  getExistingDatesForSymbol,
} = require("./pricesDaily.repository");
const { fetchMassiveHistoricalCandles, fetchGroupedDailyCandles } = require("./providerService");
const { MassiveFlatfileService } = require("./massiveFlatfile.service");
const { Pool } = require("pg");

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

/* ============================================================
   CONFIG
============================================================ */

const MIN_POINTS = parseInt(process.env.HISTORICAL_MIN_POINTS || "30", 10);
const BACKFILL_FETCH_DAYS = parseInt(process.env.HISTORICAL_BACKFILL_DAYS || "730", 10);
const ENABLE_FLATFILE_BACKFILL =
  String(process.env.HISTORICAL_ENABLE_FLATFILE_BACKFILL || "true").toLowerCase() !== "false";
const FLATFILE_MAX_DAYS = parseInt(process.env.HISTORICAL_FLATFILE_MAX_DAYS || "120", 10);
const TRIGGER_FEATURE_UPDATE =
  String(process.env.HISTORICAL_TRIGGER_FEATURE_UPDATE || "false").toLowerCase() === "true";
// Set HISTORICAL_SKIP_REST=true to disable the REST per-symbol fallback entirely.
// Useful when Massive REST is heavily delayed and flatfile/grouped-daily are sufficient.
const SKIP_REST_BACKFILL =
  String(process.env.HISTORICAL_SKIP_REST || "false").toLowerCase() === "true";
// Per-call timeout (ms) for the REST historical candle fetch.
// Prevents a single slow REST response from blocking the entire pipeline.
const REST_BACKFILL_TIMEOUT_MS =
  parseInt(process.env.HISTORICAL_REST_TIMEOUT_MS || "20000", 10);
const DATABASE_URL = process.env.DATABASE_URL;

let pool = null;
if (TRIGGER_FEATURE_UPDATE && DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 2,
  });
}

/* ============================================================
   HELPERS
============================================================ */

function parsePeriodToDays(period) {
  const s = String(period || "1y").toLowerCase().trim();
  const num = parseFloat(s);

  if (s.endsWith("y")) return Math.round((Number.isNaN(num) ? 1 : num) * 365);
  if (s.endsWith("m")) return Math.round((Number.isNaN(num) ? 1 : num) * 30);
  if (s.endsWith("d")) return Number.isNaN(num) ? 365 : Math.round(num);

  return 365;
}

function toIsoDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, safeNum(v, min)));
}

/**
 * Returns true for Saturday (6) and Sunday (0).
 * Stock exchange flatfiles and grouped daily data are only published for
 * trading days; skipping weekends avoids guaranteed "no data" fetches.
 */
function isWeekendDate(isoDate) {
  const day = new Date(`${isoDate}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

function buildDateRangeFromDays(days) {
  const safeDays = clamp(days, 1, 3650);
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);

  const dates = [];
  for (let i = safeDays - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(end.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  return dates;
}

function hasExistingDatesHelper() {
  return typeof getExistingDatesForSymbol === "function";
}

async function getMissingDatesForSymbol(symbol, dates) {
  if (!hasExistingDatesHelper()) {
    return dates;
  }

  const existing = await getExistingDatesForSymbol(symbol, dates);
  const existingSet = new Set(
    (existing || []).map((d) => toIsoDate(d)).filter(Boolean)
  );

  return dates.filter((d) => !existingSet.has(d));
}

/* ============================================================
   FLATFILE BACKFILL
============================================================ */

async function tryFlatfileBackfillBulk(symbol, days) {
  if (!ENABLE_FLATFILE_BACKFILL) return 0;

  const sym = String(symbol || "").toUpperCase();
  const targetDays = clamp(days, 1, FLATFILE_MAX_DAYS);
  const neededDates = buildDateRangeFromDays(targetDays);

  if (!neededDates.length) return 0;

  let missingDates = [];
  try {
    missingDates = await getMissingDatesForSymbol(sym, neededDates);
  } catch (err) {
    if (logger?.warn) {
      logger.warn("[historicalService] failed to resolve missing dates, fallback to full date range", {
        symbol: sym,
        message: err.message,
      });
    }
    missingDates = neededDates;
  }

  if (!missingDates.length) return 0;

  let service;
  try {
    service = new MassiveFlatfileService();
  } catch (err) {
    if (logger?.warn) {
      logger.warn("[historicalService] flatfile service init failed", {
        symbol: sym,
        message: err.message,
      });
    }
    return 0;
  }

  let totalUpserted = 0;
  const pLimit = require("p-limit").default;
  const limit = pLimit(5);

  const tasks = missingDates.map((date) =>
    limit(async () => {
      try {
        const rows = await service.loadDailyAggregatesForSymbols({
          date,
          symbols: [sym],
          useCache: true,
        });

        if (!rows.length) return 0;

        const candles = rows
          .map((r) => ({
            date: r.date,
            open: r.open,
            high: r.high,
            low: r.low,
            close: r.close,
            volume: r.volume,
            transactions: r.transactions,
            source: r.source || "massive_flatfiles",
          }))
          .filter((c) => c.date && c.close != null);

        if (!candles.length) return 0;

        await upsertPricesDailyBatch(sym, candles);
        return candles.length;
      } catch (err) {
        if (logger?.warn) {
          logger.warn("[historicalService] flatfile day backfill failed", {
            symbol: sym,
            date,
            message: err.message,
          });
        }
        return 0;
      }
    })
  );

  const results = await Promise.allSettled(tasks);
  for (const res of results) {
    if (res.status === "fulfilled") {
      totalUpserted += safeNum(res.value, 0);
    }
  }

  if (totalUpserted > 0 && logger?.info) {
    logger.info("[historicalService] flatfile backfill complete", {
      symbol: sym,
      rowsUpserted: totalUpserted,
      source: "massive_flatfiles",
    });
  }

  return totalUpserted;
}

/* ============================================================
   GROUPED DAILY BACKFILL (recent trading days, broad coverage)
============================================================ */

const GROUPED_DAILY_MAX_DAYS = parseInt(process.env.HISTORICAL_GROUPED_DAILY_MAX_DAYS || "30", 10);
const ENABLE_GROUPED_DAILY_BACKFILL =
  String(process.env.HISTORICAL_ENABLE_GROUPED_DAILY_BACKFILL || "true").toLowerCase() !== "false";

async function tryGroupedDailyBackfill(symbol, days) {
  if (!ENABLE_GROUPED_DAILY_BACKFILL) return 0;

  const sym = String(symbol || "").toUpperCase();
  const targetDays = clamp(days, 1, GROUPED_DAILY_MAX_DAYS);
  const neededDates = buildDateRangeFromDays(targetDays).filter(
    (d) => !isWeekendDate(d)
  );

  if (!neededDates.length) return 0;

  let missingDates = [];
  try {
    missingDates = await getMissingDatesForSymbol(sym, neededDates);
  } catch (_) {
    missingDates = neededDates;
  }

  if (!missingDates.length) return 0;

  let totalUpserted = 0;

  for (const date of missingDates) {
    try {
      const allRows = await fetchGroupedDailyCandles(date);
      const rows = allRows.filter((r) => r.symbol === sym);

      if (!rows.length) continue;

      const candles = rows
        .map((r) => ({
          date: r.date,
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          volume: r.volume,
          transactions: r.transactions,
          source: r.source || "MASSIVE_GROUPED",
        }))
        .filter((c) => c.date && c.close != null);

      if (!candles.length) continue;

      await upsertPricesDailyBatch(sym, candles);
      totalUpserted += candles.length;
    } catch (err) {
      if (logger?.warn) {
        logger.warn("[historicalService] grouped daily backfill day failed", {
          symbol: sym,
          date,
          message: err.message,
        });
      }
    }
  }

  if (totalUpserted > 0 && logger?.info) {
    logger.info("[historicalService] grouped daily backfill complete", {
      symbol: sym,
      rowsUpserted: totalUpserted,
      source: "massive_grouped",
    });
  }

  return totalUpserted;
}

/* ============================================================
   REST BACKFILL FALLBACK
============================================================ */

/**
 * Wraps a promise with a hard timeout so a slow REST response cannot block
 * the pipeline indefinitely.
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[historicalService] timeout: ${label} exceeded ${ms}ms`)),
      ms
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err)   => { clearTimeout(timer); reject(err); }
    );
  });
}

async function tryRestBackfill(symbol) {
  if (SKIP_REST_BACKFILL) {
    if (logger?.info) {
      logger.info("[historicalService] REST backfill skipped (HISTORICAL_SKIP_REST=true)", {
        symbol,
      });
    }
    return 0;
  }

  const sym = String(symbol || "").toUpperCase();
  const today = new Date();
  const toDate = toIsoDate(today);
  const fromDate = toIsoDate(
    new Date(today.getTime() - BACKFILL_FETCH_DAYS * 86400000)
  );

  if (logger?.info) {
    logger.info("[historicalService] REST backfill attempt (last resort – DB + flatfile insufficient)", {
      symbol: sym,
      fromDate,
      toDate,
      timeoutMs: REST_BACKFILL_TIMEOUT_MS,
    });
  }

  try {
    const candles = await withTimeout(
      fetchMassiveHistoricalCandles(sym, fromDate, toDate),
      REST_BACKFILL_TIMEOUT_MS,
      `REST backfill for ${sym}`
    );

    if (!candles || !candles.length) {
      return 0;
    }

    await upsertPricesDailyBatch(sym, candles);

    if (logger?.info) {
      logger.info("[historicalService] REST backfill complete", {
        symbol: sym,
        candlesFetched: candles.length,
        source: "massive_rest",
      });
    }

    return candles.length;
  } catch (err) {
    const isTimeout = err.message && err.message.includes("timeout:");
    if (logger?.warn) {
      logger.warn(
        isTimeout
          ? "[historicalService] REST backfill timed out – degrading gracefully, pipeline continues"
          : "[historicalService] REST backfill failed – degrading gracefully",
        {
          symbol: sym,
          message: err.message,
          degraded: true,
        }
      );
    }
    return 0;
  }
}

/* ============================================================
   BACKFILL LOCK
============================================================ */

const backfillLocks = new Map();

async function withBackfillLock(symbol, fn) {
  const sym = String(symbol || "").toUpperCase();

  if (backfillLocks.has(sym)) {
    if (logger?.debug) {
      logger.debug("[historicalService] backfill already running, waiting", {
        symbol: sym,
      });
    }
    return backfillLocks.get(sym);
  }

  const promise = Promise.resolve()
    .then(fn)
    .finally(() => {
      backfillLocks.delete(sym);
    });

  backfillLocks.set(sym, promise);
  return promise;
}

/* ============================================================
   OPTIONAL FEATURE UPDATE TRIGGER
============================================================ */

async function triggerFeatureUpdate(symbol) {
  if (!TRIGGER_FEATURE_UPDATE || !pool) return;

  try {
    await pool.query(
      `
      INSERT INTO pipeline_status (job_name, status, meta, updated_at)
      VALUES ('feature_history_update', 'pending', jsonb_build_object('symbol', $1), NOW())
      ON CONFLICT (job_name)
      DO UPDATE SET
        status = 'pending',
        updated_at = NOW(),
        meta = EXCLUDED.meta
      `,
      [symbol]
    );

    if (logger?.info) {
      logger.info("[historicalService] triggered feature_history_update", {
        symbol,
      });
    }
  } catch (err) {
    if (logger?.warn) {
      logger.warn("[historicalService] failed to trigger feature update", {
        symbol,
        message: err.message,
      });
    }
  }
}

/* ============================================================
   MAIN PUBLIC API
============================================================ */

async function getHistoricalPrices(symbol, period) {
  const sym = String(symbol || "").toUpperCase();
  const days = parsePeriodToDays(period);

  try {
    let rows = await getPricesDaily(sym, days);

    if (rows.length >= MIN_POINTS) {
      if (logger?.info) {
        logger.info("[historicalService] prices served from DB", {
          symbol: sym,
          rows: rows.length,
          source: "prices_daily",
        });
      }
      return rows.map((r) => ({ close: r.close }));
    }

    if (logger?.info) {
      logger.info("[historicalService] DB insufficient – starting backfill", {
        symbol: sym,
        dbRows: rows.length,
        minRequired: MIN_POINTS,
        requestedDays: days,
      });
    }

    const backfilledCount = await withBackfillLock(sym, async () => {
      let total = 0;

      // Step 1: Flatfile bulk for larger gaps / older history
      if (ENABLE_FLATFILE_BACKFILL) {
        total += await tryFlatfileBackfillBulk(sym, days);
      }

      rows = await getPricesDaily(sym, days);
      if (rows.length >= MIN_POINTS) {
        if (logger?.info) {
          logger.info("[historicalService] prices sufficient after flatfile backfill", {
            symbol: sym,
            rows: rows.length,
            source: "flatfile",
          });
        }
        return total;
      }

      // Step 2: Grouped daily for recent trading days
      total += await tryGroupedDailyBackfill(sym, Math.min(days, GROUPED_DAILY_MAX_DAYS));

      rows = await getPricesDaily(sym, days);
      if (rows.length >= MIN_POINTS) {
        if (logger?.info) {
          logger.info("[historicalService] prices sufficient after grouped-daily backfill", {
            symbol: sym,
            rows: rows.length,
            source: "grouped_daily",
          });
        }
        return total;
      }

      // Step 3: REST per-symbol fallback (last resort)
      total += await tryRestBackfill(sym);

      rows = await getPricesDaily(sym, days);
      return total;
    });

    if (backfilledCount > 0) {
      await triggerFeatureUpdate(sym);
    }

    if (rows.length < MIN_POINTS && logger?.warn) {
      logger.warn("[historicalService] all backfill sources exhausted – returning partial data", {
        symbol: sym,
        rows: rows.length,
        minRequired: MIN_POINTS,
      });
    }

    return rows.map((r) => ({ close: r.close }));
  } catch (err) {
    if (logger?.warn) {
      logger.warn("[historicalService] failed", {
        symbol: sym,
        message: err.message,
      });
    }
    return [];
  }
}

module.exports = {
  getHistoricalPrices,
  parsePeriodToDays,
};
