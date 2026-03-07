"use strict";

/*
  Discovery Engine
  Detects special market opportunities
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

/* ===============================
   MOMENTUM EXPLOSION
================================ */

function detectMomentumExplosion(features, trend) {

  const strength = safe(features.trendStrength);
  const volumeAccel = safe(features.volumeAcceleration);

  if (strength > 1.2 && volumeAccel > 0.5 && trend > 0.15) {
    return {
      type: "momentum_explosion",
      label: "🔥 Momentum Explosion"
    };
  }

  return null;
}

/* ===============================
   TREND ACCELERATION
================================ */

function detectTrendAcceleration(trend, acceleration) {

  const t = safe(trend);
  const a = safe(acceleration);

  if (t > 0.2 && a > 0.05) {
    return {
      type: "trend_acceleration",
      label: "🚀 Trend Acceleration"
    };
  }

  return null;
}

/* ===============================
   VOLATILITY COMPRESSION
================================ */

function detectVolatilityCompression(volatility) {

  const v = safe(volatility);

  if (v < 0.18) {
    return {
      type: "volatility_compression",
      label: "📉 Volatility Compression"
    };
  }

  return null;
}

/* ===============================
   MAIN DISCOVERY FUNCTION
================================ */

function discoverOpportunities(symbol, marketData, features, advanced) {

  const discoveries = [];

  const trend = safe(advanced.trend);
  const acceleration = safe(advanced.acceleration);
  const volatility = safe(advanced.volatilityAnnual);

  const momentumSignal = detectMomentumExplosion(features, trend);
  if (momentumSignal) discoveries.push(momentumSignal);

  const trendSignal = detectTrendAcceleration(trend, acceleration);
  if (trendSignal) discoveries.push(trendSignal);

  const compressionSignal = detectVolatilityCompression(volatility);
  if (compressionSignal) discoveries.push(compressionSignal);

  return discoveries.map(d => ({
    symbol,
    ...d
  }));
}

module.exports = {
  discoverOpportunities
};
