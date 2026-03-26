"use strict";

/**
 * Trend/Volatility Engine
 *
 * Output:
 * - trend
 * - volatilityDaily
 * - volatilityAnnual
 * - score
 * - momentum
 * - acceleration
 * - trendStrength
 *
 * Compatible replacement:
 * - same function name
 * - same input
 * - same output fields
 */

const TRADING_DAYS_YEAR = 252;

function envNum(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(x, min = -Infinity, max = Infinity, fallback = 0) {
  const n = Number(x);
  const v = Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, v));
}

function toFinite(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function cleanPrices(prices) {
  const out = [];
  for (const p of prices || []) {
    const n = toFinite(p, NaN);
    if (Number.isFinite(n) && n > 0) out.push(n);
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
  return looksAsc ? [...prices] : [...prices].reverse();
}

function calculateReturns(pricesOldestToNewest) {
  const returns = [];

  for (let i = 1; i < pricesOldestToNewest.length; i++) {
    const prev = pricesOldestToNewest[i - 1];
    const cur = pricesOldestToNewest[i];

    if (!prev || prev <= 0) continue;

    const r = (cur - prev) / prev;
    if (Number.isFinite(r)) returns.push(r);
  }

  return returns;
}

function calculateVolatilityDaily(returns) {
  if (returns.length < 2) return 0;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;

  // sample variance (n - 1) is usually more stable for market samples
  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) /
    Math.max(returns.length - 1, 1);

  return Math.sqrt(Math.max(variance, 0));
}

function calculateTrend(pricesOldestToNewest) {
  if (pricesOldestToNewest.length < 2) return 0;

  const oldest = pricesOldestToNewest[0];
  const newest = pricesOldestToNewest[pricesOldestToNewest.length - 1];

  if (!oldest || oldest <= 0) return 0;

  return (newest - oldest) / oldest;
}

/* =========================================================
   QUANT METRICS
========================================================= */

function calculateMomentum(series, window = 10) {
  if (series.length < window) return 0;

  const recent = series.slice(-window);
  const start = recent[0];
  const end = recent[recent.length - 1];

  if (!start || start <= 0) return 0;

  return (end - start) / start;
}

function calculateAcceleration(series, window = 20) {
  if (series.length < window) return 0;

  const recent = series.slice(-window);
  const half = Math.floor(window / 2);

  const firstHalf = recent.slice(0, half);
  const secondHalf = recent.slice(half);

  if (
    firstHalf.length < 2 ||
    secondHalf.length < 2 ||
    !firstHalf[0] ||
    !secondHalf[0]
  ) {
    return 0;
  }

  const trend1 =
    (firstHalf[firstHalf.length - 1] - firstHalf[0]) / firstHalf[0];

  const trend2 =
    (secondHalf[secondHalf.length - 1] - secondHalf[0]) / secondHalf[0];

  return trend2 - trend1;
}

function calculateTrendStrength(trend, volatilityAnnual) {
  const volFloor = envNum("TREND_STRENGTH_VOL_FLOOR", 0.05);
  return trend / Math.max(volatilityAnnual, volFloor);
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
  const volatilityAnnual = volatilityDaily * Math.sqrt(TRADING_DAYS_YEAR);

  const trend = calculateTrend(series);

  const momentumWindow = Math.max(2, Math.floor(envNum("TREND_MOMENTUM_WINDOW", 10)));
  const accelerationWindow = Math.max(4, Math.floor(envNum("TREND_ACCEL_WINDOW", 20)));

  const momentum = calculateMomentum(series, momentumWindow);
  const acceleration = calculateAcceleration(series, accelerationWindow);
  const trendStrength = calculateTrendStrength(trend, volatilityAnnual);

  // Risk-adjusted blended score
  const trendWeight = envNum("TREND_SCORE_W_TREND", 0.5);
  const momentumWeight = envNum("TREND_SCORE_W_MOMENTUM", 0.3);
  const accelerationWeight = envNum("TREND_SCORE_W_ACCEL", 0.2);

  const rawComposite =
    trend * trendWeight +
    momentum * momentumWeight +
    acceleration * accelerationWeight;

  // Keep denominator stable so tiny volatility does not explode the score
  const scoreVolFloor = envNum("TREND_SCORE_VOL_FLOOR", 0.5);
  const score = rawComposite / Math.max(volatilityAnnual, scoreVolFloor);

  return {
    trend: clamp(trend, -10, 10, 0),
    volatilityDaily: clamp(volatilityDaily, 0, 10, 0),
    volatilityAnnual: clamp(volatilityAnnual, 0, 10, 0),
    score: clamp(score, -10, 10, 0),
    momentum: clamp(momentum, -10, 10, 0),
    acceleration: clamp(acceleration, -10, 10, 0),
    trendStrength: clamp(trendStrength, -10, 10, 0),
  };
}

module.exports = { buildTrendScore };
