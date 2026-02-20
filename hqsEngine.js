// hqsEngine.js
// HQS Engine – v1.0 (aktuell nur Current aktiv)
// Vorbereitung für Stability + Future + Regime + Constraints

const { calculateCurrentScore, getCurrentInsight } = require("./services/current.service");

function buildHQSResponse(item) {
  const currentScore = calculateCurrentScore(item);

  // Vorbereitung für spätere Module
  const stabilityScore = null;
  const futureScore = null;

  // Gesamt-HQS (vorläufig nur Current)
  const hqsScore = currentScore;

  return {
    symbol: item.symbol,
    name: item.name,
    price: item.price,
    changePercent: Number(item.changesPercentage || 0).toFixed(2),
    volume: item.volume,
    avgVolume: item.avgVolume,
    marketCap: item.marketCap,

    currentScore,
    stabilityScore,
    futureScore,

    hqsScore,

    rating:
      hqsScore >= 85 ? "Strong Buy" :
      hqsScore >= 70 ? "Buy" :
      hqsScore >= 50 ? "Hold" :
      "Risk",

    decision:
      hqsScore >= 70 ? "KAUFEN" :
      hqsScore >= 50 ? "HALTEN" :
      "NICHT KAUFEN",

    aiInsight: getCurrentInsight(currentScore),
  };
}

module.exports = {
  buildHQSResponse,
};
