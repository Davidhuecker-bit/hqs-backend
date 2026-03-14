"use strict";

const { Pool } = require("pg");
const logger = require("../utils/logger");

const { buildAIScore } = require("../engines/marketBrain");
const { applyStrategy } = require("../engines/strategyEngine");
const { detectNarrative } = require("../engines/narrativeEngine");
const { discoverOpportunities } = require("../engines/discoveryEngine");
const {
  runMarketSimulations,
  calculateResilience,
} = require("../engines/marketSimulationEngine");
const { buildFeatures } = require("../engines/featureEngine");
const { buildIntegratedMarketView } = require("../engines/integrationEngine");

const { analyzeCrossAssetEnvironment } = require("../engines/crossAssetEngine");
const { analyzeCapitalFlows } = require("../engines/capitalFlowEngine");
const { analyzeMacroEvents } = require("../engines/eventIntelligenceEngine");
const { evaluateMarketMemory } = require("../engines/marketMemoryEngine");
const { evaluateMetaLearning } = require("../engines/metaLearningEngine");
const { orchestrateMarket } = require("../engines/marketOrchestrator");
const {
  getScoringActiveNewsContextBySymbols,
} = require("./marketNews.service");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =========================================================
   IN-MEMORY PREVIEW STORES
========================================================= */

let marketMemoryStore = {};
let metaLearningStore = {};
const OPPORTUNITY_NEWS_LIMIT = Math.max(
  1,
  Math.min(Number(process.env.OPPORTUNITY_NEWS_LIMIT || 5), 10)
);

/* =========================================================
   UTIL
========================================================= */

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function norm0to1(x) {
  const n = safeNum(x, 0);
  if (n > 1.5) return clamp(n / 100, 0, 1);
  return clamp(n, 0, 1);
}

/* =========================================================
   FALLBACK CONTEXT HELPERS
========================================================= */

function buildMacroContextFallback(row = {}) {
  return {
    vixTrend: safeNum(row?.volatility, 0) - 0.2,
    marketBreadth: safeNum(row?.trend, 0) > 0 ? 0.62 : 0.42,
    dollarTrend: 0,
    marketTrend: safeNum(row?.trend, 0),
    oilTrend: 0,
    goldTrend: 0,
    bondTrend: 0,
    techTrend: safeNum(row?.trend, 0),
  };
}

function buildCapitalFlowFallback(row = {}) {
  const volume = safeNum(row?.volume, 0);
  const avgVolume = safeNum(row?.avg_volume, volume || 1);

  return {
    sectorData: row?.sector
      ? [
          {
            sector: String(row.sector).toLowerCase(),
            performance: safeNum(row?.trend, 0),
          },
        ]
      : [],
    etfFlows: [],
    advancers: safeNum(row?.trend, 0) >= 0 ? 3200 : 1800,
    decliners: safeNum(row?.trend, 0) >= 0 ? 1800 : 3200,
    volumeData: {
      volume,
      avgVolume,
    },
  };
}

/* =========================================================
   OPPORTUNITY SCORE
========================================================= */

function calculateOpportunityScore(row) {
  const hqs = safeNum(row.hqs_score, 0);

  const momentum = norm0to1(row.momentum);
  const quality = norm0to1(row.quality);
  const stability = norm0to1(row.stability);
  const relative = norm0to1(row.relative);

  const volatility = safeNum(row.volatility, 0);

  const score =
    hqs * 0.55 +
    momentum * 10 +
    quality * 18 +
    stability * 18 +
    relative * 10 -
    volatility * 12;

  return clamp(Number(score.toFixed(2)), 0, 100);
}

/* =========================================================
   CONFIDENCE SCORE
========================================================= */

function calculateConfidence(row, opportunityScore) {
  const hqs = safeNum(row.hqs_score, 0);
  const quality = norm0to1(row.quality);
  const stability = norm0to1(row.stability);
  const volatility = safeNum(row.volatility, 0);

  let c =
    hqs * 0.35 +
    quality * 25 +
    stability * 25 -
    volatility * 18 +
    clamp(opportunityScore, -20, 80) * 0.3;

  return clamp(Math.round(c), 0, 100);
}

/* =========================================================
   OPPORTUNITY TYPE
========================================================= */

function classifyOpportunity(row) {
  const momentum = norm0to1(row.momentum);
  const quality = norm0to1(row.quality);
  const stability = norm0to1(row.stability);
  const volatility = safeNum(row.volatility, 0);
  const trend = safeNum(row.trend, 0);

  if (momentum > 0.75) return "momentum";

  if (trend > 0.10 && volatility < 0.30) {
    return "breakout";
  }

  if (quality > 0.7 && stability > 0.7) {
    return "quality";
  }

  return "balanced";
}

/* =========================================================
   REASON GENERATOR
========================================================= */

function generateReason(row, newsContext = null) {
  const reasons = [];

  const quality = norm0to1(row.quality);
  const stability = norm0to1(row.stability);
  const relative = norm0to1(row.relative);
  const momentum = norm0to1(row.momentum);
  const volatility = safeNum(row.volatility, 0);

  if (quality >= 0.65) reasons.push("gute Firma");
  if (stability >= 0.65) reasons.push("stabil");
  if (relative >= 0.65) reasons.push("stärker als der Markt");

  if (momentum >= 0.50 && momentum <= 0.85) {
    reasons.push("läuft gut");
  }

  if (volatility > 0.9) {
    reasons.push("hohe Schwankung");
  }

  if (safeNum(newsContext?.activeCount, 0) > 0) {
    if (newsContext?.direction === "bullish") {
      reasons.push("positive News-Lage");
    } else if (newsContext?.direction === "bearish") {
      reasons.push("negative News-Lage");
    }

    if (newsContext?.dominantEventType) {
      reasons.push(`News-Fokus ${newsContext.dominantEventType}`);
    }
  }

  if (!reasons.length) {
    reasons.push("solide Werte");
  }

  return Array.from(new Set(reasons)).slice(0, 4).join(" + ");
}

/* =========================================================
   MAIN SERVICE
========================================================= */

async function getTopOpportunities(arg = 10) {
  let options;

  if (typeof arg === "object" && arg !== null) {
    options = arg;
  } else {
    options = { limit: Number(arg) || 10 };
  }

  const limit = clamp(Number(options.limit || 10), 1, 25);

  const minHqs =
    options.minHqs === null || options.minHqs === undefined
      ? null
      : clamp(Number(options.minHqs), 0, 100);

  const regime =
    options.regime
      ? String(options.regime).trim().toLowerCase()
      : null;

  const res = await pool.query(`
    WITH latest_hqs AS (
      SELECT DISTINCT ON (symbol)
        symbol,
        hqs_score,
        momentum,
        quality,
        stability,
        relative,
        regime,
        created_at
      FROM hqs_scores
      ORDER BY symbol, created_at DESC
    )

    SELECT
      h.symbol,
      h.hqs_score,
      h.momentum,
      h.quality,
      h.stability,
      h.relative,
      COALESCE(h.regime, m.regime) AS regime,

      COALESCE(
        m.volatility,
        m.volatility_annual,
        m.vol_annual,
        0
      ) AS volatility,

      m.trend,
      m.scenarios,
      m.updated_at AS advanced_updated_at

    FROM latest_hqs h
    LEFT JOIN market_advanced_metrics m
      ON m.symbol = h.symbol

    ORDER BY h.hqs_score DESC
    LIMIT 250
  `);

  let rows = res.rows || [];

  if (minHqs !== null) {
    rows = rows.filter((r) => safeNum(r.hqs_score, 0) >= minHqs);
  }

  if (regime) {
    rows = rows.filter(
      (r) => String(r.regime || "").toLowerCase() === regime
    );
  }

  let newsContextBySymbol = {};
  if (rows.length) {
    try {
      newsContextBySymbol = await getScoringActiveNewsContextBySymbols(
        rows.map((row) => row.symbol),
        OPPORTUNITY_NEWS_LIMIT
      );
    } catch (error) {
      logger.warn("Opportunity news context load failed", {
        message: error.message,
      });
    }
  }

  const opportunities = rows.map((row) => {
    const newsContext = newsContextBySymbol?.[row.symbol] || null;
    const opportunityScore = calculateOpportunityScore(row);

    const features = buildFeatures(row, {
      trend: row.trend,
      volatilityAnnual: row.volatility,
      avgVolume: row.avg_volume,
    });

    const discoveries = discoverOpportunities(
      row.symbol,
      row,
      features,
      row
    );

    const narratives = detectNarrative({
      sector: row.sector,
      trend: row.trend,
      relative: row.relative,
    });

    const simulations = runMarketSimulations(features, row);
    const resilienceScore = calculateResilience(simulations);

    const brain = buildAIScore({
      symbol: row.symbol,
      hqsScore: row.hqs_score,
      features,
      advanced: row,
      discoveries,
    });

    const strategy = applyStrategy(
      row.symbol,
      brain.aiScore,
      features,
      row
    );

    /* =============================
       NEW MACRO / FLOW / EVENT LAYER
    ============================= */

    const macroContext = buildMacroContextFallback(row);
    const crossAsset = analyzeCrossAssetEnvironment(macroContext);
    const capitalFlows = analyzeCapitalFlows(buildCapitalFlowFallback(row));
    const eventIntelligence = analyzeMacroEvents(macroContext);

    /* =============================
       MEMORY + META LEARNING PREVIEW
    ============================= */

    const marketMemory = evaluateMarketMemory({
      memoryStore: marketMemoryStore,
      symbol: row.symbol,
      regime: row.regime || "neutral",
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
        regime: row.regime || "neutral",
        riskMode: "neutral",
        strategy: strategy?.strategy || "balanced",
        dominantNarrative: narratives?.[0]?.type || "none",
      },
      signalMetrics: {
        trendScore: safeNum(row?.trend, 0),
        discoveryCount: discoveries?.length || 0,
        capitalFlowStrength: capitalFlows?.marketBreadth || 0,
        eventCount: eventIntelligence?.events?.length || 0,
        memoryScore: marketMemory?.memoryStats?.memoryScore || 0,
        narrativeCount: narratives?.length || 0,
        newsActiveCount: safeNum(newsContext?.activeCount, 0),
        newsStrength: safeNum(newsContext?.strengthScore, 0),
        strategyScore: safeNum(strategy?.strategyAdjustedScore, 0),
        crossAssetCount: crossAsset?.signals?.length || 0,
      },
      actualReturn: 0,
      symbol: row.symbol,
      persist: false,
    });

    /* =============================
       ORCHESTRATOR
    ============================= */

    const orchestrator = orchestrateMarket({
      trendData: row,
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
      newsContext,
    });

    /* =============================
       FINAL INTEGRATION
    ============================= */

    const finalView = buildIntegratedMarketView({
      symbol: row.symbol,
      hqs: {
        hqsScore: row.hqs_score,
        regime: row.regime,
      },
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
      research: null,
      newsContext,
      globalContext: {
        crossAsset,
        capitalFlows,
        eventIntelligence,
        orchestrator,
        marketMemory: marketMemory?.memoryStats || null,
        metaLearning: metaLearning?.trustProfile || null,
        newsContext,
      },
    });

    return {
      symbol: String(row.symbol || "").toUpperCase(),

      regime: row.regime ?? null,
      type: classifyOpportunity(row),

      hqsScore: safeNum(row.hqs_score, 0),
      opportunityScore,
      confidence: calculateConfidence(row, opportunityScore),

      aiScore: safeNum(brain?.aiScore, 0),
      finalConviction: safeNum(finalView?.finalConviction, 0),
      finalConfidence: safeNum(finalView?.finalConfidence, 0),
      finalRating: finalView?.finalRating || null,
      finalDecision: finalView?.finalDecision || null,

      strategy: strategy?.strategy || null,
      strategyLabel: strategy?.strategyLabel || null,

      narratives,
      discoveries,

      trend: row.trend ?? null,
      volatility: row.volatility ?? null,
      resilienceScore,

      opportunityStrength: safeNum(
        orchestrator?.opportunityStrength,
        0
      ),
      orchestratorConfidence: safeNum(
        orchestrator?.orchestratorConfidence,
        0
      ),

      whyInteresting: finalView?.whyInteresting || [],
      reason: generateReason(row, newsContext),
      newsContext:
        newsContext && safeNum(newsContext?.activeCount, 0) > 0
          ? {
              activeCount: safeNum(newsContext?.activeCount, 0),
              direction: newsContext?.direction || "neutral",
              directionScore: safeNum(newsContext?.directionScore, 0),
              strengthScore: safeNum(newsContext?.strengthScore, 0),
              dominantEventType: newsContext?.dominantEventType || null,
              weightedRelevance: safeNum(newsContext?.weightedRelevance, 0),
              weightedConfidence: safeNum(newsContext?.weightedConfidence, 0),
              weightedMarketImpact: safeNum(newsContext?.weightedMarketImpact, 0),
              summary: newsContext?.summary || null,
            }
          : null,
      newsAdjustment: safeNum(finalView?.components?.newsAdjustment, 0),

      marketMemory: marketMemory?.memoryStats || null,
      metaLearning: metaLearning?.trustProfile || null,

      advancedUpdatedAt: row.advanced_updated_at
        ? new Date(row.advanced_updated_at).toISOString()
        : null,
    };
  });

  opportunities.sort((a, b) => {
    if (b.finalConviction !== a.finalConviction) {
      return b.finalConviction - a.finalConviction;
    }

    if (b.finalConfidence !== a.finalConfidence) {
      return b.finalConfidence - a.finalConfidence;
    }

    return b.opportunityScore - a.opportunityScore;
  });

  const out = opportunities.slice(0, limit);

  logger.info("getTopOpportunities", {
    limit,
    minHqs,
    regime,
    returned: out.length,
  });

  return out;
}

module.exports = {
  getTopOpportunities,
};
