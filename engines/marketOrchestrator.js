"use strict";

/*
  Market Orchestrator

  Zentrale Intelligenzschicht.
  Bewertet alle Engine-Signale und erzeugt eine
  konsolidierte Marktentscheidung.
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/* =========================================================
   MARKET RISK MODE
========================================================= */

function detectRiskMode(context = {}) {
  const vix = safe(context.vixTrend);
  const breadth = safe(context.marketBreadth);
  const dollar = safe(context.dollarTrend);

  if (vix > 0.18 && breadth < 0.45) {
    return {
      mode: "risk_off",
      label: "Risk Off Environment",
    };
  }

  if (breadth > 0.60 && dollar < 0) {
    return {
      mode: "risk_on",
      label: "Risk On Expansion",
    };
  }

  return {
    mode: "neutral",
    label: "Neutral Market",
  };
}

/* =========================================================
   DOMINANT NARRATIVE
========================================================= */

function detectDominantNarrative(narratives = [], crossSignals = [], events = []) {
  const all = [...narratives, ...crossSignals, ...events];

  if (!all.length) return null;

  const counter = {};

  for (const n of all) {
    const key = n.type || n.label;
    if (!key) continue;
    counter[key] = (counter[key] || 0) + 1;
  }

  const dominant = Object.entries(counter).sort((a, b) => b[1] - a[1])[0];

  if (!dominant) return null;

  return {
    narrative: dominant[0],
    strength: dominant[1],
  };
}

/* =========================================================
   SECTOR BIAS
========================================================= */

function detectSectorBias(capitalFlows = {}, crossAsset = {}, eventImpact = {}) {
  const leaders = capitalFlows?.sectorFlows?.leaders || [];
  const sectorImpact = crossAsset?.sectorImpact || {};
  const eventSectorImpact = eventImpact?.sectorImpact || {};

  const sectors = new Map();

  for (const leader of leaders) {
    const name = String(leader?.sector || "").toLowerCase();
    if (!name) continue;
    sectors.set(name, safe(leader?.flowScore, 0));
  }

  for (const [sector, score] of Object.entries(sectorImpact)) {
    sectors.set(sector, safe(sectors.get(sector), 0) + safe(score, 0));
  }

  for (const [sector, score] of Object.entries(eventSectorImpact)) {
    sectors.set(sector, safe(sectors.get(sector), 0) + safe(score, 0));
  }

  const ranked = [...sectors.entries()]
    .map(([sector, score]) => ({ sector, score: Number(score.toFixed(3)) }))
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    return {
      bias: "neutral",
      sectors: [],
      leaders: [],
    };
  }

  return {
    bias: "sector_rotation",
    sectors: ranked.slice(0, 5).map((s) => s.sector),
    leaders: ranked.slice(0, 5),
  };
}

/* =========================================================
   SIGNAL CONSISTENCY
========================================================= */

function calculateSignalConsistency({
  trend,
  aiScore,
  resilienceScore,
  discoveries,
  memoryScore,
  metaTrust,
}) {
  let score = 0;
  let total = 0;

  total++;
  if (safe(trend) > 0) score += 1;

  total++;
  if (safe(aiScore) > 70) score += 1;

  total++;
  if (safe(resilienceScore) > 0.5) score += 1;

  total++;
  if ((discoveries || []).length > 0) score += 1;

  total++;
  if (safe(memoryScore) >= 60) score += 1;

  total++;
  if (safe(metaTrust) >= 1) score += 1;

  return clamp(score / total, 0, 1);
}

/* =========================================================
   CROSS ASSET STRENGTH
========================================================= */

function calculateCrossAssetStrength(crossAssetSignals = []) {
  if (!Array.isArray(crossAssetSignals) || !crossAssetSignals.length) return 0;

  const avg =
    crossAssetSignals.reduce((sum, s) => sum + safe(s?.strength, 0.5), 0) /
    crossAssetSignals.length;

  return clamp(avg, 0, 1);
}

/* =========================================================
   CAPITAL FLOW STRENGTH
========================================================= */

function calculateCapitalFlowStrength(capitalFlows = {}) {
  const leaders = capitalFlows?.sectorFlows?.leaders || [];
  const breadth = safe(capitalFlows?.marketBreadth, 0.5);
  const volumePressure = safe(capitalFlows?.volumePressure, 0);

  const leaderStrength =
    leaders.length > 0
      ? leaders.reduce((sum, l) => sum + safe(l?.flowScore, 0), 0) /
        leaders.length
      : 0;

  const normalizedLeaderStrength = clamp(leaderStrength * 5, 0, 1);
  const normalizedVolumePressure = clamp((volumePressure + 1) / 2, 0, 1);

  return clamp(
    normalizedLeaderStrength * 0.45 +
      breadth * 0.35 +
      normalizedVolumePressure * 0.20,
    0,
    1
  );
}

/* =========================================================
   EVENT STRESS
========================================================= */

function calculateEventStress(events = []) {
  if (!Array.isArray(events) || !events.length) return 0;

  let stress = 0;

  for (const e of events) {
    const type = String(e?.type || "").toLowerCase();

    if (type.includes("shock")) stress += 0.35;
    else if (type.includes("tightening")) stress += 0.25;
    else stress += 0.15;
  }

  return clamp(stress, 0, 1);
}

/* =========================================================
   META TRUST
========================================================= */

function calculateMetaTrust(metaLearning = {}) {
  const strongest = metaLearning?.trustProfile?.strongest || [];

  if (!strongest.length) return 1;

  const avg =
    strongest.reduce((sum, e) => sum + safe(e?.weight, 1), 0) /
    strongest.length;

  return clamp(avg, 0.5, 2);
}

/* =========================================================
   ORCHESTRATOR CONFIDENCE
========================================================= */

function calculateOrchestratorConfidence({
  signalConsistency,
  memoryScore,
  metaTrust,
  eventStress,
}) {
  const consistencyPart = safe(signalConsistency) * 45;
  const memoryPart = clamp(safe(memoryScore) / 100, 0, 1) * 30;
  const metaPart = clamp(safe(metaTrust) / 2, 0, 1) * 20;
  const stressPenalty = safe(eventStress) * 15;

  return clamp(
    Math.round(consistencyPart + memoryPart + metaPart - stressPenalty),
    0,
    100
  );
}

/* =========================================================
   OPPORTUNITY STRENGTH
========================================================= */

function calculateOpportunityStrength({
  aiScore,
  conviction,
  signalConsistency,
  memoryScore,
  crossAssetStrength,
  capitalFlowStrength,
  eventStress,
  metaTrust,
}) {
  const a = safe(aiScore);
  const c = safe(conviction);
  const m = clamp(safe(memoryScore) / 100, 0, 1) * 100;
  const x = safe(crossAssetStrength) * 100;
  const f = safe(capitalFlowStrength) * 100;
  const ePenalty = safe(eventStress) * 18;
  const mt = clamp(safe(metaTrust), 0.5, 2);

  let base =
    a * 0.28 +
    c * 0.24 +
    signalConsistency * 12 +
    m * 0.14 +
    x * 0.08 +
    f * 0.10 -
    ePenalty;

  base *= clamp(mt, 0.8, 1.2);

  return clamp(Math.round(base), 0, 100);
}

/* =========================================================
   FINAL TRUST LAYER
========================================================= */

function buildTrustLayer({
  memoryScore,
  metaTrust,
  signalConsistency,
  orchestratorConfidence,
}) {
  return {
    memoryEdge:
      safe(memoryScore) >= 80
        ? "high"
        : safe(memoryScore) >= 60
        ? "medium"
        : "low",
    metaTrust:
      safe(metaTrust) >= 1.2
        ? "high"
        : safe(metaTrust) >= 0.95
        ? "medium"
        : "low",
    signalConsistency:
      safe(signalConsistency) >= 0.75
        ? "high"
        : safe(signalConsistency) >= 0.5
        ? "medium"
        : "low",
    confidenceBand:
      safe(orchestratorConfidence) >= 80
        ? "high"
        : safe(orchestratorConfidence) >= 60
        ? "medium"
        : "low",
  };
}

/* =========================================================
   MAIN ORCHESTRATOR
========================================================= */

function orchestrateMarket({
  trendData,
  aiScore,
  conviction,
  resilienceScore,
  narratives = [],
  discoveries = [],
  crossAssetSignals = [],
  capitalFlows = {},
  macroContext = {},
  eventIntelligence = {},
  marketMemory = {},
  metaLearning = {},
}) {
  const riskMode = detectRiskMode(macroContext);

  const dominantNarrative = detectDominantNarrative(
    narratives,
    crossAssetSignals,
    eventIntelligence?.events || []
  );

  const sectorBias = detectSectorBias(
    capitalFlows,
    { sectorImpact: eventIntelligence?.sectorImpact ? {} : {}, ...{ sectorImpact: {} } },
    eventIntelligence
  );

  const memoryScore = safe(marketMemory?.memoryStats?.memoryScore, 0);
  const metaTrust = calculateMetaTrust(metaLearning);
  const crossAssetStrength = calculateCrossAssetStrength(crossAssetSignals);
  const capitalFlowStrength = calculateCapitalFlowStrength(capitalFlows);
  const eventStress = calculateEventStress(eventIntelligence?.events || []);

  const signalConsistency = calculateSignalConsistency({
    trend: trendData?.trend,
    aiScore,
    resilienceScore,
    discoveries,
    memoryScore,
    metaTrust,
  });

  const opportunityStrength = calculateOpportunityStrength({
    aiScore,
    conviction,
    signalConsistency,
    memoryScore,
    crossAssetStrength,
    capitalFlowStrength,
    eventStress,
    metaTrust,
  });

  const orchestratorConfidence = calculateOrchestratorConfidence({
    signalConsistency,
    memoryScore,
    metaTrust,
    eventStress,
  });

  const trustLayer = buildTrustLayer({
    memoryScore,
    metaTrust,
    signalConsistency,
    orchestratorConfidence,
  });

  return {
    riskMode,
    dominantNarrative,
    sectorBias,
    signalConsistency,
    crossAssetStrength,
    capitalFlowStrength,
    eventStress,
    orchestratorConfidence,
    opportunityStrength,
    trustLayer,
    orchestratorSummary: {
      marketState: riskMode.label,
      narrative: dominantNarrative?.narrative || "none",
      sectors: sectorBias.sectors || [],
      opportunityStrength,
      confidence: orchestratorConfidence,
    },
  };
}

module.exports = {
  orchestrateMarket,
};
