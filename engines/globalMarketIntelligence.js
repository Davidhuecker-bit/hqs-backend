"use strict";

/*
  Global Market Intelligence Layer
  Detects market-wide state, sector leadership, and capital flow bias
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/* ===============================
   MARKET REGIME
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
   SECTOR LEADERSHIP
================================ */

function detectSectorLeadership(sectorData = []) {
  if (!Array.isArray(sectorData) || !sectorData.length) {
    return {
      leaders: [],
      laggards: []
    };
  }

  const sorted = [...sectorData].sort(
    (a, b) => safe(b.trendStrength) - safe(a.trendStrength)
  );

  const leaders = sorted.slice(0, 3).map((s) => ({
    sector: s.sector,
    trendStrength: safe(s.trendStrength),
    relativePerformance: safe(s.relativePerformance)
  }));

  const laggards = sorted.slice(-3).map((s) => ({
    sector: s.sector,
    trendStrength: safe(s.trendStrength),
    relativePerformance: safe(s.relativePerformance)
  }));

  return {
    leaders,
    laggards
  };
}

/* ===============================
   CAPITAL FLOW BIAS
================================ */

function detectCapitalFlowBias(marketData = {}) {
  const growthFlow = safe(marketData.growthFlow);
  const defensiveFlow = safe(marketData.defensiveFlow);
  const energyFlow = safe(marketData.energyFlow);
  const techFlow = safe(marketData.techFlow);

  const flows = [
    { type: "growth", value: growthFlow },
    { type: "defensive", value: defensiveFlow },
    { type: "energy", value: energyFlow },
    { type: "technology", value: techFlow }
  ].sort((a, b) => b.value - a.value);

  const strongest = flows[0];

  return {
    bias: strongest?.type || "neutral",
    strength: clamp(safe(strongest?.value), 0, 1)
  };
}

/* ===============================
   MARKET BREADTH SCORE
================================ */

function calculateBreadthScore(advancers, decliners) {
  const a = safe(advancers);
  const d = safe(decliners);

  const total = a + d;
  if (!total) return 0.5;

  return clamp(a / total, 0, 1);
}

/* ===============================
   INTELLIGENCE SUMMARY
================================ */

function buildGlobalMarketIntelligence({
  marketData = {},
  sectorData = []
} = {}) {
  const breadthScore = calculateBreadthScore(
    marketData.advancers,
    marketData.decliners
  );

  const regime = detectGlobalRegime({
    ...marketData,
    marketBreadth: breadthScore
  });

  const sectorLeadership = detectSectorLeadership(sectorData);

  const capitalFlow = detectCapitalFlowBias(marketData);

  return {
    regime: regime.regime,
    regimeLabel: regime.label,
    breadthScore,
    sectorLeadership,
    capitalFlow
  };
}

module.exports = {
  buildGlobalMarketIntelligence
};
