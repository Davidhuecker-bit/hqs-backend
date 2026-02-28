// services/hqsEngine.js
// HQS Engine v3.0 – Institutional Core Architecture

const { calculateCurrentScore } = require("./services/current.service");
const { calculateStabilityScore } = require("./services/stability.service");
const { getFundamentals } = require("./services/fundamental.service");

/* =========================================================
   REGIME ENGINE
========================================================= */

function detectMarketRegime(changePercent = 0) {
  const change = Number(changePercent || 0);

  if (change > 1.5) return "strong_bull";
  if (change > 0.5) return "bull";
  if (change < -1.5) return "strong_bear";
  if (change < -0.5) return "bear";
  return "neutral";
}

function regimeModifier(regime) {
  switch (regime) {
    case "strong_bull":
      return 5;
    case "bull":
      return 2;
    case "strong_bear":
      return -5;
    case "bear":
      return -2;
    default:
      return 0;
  }
}

/* =========================================================
   STRENGTH LAYER (Marktverhalten)
========================================================= */

function calculateStrengthLayer(item) {
  const price = Number(item.price || 0);
  const open = Number(item.open || 0);
  const high = Number(item.high || 0);
  const low = Number(item.low || 0);
  const volume = Number(item.volume || 0);

  if (!open || !price) return 50;

  const momentum = ((price - open) / open) * 100;
  const volatility = ((high - low) / open) * 100;
  const volumeFactor = volume / 10000000;

  let score = 50;

  // Momentum
  score += momentum * 2;

  // Volumenbestätigung
  score += Math.min(volumeFactor * 5, 10);

  // Gesunde Volatilität
  if (volatility < 2) score += 5;
  if (volatility > 6) score -= 5;

  return clamp(score, 0, 100);
}

/* =========================================================
   QUALITY LAYER (Fundamental)
========================================================= */

function calculateQualityLayer(fundamentals) {
  if (!fundamentals) return 50;

  let score = 50;

  const revenueGrowth = Number(fundamentals.revenueGrowth || 0);
  const profitMargin = Number(fundamentals.netMargin || 0);
  const debtRatio = Number(fundamentals.debtToEquity || 0);
  const roe = Number(fundamentals.returnOnEquity || 0);

  if (revenueGrowth > 10) score += 10;
  if (profitMargin > 15) score += 10;
  if (roe > 15) score += 10;
  if (debtRatio < 1) score += 5;
  if (debtRatio > 2) score -= 10;

  return clamp(score, 0, 100);
}

/* =========================================================
   COMBINATION LOGIC
========================================================= */

function combineLayers(quality, strength, regime) {
  const baseScore =
    quality * 0.4 +
    strength * 0.4 +
    50 * 0.2; // neutral baseline for regime influence

  const finalScore = baseScore + regimeModifier(regime);

  return clamp(Math.round(finalScore), 0, 100);
}

/* =========================================================
   UTILITY
========================================================= */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/* =========================================================
   MAIN HQS RESPONSE BUILDER
========================================================= */

async function buildHQSResponse(item = {}) {
  if (!item || typeof item !== "object") {
    throw new Error("Invalid item passed to HQS Engine");
  }
  if (!item.symbol) {
    throw new Error("Missing symbol in HQS Engine");
  }

  const fundamentals = await getFundamentals(item.symbol);

  const strengthScore = calculateStrengthLayer(item);
  const qualityScore = calculateQualityLayer(fundamentals);

  const regime = detectMarketRegime(item.changesPercentage);

  const hqsScore = combineLayers(
    qualityScore,
    strengthScore,
    regime
  );

  return {
    symbol: String(item.symbol || "").toUpperCase(),
    price: Number(item.price || 0),
    changePercent: Number(Number(item.changesPercentage || 0).toFixed(2)),
    volume: Number(item.volume || 0),
    marketRegime: regime,

    breakdown: {
      qualityScore: Math.round(qualityScore),
      strengthScore: Math.round(strengthScore),
      regimeModifier: regimeModifier(regime)
    },

    hqsScore,

    rating:
      hqsScore >= 85
        ? "Strong Buy"
        : hqsScore >= 70
        ? "Buy"
        : hqsScore >= 50
        ? "Hold"
        : "Risk",

    decision:
      hqsScore >= 70
        ? "KAUFEN"
        : hqsScore >= 50
        ? "HALTEN"
        : "NICHT KAUFEN",
  };
}

module.exports = {
  buildHQSResponse,
};
