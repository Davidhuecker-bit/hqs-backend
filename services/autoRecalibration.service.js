"use strict";

const { adjustWeights, getDefaultWeights } = require("./autoFactor.service");
const {
  saveWeightSnapshot,
  loadLastWeights
} = require("./weightHistory.repository");

/*
  HQS Auto-Recalibration Engine – Hardened Version
  -------------------------------------------------
  - Cooldown Protection
  - Performance Filter
  - Stability Fallback
  - Regime-aware Learning
*/

const MIN_TRADES_THRESHOLD = 10;
const MIN_SHARPE_THRESHOLD = 0.3;
const RECALIBRATION_COOLDOWN_MS = 1000 * 60 * 60 * 6; // 6 Stunden

let lastRecalibrationTimestamp = 0;

function shouldRecalibrate(performance) {
  if (!performance) return false;

  const trades = Number(performance.trades || 0);
  const sharpe = Number(performance.sharpe || 0);

  if (trades < MIN_TRADES_THRESHOLD) return false;
  if (sharpe < MIN_SHARPE_THRESHOLD) return false;

  return true;
}

function cooldownActive() {
  const now = Date.now();
  return now - lastRecalibrationTimestamp < RECALIBRATION_COOLDOWN_MS;
}

async function recalibrate(performance, regime = "neutral") {
  try {
    if (!shouldRecalibrate(performance)) {
      return {
        success: false,
        reason: "Performance threshold not met"
      };
    }

    if (cooldownActive()) {
      return {
        success: false,
        reason: "Cooldown active"
      };
    }

    let currentWeights = await loadLastWeights();

    if (!currentWeights) {
      currentWeights = getDefaultWeights();
    }

    const newWeights = adjustWeights(currentWeights, performance, regime);

    await saveWeightSnapshot(regime, newWeights, performance);

    lastRecalibrationTimestamp = Date.now();

    return {
      success: true,
      weights: newWeights
    };
  } catch (error) {
    console.error("Recalibration Error:", error.message);

    return {
      success: false,
      reason: "Internal recalibration error",
      fallbackWeights: getDefaultWeights()
    };
  }
}

module.exports = { recalibrate };
