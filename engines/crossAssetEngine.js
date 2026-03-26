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
  - same core output
  - smarter thresholds
  - relative volume support
  - relative volatility compression support
  - optional confidence fields (backward-safe)
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
  confluence: {
    bonusConfidence: envNum("DISCOVERY_CONFLUENCE_BONUS_CONF", 0.08),
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
    const confidence = clamp(
      (
        clamp(strength / 3, 0, 1) * 0.45 +
        clamp(volumeAccel / 2, 0, 1) * 0.25 +
        clamp(relVol / 3, 0, 1) * 0.20 +
        clamp(t / 0.3, 0, 1) * 0.10
      ),
      0,
      1
    );

    return {
      type: "momentum_explosion",
      label: "🔥 Momentum Explosion",
      confidence: Number(confidence.toFixed(2)),
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
    const confidence = clamp(
      clamp(t / 0.35, 0, 1) * 0.55 +
      clamp(a / 0.12, 0, 1) * 0.45,
      0,
      1
    );

    return {
      type: "trend_acceleration",
      label: "🚀 Trend Acceleration",
      confidence: Number(confidence.toFixed(2)),
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
    let confidence = 0.6;

    if (avgV > 0) {
      const ratio = v / avgV;
      confidence = clamp(1 - ratio, 0.4, 1);
    } else {
      confidence = clamp(
        1 - v / Math.max(CONFIG.volatilityCompression.fallbackVolMax, 0.0001),
        0.4,
        1
      );
    }

    return {
      type: "volatility_compression",
      label: "📉 Volatility Compression",
      confidence: Number(confidence.toFixed(2)),
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

  // leichte Konfluenz-Intelligenz:
  // wenn Momentum + Compression gleichzeitig da sind, Confidence moderat anheben
  const hasMomentum = discoveries.some((d) => d.type === "momentum_explosion");
  const hasCompression = discoveries.some((d) => d.type === "volatility_compression");

  if (hasMomentum && hasCompression) {
    for (const d of discoveries) {
      if (
        d.type === "momentum_explosion" ||
        d.type === "volatility_compression"
      ) {
        d.confidence = Number(
          clamp(
            safe(d.confidence) + CONFIG.confluence.bonusConfidence,
            0,
            1
          ).toFixed(2)
        );
      }
    }
  }

  return discoveries.map((d) => ({
    symbol,
    ...d,
  }));
}

module.exports = {
  discoverOpportunities,
};
