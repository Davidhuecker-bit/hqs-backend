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

const NEWS_DIRECTION_THRESHOLD = 0.12;
// Orchestrator weights the prepared news block for live signal alignment:
// relevance still leads, but confidence and market impact stay slightly stronger
// than in the final conviction layer because this stage judges whether signals agree now.
const NEWS_STRENGTH_RELEVANCE_WEIGHT = 0.28;
const NEWS_STRENGTH_CONFIDENCE_WEIGHT = 0.2;
const NEWS_STRENGTH_MARKET_IMPACT_WEIGHT = 0.26;
const NEWS_STRENGTH_FRESHNESS_WEIGHT = 0.1;
const NEWS_STRENGTH_PERSISTENCE_WEIGHT = 0.16;
const NEWS_PERSISTENCE_MAX = 160;
const NEWS_OPPORTUNITY_SIGNAL_WEIGHT = 12;
const NEWS_CONFIDENCE_WEIGHT = 8;

function normalizeNewsContext(newsContext = {}) {
  if (!newsContext || typeof newsContext !== "object" || Array.isArray(newsContext)) {
    return null;
  }

  return newsContext;
}

function calculateNewsDirectionScore(newsContext = {}) {
  const normalized = normalizeNewsContext(newsContext);
  if (!normalized) return 0;

  const explicitDirectionScore = Number(normalized?.directionScore);
  if (Number.isFinite(explicitDirectionScore)) {
    return clamp(explicitDirectionScore, -1, 1);
  }

  const sentimentScore = safe(normalized?.marketSentiment?.sentimentScore, 0);
  if (sentimentScore !== 0) {
    return clamp(sentimentScore / 100, -1, 1);
  }

  const direction = String(normalized?.direction || "").toLowerCase();
  if (direction === "bullish") return 0.35;
  if (direction === "bearish") return -0.35;
  return 0;
}

function calculateNewsStrength(newsContext = {}) {
  const normalized = normalizeNewsContext(newsContext);
  if (!normalized || safe(normalized?.activeCount, 0) <= 0) return 0;

  const relevance = clamp(safe(normalized?.weightedRelevance, 0), 0, 100) / 100;
  const confidence = clamp(safe(normalized?.weightedConfidence, 0), 0, 100) / 100;
  const marketImpact = clamp(safe(normalized?.weightedMarketImpact, 0), 0, 100) / 100;
  const freshness = clamp(safe(normalized?.weightedFreshness, 0), 0, 100) / 100;
  const persistence = clamp(safe(normalized?.weightedPersistence, 0) / NEWS_PERSISTENCE_MAX, 0, 1);

  return clamp(
    relevance * NEWS_STRENGTH_RELEVANCE_WEIGHT +
      confidence * NEWS_STRENGTH_CONFIDENCE_WEIGHT +
      marketImpact * NEWS_STRENGTH_MARKET_IMPACT_WEIGHT +
      freshness * NEWS_STRENGTH_FRESHNESS_WEIGHT +
      persistence * NEWS_STRENGTH_PERSISTENCE_WEIGHT,
    0,
    1
  );
}

function buildNewsPulse(newsContext = {}) {
  const normalized = normalizeNewsContext(newsContext);
  if (!normalized || safe(normalized?.activeCount, 0) <= 0) {
    return {
      activeCount: 0,
      direction: "neutral",
      directionScore: 0,
      strength: 0,
      confidence: 0,
      dominantEventType: null,
    };
  }

  const directionScore = calculateNewsDirectionScore(normalized);
  const strength = calculateNewsStrength(normalized);

  return {
    activeCount: safe(normalized?.activeCount, 0),
    direction:
      directionScore >= NEWS_DIRECTION_THRESHOLD
        ? "bullish"
        : directionScore <= -NEWS_DIRECTION_THRESHOLD
          ? "bearish"
          : "neutral",
    directionScore: Number(directionScore.toFixed(2)),
    strength: Number((strength * 100).toFixed(2)),
    confidence: clamp(safe(normalized?.weightedConfidence, 0), 0, 100),
    dominantEventType: normalized?.dominantEventType || null,
  };
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
  newsStrength,
  newsDirectionScore,
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

  if (safe(newsStrength) > 0) {
    total++;
    if (
      (safe(newsDirectionScore) >= 0 && safe(aiScore) >= 55) ||
      (safe(newsDirectionScore) < 0 && safe(aiScore) <= 55)
    ) {
      score += 1;
    }
  }

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
  newsStrength,
}) {
  const consistencyPart = safe(signalConsistency) * 45;
  const memoryPart = clamp(safe(memoryScore) / 100, 0, 1) * 30;
  const metaPart = clamp(safe(metaTrust) / 2, 0, 1) * 20;
  const newsPart = clamp(safe(newsStrength), 0, 1) * NEWS_CONFIDENCE_WEIGHT;
  const stressPenalty = safe(eventStress) * 15;

  return clamp(
    Math.round(consistencyPart + memoryPart + metaPart + newsPart - stressPenalty),
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
  newsStrength,
  newsDirectionScore,
}) {
  const a = safe(aiScore);
  const c = safe(conviction);
  const m = clamp(safe(memoryScore) / 100, 0, 1) * 100;
  const x = safe(crossAssetStrength) * 100;
  const f = safe(capitalFlowStrength) * 100;
  const ePenalty = safe(eventStress) * 18;
  const mt = clamp(safe(metaTrust), 0.5, 2);
  const newsContribution =
    clamp(safe(newsStrength), 0, 1) *
    clamp(safe(newsDirectionScore), -1, 1) *
    NEWS_OPPORTUNITY_SIGNAL_WEIGHT;

  let base =
    a * 0.28 +
    c * 0.24 +
    signalConsistency * 12 +
    m * 0.14 +
    x * 0.08 +
    f * 0.10 +
    newsContribution -
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
  newsContext = null,
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
  const newsPulse = buildNewsPulse(newsContext);

  const signalConsistency = calculateSignalConsistency({
    trend: trendData?.trend,
    aiScore,
    resilienceScore,
    discoveries,
    memoryScore,
    metaTrust,
    newsStrength: safe(newsPulse?.strength, 0) / 100,
    newsDirectionScore: newsPulse?.directionScore,
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
    newsStrength: safe(newsPulse?.strength, 0) / 100,
    newsDirectionScore: newsPulse?.directionScore,
  });

  const orchestratorConfidence = calculateOrchestratorConfidence({
    signalConsistency,
    memoryScore,
    metaTrust,
    eventStress,
    newsStrength: safe(newsPulse?.strength, 0) / 100,
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
    newsPulse,
    orchestratorConfidence,
    opportunityStrength,
    trustLayer,
    orchestratorSummary: {
      marketState: riskMode.label,
      narrative: dominantNarrative?.narrative || "none",
      sectors: sectorBias.sectors || [],
      newsDirection: newsPulse?.direction || "neutral",
      opportunityStrength,
      confidence: orchestratorConfidence,
    },
  };
}

module.exports = {
  orchestrateMarket,
};
