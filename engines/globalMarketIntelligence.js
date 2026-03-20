"use strict";

/*
  Global Market Intelligence Layer

  Canonical role: Composer / Wrapper
  - Delegates breadth calculation to capitalFlowEngine (canonical source)
  - Delegates sector flow detection to capitalFlowEngine (canonical source)
  - Provides global regime classification (risk_on / risk_off / panic / neutral)
    using index trend + breadth + volatility — distinct from marketRegimeEngine's
    per-symbol expansion/bull/neutral/bear/crash vocabulary.
*/

const {
  calculateMarketBreadth,
  detectSectorFlows
} = require("./capitalFlowEngine");

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

/* ===============================
   GLOBAL REGIME
   (risk_on / risk_off / panic / neutral)
   Distinct from marketRegimeEngine which
   classifies per-symbol trend regimes.
================================ */

function detectGlobalRegime(marketData = {}) {
  const indexTrend = safe(marketData.indexTrend);
  const breadth = safe(marketData.marketBreadth);
  const volatility = safe(marketData.marketVolatility);

  if (indexTrend > 0.12 && breadth > 0.6 && volatility < 0.28) {
    return {
      regime: "risk_on",
      label: "Risk-On Expansion"
    };
  }

  if (indexTrend < -0.08 && volatility > 0.4) {
    return {
      regime: "risk_off",
      label: "Risk-Off Stress"
    };
  }

  if (volatility > 0.55) {
    return {
      regime: "panic",
      label: "Panic / Shock Regime"
    };
  }

  return {
    regime: "neutral",
    label: "Neutral Market"
  };
}

/* ===============================
   INTELLIGENCE SUMMARY (composer)
================================ */

function buildGlobalMarketIntelligence({
  marketData = {},
  sectorData = []
} = {}) {

  // Delegate breadth to canonical capitalFlowEngine
  const breadthScore = calculateMarketBreadth(
    marketData.advancers,
    marketData.decliners
  );

  const regime = detectGlobalRegime({
    ...marketData,
    marketBreadth: breadthScore
  });

  // Delegate sector flows to canonical capitalFlowEngine
  const sectorFlows = detectSectorFlows(sectorData);

  return {
    regime: regime.regime,
    regimeLabel: regime.label,
    breadthScore,
    sectorFlows
  };
}

module.exports = {
  buildGlobalMarketIntelligence
};

