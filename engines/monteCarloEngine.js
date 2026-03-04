"use strict";

/**
 * Monte Carlo (GBM, lognormal)
 * Inputs:
 * - S: start price
 * - totalTrend: total return over the same window as your trend estimate (e.g. last 252 days)
 * - sigmaDaily: daily volatility (std dev of daily returns)
 * - days: number of simulated days
 * - simulations: paths
 */

function randomNormal() {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random(); // avoid 0
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function safeNumber(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function quantile(sortedArr, q) {
  if (!sortedArr.length) return null;
  const pos = (sortedArr.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const left = sortedArr[base];
  const right = sortedArr[Math.min(base + 1, sortedArr.length - 1)];
  return left + rest * (right - left);
}

function monteCarloSimulation(S, totalTrend, sigmaDaily, days = 252, simulations = 1000) {
  const S0 = safeNumber(S, 0);
  if (S0 <= 0) {
    return { pessimistic: null, realistic: null, optimistic: null, mean: null, min: null, max: null };
  }

  const d = Math.max(1, Math.floor(safeNumber(days, 252)));
  const sims = Math.max(100, Math.floor(safeNumber(simulations, 1000)));

  const trend = safeNumber(totalTrend, 0);

  // derive muDaily from total trend over d days (geometric)
  // guard: if trend <= -1, clamp
  const cappedTrend = Math.max(-0.95, trend);
  const muDaily = Math.pow(1 + cappedTrend, 1 / d) - 1;

  const sigma = Math.max(0, safeNumber(sigmaDaily, 0));

  const dt = 1; // 1 day step
  const drift = (muDaily - 0.5 * sigma * sigma) * dt;
  const shockScale = sigma * Math.sqrt(dt);

  const results = new Array(sims);

  for (let i = 0; i < sims; i++) {
    let price = S0;

    for (let t = 0; t < d; t++) {
      const z = randomNormal();
      price = price * Math.exp(drift + shockScale * z);
    }

    results[i] = price;
  }

  results.sort((a, b) => a - b);

  // summary stats
  const min = results[0];
  const max = results[results.length - 1];
  const mean = results.reduce((a, b) => a + b, 0) / results.length;

  return {
    pessimistic: quantile(results, 0.10),
    realistic: quantile(results, 0.50),
    optimistic: quantile(results, 0.90),
    mean,
    min,
    max,
  };
}

module.exports = { monteCarloSimulation };
