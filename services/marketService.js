"use strict";

/*
  HQS Market System – Enterprise Upgrade (DB-FIRST ADVANCED + WATCHLIST DB + LOCKED)
  - Snapshot Speicherung
  - HQS Berechnung (DB-first)
  - Advanced Metrics (Trend/Vol/Scenarios) DB-first via market_advanced_metrics
  - Watchlist aus DB (watchlist_symbols)
  - Job Locking (job_locks) gegen Doppel-Snapshots
  - Historical optional (DELAYED safe via historicalService)
  - ✅ Multi-Horizon Scenarios (30/90/180/252d)
  - ✅ HIST_PERIOD env (1y/max)
  - ✅ NEW: Snapshot kann batchweise aus Universe scannen (Cursor)
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

// ✅ Universe (Symbol-Liste + Cursor Batch)
const { initUniverseTables, getUniverseBatch } = require("./universe.repository");

const logger = require("../utils/logger");

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ✅ Historical Period (1y/max)
const HIST_PERIOD = String(process.env.HIST_PERIOD || "1y").toLowerCase();

// MonteCarlo Simulationen pro Symbol
const MC_SIMS = Number(process.env.MC_SIMS || 800);

// ✅ Batch Size für Universe Scan
const SNAPSHOT_BATCH_SIZE = Number(process.env.SNAPSHOT_BATCH_SIZE || 150);

// ✅ Snapshot Quelle: "universe" oder "watchlist"
const SNAPSHOT_SOURCE = String(process.env.SNAPSHOT_SOURCE || "watchlist").toLowerCase();

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

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

  // Existing init chain
  await initAdvancedMetricsTable();
  await initJobLocksTable();
  await initWatchlistTable();
  await seedDefaultWatchlist();

  // ✅ Universe init (wichtig, sonst gibt's keine Tabelle & keinen Cursor)
  await initUniverseTables();

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
   MULTI HORIZON SCENARIOS
========================================================= */

function buildMultiHorizonScenarios(S, mu, sigmaDaily, simulations) {
  const price0 = safeNum(S, 0);
  const drift = safeNum(mu, 0);
  const sig = safeNum(sigmaDaily, 0);

  if (!Number.isFinite(price0) || price0 <= 0) return null;

  const sim = Number.isFinite(simulations) && simulations > 100 ? simulations : 800;

  const h30 = monteCarloSimulation(price0, drift, sig, 30, sim);
  const h90 = monteCarloSimulation(price0, drift, sig, 90, sim);
  const h180 = monteCarloSimulation(price0, drift, sig, 180, sim);
  const h252 = monteCarloSimulation(price0, drift, sig, 252, sim);

  return {
    horizons: {
      "30": { base: h30.realistic, bull: h30.optimistic, bear: h30.pessimistic },
      "90": { base: h90.realistic, bull: h90.optimistic, bear: h90.pessimistic },
      "180": { base: h180.realistic, bull: h180.optimistic, bear: h180.pessimistic },
      "252": { base: h252.realistic, bull: h252.optimistic, bear: h252.pessimistic },
    },
    meta: {
      simulations: sim,
      sigmaDaily: sig,
      mu: drift,
    },
  };
}

/* =========================================================
   SNAPSHOT + HQS PIPELINE
   - locked against duplicates
   - ✅ optional Universe Batch Scan (Cursor)
========================================================= */

async function buildMarketSnapshot() {
  const won = await acquireLock("snapshot_job", 12 * 60); // 12 min TTL
  if (!won) {
    logger.warn("Snapshot job skipped (lock held)");
    return;
  }

  logger.info("Building market snapshot...");

  // ✅ Entscheidet ob Universe oder Watchlist
  let symbols = [];
  if (SNAPSHOT_SOURCE === "universe") {
    const batch = await getUniverseBatch(SNAPSHOT_BATCH_SIZE);
    symbols = batch.symbols;

    logger.info("Snapshot source = universe", {
      batchSize: symbols.length,
      cursor: batch.cursor,
      nextCursor: batch.nextCursor,
    });
  } else {
    symbols = await getActiveWatchlistSymbols(250);
    logger.info("Snapshot source = watchlist", { count: symbols.length });
  }

  if (!symbols.length) {
    logger.warn("No symbols found for snapshot run", {
      SNAPSHOT_SOURCE,
      hint:
        SNAPSHOT_SOURCE === "universe"
          ? "universe_symbols ist leer -> erst universeRefresh ausführen"
          : "watchlist leer/disabled",
    });
    return;
  }

  for (const symbol of symbols) {
    try {
      const raw = await fetchQuote(symbol);
      if (!raw || !raw.length) continue;

      const normalized = normalizeMarketData(raw[0], "massive", "us");
      if (!normalized) continue;

      let trendData = null;
      let scenarios = null;

      let regime = "neutral";
      let adaptiveWeights = await computeAdaptiveWeights(regime);

      try {
        const historical = await getHistoricalPrices(symbol, HIST_PERIOD);

        const prices = (historical || [])
          .map((d) => Number(d?.close))
          .filter((n) => Number.isFinite(n) && n > 0);

        if (prices.length >= 30) {
          trendData = buildTrendScore(prices);

          regime = detectMarketRegime(trendData.trend, trendData.volatilityAnnual);
          adaptiveWeights = await computeAdaptiveWeights(regime);

          scenarios = buildMultiHorizonScenarios(
            prices[0],
            trendData.trend,
            trendData.volatilityDaily,
            MC_SIMS
          );

          await upsertAdvancedMetrics(symbol, {
            regime,
            trend: trendData.trend,
            volatilityAnnual: trendData.volatilityAnnual,
            volatilityDaily: trendData.volatilityDaily,
            scenarios,
          });
        } else {
          logger.warn("Historical insufficient; using fallback", {
            symbol,
            points: prices.length,
            period: HIST_PERIOD,
          });
        }
      } catch (histErr) {
        logger.warn("Historical unavailable; using fallback", {
          symbol,
          period: HIST_PERIOD,
          message: histErr.message,
        });
      }

      const hqs = await buildHQSResponse(normalized, 0, adaptiveWeights, regime);

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
          period: HIST_PERIOD,
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
   - bleibt bewusst Watchlist/Symbol basiert (UI/Users)
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

      const cached = await loadLatestHqsScore(s);
      if (cached) Object.assign(normalized, cached);

      const adv = await loadAdvancedMetrics(s);

      if (adv) {
        normalized.regime = normalized.regime ?? adv.regime ?? null;
        normalized.trend = adv.trend ?? null;
        normalized.volatility = adv.volatility ?? null;
        normalized.volatilityDaily = adv.volatilityDaily ?? null;
        normalized.scenarios = adv.scenarios ?? null;
        normalized.advancedUpdatedAt = adv.advancedUpdatedAt ?? null;
      } else {
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
