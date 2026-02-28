"use strict";

const { getFundamentals } = require("./fundamental.service");
const { saveScoreSnapshot } = require("./factorHistory.repository");
const { loadLastWeights } = require("./weightHistory.repository");
const { getDefaultWeights } = require("./autoFactor.service");

/* =========================================================
   UTIL
========================================================= */

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function safe(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* =========================================================
   REGIME DETECTION
========================================================= */

function detectRegime(changePercent) {
  const c = safe(changePercent);

  if (c > 2) return "expansion";
  if (c > 0.5) return "bull";
  if (c < -2) return "crash";
  if (c < -0.5) return "bear";
  return "neutral";
}

function regimeMultiplier(regime) {
  switch (regime) {
    case "expansion": return 1.15;
    case "bull": return 1.05;
    case "bear": return 0.95;
    case "crash": return 0.85;
    default: return 1;
  }
}

/* =========================================================
   FACTOR: MOMENTUM
========================================================= */

function calculateMomentum(item) {
  const change = safe(item.changesPercentage);
  return clamp(50 + change * 3, 0, 100);
}

/* =========================================================
   FACTOR: VOLATILITY
========================================================= */

function calculateStability(item) {
  const high = safe(item.high);
  const low = safe(item.low);
  const open = safe(item.open);

  if (!open) return 50;

  const range = ((high - low) / open) * 100;

  if (range < 2) return 60;
  if (range > 6) return 40;
  return 50;
}

/* =========================================================
   FACTOR: QUALITY (Fundamental)
========================================================= */

function calculateQuality(f) {
  if (!f) return 50;

  let score = 50;

  if (safe(f.revenueGrowth) > 10) score += 10;
  if (safe(f.netMargin) > 15) score += 10;
  if (safe(f.returnOnEquity) > 15) score += 10;
  if (safe(f.debtToEquity) < 1) score += 5;
  if (safe(f.debtToEquity) > 2) score -= 10;

  return clamp(score, 0, 100);
}

/* =========================================================
   FACTOR: RELATIVE STRENGTH
========================================================= */

function calculateRelativeStrength(changePercent, marketProxy = 0.8) {
  const relative = safe(changePercent) - marketProxy;

  if (relative > 2) return 65;
  if (relative > 1) return 60;
  if (relative > 0) return 55;
  if (relative < -2) return 35;
  if (relative < -1) return 40;
  return 50;
}

/* =========================================================
   MAIN ADAPTIVE ENGINE
========================================================= */

async function buildHQSResponse(item = {}) {
  if (!item || typeof item !== "object") {
    throw new Error("Invalid item passed to HQS Engine");
  }

  if (!item.symbol) {
    throw new Error("Missing symbol in HQS Engine");
  }

  // 🔥 Dynamische Gewichte laden
  let weights = await loadLastWeights();
  if (!weights) weights = getDefaultWeights();

  const fundamentals = await getFundamentals(item.symbol);

  const regime = detectRegime(item.changesPercentage);

  const momentum = calculateMomentum(item);
  const stability = calculateStability(item);
  const quality = calculateQuality(fundamentals);
  const relative = calculateRelativeStrength(item.changesPercentage);

  // Adaptive Gewichtung
  let baseScore =
    momentum * weights.momentum +
    quality * weights.quality +
    stability * weights.stability +
    relative * weights.relative;

  // Marktphase berücksichtigen
  baseScore *= regimeMultiplier(regime);

  const finalScore = clamp(Math.round(baseScore), 0, 100);

  /* ===============================================
     SAVE FACTOR SNAPSHOT (für Learning Loop)
  =============================================== */

  await saveScoreSnapshot({
    symbol: item.symbol,
    hqsScore: finalScore,
    momentum,
    quality,
    stability,
    relative,
    regime
  });

  return {
    symbol: item.symbol.toUpperCase(),
    price: safe(item.price),
    changePercent: safe(item.changesPercentage),
    regime,

    weights,

    breakdown: {
      momentum,
      quality,
      stability,
      relative
    },

    hqsScore: finalScore,

    rating:
      finalScore >= 85 ? "Strong Buy"
      : finalScore >= 70 ? "Buy"
      : finalScore >= 50 ? "Hold"
      : "Risk",

    decision:
      finalScore >= 70 ? "KAUFEN"
      : finalScore >= 50 ? "HALTEN"
      : "NICHT KAUFEN"
  };
}

module.exports = {
  buildHQSResponse
};
