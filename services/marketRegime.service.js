"use strict";

async function detectMarketRegime(marketData = {}) {
  const change = Number(marketData?.changesPercentage || 0);

  if (change > 2) return "expansion";
  if (change > 0.5) return "bull";
  if (change < -2) return "crash";
  if (change < -0.5) return "bear";

  return "neutral";
}

module.exports = { detectMarketRegime };
