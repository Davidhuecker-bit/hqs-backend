// hqsEngine.js
// HQS Engine – aktuell nur "Current Score" (Gegenwart) v1.0
// Später ergänzen wir: Stability + Future + Regime + Constraints + Confidence

const { calculateCurrentScore, getCurrentInsight } = require("./services/current.service");

function buildHQSResponse(item) {
  const currentScore = calculateCurrentScore(item);

  return {
    symbol: item.symbol,
    name: item.name,
    price: item.price,
    changePercent: Number(item.changesPercentage || 0).toFixed(2),
    volume: item.volume,
    avgVolume: item.avgVolume,
    marketCap: item.marketCap,

    // Modul-Score
    currentScore,

    // Vorläufig: Gesamt-HQS = Current
    hqsScore: currentScore,

    rating:
      currentScore >= 85 ? "Strong Buy" :
      currentScore >= 70 ? "Buy" :
      currentScore >= 50 ? "Hold" :
      "Risk",

    decision:
      currentScore >= 70 ? "KAUFEN" :
      currentScore >= 50 ? "HALTEN" :
      "NICHT KAUFEN",

    aiInsight: getCurrentInsight(currentScore),
  };
}

module.exports = {
  buildHQSResponse,
};
