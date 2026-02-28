// services/backtestEngine.js
// HQS Backtesting Engine v1.0

function safe(v, f = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
}

function calculateReturn(entry, exit) {
  if (!entry || !exit) return 0;
  return ((exit - entry) / entry) * 100;
}

function simulateStrategy(historicalData = [], scoreThreshold = 70) {
  if (!Array.isArray(historicalData)) return null;

  let trades = [];
  let wins = 0;

  for (let i = 0; i < historicalData.length - 1; i++) {
    const today = historicalData[i];
    const tomorrow = historicalData[i + 1];

    if (safe(today.hqsScore) >= scoreThreshold) {
      const tradeReturn = calculateReturn(
        safe(today.price),
        safe(tomorrow.price)
      );

      trades.push(tradeReturn);

      if (tradeReturn > 0) wins++;
    }
  }

  const totalReturn = trades.reduce((a, b) => a + b, 0);
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;

  return {
    trades: trades.length,
    winRate: Math.round(winRate),
    totalReturn: Math.round(totalReturn),
    averageReturn: trades.length
      ? Math.round(totalReturn / trades.length)
      : 0,
  };
}

module.exports = { simulateStrategy };
