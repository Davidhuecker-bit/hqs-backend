"use strict";

/*
  HQS Engine – Core Stock Scoring Engine (Market-Regime Version B)
*/

const { getFundamentals } = require("./services/fundamental.service");
const { saveScoreSnapshot } = require("./services/factorHistory.repository");
const { loadLastWeights } = require("./services/weightHistory.repository");

/* =========================================================
   DEFAULT WEIGHTS
========================================================= */

const DEFAULT_WEIGHTS = {
  momentum: 0.35,
  quality: 0.35,
  stability: 0.20,
  relative: 0.10,
};

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

function normalizeWeights(weights) {
  const sum = Object.values(weights || {}).reduce((a, b) => a + safe(b), 0);
  if (!sum) return DEFAULT_WEIGHTS;

  const normalized = {};
  Object.keys(DEFAULT_WEIGHTS).forEach((key) => {
    normalized[key] = safe(weights[key]) / sum;
  });

  return normalized;
}

/* =========================================================
   REGIME DETECTION – MARKET BASED
========================================================= */

function detectRegime(symbolChange, marketAverage) {
  const diff = safe(symbolChange) - safe(marketAverage);

  if (marketAverage > 1 && diff > 0.5) return "expansion";
  if (marketAverage > 0) return "bull";
  if (marketAverage < -1 && diff < -0.5) return "crash";
  if (marketAverage < 0) return "bear";
  return "neutral";
}

function regimeMultiplier(regime) {
  switch (regime) {
    case "expansion": return 1.10;
    case "bull": return 1.05;
    case "bear": return 0.95;
    case "crash": return 0.85;
    default: return 1;
  }
}

/* =========================================================
   FACTORS
========================================================= */

function calculateMomentum(changePercent) {
  return clamp(50 + safe(changePercent) * 3, 0, 100);
}

function calculateStability(item) {
  const high = safe(item.high);
  const low = safe(item.low);
  const open = safe(item.open);

  if (!open) return 50;

  const range = ((high - low) / open) * 100;

  return clamp(70 - range * 4, 20, 80);
}

function calculateQuality(fundamentals) {
  if (!fundamentals) return 50;

  let score = 50;

  if (safe(fundamentals.revenueGrowth) > 10) score += 10;
  if (safe(fundamentals.netMargin) > 15) score += 10;
  if (safe(fundamentals.returnOnEquity) > 15) score += 10;
  if (safe(fundamentals.debtToEquity) < 1) score += 5;
  if (safe(fundamentals.debtToEquity) > 2) score -= 10;

  return clamp(score, 0, 100);
}

function calculateRelativeStrength(symbolChange, marketAverage) {
  const diff = safe(symbolChange) - safe(marketAverage);
  return clamp(50 + diff * 5, 0, 100);
}

/* =========================================================
   MAIN ENGINE
========================================================= */

async function buildHQSResponse(item = {}, marketAverage = 0) {
  try {
    if (!item.symbol) {
      throw new Error("Missing symbol");
    }

    let weights = await loadLastWeights();
    if (!weights) weights = DEFAULT_WEIGHTS;
    weights = normalizeWeights(weights);

    let fundamentals = null;
    try {
      fundamentals = await getFundamentals(item.symbol);
    } catch (err) {
      console.warn("Fundamental load failed:", err.message);
    }

    const regime = detectRegime(item.changesPercentage, marketAverage);

    const momentum = calculateMomentum(item.changesPercentage);
    const stability = calculateStability(item);
    const quality = calculateQuality(fundamentals);
    const relative = calculateRelativeStrength(item.changesPercentage, marketAverage);

    let baseScore =
      momentum * weights.momentum +
      quality * weights.quality +
      stability * weights.stability +
      relative * weights.relative;

    baseScore *= regimeMultiplier(regime);

    const finalScore = clamp(Math.round(baseScore), 0, 100);

    await saveScoreSnapshot({
      symbol: item.symbol,
      hqsScore: finalScore,
      momentum,
      quality,
      stability,
      relative,
      regime,
    });

    return {
      symbol: item.symbol.toUpperCase(),
      price: safe(item.price),
      changePercent: safe(item.changesPercentage),
      regime,
      weights,
      breakdown: { momentum, quality, stability, relative },
      hqsScore: finalScore,
      rating:
        finalScore >= 85 ? "Strong Buy"
        : finalScore >= 70 ? "Buy"
        : finalScore >= 50 ? "Hold"
        : "Risk",
      decision:
        finalScore >= 70 ? "KAUFEN"
        : finalScore >= 50 ? "HALTEN"
        : "NICHT KAUFEN",
      timestamp: new Date().toISOString(),
    };

  } catch (error) {
    console.error("HQS Engine Error:", error.message);
    return {
      symbol: item?.symbol || null,
      hqsScore: null,
      error: "HQS calculation failed"
    };
  }
}

module.exports = { buildHQSResponse };
