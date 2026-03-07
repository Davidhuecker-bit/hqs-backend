"use strict";

/*
  Feature Engine
  Generates advanced market features from raw data
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/* ===============================
   TREND STRENGTH
================================ */

function calculateTrendStrength(trend, volatility) {
  const t = safe(trend);
  const v = safe(volatility);

  if (!v) return t;

  return clamp(t / v, -5, 5);
}

/* ===============================
   VOLUME ACCELERATION
================================ */

function calculateVolumeAcceleration(currentVolume, avgVolume) {
  const cur = safe(currentVolume);
  const avg = safe(avgVolume);

  if (!avg) return 0;

  const ratio = cur / avg;

  return clamp(ratio - 1, -2, 5);
}

/* ===============================
   LIQUIDITY SCORE
================================ */

function calculateLiquidityScore(volume, price) {
  const v = safe(volume);
  const p = safe(price);

  const dollarVolume = v * p;

  if (dollarVolume > 500000000) return 90;
  if (dollarVolume > 100000000) return 80;
  if (dollarVolume > 50000000) return 70;
  if (dollarVolume > 10000000) return 60;

  return 40;
}

/* ===============================
   VOLATILITY REGIME
================================ */

function calculateVolatilityRegime(volatilityAnnual) {
  const v = safe(volatilityAnnual);

  if (v > 0.8) return "extreme";
  if (v > 0.5) return "high";
  if (v > 0.25) return "normal";

  return "low";
}

/* ===============================
   RELATIVE VOLUME
================================ */

function calculateRelativeVolume(volume, avgVolume) {
  const v = safe(volume);
  const avg = safe(avgVolume);

  if (!avg) return 1;

  return clamp(v / avg, 0, 10);
}

/* ===============================
   MAIN FEATURE BUILDER
================================ */

function buildFeatures(data = {}, advanced = {}) {

  const price = safe(data.price);
  const volume = safe(data.volume);

  const avgVolume = safe(advanced.avgVolume);
  const volatility = safe(advanced.volatilityAnnual);
  const trend = safe(advanced.trend);

  return {

    trendStrength: calculateTrendStrength(trend, volatility),

    volumeAcceleration: calculateVolumeAcceleration(volume, avgVolume),

    liquidityScore: calculateLiquidityScore(volume, price),

    volatilityRegime: calculateVolatilityRegime(volatility),

    relativeVolume: calculateRelativeVolume(volume, avgVolume)

  };
}

module.exports = {
  buildFeatures
};
