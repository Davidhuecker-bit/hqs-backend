"use strict";

/**
 * HQS Portfolio Engine – Full Version + Insider Signal
 */

const { getGlobalMarketData } = require("./aggregator.service");
const axios = require("axios");

const FMP_API_KEY = process.env.FMP_API_KEY;

/* =========================
   Momentum Score
========================= */
function calculateMomentumScore(stock) {
  let score = 50;

  if (stock.changesPercentage !== null) {
    if (stock.changesPercentage > 4) score += 18;
    else if (stock.changesPercentage > 2) score += 10;
    else if (stock.changesPercentage < -4) score -= 18;
    else if (stock.changesPercentage < -2) score -= 10;
  }

  if (stock.volume !== null && stock.volume > 3_000_000) {
    score += 5;
  }

  return Math.max(0, Math.min(100, score));
}

/* =========================
   Volatility Adjustment
========================= */
function calculateVolatilityAdjustment(stock) {
  if (stock.high && stock.low && stock.price) {
    const range = (stock.high - stock.low) / stock.price;
    if (range > 0.08) return -10;
    if (range > 0.05) return -6;
  }
  return 0;
}

/* =========================
   Region Score
========================= */
function calculateRegionScore(stocks) {
  const regions = new Set(stocks.map(s => s.region));
  return Math.min(100, regions.size * 30);
}

/* =========================
   Concentration Risk
========================= */
function calculateConcentrationPenalty(portfolio) {
  const totalWeight = portfolio.reduce((sum, p) => sum + p.weight, 0);
  const regionWeights = {};

  for (const position of portfolio) {
    regionWeights[position.region] =
      (regionWeights[position.region] || 0) + position.weight;
  }

  const maxRegionWeight = Math.max(...Object.values(regionWeights));
  const ratio = maxRegionWeight / totalWeight;

  if (ratio > 0.75) return -30;
  if (ratio > 0.6) return -18;
  if (ratio > 0.5) return -10;

  return 0;
}

/* =========================
   Insider Signal
========================= */
async function fetchInsiderSignal(symbol) {
  try {
    const url = `https://financialmodelingprep.com/api/v4/insider-trading?symbol=${symbol}&apikey=${FMP_API_KEY}`;
    const response = await axios.get(url, { timeout: 5000 });

    const trades = response.data;

    if (!Array.isArray(trades) || trades.length === 0) {
      return 0;
    }

    let buyVolume = 0;
    let sellVolume = 0;

    for (const trade of trades.slice(0, 10)) {
      if (trade.transactionType === "P-Purchase") {
        buyVolume += Number(trade.securitiesTransacted) || 0;
      }

      if (trade.transactionType === "S-Sale") {
        sellVolume += Number(trade.securitiesTransacted) || 0;
      }
    }

    if (buyVolume > sellVolume * 1.2) return 8;
    if (sellVolume > buyVolume * 1.2) return -8;

    return 0;

  } catch {
    return 0;
  }
}

/* =========================
   Fear & Greed
========================= */
async function getMarketPhase() {
  try {
    const response = await axios.get(
      "https://api.alternative.me/fng/?limit=1",
      { timeout: 4000 }
    );

    const value = Number(response.data?.data?.[0]?.value);

    if (value >= 65) return { phase: "risk_on", value };
    if (value <= 35) return { phase: "risk_off", value };

    return { phase: "neutral", value };
  } catch {
    return { phase: "neutral", value: null };
  }
}

/* =========================
   MAIN FUNCTION
========================= */
async function calculatePortfolioHQS(portfolio = []) {
  if (!Array.isArray(portfolio) || portfolio.length === 0) {
    return { finalScore: 0, reason: "Empty portfolio" };
  }

  const symbols = portfolio.map(p => p.symbol);
  const marketData = await getGlobalMarketData(symbols);

  if (!marketData.length) {
    return { finalScore: 0, reason: "No market data available" };
  }

  const enriched = [];

  for (const stock of marketData) {
    const position = portfolio.find(p => p.symbol === stock.symbol);
    const insiderAdjustment = await fetchInsiderSignal(stock.symbol);

    enriched.push({
      ...stock,
      weight: position?.weight || 1,
      insiderAdjustment,
    });
  }

  const totalWeight = enriched.reduce((sum, p) => sum + p.weight, 0);

  let weightedMomentum = 0;
  let volatilityPenalty = 0;
  let insiderSum = 0;

  const breakdown = enriched.map(stock => {
    const momentumScore = calculateMomentumScore(stock);
    const volAdj = calculateVolatilityAdjustment(stock);

    weightedMomentum += momentumScore * (stock.weight / totalWeight);
    volatilityPenalty += volAdj * (stock.weight / totalWeight);
    insiderSum += stock.insiderAdjustment * (stock.weight / totalWeight);

    return {
      symbol: stock.symbol,
      region: stock.region,
      weight: stock.weight,
      momentumScore,
      volatilityAdjustment: volAdj,
      insiderAdjustment: stock.insiderAdjustment,
    };
  });

  const regionScore = calculateRegionScore(enriched);
  const concentrationPenalty = calculateConcentrationPenalty(enriched);
  const marketPhase = await getMarketPhase();

  let phaseAdjustment = 0;

  if (marketPhase.phase === "risk_off") phaseAdjustment = -12;
  if (marketPhase.phase === "risk_on") phaseAdjustment = 6;

  const rawScore =
    weightedMomentum * 0.5 +
    regionScore * 0.25 +
    50 * 0.25;

  const finalScore = Math.round(
    Math.max(
      0,
      Math.min(
        100,
        rawScore +
        concentrationPenalty +
        volatilityPenalty +
        phaseAdjustment +
        insiderSum
      )
    )
  );

  return {
    finalScore,
    marketPhase: marketPhase.phase,
    fearGreedValue: marketPhase.value,
    regionScore,
    concentrationPenalty,
    insiderImpact: Math.round(insiderSum),
    volatilityImpact: Math.round(volatilityPenalty),
    breakdown,
  };
}

module.exports = {
  calculatePortfolioHQS,
};
