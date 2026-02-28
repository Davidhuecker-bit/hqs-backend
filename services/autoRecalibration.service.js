"use strict";

const { adjustWeights, getDefaultWeights } = require("./autoFactor.service");
const { saveWeightSnapshot, loadLastWeights } = require("./weightHistory.repository");

async function recalibrate(performance, regime) {
  let currentWeights = await loadLastWeights();

  if (!currentWeights) {
    currentWeights = getDefaultWeights();
  }

  const newWeights = adjustWeights(currentWeights, performance, regime);

  await saveWeightSnapshot(regime, newWeights, performance);

  return newWeights;
}

module.exports = { recalibrate };
