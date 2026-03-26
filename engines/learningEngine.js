"use strict";

/*
  Ultra Learning Engine
  Self adapting prediction intelligence

  Final compatible version:
  - same export
  - same input signature
  - same output fields
  - smarter confidence curve
  - adaptive learning rate by regime + surprise factor
  - configurable thresholds
  - safer feature/weight handling
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, safe(v, min)));
}

function envNum(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeKeyPart(value, fallback = "none") {
  const normalized = String(value ?? fallback)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");
  return normalized || fallback;
}

/* ===============================
   CONFIG
================================ */

const FEATURE_COMBINATION_THRESHOLD = envNum("ULTRA_FEATURE_THRESHOLD", 0.6);
const FEATURE_IMPACT_MIN = envNum("ULTRA_FEATURE_IMPACT_MIN", 0.1);

const LR_CRASH = envNum("ULTRA_LR_CRASH", 0.005);
const LR_BEAR = envNum("ULTRA_LR_BEAR", 0.003);
const LR_BULL = envNum("ULTRA_LR_BULL", 0.002);
const LR_NEUTRAL = envNum("ULTRA_LR_NEUTRAL", 0.002);

const LEARNING_SURPRISE_THRESHOLD = envNum("ULTRA_SURPRISE_THRESHOLD", 0.5);
const LEARNING_SURPRISE_MULTIPLIER = envNum("ULTRA_SURPRISE_MULTIPLIER", 2);

const MIN_WEIGHT = envNum("ULTRA_WEIGHT_MIN", 0.01);
const MAX_WEIGHT = envNum("ULTRA_WEIGHT_MAX", 1);

const PERFORMANCE_STRONG_POS = envNum("ULTRA_PERF_STRONG_POS", 0.20);
const PERFORMANCE_POS = envNum("ULTRA_PERF_POS", 0.10);
const PERFORMANCE_MILD_POS = envNum("ULTRA_PERF_MILD_POS", 0.03);
const PERFORMANCE_NEUTRAL_LOW = envNum("ULTRA_PERF_NEUTRAL_LOW", -0.03);
const PERFORMANCE_NEG = envNum("ULTRA_PERF_NEG", -0.10);

const CONFIDENCE_MIN = envNum("ULTRA_CONFIDENCE_MIN", 0);
const CONFIDENCE_MAX = envNum("ULTRA_CONFIDENCE_MAX", 1);
const CONFIDENCE_CURVE_POWER = envNum("ULTRA_CONFIDENCE_CURVE_POWER", 1.5);

/* ===============================
   PREDICTION ERROR
================================ */

function calculatePredictionError(predicted, actual) {
  const p = safe(predicted);
  const a = safe(actual);
  return a - p;
}

/* ===============================
   TIME ADJUSTMENT
================================ */

function calculateHorizonAdjustment(actualReturn, horizonDays) {
  const r = safe(actualReturn);
  const h = Math.max(1, safe(horizonDays, 30));

  // keep cross-horizon comparability
  return r / Math.sqrt(h);
}

/* ===============================
   PERFORMANCE SCORE
================================ */

function normalizePerformance(actualReturn) {
  const r = safe(actualReturn);

  if (r > PERFORMANCE_STRONG_POS) return 1;
  if (r > PERFORMANCE_POS) return 0.7;
  if (r > PERFORMANCE_MILD_POS) return 0.4;
  if (r > PERFORMANCE_NEUTRAL_LOW) return 0;
  if (r > PERFORMANCE_NEG) return -0.5;

  return -1;
}

/* ===============================
   FEATURE IMPACT
================================ */

function calculateFeatureImpact(features, performanceScore) {
  const impacts = {};

  for (const [key, value] of Object.entries(features || {})) {
    const val = safe(value, NaN);
    if (!Number.isFinite(val)) continue;

    // ignore tiny noise features
    if (Math.abs(val) <= FEATURE_IMPACT_MIN) continue;

    impacts[key] = val * safe(performanceScore);
  }

  return impacts;
}

/* ===============================
   SIGNAL COMBINATION
================================ */

function detectFeatureCombination(features) {
  const keys = Object.keys(features || {})
    .filter((k) => safe(features[k]) > FEATURE_COMBINATION_THRESHOLD)
    .map((k) => normalizeKeyPart(k))
    .sort();

  return keys.join("+") || "none";
}

/* ===============================
   LEARNING RATE
================================ */

function getAdaptiveLearningRate(regime, error) {
  const normalized = normalizeKeyPart(regime, "neutral");

  let rate = LR_NEUTRAL;
  if (normalized === "crash") rate = LR_CRASH;
  else if (normalized === "bear") rate = LR_BEAR;
  else if (normalized === "bull") rate = LR_BULL;

  // surprise factor: learn faster from large misses
  if (Math.abs(safe(error)) > LEARNING_SURPRISE_THRESHOLD) {
    rate *= LEARNING_SURPRISE_MULTIPLIER;
  }

  return rate;
}

/* ===============================
   WEIGHT ADJUSTMENT
================================ */

function adjustWeights(currentWeights, impacts, learningRate) {
  const updated = { ...(currentWeights || {}) };

  for (const [key, impactRaw] of Object.entries(impacts || {})) {
    const impact = safe(impactRaw);

    // keep compatibility: only update existing weights
    if (!Object.prototype.hasOwnProperty.call(updated, key)) continue;

    updated[key] = clamp(
      safe(updated[key]) + impact * safe(learningRate),
      MIN_WEIGHT,
      MAX_WEIGHT
    );
  }

  return updated;
}

/* ===============================
   CONFIDENCE SCORE
================================ */

function calculateConfidence(error) {
  const e = Math.abs(safe(error));

  // non-linear confidence drop:
  // small misses are tolerable, big misses are punished harder
  const normalizedError = clamp(e, 0, 1);
  const confidence = 1 - Math.pow(normalizedError, CONFIDENCE_CURVE_POWER);

  return clamp(confidence, CONFIDENCE_MIN, CONFIDENCE_MAX);
}

/* ===============================
   MAIN LEARNING FUNCTION
================================ */

function evaluateLearning({
  symbol,
  prediction,
  actualReturn,
  features = {},
  weights = {},
  regime = "neutral",
  horizonDays = 30,
}) {
  const horizonAdjusted = calculateHorizonAdjustment(
    actualReturn,
    horizonDays
  );

  const error = calculatePredictionError(
    prediction,
    horizonAdjusted
  );

  const performanceScore = normalizePerformance(
    horizonAdjusted
  );

  const impacts = calculateFeatureImpact(
    features,
    performanceScore
  );

  const learningRate = getAdaptiveLearningRate(
    regime,
    error
  );

  const newWeights = adjustWeights(
    weights,
    impacts,
    learningRate
  );

  const confidence = calculateConfidence(error);

  const featureCombination = detectFeatureCombination(features);

  return {
    symbol,
    error,
    confidence,
    performanceScore,
    learningRate,
    featureCombination,
    impacts,
    newWeights,
  };
}

module.exports = {
  evaluateLearning,
};
