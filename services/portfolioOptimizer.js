"use strict";

/*
  HQS Portfolio Optimizer – Score Weighted Allocation
*/

function safe(v, f = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
}

function optimizePortfolio(stocks = []) {
  if (!Array.isArray(stocks) || stocks.length === 0) {
    return [];
  }

  const totalScore = stocks.reduce(
    (sum, s) => sum + safe(s.hqsScore),
    0
  );

  if (totalScore === 0) {
    const equalWeight = 100 / stocks.length;

    return stocks.map(stock => ({
      symbol: stock.symbol,
      allocation: Number(equalWeight.toFixed(2))
    }));
  }

  return stocks.map(stock => {
    const weight =
      (safe(stock.hqsScore) / totalScore) * 100;

    return {
      symbol: stock.symbol,
      allocation: Number(weight.toFixed(2))
    };
  });
}

module.exports = { optimizePortfolio };
