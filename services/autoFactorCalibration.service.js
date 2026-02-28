"use strict";

/*
  HQS AUTO FACTOR CALIBRATION – FULL VERSION
  - Rolling Learning Window
  - Regime Adaptive Weights
  - Stable Fallback
*/

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr) {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map(x => (x - m) ** 2)));
}

function correlation(a, b) {
  if (a.length !== b.length || a.length < 5) return 0;

  const meanA = mean(a);
  const meanB = mean(b);

  let num = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - meanA) * (b[i] - meanB);
  }

  const denom = std(a) * std(b) * a.length;
  if (!denom) return 0;

  return num / denom;
}

/*
  factorHistory format:
  [
    {
      return: 0.01,
      regime: "risk_on",
      factors: {
        momentum: 60,
        volatility: -5,
        earnings: 8,
        correlation: -12,
        macro: 3
      }
    }
  ]
*/

function normalizeWeights(rawWeights) {
  const sumAbs = Object.values(rawWeights)
    .map(Math.abs)
    .reduce((a, b) => a + b, 0);

  if (!sumAbs) return null;

  const normalized = {};
  for (const k in rawWeights) {
    normalized[k] = rawWeights[k] / sumAbs;
  }

  return normalized;
}

function calibrateForRegime(factorHistory, regime, windowSize = 90) {
  const filtered = factorHistory
    .filter(r => r.regime === regime)
    .slice(-windowSize);

  if (filtered.length < 20) return null;

  const factorNames = Object.keys(filtered[0].factors);
  const returns = filtered.map(r => r.return);

  const rawWeights = {};

  for (const factor of factorNames) {
    const values = filtered.map(r => r.factors[factor] || 0);
    rawWeights[factor] = correlation(values, returns);
  }

  return normalizeWeights(rawWeights);
}

function calibrateFactorWeights(factorHistory = []) {
  if (!Array.isArray(factorHistory) || factorHistory.length < 30)
    return null;

  const regimes = ["risk_on", "risk_off", "neutral"];
  const result = {};

  for (const regime of regimes) {
    const calibrated = calibrateForRegime(factorHistory, regime);
    if (calibrated) {
      result[regime] = calibrated;
    }
  }

  return result;
}

module.exports = {
  calibrateFactorWeights
};
