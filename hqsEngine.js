// services/hqsEngine.js
// HQS 5.0 – Quant Factor Engine

const { getFundamentals } = require("./services/fundamental.service");

/* =========================================================
   UTIL
========================================================= */

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function safe(v, f = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
}

/* =========================================================
   MARKET REGIME
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
   MOMENTUM ENGINE (Multi-Timeframe Simulation)
========================================================= */

function calculateMomentum(item) {
  const intraday = safe(item.changesPercentage);
  const weekly = safe(item.weekChange || intraday * 2);
  const monthly = safe(item.monthChange || intraday * 4);

  let score = 50;

  score += intraday * 2;
  score += weekly * 1.5;
  score += monthly * 1;

  return clamp(score, 0, 100);
}

/* =========================================================
   VOLATILITY ADJUSTMENT
========================================================= */

function calculateVolatilityAdjustment(item) {
  const high = safe(item.high);
  const low = safe(item.low);
  const open = safe(item.open);

  if (!open) return 0;

  const range = ((high - low) / open) * 100;

  if (range < 2) return 5;
  if (range > 6) return -5;
  return 0;
}

/* =========================================================
   QUALITY FACTOR
========================================================= */

function calculateQuality(fundamentals) {
  if (!fundamentals) return 50;

  const growth = safe(fundamentals.revenueGrowth);
  const margin = safe(fundamentals.netMargin);
  const roe = safe(fundamentals.returnOnEquity);
  const debt = safe(fundamentals.debtToEquity);

  let score = 50;

  score += growth > 15 ? 15 : growth > 5 ? 8 : 0;
  score += margin > 20 ? 10 : margin > 10 ? 5 : 0;
  score += roe > 20 ? 10 : roe > 10 ? 5 : 0;
  score += debt < 1 ? 5 : debt > 2 ? -10 : 0;

  return clamp(score, 0, 100);
}

/* =========================================================
   RELATIVE STRENGTH (vs SPY Proxy)
========================================================= */

function calculateRelativeStrength(stockChange, marketProxy = 0.8) {
  const relative = safe(stockChange) - marketProxy;

  if (relative > 2) return 15;
  if (relative > 1) return 8;
  if (relative > 0) return 4;
  if (relative < -2) return -10;
  if (relative < -1) return -5;

  return 0;
}

/* =========================================================
   BETA SIMULATION
========================================================= */

function calculateBetaSimulation(item) {
  const volatility = Math.abs(safe(item.changesPercentage));

  if (volatility > 4) return -5;   // zu aggressiv
  if (volatility < 0.5) return 3;  // defensiv stabil
  return 0;
}

/* =========================================================
   AUTO FACTOR WEIGHTING (Basisversion)
========================================================= */

function adaptiveWeights(regime) {
  switch (regime) {
    case "expansion":
      return { momentum: 0.4, quality: 0.3, stability: 0.2, relative: 0.1 };
    case "bear":
      return { momentum: 0.2, quality: 0.4, stability: 0.3, relative: 0.1 };
    default:
      return { momentum: 0.3, quality: 0.35, stability: 0.25, relative: 0.1 };
  }
}

/* =========================================================
   MAIN ENGINE
========================================================= */

async function buildHQSResponse(item = {}) {
  if (!item.symbol) throw new Error("Missing symbol");

  const fundamentals = await getFundamentals(item.symbol);

  const regime = detectRegime(item.changesPercentage);

  const momentumScore = calculateMomentum(item);
  const qualityScore = calculateQuality(fundamentals);
  const stabilityAdjustment = calculateVolatilityAdjustment(item);
  const relativeScore = calculateRelativeStrength(item.changesPercentage);
  const betaAdjustment = calculateBetaSimulation(item);

  const weights = adaptiveWeights(regime);

  let baseScore =
    momentumScore * weights.momentum +
    qualityScore * weights.quality +
    (50 + stabilityAdjustment + betaAdjustment) * weights.stability +
    (50 + relativeScore) * weights.relative;

  baseScore = baseScore * regimeMultiplier(regime);

  const finalScore = clamp(Math.round(baseScore), 0, 100);

  return {
    symbol: item.symbol.toUpperCase(),
    price: safe(item.price),
    regime,

    breakdown: {
      momentumScore,
      qualityScore,
      stabilityAdjustment,
      relativeScore,
      betaAdjustment,
      weights
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

module.exports = { buildHQSResponse };
