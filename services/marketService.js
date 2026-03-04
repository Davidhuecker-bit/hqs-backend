"use strict";

/*
  HQS Market System – Enterprise Upgrade (FINAL)
  - Snapshot Speicherung
  - HQS Berechnung (DB-first)
  - Trend Analyse (oldest->newest standard)
  - Monte Carlo Simulation (GBM, lognormal)
  - Regime Detection (expansion/bull/neutral/bear/crash)
  - Adaptive Weights (reinforcement)
*/

const { fetchQuote } = require("./providerService");
const { normalizeMarketData } = require("./marketNormalizer");
const { buildHQSResponse } = require("../hqsEngine");

const { getHistoricalPrices } = require("./historicalService");
const { buildTrendScore } = require("../engines/trendEngine");
const { monteCarloSimulation } = require("../engines/monteCarloEngine");
const { detectMarketRegime } = require("../engines/marketRegimeEngine");

const { computeAdaptiveWeights } = require("./weightHistory.repository");
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

  logger.info("Tables ensured");
}

/* =========================================================
   WATCHLIST
========================================================= */

const WATCHLIST = ["AAPL", "MSFT", "NVDA", "AMD"];

/* =========================================================
   LOAD LATEST HQS SCORE
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
   SNAPSHOT + ADVANCED HQS PIPELINE
========================================================= */

async function buildMarketSnapshot() {
  logger.info("Building market snapshot...");

  for (const symbol of WATCHLIST) {
    try {
      const raw = await fetchQuote(symbol);
      if (!raw || !raw.length) continue;

      const normalized = normalizeMarketData(raw[0], "massive", "us");
      if (!normalized) continue;

      // HISTORICAL DATA
      const historical = await getHistoricalPrices(symbol, "1y");

      // FMP line history typically: [{date, close}, ...]
      const prices = (historical || [])
        .map((d) => Number(d?.close))
        .filter((n) => Number.isFinite(n) && n > 0);

      if (prices.length < 30) continue;

      // TREND + VOL
      const trendData = buildTrendScore(prices);

      // REGIME DETECTION (expects annual vol)
      const regime = detectMarketRegime(trendData.trend, trendData.volatilityAnnual);

      // ADAPTIVE WEIGHTS
      const adaptiveWeights = await computeAdaptiveWeights(regime);

      // HQS (pass regime hint as 4th param)
      const hqs = await buildHQSResponse(
        normalized,
        0,
        adaptiveWeights,
        regime
      );

      // MONTE CARLO (sigmaDaily!)
      const scenarios = monteCarloSimulation(
        prices[0],
        trendData.trend,
        trendData.volatilityDaily,
        252,
        1000
      );

      // Snapshot speichern
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

      // HQS speichern
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

      logger.info(`Snapshot + Advanced HQS saved for ${symbol}`);
      // Optional: scenarios/trendData nicht in DB speichern (erstmal nur API)
      // Du könntest später eine eigene table "hqs_advanced_metrics" dafür machen.

      // Hinweis: wenn du willst, kannst du normalized.scenarios auch zurückgeben
      // aber für Snapshot reicht persistierter HQS Score.

    } catch (err) {
      logger.error(`Snapshot error for ${symbol}`, { message: err.message });
    }
  }

  logger.info("Snapshot complete");
}

/* =========================================================
   MARKET DATA (DB-FIRST + SCENARIOS)
========================================================= */

async function getMarketData(symbol) {
  try {
    const symbols = symbol ? [String(symbol).trim().toUpperCase()] : WATCHLIST;
    const results = [];

    for (const s of symbols) {
      const raw = await fetchQuote(s);
      if (!raw || !raw.length) continue;

      const normalized = normalizeMarketData(raw[0], "massive", "us");
      if (!normalized) continue;

      // DB-first HQS
      const cached = await loadLatestHqsScore(s);
      if (cached) Object.assign(normalized, cached);

      // Advanced API Addons
      const historical = await getHistoricalPrices(s, "1y");
      const prices = (historical || [])
        .map((d) => Number(d?.close))
        .filter((n) => Number.isFinite(n) && n > 0);

      if (prices.length > 30) {
        const trendData = buildTrendScore(prices);

        normalized.trend = trendData.trend;
        normalized.volatility = trendData.volatilityAnnual; // keep name "volatility" for frontend
        normalized.volatilityDaily = trendData.volatilityDaily; // extra field if you want

        normalized.scenarios = monteCarloSimulation(
          prices[0],
          trendData.trend,
          trendData.volatilityDaily,
          252,
          500
        );
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
