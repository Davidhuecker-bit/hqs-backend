// services/portfolioHqs.service.js
// Advanced HQS Portfolio Engine (Weighted Version)

const { getGlobalMarketData } = require("./aggregator.service");

/**
 * Momentum Score pro Aktie
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
 * Konzentrations-Risiko (Gewicht berücksichtigt)
 */
function calculateConcentrationPenalty(portfolio) {
  const totalWeight = portfolio.reduce((sum, p) => sum + (p.weight || 1), 0);

  const regionWeights = {};

  for (const position of portfolio) {
    const region = position.region;
    regionWeights[region] =
      (regionWeights[region] || 0) + (position.weight || 1);
  }

  const maxRegionWeight = Math.max(...Object.values(regionWeights));
  const concentrationRatio = maxRegionWeight / totalWeight;

  if (concentrationRatio > 0.7) return -25;
  if (concentrationRatio > 0.5) return -12;

  return 0;
}

/**
 * Hauptfunktion
 * @param {Array<{symbol: string, weight?: number}>} portfolio
 */
async function calculatePortfolioHQS(portfolio = []) {
  if (!Array.isArray(portfolio) || portfolio.length === 0) {
    return { finalScore: 0, reason: "Empty portfolio" };
  }

  const symbols = portfolio.map(p => p.symbol);

  const marketData = await getGlobalMarketData(symbols);

  if (!marketData.length) {
    return { finalScore: 0, reason: "No market data available" };
  }

  // Merge Markt + Gewicht
  const enrichedPortfolio = marketData.map(stock => {
    const position = portfolio.find(p => p.symbol === stock.symbol);
    return {
      ...stock,
      weight: position?.weight || 1,
    };
  });

  const totalWeight = enrichedPortfolio.reduce(
    (sum, p) => sum + p.weight,
    0
  );

  let weightedMomentumSum = 0;

  const breakdown = enrichedPortfolio.map(stock => {
    const momentumScore = calculateMomentumScore(stock);

    weightedMomentumSum += momentumScore * (stock.weight / totalWeight);

    return {
      symbol: stock.symbol,
      region: stock.region,
      weight: stock.weight,
      momentumScore,
    };
  });

  const regionScore = calculateRegionScore(enrichedPortfolio);
  const concentrationPenalty = calculateConcentrationPenalty(enrichedPortfolio);

  const rawScore =
    weightedMomentumSum * 0.6 +
    regionScore * 0.3 +
    50 * 0.1;

  const finalScore = Math.round(
    Math.max(0, Math.min(100, rawScore + concentrationPenalty))
  );

  return {
    finalScore,
    weightedMomentum: Math.round(weightedMomentumSum),
    regionScore,
    concentrationPenalty,
    stockCount: enrichedPortfolio.length,
    breakdown,
  };
}

module.exports = {
  calculatePortfolioHQS,
};
