"use strict";

const { Pool } = require("pg");
const pLimit = require("p-limit").default;
const pRetry = require("p-retry").default;
const logger = require("../utils/logger");
const { MassiveFlatfileService } = require("../services/massiveFlatfile.service");
const { fetchMassiveGroupedDailyCandles } = require("../services/providerService");

/* ============================================================
   HELPERS
============================================================ */

function env(name, fallback = "") {
  const value = process.env[name];
  return value == null || value === "" ? fallback : value;
}

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, safeNum(v, min)));
}

function toIsoDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function isWeekendDate(isoDate) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

function buildDateRange({ dateFrom, dateTo, daysBack }) {
  if (dateFrom && dateTo) {
    const start = new Date(dateFrom);
    const end = new Date(dateTo);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new Error("Invalid FLATFILE_BACKFILL_DATE_FROM / FLATFILE_BACKFILL_DATE_TO");
    }

    if (start > end) {
      throw new Error("FLATFILE_BACKFILL_DATE_FROM must be <= FLATFILE_BACKFILL_DATE_TO");
    }

    const dates = [];
    const current = new Date(start);

    while (current <= end) {
      const iso = current.toISOString().slice(0, 10);
      if (!isWeekendDate(iso)) dates.push(iso);
      current.setUTCDate(current.getUTCDate() + 1);
    }

    return dates;
  }

  const back = clamp(daysBack, 1, 3650);
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);

  const dates = [];
  for (let i = back - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(end.getUTCDate() - i);
    const iso = d.toISOString().slice(0, 10);
    if (!isWeekendDate(iso)) dates.push(iso);
  }

  return dates;
}

function shouldEnableJobMetrics() {
  return String(env("FLATFILE_BACKFILL_ENABLE_JOB_METRICS", "false")).toLowerCase() === "true";
}

function shouldTriggerFeatureUpdate() {
  return String(env("FLATFILE_BACKFILL_TRIGGER_FEATURE_UPDATE", "false")).toLowerCase() === "true";
}

function shouldUseRestFallback() {
  return String(env("FLATFILE_BACKFILL_REST_FALLBACK", "true")).toLowerCase() === "true";
}

/* ============================================================
   DB SETUP
============================================================ */

async function ensurePricesDailyTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prices_daily (
      id BIGSERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      price_date DATE NOT NULL,
      open NUMERIC,
      high NUMERIC,
      low NUMERIC,
      close NUMERIC,
      volume BIGINT,
      transactions BIGINT,
      source TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(symbol, price_date)
    );
  `);

  // Migration: rename legacy "date" column -> "price_date"
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'prices_daily'
          AND column_name = 'date'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'prices_daily'
          AND column_name = 'price_date'
      ) THEN
        ALTER TABLE prices_daily RENAME COLUMN "date" TO price_date;
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_prices_daily_symbol_date
    ON prices_daily(symbol, price_date DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_prices_daily_date
    ON prices_daily(price_date DESC);
  `);

  logger.info("[historicalFlatfileBackfill] prices_daily ensured");
}

async function ensureJobMetricsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_metrics (
      id BIGSERIAL PRIMARY KEY,
      job_name TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      status TEXT,
      rows_loaded INT,
      rows_written INT,
      duration_ms INT,
      error TEXT,
      meta JSONB
    );
  `);
}

/* ============================================================
   SYMBOL LOADING
============================================================ */

async function loadTargetSymbols(pool, limit, filters = {}) {
  const safeLimit = clamp(limit, 1, 10000);
  const countryFilter = String(filters.country || "US").toUpperCase();

  try {
    const res = await pool.query(
      `
      SELECT symbol
      FROM universe_symbols
      WHERE is_active = true
        AND UPPER(COALESCE(country, 'US')) = $1
      ORDER BY priority ASC NULLS LAST, symbol ASC
      LIMIT $2
      `,
      [countryFilter, safeLimit]
    );

    const symbols = res.rows
      .map((r) => String(r.symbol || "").trim().toUpperCase())
      .filter(Boolean);

    if (symbols.length) {
      logger.info("[historicalFlatfileBackfill] loaded symbols from universe_symbols", {
        count: symbols.length,
      });
      return symbols;
    }
  } catch (err) {
    logger.warn("[historicalFlatfileBackfill] universe_symbols load failed – returning empty symbol list", {
      message: err.message,
    });
  }

  logger.warn("[historicalFlatfileBackfill] no symbols found in universe_symbols – skipping");
  return [];
}

/* ============================================================
   INCREMENTAL CHECK
============================================================ */

async function getMissingPairs(pool, symbols, dates) {
  if (!symbols.length || !dates.length) return [];

  const dateValues = dates.map((d) => toIsoDate(d)).filter(Boolean);
  if (!dateValues.length) return [];

  const existing = await pool.query(
    `
    SELECT symbol, price_date::date AS date
    FROM prices_daily
    WHERE symbol = ANY($1::text[])
      AND price_date = ANY($2::date[])
    `,
    [symbols, dateValues]
  );

  const existingSet = new Set(
    existing.rows.map((r) => `${String(r.symbol).toUpperCase()}|${toIsoDate(r.date)}`)
  );

  const missing = [];
  for (const symbol of symbols) {
    const sym = String(symbol || "").trim().toUpperCase();
    if (!sym) continue;

    for (const date of dateValues) {
      if (!existingSet.has(`${sym}|${date}`)) {
        missing.push({ symbol: sym, date });
      }
    }
  }

  return missing;
}

/* ============================================================
   UPSERT
============================================================ */

async function upsertDailyRowsBatch(pool, rows, batchSize = 500) {
  if (!Array.isArray(rows) || !rows.length) return 0;

  const safeBatchSize = clamp(batchSize, 50, 5000);
  const client = await pool.connect();
  let written = 0;

  try {
    await client.query("BEGIN");

    for (let i = 0; i < rows.length; i += safeBatchSize) {
      const batch = rows.slice(i, i + safeBatchSize);
      const placeholders = [];
      const values = [];

      batch.forEach((row, idx) => {
        const base = idx * 9;
        placeholders.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`
        );

        values.push(
          row.symbol,
          row.date,
          row.open,
          row.high,
          row.low,
          row.close,
          row.volume,
          row.transactions,
          row.source || "massive_flatfiles"
        );
      });

      const sql = `
        INSERT INTO prices_daily
          (symbol, price_date, open, high, low, close, volume, transactions, source)
        VALUES ${placeholders.join(", ")}
        ON CONFLICT (symbol, price_date) DO UPDATE SET
          open         = EXCLUDED.open,
          high         = EXCLUDED.high,
          low          = EXCLUDED.low,
          close        = EXCLUDED.close,
          volume       = EXCLUDED.volume,
          transactions = EXCLUDED.transactions,
          source       = EXCLUDED.source,
          updated_at   = NOW()
      `;

      await client.query(sql, values);
      written += batch.length;
    }

    await client.query("COMMIT");
    return written;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/* ============================================================
   JOB METRICS
============================================================ */

async function recordJobMetrics(pool, jobName, startedAt, result) {
  if (!shouldEnableJobMetrics()) return;

  const finishedAt = new Date();
  const durationMs = finishedAt - startedAt;
  const status = result.error ? "failed" : "success";

  await pool.query(
    `
    INSERT INTO job_metrics
      (job_name, started_at, finished_at, status, rows_loaded, rows_written, duration_ms, error, meta)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
    `,
    [
      jobName,
      startedAt,
      finishedAt,
      status,
      result.rowsLoaded || 0,
      result.rowsWritten || 0,
      durationMs,
      result.error || null,
      JSON.stringify(result.meta || {}),
    ]
  );
}

/* ============================================================
   OPTIONAL PIPELINE TRIGGER
============================================================ */

async function triggerFeatureUpdate(pool) {
  if (!shouldTriggerFeatureUpdate()) return;

  try {
    await pool.query(
      `
      INSERT INTO pipeline_status (job_name, status, updated_at)
      VALUES ('feature_history_update', 'pending', NOW())
      ON CONFLICT (job_name)
      DO UPDATE SET status = 'pending', updated_at = NOW()
      `
    );

    logger.info("[historicalFlatfileBackfill] triggered feature_history_update");
  } catch (err) {
    logger.warn("[historicalFlatfileBackfill] feature update trigger skipped", {
      message: err.message,
    });
  }
}

/* ============================================================
   PER-DAY PROCESSING
============================================================ */

async function processDay({ date, missingPairs, massiveService, pool, chunkSize, useCache, dataset }) {
  const start = Date.now();
  const symbolsForDay = [...new Set(missingPairs.map((p) => p.symbol))];

  logger.info("[historicalFlatfileBackfill] processing date", {
    date,
    symbolsRequested: symbolsForDay.length,
  });

  const loadedRows = await massiveService.loadDailyAggregatesForSymbolChunks({
    date,
    symbols: symbolsForDay,
    chunkSize,
    useCache,
    dataset,
  });

  const missingSet = new Set(missingPairs.map((p) => `${p.symbol}|${p.date}`));
  let filteredRows = loadedRows.filter((row) => missingSet.has(`${row.symbol}|${row.date}`));

  // When the flatfile for this date is unavailable (NoSuchKey / holiday / not yet
  // published), fall back to the Massive grouped-daily REST endpoint so that very
  // recent trading days are still filled in.
  if (!filteredRows.length && shouldUseRestFallback()) {
    try {
      const groupedRows = await fetchMassiveGroupedDailyCandles(date);
      const symbolSet = new Set(symbolsForDay);
      filteredRows = groupedRows.filter((r) => symbolSet.has(r.symbol));

      if (filteredRows.length) {
        logger.info("[historicalFlatfileBackfill] grouped-daily fallback supplied rows", {
          date,
          rows: filteredRows.length,
        });
      }
    } catch (err) {
      logger.warn("[historicalFlatfileBackfill] grouped-daily fallback failed – skipping date", {
        date,
        message: err.message,
      });
    }
  }

  if (!filteredRows.length) {
    return {
      date,
      success: true,
      rowsLoaded: 0,
      rowsWritten: 0,
      durationMs: Date.now() - start,
    };
  }

  const rowsWritten = await upsertDailyRowsBatch(pool, filteredRows, 500);

  return {
    date,
    success: true,
    rowsLoaded: filteredRows.length,
    rowsWritten,
    durationMs: Date.now() - start,
  };
}

/* ============================================================
   MAIN JOB
============================================================ */

async function runHistoricalFlatfileBackfillJob(options = {}) {
  const startedAt = new Date();

  const symbolLimit = clamp(
    safeNum(options.symbolLimit, env("FLATFILE_BACKFILL_SYMBOL_LIMIT", 300)),
    1,
    10000
  );

  const chunkSize = clamp(
    safeNum(options.chunkSize, env("FLATFILE_BACKFILL_CHUNK_SIZE", 500)),
    50,
    5000
  );

  const concurrency = clamp(
    safeNum(options.concurrency, env("FLATFILE_BACKFILL_CONCURRENCY", 3)),
    1,
    10
  );

  const dateFrom = options.dateFrom || env("FLATFILE_BACKFILL_DATE_FROM", "");
  const dateTo = options.dateTo || env("FLATFILE_BACKFILL_DATE_TO", "");
  const daysBack = clamp(
    safeNum(options.daysBack, env("FLATFILE_BACKFILL_DAYS_BACK", 1)),
    1,
    3650
  );

  const useCache =
    options.useCache !== undefined
      ? !!options.useCache
      : String(env("FLATFILE_BACKFILL_USE_CACHE", "true")).toLowerCase() === "true";

  const dataset =
    options.dataset || env("MASSIVE_FLATFILES_DAILY_DATASET", "us_stocks_sip/day_aggs_v1");

  const incremental =
    options.incremental !== undefined
      ? !!options.incremental
      : String(env("FLATFILE_BACKFILL_INCREMENTAL", "true")).toLowerCase() === "true";

  const countryFilter = options.countryFilter || env("FLATFILE_BACKFILL_COUNTRY_FILTER", "US");
  const symbolSource = options.symbolSource || env("FLATFILE_BACKFILL_SYMBOL_SOURCE", "universe");

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: concurrency + 2,
  });

  try {
    logger.info("[historicalFlatfileBackfill] start", {
      symbolLimit,
      chunkSize,
      concurrency,
      incremental,
      dateFrom: dateFrom || `last ${daysBack} days`,
      dataset,
      symbolSource,
      countryFilter,
    });

    await ensurePricesDailyTable(pool);

    if (shouldEnableJobMetrics()) {
      await ensureJobMetricsTable(pool);
    }

    const symbols = await loadTargetSymbols(pool, symbolLimit, {
      country: countryFilter,
      source: symbolSource,
    });

    if (!symbols.length) {
      const emptyResult = {
        success: true,
        symbolsRequested: 0,
        datesProcessed: 0,
        rowsLoaded: 0,
        rowsWritten: 0,
        meta: {},
      };

      await recordJobMetrics(pool, "historicalFlatfileBackfill", startedAt, emptyResult);
      logger.warn("[historicalFlatfileBackfill] no target symbols found");
      return emptyResult;
    }

    const dates = buildDateRange({ dateFrom, dateTo, daysBack });

    if (!dates.length) {
      const emptyResult = {
        success: true,
        symbolsRequested: symbols.length,
        datesProcessed: 0,
        rowsLoaded: 0,
        rowsWritten: 0,
        meta: {},
      };

      await recordJobMetrics(pool, "historicalFlatfileBackfill", startedAt, emptyResult);
      logger.warn("[historicalFlatfileBackfill] no dates to process");
      return emptyResult;
    }

    let missingPairs = [];

    if (incremental) {
      missingPairs = await getMissingPairs(pool, symbols, dates);
      logger.info("[historicalFlatfileBackfill] incremental scan complete", {
        missingPairs: missingPairs.length,
        possiblePairs: symbols.length * dates.length,
      });
    } else {
      for (const symbol of symbols) {
        for (const date of dates) {
          missingPairs.push({ symbol, date });
        }
      }
    }

    if (!missingPairs.length) {
      const noWorkResult = {
        success: true,
        symbolsRequested: symbols.length,
        datesProcessed: dates.length,
        rowsLoaded: 0,
        rowsWritten: 0,
        meta: {
          incremental,
          nothingToBackfill: true,
        },
      };

      await recordJobMetrics(pool, "historicalFlatfileBackfill", startedAt, noWorkResult);
      logger.info("[historicalFlatfileBackfill] nothing to backfill");
      return noWorkResult;
    }

    const pairsByDate = new Map();
    for (const pair of missingPairs) {
      if (!pairsByDate.has(pair.date)) pairsByDate.set(pair.date, []);
      pairsByDate.get(pair.date).push(pair);
    }

    const massiveService = new MassiveFlatfileService();
    const limit = pLimit(concurrency);

    const tasks = Array.from(pairsByDate.entries()).map(([date, pairs]) =>
      limit(() =>
        pRetry(
          async () => {
            const result = await processDay({
              date,
              missingPairs: pairs,
              massiveService,
              pool,
              chunkSize,
              useCache,
              dataset,
            });

            return result;
          },
          {
            retries: 2,
            onFailedAttempt: (err) => {
              logger.warn("[historicalFlatfileBackfill] retry scheduled", {
                date,
                attemptNumber: err.attemptNumber,
                retriesLeft: err.retriesLeft,
                message: err.message,
              });
            },
          }
        )
      )
    );

    const settled = await Promise.allSettled(tasks);

    let totalRowsLoaded = 0;
    let totalRowsWritten = 0;
    let successfulDates = 0;
    let errorCount = 0;

    for (const result of settled) {
      if (result.status === "fulfilled") {
        totalRowsLoaded += safeNum(result.value?.rowsLoaded, 0);
        totalRowsWritten += safeNum(result.value?.rowsWritten, 0);
        successfulDates += 1;
      } else {
        errorCount += 1;
        logger.error("[historicalFlatfileBackfill] day processing failed", {
          message: result.reason?.message || String(result.reason),
        });
      }
    }

    const finalResult = {
      success: errorCount === 0,
      symbolsRequested: symbols.length,
      datesProcessed: successfulDates,
      rowsLoaded: totalRowsLoaded,
      rowsWritten: totalRowsWritten,
      errors: errorCount,
      meta: {
        incremental,
        totalDatesRequested: pairsByDate.size,
      },
    };

    await recordJobMetrics(pool, "historicalFlatfileBackfill", startedAt, finalResult);

    if (totalRowsWritten > 0) {
      await triggerFeatureUpdate(pool);
    }

    logger.info("[historicalFlatfileBackfill] done", finalResult);
    return finalResult;
  } catch (err) {
    const failedResult = {
      error: err.message,
      rowsLoaded: 0,
      rowsWritten: 0,
      meta: {},
    };

    logger.error("[historicalFlatfileBackfill] job failed", {
      message: err.message,
      stack: err.stack,
    });

    try {
      await recordJobMetrics(pool, "historicalFlatfileBackfill", startedAt, failedResult);
    } catch (metricsErr) {
      logger.warn("[historicalFlatfileBackfill] failed to record job metrics", {
        message: metricsErr.message,
      });
    }

    throw err;
  } finally {
    await pool.end();
  }
}

/* ============================================================
   CLI ENTRYPOINT
============================================================ */

if (require.main === module) {
  runHistoricalFlatfileBackfillJob()
    .then(() => {
      logger.info("[historicalFlatfileBackfill] process exit 0");
      process.exit(0);
    })
    .catch((err) => {
      logger.error("[historicalFlatfileBackfill] process exit 1", {
        message: err.message,
      });
      process.exit(1);
    });
}

module.exports = {
  runHistoricalFlatfileBackfillJob,
  ensurePricesDailyTable,
  loadTargetSymbols,
  getMissingPairs,
  upsertDailyRowsBatch,
};
