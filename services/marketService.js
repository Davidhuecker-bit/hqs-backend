"use strict";

/*
  HQS Market System – Enterprise Upgrade (DB-FIRST ADVANCED + WATCHLIST DB + LOCKED)
  - Snapshot Speicherung
  - HQS Berechnung (DB-first)
  - Advanced Metrics (Trend/Vol/Scenarios) DB-first via market_advanced_metrics
  - Watchlist aus DB (watchlist_symbols)
  - Job Locking (job_locks) gegen Doppel-Snapshots
  - Historical optional (DELAYED safe via historicalService)
*/

const { fetchQuote } = require("./providerService");
const { normalizeMarketData } = require("./marketNormalizer");
const { buildHQSResponse } = require("../hqsEngine");

const { getHistoricalPrices } = require("./historicalService");
const { buildTrendScore } = require("../engines/trendEngine");
const { monteCarloSimulation } = require("../engines/monteCarloEngine");
const { detectMarketRegime } = require("../engines/marketRegimeEngine");

const { computeAdaptiveWeights } = require("./weightHistory.repository");

const {
  initWatchlistTable,
  seedDefaultWatchlist,
  getActiveWatchlistSymbols,
} = require("./watchlist.repository");

const {
  initAdvancedMetricsTable,
  upsertAdvancedMetrics,
  loadAdvancedMetrics,
} = require("./advancedMetrics.repository");

const { initJobLocksTable, acquireLock } = require("./jobLock.repository");

const logger = require("../utils/logger");

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =========================================================
   TABLE INIT
========================================================= */

async function ensureTablesExist() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_snapshots (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      price NUMERIC,
      open NUMERIC,
      high NUMERIC,
      low NUMERIC,
      volume BIGINT,
      source TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hqs_scores (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      hqs_score NUMERIC,
      momentum NUMERIC,
      quality NUMERIC,
      stability NUMERIC,
      relative NUMERIC,
      regime TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // ✅ NEW TABLES
  await initAdvancedMetricsTable();
  await initJobLocksTable();
  await initWatchlistTable();
  await seedDefaultWatchlist();

  logger.info("Tables ensured");
}

/* =========================================================
   INTERNAL: LOAD LATEST HQS SCORE + BREAKDOWN
========================================================= */

async function loadLatestHqsScore(symbol) {
  try {
    const res = await pool.query(
      `
      SELECT
        hqs_score,
        momentum,
        quality,
        stability,
        relative,
        regime,
        created_at
      FROM hqs_scores
      WHERE symbol = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [symbol]
    );

    if (!res.rows.length) return null;

    const row = res.rows[0];

    return {
      hqsScore: row.hqs_score !== null ? Number(row.hqs_score) : null,
      momentum: row.momentum !== null ? Number(row.momentum) : null,
      quality: row.quality !== null ? Number(row.quality) : null,
      stability: row.stability !== null ? Number(row.stability) : null,
      relative: row.relative !== null ? Number(row.relative) : null,
      regime: row.regime ?? null,
      hqsCreatedAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    };
  } catch (err) {
    logger.error("loadLatestHqsScore error", { message: err.message });
    return null;
  }
}

/* =========================================================
   SNAPSHOT + HQS PIPELINE
   - uses DB watchlist
   - computes advanced metrics ONCE and stores to DB
   - locked against duplicates
========================================================= */

async function buildMarketSnapshot() {
  // ✅ Locking gegen Doppel-Jobs (Deploy/Restart)
  const won = await acquireLock("snapshot_job", 12 * 60); // 12 min TTL
  if (!won) {
    logger.warn("Snapshot job skipped (lock held)");
    return;
  }

  logger.info("Building market snapshot...");

  const watchlist = await getActiveWatchlistSymbols(250);
  if (!watchlist.length) {
    logger.warn("No active watchlist symbols found");
    return;
  }

  for (const symbol of watchlist) {
    try {
      const raw = await fetchQuote(symbol);
      if (!raw || !raw.length) continue;

      const normalized = normalizeMarketData(raw[0], "massive", "us");
      if (!normalized) continue;

      // -----------------------------------------------------
      // DEFAULTS (HISTORICAL OPTIONAL)
      // -----------------------------------------------------
      let trendData = null;
      let scenarios = null;

      let regime = "neutral";
      let adaptiveWeights = await computeAdaptiveWeights(regime);

      // -----------------------------------------------------
      // TRY HISTORICAL -> compute & persist advanced metrics
      // -----------------------------------------------------
      try {
        // Du kannst hier auf "max" stellen, wenn du wirklich 5 Jahre willst:
        // const historical = await getHistoricalPrices(symbol, "max");
        const historical = await getHistoricalPrices(symbol, "1y");

        const prices = (historical || [])
          .map((d) => Number(d?.close))
          .filter((n) => Number.isFinite(n) && n > 0);

        if (prices.length >= 30) {
          trendData = buildTrendScore(prices);

          regime = detectMarketRegime(trendData.trend, trendData.volatilityAnnual);

          adaptiveWeights = await computeAdaptiveWeights(regime);

          scenarios = monteCarloSimulation(
            prices[0],
            trendData.trend,
            trendData.volatilityDaily,
            252,
            800
          );

          // ✅ STORE ADVANCED METRICS DB-FIRST
          await upsertAdvancedMetrics(symbol, {
            regime,
            trend: trendData.trend,
            volatilityAnnual: trendData.volatilityAnnual,
            volatilityDaily: trendData.volatilityDaily,
            scenarios,
          });
        } else {
          logger.warn("Historical insufficient; using fallback", { symbol, points: prices.length });
        }
      } catch (histErr) {
        logger.warn("Historical unavailable; using fallback", { symbol, message: histErr.message });
      }

      // -----------------------------------------------------
      // HQS ALWAYS RUNS
      // -----------------------------------------------------
      const hqs = await buildHQSResponse(normalized, 0, adaptiveWeights, regime);

      // -----------------------------------------------------
      // SAVE SNAPSHOT
      // -----------------------------------------------------
      await pool.query(
        `
        INSERT INTO market_snapshots
        (symbol, price, open, high, low, volume, source, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        `,
        [
          normalized.symbol,
          normalized.price,
          normalized.open,
          normalized.high,
          normalized.low,
          normalized.volume,
          normalized.source,
        ]
      );

      // -----------------------------------------------------
      // SAVE HQS SCORE
      // -----------------------------------------------------
      await pool.query(
        `
        INSERT INTO hqs_scores
        (symbol, hqs_score, momentum, quality, stability, relative, regime, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        `,
        [
          hqs.symbol,
          hqs.hqsScore,
          hqs.breakdown?.momentum ?? null,
          hqs.breakdown?.quality ?? null,
          hqs.breakdown?.stability ?? null,
          hqs.breakdown?.relative ?? null,
          hqs.regime ?? regime,
        ]
      );

      if (trendData) {
        logger.info("Advanced metrics computed", {
          symbol,
          regime,
          trend: trendData.trend,
          volAnnual: trendData.volatilityAnnual,
        });
      }

      logger.info(`Snapshot + HQS saved for ${symbol}`);
    } catch (err) {
      logger.error(`Snapshot error for ${symbol}`, { message: err.message });
    }
  }

  logger.info("Snapshot complete");
}

/* =========================================================
   MARKET DATA (DB-FIRST HQS + DB-FIRST ADVANCED)
========================================================= */

async function getMarketData(symbol) {
  try {
    const symbols = symbol
      ? [String(symbol).trim().toUpperCase()]
      : await getActiveWatchlistSymbols(250);

    const results = [];

    for (const s of symbols) {
      const raw = await fetchQuote(s);
      if (!raw || !raw.length) continue;

      const normalized = normalizeMarketData(raw[0], "massive", "us");
      if (!normalized) continue;

      // -----------------------
      // DB-first HQS
      // -----------------------
      const cached = await loadLatestHqsScore(s);
      if (cached) Object.assign(normalized, cached);

      // -----------------------
      // DB-first Advanced Metrics
      // -----------------------
      const adv = await loadAdvancedMetrics(s);

      if (adv) {
        normalized.regime = normalized.regime ?? adv.regime ?? null;
        normalized.trend = adv.trend ?? null;

        // frontend-friendly naming
        normalized.volatility = adv.volatility ?? null;
        normalized.volatilityDaily = adv.volatilityDaily ?? null;

        normalized.scenarios = adv.scenarios ?? null;
        normalized.advancedUpdatedAt = adv.advancedUpdatedAt ?? null;
      } else {
        // wirklich DB-first: keine Live-Berechnung mehr hier
        normalized.trend = null;
        normalized.volatility = null;
        normalized.volatilityDaily = null;
        normalized.scenarios = null;
        normalized.advancedUpdatedAt = null;
      }

      results.push(normalized);
    }

    return results;
  } catch (error) {
    logger.error("MarketData Error", { message: error.message });
    return [];
  }
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  getMarketData,
  buildMarketSnapshot,
  ensureTablesExist,
};
