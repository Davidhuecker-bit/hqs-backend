"use strict";

/*
  Learning Engine
  Evaluates model predictions against real performance
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/* ===============================
   PERFORMANCE SCORE
================================ */

function calculatePredictionError(predicted, actual) {

  const p = safe(predicted);
  const a = safe(actual);

  return a - p;
}

/* ===============================
   FEATURE IMPORTANCE
================================ */

function calculateFeatureImpact(features, performance) {

  const impacts = {};

  for (const key of Object.keys(features)) {

    const value = safe(features[key]);

    impacts[key] = value * performance;

  }

  return impacts;
}

/* ===============================
   WEIGHT ADJUSTMENT
================================ */

function adjustWeights(currentWeights, impacts) {

  const updated = { ...currentWeights };

  for (const key of Object.keys(impacts)) {

    const impact = safe(impacts[key]);

    if (!updated[key]) continue;

    updated[key] = clamp(updated[key] + impact * 0.001, 0.01, 1);

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

function evaluateLearning(symbol, prediction, actualReturn, features, weights) {

  const error = calculatePredictionError(prediction, actualReturn);

  const impacts = calculateFeatureImpact(features, actualReturn);

  const newWeights = adjustWeights(weights, impacts);

  const confidence = calculateConfidence(error);

  return {

    symbol,

    error,

    confidence,

    impacts,

    newWeights

  };

}

module.exports = {
  evaluateLearning
};
