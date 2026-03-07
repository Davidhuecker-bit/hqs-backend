"use strict";

/*
  HQS Market System – Enterprise AI Market Pipeline
*/

const axios = require("axios");

const { fetchQuote } = require("./providerService");
const { normalizeMarketData } = require("./marketNormalizer");
const { buildHQSResponse } = require("../hqsEngine");

const { getHistoricalPrices } = require("./historicalService");

const { buildTrendScore } = require("../engines/trendEngine");
const { monteCarloSimulation } = require("../engines/monteCarloEngine");
const { detectMarketRegime } = require("../engines/marketRegimeEngine");

const { buildFeatures } = require("../engines/featureEngine");
const { discoverOpportunities } = require("../engines/discoveryEngine");
const { detectNarrative } = require("../engines/narrativeEngine");
const {
  runMarketSimulations,
  calculateResilience,
} = require("../engines/marketSimulationEngine");
const { runResearch } = require("../engines/researchEngine");
const { buildAIScore } = require("../engines/marketBrain");
const { applyStrategy } = require("../engines/strategyEngine");
const { buildIntegratedMarketView } = require("../engines/integrationEngine");

const { analyzeCrossAssetEnvironment } = require("../engines/crossAssetEngine");
const { analyzeCapitalFlows } = require("../engines/capitalFlowEngine");
const { analyzeMacroEvents } = require("../engines/eventIntelligenceEngine");
const { evaluateMarketMemory } = require("../engines/marketMemoryEngine");
const { evaluateMetaLearning } = require("../engines/metaLearningEngine");
const { orchestrateMarket } = require("../engines/marketOrchestrator");

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

const HIST_PERIOD = String(process.env.HIST_PERIOD || "1y").toLowerCase();
const MC_SIMS = Number(process.env.MC_SIMS || 800);

/* =========================================================
   IN-MEMORY AI STORES
   (später DB/Redis möglich)
========================================================= */

let marketMemoryStore = {};
let metaLearningStore = {};

/* =========================================================
   FMP MARKET SYMBOLS
========================================================= */

async function getMarketSymbolsFromFMP() {
  try {
    const exchanges = ["NASDAQ", "NYSE", "AMEX"];
    let symbols = [];

    for (const exchange of exchanges) {
      const url =
        `https://financialmodelingprep.com/api/v3/stock-screener?exchange=${exchange}&limit=1000&apikey=${process.env.FMP_API_KEY}`;

      const res = await axios.get(url);

      if (Array.isArray(res.data)) {
        const list = res.data.map((s) => s.symbol).filter(Boolean);
        symbols = symbols.concat(list);
      }
    }

    symbols = [...new Set(symbols)];

    logger.info("FMP market symbols loaded", {
      count: symbols.length,
    });

    return symbols;
  } catch (err) {
    logger.error("FMP screener failed", {
      message: err.message,
    });

    return [];
  }
}

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

  await initAdvancedMetricsTable();
  await initJobLocksTable();
  await initWatchlistTable();
  await seedDefaultWatchlist();

  logger.info("Tables ensured");
}

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
      hqsCreatedAt: row.created_at
        ? new Date(row.created_at).toISOString()
        : null,
    };
  } catch (err) {
    logger.error("loadLatestHqsScore error", { message: err.message });
    return null;
  }
}

/* =========================================================
   MONTE CARLO SCENARIOS
========================================================= */

function buildMultiHorizonScenarios(S, mu, sigmaDaily, simulations) {
  const price0 = safeNum(S, 0);
  const drift = safeNum(mu, 0);
  const sig = safeNum(sigmaDaily, 0);

  if (!Number.isFinite(price0) || price0 <= 0) return null;

  const sim =
    Number.isFinite(simulations) && simulations > 100 ? simulations : 800;

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
  };
}

/* =========================================================
   HELPER: MACRO / FLOW FALLBACK CONTEXT
   (später mit echten Daten füttern)
========================================================= */

function buildMacroContextFallback({ trendData, normalized }) {
  return {
    vixTrend: safeNum(trendData?.volatilityAnnual, 0) - 0.2,
    marketBreadth: safeNum(trendData?.trend, 0) > 0 ? 0.62 : 0.42,
    dollarTrend: 0,
    marketTrend: safeNum(trendData?.trend, 0),
    oilTrend: 0,
    goldTrend: 0,
    bondTrend: 0,
    techTrend: safeNum(normalized?.changesPercentage, 0) / 100,
  };
}

function buildCapitalFlowFallback({ normalized }) {
  const volume = safeNum(normalized?.volume, 0);
  const avgVolume = safeNum(normalized?.avgVolume, volume || 1);

  return {
    sectorData: normalized?.sector
      ? [
          {
            sector: String(normalized.sector).toLowerCase(),
            performance: safeNum(normalized?.changesPercentage, 0) / 100,
          },
        ]
      : [],
    etfFlows: [],
    advancers: safeNum(normalized?.changesPercentage, 0) >= 0 ? 3200 : 1800,
    decliners: safeNum(normalized?.changesPercentage, 0) >= 0 ? 1800 : 3200,
    volumeData: {
      volume,
      avgVolume,
    },
  };
}

/* =========================================================
   SNAPSHOT PIPELINE
========================================================= */

async function buildMarketSnapshot() {
  const won = await acquireLock("snapshot_job", 12 * 60);

  if (!won) {
    logger.warn("Snapshot job skipped (lock held)");
    return;
  }

  logger.info("Building market snapshot...");

  const symbols = await getMarketSymbolsFromFMP();

  if (!symbols.length) {
    logger.warn("No symbols received from FMP");
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

          regime = detectMarketRegime(
            trendData.trend,
            trendData.volatilityAnnual
          );

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
        }
      } catch (histErr) {
        logger.warn("Historical unavailable", {
          symbol,
          message: histErr.message,
        });
      }

      const hqs = await buildHQSResponse(
        normalized,
        0,
        adaptiveWeights,
        regime
      );

      /* =============================
         CORE AI LAYER
      ============================= */

      const features = buildFeatures(normalized, {
        trend: trendData?.trend,
        volatilityAnnual: trendData?.volatilityAnnual,
        avgVolume: normalized.avgVolume,
      });

      const discoveries = discoverOpportunities(
        symbol,
        normalized,
        features,
        trendData
      );

      const narratives = detectNarrative({
        sector: normalized.sector,
        trend: trendData?.trend,
        relative: hqs?.breakdown?.relative,
      });

      const simulations = runMarketSimulations(features, trendData);
      const resilienceScore = calculateResilience(simulations);

      const research = runResearch(
        symbol,
        normalized,
        features,
        trendData,
        hqs?.hqsScore
      );

      const brain = buildAIScore({
        symbol,
        hqsScore: hqs?.hqsScore,
        features,
        advanced: trendData,
        discoveries,
      });

      const strategy = applyStrategy(
        symbol,
        brain?.aiScore,
        features,
        trendData
      );

      /* =============================
         NEW MACRO / FLOW / EVENT LAYER
      ============================= */

      const macroContext = buildMacroContextFallback({
        trendData,
        normalized,
      });

      const crossAsset = analyzeCrossAssetEnvironment(macroContext);

      const capitalFlows = analyzeCapitalFlows(
        buildCapitalFlowFallback({ normalized })
      );

      const eventIntelligence = analyzeMacroEvents(macroContext);

      /* =============================
         MEMORY + META LEARNING
      ============================= */

      const marketMemory = evaluateMarketMemory({
        memoryStore: marketMemoryStore,
        symbol,
        regime,
        strategy: strategy?.strategy || "balanced",
        discoveries,
        narratives,
        features,
        crossSignals: crossAsset?.signals || [],
        prediction: safeNum(brain?.aiScore, 0) / 100,
        actualReturn: 0,
        confidence: 0.5,
        persist: false,
      });

      const metaLearning = evaluateMetaLearning({
        metaStore: metaLearningStore,
        context: {
          regime,
          riskMode: "neutral",
          strategy: strategy?.strategy || "balanced",
          dominantNarrative: narratives?.[0]?.type || "none",
        },
        signalMetrics: {
          trendScore: safeNum(trendData?.trendStrength, 0),
          discoveryCount: discoveries?.length || 0,
          capitalFlowStrength: capitalFlows?.marketBreadth || 0,
          eventCount: eventIntelligence?.events?.length || 0,
          memoryScore: marketMemory?.memoryStats?.memoryScore || 0,
          narrativeCount: narratives?.length || 0,
          strategyScore: safeNum(strategy?.strategyAdjustedScore, 0),
          crossAssetCount: crossAsset?.signals?.length || 0,
        },
        actualReturn: 0,
        symbol,
        persist: false,
      });

      /* =============================
         ORCHESTRATOR
      ============================= */

      const orchestrator = orchestrateMarket({
        trendData,
        aiScore: brain?.aiScore,
        conviction: brain?.aiScore,
        resilienceScore,
        narratives,
        discoveries,
        crossAssetSignals: crossAsset?.signals || [],
        capitalFlows,
        macroContext: {
          ...macroContext,
          marketBreadth: capitalFlows?.marketBreadth ?? macroContext.marketBreadth,
        },
        eventIntelligence,
        marketMemory,
        metaLearning,
      });

      /* =============================
         FINAL INTEGRATION
      ============================= */

      const finalView = buildIntegratedMarketView({
        symbol,
        hqs,
        features,
        discoveries,
        learning: null,
        brain,
        strategy,
        narratives,
        simulations,
        resilienceScore,
        research,
        globalContext: {
          crossAsset,
          capitalFlows,
          eventIntelligence,
          orchestrator,
          marketMemory: marketMemory?.memoryStats || null,
          metaLearning: metaLearning?.trustProfile || null,
        },
      });

      logger.info("AI Market View", {
        symbol,
        finalConviction: finalView?.finalConviction,
        finalRating: finalView?.finalRating,
        aiScore: brain?.aiScore,
        opportunityStrength: orchestrator?.opportunityStrength,
        orchestratorConfidence: orchestrator?.orchestratorConfidence,
      });

      /* =============================
         DATABASE STORAGE
      ============================= */

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
          regime,
        ]
      );

      logger.info(`Snapshot saved for ${symbol}`);
    } catch (err) {
      logger.error(`Snapshot error for ${symbol}`, {
        message: err.message,
      });
    }
  }

  logger.info("Snapshot complete");
}

/* =========================================================
   MARKET DATA (API / UI)
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
        normalized.scenarios = adv.scenarios ?? null;
      }

      results.push(normalized);
    }

    return results;
  } catch (error) {
    logger.error("MarketData Error", {
      message: error.message,
    });

    return [];
  }
}

module.exports = {
  getMarketData,
  buildMarketSnapshot,
  ensureTablesExist,
};
