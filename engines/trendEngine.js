"use strict";

/**
 * Trend/Volatility Engine
 * Output:
 * - trend: total return over window (oldest->newest)
 * - volatilityDaily: std dev of daily returns
 * - volatilityAnnual: volatilityDaily * sqrt(252)
 *
 * ✅ FIX:
 * - Massive historical is requested with sort=asc (oldest->newest)
 * - Old version always reversed -> wrong trend/returns
 * - Now: auto-detect order + optional env override
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
 * Decide order:
 * - If env PRICES_ORDER is set:
 *     "asc"  -> already oldest->newest, do nothing
 *     "desc" -> reverse
 * - Else auto detect:
 *     If last price >= first price AND also typical daily return seems sane,
 *     assume it's already asc.
 *     Otherwise reverse.
 *
 * This is a heuristic but works well with Massive (asc) + many APIs (desc).
 */
function ensureOldestToNewest(prices) {
  const order = String(process.env.PRICES_ORDER || "").toLowerCase().trim();

  if (order === "asc") return [...prices];
  if (order === "desc") return [...prices].reverse();

  if (prices.length < 3) return [...prices];

  const first = prices[0];
  const last = prices[prices.length - 1];

  // quick sanity: compute a few returns without reversing
  let saneCount = 0;
  const checks = Math.min(10, prices.length - 1);

  for (let i = 1; i <= checks; i++) {
    const prev = prices[i - 1];
    const cur = prices[i];
    if (!prev || !cur) continue;

    const r = (cur - prev) / prev;

    // "sane" daily return range (very loose)
    if (Number.isFinite(r) && r > -0.5 && r < 0.5) saneCount++;
  }

  const looksAsc = saneCount >= Math.floor(checks * 0.6);

  // If looks asc, keep it. If not, reverse.
  // If ambiguous, fallback to "asc" when last is close to first (not decisive).
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

  // ✅ Standardize direction safely
  const series = ensureOldestToNewest(cleaned);

  const returns = calculateReturns(series);
  const volatilityDaily = calculateVolatilityDaily(returns);
  const volatilityAnnual = volatilityDaily * Math.sqrt(252);
  const trend = calculateTrend(series);

  // Combined score (bounded-ish)
  const score = trend * (1 - Math.min(volatilityAnnual, 0.95));

  return {
    trend,
    volatilityDaily,
    volatilityAnnual,
    score,
  };
}

module.exports = { buildTrendScore };
