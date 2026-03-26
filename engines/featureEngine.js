"use strict";

/*
  Feature Engine
  Generates advanced market features from raw data

  Final compatible version:
  - same main export
  - same core output fields
  - improved liquidity/trend logic
  - better configurability
  - optional richer context fields
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function envNum(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/* ===============================
   CONFIG
================================ */

const FEATURE_CONFIG = {
  TREND_STRENGTH_MIN: envNum("FEATURE_TREND_STRENGTH_MIN", -5),
  TREND_STRENGTH_MAX: envNum("FEATURE_TREND_STRENGTH_MAX", 5),

  VOLUME_ACCEL_MIN: envNum("FEATURE_VOLUME_ACCEL_MIN", -2),
  VOLUME_ACCEL_MAX: envNum("FEATURE_VOLUME_ACCEL_MAX", 5),

  RELATIVE_VOLUME_MAX: envNum("FEATURE_RELATIVE_VOLUME_MAX", 10),

  VOLATILITY_REGIME: {
    EXTREME: envNum("FEATURE_VOLA_EXTREME", 0.8),
    HIGH: envNum("FEATURE_VOLA_HIGH", 0.5),
    NORMAL: envNum("FEATURE_VOLA_NORMAL", 0.25),
  },

  LIQUIDITY_MODE: String(process.env.FEATURE_LIQUIDITY_MODE || "tiered")
    .toLowerCase()
    .trim(), // "tiered" | "log"

  LIQUIDITY_LEVELS: [
    { minDollarVolume: 500_000_000, score: 90 },
    { minDollarVolume: 100_000_000, score: 80 },
    { minDollarVolume: 50_000_000, score: 70 },
    { minDollarVolume: 10_000_000, score: 60 },
    { minDollarVolume: 0, score: 40 },
  ],

  TREND_EFFICIENCY_VOL_FLOOR: envNum("FEATURE_TREND_VOL_FLOOR", 0.05),
  VOLUME_SPIKE_THRESHOLD: envNum("FEATURE_VOLUME_SPIKE_THRESHOLD", 2.0),

  VOLA_STATE_EXPANDING_MULT: envNum("FEATURE_VOLA_EXPANDING_MULT", 1.5),
  VOLA_STATE_COMPRESSING_MULT: envNum("FEATURE_VOLA_COMPRESSING_MULT", 0.7),
};

/* ===============================
   TREND STRENGTH / EFFICIENCY
================================ */

function calculateTrendStrength(trend, volatility) {
  const t = safe(trend);
  const v = Math.max(safe(volatility), FEATURE_CONFIG.TREND_EFFICIENCY_VOL_FLOOR);

  return Number(
    clamp(
      t / v,
      FEATURE_CONFIG.TREND_STRENGTH_MIN,
      FEATURE_CONFIG.TREND_STRENGTH_MAX
    ).toFixed(3)
  );
}

/* ===============================
   VOLUME ACCELERATION
================================ */

function calculateVolumeAcceleration(currentVolume, avgVolume) {
  const cur = safe(currentVolume);
  const avg = safe(avgVolume);

  if (!avg) return 0;

  const ratio = cur / avg;

  return clamp(
    ratio - 1,
    FEATURE_CONFIG.VOLUME_ACCEL_MIN,
    FEATURE_CONFIG.VOLUME_ACCEL_MAX
  );
}

/* ===============================
   LIQUIDITY SCORE
================================ */

function calculateLiquidityScore(volume, price) {
  const v = safe(volume);
  const p = safe(price);
  const dollarVolume = v * p;

  if (dollarVolume <= 0) return 0;

  if (FEATURE_CONFIG.LIQUIDITY_MODE === "log") {
    // smoother log-based version
    const score = 10 * Math.log10(dollarVolume / 1000);
    return clamp(Math.round(score), 20, 100);
  }

  // backward-friendly tiered default
  const level = FEATURE_CONFIG.LIQUIDITY_LEVELS.find(
    (l) => dollarVolume >= l.minDollarVolume
  );

  return level ? level.score : 40;
}

/* ===============================
   VOLATILITY REGIME
================================ */

function calculateVolatilityRegime(volatilityAnnual) {
  const v = safe(volatilityAnnual);

  if (v > FEATURE_CONFIG.VOLATILITY_REGIME.EXTREME) return "extreme";
  if (v > FEATURE_CONFIG.VOLATILITY_REGIME.HIGH) return "high";
  if (v > FEATURE_CONFIG.VOLATILITY_REGIME.NORMAL) return "normal";

  return "low";
}

/* ===============================
   VOLATILITY STATE
================================ */

function detectVolatilityState(volaCurrent, volaAvg) {
  const v = safe(volaCurrent);
  const avg = safe(volaAvg, v);

  if (v > avg * FEATURE_CONFIG.VOLA_STATE_EXPANDING_MULT) return "expanding";
  if (v < avg * FEATURE_CONFIG.VOLA_STATE_COMPRESSING_MULT) return "compressing";
  return "stable";
}

/* ===============================
   RELATIVE VOLUME
================================ */

function calculateRelativeVolume(volume, avgVolume) {
  const v = safe(volume);
  const avg = safe(avgVolume);

  if (!avg) return 1;

  return Number(
    clamp(v / avg, 0, FEATURE_CONFIG.RELATIVE_VOLUME_MAX).toFixed(2)
  );
}

/* ===============================
   MAIN FEATURE BUILDER
================================ */

function buildFeatures(data = {}, advanced = {}) {
  if (!data || typeof data !== "object") data = {};
  if (!advanced || typeof advanced !== "object") advanced = {};

  const price = safe(data.price);
  const volume = safe(data.volume);

  const avgVolume = safe(advanced.avgVolume, volume);
  const volatility = safe(advanced.volatilityAnnual);
  const avgVolatility = safe(advanced.avgVolatilityAnnual, volatility);
  const trend = safe(advanced.trend);

  const trendStrength = calculateTrendStrength(trend, volatility);
  const relativeVolume = calculateRelativeVolume(volume, avgVolume);

  return {
    trendStrength,
    volumeAcceleration: calculateVolumeAcceleration(volume, avgVolume),
    liquidityScore: calculateLiquidityScore(volume, price),
    volatilityRegime: calculateVolatilityRegime(volatility),
    relativeVolume,

    // optional richer context, backward-safe in normal JS consumers
    volatilityState: detectVolatilityState(volatility, avgVolatility),
    isVolumeSpiking: relativeVolume > FEATURE_CONFIG.VOLUME_SPIKE_THRESHOLD && trend > 0,
    efficiency: Math.abs(trendStrength),
  };
}

module.exports = {
  buildFeatures,
};
