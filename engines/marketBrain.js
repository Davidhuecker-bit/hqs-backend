"use strict";

/*
  Market Brain – AI Subscore Builder

  Leitet einen KI-gewichteten Teilscore aus HQS, Features,
  Monte-Carlo-Szenarien, Discoveries und Learning ab.

  Verantwortung: AI-Subscore als Eingabe für integrationEngine.
  Nicht als zweite finale Scoring-Schicht gedacht – der endgültige
  Conviction-Score wird ausschließlich in integrationEngine berechnet.

  Ablauf: marketOrchestrator → marketBrain (AI-Subscore) → integrationEngine (Finale Integration)

  Final compatible version:
  - gleiche Schnittstelle
  - gleiche Rückgabeform
  - robustere Discovery-/Risk-/Monte-Carlo-Logik
  - etwas intelligentere Gewichtung ohne Seiteneffekte
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function envNum(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, safe(v, min)));
}

/* ===============================
   CONFIG
================================ */

const AI_WEIGHTS = {
  BASE: envNum("AI_WEIGHT_BASE", 0.50),
  TREND_STRENGTH: envNum("AI_WEIGHT_TREND_STRENGTH", 8.5),
  LIQUIDITY: envNum("AI_WEIGHT_LIQUIDITY", 0.05),
  MONTE_CARLO: envNum("AI_WEIGHT_MONTE_CARLO", 15),
};

const DISCOVERY_BOOSTS = {
  momentum_explosion: envNum("AI_DISCOVERY_MOMENTUM_EXPLOSION", 7),
  trend_acceleration: envNum("AI_DISCOVERY_TREND_ACCELERATION", 4),
  volatility_compression: envNum("AI_DISCOVERY_VOLATILITY_COMPRESSION", 3),
};

const DISCOVERY_CONFLUENCE_MULTIPLIER = envNum("AI_DISCOVERY_CONFLUENCE_MULT", 1.2);

const LOW_LIQUIDITY_THRESHOLD = envNum("AI_LOW_LIQUIDITY_THRESHOLD", 40);
const LEARNING_CONFIDENCE_MIN = envNum("AI_LEARNING_CONFIDENCE_MIN", 0.5);
const LEARNING_CONFIDENCE_MAX = envNum("AI_LEARNING_CONFIDENCE_MAX", 1.5);

const RISK_SAFE_ZONE = envNum("AI_RISK_SAFE_ZONE", 0.25);
const RISK_PENALTY_CAP = envNum("AI_RISK_PENALTY_CAP", 25);

/* ===============================
   DISCOVERY BOOST
================================ */

function calculateDiscoveryBoost(discoveries = []) {
  if (!Array.isArray(discoveries) || !discoveries.length) return 0;

  let total = discoveries.reduce((sum, d) => {
    const type = d?.type;
    return sum + safe(DISCOVERY_BOOSTS[type], 0);
  }, 0);

  // leichter Konfluenz-Bonus, aber kontrolliert
  if (discoveries.length >= 2) {
    total *= DISCOVERY_CONFLUENCE_MULTIPLIER;
  }

  return total;
}

/* ===============================
   MONTE CARLO SIGNAL
================================ */

function extractMonteCarloProbability(scenarios) {
  if (!scenarios || typeof scenarios !== "object") return 0;

  // bevorzugt explizite probability-Felder, falls vorhanden
  const explicitProbability = Number(
    scenarios?.probabilityPositive ??
      scenarios?.mcProbability ??
      scenarios?.probability
  );

  if (Number.isFinite(explicitProbability)) {
    return clamp(explicitProbability, -1, 1);
  }

  const h90 = scenarios?.horizons?.["90"];
  if (!h90) return 0;

  const base = safe(h90.base);
  const bull = safe(h90.bull);

  return clamp((base + bull) / 2, -1, 1);
}

/* ===============================
   RISK PENALTY
================================ */

function calculateRiskPenalty(volatility) {
  const v = Math.max(0, safe(volatility));

  if (v <= RISK_SAFE_ZONE) return 0;

  // glattere nichtlineare Kurve statt nur harte Stufen
  const penalty = Math.pow(v * 4, 2);

  return -clamp(penalty, 0, RISK_PENALTY_CAP);
}

/* ===============================
   LIQUIDITY FACTOR
================================ */

function calculateLiquidityFactor(liquidity) {
  const l = safe(liquidity, 100);

  if (l >= LOW_LIQUIDITY_THRESHOLD) return 1;

  return clamp(l / LOW_LIQUIDITY_THRESHOLD, 0.2, 1);
}

/* ===============================
   LEARNING FACTOR
================================ */

function calculateLearningConfidence(learning = {}) {
  // bevorzugt explizitere Vertrauensfelder, fällt sauber zurück
  const raw =
    learning?.trustScore ??
    learning?.confidence ??
    0.5;

  return clamp(
    safe(raw, 0.5),
    LEARNING_CONFIDENCE_MIN,
    LEARNING_CONFIDENCE_MAX
  );
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
  learning,
}) {
  const base = safe(hqsScore);

  const trendStrength = safe(features?.trendStrength);
  const liquidity = safe(features?.liquidityScore, 100);

  const volatility = safe(advanced?.volatilityAnnual);
  const scenarios = advanced?.scenarios;

  const learningConfidence = calculateLearningConfidence(learning);
  const discoveryBoost = calculateDiscoveryBoost(discoveries);
  const monteCarlo = extractMonteCarloProbability(scenarios);
  const riskPenalty = calculateRiskPenalty(volatility);
  const liquidityFactor = calculateLiquidityFactor(liquidity);

  let score =
    base * AI_WEIGHTS.BASE +
    trendStrength * AI_WEIGHTS.TREND_STRENGTH +
    liquidity * AI_WEIGHTS.LIQUIDITY +
    monteCarlo * AI_WEIGHTS.MONTE_CARLO +
    discoveryBoost +
    riskPenalty;

  // Liquiditäts-Gate zuerst
  score *= liquidityFactor;

  // Learning-/Trust-Faktor danach
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
      riskPenalty,
    },
  };
}

module.exports = {
  buildAIScore,
};
