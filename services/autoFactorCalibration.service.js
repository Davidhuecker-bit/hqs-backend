"use strict";

/*
  HQS AUTO FACTOR CALIBRATION ENGINE
  Learns which factors actually drive performance
*/

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr) {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map(x => (x - m) ** 2)));
}

function correlation(a, b) {
  if (a.length !== b.length || a.length < 2) return 0;

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
      return: 0.02,
      factors: {
        momentum: 60,
        volatility: -5,
        earnings: 8,
        correlation: -12,
        macro: 3
      }
    },
    ...
  ]
*/

function calibrateFactorWeights(factorHistory) {
  if (!Array.isArray(factorHistory) || factorHistory.length < 20)
    return null;

  const factorNames = Object.keys(factorHistory[0].factors);

  const returns = factorHistory.map(r => r.return);

  const newWeights = {};

  for (const factor of factorNames) {
    const values = factorHistory.map(r => r.factors[factor] || 0);

    const corr = correlation(values, returns);

    // Convert correlation into weight influence
    newWeights[factor] = corr;
  }

  // Normalize weights to sum = 1
  const sumAbs = Object.values(newWeights)
    .map(Math.abs)
    .reduce((a, b) => a + b, 0);

  if (!sumAbs) return null;

  for (const key in newWeights) {
    newWeights[key] = newWeights[key] / sumAbs;
  }

  return newWeights;
}

module.exports = {
  calibrateFactorWeights
};
