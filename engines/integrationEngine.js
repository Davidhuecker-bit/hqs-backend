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
  globalContext
}) {
  const hqs = safe(hqsScore);
  const ai = safe(aiScore);
  const strategy = safe(strategyAdjustedScore);
  const resilience = safe(resilienceScore) * 100;

  const narrativeBoost = Array.isArray(narratives) ? narratives.length * 2 : 0;
  const discoveryBoost = Array.isArray(discoveries) ? discoveries.length * 2 : 0;
  const researchBoost = Array.isArray(researchSignals) ? researchSignals.length * 3 : 0;

  let globalBoost = 0;
  const regime = String(globalContext?.regime || "").toLowerCase();

  if (regime === "risk_on") globalBoost += 4;
  if (regime === "neutral") globalBoost += 1;
  if (regime === "risk_off") globalBoost -= 4;
  if (regime === "panic") globalBoost -= 8;

  let conviction =
    hqs * 0.25 +
    ai * 0.30 +
    strategy * 0.20 +
    resilience * 0.15 +
    narrativeBoost +
    discoveryBoost +
    researchBoost +
    globalBoost;

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
  globalContext
}) {
  const finalConviction = calculateFinalConviction({
    hqsScore: hqs?.hqsScore,
    aiScore: brain?.aiScore,
    strategyAdjustedScore: strategy?.strategyAdjustedScore,
    resilienceScore,
    narratives,
    discoveries,
    researchSignals: research?.researchSignals,
    globalContext
  });

  return {
    symbol,

    hqsScore: safe(hqs?.hqsScore),
    aiScore: safe(brain?.aiScore),

    finalConviction,
    finalRating: buildFinalRating(finalConviction),
    finalDecision: buildFinalDecision(finalConviction),

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

    components: {
      hqs: safe(hqs?.hqsScore),
      ai: safe(brain?.aiScore),
      strategyAdjusted: safe(strategy?.strategyAdjustedScore),
      resilience: safe(resilienceScore)
    },

    timestamp: new Date().toISOString()
  };
}

module.exports = {
  buildIntegratedMarketView
};
