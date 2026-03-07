"use strict";

/*
 Ultra Learning Engine
 Self adapting prediction intelligence
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

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
  const h = safe(horizonDays);

  if (!h) return r;

  const normalized = r / Math.sqrt(h);

  return normalized;

}

/* ===============================
 PERFORMANCE SCORE
================================ */

function normalizePerformance(actualReturn) {

  const r = safe(actualReturn);

  if (r > 0.20) return 1;
  if (r > 0.10) return 0.7;
  if (r > 0.03) return 0.4;
  if (r > -0.03) return 0;
  if (r > -0.10) return -0.5;

  return -1;

}

/* ===============================
 FEATURE IMPACT
================================ */

function calculateFeatureImpact(features, performanceScore) {

  const impacts = {};

  for (const key of Object.keys(features)) {

    const value = safe(features[key]);

    impacts[key] = value * performanceScore;

  }

  return impacts;

}

/* ===============================
 SIGNAL COMBINATION
================================ */

function detectFeatureCombination(features) {

  const keys = Object.keys(features)
    .filter(k => safe(features[k]) > 0.6)
    .sort();

  return keys.join("+");

}

/* ===============================
 LEARNING RATE
================================ */

function calculateLearningRate(regime) {

  if (regime === "crash") return 0.005;

  if (regime === "bear") return 0.003;

  if (regime === "bull") return 0.002;

  return 0.002;

}

/* ===============================
 WEIGHT ADJUSTMENT
================================ */

function adjustWeights(currentWeights, impacts, learningRate) {

  const updated = { ...currentWeights };

  for (const key of Object.keys(impacts)) {

    const impact = safe(impacts[key]);

    if (!updated[key]) continue;

    updated[key] =
      clamp(
        updated[key] + impact * learningRate,
        0.01,
        1
      );

  }

  return updated;

}

/* ===============================
 CONFIDENCE SCORE
================================ */

function calculateConfidence(error) {

  const e = Math.abs(safe(error));

  const confidence = 1 - clamp(e, 0, 1);

  return clamp(confidence, 0, 1);

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
  horizonDays = 30

}) {

  const horizonAdjusted =
    calculateHorizonAdjustment(
      actualReturn,
      horizonDays
    );

  const error =
    calculatePredictionError(
      prediction,
      horizonAdjusted
    );

  const performanceScore =
    normalizePerformance(
      horizonAdjusted
    );

  const impacts =
    calculateFeatureImpact(
      features,
      performanceScore
    );

  const learningRate =
    calculateLearningRate(regime);

  const newWeights =
    adjustWeights(
      weights,
      impacts,
      learningRate
    );

  const confidence =
    calculateConfidence(error);

  const featureCombination =
    detectFeatureCombination(features);

  return {

    symbol,

    error,

    confidence,

    performanceScore,

    learningRate,

    featureCombination,

    impacts,

    newWeights

  };

}

module.exports = {
  evaluateLearning
};
