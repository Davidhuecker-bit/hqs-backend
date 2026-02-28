"use strict";

/*
  HQS BACKTESTING ENGINE
  - Historical Portfolio Simulation
  - Factor Attribution
  - Benchmark Comparison (SPY)
*/

const axios = require("axios");

const FMP_API_KEY = process.env.FMP_API_KEY;

/* =========================================================
   HELPERS
========================================================= */

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr) {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map(x => (x - m) ** 2)));
}

function calculateMaxDrawdown(prices) {
  let peak = prices[0];
  let maxDD = 0;

  for (let i = 1; i < prices.length; i++) {
    if (prices[i] > peak) peak = prices[i];
    const dd = (prices[i] - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  return maxDD;
}

function calculateSharpe(returns) {
  const avg = mean(returns);
  const volatility = std(returns);
  if (!volatility) return 0;
  return (avg / volatility) * Math.sqrt(252);
}

/* =========================================================
   HISTORICAL DATA
========================================================= */

async function fetchHistorical(symbol, days = 365) {
  try {
    const url = `https://financialmodelingprep.com/api/v3/historical-price-full/${symbol}?timeseries=${days}&apikey=${FMP_API_KEY}`;
    const res = await axios.get(url, { timeout: 8000 });

    const hist = res.data?.historical;
    if (!Array.isArray(hist)) return [];

    return hist.map(d => ({
      date: d.date,
      close: d.close
    })).reverse();
  } catch {
    return [];
  }
}

/* =========================================================
   PORTFOLIO SIMULATION
========================================================= */

async function simulatePortfolio(portfolio, days = 365) {
  const symbols = portfolio.map(p => p.symbol);

  const historicalMap = {};

  await Promise.all(
    symbols.map(async s => {
      historicalMap[s] = await fetchHistorical(s, days);
    })
  );

  const length = Math.min(
    ...Object.values(historicalMap).map(arr => arr.length)
  );

  if (!length) return null;

  const portfolioValues = [];
  const dailyReturns = [];

  for (let i = 0; i < length; i++) {
    let value = 0;

    for (const position of portfolio) {
      const data = historicalMap[position.symbol];
      value += data[i].close * (position.weight || 1);
    }

    portfolioValues.push(value);

    if (i > 0) {
      const ret =
        (portfolioValues[i] - portfolioValues[i - 1]) /
        portfolioValues[i - 1];
      dailyReturns.push(ret);
    }
  }

  const totalReturn =
    (portfolioValues[length - 1] - portfolioValues[0]) /
    portfolioValues[0];

  const maxDD = calculateMaxDrawdown(portfolioValues);
  const sharpe = calculateSharpe(dailyReturns);

  return {
    totalReturn,
    maxDrawdown: maxDD,
    sharpe,
    dailyReturns
  };
}

/* =========================================================
   BENCHMARK COMPARISON
========================================================= */

async function simulateBenchmark(days = 365) {
  const spyData = await fetchHistorical("SPY", days);

  if (!spyData.length) return null;

  const prices = spyData.map(d => d.close);
  const returns = [];

  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }

  const totalReturn =
    (prices[prices.length - 1] - prices[0]) / prices[0];

  return {
    totalReturn,
    maxDrawdown: calculateMaxDrawdown(prices),
    sharpe: calculateSharpe(returns)
  };
}

/* =========================================================
   FACTOR ATTRIBUTION (Basic)
========================================================= */

function factorAttribution(portfolio) {
  let growthWeight = 0;
  let defensiveWeight = 0;

  for (const p of portfolio) {
    if (p.sector === "Technology" || p.sector === "Consumer Cyclical")
      growthWeight += p.weight || 1;
    else
      defensiveWeight += p.weight || 1;
  }

  return {
    growthExposure: growthWeight,
    defensiveExposure: defensiveWeight
  };
}

/* =========================================================
   MAIN BACKTEST FUNCTION
========================================================= */

async function runBacktest(portfolio, days = 365) {
  if (!Array.isArray(portfolio) || !portfolio.length)
    return { error: "Empty portfolio" };

  const portfolioResult = await simulatePortfolio(portfolio, days);
  const benchmarkResult = await simulateBenchmark(days);

  if (!portfolioResult || !benchmarkResult)
    return { error: "Insufficient data" };

  const alpha =
    portfolioResult.totalReturn - benchmarkResult.totalReturn;

  return {
    portfolio: {
      return: portfolioResult.totalReturn,
      maxDrawdown: portfolioResult.maxDrawdown,
      sharpe: portfolioResult.sharpe
    },
    benchmark: benchmarkResult,
    alpha,
    factorExposure: factorAttribution(portfolio)
  };
}

module.exports = {
  runBacktest
};
