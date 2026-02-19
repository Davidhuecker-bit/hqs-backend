function calculateHQS(item) {
  const change = Number(item.changesPercentage || 0);
  const volume = Number(item.volume || 0);
  const avgVolume = Number(item.avgVolume || 1);
  const vRatio = avgVolume > 0 ? volume / avgVolume : 0;

  let score = 50;

  if (change > 0) score += 10;
  if (vRatio > 1.3) score += 15;
  if (item.marketCap && item.marketCap > 1e11) score += 10;

  return Math.min(100, Math.round(score));
}

function getAIInsight(score) {
  if (score >= 80) return "Starke institutionelle Akkumulation erkannt.";
  if (score <= 45) return "Erhöhtes Risiko – Gewinnmitnahmen wahrscheinlich.";
  return "Neutraler Markt – Konsolidierungsphase möglich.";
}

function buildHQSResponse(item) {
  const hqs = calculateHQS(item);

  return {
    symbol: item.symbol,
    name: item.name,
    price: item.price,
    changePercent: Number(item.changesPercentage || 0).toFixed(2),
    volume: item.volume,
    avgVolume: item.avgVolume,
    marketCap: item.marketCap,
    hqsScore: hqs,
    rating:
      hqs >= 85 ? "Strong Buy" :
      hqs >= 70 ? "Buy" :
      hqs >= 50 ? "Hold" :
      "Risk",
    decision:
      hqs >= 70 ? "KAUFEN" :
      hqs >= 50 ? "HALTEN" :
      "NICHT KAUFEN",
    aiInsight: getAIInsight(hqs),
  };
}

module.exports = {
  buildHQSResponse,
};
