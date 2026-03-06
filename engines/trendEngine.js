"use strict";

/**
 * Trend/Volatility Engine
 *
 * Output:
 * - trend
 * - volatilityDaily
 * - volatilityAnnual
 * - score
 *
 * NEW:
 * - momentum
 * - acceleration
 * - trendStrength
 */

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function cleanPrices(prices) {
  const out = [];
  for (const p of prices || []) {
    const n = toNumber(p);
    if (n !== null && n > 0) out.push(n);
  }
  return out;
}

function ensureOldestToNewest(prices) {
  const order = String(process.env.PRICES_ORDER || "").toLowerCase().trim();

  if (order === "asc") return [...prices];
  if (order === "desc") return [...prices].reverse();

  if (prices.length < 3) return [...prices];

  const checks = Math.min(10, prices.length - 1);

  let saneCount = 0;

  for (let i = 1; i <= checks; i++) {
    const prev = prices[i - 1];
    const cur = prices[i];

    if (!prev || !cur) continue;

    const r = (cur - prev) / prev;

    if (Number.isFinite(r) && r > -0.5 && r < 0.5) saneCount++;
  }

  const looksAsc = saneCount >= Math.floor(checks * 0.6);

  if (looksAsc) return [...prices];

  return [...prices].reverse();
}

function calculateReturns(pricesOldestToNewest) {
  const returns = [];

  for (let i = 1; i < pricesOldestToNewest.length; i++) {
    const prev = pricesOldestToNewest[i - 1];
    const cur = pricesOldestToNewest[i];

    if (!prev) continue;

    returns.push((cur - prev) / prev);
  }

  return returns;
}

function calculateVolatilityDaily(returns) {
  if (!returns.length) return 0;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;

  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) /
    returns.length;

  return Math.sqrt(variance);
}

function calculateTrend(pricesOldestToNewest) {
  if (pricesOldestToNewest.length < 2) return 0;

  const oldest = pricesOldestToNewest[0];
  const newest = pricesOldestToNewest[pricesOldestToNewest.length - 1];

  if (!oldest) return 0;

  return (newest - oldest) / oldest;
}

/* =========================================================
   NEW QUANT METRICS
========================================================= */

function calculateMomentum(series) {
  if (series.length < 10) return 0;

  const recent = series.slice(-10);
  const start = recent[0];
  const end = recent[recent.length - 1];

  if (!start) return 0;

  return (end - start) / start;
}

function calculateAcceleration(series) {
  if (series.length < 20) return 0;

  const mid = Math.floor(series.length / 2);

  const firstHalf = series.slice(0, mid);
  const secondHalf = series.slice(mid);

  const trend1 =
    (firstHalf[firstHalf.length - 1] - firstHalf[0]) / firstHalf[0];

  const trend2 =
    (secondHalf[secondHalf.length - 1] - secondHalf[0]) / secondHalf[0];

  return trend2 - trend1;
}

function calculateTrendStrength(trend, volatilityAnnual) {
  if (!volatilityAnnual) return trend;

  return trend / volatilityAnnual;
}

/* =========================================================
   MAIN ENGINE
========================================================= */

function buildTrendScore(prices) {
  const cleaned = cleanPrices(prices);

  if (cleaned.length < 2) {
    return {
      trend: 0,
      volatilityDaily: 0,
      volatilityAnnual: 0,
      score: 0,
      momentum: 0,
      acceleration: 0,
      trendStrength: 0,
    };
  }

  const series = ensureOldestToNewest(cleaned);

  const returns = calculateReturns(series);

  const volatilityDaily = calculateVolatilityDaily(returns);

  const volatilityAnnual = volatilityDaily * Math.sqrt(252);

  const trend = calculateTrend(series);

  const momentum = calculateMomentum(series);

  const acceleration = calculateAcceleration(series);

  const trendStrength = calculateTrendStrength(trend, volatilityAnnual);

  const score =
    trend * (1 - Math.min(volatilityAnnual, 0.95));

  return {
    trend,
    volatilityDaily,
    volatilityAnnual,
    score,
    momentum,
    acceleration,
    trendStrength,
  };
}

module.exports = { buildTrendScore };
