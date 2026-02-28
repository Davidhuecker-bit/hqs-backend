"use strict";

/*
  HQS Auto-Factor Learning Engine – Hardened Version
  ---------------------------------------------------
  - Adaptive Learning Rate
  - Drift Protection
  - Regime Sensitivity
  - Stability Safeguards
*/

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeWeights(weights) {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);

  if (!sum || sum === 0) {
    return {
      momentum: 0.25,
      quality: 0.25,
      stability: 0.25,
      relative: 0.25
    };
  }

  const normalized = {};
  Object.keys(weights).forEach(key => {
    normalized[key] = weights[key] / sum;
  });

  return normalized;
}

function calculateLearningRate(performance) {
  const sharpe = Number(performance?.sharpe || 0);
  const winRate = Number(performance?.winRate || 0);

  // stärkeres Lernen bei starker Performance
  const strength = clamp((sharpe + winRate / 100) / 2, 0, 2);

  return 0.01 + strength * 0.01; 
}

function adjustWeights(currentWeights, performance, regime = "neutral") {
  if (!currentWeights) {
    throw new Error("Missing currentWeights in autoFactor");
  }

  const weights = { ...currentWeights };

  const winRate = Number(performance?.winRate || 0);
  const sharpe = Number(performance?.sharpe || 0);
  const drawdown = Number(performance?.maxDrawdown || 0);
  const totalReturn = Number(performance?.totalReturn || 0);

  const lr = calculateLearningRate(performance);

  /*
    ===== 1. Momentum & Relative =====
  */

  if (winRate > 60) {
    weights.momentum += lr;
    weights.relative += lr / 2;
  }

  if (winRate < 45) {
    weights.momentum -= lr;
    weights.relative -= lr / 2;
  }

  /*
    ===== 2. Quality & Stability via Sharpe =====
  */

  if (sharpe > 1.5) {
    weights.quality += lr;
  }

  if (sharpe < 0.8) {
    weights.stability += lr;
  }

  /*
    ===== 3. Drawdown Protection =====
  */

  if (drawdown > 20) {
    weights.stability += lr * 1.5;
    weights.momentum -= lr;
  }

  /*
    ===== 4. Total Return Bias =====
  */

  if (totalReturn > 15) {
    weights.momentum += lr / 2;
  }

  if (totalReturn < 0) {
    weights.stability += lr;
    weights.quality += lr / 2;
  }

  /*
    ===== 5. Regime Bias =====
  */

  if (regime === "bull" || regime === "expansion") {
    weights.momentum += lr / 2;
  }

  if (regime === "bear" || regime === "crash") {
    weights.stability += lr;
    weights.quality += lr / 2;
  }

  /*
    ===== 6. Clamp Hard Limits
  */

  Object.keys(weights).forEach(key => {
    weights[key] = clamp(weights[key], 0.05, 0.6);
  });

  /*
    ===== 7. Normalize to 1
  */

  return normalizeWeights(weights);
}

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
