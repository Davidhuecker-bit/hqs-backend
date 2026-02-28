"use strict";

/*
  Institutional Risk Metrics Engine
*/

function calculateSharpe(returns = [], riskFreeRate = 0) {
  if (!returns.length) return 0;

  const avg =
    returns.reduce((a, b) => a + b, 0) / returns.length;

  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - avg, 2), 0) /
    returns.length;

  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;

  return Number(((avg - riskFreeRate) / stdDev).toFixed(4));
}

function calculateMaxDrawdown(equityCurve = []) {
  if (!equityCurve.length) return 0;

  let peak = equityCurve[0];
  let maxDrawdown = 0;

  for (let value of equityCurve) {
    if (value > peak) peak = value;

    const drawdown = (peak - value) / peak;

    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  return Number((maxDrawdown * 100).toFixed(2));
}

module.exports = {
  calculateSharpe,
  calculateMaxDrawdown
};
