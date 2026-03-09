"use strict";

/*
  HQS Market System – Enterprise AI Market Pipeline
  DB-first snapshot scanning (watchlist based)

  Enthält:
  - Step 1: Snapshot Summary
  - Step 2: System Health Score
  - Step 3: Priority-aware Snapshot Loading
  - Step 4: Extended Diagnostics (source + tier)
  - Step 5: Run Recommendations / Quality Warnings
*/

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
const {
  evaluateMarketMemory,
  buildSetupSignature,
} = require("../engines/marketMemoryEngine");
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

const {
  initOutcomeTrackingTable,
  createOutcomeTrackingEntry,
} = require("./outcomeTracking.repository");

const { initJobLocksTable, acquireLock } = require("./jobLock.repository");

const logger = require("../utils/logger");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const HIST_PERIOD = String(process.env.HIST_PERIOD || "1y").toLowerCase();
const MC_SIMS = Number(process.env.MC_SIMS || 800);
const OUTCOME_HORIZON_DAYS = Number(process.env.OUTCOME_HORIZON_DAYS || 30);
const SNAPSHOT_SYMBOL_LIMIT = Number(process.env.SNAPSHOT_SYMBOL_LIMIT || 250);
const SNAPSHOT_REGION = String(process.env.SNAPSHOT_REGION || "us").toLowerCase().trim();
const SNAPSHOT_FAIL_FAST_THRESHOLD = Number(process.env.SNAPSHOT_FAIL_FAST_THRESHOLD || 35);

/* =========================================================
   IN-MEMORY AI STORES
   (später DB/Redis möglich)
========================================================= */

let marketMemoryStore = {};
let metaLearningStore = {};

/* =========================================================
   UTIL
========================================================= */

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function pct(part, total) {
  const p = Number(part);
  const t = Number(total);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return 0;
  return (p / t) * 100;
}

function normalizePriority(priority) {
  return clamp(safeNum(priority, 100), 1, 9999);
}

function classifyPriorityTier(priority) {
  const p = normalizePriority(priority);

  if (p <= 30) return "core";
  if (p <= 80) return "high";
  if (p <= 180) return "standard";
  return "extended";
}

function createEmptyTierStats() {
  return {
    total: 0,
    quotesLoaded: 0,
    normalizedOk: 0,
    historicalOk: 0,
    snapshotsSaved: 0,
    outcomeTracked: 0,
    failed: 0,
    skipped: 0,
  };
}

function createEmptySourceStats() {
  return {
    total: 0,
    normalizedOk: 0,
    snapshotsSaved: 0,
    outcomeTracked: 0,
    failed: 0,
  };
}

function ensureTierBucket(summary, tier) {
  if (!summary.byTier[tier]) {
    summary.byTier[tier] = createEmptyTierStats();
  }
  return summary.byTier[tier];
}

function ensureSourceBucket(summary, source) {
  const key = String(source || "unknown").toUpperCase();
  if (!summary.bySource[key]) {
    summary.bySource[key] = createEmptySourceStats();
  }
  return summary.bySource[key];
}

function buildSystemHealth(summary) {
  const symbolsTotal = safeNum(summary?.symbolsTotal, 0);
  const normalizedOk = safeNum(summary?.normalizedOk, 0);
  const historicalOk = safeNum(summary?.historicalOk, 0);
  const outcomeTracked = safeNum(summary?.outcomeTracked, 0);
  const failed = safeNum(summary?.failed, 0);
  const snapshotsSaved = safeNum(summary?.snapshotsSaved, 0);
  const skipped = safeNum(summary?.skipped, 0);

  const successRate = pct(normalizedOk, symbolsTotal);
  const historicalCoverage = pct(historicalOk, normalizedOk || symbolsTotal);
  const trackingCoverage = pct(outcomeTracked, snapshotsSaved || normalizedOk || symbolsTotal);
  const failureRate = pct(failed, symbolsTotal);
  const skipRate = pct(skipped, symbolsTotal);
  const snapshotCoverage = pct(snapshotsSaved, symbolsTotal);

  const score = clamp(
    Math.round(
      successRate * 0.32 +
      historicalCoverage * 0.20 +
      trackingCoverage * 0.18 +
      snapshotCoverage * 0.20 +
      (100 - failureRate) * 0.07 +
      (100 - skipRate) * 0.03
    ),
    0,
    100
  );

  let status = "critical";
  if (score >= 90) status = "excellent";
  else if (score >= 75) status = "good";
  else if (score >= 55) status = "warning";

  return {
    successRate: Number(successRate.toFixed(2)),
    historicalCoverage: Number(historicalCoverage.toFixed(2)),
    trackingCoverage: Number(trackingCoverage.toFixed(2)),
    snapshotCoverage: Number(snapshotCoverage.toFixed(2)),
    failureRate: Number(failureRate.toFixed(2)),
    skipRate: Number(skipRate.toFixed(2)),
    systemHealthScore: score,
    status,
  };
}

function buildRunRecommendations(summary, health) {
  const recommendations = [];

  if (safeNum(summary.symbolsTotal, 0) < 100) {
    recommendations.push("Watchlist ist noch zu klein für starkes Lernen.");
  }

  if (safeNum(health.successRate, 0) < 85) {
    recommendations.push("Quote-/Normalisierungs-Erfolgsrate prüfen.");
  }

  if (safeNum(health.historicalCoverage, 0) < 70) {
    recommendations.push("Historische Datenabdeckung ist zu niedrig.");
  }

  if (safeNum(health.trackingCoverage, 0) < 85) {
    recommendations.push("Outcome-Tracking schreibt nicht für genug Symbole.");
  }

  if (safeNum(health.failureRate, 0) > 10) {
    recommendations.push("Fehlerquote zu hoch: Provider/Inputs prüfen.");
  }

  if (safeNum(summary.failed, 0) >= SNAPSHOT_FAIL_FAST_THRESHOLD) {
    recommendations.push("Viele Symbolfehler in einem Lauf: genauer Log-Check nötig.");
  }

  if (!recommendations.length) {
    recommendations.push("Lauf sieht gesund aus.");
  }

  return recommendations;
}

async function getSnapshotCandidates(limit = SNAPSHOT_SYMBOL_LIMIT) {
  const lim = clamp(Number(limit) || SNAPSHOT_SYMBOL_LIMIT, 1, 2000);

  const res = await pool.query(
    `
    SELECT
      symbol,
      priority,
      region
    FROM watchlist_symbols
    WHERE is_active = TRUE
      AND LOWER(COALESCE(region, 'us')) = $1
    ORDER BY priority ASC, symbol ASC
    LIMIT $2
    `,
    [SNAPSHOT_REGION || "us", lim]
  );

  const rows = Array.isArray(res.rows) ? res.rows : [];

  if (!rows.length) {
    logger.warn("No snapshot candidates found in watchlist_symbols", {
      region: SNAPSHOT_REGION,
      limit: lim,
    });
    return [];
  }

  const candidates = rows
    .map((row) => {
      const symbol = String(row.symbol || "").trim().toUpperCase();
      const priority = normalizePriority(row.priority);
      const region = String(row.region || "us").toLowerCase();
      const tier = classifyPriorityTier(priority);

      return {
        symbol,
        priority,
        tier,
        region,
      };
    })
    .filter((row) => row.symbol);

  const tierMix = candidates.reduce((acc, item) => {
    acc[item.tier] = (acc[item.tier] || 0) + 1;
    return acc;
  }, {});

  logger.info("Snapshot candidates loaded", {
    count: candidates.length,
    limit: lim,
    region: SNAPSHOT_REGION,
    tierMix,
  });

  return candidates;
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
  await initOutcomeTrackingTable();

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

  const summary = {
    symbolsTotal: 0,
    quotesLoaded: 0,
    normalizedOk: 0,
    historicalOk: 0,
    hqsBuilt: 0,
    snapshotsSaved: 0,
    hqsSaved: 0,
    outcomeTracked: 0,
    skipped: 0,
    failed: 0,
    byTier: {},
    bySource: {},
  };

  const candidates = await getSnapshotCandidates(SNAPSHOT_SYMBOL_LIMIT);
  summary.symbolsTotal = candidates.length;

  if (!candidates.length) {
    const health = buildSystemHealth(summary);
    const recommendations = buildRunRecommendations(summary, health);

    logger.warn("No symbols available for snapshot run");
    logger.info("Snapshot complete", {
      summary,
      health,
      recommendations,
    });
    return;
  }

  for (const candidate of candidates) {
    const symbol = candidate.symbol;
    const tier = candidate.tier;

    ensureTierBucket(summary, tier).total++;

    try {
      const raw = await fetchQuote(symbol);
      if (!raw || !raw.length) {
        summary.skipped++;
        ensureTierBucket(summary, tier).skipped++;
        continue;
      }

      summary.quotesLoaded++;
      ensureTierBucket(summary, tier).quotesLoaded++;

      const providerSource = String(raw?.[0]?.source || "massive").toLowerCase();
      ensureSourceBucket(summary, providerSource).total++;

      const normalized = normalizeMarketData(raw[0], providerSource, "us");
      if (!normalized) {
        summary.skipped++;
        ensureTierBucket(summary, tier).skipped++;
        continue;
      }

      summary.normalizedOk++;
      ensureTierBucket(summary, tier).normalizedOk++;
      ensureSourceBucket(summary, providerSource).normalizedOk++;

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
          summary.historicalOk++;
          ensureTierBucket(summary, tier).historicalOk++;

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
        } else {
          logger.warn("Historical insufficient", {
            symbol,
            points: prices.length,
            period: HIST_PERIOD,
            tier,
          });
        }
      } catch (histErr) {
        logger.warn("Historical unavailable", {
          symbol,
          message: histErr.message,
          tier,
        });
      }

      const hqs = await buildHQSResponse(
        normalized,
        0,
        adaptiveWeights,
        regime
      );

      if (hqs) {
        summary.hqsBuilt++;
      }

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

      const macroContext = buildMacroContextFallback({
        trendData,
        normalized,
      });

      const crossAsset = analyzeCrossAssetEnvironment(macroContext);

      const capitalFlows = analyzeCapitalFlows(
        buildCapitalFlowFallback({ normalized })
      );

      const eventIntelligence = analyzeMacroEvents(macroContext);

      const setupSignature = buildSetupSignature({
        regime,
        strategy: strategy?.strategy || "balanced",
        discoveries,
        narratives,
        features,
        crossSignals: crossAsset?.signals || [],
      });

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
          marketBreadth:
            capitalFlows?.marketBreadth ?? macroContext.marketBreadth,
        },
        eventIntelligence,
        marketMemory,
        metaLearning,
      });

      const finalView = buildIntegratedMarketView({
        symbol,
        hqs,
        features,
        discoveries,
        learning: {
          confidence: 0.5,
        },
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
        tier,
        priority: candidate.priority,
        source: normalized.source,
        finalConviction: finalView?.finalConviction,
        finalRating: finalView?.finalRating,
        aiScore: brain?.aiScore,
        opportunityStrength: orchestrator?.opportunityStrength,
        orchestratorConfidence: orchestrator?.orchestratorConfidence,
      });

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
      summary.snapshotsSaved++;
      ensureTierBucket(summary, tier).snapshotsSaved++;
      ensureSourceBucket(summary, providerSource).snapshotsSaved++;

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
      summary.hqsSaved++;

      const trackingEntry = await createOutcomeTrackingEntry({
        symbol: normalized.symbol,
        predictionType: "market_view",
        regime,
        strategy: strategy?.strategy || "balanced",
        hqsScore: hqs?.hqsScore,
        aiScore: brain?.aiScore,
        finalConviction: finalView?.finalConviction,
        finalConfidence: finalView?.finalConfidence,
        memoryScore: marketMemory?.memoryStats?.memoryScore || 0,
        opportunityStrength: orchestrator?.opportunityStrength || 0,
        orchestratorConfidence:
          orchestrator?.orchestratorConfidence || 0,
        setupSignature,
        horizonDays: OUTCOME_HORIZON_DAYS,
        entryPrice: normalized?.price,
        payload: {
          symbol: normalized.symbol,
          priority: candidate.priority,
          tier,
          region: candidate.region,
          regime,
          hqs,
          features,
          discoveries,
          narratives,
          simulations,
          resilienceScore,
          research,
          brain,
          strategy,
          orchestrator,
          finalView,
        },
      });

      if (trackingEntry) {
        summary.outcomeTracked++;
        ensureTierBucket(summary, tier).outcomeTracked++;
        ensureSourceBucket(summary, providerSource).outcomeTracked++;
      }

      logger.info(`Snapshot saved for ${symbol}`);
    } catch (err) {
      summary.failed++;
      ensureTierBucket(summary, tier).failed++;

      logger.error(`Snapshot error for ${symbol}`, {
        message: err.message,
        tier,
        priority: candidate.priority,
      });
    }
  }

  const health = buildSystemHealth(summary);
  const recommendations = buildRunRecommendations(summary, health);

  logger.info("Snapshot complete", {
    summary,
    health,
    recommendations,
  });
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

      const providerSource = String(raw?.[0]?.source || "massive").toLowerCase();
      const normalized = normalizeMarketData(raw[0], providerSource, "us");
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
