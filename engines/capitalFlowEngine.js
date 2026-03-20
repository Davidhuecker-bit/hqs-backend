"use strict";

/*
  Capital Flow Intelligence Engine

  Erkennt Kapitalflüsse im Markt:
  - Sektor Rotation
  - ETF Flows
  - Volume Pressure
  - Market Breadth
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/* =========================================================
   SECTOR FLOW
========================================================= */

function detectSectorFlows(sectorData = []) {

  if (!Array.isArray(sectorData) || !sectorData.length) {
    return { leaders: [], laggards: [] };
  }

  const sorted = [...sectorData].sort(
    (a, b) => safe(b.performance) - safe(a.performance)
  );

  const leaders = sorted.slice(0, 3).map(s => ({
    sector: s.sector,
    flowScore: safe(s.performance)
  }));

  const laggards = sorted.slice(-3).map(s => ({
    sector: s.sector,
    flowScore: safe(s.performance)
  }));

  return { leaders, laggards };

}

/* =========================================================
   ETF FLOW ANALYSIS
========================================================= */

function analyzeEtfFlows(etfFlows = []) {

  if (!Array.isArray(etfFlows) || !etfFlows.length) {
    return [];
  }

  const strongInflows = etfFlows
    .filter(e => safe(e.flow) > 0.05)
    .map(e => ({
      etf: e.symbol,
      flow: safe(e.flow)
    }));

  return strongInflows;

}

/* =========================================================
   MARKET BREADTH
========================================================= */

function calculateMarketBreadth(advancers, decliners) {

  const a = safe(advancers);
  const d = safe(decliners);

  const total = a + d;

  if (!total) return 0.5;

  return clamp(a / total, 0, 1);

}

/* =========================================================
   VOLUME PRESSURE
========================================================= */

function detectVolumePressure(data) {

  const volume = safe(data.volume);
  const avgVolume = safe(data.avgVolume);

  if (!avgVolume) return 0;

  const ratio = volume / avgVolume;

  if (ratio > 1.5) return 1;
  if (ratio > 1.2) return 0.6;
  if (ratio > 1.0) return 0.3;

  return -0.3;

}

/* =========================================================
   MAIN CAPITAL FLOW ANALYSIS
========================================================= */

function analyzeCapitalFlows({

  sectorData = [],
  etfFlows = [],
  advancers = 0,
  decliners = 0,
  volumeData = {}

} = {}) {

  const sectorFlows = detectSectorFlows(sectorData);

  const etfFlowSignals = analyzeEtfFlows(etfFlows);

  const breadth = calculateMarketBreadth(
    advancers,
    decliners
  );

  const volumePressure = detectVolumePressure(volumeData);

  return {

    sectorFlows,

    etfFlowSignals,

    marketBreadth: breadth,

    volumePressure,

    flowSummary: {

      bullish:
        breadth > 0.6 &&
        volumePressure > 0,

      bearish:
        breadth < 0.4 &&
        volumePressure < 0

    }

  };

}

module.exports = {
  analyzeCapitalFlows,
  calculateMarketBreadth,
  detectSectorFlows
};
