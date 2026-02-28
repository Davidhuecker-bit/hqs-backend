"use strict";

/*
  HQS PORTFOLIO ENGINE – FULL PERSISTENT VERSION
*/

const axios = require("axios");
const { getGlobalMarketData } = require("./aggregator.service");
const { buildDiagnosis } = require("./portfolioDiagnosis.service");
const { calibrateFactorWeights } = require("./autoFactorCalibration.service");
const {
  initFactorTable,
  saveFactorSnapshot,
  loadFactorHistory
} = require("./factorHistory.repository");

const FMP_API_KEY = process.env.FMP_API_KEY;

const DEFAULT_WEIGHTS = {
  momentum: 0.30,
  volatility: 0.10,
  earnings: 0.20,
  correlation: 0.20,
  macro: 0.20
};

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function calculateMomentum(stock) {
  const ch = stock.changesPercentage || 0;
  if (ch > 4) return 75;
  if (ch > 2) return 65;
  if (ch < -4) return 30;
  if (ch < -2) return 40;
  return 50;
}

function calculateVolatility(stock) {
  if (!stock.high || !stock.low || !stock.price) return 0;
  const range = (stock.high - stock.low) / stock.price;
  if (range > 0.08) return -12;
  if (range > 0.05) return -6;
  return 0;
}

async function fetchEarningsDrift(symbol) {
  try {
    const url = `https://financialmodelingprep.com/api/v3/analyst-estimates/${symbol}?apikey=${FMP_API_KEY}`;
    const res = await axios.get(url);
    const data = res.data;
    if (!Array.isArray(data) || data.length < 2) return 0;

    const latest = data[0]?.estimatedEpsAvg;
    const prev = data[1]?.estimatedEpsAvg;

    if (!latest || !prev) return 0;
    if (latest > prev * 1.05) return 8;
    if (latest < prev * 0.95) return -8;
    return 0;
  } catch {
    return 0;
  }
}

async function detectRegime() {
  try {
    const [spy, vix] = await Promise.all([
      axios.get(`https://financialmodelingprep.com/api/v3/quote/SPY?apikey=${FMP_API_KEY}`),
      axios.get(`https://financialmodelingprep.com/api/v3/quote/%5EVIX?apikey=${FMP_API_KEY}`)
    ]);

    const spyCh = spy.data?.[0]?.changesPercentage || 0;
    const vixLevel = vix.data?.[0]?.price || 20;

    if (vixLevel > 25) return "risk_off";
    if (spyCh > 1.5) return "risk_on";
    return "neutral";
  } catch {
    return "neutral";
  }
}

async function calculatePortfolioHQS(portfolio = []) {
  if (!Array.isArray(portfolio) || !portfolio.length)
    return { finalScore: 0, reason: "Empty portfolio" };

  await initFactorTable();

  const symbols = portfolio.map(p => p.symbol);
  const marketData = await getGlobalMarketData(symbols);

  if (!marketData.length)
    return { finalScore: 0, reason: "No market data available" };

  const regime = await detectRegime();

  const factorHistory = await loadFactorHistory();

  const learned = calibrateFactorWeights(
    factorHistory,
    {}
  );

  const dynamicWeights =
    learned?.[regime] || DEFAULT_WEIGHTS;

  const enriched = await Promise.all(
    marketData.map(async stock => {
      const position = portfolio.find(p => p.symbol === stock.symbol);
      return {
        ...stock,
        weight: position?.weight || 1,
        momentum: calculateMomentum(stock),
        volatility: calculateVolatility(stock),
        earnings: await fetchEarningsDrift(stock.symbol)
      };
    })
  );

  const totalWeight = enriched.reduce((s, p) => s + p.weight, 0);

  let weightedScore = 0;

  for (const s of enriched) {
    const score =
      s.momentum * dynamicWeights.momentum +
      s.volatility * dynamicWeights.volatility +
      s.earnings * dynamicWeights.earnings;

    weightedScore += score * (s.weight / totalWeight);
  }

  const finalScore = Math.round(
    clamp(weightedScore * 0.6 + 50 * 0.4, 0, 100)
  );

  // Persist learning snapshot
  await saveFactorSnapshot(regime, finalScore / 100, {
    momentum: dynamicWeights.momentum,
    volatility: dynamicWeights.volatility,
    earnings: dynamicWeights.earnings,
    correlation: dynamicWeights.correlation,
    macro: dynamicWeights.macro
  });

  const diagnosis = buildDiagnosis(
    enriched,
    finalScore,
    regime
  );

  return {
    finalScore,
    regime,
    dynamicWeights,
    breakdown: enriched,
    diagnosis
  };
}

module.exports = {
  calculatePortfolioHQS
};
