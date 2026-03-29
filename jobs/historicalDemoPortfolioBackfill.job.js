"use strict";

/*
  historicalDemoPortfolioBackfill.job.js
  ----------------------------------------
  ONE-OFF manual backfill job.
  Fetches historical daily price data from Massive flatfiles for ONLY the
  symbols currently in the demo portfolio and upserts them into prices_daily.

  NOT a cron. NOT registered in any scheduler. Run once manually:
    node jobs/historicalDemoPortfolioBackfill.job.js
    npm run job:demo-portfolio-backfill

  Configuration (all optional, via env):
    DEMO_PORTFOLIO_BACKFILL_DAYS         Default lookback in calendar days (default: 365)
    DEMO_PORTFOLIO_BACKFILL_INCREMENTAL  Skip pairs already in DB (default: true)
    DEMO_PORTFOLIO_BACKFILL_CONCURRENCY  Parallel date workers (default: 3)
    DEMO_PORTFOLIO_BACKFILL_REST_FALLBACK  Grouped-daily REST fallback for recent gaps (default: true)
    DEMO_PORTFOLIO_BACKFILL_REFRESH_SUMMARY  Refresh symbol_summary after backfill (default: false)
    MASSIVE_FLATFILES_DAILY_DATASET      Flatfile dataset path (default: us_stocks_sip/day_aggs_v1)

  Symbol source:
    Canonical DEMO_ADMIN_SYMBOLS from adminDemoPortfolio.service.js
    (default 20 well-known US stocks, overridable via DEMO_ADMIN_SYMBOLS env).
    If DEMO_ADMIN_SYMBOLS="use_universe", loads top-20 from universe_symbols.
*/

const { Pool } = require("pg");
const pLimit = require("p-limit").default;
const logger = require("../utils/logger");
const { MassiveFlatfileService } = require("../services/massiveFlatfile.service");
const { fetchMassiveGroupedDailyCandles } = require("../services/providerService");
const {
  ensurePricesDailyTable,
  getMissingPairs,
  upsertDailyRowsBatch,
} = require("./historicalFlatfileBackfill.job");

/* ============================================================
   HELPERS
============================================================ */

function env(name, fallback = "") {
  const v = process.env[name];
  return v == null || v === "" ? fallback : v;
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

function buildDateRangeDaysBack(daysBack) {
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

/* ============================================================
   SYMBOL LOADING
   Uses the canonical DEMO_ADMIN_SYMBOLS from adminDemoPortfolio.service.js.
   If "use_universe", queries universe_symbols with the job's own pool.
============================================================ */

async function loadDemoPortfolioSymbols(pool) {
  // Lazy import to avoid pulling in the full service graph at module load time.
  // DEMO_ADMIN_SYMBOLS is either a string[] or the sentinel "use_universe".
  const { DEMO_ADMIN_SYMBOLS } = require("../services/adminDemoPortfolio.service");

  if (Array.isArray(DEMO_ADMIN_SYMBOLS) && DEMO_ADMIN_SYMBOLS.length > 0) {
    const symbols = DEMO_ADMIN_SYMBOLS.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
    logger.info("[demoPortfolioBackfill] symbols from DEMO_ADMIN_SYMBOLS", { count: symbols.length, symbols });
    return symbols;
  }

  // "use_universe" mode
  try {
    const res = await pool.query(`
      SELECT symbol FROM universe_symbols
      WHERE is_active = TRUE
      ORDER BY priority ASC, symbol ASC
      LIMIT 20
    `);
    const symbols = res.rows.map((r) => String(r.symbol || "").trim().toUpperCase()).filter(Boolean);
    if (symbols.length) {
      logger.info("[demoPortfolioBackfill] symbols loaded from universe_symbols", { count: symbols.length, symbols });
      return symbols;
    }
    logger.warn("[demoPortfolioBackfill] universe_symbols returned no rows – falling back to default demo symbols");
  } catch (err) {
    logger.warn("[demoPortfolioBackfill] universe_symbols query failed – falling back to default demo symbols", {
      message: err.message,
    });
  }

  // Hard fallback: the same default 20 that adminDemoPortfolio.service.js uses
  const defaults = [
    "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN",
    "META", "TSLA", "JPM", "BAC", "GS",
    "XOM", "CVX", "JNJ", "PFE", "UNH",
    "WMT", "COST", "CAT", "V", "MA",
  ];
  logger.info("[demoPortfolioBackfill] using hardcoded default demo symbols", { count: defaults.length });
  return defaults;
}

/* ============================================================
   PER-DAY PROCESSING
============================================================ */

async function processDay({ date, missingPairs, massiveService, pool, useCache, dataset, useRestFallback }) {
  const start = Date.now();
  const symbolsForDay = [...new Set(missingPairs.map((p) => p.symbol))];

  logger.info("[demoPortfolioBackfill] processing date", {
    date,
    symbolsRequested: symbolsForDay.length,
  });

  const loadedRows = await massiveService.loadDailyAggregatesForSymbolChunks({
    date,
    symbols: symbolsForDay,
    chunkSize: 500,
    useCache,
    dataset,
  });

  const missingSet = new Set(missingPairs.map((p) => `${p.symbol}|${p.date}`));
  let filteredRows = loadedRows.filter((row) => missingSet.has(`${row.symbol}|${row.date}`));

  // REST fallback for recent dates where the flatfile is not yet published
  if (!filteredRows.length && useRestFallback) {
    try {
      const groupedRows = await fetchMassiveGroupedDailyCandles(date);
      const symbolSet = new Set(symbolsForDay);
      filteredRows = groupedRows.filter((r) => symbolSet.has(r.symbol));
      if (filteredRows.length) {
        logger.info("[demoPortfolioBackfill] grouped-daily fallback supplied rows", {
          date,
          rows: filteredRows.length,
        });
      }
    } catch (err) {
      logger.warn("[demoPortfolioBackfill] grouped-daily fallback failed – skipping date", {
        date,
        message: err.message,
      });
    }
  }

  if (!filteredRows.length) {
    return {
      date,
      rowsLoaded: 0,
      rowsWritten: 0,
      symbolsWithData: [],
      durationMs: Date.now() - start,
    };
  }

  const symbolsWithData = [...new Set(filteredRows.map((r) => r.symbol))];
  const rowsWritten = await upsertDailyRowsBatch(pool, filteredRows, 500);

  return {
    date,
    rowsLoaded: filteredRows.length,
    rowsWritten,
    symbolsWithData,
    durationMs: Date.now() - start,
  };
}

/* ============================================================
   OPTIONAL SYMBOL SUMMARY REFRESH
============================================================ */

async function refreshSymbolSummaries(symbols) {
  if (!symbols.length) return;

  const { refreshSymbolSummary } = require("../services/symbolSummary.builder");

  const limit = pLimit(3);
  const results = await Promise.allSettled(
    symbols.map((sym) =>
      limit(async () => {
        await refreshSymbolSummary(sym);
        logger.info("[demoPortfolioBackfill] symbol_summary refreshed", { symbol: sym });
      })
    )
  );

  const failed = results
    .map((r, i) => (r.status === "rejected" ? symbols[i] : null))
    .filter(Boolean);

  if (failed.length) {
    logger.warn("[demoPortfolioBackfill] symbol_summary refresh failed for some symbols", { failed });
  } else {
    logger.info("[demoPortfolioBackfill] symbol_summary refresh complete", { count: symbols.length });
  }
}

/* ============================================================
   MAIN JOB
============================================================ */

async function runDemoPortfolioBackfill(options = {}) {
  const startedAt = new Date();

  const daysBack = clamp(
    safeNum(options.daysBack, env("DEMO_PORTFOLIO_BACKFILL_DAYS", 365)),
    1,
    3650
  );

  const incremental =
    options.incremental !== undefined
      ? !!options.incremental
      : String(env("DEMO_PORTFOLIO_BACKFILL_INCREMENTAL", "true")).toLowerCase() === "true";

  const concurrency = clamp(
    safeNum(options.concurrency, env("DEMO_PORTFOLIO_BACKFILL_CONCURRENCY", 3)),
    1,
    10
  );

  const useRestFallback =
    options.useRestFallback !== undefined
      ? !!options.useRestFallback
      : String(env("DEMO_PORTFOLIO_BACKFILL_REST_FALLBACK", "true")).toLowerCase() === "true";

  const refreshSummary =
    options.refreshSummary !== undefined
      ? !!options.refreshSummary
      : String(env("DEMO_PORTFOLIO_BACKFILL_REFRESH_SUMMARY", "false")).toLowerCase() === "true";

  const useCache =
    options.useCache !== undefined
      ? !!options.useCache
      : true;

  const dataset =
    options.dataset || env("MASSIVE_FLATFILES_DAILY_DATASET", "us_stocks_sip/day_aggs_v1");

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: concurrency + 2,
  });

  try {
    logger.info("[demoPortfolioBackfill] ===== ONE-OFF DEMO PORTFOLIO HISTORICAL BACKFILL START =====", {
      daysBack,
      incremental,
      concurrency,
      useRestFallback,
      refreshSummary,
      dataset,
    });

    await ensurePricesDailyTable(pool);

    // --- Load demo portfolio symbols ---
    const symbols = await loadDemoPortfolioSymbols(pool);

    if (!symbols.length) {
      logger.warn("[demoPortfolioBackfill] demo portfolio symbols list is empty – exiting cleanly");
      return {
        success: true,
        symbolsRequested: 0,
        datesProcessed: 0,
        rowsLoaded: 0,
        rowsWritten: 0,
        symbolSuccess: [],
        symbolFailed: [],
        message: "No demo portfolio symbols found",
      };
    }

    // --- Build date range ---
    const dates = buildDateRangeDaysBack(daysBack);

    if (!dates.length) {
      logger.warn("[demoPortfolioBackfill] no trading dates in requested range – exiting cleanly");
      return {
        success: true,
        symbolsRequested: symbols.length,
        datesProcessed: 0,
        rowsLoaded: 0,
        rowsWritten: 0,
        symbolSuccess: [],
        symbolFailed: [],
        message: "No dates to process",
      };
    }

    logger.info("[demoPortfolioBackfill] date range built", {
      dateFrom: dates[0],
      dateTo: dates[dates.length - 1],
      tradingDays: dates.length,
    });

    // --- Incremental scan: find missing pairs ---
    let missingPairs = [];

    if (incremental) {
      missingPairs = await getMissingPairs(pool, symbols, dates);
      logger.info("[demoPortfolioBackfill] incremental scan", {
        missingPairs: missingPairs.length,
        possiblePairs: symbols.length * dates.length,
      });
    } else {
      for (const symbol of symbols) {
        for (const date of dates) {
          missingPairs.push({ symbol, date });
        }
      }
      logger.info("[demoPortfolioBackfill] full (non-incremental) mode", {
        totalPairs: missingPairs.length,
      });
    }

    if (!missingPairs.length) {
      logger.info("[demoPortfolioBackfill] nothing to backfill – all pairs already present");
      return {
        success: true,
        symbolsRequested: symbols.length,
        datesProcessed: dates.length,
        rowsLoaded: 0,
        rowsWritten: 0,
        symbolSuccess: [],
        symbolFailed: [],
        message: "Nothing to backfill",
      };
    }

    // --- Group by date and process ---
    const pairsByDate = new Map();
    for (const pair of missingPairs) {
      if (!pairsByDate.has(pair.date)) pairsByDate.set(pair.date, []);
      pairsByDate.get(pair.date).push(pair);
    }

    const massiveService = new MassiveFlatfileService();
    const limiter = pLimit(concurrency);

    const tasks = Array.from(pairsByDate.entries()).map(([date, pairs]) =>
      limiter(async () => {
        try {
          return await processDay({
            date,
            missingPairs: pairs,
            massiveService,
            pool,
            useCache,
            dataset,
            useRestFallback,
          });
        } catch (err) {
          logger.error("[demoPortfolioBackfill] date processing failed", {
            date,
            message: err.message,
          });
          return { date, rowsLoaded: 0, rowsWritten: 0, symbolsWithData: [], error: err.message };
        }
      })
    );

    const dayResults = await Promise.all(tasks);

    // --- Aggregate per-symbol stats ---
    let totalRowsLoaded = 0;
    let totalRowsWritten = 0;
    let datesWithErrors = 0;
    const symbolWrittenCounts = new Map(); // symbol -> rows written across all dates

    for (const result of dayResults) {
      totalRowsLoaded += safeNum(result.rowsLoaded, 0);
      totalRowsWritten += safeNum(result.rowsWritten, 0);
      if (result.error) datesWithErrors += 1;

      for (const sym of result.symbolsWithData || []) {
        symbolWrittenCounts.set(sym, (symbolWrittenCounts.get(sym) || 0) + 1);
      }
    }

    const symbolSuccess = [...symbolWrittenCounts.keys()].sort();
    const symbolFailed = symbols.filter((s) => !symbolWrittenCounts.has(s)).sort();

    // --- Summary logging ---
    logger.info("[demoPortfolioBackfill] ===== SUMMARY =====", {
      symbolsRequested: symbols.length,
      symbolsWithData: symbolSuccess.length,
      symbolsWithoutData: symbolFailed.length,
      datesProcessed: pairsByDate.size - datesWithErrors,
      datesWithErrors,
      rowsLoaded: totalRowsLoaded,
      rowsWritten: totalRowsWritten,
      durationMs: Date.now() - startedAt.getTime(),
    });

    if (symbolSuccess.length) {
      logger.info("[demoPortfolioBackfill] symbols successfully backfilled", { symbols: symbolSuccess });
    }

    if (symbolFailed.length) {
      logger.warn("[demoPortfolioBackfill] symbols with no data found in flatfiles", {
        symbols: symbolFailed,
        hint: "These symbols may not exist in the Massive flatfile dataset for this date range.",
      });
    }

    // --- Optional symbol_summary refresh ---
    if (refreshSummary && symbolSuccess.length > 0) {
      logger.info("[demoPortfolioBackfill] starting symbol_summary refresh for backfilled symbols", {
        count: symbolSuccess.length,
      });
      await refreshSymbolSummaries(symbolSuccess);
    } else if (refreshSummary && symbolSuccess.length === 0) {
      logger.info("[demoPortfolioBackfill] no rows written – skipping symbol_summary refresh");
    } else {
      logger.info(
        "[demoPortfolioBackfill] symbol_summary refresh skipped (DEMO_PORTFOLIO_BACKFILL_REFRESH_SUMMARY not enabled). " +
        "To refresh manually: set DEMO_PORTFOLIO_BACKFILL_REFRESH_SUMMARY=true and re-run, " +
        "or call GET /api/admin/demo-portfolio?refresh=1"
      );
    }

    return {
      success: datesWithErrors === 0,
      symbolsRequested: symbols.length,
      datesProcessed: pairsByDate.size - datesWithErrors,
      rowsLoaded: totalRowsLoaded,
      rowsWritten: totalRowsWritten,
      symbolSuccess,
      symbolFailed,
    };
  } catch (err) {
    logger.error("[demoPortfolioBackfill] job failed", {
      message: err.message,
      stack: err.stack,
    });
    throw err;
  } finally {
    await pool.end();
    logger.info("[demoPortfolioBackfill] DB pool closed");
  }
}

/* ============================================================
   CLI ENTRYPOINT
   Usage: node jobs/historicalDemoPortfolioBackfill.job.js
============================================================ */

if (require.main === module) {
  runDemoPortfolioBackfill()
    .then((result) => {
      logger.info("[demoPortfolioBackfill] process exit 0", {
        rowsWritten: result.rowsWritten,
        symbolSuccess: result.symbolSuccess,
      });
      process.exit(0);
    })
    .catch((err) => {
      logger.error("[demoPortfolioBackfill] process exit 1", { message: err.message });
      process.exit(1);
    });
}

module.exports = { runDemoPortfolioBackfill };
