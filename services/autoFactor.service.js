"use strict";

/*
  HQS Auto-Factor Learning Engine
  --------------------------------
  Ziel:
  - Dynamische Gewichtsanpassung
  - Performance-basiertes Lernen
  - Regime-sensitives Feintuning
  - Stabilitäts-Absicherung (keine Extremwerte)
*/

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeWeights(weights) {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);

  if (!sum || sum === 0) return weights;

  const normalized = {};
  Object.keys(weights).forEach(key => {
    normalized[key] = weights[key] / sum;
  });

  return normalized;
}

/*
  PERFORMANCE INPUT STRUCTURE:

  performance = {
    winRate: number,
    sharpe: number,
    maxDrawdown: number,
    totalReturn: number
  }
*/

function adjustWeights(currentWeights, performance, regime = "neutral") {
  if (!currentWeights) {
    throw new Error("Missing currentWeights in autoFactor");
  }

  const weights = { ...currentWeights };

  const winRate = Number(performance?.winRate || 0);
  const sharpe = Number(performance?.sharpe || 0);
  const drawdown = Number(performance?.maxDrawdown || 0);
  const totalReturn = Number(performance?.totalReturn || 0);

  /*
    ===== 1. WinRate Adjustment =====
  */

  if (winRate > 60) {
    weights.momentum += 0.02;
    weights.relative += 0.01;
  }

  if (winRate < 45) {
    weights.momentum -= 0.02;
    weights.relative -= 0.01;
  }

  /*
    ===== 2. Sharpe Ratio Adjustment =====
  */

  if (sharpe > 1.5) {
    weights.quality += 0.02;
  }

  if (sharpe < 0.8) {
    weights.stability += 0.02;
  }

  /*
    ===== 3. Drawdown Protection =====
  */

  if (drawdown > 20) {
    weights.stability += 0.03;
    weights.momentum -= 0.02;
  }

  /*
    ===== 4. Total Return Confirmation =====
  */

  if (totalReturn > 15) {
    weights.momentum += 0.01;
  }

  if (totalReturn < 0) {
    weights.stability += 0.02;
    weights.quality += 0.01;
  }

  /*
    ===== 5. Regime Bias =====
  */

  if (regime === "bull" || regime === "expansion") {
    weights.momentum += 0.01;
  }

  if (regime === "bear" || regime === "crash") {
    weights.stability += 0.02;
    weights.quality += 0.01;
  }

  /*
    ===== 6. Clamp Limits =====
    Kein Faktor darf unter 5% oder über 60% liegen
  */

  Object.keys(weights).forEach(key => {
    weights[key] = clamp(weights[key], 0.05, 0.6);
  });

  /*
    ===== 7. Normalize to 1 =====
  */

  const normalized = normalizeWeights(weights);

  return normalized;
}

/*
  Default Starting Weights
*/

function getDefaultWeights() {
  return {
    momentum: 0.35,
    quality: 0.35,
    stability: 0.2,
    relative: 0.1
  };
}

module.exports = {
  adjustWeights,
  getDefaultWeights
};
