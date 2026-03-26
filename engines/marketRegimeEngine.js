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
 * Improvements:
 * - safer env parsing (0 is preserved, invalid values fall back cleanly)
 * - defensive sanitization
 * - volatility cannot become negative
 * - partial custom thresholds are easier to maintain internally
 * - same output contract as before (string only)
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

function clamp(x, min = -Infinity, max = Infinity, fallback = 0) {
  const n = safe(x, fallback);
  return Math.max(min, Math.min(max, n));
}

// Default thresholds (good for stocks)
const DEFAULT_CONFIG = {
  crashTrend: envNum("REGIME_CRASH_T", -0.20),
  crashVol: envNum("REGIME_CRASH_V", 0.35),

  expansionTrend: envNum("REGIME_EXPANSION_T", 0.20),
  expansionVol: envNum("REGIME_EXPANSION_V", 0.25),

  bullTrend: envNum("REGIME_BULL_T", 0.08),
  bearTrend: envNum("REGIME_BEAR_T", -0.08),

  lowVolThreshold: envNum("REGIME_LOWVOL_V", 0.18),
  highVolThreshold: envNum("REGIME_HIGHVOL_V", 0.35),

  // adaptive thresholds
  bullTrendHighVol: envNum("REGIME_BULL_HIGHVOL", 0.12),
  bearTrendHighVol: envNum("REGIME_BEAR_HIGHVOL", -0.12),
  bullTrendLowVol: envNum("REGIME_BULL_LOWVOL", 0.06),
  bearTrendLowVol: envNum("REGIME_BEAR_LOWVOL", -0.06),
};

function detectMarketRegime(trend, volatilityAnnual) {
  const cfg = DEFAULT_CONFIG;

  // Trend can be negative/positive, volatility must not be negative
  const t = clamp(trend, -Infinity, Infinity, 0);
  const v = clamp(volatilityAnnual, 0, Infinity, 0);

  // 1) Extreme regimes first
  if (t <= cfg.crashTrend && v >= cfg.crashVol) return "crash";
  if (t >= cfg.expansionTrend && v <= cfg.expansionVol) return "expansion";

  // 2) Volatility-aware bull/bear
  // If volatility is very high, require stronger trend signal to call bull/bear
  // If volatility is very low, accept slightly smaller trend signal
  let bullT = cfg.bullTrend;
  let bearT = cfg.bearTrend;

  if (v >= cfg.highVolThreshold) {
    bullT = Math.max(bullT, cfg.bullTrendHighVol);
    bearT = Math.min(bearT, cfg.bearTrendHighVol);
  } else if (v <= cfg.lowVolThreshold) {
    bullT = Math.min(bullT, cfg.bullTrendLowVol);
    bearT = Math.max(bearT, cfg.bearTrendLowVol);
  }

  if (t >= bullT) return "bull";
  if (t <= bearT) return "bear";

  return "neutral";
}

module.exports = { detectMarketRegime };
