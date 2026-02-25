// hqsEngine.js
// HQS Engine – v2.0
// Current + Stability + Dynamische Marktphase

const { calculateCurrentScore, getCurrentInsight } = require("./services/current.service");
const { getFundamentals } = require("./services/fundamental.service");
const { calculateStabilityScore } = require("./services/stability.service");

/**
 * Marktphase-Erkennung (v1 – einfach über Tagesveränderung)
 * Später: S&P 500 / VIX / Makro-Daten
 */
function detectMarketPhase(changePercent) {
  const change = Number(changePercent || 0);

  if (change > 1) return "bull";
  if (change < -1) return "bear";
  return "neutral";
}

/**
 * Dynamische Gewichtung von Current + Stability
 */
function combineScores(currentScore, stabilityScore, marketPhase) {
  let weightG = 0.5;
  let weightS = 0.5;

  if (marketPhase === "bull") {
    weightG = 0.6;
    weightS = 0.4;
  }

  if (marketPhase === "bear") {
    weightG = 0.4;
    weightS = 0.6;
  }

  return Math.round(currentScore * weightG + stabilityScore * weightS);
}

async function buildHQSResponse(item = {}) {
  if (!item || typeof item !== "object") {
    throw new Error("Invalid item passed to HQS Engine (not an object)");
  }
  if (!item.symbol) {
    throw new Error("Invalid item passed to HQS Engine (missing symbol)");
  }

  // Defensive numeric normalization
  const safePrice = Number(item.price || 0);
  const safeVolume = Number(item.volume || 0);
  const safeAvgVolume = Number(item.avgVolume || 0);
  const safeMarketCap = Number(item.marketCap || 0);
  const rawChangePercent = Number(item.changesPercentage || 0);

  const currentScore = calculateCurrentScore(item);

  // Fundamentals laden
  const fundamentals = await getFundamentals(item.symbol);

  // Stability berechnen
  const stabilityScore = fundamentals ? calculateStabilityScore(fundamentals) : 50;

  // Marktphase bestimmen (vereinfacht über Tagesperformance)
  const marketPhase = detectMarketPhase(rawChangePercent);

  // Gesamt-HQS
  const hqsScore = combineScores(currentScore, stabilityScore, marketPhase);

  return {
    symbol: String(item.symbol || "").toUpperCase(),
    name: item.name,

    price: safePrice,

    // IMPORTANT: keep as NUMBER (not string)
    changePercent: Number(rawChangePercent.toFixed(2)),

    volume: safeVolume,
    avgVolume: safeAvgVolume,
    marketCap: safeMarketCap,

    marketPhase,

    currentScore,
    stabilityScore,

    hqsScore,

    rating:
      hqsScore >= 85
        ? "Strong Buy"
        : hqsScore >= 70
          ? "Buy"
          : hqsScore >= 50
            ? "Hold"
            : "Risk",

    decision: hqsScore >= 70 ? "KAUFEN" : hqsScore >= 50 ? "HALTEN" : "NICHT KAUFEN",

    aiInsight: getCurrentInsight(currentScore),
  };
}

module.exports = {
  buildHQSResponse,
};
