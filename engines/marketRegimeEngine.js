"use strict";

/**
 * Market Regime Detection (compatible with DB + HQS engine)
 * Returns one of:
 * - "expansion" | "bull" | "neutral" | "bear" | "crash"
 *
 * Inputs expected:
 * - trend: total return over window (e.g. last 252 trading days)
 * - volatilityAnnual: annualized volatility (e.g. 0.20 = 20%)
 */

function safe(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function detectMarketRegime(trend, volatilityAnnual) {
  const t = safe(trend, 0);
  const v = safe(volatilityAnnual, 0);

  // Extreme regimes first
  // "crash": strong negative trend + high volatility
  if (t <= -0.20 && v >= 0.35) return "crash";

  // "expansion": strong positive trend + controlled volatility
  if (t >= 0.20 && v <= 0.25) return "expansion";

  // Standard bull/bear
  if (t >= 0.05) return "bull";
  if (t <= -0.05) return "bear";

  return "neutral";
}

module.exports = { detectMarketRegime };
