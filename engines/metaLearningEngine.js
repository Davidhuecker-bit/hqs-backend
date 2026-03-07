"use strict";

/*
  Meta Learning Engine

  Lernt, welchen Engines in welchem Marktumfeld
  wie stark vertraut werden sollte.
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/* =========================================================
   DEFAULT ENGINE WEIGHTS
========================================================= */

const DEFAULT_ENGINE_WEIGHTS = {
  trendEngine: 1,
  discoveryEngine: 1,
  capitalFlowEngine: 1,
  eventIntelligenceEngine: 1,
  marketMemoryEngine: 1,
  narrativeEngine: 1,
  strategyEngine: 1,
  crossAssetEngine: 1,
};

/* =========================================================
   CONTEXT KEY
========================================================= */

function buildContextKey({
  regime = "neutral",
  riskMode = "neutral",
  strategy = "balanced",
  dominantNarrative = "none",
} = {}) {
  return [
    `regime:${String(regime).toLowerCase()}`,
    `risk:${String(riskMode).toLowerCase()}`,
    `strategy:${String(strategy).toLowerCase()}`,
    `narrative:${String(dominantNarrative).toLowerCase()}`,
  ].join("|");
}

/* =========================================================
   INIT CONTEXT
========================================================= */

function ensureContextStore(metaStore = {}, contextKey) {
  const nextStore = { ...metaStore };

  if (!nextStore[contextKey]) {
    nextStore[contextKey] = {
      engineWeights: { ...DEFAULT_ENGINE_WEIGHTS },
      history: [],
    };
  }

  return nextStore;
}

/* =========================================================
   ENGINE CONTRIBUTION SCORE
========================================================= */

function calculateEngineContributions({
  trendScore = 0,
  discoveryCount = 0,
  capitalFlowStrength = 0,
  eventCount = 0,
  memoryScore = 0,
  narrativeCount = 0,
  strategyScore = 0,
  crossAssetCount = 0,
} = {}) {
  return {
    trendEngine: clamp(safe(trendScore), 0, 1),
    discoveryEngine: clamp(safe(discoveryCount) / 5, 0, 1),
    capitalFlowEngine: clamp(safe(capitalFlowStrength), 0, 1),
    eventIntelligenceEngine: clamp(safe(eventCount) / 5, 0, 1),
    marketMemoryEngine: clamp(safe(memoryScore) / 100, 0, 1),
    narrativeEngine: clamp(safe(narrativeCount) / 5, 0, 1),
    strategyEngine: clamp(safe(strategyScore) / 100, 0, 1),
    crossAssetEngine: clamp(safe(crossAssetCount) / 5, 0, 1),
  };
}

/* =========================================================
   PERFORMANCE SCORE
========================================================= */

function normalizeOutcome(actualReturn = 0) {
  const r = safe(actualReturn);

  if (r > 0.20) return 1;
  if (r > 0.10) return 0.75;
  if (r > 0.03) return 0.4;
  if (r > -0.03) return 0;
  if (r > -0.10) return -0.5;

  return -1;
}

/* =========================================================
   ADJUST ENGINE WEIGHTS
========================================================= */

function adjustEngineWeights(currentWeights = {}, contributions = {}, outcomeScore = 0) {
  const updated = { ...currentWeights };

  for (const engine of Object.keys(contributions)) {
    const contribution = safe(contributions[engine], 0);
    const current = safe(updated[engine], 1);

    const delta = contribution * safe(outcomeScore) * 0.05;

    updated[engine] = clamp(current + delta, 0.2, 3);
  }

  return updated;
}

/* =========================================================
   BUILD TRUST PROFILE
========================================================= */

function buildTrustProfile(engineWeights = {}) {
  const entries = Object.entries(engineWeights)
    .map(([engine, weight]) => ({
      engine,
      weight: Number(safe(weight, 1).toFixed(3)),
    }))
    .sort((a, b) => b.weight - a.weight);

  return {
    strongest: entries.slice(0, 3),
    weakest: entries.slice(-3),
    all: entries,
  };
}

/* =========================================================
   UPDATE META STORE
========================================================= */

function updateMetaLearningStore({
  metaStore = {},
  context = {},
  actualReturn = 0,
  contributions = {},
  symbol = null,
} = {}) {
  const contextKey = buildContextKey(context);
  const preparedStore = ensureContextStore(metaStore, contextKey);

  const currentContext = preparedStore[contextKey];
  const outcomeScore = normalizeOutcome(actualReturn);

  const newWeights = adjustEngineWeights(
    currentContext.engineWeights,
    contributions,
    outcomeScore
  );

  const historyEntry = {
    symbol,
    actualReturn: safe(actualReturn),
    outcomeScore,
    contributions,
    timestamp: new Date().toISOString(),
  };

  const updatedStore = {
    ...preparedStore,
    [contextKey]: {
      engineWeights: newWeights,
      history: [...currentContext.history, historyEntry].slice(-500),
    },
  };

  return {
    contextKey,
    updatedStore,
    engineWeights: newWeights,
    trustProfile: buildTrustProfile(newWeights),
    outcomeScore,
  };
}

/* =========================================================
   GET CONTEXT WEIGHTS
========================================================= */

function getMetaWeights(metaStore = {}, context = {}) {
  const contextKey = buildContextKey(context);

  if (!metaStore[contextKey]) {
    return {
      contextKey,
      engineWeights: { ...DEFAULT_ENGINE_WEIGHTS },
      trustProfile: buildTrustProfile(DEFAULT_ENGINE_WEIGHTS),
    };
  }

  const engineWeights = metaStore[contextKey].engineWeights || {
    ...DEFAULT_ENGINE_WEIGHTS,
  };

  return {
    contextKey,
    engineWeights,
    trustProfile: buildTrustProfile(engineWeights),
  };
}

/* =========================================================
   MAIN ENGINE
========================================================= */

function evaluateMetaLearning({
  metaStore = {},
  context = {},
  signalMetrics = {},
  actualReturn = 0,
  symbol = null,
  persist = false,
} = {}) {
  const contributions = calculateEngineContributions(signalMetrics);

  if (!persist) {
    const preview = getMetaWeights(metaStore, context);

    return {
      contextKey: preview.contextKey,
      contributions,
      engineWeights: preview.engineWeights,
      trustProfile: preview.trustProfile,
      outcomeScore: normalizeOutcome(actualReturn),
      updatedStore: metaStore,
    };
  }

  return updateMetaLearningStore({
    metaStore,
    context,
    actualReturn,
    contributions,
    symbol,
  });
}

module.exports = {
  buildContextKey,
  calculateEngineContributions,
  getMetaWeights,
  evaluateMetaLearning,
};
