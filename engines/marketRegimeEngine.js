"use strict";

/**
 * Market Regime Detection (compatible with DB + HQS engine)
 * Returns one of:
 * - "expansion" | "bull" | "neutral" | "bear" | "crash"
 *
 * Inputs:
 * - trend: total return over window (e.g. 1y)  -> e.g. 0.12 = +12%
 * - volatilityAnnual: annualized volatility   -> e.g. 0.25 = 25%
 *
 * ✅ NEW:
 * - less flip-flop by using small neutral zones and volatility-aware checks
 * - env tuning optional
 */

function safe(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function envNum(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Default thresholds (good for stocks)
const T_CRASH = envNum("REGIME_CRASH_T", -0.20);
const V_CRASH = envNum("REGIME_CRASH_V", 0.35);

const T_EXPANSION = envNum("REGIME_EXPANSION_T", 0.20);
const V_EXPANSION = envNum("REGIME_EXPANSION_V", 0.25);

// "bull/bear" thresholds (use neutral band)
const T_BULL = envNum("REGIME_BULL_T", 0.08);
const T_BEAR = envNum("REGIME_BEAR_T", -0.08);

// volatility neutral band: if volatility very low, allow smaller trend to be bull/bear
const V_LOW = envNum("REGIME_LOWVOL_V", 0.18);
const V_HIGH = envNum("REGIME_HIGHVOL_V", 0.35);

function detectMarketRegime(trend, volatilityAnnual) {
  const t = safe(trend, 0);
  const v = safe(volatilityAnnual, 0);

  // 1) Extreme regimes first
  if (t <= T_CRASH && v >= V_CRASH) return "crash";
  if (t >= T_EXPANSION && v <= V_EXPANSION) return "expansion";

  // 2) Volatility-aware bull/bear
  // If volatility is very high, require stronger trend signal to call bull/bear
  // If volatility is very low, accept slightly smaller trend signal
  let bullT = T_BULL;
  let bearT = T_BEAR;

  if (v >= V_HIGH) {
    bullT = Math.max(bullT, 0.12);
    bearT = Math.min(bearT, -0.12);
  } else if (v <= V_LOW) {
    bullT = Math.min(bullT, 0.06);
    bearT = Math.max(bearT, -0.06);
  }

  if (t >= bullT) return "bull";
  if (t <= bearT) return "bear";

  return "neutral";
}

module.exports = { detectMarketRegime };
