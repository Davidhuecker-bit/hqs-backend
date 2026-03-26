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
 * Final compatible version:
 * - safer env parsing
 * - defensive sanitization
 * - volatility cannot become negative
 * - adaptive volatility-aware bull/bear thresholds
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

// Default thresholds (good for stocks, but env-tunable)
const DEFAULT_CONFIG = {
  crashTrend: envNum("REGIME_CRASH_T", -0.20),
  crashVol: envNum("REGIME_CRASH_V", 0.35),

  expansionTrend: envNum("REGIME_EXPANSION_T", 0.20),
  expansionVol: envNum("REGIME_EXPANSION_V", 0.25),

  bullTrend: envNum("REGIME_BULL_T", 0.08),
  bearTrend: envNum("REGIME_BEAR_T", -0.08),

  lowVolThreshold: envNum("REGIME_LOWVOL_V", 0.18),
  highVolThreshold: envNum("REGIME_HIGHVOL_V", 0.35),

  // Adaptive thresholds
  bullTrendHighVol: envNum("REGIME_BULL_HIGHVOL", 0.12),
  bearTrendHighVol: envNum("REGIME_BEAR_HIGHVOL", -0.12),
  bullTrendLowVol: envNum("REGIME_BULL_LOWVOL", 0.05),
  bearTrendLowVol: envNum("REGIME_BEAR_LOWVOL", -0.05),
};

function detectMarketRegime(trend, volatilityAnnual) {
  const cfg = DEFAULT_CONFIG;

  // Trend can be negative/positive, volatility must not be negative
  const t = clamp(trend, -Infinity, Infinity, 0);
  const v = clamp(volatilityAnnual, 0, Infinity, 0);

  // 1) Extreme regimes first (system protection)
  if (t <= cfg.crashTrend && v >= cfg.crashVol) return "crash";
  if (t >= cfg.expansionTrend && v <= cfg.expansionVol) return "expansion";

  // 2) Volatility-aware bull/bear thresholds
  let bullThreshold = cfg.bullTrend;
  let bearThreshold = cfg.bearTrend;

  // In noisy high-vol regimes, require stronger confirmation
  if (v >= cfg.highVolThreshold) {
    bullThreshold = Math.max(bullThreshold, cfg.bullTrendHighVol);
    bearThreshold = Math.min(bearThreshold, cfg.bearTrendHighVol);
  }
  // In calm low-vol regimes, smaller moves can already be meaningful
  else if (v <= cfg.lowVolThreshold) {
    bullThreshold = Math.min(bullThreshold, cfg.bullTrendLowVol);
    bearThreshold = Math.max(bearThreshold, cfg.bearTrendLowVol);
  }

  // 3) Final classification
  if (t >= bullThreshold) return "bull";
  if (t <= bearThreshold) return "bear";

  return "neutral";
}

module.exports = { detectMarketRegime };
