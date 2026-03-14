"use strict";

/*
  Integration Engine
  Combines all subsystem outputs into one final intelligence object
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

const NEWS_CONVICTION_MAX_ABS = 8;
// Final conviction uses a softer news profile than the orchestrator so that
// prepared news context can move ranking meaningfully without dominating HQS/AI.
// Relevance still leads, market impact remains material, but activity/freshness
// are deliberately smaller because the scanner already pre-filters to scoring-active news.
const NEWS_SIGNAL_RELEVANCE_WEIGHT = 0.28;
const NEWS_SIGNAL_CONFIDENCE_WEIGHT = 0.18;
const NEWS_SIGNAL_MARKET_IMPACT_WEIGHT = 0.24;
const NEWS_SIGNAL_FRESHNESS_WEIGHT = 0.1;
const NEWS_SIGNAL_PERSISTENCE_WEIGHT = 0.12;
const NEWS_SIGNAL_ACTIVITY_WEIGHT = 0.08;
const NEWS_PERSISTENCE_MAX = 160;
const NEWS_ACTIVITY_CAP = 4;
const NEWS_REASON_STRENGTH_THRESHOLD = 0.45;
const SIGNAL_CONVICTION_MAX_ABS = 6;
const SIGNAL_REASON_STRENGTH_THRESHOLD = 55;

function resolveNewsContext(newsContext = null, globalContext = {}) {
  if (newsContext && typeof newsContext === "object" && !Array.isArray(newsContext)) {
    return newsContext;
  }

  const nested = globalContext?.newsContext;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested;
  }

  return null;
}

function resolveSignalContext(signalContext = null, globalContext = {}) {
  if (signalContext && typeof signalContext === "object" && !Array.isArray(signalContext)) {
    return signalContext;
  }

  const nested = globalContext?.signalContext;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested;
  }

  return null;
}

function calculateNewsDirectionScore(newsContext = null, globalContext = {}) {
  const news = resolveNewsContext(newsContext, globalContext);
  if (!news) return 0;

  const explicitDirectionScore = Number(news?.directionScore);
  if (Number.isFinite(explicitDirectionScore)) {
    return clamp(explicitDirectionScore, -1, 1);
  }

  const sentimentScore = safe(news?.marketSentiment?.sentimentScore, 0);
  if (sentimentScore !== 0) {
    return clamp(sentimentScore / 100, -1, 1);
  }

  const direction = String(news?.direction || "").toLowerCase();
  if (direction === "bullish") return 0.35;
  if (direction === "bearish") return -0.35;
  return 0;
}

function calculateNewsStrength(newsContext = null, globalContext = {}) {
  const news = resolveNewsContext(newsContext, globalContext);
  if (!news || safe(news?.activeCount, 0) <= 0) return 0;

  const relevance = clamp(safe(news?.weightedRelevance, 0), 0, 100) / 100;
  const confidence = clamp(safe(news?.weightedConfidence, 0), 0, 100) / 100;
  const marketImpact = clamp(safe(news?.weightedMarketImpact, 0), 0, 100) / 100;
  const freshness = clamp(safe(news?.weightedFreshness, 0), 0, 100) / 100;
  const persistence = clamp(safe(news?.weightedPersistence, 0) / NEWS_PERSISTENCE_MAX, 0, 1);
  const activity = clamp(safe(news?.activeCount, 0) / NEWS_ACTIVITY_CAP, 0, 1);

  return clamp(
    relevance * NEWS_SIGNAL_RELEVANCE_WEIGHT +
      confidence * NEWS_SIGNAL_CONFIDENCE_WEIGHT +
      marketImpact * NEWS_SIGNAL_MARKET_IMPACT_WEIGHT +
      freshness * NEWS_SIGNAL_FRESHNESS_WEIGHT +
      persistence * NEWS_SIGNAL_PERSISTENCE_WEIGHT +
      activity * NEWS_SIGNAL_ACTIVITY_WEIGHT,
    0,
    1
  );
}

function calculateNewsAdjustment(newsContext = null, globalContext = {}) {
  const newsStrength = calculateNewsStrength(newsContext, globalContext);
  if (newsStrength <= 0) return 0;

  const directionScore = calculateNewsDirectionScore(newsContext, globalContext);
  return clamp(
    Math.round(newsStrength * directionScore * NEWS_CONVICTION_MAX_ABS),
    -NEWS_CONVICTION_MAX_ABS,
    NEWS_CONVICTION_MAX_ABS
  );
}

function calculateSignalDirectionScore(signalContext = null, globalContext = {}) {
  const signal = resolveSignalContext(signalContext, globalContext);
  if (!signal) return 0;

  const explicitDirectionScore = Number(signal?.signalDirectionScore);
  if (Number.isFinite(explicitDirectionScore)) {
    return clamp(explicitDirectionScore, -1, 1);
  }

  const sentimentScore = safe(signal?.sentimentScore, 0);
  if (sentimentScore !== 0) {
    return clamp(sentimentScore / 100, -1, 1);
  }

  const direction = String(signal?.signalDirection || "").toLowerCase();
  if (direction === "bullish") return 0.35;
  if (direction === "bearish") return -0.35;
  return 0;
}

function calculateSignalStrength(signalContext = null, globalContext = {}) {
  const signal = resolveSignalContext(signalContext, globalContext);
  if (!signal) return 0;

  const strength = clamp(
    safe(signal?.signalStrength, signal?.trendScore),
    0,
    100
  ) / 100;
  const confidence = clamp(safe(signal?.signalConfidence, 0), 0, 100) / 100;

  return clamp(strength * 0.7 + confidence * 0.3, 0, 1);
}

function calculateSignalAdjustment(signalContext = null, globalContext = {}) {
  const signalStrength = calculateSignalStrength(signalContext, globalContext);
  if (signalStrength <= 0) return 0;

  const directionScore = calculateSignalDirectionScore(signalContext, globalContext);

  return clamp(
    Math.round(signalStrength * directionScore * SIGNAL_CONVICTION_MAX_ABS),
    -SIGNAL_CONVICTION_MAX_ABS,
    SIGNAL_CONVICTION_MAX_ABS
  );
}

/* ===============================
   GLOBAL REGIME EXTRACTION
================================ */

function extractGlobalRegime(globalContext = {}) {
  const orchestratorMode = String(
    globalContext?.orchestrator?.riskMode?.mode || ""
  ).toLowerCase();

  if (orchestratorMode) return orchestratorMode;

  const regime = String(globalContext?.regime || "").toLowerCase();
  if (regime) return regime;

  return "neutral";
}

/* ===============================
   CONTEXT BOOSTS
================================ */

function calculateGlobalBoost(globalContext = {}) {
  let boost = 0;

  const regime = extractGlobalRegime(globalContext);

  if (regime === "risk_on") boost += 4;
  if (regime === "neutral") boost += 1;
  if (regime === "risk_off") boost -= 4;
  if (regime === "panic") boost -= 8;

  const opportunityStrength = safe(
    globalContext?.orchestrator?.opportunityStrength,
    0
  );

  if (opportunityStrength >= 85) boost += 4;
  else if (opportunityStrength >= 70) boost += 2;
  else if (opportunityStrength < 40) boost -= 2;

  const orchestratorConfidence = safe(
    globalContext?.orchestrator?.orchestratorConfidence,
    0
  );

  if (orchestratorConfidence >= 80) boost += 3;
  else if (orchestratorConfidence >= 60) boost += 1;
  else if (orchestratorConfidence < 40) boost -= 2;

  return boost;
}

function calculateMemoryBoost(globalContext = {}) {
  const memoryScore = safe(globalContext?.marketMemory?.memoryScore, 0);

  if (memoryScore >= 85) return 6;
  if (memoryScore >= 70) return 4;
  if (memoryScore >= 55) return 2;
  if (memoryScore < 35) return -2;

  return 0;
}

function calculateMetaBoost(globalContext = {}) {
  const strongest =
    globalContext?.metaLearning?.strongest || [];

  if (!Array.isArray(strongest) || !strongest.length) return 0;

  const avg =
    strongest.reduce((sum, e) => sum + safe(e?.weight, 1), 0) /
    strongest.length;

  if (avg >= 1.2) return 3;
  if (avg >= 1.0) return 1;
  if (avg < 0.85) return -2;

  return 0;
}

function calculateEventPenalty(globalContext = {}) {
  const events = globalContext?.eventIntelligence?.events || [];
  const eventStress = safe(globalContext?.orchestrator?.eventStress, 0);

  let penalty = 0;

  if (events.length >= 2) penalty += 2;
  if (eventStress > 0.6) penalty += 6;
  else if (eventStress > 0.3) penalty += 3;

  return penalty;
}

/* ===============================
   FINAL CONVICTION SCORE
================================ */

function calculateFinalConviction({
  hqsScore,
  aiScore,
  strategyAdjustedScore,
  resilienceScore,
  narratives,
  discoveries,
  researchSignals,
  globalContext,
  newsContext,
  signalContext,
}) {
  const hqs = safe(hqsScore);
  const ai = safe(aiScore);
  const strategy = safe(strategyAdjustedScore);
  const resilience = safe(resilienceScore) * 100;

  const narrativeBoost = Array.isArray(narratives)
    ? narratives.length * 2
    : 0;

  const discoveryBoost = Array.isArray(discoveries)
    ? discoveries.length * 2
    : 0;

  const researchBoost = Array.isArray(researchSignals)
    ? researchSignals.length * 3
    : 0;

  const globalBoost = calculateGlobalBoost(globalContext);
  const memoryBoost = calculateMemoryBoost(globalContext);
  const metaBoost = calculateMetaBoost(globalContext);
  const eventPenalty = calculateEventPenalty(globalContext);
  const newsAdjustment = calculateNewsAdjustment(newsContext, globalContext);
  const signalAdjustment = calculateSignalAdjustment(signalContext, globalContext);

  let conviction =
    hqs * 0.22 +
    ai * 0.28 +
    strategy * 0.18 +
    resilience * 0.12 +
    narrativeBoost +
    discoveryBoost +
    researchBoost +
    globalBoost +
    memoryBoost +
    metaBoost -
    eventPenalty +
    newsAdjustment +
    signalAdjustment;

  return clamp(Math.round(conviction), 0, 100);
}

/* ===============================
   FINAL RATING
================================ */

function buildFinalRating(score) {
  const s = safe(score);

  if (s >= 90) return "Elite Conviction";
  if (s >= 80) return "High Conviction";
  if (s >= 65) return "Strong Opportunity";
  if (s >= 50) return "Watchlist";
  return "Low Conviction";
}

/* ===============================
   FINAL DECISION
================================ */

function buildFinalDecision(score) {
  const s = safe(score);

  if (s >= 80) return "AGGRESSIV PRÜFEN";
  if (s >= 65) return "PRÜFEN";
  if (s >= 50) return "BEOBACHTEN";
  return "IGNORIEREN";
}

/* ===============================
   FINAL CONFIDENCE
================================ */

function buildFinalConfidence({
  learning,
  brain,
  globalContext,
  resilienceScore,
}) {
  const learningConfidence = safe(learning?.confidence, 0.5) * 100;
  const resilience = safe(resilienceScore, 0.5) * 100;
  const orchestratorConfidence = safe(
    globalContext?.orchestrator?.orchestratorConfidence,
    0
  );

  const confidence =
    learningConfidence * 0.25 +
    resilience * 0.20 +
    orchestratorConfidence * 0.55;

  return clamp(Math.round(confidence), 0, 100);
}

/* ===============================
   EXPLAINABILITY SUMMARY
================================ */

function buildWhyItIsInteresting({
  narratives = [],
  discoveries = [],
  globalContext = {},
  strategy = {},
  features = {},
  newsContext = null,
  signalContext = null,
}) {
  const reasons = [];

  const trendStrength = safe(features?.trendStrength, 0);
  const relativeVolume = safe(features?.relativeVolume, 0);
  const liquidityScore = safe(features?.liquidityScore, 0);

  if (trendStrength > 1) reasons.push("starker Trend");
  if (relativeVolume > 1.2) reasons.push("überdurchschnittliches Volumen");
  if (liquidityScore >= 70) reasons.push("hohe Liquidität");

  const signal = resolveSignalContext(signalContext, globalContext);
  const signalStrength = Math.round(
    calculateSignalStrength(signal, globalContext) * 100
  );

  if (signalStrength >= SIGNAL_REASON_STRENGTH_THRESHOLD) {
    if (signal?.earlySignalType === "potential_breakout") {
      reasons.push("frühes Breakout-Signal");
    } else if (signal?.earlySignalType === "early_interest") {
      reasons.push("frühes Marktinteresse");
    } else if (signal?.signalDirection === "bullish") {
      reasons.push("bullisches Signal-Setup");
    } else if (signal?.signalDirection === "bearish") {
      reasons.push("bearisches Signal-Setup");
    }
  }

  if (signal?.trendLevel === "exploding" || signal?.trendLevel === "very_hot") {
    reasons.push(`Trend ${signal.trendLevel}`);
  } else if (
    signal?.trendLevel === "hot" &&
    signalStrength >= SIGNAL_REASON_STRENGTH_THRESHOLD
  ) {
    reasons.push("heißes Signal-Setup");
  }

  const news = resolveNewsContext(newsContext, globalContext);
  const newsStrength = calculateNewsStrength(news, globalContext);
  const newsDirectionScore = calculateNewsDirectionScore(news, globalContext);

  if (safe(news?.activeCount, 0) > 0 && newsStrength >= NEWS_REASON_STRENGTH_THRESHOLD) {
    if (newsDirectionScore >= 0.12) {
      reasons.push("positive News-Lage");
    } else if (newsDirectionScore <= -0.12) {
      reasons.push("belastende News-Lage");
    } else {
      reasons.push("relevante News-Lage");
    }
  }

  if (news?.dominantEventType && safe(news?.activeCount, 0) > 0) {
    reasons.push(`News-Fokus ${news.dominantEventType}`);
  }

  if (Array.isArray(discoveries) && discoveries.length > 0) {
    reasons.push("aktives Marktsignal");
  }

  if (Array.isArray(narratives) && narratives.length > 0) {
    reasons.push("starkes Markt-Narrativ");
  }

  if (String(strategy?.strategy || "") === "momentum") {
    reasons.push("passt zur Momentum-Strategie");
  }

  const riskMode = globalContext?.orchestrator?.riskMode?.mode;
  if (riskMode === "risk_on") reasons.push("positives Marktumfeld");
  if (riskMode === "risk_off") reasons.push("vorsichtiges Marktumfeld");

  return reasons.slice(0, 5);
}

/* ===============================
   MAIN INTEGRATION
================================ */

function buildIntegratedMarketView({
  symbol,
  hqs,
  features,
  discoveries,
  learning,
  brain,
  strategy,
  narratives,
  simulations,
  resilienceScore,
  research,
  globalContext,
  newsContext = null,
  signalContext = null,
}) {
  const mergedGlobalContext = {
    ...(globalContext ?? {}),
    newsContext: resolveNewsContext(newsContext, globalContext),
    signalContext: resolveSignalContext(signalContext, globalContext),
  };

  const finalConviction = calculateFinalConviction({
    hqsScore: hqs?.hqsScore,
    aiScore: brain?.aiScore,
    strategyAdjustedScore: strategy?.strategyAdjustedScore,
    resilienceScore,
    narratives,
    discoveries,
    researchSignals: research?.researchSignals,
    globalContext: mergedGlobalContext,
    newsContext,
    signalContext,
  });

  const finalConfidence = buildFinalConfidence({
    learning,
    brain,
    globalContext: mergedGlobalContext,
    resilienceScore,
  });

  const finalRating = buildFinalRating(finalConviction);
  const finalDecision = buildFinalDecision(finalConviction);

  const whyInteresting = buildWhyItIsInteresting({
    narratives,
    discoveries,
    globalContext: mergedGlobalContext,
    strategy,
    features,
    newsContext,
    signalContext,
  });

  const newsAdjustment = calculateNewsAdjustment(newsContext, mergedGlobalContext);
  const newsStrength = Math.round(
    calculateNewsStrength(newsContext, mergedGlobalContext) * 100
  );
  const signalAdjustment = calculateSignalAdjustment(
    signalContext,
    mergedGlobalContext
  );
  const signalStrength = Math.round(
    calculateSignalStrength(signalContext, mergedGlobalContext) * 100
  );

  return {
    symbol,

    hqsScore: safe(hqs?.hqsScore),
    aiScore: safe(brain?.aiScore),

    finalConviction,
    finalConfidence,
    finalRating,
    finalDecision,

    regime: hqs?.regime ?? null,

    features: features ?? {},
    discoveries: discoveries ?? [],
    learning: learning ?? {},
    strategy: strategy ?? {},
    narratives: narratives ?? [],
    simulations: simulations ?? [],
    resilienceScore: safe(resilienceScore),
    research: research ?? {},
    globalContext: mergedGlobalContext,
    newsContext: mergedGlobalContext.newsContext ?? null,
    signalContext: mergedGlobalContext.signalContext ?? null,

    whyInteresting,

    components: {
      hqs: safe(hqs?.hqsScore),
      ai: safe(brain?.aiScore),
      strategyAdjusted: safe(strategy?.strategyAdjustedScore),
      resilience: safe(resilienceScore),
      memoryScore: safe(mergedGlobalContext?.marketMemory?.memoryScore, 0),
      opportunityStrength: safe(
        mergedGlobalContext?.orchestrator?.opportunityStrength,
        0
      ),
      orchestratorConfidence: safe(
        mergedGlobalContext?.orchestrator?.orchestratorConfidence,
        0
      ),
      newsStrength,
      newsAdjustment,
      signalStrength,
      signalAdjustment,
    },

    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  buildIntegratedMarketView,
};
