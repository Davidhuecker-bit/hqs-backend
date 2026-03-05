"use strict";

/**
 * Monte Carlo (GBM, lognormal)
 * Inputs:
 * - S: start price
 * - totalTrend: total return over the same window as your trend estimate (e.g. last 252 days)
 * - sigmaDaily: daily volatility (std dev of daily returns)
 * - days: number of simulated days
 * - simulations: paths
 *
 * ✅ NEW (backward compatible):
 * - optional options: { returnMode: "price"|"percent"|"both", seed?: number }
 * - returns percent summaries when requested (useful for weeks/months)
 * - meta fields for debugging
 */

function randomNormal(rand = Math.random) {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = rand(); // avoid 0
  while (v === 0) v = rand();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function safeNumber(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  const x = safeNumber(n, min);
  return Math.max(min, Math.min(max, x));
}

// simple seeded RNG (optional)
function makeSeededRng(seed) {
  let s = Math.floor(safeNumber(seed, 0)) || 0;
  if (!s) return null;

  // LCG parameters
  const m = 0x80000000; // 2^31
  const a = 1103515245;
  const c = 12345;

  return function rand() {
    s = (a * s + c) % m;
    return s / (m - 1);
  };
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

function toPct(price, S0) {
  const p = safeNumber(price, NaN);
  const s = safeNumber(S0, NaN);
  if (!Number.isFinite(p) || !Number.isFinite(s) || s <= 0) return null;
  return ((p - s) / s) * 100;
}

/**
 * Backward compatible call:
 *   monteCarloSimulation(S, totalTrend, sigmaDaily, days, simulations)
 *
 * New optional 6th arg:
 *   monteCarloSimulation(S, totalTrend, sigmaDaily, days, simulations, { returnMode, seed })
 */
function monteCarloSimulation(S, totalTrend, sigmaDaily, days = 252, simulations = 1000, options = null) {
  const S0 = safeNumber(S, 0);

  if (S0 <= 0) {
    return {
      pessimistic: null,
      realistic: null,
      optimistic: null,
      mean: null,
      min: null,
      max: null,
      pessimisticPct: null,
      realisticPct: null,
      optimisticPct: null,
      meanPct: null,
      minPct: null,
      maxPct: null,
      meta: null,
    };
  }

  const d = Math.max(1, Math.floor(safeNumber(days, 252)));
  const sims = Math.max(100, Math.floor(safeNumber(simulations, 1000)));

  const trend = safeNumber(totalTrend, 0);

  // derive muDaily from total trend over d days (geometric)
  // guard: if trend <= -1, clamp
  const cappedTrend = clamp(trend, -0.95, 3.0); // allow strong bull runs but cap insane inputs
  const muDaily = Math.pow(1 + cappedTrend, 1 / d) - 1;

  const sigma = Math.max(0, safeNumber(sigmaDaily, 0));

  const dt = 1; // 1 day step
  const drift = (muDaily - 0.5 * sigma * sigma) * dt;
  const shockScale = sigma * Math.sqrt(dt);

  // options
  const returnMode = String(options?.returnMode || "price").toLowerCase(); // price|percent|both
  const seeded = makeSeededRng(options?.seed);
  const rand = seeded || Math.random;

  const results = new Array(sims);

  for (let i = 0; i < sims; i++) {
    let price = S0;

    for (let t = 0; t < d; t++) {
      const z = randomNormal(rand);
      const step = drift + shockScale * z;

      // guard against numerical explosions
      if (!Number.isFinite(step)) continue;

      price = price * Math.exp(step);

      if (!Number.isFinite(price) || price <= 0) {
        price = 0;
        break;
      }
    }

    results[i] = price;
  }

  // filter out invalid
  const clean = results.filter((x) => Number.isFinite(x) && x > 0);
  if (!clean.length) {
    return {
      pessimistic: null,
      realistic: null,
      optimistic: null,
      mean: null,
      min: null,
      max: null,
      pessimisticPct: null,
      realisticPct: null,
      optimisticPct: null,
      meanPct: null,
      minPct: null,
      maxPct: null,
      meta: { days: d, sims, muDaily, sigmaDaily: sigma },
    };
  }

  clean.sort((a, b) => a - b);

  const min = clean[0];
  const max = clean[clean.length - 1];
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;

  const pessimistic = quantile(clean, 0.10);
  const realistic = quantile(clean, 0.50);
  const optimistic = quantile(clean, 0.90);

  const out = {
    pessimistic,
    realistic,
    optimistic,
    mean,
    min,
    max,

    // percent outputs (optional but always computed safely)
    pessimisticPct: toPct(pessimistic, S0),
    realisticPct: toPct(realistic, S0),
    optimisticPct: toPct(optimistic, S0),
    meanPct: toPct(mean, S0),
    minPct: toPct(min, S0),
    maxPct: toPct(max, S0),

    meta: {
      days: d,
      sims: clean.length,
      muDaily,
      sigmaDaily: sigma,
      returnMode,
      seeded: !!seeded,
    },
  };

  // Keep backward compatibility: if someone expects only prices, they can still use pessimistic/realistic/optimistic.
  // returnMode is informational for now; we include both always to avoid breaking.
  return out;
}

module.exports = { monteCarloSimulation };
