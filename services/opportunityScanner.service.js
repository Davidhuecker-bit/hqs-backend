"use strict";

const { Pool } = require("pg");
const logger = require("../utils/logger");

const {
  buildScoringNewsContext,
  getScoringActiveMarketNewsBySymbols,
} = require("./marketNews.service");
const {
  loadLatestOutcomeTrackingBySymbols,
  buildStructuredPatternSignature,
  getPatternStats,
} = require("./outcomeTracking.repository");
const {
  loadRuntimeState,
  RUNTIME_STATE_MARKET_MEMORY_KEY,
  RUNTIME_STATE_META_LEARNING_KEY,
} = require("./discoveryLearning.repository");
const { buildMarketSentiment } = require("./marketSentiment.service");
const { buildMarketBuzz } = require("./marketBuzz.service");
const { buildTrendingStock } = require("./trendingStocks.service");
const { buildEarlySignals } = require("./earlySignal.service");
const { classifyMarketRegime } = require("./regimeDetection.service");
const { recordAutonomyDecision, logNearMiss } = require("./autonomyAudit.repository");
const { runAgenticDebate } = require("./agenticDebate.service");
const { getInterMarketCorrelation } = require("./interMarketCorrelation.service");
const { logAgentForecasts } = require("./agentForecast.repository");
const { getAgentWeights, buildMetaRationale } = require("./causalMemory.repository");
const { getSharpenedThresholds } = require("./sectorCoherence.service");
// World State: unified global market truth (regime + cross-asset + sector + agents)
const { getWorldState, classifyWorldStateAge } = require("./worldState.service");
// Capital Allocation Layer: position sizing, risk-budget, sector caps
const { applyCapitalAllocation } = require("./capitalAllocation.service");
// Portfolio Twin: virtual position tracking (Stage 2 – auto live-integration)
const {
  hasOpenVirtualPosition,
  openVirtualPositionFromAllocation,
} = require("./portfolioTwin.service");
// Step 4: Personalized Decision Layer – portfolio/watchlist context per symbol
const {
  buildPortfolioContextForSymbols,
  enrichWithPortfolioContext,
} = require("./portfolioContext.service");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =========================================================
   IN-MEMORY PREVIEW STORES
========================================================= */

let marketMemoryStore = {};
let metaLearningStore = {};
let runtimePreviewStoresLoaded = false;
const OPPORTUNITY_NEWS_LIMIT = Math.max(
  1,
  Math.min(Number(process.env.OPPORTUNITY_NEWS_LIMIT || 5), 10)
);
const OPPORTUNITY_REASON_LIMIT = 4;
const SIGNAL_REASON_LIMIT = 4;
const SIGNAL_DIRECTION_THRESHOLD = 0.12;

/* =========================================================
   GUARDIAN PROTOCOL CONSTANTS
========================================================= */

// Base robustness thresholds per market cluster (executeSafetyFirst)
const GUARDIAN_THRESHOLD_SAFE = Number(
  process.env.GUARDIAN_THRESHOLD_SAFE || 0.35
);
const GUARDIAN_THRESHOLD_VOLATILE = Number(
  process.env.GUARDIAN_THRESHOLD_VOLATILE || 0.50
);
const GUARDIAN_THRESHOLD_DANGER = Number(
  process.env.GUARDIAN_THRESHOLD_DANGER || 0.65
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

function safeObject(value, fallback = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }

  try {
    if (typeof structuredClone === "function") {
      return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return fallback;
  }
}

/**
 * Returns a small sort-score adjustment for a candidate based on its
 * portfolio intelligence context.  Diversifiers get a gentle boost;
 * candidates that would increase concentration risk get a gentle penalty.
 * The delta is kept small (±5) so conviction/confidence remain dominant.
 *
 * @param {object|null} ctx  – portfolioContext from enrichWithPortfolioContext
 * @returns {number}  adjustment to add to the effective conviction score
 */
const PORTFOLIO_DIVERSIFICATION_BONUS    =  3;
const PORTFOLIO_HIGH_CONCENTRATION_PENALTY = -5;
const PORTFOLIO_MED_CONCENTRATION_PENALTY  = -2;

function _portfolioIntelligenceBonus(ctx) {
  if (!ctx) return 0;
  let bonus = 0;
  if (ctx.diversificationBenefit) bonus += PORTFOLIO_DIVERSIFICATION_BONUS;
  if (ctx.concentrationRisk === "high")   bonus += PORTFOLIO_HIGH_CONCENTRATION_PENALTY;
  else if (ctx.concentrationRisk === "medium") bonus += PORTFOLIO_MED_CONCENTRATION_PENALTY;
  return bonus;
}

async function ensureRuntimePreviewStoresLoaded() {
  if (runtimePreviewStoresLoaded) return;

  const [persistedMarketMemory, persistedMetaLearning] = await Promise.all([
    loadRuntimeState(RUNTIME_STATE_MARKET_MEMORY_KEY),
    loadRuntimeState(RUNTIME_STATE_META_LEARNING_KEY),
  ]);

  marketMemoryStore = safeObject(persistedMarketMemory, {});
  metaLearningStore = safeObject(persistedMetaLearning, {});
  runtimePreviewStoresLoaded = true;
}

function norm0to1(x) {
  const n = safeNum(x, 0);
  if (n > 1.5) return clamp(n / 100, 0, 1);
  return clamp(n, 0, 1);
}

function uniqueTexts(values = [], maxItems = SIGNAL_REASON_LIMIT) {
  const seen = new Set();
  const result = [];

  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "")
      .replace(/\s+/g, " ")
      .trim();

    if (!text) continue;

    const key = text.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(text);

    if (result.length >= maxItems) break;
  }

  return result;
}

function normalizeSignalDirection(directionScore) {
  const score = clamp(safeNum(directionScore, 0), -1, 1);

  if (score >= SIGNAL_DIRECTION_THRESHOLD) return "bullish";
  if (score <= -SIGNAL_DIRECTION_THRESHOLD) return "bearish";
  return "neutral";
}

function buildSignalSummary(signalContext = {}) {
  if (!signalContext || typeof signalContext !== "object") return null;

  const parts = [];
  const direction = signalContext.signalDirection || "neutral";
  const earlySignalType = signalContext.earlySignalType || null;
  const trendLevel = signalContext.trendLevel || null;
  const buzzScore = clamp(safeNum(signalContext.buzzScore, 0), 0, 100);
  const signalStrength = clamp(safeNum(signalContext.signalStrength, 0), 0, 100);

  if (direction === "bullish") {
    parts.push("bullisches Signal");
  } else if (direction === "bearish") {
    parts.push("bearisches Signal");
  } else if (signalStrength > 0) {
    parts.push("neutrales Signal");
  }

  if (trendLevel) {
    parts.push(`Trend ${trendLevel}`);
  }

  if (earlySignalType === "potential_breakout") {
    parts.push("frühes Breakout");
  } else if (earlySignalType === "early_interest") {
    parts.push("frühes Interesse");
  }

  if (buzzScore >= 60) {
    parts.push(`Buzz ${Math.round(buzzScore)}`);
  }

  return parts.length ? parts.join(" · ") : null;
}

function buildSignalReasons({
  sentimentScore,
  buzzScore,
  trendLevel,
  earlySignalType,
  newsContext,
}) {
  const reasons = [];

  if (earlySignalType === "potential_breakout") {
    reasons.push("frühes Breakout-Signal");
  } else if (earlySignalType === "early_interest") {
    reasons.push("frühes Marktinteresse");
  }

  if (trendLevel === "exploding" || trendLevel === "very_hot") {
    reasons.push(`Trend ${trendLevel}`);
  } else if (trendLevel === "hot") {
    reasons.push("Trend hot");
  }

  if (buzzScore >= 70) {
    reasons.push("hoher Markt-Buzz");
  } else if (buzzScore >= 50) {
    reasons.push("solider Markt-Buzz");
  }

  if (sentimentScore >= 20) {
    reasons.push("positives Sentiment");
  } else if (sentimentScore <= -20) {
    reasons.push("negatives Sentiment");
  }

  if (!reasons.length) {
    reasons.push(...uniqueTexts(newsContext?.reasons, SIGNAL_REASON_LIMIT));
  }

  return uniqueTexts(reasons, SIGNAL_REASON_LIMIT);
}

function buildSignalContext(row = {}, newsContext = null, newsItems = [], socialPosts = []) {
  const symbol = String(row?.symbol || "").trim().toUpperCase();
  if (!symbol) return null;

  const marketSentiment = buildMarketSentiment({
    sentimentScore:
      newsContext?.marketSentiment?.sentimentScore ??
      safeNum(newsContext?.directionScore, 0) * 100,
    buzzScore:
      newsContext?.marketSentiment?.buzzScore ??
      newsContext?.strengthScore ??
      0,
    mentionCount:
      newsContext?.marketSentiment?.mentionCount ??
      newsContext?.activeCount ??
      0,
    reasons:
      newsContext?.marketSentiment?.reasons?.length
        ? newsContext.marketSentiment.reasons
        : newsContext?.reasons,
    sourceBreakdown: newsContext?.marketSentiment?.sourceBreakdown,
  });

  const marketBuzz =
    buildMarketBuzz({
      newsItems: Array.isArray(newsItems) ? newsItems : [],
      socialPosts: Array.isArray(socialPosts) ? socialPosts : [],
    }).find((entry) => String(entry?.symbol || "").toUpperCase() === symbol) || null;

  const momentumScore = Math.round(norm0to1(row?.momentum) * 100);
  const trendSignal = buildTrendingStock({
    symbol,
    buzzScore:
      marketBuzz?.buzzScore ??
      safeNum(marketSentiment?.buzzScore, 0),
    priceMomentum: momentumScore,
  });

  const earlySignal = buildEarlySignals([
    {
      symbol,
      buzzScore:
        trendSignal?.buzzScore ??
        marketBuzz?.buzzScore ??
        0,
      priceMomentum: trendSignal?.priceMomentum ?? momentumScore,
      trendScore: trendSignal?.trendScore,
      trendLevel: trendSignal?.trendLevel,
    },
  ])[0] || null;

  const sentimentScore = clamp(
    safeNum(marketSentiment?.sentimentScore, 0),
    -100,
    100
  );
  const buzzScore = clamp(
    safeNum(marketBuzz?.buzzScore, marketSentiment?.buzzScore),
    0,
    100
  );
  const trendScore = clamp(safeNum(trendSignal?.trendScore, 0), 0, 100);
  const earlySignalStrength = clamp(safeNum(earlySignal?.strength, 0), 0, 100);
  const trendBias = clamp(safeNum(row?.trend, 0), -1, 1);
  const momentumBias = clamp((momentumScore - 50) / 50, -1, 1);
  const normalizedSentimentDirection = (sentimentScore / 100) * 0.5;
  const normalizedSentimentStrength = Math.abs(sentimentScore) * 0.2;

  let signalDirectionScore = clamp(
    normalizedSentimentDirection + momentumBias * 0.35 + trendBias * 0.15,
    -1,
    1
  );

  if (earlySignal?.signal && signalDirectionScore >= 0) {
    signalDirectionScore = clamp(signalDirectionScore + 0.08, -1, 1);
  }

  const signalStrength = clamp(
    Math.round(
      trendScore * 0.55 +
        normalizedSentimentStrength +
        buzzScore * 0.1 +
        earlySignalStrength * 0.15
    ),
    0,
    100
  );

  const directionAligned =
    (signalDirectionScore >= SIGNAL_DIRECTION_THRESHOLD && trendBias >= 0) ||
    (signalDirectionScore <= -SIGNAL_DIRECTION_THRESHOLD && trendBias < 0);

  const signalConfidence = clamp(
    Math.round(
      signalStrength * 0.45 +
        clamp(safeNum(newsContext?.weightedConfidence, 0), 0, 100) * 0.25 +
        clamp(safeNum(newsContext?.activeCount, 0), 0, 4) * 5 +
        (directionAligned ? 10 : 0)
    ),
    0,
    100
  );

  const signalContext = {
    sentimentScore,
    buzzScore,
    trendScore,
    trendLevel: trendSignal?.trendLevel || null,
    earlySignalType: earlySignal?.signal || null,
    earlySignalStrength,
    signalStrength,
    signalDirection: normalizeSignalDirection(signalDirectionScore),
    signalDirectionScore: Number(signalDirectionScore.toFixed(2)),
    signalConfidence,
    summary: null,
    reasons: [],
  };

  signalContext.summary = buildSignalSummary(signalContext);
  signalContext.reasons = buildSignalReasons({
    sentimentScore,
    buzzScore,
    trendLevel: signalContext.trendLevel,
    earlySignalType: signalContext.earlySignalType,
    newsContext,
  });

  return signalContext;
}

async function loadOpportunityNewsContextBySymbols(
  symbols = [],
  limitPerSymbol = OPPORTUNITY_NEWS_LIMIT
) {
  const normalizedSymbols = [
    ...new Set(
      (Array.isArray(symbols) ? symbols : [])
        .map((symbol) => String(symbol || "").trim().toUpperCase())
        .filter(Boolean)
    ),
  ];

  if (!normalizedSymbols.length) {
    return {
      scoringActiveNewsBySymbol: {},
      newsContextBySymbol: {},
    };
  }

  const scoringActiveNewsBySymbol = await getScoringActiveMarketNewsBySymbols(
    normalizedSymbols,
    limitPerSymbol
  );

  const newsContextBySymbol = normalizedSymbols.reduce((result, symbol) => {
    result[symbol] = buildScoringNewsContext(
      scoringActiveNewsBySymbol?.[symbol] || []
    );
    return result;
  }, {});

  return {
    scoringActiveNewsBySymbol,
    newsContextBySymbol,
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
   STRESS-TEST ENGINE
========================================================= */

const STRESS_SCENARIO_COUNT = 10;
const STRESS_PERCENT_MIN = 0.05;
const STRESS_PERCENT_MAX = 0.15;
const STRESS_ANTIFRAGILE_THRESHOLD = 0.8;
const STRESS_MIN_HQS_SCORE = 35;
const STRESS_MIN_OPPORTUNITY_SCORE = 30;
const STRESS_MIN_OPPORTUNITY_STRENGTH = 20;

function randomStressFactor() {
  return STRESS_PERCENT_MIN + Math.random() * (STRESS_PERCENT_MAX - STRESS_PERCENT_MIN);
}

function simulateMarketStress(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return [];

  const variants = [];

  for (let i = 0; i < STRESS_SCENARIO_COUNT; i++) {
    const volumeStress = randomStressFactor();
    const rsiStress = randomStressFactor();
    const priceStress = randomStressFactor();

    const features = safeObject(snapshot.features, {});
    const signalCtx = safeObject(snapshot.signalContext, {});
    const orchestratorCtx = safeObject(snapshot.orchestrator, {});

    variants.push({
      hqsScore: safeNum(snapshot.hqsScore, 0),
      features: {
        momentum: Math.max(0, safeNum(features.momentum, 0) * (1 - rsiStress)),
        quality: safeNum(features.quality, 0),
        stability: safeNum(features.stability, 0),
        relative: Math.max(0, safeNum(features.relative, 0) * (1 - rsiStress)),
        volatility: safeNum(features.volatility, 0),
        trendStrength: Math.max(0, safeNum(features.trendStrength, 0) * (1 - rsiStress)),
        relativeVolume: Math.max(0, safeNum(features.relativeVolume, 0) * (1 - volumeStress)),
        liquidityScore: Math.max(0, safeNum(features.liquidityScore, 0) * (1 - volumeStress)),
      },
      signalContext: {
        signalStrength: Math.max(0, safeNum(signalCtx.signalStrength, 0) * (1 - rsiStress)),
        trendScore: Math.max(0, safeNum(signalCtx.trendScore, 0) * (1 - rsiStress)),
        signalDirectionScore: safeNum(signalCtx.signalDirectionScore, 0),
        signalConfidence: safeNum(signalCtx.signalConfidence, 0),
        buzzScore: Math.max(0, safeNum(signalCtx.buzzScore, 0) * (1 - volumeStress)),
        sentimentScore: safeNum(signalCtx.sentimentScore, 0),
        trendLevel: signalCtx.trendLevel || null,
        earlySignalType: signalCtx.earlySignalType || null,
      },
      orchestrator: {
        opportunityStrength: Math.max(0, safeNum(orchestratorCtx.opportunityStrength, 0) * (1 - priceStress)),
        orchestratorConfidence: Math.max(0, safeNum(orchestratorCtx.orchestratorConfidence, 0) * (1 - priceStress)),
      },
      entryPrice: Math.max(0, safeNum(snapshot.entryPrice, 0) * (1 - priceStress)),
    });
  }

  return variants;
}

function meetsMinimumSignalCriteria(stressedSnapshot) {
  const hqs = safeNum(stressedSnapshot?.hqsScore, 0);
  const features = stressedSnapshot?.features || {};

  const stressedRow = {
    hqs_score: hqs,
    momentum: features.momentum,
    quality: features.quality,
    stability: features.stability,
    relative: features.relative,
    volatility: features.volatility,
  };

  const opportunityScore = calculateOpportunityScore(stressedRow);
  const opportunityStrength = safeNum(stressedSnapshot?.orchestrator?.opportunityStrength, 0);

  return (
    hqs >= STRESS_MIN_HQS_SCORE &&
    opportunityScore >= STRESS_MIN_OPPORTUNITY_SCORE &&
    opportunityStrength >= STRESS_MIN_OPPORTUNITY_STRENGTH
  );
}

function calculateRobustnessScore(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return 0;

  const variants = simulateMarketStress(snapshot);
  if (!variants.length) return 0;

  const passing = variants.filter((v) => meetsMinimumSignalCriteria(v)).length;
  return Number((passing / variants.length).toFixed(2));
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

  return Array.from(new Set(reasons)).slice(0, OPPORTUNITY_REASON_LIMIT).join(" + ");
}

function formatOpportunityNewsContext(newsContext = null) {
  if (!newsContext || safeNum(newsContext?.activeCount, 0) <= 0) return null;

  return {
    activeCount: safeNum(newsContext?.activeCount, 0),
    direction: newsContext?.direction || "neutral",
    directionScore: safeNum(newsContext?.directionScore, 0),
    strengthScore: safeNum(newsContext?.strengthScore, 0),
    dominantEventType: newsContext?.dominantEventType || null,
    weightedRelevance: safeNum(newsContext?.weightedRelevance, 0),
    weightedConfidence: safeNum(newsContext?.weightedConfidence, 0),
    weightedMarketImpact: safeNum(newsContext?.weightedMarketImpact, 0),
    summary: newsContext?.summary || null,
  };
}

function formatOpportunitySignalContext(signalContext = null) {
  if (!signalContext || safeNum(signalContext?.signalStrength, 0) <= 0) return null;

  return {
    sentimentScore: safeNum(signalContext?.sentimentScore, 0),
    buzzScore: safeNum(signalContext?.buzzScore, 0),
    trendScore: safeNum(signalContext?.trendScore, 0),
    trendLevel: signalContext?.trendLevel || null,
    earlySignalType: signalContext?.earlySignalType || null,
    earlySignalStrength: safeNum(signalContext?.earlySignalStrength, 0),
    signalStrength: safeNum(signalContext?.signalStrength, 0),
    signalDirection: signalContext?.signalDirection || "neutral",
    signalDirectionScore: safeNum(signalContext?.signalDirectionScore, 0),
    signalConfidence: safeNum(signalContext?.signalConfidence, 0),
    summary: signalContext?.summary || null,
    reasons: Array.isArray(signalContext?.reasons)
      ? signalContext.reasons.slice(0, SIGNAL_REASON_LIMIT)
      : [],
  };
}

function hasPersistedBatchResult(tracked = null) {
  const payload = safeObject(tracked?.payload, {});
  const finalView = safeObject(payload?.finalView, {});
  return Boolean(
    Object.keys(finalView).length ||
      Object.keys(safeObject(payload?.orchestrator, {})).length
  );
}

function buildOpportunityFromBatchResult(row, tracked = null) {
  if (!hasPersistedBatchResult(tracked)) return null;

  const payload = safeObject(tracked?.payload, {});
  const finalView = safeObject(payload?.finalView, {});
  const globalContext = safeObject(finalView?.globalContext, {});
  const brain = safeObject(payload?.brain, {});
  const strategy = safeObject(payload?.strategy, safeObject(finalView?.strategy, {}));
  const features = safeObject(payload?.features, safeObject(finalView?.features, {}));
  const orchestrator = safeObject(
    payload?.orchestrator,
    safeObject(globalContext?.orchestrator, {})
  );
  const historicalContext = safeObject(payload?.historicalContext, {});
  const newsContextCandidate = finalView?.newsContext ?? globalContext?.newsContext ?? null;
  const signalContextCandidate =
    finalView?.signalContext ?? globalContext?.signalContext ?? null;
  const newsContext =
    newsContextCandidate &&
    typeof newsContextCandidate === "object" &&
    !Array.isArray(newsContextCandidate)
      ? newsContextCandidate
      : null;
  const signalContext =
    signalContextCandidate &&
    typeof signalContextCandidate === "object" &&
    !Array.isArray(signalContextCandidate)
      ? signalContextCandidate
      : null;
  const discoveries = Array.isArray(payload?.discoveries)
    ? payload.discoveries
    : Array.isArray(finalView?.discoveries)
      ? finalView.discoveries
      : [];
  const narratives = Array.isArray(payload?.narratives)
    ? payload.narratives
    : Array.isArray(finalView?.narratives)
      ? finalView.narratives
      : [];
  // Prefer integrationEngine chain outputs over local raw recomputation.
  const chainConviction = safeNum(
    finalView?.finalConviction,
    safeNum(tracked?.finalConviction, 0)
  );
  const chainConfidence = safeNum(
    finalView?.finalConfidence,
    safeNum(tracked?.finalConfidence, 0)
  );
  const opportunityScore = chainConviction > 0
    ? chainConviction
    : calculateOpportunityScore(row);
  const confidence = chainConfidence > 0
    ? chainConfidence
    : calculateConfidence(row, opportunityScore);
  const robustnessScore = safeNum(historicalContext?.robustness, 0);

  return {
    symbol: String(row?.symbol || "").trim().toUpperCase(),

    regime: row?.regime ?? tracked?.regime ?? finalView?.regime ?? null,
    // Prefer strategyEngine output from chain; fall back to raw classification.
    type: strategy?.strategy || classifyOpportunity(row),

    hqsScore: safeNum(row?.hqs_score, safeNum(finalView?.hqsScore, 0)),
    opportunityScore,
    confidence,

    aiScore: safeNum(finalView?.aiScore, safeNum(brain?.aiScore, 0)),
    finalConviction: chainConviction,
    finalConfidence: chainConfidence,
    finalRating: finalView?.finalRating || null,
    finalDecision: finalView?.finalDecision || null,

    strategy: strategy?.strategy || null,
    strategyLabel: strategy?.strategyLabel || null,

    narratives,
    discoveries,

    trend: row?.trend ?? null,
    volatility: row?.volatility ?? null,
    resilienceScore: safeNum(
      payload?.resilienceScore,
      safeNum(finalView?.resilienceScore, 0)
    ),

    opportunityStrength: safeNum(
      orchestrator?.opportunityStrength,
      safeNum(tracked?.opportunityStrength, 0)
    ),
    orchestratorConfidence: safeNum(
      orchestrator?.orchestratorConfidence,
      safeNum(tracked?.orchestratorConfidence, 0)
    ),

    whyInteresting: Array.isArray(finalView?.whyInteresting)
      ? finalView.whyInteresting
      : [],
    reason: generateReason(row, newsContext),
    newsContext: formatOpportunityNewsContext(newsContext),
    newsAdjustment: safeNum(finalView?.components?.newsAdjustment, 0),
    signalAdjustment: safeNum(finalView?.components?.signalAdjustment, 0),
    signalContext: formatOpportunitySignalContext(signalContext),

    marketMemory: safeObject(globalContext?.marketMemory, null),
    metaLearning: safeObject(globalContext?.metaLearning, null),

    robustnessScore,
    antifragile: robustnessScore > STRESS_ANTIFRAGILE_THRESHOLD,

    advancedUpdatedAt: row?.advanced_updated_at
      ? new Date(row.advanced_updated_at).toISOString()
      : null,
  };
}

function buildFallbackOpportunity(row, tracked = null) {
  const payload = safeObject(tracked?.payload, {});
  const finalView = safeObject(payload?.finalView, {});
  const globalContext = safeObject(finalView?.globalContext, {});
  const brain = safeObject(payload?.brain, {});
  const strategy = safeObject(payload?.strategy, safeObject(finalView?.strategy, {}));
  const orchestrator = safeObject(
    payload?.orchestrator,
    safeObject(globalContext?.orchestrator, {})
  );
  const historicalContext = safeObject(payload?.historicalContext, {});
  const newsContextCandidate = finalView?.newsContext ?? globalContext?.newsContext ?? null;
  const signalContextCandidate =
    finalView?.signalContext ?? globalContext?.signalContext ?? null;
  const newsContext =
    newsContextCandidate &&
    typeof newsContextCandidate === "object" &&
    !Array.isArray(newsContextCandidate)
      ? newsContextCandidate
      : null;
  const signalContext =
    signalContextCandidate &&
    typeof signalContextCandidate === "object" &&
    !Array.isArray(signalContextCandidate)
      ? signalContextCandidate
      : null;
  const discoveries = Array.isArray(payload?.discoveries)
    ? payload.discoveries
    : Array.isArray(finalView?.discoveries)
      ? finalView.discoveries
      : [];
  const narratives = Array.isArray(payload?.narratives)
    ? payload.narratives
    : Array.isArray(finalView?.narratives)
      ? finalView.narratives
      : [];
  const opportunityScore = calculateOpportunityScore(row);
  const robustnessScore = safeNum(historicalContext?.robustness, 0);

  return {
    symbol: String(row?.symbol || "").trim().toUpperCase(),

    regime: row?.regime ?? tracked?.regime ?? finalView?.regime ?? null,
    // Prefer strategyEngine output from chain; fall back to raw classification.
    type: strategy?.strategy || classifyOpportunity(row),

    hqsScore: safeNum(row?.hqs_score, safeNum(finalView?.hqsScore, 0)),
    opportunityScore,
    confidence: calculateConfidence(row, opportunityScore),

    aiScore: safeNum(finalView?.aiScore, safeNum(brain?.aiScore, 0)),
    finalConviction: safeNum(
      finalView?.finalConviction,
      safeNum(tracked?.finalConviction, 0)
    ),
    finalConfidence: safeNum(
      finalView?.finalConfidence,
      safeNum(tracked?.finalConfidence, 0)
    ),
    finalRating: finalView?.finalRating || null,
    finalDecision: finalView?.finalDecision || null,

    strategy: strategy?.strategy || null,
    strategyLabel: strategy?.strategyLabel || null,

    narratives,
    discoveries,

    trend: row?.trend ?? null,
    volatility: row?.volatility ?? null,
    resilienceScore: safeNum(
      payload?.resilienceScore,
      safeNum(finalView?.resilienceScore, 0)
    ),

    opportunityStrength: safeNum(
      orchestrator?.opportunityStrength,
      safeNum(tracked?.opportunityStrength, 0)
    ),
    orchestratorConfidence: safeNum(
      orchestrator?.orchestratorConfidence,
      safeNum(tracked?.orchestratorConfidence, 0)
    ),

    whyInteresting: Array.isArray(finalView?.whyInteresting)
      ? finalView.whyInteresting
      : [],
    reason: generateReason(row, newsContext),
    newsContext: formatOpportunityNewsContext(newsContext),
    newsAdjustment: safeNum(finalView?.components?.newsAdjustment, 0),
    signalAdjustment: safeNum(finalView?.components?.signalAdjustment, 0),
    signalContext: formatOpportunitySignalContext(signalContext),

    marketMemory: safeObject(globalContext?.marketMemory, null),
    metaLearning: safeObject(globalContext?.metaLearning, null),

    robustnessScore,
    antifragile: robustnessScore > STRESS_ANTIFRAGILE_THRESHOLD,

    advancedUpdatedAt: row?.advanced_updated_at
      ? new Date(row.advanced_updated_at).toISOString()
      : null,
  };
}

async function hydrateOpportunityRuntimeState() {
  await ensureRuntimePreviewStoresLoaded();

  return {
    marketMemoryKeys: Object.keys(safeObject(marketMemoryStore, {})).length,
    metaLearningKeys: Object.keys(safeObject(metaLearningStore, {})).length,
  };
}

/* =========================================================
   GUARDIAN PROTOCOL
========================================================= */

/**
 * Evaluates whether a signal should be suppressed for wealth protection.
 *
 * The robustness threshold is adjusted upward in unfavourable market clusters:
 *   Safe     → GUARDIAN_THRESHOLD_SAFE
 *   Volatile → GUARDIAN_THRESHOLD_VOLATILE
 *   Danger   → GUARDIAN_THRESHOLD_DANGER
 *
 * @param {object} opportunity  - built opportunity object
 * @param {string} marketCluster - 'Safe' | 'Volatile' | 'Danger'
 * @returns {{ suppressed: boolean, reason: string|null, threshold: number }}
 */
function executeSafetyFirst(opportunity, marketCluster = "Safe") {
  const robustness = safeNum(opportunity?.robustnessScore, 0);

  let threshold;
  switch (String(marketCluster)) {
    case "Danger":
      threshold = GUARDIAN_THRESHOLD_DANGER;
      break;
    case "Volatile":
      threshold = GUARDIAN_THRESHOLD_VOLATILE;
      break;
    default:
      threshold = GUARDIAN_THRESHOLD_SAFE;
  }

  if (robustness < threshold) {
    return {
      suppressed: true,
      reason: "Wealth Protection",
      detail: `Signal suppressed: robustness_score ${robustness.toFixed(2)} below threshold ${threshold.toFixed(2)} in ${marketCluster} market`,
      threshold,
    };
  }

  return { suppressed: false, reason: null, detail: null, threshold };
}

/* =========================================================
   HUMAN-CENTRIC INSIGHT BUILDER
========================================================= */

/**
 * Converts a raw opportunity object into a human-readable Insight.
 * The backend performs all interpretation – callers receive finished,
 * actionable conclusions rather than technical raw data.
 *
 * @param {object} opportunity
 * @param {object} guardianResult  - result of executeSafetyFirst()
 * @param {string} marketCluster   - 'Safe' | 'Volatile' | 'Danger'
 * @returns {object} insight
 */
function buildOpportunityInsight(opportunity, guardianResult, marketCluster) {
  const symbol = String(opportunity?.symbol || "").trim().toUpperCase();
  const conviction = safeNum(opportunity?.finalConviction, 0);
  const robustness = safeNum(opportunity?.robustnessScore, 0);
  const antifragile = Boolean(opportunity?.antifragile);

  // Risk level
  let riskLevel;
  if (marketCluster === "Danger" || robustness < 0.3) {
    riskLevel = "HIGH";
  } else if (marketCluster === "Volatile" || robustness < 0.55) {
    riskLevel = "MEDIUM";
  } else {
    riskLevel = "LOW";
  }

  // Human recommendation (German: system targets German-speaking users throughout)
  // Note: debateApproved is explicitly checked for `false` (not falsy) to distinguish
  // "debate voted reject" from "no debate result available" (null/undefined).
  let recommendation;
  if (guardianResult.suppressed) {
    const blockedByDebate = guardianResult.debateApproved === false;
    recommendation = blockedByDebate
      ? "Kein Analytisches Signal – Schwarmintelligenz-Konsens verweigert"
      : "Kein Analytisches Signal – Wealth Protection aktiv";
  } else if (conviction >= 80) {
    recommendation = "Starke Technische Übereinstimmung – aktiv beobachten";
  } else if (conviction >= 65) {
    recommendation = "Technische Übereinstimmung – weitere Prüfung empfohlen";
  } else if (conviction >= 50) {
    recommendation = "Analytisches Signal – Watchlist, kein sofortiger Handlungsbedarf";
  } else {
    recommendation = "Kein klares Analytisches Signal – kein Handlungsbedarf";
  }

  // Title label: distinguish Debate-blocked from robustness-blocked signals
  // debateApproved === false means the 3-agent consensus rejected; all other
  // suppressed cases are robustness / Wealth-Protection blocks.
  const suppressionLabel =
    guardianResult.suppressed && guardianResult.debateApproved === false
      ? "Schutzmodus"
      : "Wealth Protection";

  // Stability narrative
  const stabilityNote = antifragile
    ? "Das Signal hat alle Stressszenarien bestanden und gilt als antifragil."
    : robustness >= 0.55
    ? "Das Signal zeigt gute Stabilität unter Marktdruck."
    : "Das Signal reagiert empfindlich auf Marktschwankungen.";

  // Summary — include debate summary when available (Invisible Rationale)
  const existingReason = String(opportunity?.reason || "").trim();
  const debateSummary = String(guardianResult?.debateSummary || "").trim();
  let summary = existingReason
    ? `${symbol}: ${existingReason}. ${stabilityNote}`
    : `${symbol}: ${stabilityNote}`;

  if (debateSummary) {
    summary = `${summary} 🤖 Interne Debatte: ${debateSummary}`;
  }

  // Portfolio intelligence note: surface role/concentration for non-suppressed signals
  const portfolioCtx = opportunity?.portfolioContext;
  if (!guardianResult.suppressed && portfolioCtx?.portfolioRole) {
    const roleMap = {
      additive:    "Aufstockung bestehender Position",
      redundant:   "Sektor bereits im Portfolio vertreten",
      diversifier: "Ergänzt Portfolio mit neuem Sektor",
      complement:  "Ergänzt Watchlist-Abdeckung",
    };
    const roleNote = roleMap[portfolioCtx.portfolioRole];
    const concNote = portfolioCtx.concentrationRisk === "high"
      ? " – Konzentrationsrisiko erhöht"
      : portfolioCtx.concentrationRisk === "medium"
      ? " – Sektorgewicht prüfen"
      : "";
    if (roleNote) {
      summary = `${summary} 📊 Portfolio: ${roleNote}${concNote}.`;
    }
  }

  // Inter-market warning note
  if (guardianResult.interMarketWarning) {
    summary += " ⚠️ Frühwarnung: BTC und Gold zeigen gleichzeitig Risikoabbau.";
  }

  return {
    title: guardianResult.suppressed
      ? `${symbol} – Gesperrt (${suppressionLabel})`
      : `${symbol} – ${opportunity?.finalRating || "Signal erkannt"}`,
    summary,
    recommendation,
    riskLevel,
    marketClimate: marketCluster,
    protectionStatus: guardianResult.suppressed
      ? {
          active: true,
          reason: guardianResult.reason,
          detail: guardianResult.detail,
          debateApproved: guardianResult.debateApproved ?? null,
          debateSummary: debateSummary || null,
        }
      : { active: false },
    debate: guardianResult.debateVotes
      ? {
          approved: guardianResult.debateApproved,
          approvalCount: Object.values(guardianResult.debateVotes).filter(
            (v) => v?.vote === "approve"
          ).length,
          summary: debateSummary || null,
        }
      : null,
    interMarketWarning: Boolean(guardianResult.interMarketWarning),
    robustnessScore: Number(robustness.toFixed(2)),
    antifragile,
    finalConviction: Number(conviction.toFixed(1)),
  };
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

      COALESCE(m.volatility_annual, m.volatility_daily, 0) AS volatility,

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

  let persistedOutcomeBySymbol = {};
  if (rows.length) {
    try {
      persistedOutcomeBySymbol = await loadLatestOutcomeTrackingBySymbols(
        rows.map((row) => row.symbol)
      );
    } catch (error) {
      logger.warn("Opportunity batch result load failed", {
        message: error.message,
      });
    }
  }

  const opportunities = rows.map((row) => {
    const normalizedSymbol = String(row?.symbol || "").trim().toUpperCase();
    const persistedOpportunity = buildOpportunityFromBatchResult(
      row,
      persistedOutcomeBySymbol?.[normalizedSymbol] || null
    );

    if (persistedOpportunity) {
      return persistedOpportunity;
    }

    return buildFallbackOpportunity(
      row,
      persistedOutcomeBySymbol?.[normalizedSymbol] || null
    );
  });

  const persistedCount = rows.filter((row) => {
    const normalizedSymbol = String(row?.symbol || "").trim().toUpperCase();
    return hasPersistedBatchResult(persistedOutcomeBySymbol?.[normalizedSymbol]);
  }).length;
  const fallbackCount = Math.max(0, opportunities.length - persistedCount);

  opportunities.sort((a, b) => {
    if (b.finalConviction !== a.finalConviction) {
      return b.finalConviction - a.finalConviction;
    }

    if (b.finalConfidence !== a.finalConfidence) {
      return b.finalConfidence - a.finalConfidence;
    }

    return b.hqsScore - a.hqsScore;
  });

  // ── Step 4: Personalized Decision Layer ─────────────────────────────────
  // One round-trip: load open virtual positions + watchlist membership for all
  // candidate symbols, then merge portfolio context into each opportunity.
  // Graceful fallback: context defaults to unknown when DB is unavailable.
  let portfolioCtxMap = new Map();
  try {
    portfolioCtxMap = await buildPortfolioContextForSymbols(
      opportunities.map((o) => o.symbol)
    );
  } catch (ctxErr) {
    logger.warn("getTopOpportunities: portfolio context load failed – continuing without", {
      message: ctxErr.message,
    });
  }
  const opportunitiesWithCtx = opportunities.map((o) =>
    enrichWithPortfolioContext(o, portfolioCtxMap)
  );

  // Portfolio-intelligence-aware re-sort: diversifiers and low-concentration-risk
  // candidates get a gentle nudge up; high-concentration-risk candidates get a
  // gentle nudge down.  Conviction/confidence still dominate; bonus is ±3–5 pts.
  opportunitiesWithCtx.sort((a, b) => {
    const aAdj = safeNum(a.finalConviction, safeNum(a.hqsScore, 0))
      + _portfolioIntelligenceBonus(a.portfolioContext);
    const bAdj = safeNum(b.finalConviction, safeNum(b.hqsScore, 0))
      + _portfolioIntelligenceBonus(b.portfolioContext);
    if (bAdj !== aAdj) return bAdj - aAdj;
    if (b.finalConfidence !== a.finalConfidence) return b.finalConfidence - a.finalConfidence;
    return safeNum(b.hqsScore, 0) - safeNum(a.hqsScore, 0);
  });

  // ── World State: single source of global market truth ───────────────────
  // Replaces three individual async calls (regime, inter-market, agent weights)
  // with one unified getWorldState() lookup that is already cached in-memory.
  // Also exposes orchestrator_global, capital_flow_summary, and news_pulse for
  // use by debate/guardian/insight building.
  // Falls back to direct service calls if world_state is unavailable.
  let marketRegime = { cluster: "Safe", capturedAt: new Date().toISOString() };
  let interMarketData = null;
  let agentWeights = null;
  let orchestratorGlobal = null;
  let capitalFlowSummary = null;
  let globalNewsPulse = null;
  let riskMode = "neutral";
  let uncertainty = 0;

  try {
    const ws = await getWorldState();
    const _wsFreshness = classifyWorldStateAge(ws);
    if (_wsFreshness === "hard_stale") {
      // Hard-stale: do not use as authoritative input – trigger the fallback below.
      logger.warn(
        "getTopOpportunities: world_state is hard_stale – falling back to direct service calls",
        { created_at: ws?.created_at }
      );
      throw new Error("world_state hard_stale – defensive fallback active");
    }
    if (_wsFreshness === "stale") {
      logger.warn(
        "getTopOpportunities: world_state is stale – using with degraded trust",
        { created_at: ws?.created_at }
      );
    }
    marketRegime = {
      cluster:      ws.regime.cluster,
      avgHqs:       ws.regime.avgHqs,
      bearRatio:    ws.regime.bearRatio,
      highVolRatio: ws.regime.highVolRatio,
      totalSymbols: ws.regime.totalSymbols,
      capturedAt:   ws.created_at,
    };
    interMarketData = {
      btc:          ws.cross_asset_state.btc,
      gold:         ws.cross_asset_state.gold,
      earlyWarning: ws.cross_asset_state.earlyWarning,
      timestamp:    ws.created_at,
    };
    agentWeights        = ws.agent_calibration.weights;
    orchestratorGlobal  = ws.orchestrator_global  || null;
    capitalFlowSummary  = ws.capital_flow_summary  || null;
    globalNewsPulse     = ws.news_pulse            || null;
    riskMode            = ws.risk_mode             || "neutral";
    uncertainty         = safeNum(ws.uncertainty, 0);
  } catch (wsErr) {
    logger.warn(
      "getTopOpportunities: world_state unavailable – falling back to direct service calls",
      { message: wsErr.message }
    );
    // Fallback: call the individual services directly (pre-world_state behaviour)
    try {
      marketRegime = await classifyMarketRegime();
    } catch (_) { /* default Safe stays */ }
    try {
      interMarketData = await getInterMarketCorrelation();
    } catch (_) { /* continues without cross-asset data */ }
    try {
      agentWeights = await getAgentWeights();
    } catch (_) { /* agentWeights stays null – debate uses its internal defaults */ }
  }

  const marketCluster = marketRegime.cluster;

  // ── Agentic Debate + Guardian Protocol + Insight building ───────────────
  let suppressedCount = 0;
  let debateBlockedCount = 0;
  const withInsights = await Promise.all(opportunitiesWithCtx.map(async (opp) => {
    // 1. Meta-Rationale: historical context for this symbol
    let metaRationale = null;
    try {
      metaRationale = await buildMetaRationale(opp.symbol);
    } catch (_) {
      // non-critical – continue without meta-rationale
    }

    // 1b. Sector Coherence: check whether sector alert is active for this symbol
    const sectorThresholds = getSharpenedThresholds(opp.symbol);

    // 1c. Pattern Memory: derive structured key for this opportunity's signal setup
    //     and look up historical performance statistics for identical setups.
    let patternContext = null;
    try {
      const { patternKey } = buildStructuredPatternSignature({
        regime:          opp.regime,
        volatility:      opp.volatility,
        trendStrength:   opp.signalContext?.trendScore,
        sentimentScore:  opp.signalContext?.sentimentScore,
        newsDirection:   opp.newsContext?.direction,
        buzzScore:       opp.signalContext?.buzzScore,
        signalDirection: opp.signalContext?.signalDirection,
        robustnessScore: opp.robustnessScore,
        hqsScore:        opp.hqsScore,
        finalConviction: opp.finalConviction,
      });
      patternContext = await getPatternStats(patternKey);
    } catch (_) {
      // non-critical – continue without pattern context
    }

    // 2. Run the three-agent debate (GROWTH_BIAS, RISK_SKEPTIC, MACRO_JUDGE)
    const debateResult = runAgenticDebate(
      opp,
      marketCluster,
      opp.signalContext || null,
      interMarketData,
      {
        dynamicWeights: agentWeights,
        metaRationale,
        sectorAlert: sectorThresholds.sectorAlert,
        patternContext,
      }
    );

    // 3. Guardian Protocol robustness check
    const guardianResult = executeSafetyFirst(opp, marketCluster);

    // Signal is suppressed if EITHER debate or Guardian blocks it
    const debateBlocked = !debateResult.approved;
    const suppressed = debateBlocked || guardianResult.suppressed;

    if (suppressed) {
      suppressedCount++;
      if (debateBlocked && !guardianResult.suppressed) debateBlockedCount++;
    }

    // Augment guardianResult with debate context for insight and rationale
    const enrichedGuardian = {
      ...guardianResult,
      suppressed,
      debateApproved: debateResult.approved,
      debateSummary: debateResult.debateSummary,
      debateVotes: debateResult.votes,
      interMarketWarning: Boolean(interMarketData?.earlyWarning),
      // Global orchestrator risk mode from world_state (available when present)
      globalRiskMode: orchestratorGlobal?.riskMode?.mode || null,
    };

    const insight = buildOpportunityInsight(opp, enrichedGuardian, marketCluster);

    // Fire-and-forget audit log
    const tracked = persistedOutcomeBySymbol?.[opp.symbol] || null;
    const rawSnap = tracked?.raw_input_snapshot || null;
    const auditSnapshot = rawSnap || {
      hqsScore: opp.hqsScore,
      robustnessScore: opp.robustnessScore,
      finalConviction: opp.finalConviction,
      regime: opp.regime,
      capturedAt: new Date().toISOString(),
    };

    // Fire-and-forget: log per-agent 24h forecasts for Prediction-Self-Audit
    logAgentForecasts({
      symbol: opp.symbol,
      marketCluster,
      debateApproved: debateResult.approved,
      entryPrice: opp.entryPrice || null,
      votes: debateResult.votes,
    }).catch((fErr) => {
      logger.warn("getTopOpportunities: agent forecast log failed", {
        symbol: opp.symbol,
        message: fErr.message,
      });
    });

    recordAutonomyDecision({
      symbol: opp.symbol,
      decisionType: "opportunity_signal",
      decisionValue: suppressed
        ? "SUPPRESSED"
        : opp.finalDecision || "EVALUATED",
      marketCluster,
      robustnessScore: safeNum(opp.robustnessScore, 0),
      guardianApplied: true,
      suppressed,
      suppressionReason: suppressed
        ? (debateBlocked ? "Debate Consensus Failed" : "Kapitalschutz-Aktion")
        : null,
      rawInputSnapshot: {
        ...auditSnapshot,
        debate: {
          approved: debateResult.approved,
          approvalCount: debateResult.approvalCount,
          summary: debateResult.debateSummary,
        },
        interMarket: interMarketData
          ? {
              earlyWarning: interMarketData.earlyWarning,
              btcSignal: interMarketData.btc?.signal || null,
              goldSignal: interMarketData.gold?.signal || null,
            }
          : null,
      },
    }).catch((auditErr) => {
      logger.warn("getTopOpportunities: audit log failed", {
        symbol: opp.symbol,
        message: auditErr.message,
      });
    });

    // Virtual Capital Protector: log near-miss for blocked signals
    if (suppressed) {
      logNearMiss({
        symbol: opp.symbol,
        marketCluster,
        robustnessScore: safeNum(opp.robustnessScore, 0),
        entryPriceRef: null,
        debateApproved: debateResult.approved,
        debateSummary: debateResult.debateSummary,
        debateResult: {
          approved: debateResult.approved,
          approvalCount: debateResult.approvalCount,
          votes: debateResult.votes,
        },
      }).catch((nmErr) => {
        logger.warn("getTopOpportunities: near-miss log failed", {
          symbol: opp.symbol,
          message: nmErr.message,
        });
      });
    }

    return {
      ...opp,
      suppressed,
      suppressionReason: suppressed
        ? (debateBlocked ? "Debate Consensus Failed" : "Kapitalschutz-Aktion")
        : null,
      debateResult: {
        approved: debateResult.approved,
        approvalCount: debateResult.approvalCount,
        debateSummary: debateResult.debateSummary,
      },
      insight,
      // Pass sector-alert flag to the Capital Allocation Layer
      sectorAlert: sectorThresholds.sectorAlert,
    };
  }));

  // Keep only non-suppressed signals in the final output (guardian enforcement)
  // Capital Allocation runs on ALL non-suppressed candidates BEFORE the limit-slice
  // so the budget logic can reject weaker signals and keep capacity for stronger ones.
  const candidates = withInsights.filter((opp) => !opp.suppressed);

  // ── Capital Allocation Layer ─────────────────────────────────────────────
  // Pure, O(n) budget distribution. No DB calls. Falls back gracefully.
  // maxPositions is set to 2× the requested limit so the allocation engine
  // has a larger candidate pool to work with: it can reject weaker signals
  // and still fill up to `limit` approved positions in the final slice.
  const ALLOC_MIN_POSITIONS = 5;   // floor: always consider at least 5 candidates
  const ALLOC_MAX_POSITIONS = 20;  // ceiling: cap to avoid over-allocating budget

  let allocatedCandidates = candidates;
  let budgetSummary       = null;
  try {
    const allocResult = applyCapitalAllocation(
      candidates,
      { riskMode, uncertainty },
      {
        totalBudgetEur: safeNum(Number(process.env.ALLOCATION_BUDGET_EUR), 10000),
        maxPositions:   clamp(limit * 2, ALLOC_MIN_POSITIONS, ALLOC_MAX_POSITIONS),
      }
    );
    allocatedCandidates = allocResult.opportunities;
    budgetSummary       = allocResult.budgetSummary;
  } catch (allocErr) {
    logger.warn("getTopOpportunities: capital allocation layer failed – returning without allocation fields", {
      message: allocErr.message,
    });
  }

  // ── Portfolio Twin Stage 2: auto live-integration ───────────────────────
  // For every allocation-approved candidate with positionSizeEur > 0,
  // attempt to open a virtual position (sequential to avoid DB pool pressure).
  // Duplicate guard: skip if an open position for the symbol already exists.
  // Can be disabled via PORTFOLIO_TWIN_AUTO_OPEN=false env var.
  const autoOpenEnabled = process.env.PORTFOLIO_TWIN_AUTO_OPEN !== "false";
  const virtualOpenResults = [];
  for (const opp of allocatedCandidates) {
    // Gate 0: feature flag
    if (!autoOpenEnabled) {
      virtualOpenResults.push({ symbol: opp.symbol, virtualPositionOpened: false, virtualPositionSkippedReason: "autoOpenDisabled" });
      continue;
    }

    // Gate 1: only approved allocations
    if (!opp.allocationApproved) {
      logger.debug("portfolioTwin: skip – allocationApproved=false", { symbol: opp.symbol });
      virtualOpenResults.push({ symbol: opp.symbol, virtualPositionOpened: false, virtualPositionSkippedReason: "allocationApproved=false" });
      continue;
    }

    // Gate 2: must have positive position size
    const positionSizeEur = safeNum(opp.positionSizeEur, 0);
    if (positionSizeEur <= 0) {
      logger.debug("portfolioTwin: skip – positionSizeEur<=0", { symbol: opp.symbol });
      virtualOpenResults.push({ symbol: opp.symbol, virtualPositionOpened: false, virtualPositionSkippedReason: "positionSizeEur<=0" });
      continue;
    }

    // Gate 3: must have a valid entry price
    const entryPrice = safeNum(opp.entryPrice, 0);
    if (entryPrice <= 0) {
      logger.debug("portfolioTwin: skip – entryPrice not available", { symbol: opp.symbol });
      virtualOpenResults.push({ symbol: opp.symbol, virtualPositionOpened: false, virtualPositionSkippedReason: "entryPriceMissing" });
      continue;
    }

    // Gate 4: duplicate guard – skip if open position already exists
    try {
      const alreadyOpen = await hasOpenVirtualPosition(opp.symbol);
      if (alreadyOpen) {
        logger.info("portfolioTwin: skip – open position already exists", { symbol: opp.symbol });
        virtualOpenResults.push({ symbol: opp.symbol, virtualPositionOpened: false, virtualPositionSkippedReason: "alreadyOpen" });
        continue;
      }
    } catch (guardErr) {
      logger.warn("portfolioTwin: duplicate guard check failed – skipping open", {
        symbol: opp.symbol, message: guardErr.message,
      });
      virtualOpenResults.push({ symbol: opp.symbol, virtualPositionOpened: false, virtualPositionSkippedReason: "guardCheckFailed" });
      continue;
    }

    // All gates passed – open the virtual position
    try {
      await openVirtualPositionFromAllocation({
        symbol:             opp.symbol,
        entryPrice,
        allocatedEur:       positionSizeEur,
        allocatedPct:       safeNum(opp.positionSizePct, 0),
        convictionTier:     opp.convictionTier     || null,
        riskModeAtEntry:    riskMode               || null,
        uncertaintyAtEntry: uncertainty,
        sourceRunId:        opp.sourceRunId        || null,
      });
      logger.info("portfolioTwin: virtual position opened via scanner flow", {
        symbol: opp.symbol, entryPrice, positionSizeEur,
      });
      virtualOpenResults.push({ symbol: opp.symbol, virtualPositionOpened: true });
    } catch (openErr) {
      logger.warn("portfolioTwin: openVirtualPositionFromAllocation failed", {
        symbol: opp.symbol, message: openErr.message,
      });
      virtualOpenResults.push({ symbol: opp.symbol, virtualPositionOpened: false, virtualPositionSkippedReason: openErr.message });
    }
  }

  // Attach virtualPositionOpened / virtualPositionSkippedReason to each candidate
  const vpBySymbol = Object.fromEntries(
    virtualOpenResults.map((r) => [r.symbol, r])
  );
  const allocatedWithVp = allocatedCandidates.map((opp) => {
    const vr = vpBySymbol[opp.symbol];
    if (!vr) return opp;
    const extra = { virtualPositionOpened: vr.virtualPositionOpened };
    if (!vr.virtualPositionOpened && vr.virtualPositionSkippedReason) {
      extra.virtualPositionSkippedReason = vr.virtualPositionSkippedReason;
    }
    return { ...opp, ...extra };
  });

  const out = allocatedWithVp.slice(0, limit);

  logger.info("getTopOpportunities", {
    limit,
    minHqs,
    regime,
    marketCluster,
    riskMode,
    uncertainty:             Number(uncertainty.toFixed(2)),
    persistedCount,
    fallbackCount,
    suppressedCount,
    debateBlockedCount,
    interMarketWarning:      Boolean(interMarketData?.earlyWarning),
    orchestratorGlobalMode:  orchestratorGlobal?.riskMode?.mode || null,
    capitalFlowBullish:      capitalFlowSummary?.flowSummary?.bullish ?? null,
    newsPulseDirection:      globalNewsPulse?.direction || null,
    allocationApproved:      budgetSummary ? budgetSummary.approvedPositions : null,
    budgetConsumedPct:       budgetSummary ? budgetSummary.consumedBudgetPct : null,
    virtualPositionsOpened:  virtualOpenResults.filter((r) => r.virtualPositionOpened).length,
    returned: out.length,
  });

  return out;
}

module.exports = {
  buildSignalContext,
  hydrateOpportunityRuntimeState,
  loadOpportunityNewsContextBySymbols,
  getTopOpportunities,
  simulateMarketStress,
  calculateRobustnessScore,
  executeSafetyFirst,
  buildOpportunityInsight,
};
