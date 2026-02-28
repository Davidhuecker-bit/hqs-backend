// services/portfolioOptimizer.js
// HQS Hybrid Portfolio Optimizer

function safe(v, f = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
}

function optimizePortfolio(stocks = []) {
  if (!Array.isArray(stocks) || stocks.length === 0) return [];

  const totalScore = stocks.reduce(
    (sum, s) => sum + safe(s.hqsScore),
    0
  );

  return stocks.map(stock => {
    const weight = totalScore
      ? safe(stock.hqsScore) / totalScore
      : 1 / stocks.length;

    return {
      symbol: stock.symbol,
      allocation: Number((weight * 100).toFixed(2))
    };
  });
}

module.exports = { optimizePortfolio };
