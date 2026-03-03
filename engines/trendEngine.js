function calculateReturns(prices) {
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    const r = (prices[i] - prices[i - 1]) / prices[i - 1];
    returns.push(r);
  }
  return returns;
}

function calculateVolatility(returns) {
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) /
    returns.length;
  return Math.sqrt(variance) * Math.sqrt(252);
}

function calculateTrend(prices) {
  const first = prices[prices.length - 1];
  const last = prices[0];
  return (first - last) / last;
}

function buildTrendScore(prices) {
  const returns = calculateReturns(prices);
  const volatility = calculateVolatility(returns);
  const trend = calculateTrend(prices);

  return {
    trend,
    volatility,
    score: trend * (1 - volatility)
  };
}

module.exports = { buildTrendScore };
