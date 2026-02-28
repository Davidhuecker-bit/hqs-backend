"use strict";

/*
  HQS Backtesting Engine – Institutional Version
*/

function safe(v, f = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
}

function calculateReturn(entry, exit) {
  if (!entry || !exit) return 0;
  return ((exit - entry) / entry) * 100;
}

function simulateStrategy(history = [], threshold = 70) {
  if (!Array.isArray(history) || history.length < 2) {
    return {
      trades: 0,
      winRate: 0,
      totalReturn: 0,
      averageReturn: 0,
      equityCurve: []
    };
  }

  let trades = [];
  let wins = 0;
  let equity = 100;
  const equityCurve = [equity];

  for (let i = 0; i < history.length - 1; i++) {
    const today = history[i];
    const tomorrow = history[i + 1];

    if (safe(today.hqsScore) >= threshold) {
      const ret = calculateReturn(
        safe(today.price),
        safe(tomorrow.price)
      );

      trades.push(ret);

      equity = equity * (1 + ret / 100);
      equityCurve.push(equity);

      if (ret > 0) wins++;
    }
  }

  const totalReturn = equity - 100;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;
  const avgReturn = trades.length
    ? trades.reduce((a, b) => a + b, 0) / trades.length
    : 0;

  return {
    trades: trades.length,
    winRate: Math.round(winRate),
    totalReturn: Number(totalReturn.toFixed(2)),
    averageReturn: Number(avgReturn.toFixed(2)),
    equityCurve
  };
}

module.exports = { simulateStrategy };
