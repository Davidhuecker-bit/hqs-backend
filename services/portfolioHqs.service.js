"use strict";

/**
 * HQS Portfolio Engine – Full Version
 * Features:
 * - Gewichtetes Momentum
 * - Region-Diversifikation
 * - Konzentrationsrisiko
 * - Marktphase (Fear & Greed)
 * - Volatilitäts-Faktor
 * - Defensive Anpassung bei Risk-Off
 */

const { getGlobalMarketData } = require("./aggregator.service");
const axios = require("axios");

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
   Volatility Factor
========================= */
function calculateVolatilityAdjustment(stock) {
  if (stock.high && stock.low && stock.price) {
    const range = (stock.high - stock.low) / stock.price;
    if (range > 0.05) return -6;
    if (range > 0.08) return -10;
  }
  return 0;
}

/* =========================
   Region Diversifikation
========================= */
function calculateRegionScore(stocks) {
  const regions = new Set(stocks.map(s => s.region));
  return Math.min(100, regions.size * 30);
}

/* =========================
   Konzentrations-Risiko
========================= */
function calculateConcentrationPenalty(portfolio) {
  const totalWeight = portfolio.reduce((sum, p) => sum + p.weight, 0);

  const regionWeights = {};

  for (const position of portfolio) {
    regionWeights[position.region] =
      (regionWeights[position.region] || 0) + position.weight;
  }

  const maxRegionWeight = Math.max(...Object.values(regionWeights));
  const concentrationRatio = maxRegionWeight / totalWeight;

  if (concentrationRatio > 0.75) return -30;
  if (concentrationRatio > 0.6) return -18;
  if (concentrationRatio > 0.5) return -10;

  return 0;
}

/* =========================
   Fear & Greed (Market Phase)
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
   Main HQS Calculation
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

  let weightedMomentum = 0;
  let volatilityPenaltySum = 0;

  const breakdown = enrichedPortfolio.map(stock => {
    const momentumScore = calculateMomentumScore(stock);
    const volatilityAdjustment = calculateVolatilityAdjustment(stock);

    weightedMomentum += momentumScore * (stock.weight / totalWeight);
    volatilityPenaltySum += volatilityAdjustment * (stock.weight / totalWeight);

    return {
      symbol: stock.symbol,
      region: stock.region,
      weight: stock.weight,
      momentumScore,
      volatilityAdjustment,
    };
  });

  const regionScore = calculateRegionScore(enrichedPortfolio);
  const concentrationPenalty = calculateConcentrationPenalty(enrichedPortfolio);

  const marketPhaseData = await getMarketPhase();

  let phaseAdjustment = 0;

  if (marketPhaseData.phase === "risk_off") {
    phaseAdjustment = -12;
  }

  if (marketPhaseData.phase === "risk_on") {
    phaseAdjustment = 6;
  }

  const rawScore =
    weightedMomentum * 0.55 +
    regionScore * 0.25 +
    50 * 0.2;

  const finalScore = Math.round(
    Math.max(
      0,
      Math.min(
        100,
        rawScore +
        concentrationPenalty +
        phaseAdjustment +
        volatilityPenaltySum
      )
    )
  );

  return {
    finalScore,
    weightedMomentum: Math.round(weightedMomentum),
    regionScore,
    concentrationPenalty,
    volatilityPenalty: Math.round(volatilityPenaltySum),
    marketPhase: marketPhaseData.phase,
    fearGreedValue: marketPhaseData.value,
    phaseAdjustment,
    stockCount: enrichedPortfolio.length,
    breakdown,
  };
}

module.exports = {
  calculatePortfolioHQS,
};
