"use strict";

/*
  Discovery Engine – Pattern Detection (Pipeline: Stage 1 of 4)

  Detects special market opportunity conditions directly from raw
  technical features and advanced metrics. Produces a typed discovery
  array that is consumed by researchEngine (evaluation) and marketBrain
  (score boost) in the next pipeline stages.

  Verantwortung: Erkennung von momentum_explosion, trend_acceleration und
  volatility_compression. Keine Bewertung, kein Scoring – reine Mustererkennung.

  Ablauf: discoveryEngine → researchEngine → marketBrain → strategyEngine → integrationEngine

  Final compatible version:
  - same export
  - same input signature
  - same output shape
  - smarter thresholds
  - relative-volume support
  - relative volatility compression support
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
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

const CONFIG = {
  momentum: {
    trendStrengthMin: envNum("DISCOVERY_MOM_TREND_STRENGTH", 1.2),
    volumeAccelerationMin: envNum("DISCOVERY_MOM_VOLUME_ACCEL", 0.4),
    relativeVolumeMin: envNum("DISCOVERY_MOM_RELATIVE_VOLUME", 1.8),
    trendMin: envNum("DISCOVERY_MOM_TREND", 0.12),
  },
  trendAcceleration: {
    trendMin: envNum("DISCOVERY_ACCEL_TREND", 0.15),
    accelerationMin: envNum("DISCOVERY_ACCEL_VALUE", 0.04),
  },
  volatilityCompression: {
    absoluteVolMax: envNum("DISCOVERY_COMPRESSION_ABS_VOL", 0.15),
    relativeVolFactor: envNum("DISCOVERY_COMPRESSION_REL_FACTOR", 0.65),
    fallbackVolMax: envNum("DISCOVERY_COMPRESSION_FALLBACK_VOL", 0.18),
  },
};

/* ===============================
   MOMENTUM EXPLOSION
================================ */

function detectMomentumExplosion(features, trend, relativeVolume) {
  const strength = safe(features?.trendStrength);
  const volumeAccel = safe(features?.volumeAcceleration);
  const relVol = safe(relativeVolume);
  const t = safe(trend);

  if (
    strength > CONFIG.momentum.trendStrengthMin &&
    t > CONFIG.momentum.trendMin &&
    (
      volumeAccel > CONFIG.momentum.volumeAccelerationMin ||
      relVol > CONFIG.momentum.relativeVolumeMin
    )
  ) {
    return {
      type: "momentum_explosion",
      label: "🔥 Momentum Explosion",
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

  if (
    t > CONFIG.trendAcceleration.trendMin &&
    a > CONFIG.trendAcceleration.accelerationMin
  ) {
    return {
      type: "trend_acceleration",
      label: "🚀 Trend Acceleration",
    };
  }

  return null;
}

/* ===============================
   VOLATILITY COMPRESSION
================================ */

function detectVolatilityCompression(volatility, avgVolatility) {
  const v = safe(volatility);
  const avgV = safe(avgVolatility, 0);

  const absoluteCompression = v < CONFIG.volatilityCompression.absoluteVolMax;
  const relativeCompression =
    avgV > 0 && v < avgV * CONFIG.volatilityCompression.relativeVolFactor;

  const fallbackCompression =
    avgV <= 0 && v < CONFIG.volatilityCompression.fallbackVolMax;

  if (absoluteCompression || relativeCompression || fallbackCompression) {
    return {
      type: "volatility_compression",
      label: "📉 Volatility Compression",
    };
  }

  return null;
}

/* ===============================
   MAIN DISCOVERY FUNCTION
================================ */

function discoverOpportunities(symbol, marketData, features, advanced) {
  const discoveries = [];

  const trend = safe(advanced?.trend);
  const acceleration = safe(advanced?.acceleration);
  const volatility = safe(advanced?.volatilityAnnual);
  const avgVolatility = safe(advanced?.avgVolatilityAnnual);
  const relativeVolume = safe(features?.relativeVolume);

  const momentumSignal = detectMomentumExplosion(
    features,
    trend,
    relativeVolume
  );
  if (momentumSignal) discoveries.push(momentumSignal);

  const trendSignal = detectTrendAcceleration(
    trend,
    acceleration
  );
  if (trendSignal) discoveries.push(trendSignal);

  const compressionSignal = detectVolatilityCompression(
    volatility,
    avgVolatility
  );
  if (compressionSignal) discoveries.push(compressionSignal);

  return discoveries.map((d) => ({
    symbol,
    ...d,
  }));
}

module.exports = {
  discoverOpportunities,
};
