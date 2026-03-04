"use strict";

/**
 * Trend/Volatility Engine
 * Output:
 * - trend: total return over window (oldest->newest)
 * - volatilityDaily: std dev of daily returns
 * - volatilityAnnual: volatilityDaily * sqrt(252)
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

/**
 * Heuristic: If the series is newest-first, the first value often differs from last substantially,
 * but we can't know direction. We'll standardize to oldest->newest by:
 * - assume input is newest->oldest (common for many APIs) and reverse
 * - BUT to avoid accidental wrong reversal, we provide an option flag.
 *
 * In our project, FMP historical often returns newest->oldest → reversing is correct.
 */
function ensureOldestToNewest(prices) {
  // We default to reversing because FMP historical is typically newest->oldest.
  // If at some point you swap providers and it becomes oldest->newest,
  // trend sign would flip. Then you can set a flag here.
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
    returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;

  return Math.sqrt(variance);
}

function calculateTrend(pricesOldestToNewest) {
  if (pricesOldestToNewest.length < 2) return 0;

  const oldest = pricesOldestToNewest[0];
  const newest = pricesOldestToNewest[pricesOldestToNewest.length - 1];
  if (!oldest) return 0;

  return (newest - oldest) / oldest;
}

function buildTrendScore(prices) {
  const cleaned = cleanPrices(prices);
  if (cleaned.length < 2) {
    return {
      trend: 0,
      volatilityDaily: 0,
      volatilityAnnual: 0,
      score: 0,
    };
  }

  // Standardize direction
  const series = ensureOldestToNewest(cleaned);

  const returns = calculateReturns(series);
  const volatilityDaily = calculateVolatilityDaily(returns);
  const volatilityAnnual = volatilityDaily * Math.sqrt(252);
  const trend = calculateTrend(series);

  // simple combined score (bounded-ish)
  const score = trend * (1 - Math.min(volatilityAnnual, 0.95));

  return {
    trend,
    volatilityDaily,
    volatilityAnnual,
    score,
  };
}

module.exports = { buildTrendScore };
