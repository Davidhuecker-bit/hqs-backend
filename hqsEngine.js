// services/hqsEngine.js
// HQS 4.0 – Institutional Multi-Layer Engine

const { getFundamentals } = require("./services/fundamental.service");

/* =========================================================
   UTIL
========================================================= */

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* =========================================================
   REGIME ENGINE
========================================================= */

function detectRegime(changePercent) {
  const change = safeNumber(changePercent);

  if (change > 1.5) return "strong_bull";
  if (change > 0.5) return "bull";
  if (change < -1.5) return "strong_bear";
  if (change < -0.5) return "bear";
  return "neutral";
}

function regimeWeight(regime) {
  switch (regime) {
    case "strong_bull": return 1.1;
    case "bull": return 1.05;
    case "strong_bear": return 0.9;
    case "bear": return 0.95;
    default: return 1;
  }
}

/* =========================================================
   STRENGTH LAYER
========================================================= */

function calculateStrengthLayer(item) {
  const price = safeNumber(item.price);
  const open = safeNumber(item.open);
  const high = safeNumber(item.high);
  const low = safeNumber(item.low);
  const volume = safeNumber(item.volume);

  if (!price || !open) return 50;

  const momentum = ((price - open) / open) * 100;
  const intradayRange = ((high - low) / open) * 100;
  const volumeFactor = volume / 10000000;

  let score = 50;

  // Momentum
  score += momentum * 2;

  // Volumenintelligenz
  score += clamp(volumeFactor * 5, 0, 15);

  // Gesunde Struktur
  if (intradayRange < 2) score += 5;
  if (intradayRange > 6) score -= 5;

  return clamp(score, 0, 100);
}

/* =========================================================
   QUALITY LAYER
========================================================= */

function calculateQualityLayer(fundamentals) {
  if (!fundamentals) return 50;

  const revenueGrowth = safeNumber(fundamentals.revenueGrowth);
  const margin = safeNumber(fundamentals.netMargin);
  const roe = safeNumber(fundamentals.returnOnEquity);
  const debt = safeNumber(fundamentals.debtToEquity);

  let score = 50;

  if (revenueGrowth > 15) score += 15;
  else if (revenueGrowth > 5) score += 8;

  if (margin > 20) score += 10;
  else if (margin > 10) score += 5;

  if (roe > 20) score += 10;
  else if (roe > 10) score += 5;

  if (debt < 1) score += 5;
  if (debt > 2) score -= 10;

  return clamp(score, 0, 100);
}

/* =========================================================
   RISK LAYER
========================================================= */

function calculateRiskLayer(item) {
  const open = safeNumber(item.open);
  const low = safeNumber(item.low);
  const price = safeNumber(item.price);

  if (!open) return 50;

  const downside = ((open - low) / open) * 100;
  const overextension = ((price - open) / open) * 100;

  let score = 50;

  if (downside < 1) score += 10;
  else if (downside > 5) score -= 10;

  if (overextension > 5) score -= 5;

  return clamp(score, 0, 100);
}

/* =========================================================
   RELATIVE STRENGTH (vs Market Proxy)
   (Currently simplified – can later integrate index data)
========================================================= */

function calculateRelativeStrength(changePercent) {
  const change = safeNumber(changePercent);

  if (change > 3) return 15;
  if (change > 1) return 8;
  if (change > 0) return 4;
  if (change < -3) return -10;
  if (change < -1) return -5;

  return 0;
}

/* =========================================================
   COMBINATION ENGINE
========================================================= */

function combineAllLayers({
  quality,
  strength,
  risk,
  relative,
  regime
}) {
  const base =
    quality * 0.35 +
    strength * 0.35 +
    risk * 0.2 +
    (50 + relative) * 0.1;

  const weighted = base * regimeWeight(regime);

  return clamp(Math.round(weighted), 0, 100);
}

/* =========================================================
   MAIN HQS BUILDER
========================================================= */

async function buildHQSResponse(item = {}) {
  if (!item || typeof item !== "object") {
    throw new Error("Invalid item passed to HQS Engine");
  }
  if (!item.symbol) {
    throw new Error("Missing symbol");
  }

  const fundamentals = await getFundamentals(item.symbol);

  const qualityScore = calculateQualityLayer(fundamentals);
  const strengthScore = calculateStrengthLayer(item);
  const riskScore = calculateRiskLayer(item);
  const relativeScore = calculateRelativeStrength(item.changesPercentage);
  const regime = detectRegime(item.changesPercentage);

  const hqsScore = combineAllLayers({
    quality: qualityScore,
    strength: strengthScore,
    risk: riskScore,
    relative: relativeScore,
    regime
  });

  return {
    symbol: String(item.symbol).toUpperCase(),
    price: safeNumber(item.price),
    changePercent: safeNumber(item.changesPercentage),
    volume: safeNumber(item.volume),
    regime,

    breakdown: {
      qualityScore,
      strengthScore,
      riskScore,
      relativeModifier: relativeScore
    },

    hqsScore,

    rating:
      hqsScore >= 85 ? "Strong Buy"
      : hqsScore >= 70 ? "Buy"
      : hqsScore >= 50 ? "Hold"
      : "Risk",

    decision:
      hqsScore >= 70 ? "KAUFEN"
      : hqsScore >= 50 ? "HALTEN"
      : "NICHT KAUFEN"
  };
}

module.exports = {
  buildHQSResponse
};
