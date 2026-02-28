// services/portfolioHqs.service.js
// HQS Portfolio Core Engine

const { getGlobalMarketData } = require("./aggregator.service");

/**
 * Berechnet Einzel-Aktien-Score (Basis)
 */
function calculateStockScore(stock) {
  let score = 50;

  if (stock.changesPercentage !== null) {
    if (stock.changesPercentage > 2) score += 10;
    if (stock.changesPercentage < -2) score -= 10;
  }

  if (stock.volume !== null && stock.volume > 1000000) {
    score += 5;
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Berechnet Diversifikation
 */
function calculateDiversificationScore(stocks) {
  const regions = new Set(stocks.map(s => s.region));
  return Math.min(100, regions.size * 25);
}

/**
 * Hauptfunktion
 */
async function calculatePortfolioHQS(symbols = []) {
  const marketData = await getGlobalMarketData(symbols);

  const individualScores = marketData.map(stock => ({
    symbol: stock.symbol,
    region: stock.region,
    score: calculateStockScore(stock),
  }));

  const averageStockScore =
    individualScores.reduce((sum, s) => sum + s.score, 0) /
    (individualScores.length || 1);

  const diversificationScore = calculateDiversificationScore(marketData);

  const finalScore = Math.round(
    averageStockScore * 0.7 +
    diversificationScore * 0.3
  );

  return {
    finalScore,
    averageStockScore: Math.round(averageStockScore),
    diversificationScore,
    breakdown: individualScores,
  };
}

module.exports = {
  calculatePortfolioHQS,
};
