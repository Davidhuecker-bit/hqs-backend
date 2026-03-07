"use strict";

/*
  Strategy Engine
  Determines which strategy fits the current market conditions
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function detectStrategy(features, advanced) {

  const trend = safe(advanced?.trend);
  const volatility = safe(advanced?.volatilityAnnual);
  const trendStrength = safe(features?.trendStrength);

  if (trendStrength > 1.5 && trend > 0.2) {
    return {
      strategy: "momentum",
      label: "Momentum Strategy"
    };
  }

  if (volatility < 0.2 && trend > 0.1) {
    return {
      strategy: "breakout",
      label: "Breakout Setup"
    };
  }

  if (volatility > 0.7) {
    return {
      strategy: "defensive",
      label: "Defensive Setup"
    };
  }

  return {
    strategy: "balanced",
    label: "Balanced Market"
  };
}

/* ===============================
   STRATEGY SCORE ADJUSTMENT
================================ */

function adjustScoreForStrategy(aiScore, strategy) {

  let adjusted = aiScore;

  if (strategy === "momentum") {
    adjusted += 5;
  }

  if (strategy === "breakout") {
    adjusted += 3;
  }

  if (strategy === "defensive") {
    adjusted -= 4;
  }

  return Math.max(0, Math.min(100, adjusted));
}

function applyStrategy(symbol, aiScore, features, advanced) {

  const strategyInfo = detectStrategy(features, advanced);

  const adjustedScore = adjustScoreForStrategy(
    aiScore,
    strategyInfo.strategy
  );

  return {

    symbol,

    strategy: strategyInfo.strategy,
    strategyLabel: strategyInfo.label,

    strategyAdjustedScore: adjustedScore

  };

}

module.exports = {
  applyStrategy
};
