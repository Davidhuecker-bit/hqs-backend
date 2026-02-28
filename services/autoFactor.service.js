// services/autoFactor.service.js
// HQS Adaptive Weight Optimizer

function adjustWeights(weights, performance) {
  if (!weights || !performance) return weights;

  const newWeights = { ...weights };

  if (performance.winRate > 60) {
    newWeights.momentum += 0.02;
  }

  if (performance.averageReturn > 1) {
    newWeights.quality += 0.02;
  }

  if (performance.winRate < 45) {
    newWeights.momentum -= 0.02;
  }

  // Normalisieren
  const sum =
    newWeights.momentum +
    newWeights.quality +
    newWeights.stability +
    newWeights.relative;

  Object.keys(newWeights).forEach(
    key => newWeights[key] = newWeights[key] / sum
  );

  return newWeights;
}

module.exports = { adjustWeights };
