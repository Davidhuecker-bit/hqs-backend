// services/portfolioHqs.service.js
// Advanced HQS Portfolio Core Engine

const { getGlobalMarketData } = require("./aggregator.service");

/**
 * Einzel-Aktien Momentum Score
 */
function calculateMomentumScore(stock) {
  let score = 50;

  if (stock.changesPercentage !== null) {
    if (stock.changesPercentage > 3) score += 15;
    else if (stock.changesPercentage > 1) score += 8;
    else if (stock.changesPercentage < -3) score -= 15;
    else if (stock.changesPercentage < -1) score -= 8;
  }

  if (stock.volume !== null && stock.volume > 2_000_000) {
    score += 5;
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Region Diversifikation
 */
function calculateRegionScore(stocks) {
  const regions = new Set(stocks.map(s => s.region));
  return Math.min(100, regions.size * 30);
}

/**
 * Konzentrations-Risiko
 */
function calculateConcentrationPenalty(stocks) {
  const regionCount = {};

  for (const stock of stocks) {
    regionCount[stock.region] = (regionCount[stock.region] || 0) + 1;
  }

  const maxRegion = Math.max(...Object.values(regionCount));
  const concentrationRatio = maxRegion / stocks.length;

  if (concentrationRatio > 0.7) return -20;
  if (concentrationRatio > 0.5) return -10;

  return 0;
}

/**
 * Hauptfunktion
 */
async function calculatePortfolioHQS(symbols = []) {
  const marketData = await getGlobalMarketData(symbols);

  if (!marketData.length) {
    return {
      finalScore: 0,
      reason: "No market data available",
    };
  }

  const momentumScores = marketData.map(calculateMomentumScore);

  const avgMomentum =
    momentumScores.reduce((sum, val) => sum + val, 0) /
    momentumScores.length;

  const regionScore = calculateRegionScore(marketData);
  const concentrationPenalty = calculateConcentrationPenalty(marketData);

  const rawScore =
    avgMomentum * 0.6 +
    regionScore * 0.3 +
    50 * 0.1;

  const finalScore = Math.round(
    Math.max(0, Math.min(100, rawScore + concentrationPenalty))
  );

  return {
    finalScore,
    avgMomentum: Math.round(avgMomentum),
    regionScore,
    concentrationPenalty,
    stockCount: marketData.length,
    breakdown: marketData.map((stock, i) => ({
      symbol: stock.symbol,
      region: stock.region,
      momentumScore: momentumScores[i],
    })),
  };
}

module.exports = {
  calculatePortfolioHQS,
};
