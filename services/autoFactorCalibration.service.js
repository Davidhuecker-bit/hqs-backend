"use strict";

/*
  HQS AUTO FACTOR CALIBRATION – FULL QUANT SAFEGUARD VERSION

  Features:
  - Regime separated learning
  - Rolling window
  - EWMA decay weighting
  - Confidence scoring
  - Weight bounds (min/max caps)
  - Max delta per recalibration (stability control)
  - Safe fallback
*/

const MIN_OBSERVATIONS = 60;
const DEFAULT_WINDOW = 120;
const EWMA_LAMBDA = 0.94;

const MIN_WEIGHT = 0.05;
const MAX_WEIGHT = 0.40;
const MAX_DELTA = 0.10; // max weight change per recalibration

/* =========================
   Math Helpers
========================= */

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr) {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map(x => (x - m) ** 2)));
}

function weightedCorrelation(x, y, weights) {
  if (x.length !== y.length || x.length !== weights.length) return 0;
  if (x.length < 10) return 0;

  const sumW = weights.reduce((a, b) => a + b, 0);
  if (!sumW) return 0;

  const meanX = x.reduce((s, v, i) => s + v * weights[i], 0) / sumW;
  const meanY = y.reduce((s, v, i) => s + v * weights[i], 0) / sumW;

  let cov = 0;
  let varX = 0;
  let varY = 0;

  for (let i = 0; i < x.length; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    cov += weights[i] * dx * dy;
    varX += weights[i] * dx * dx;
    varY += weights[i] * dy * dy;
  }

  if (!varX || !varY) return 0;

  return cov / Math.sqrt(varX * varY);
}

function buildEWMAWeights(length) {
  const weights = [];
  for (let i = 0; i < length; i++) {
    const w = Math.pow(EWMA_LAMBDA, length - 1 - i);
    weights.push(w);
  }
  return weights;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/* =========================
   Confidence Score
========================= */

function calculateConfidence(sampleSize) {
  if (sampleSize >= 200) return 1;
  if (sampleSize >= 120) return 0.85;
  if (sampleSize >= 90) return 0.7;
  if (sampleSize >= 60) return 0.5;
  return 0.3;
}

/* =========================
   Core Calibration
========================= */

function calibrateForRegime(history, regime, previousWeights) {
  const filtered = history
    .filter(r => r.regime === regime)
    .slice(-DEFAULT_WINDOW);

  if (filtered.length < MIN_OBSERVATIONS) return null;

  const factorNames = Object.keys(filtered[0].factors);
  const returns = filtered.map(r => r.return);

  const weightsEWMA = buildEWMAWeights(filtered.length);

  const rawWeights = {};

  for (const factor of factorNames) {
    const values = filtered.map(r => r.factors[factor] || 0);

    const corr = weightedCorrelation(values, returns, weightsEWMA);
    const confidence = calculateConfidence(filtered.length);

    rawWeights[factor] = corr * confidence;
  }

  const sumAbs = Object.values(rawWeights)
    .map(Math.abs)
    .reduce((a, b) => a + b, 0);

  if (!sumAbs) return null;

  const normalized = {};

  for (const key in rawWeights) {
    normalized[key] = rawWeights[key] / sumAbs;
  }

  // Apply bounds + delta limits
  const stabilized = {};

  for (const key in normalized) {
    let target = clamp(normalized[key], MIN_WEIGHT, MAX_WEIGHT);

    if (previousWeights && previousWeights[key] !== undefined) {
      const prev = previousWeights[key];
      const delta = clamp(target - prev, -MAX_DELTA, MAX_DELTA);
      target = prev + delta;
    }

    stabilized[key] = target;
  }

  return stabilized;
}

function calibrateFactorWeights(factorHistory = [], previousState = {}) {
  if (!Array.isArray(factorHistory) || factorHistory.length < MIN_OBSERVATIONS)
    return null;

  const regimes = ["risk_on", "risk_off", "neutral"];
  const result = {};

  for (const regime of regimes) {
    const calibrated = calibrateForRegime(
      factorHistory,
      regime,
      previousState[regime]
    );

    if (calibrated) {
      result[regime] = calibrated;
    }
  }

  return Object.keys(result).length ? result : null;
}

module.exports = {
  calibrateFactorWeights
};
