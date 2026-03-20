"use strict";

/*
  Market Brain – AI Subscore Builder

  Leitet einen KI-gewichteten Teilscore aus HQS, Features,
  Monte-Carlo-Szenarien, Discoveries und Learning ab.

  Verantwortung: AI-Subscore als Eingabe für integrationEngine.
  Nicht als zweite finale Scoring-Schicht gedacht – der endgültige
  Conviction-Score wird ausschließlich in integrationEngine berechnet.

  Ablauf: marketOrchestrator → marketBrain (AI-Subscore) → integrationEngine (Finale Integration)
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/* ===============================
   DISCOVERY BOOST
================================ */

function calculateDiscoveryBoost(discoveries = []) {

  let boost = 0;

  for (const d of discoveries) {

    if (d.type === "momentum_explosion") boost += 6;
    if (d.type === "trend_acceleration") boost += 4;
    if (d.type === "volatility_compression") boost += 3;

  }

  return boost;
}

/* ===============================
   MONTE CARLO PROBABILITY
================================ */

function extractMonteCarloProbability(scenarios) {

  if (!scenarios || !scenarios.horizons) return 0;

  const h90 = scenarios.horizons["90"];

  if (!h90) return 0;

  const base = safe(h90.base);
  const bull = safe(h90.bull);

  return clamp((base + bull) / 2, -1, 1);
}

/* ===============================
   RISK PENALTY
================================ */

function calculateRiskPenalty(volatility) {

  const v = safe(volatility);

  if (v > 0.9) return -10;
  if (v > 0.6) return -6;
  if (v > 0.4) return -3;

  return 0;
}

/* ===============================
   AI SUBSCORE
================================ */

function buildAIScore({

  symbol,
  hqsScore,
  features,
  advanced,
  discoveries,
  learning

}) {

  const base = safe(hqsScore);

  const trendStrength = safe(features?.trendStrength);
  const liquidity = safe(features?.liquidityScore);

  const volatility = safe(advanced?.volatilityAnnual);
  const scenarios = advanced?.scenarios;

  const learningConfidence = safe(learning?.confidence, 0.5);

  const discoveryBoost = calculateDiscoveryBoost(discoveries);

  const monteCarlo = extractMonteCarloProbability(scenarios);

  const riskPenalty = calculateRiskPenalty(volatility);

  let score =
    base * 0.55 +
    trendStrength * 8 +
    liquidity * 0.05 +
    monteCarlo * 15 +
    discoveryBoost +
    riskPenalty;

  score *= learningConfidence;

  const finalScore = clamp(Math.round(score), 0, 100);

  return {

    symbol,

    aiScore: finalScore,

    components: {
      baseScore: base,
      trendStrength,
      liquidity,
      monteCarlo,
      discoveryBoost,
      learningConfidence,
      riskPenalty
    }

  };

}

module.exports = {
  buildAIScore
};
