"use strict";

/*
  Strategy Engine
  Derives the strategy and score adjustment from market conditions.
  When a researchReport from researchEngine is provided, the breakout
  strategy is confirmed via research signals (chain mode) rather than
  re-evaluating the raw volatility/trend condition.
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function detectStrategy(features, advanced, researchReport) {

  const trend = safe(advanced?.trend);
  const volatility = safe(advanced?.volatilityAnnual);
  const trendStrength = safe(features?.trendStrength);

  if (trendStrength > 1.5 && trend > 0.2) {
    return {
      strategy: "momentum",
      label: "Momentum Strategy"
    };
  }

  const breakoutConfirmed = researchReport
    ? (researchReport.researchSignals || []).some(s => s.hypothesis === "volatility_breakout")
    : (volatility < 0.2 && trend > 0.1);

  if (breakoutConfirmed) {
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

function applyStrategy(symbol, aiScore, features, advanced, researchReport = null) {

  const strategyInfo = detectStrategy(features, advanced, researchReport);

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
