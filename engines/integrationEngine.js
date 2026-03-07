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
    eventPenalty;

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
}) {
  const reasons = [];

  const trendStrength = safe(features?.trendStrength, 0);
  const relativeVolume = safe(features?.relativeVolume, 0);
  const liquidityScore = safe(features?.liquidityScore, 0);

  if (trendStrength > 1) reasons.push("starker Trend");
  if (relativeVolume > 1.2) reasons.push("überdurchschnittliches Volumen");
  if (liquidityScore >= 70) reasons.push("hohe Liquidität");

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
}) {
  const finalConviction = calculateFinalConviction({
    hqsScore: hqs?.hqsScore,
    aiScore: brain?.aiScore,
    strategyAdjustedScore: strategy?.strategyAdjustedScore,
    resilienceScore,
    narratives,
    discoveries,
    researchSignals: research?.researchSignals,
    globalContext,
  });

  const finalConfidence = buildFinalConfidence({
    learning,
    brain,
    globalContext,
    resilienceScore,
  });

  const finalRating = buildFinalRating(finalConviction);
  const finalDecision = buildFinalDecision(finalConviction);

  const whyInteresting = buildWhyItIsInteresting({
    narratives,
    discoveries,
    globalContext,
    strategy,
    features,
  });

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
    globalContext: globalContext ?? {},

    whyInteresting,

    components: {
      hqs: safe(hqs?.hqsScore),
      ai: safe(brain?.aiScore),
      strategyAdjusted: safe(strategy?.strategyAdjustedScore),
      resilience: safe(resilienceScore),
      memoryScore: safe(globalContext?.marketMemory?.memoryScore, 0),
      opportunityStrength: safe(
        globalContext?.orchestrator?.opportunityStrength,
        0
      ),
      orchestratorConfidence: safe(
        globalContext?.orchestrator?.orchestratorConfidence,
        0
      ),
    },

    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  buildIntegratedMarketView,
};
