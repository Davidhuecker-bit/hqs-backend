"use strict";

/*
  Meta Learning Engine

  Lernt, welchen Engines in welchem Marktumfeld
  wie stark vertraut werden sollte.

  Final compatible version:
  - gleiche Exporte
  - gleiche Rückgabeform
  - gleicher persist/preview-Mechanismus
  - verbessert um:
    - robustere Konfiguration
    - riskMode-abhängige Lernrate
    - glattere Outcome-Normalisierung
    - nur Engines mit echter Contribution werden angepasst
    - konfigurierbare Grenzen / History-Limit
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, safe(v, min)));
}

function envNum(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeKeyPart(value, fallback = "none") {
  const normalized = String(value ?? fallback)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");
  return normalized || fallback;
}

/* =========================================================
   DEFAULT ENGINE WEIGHTS
========================================================= */

const DEFAULT_ENGINE_WEIGHTS = {
  trendEngine: envNum("META_WEIGHT_TREND", 1),
  discoveryEngine: envNum("META_WEIGHT_DISCOVERY", 1),
  capitalFlowEngine: envNum("META_WEIGHT_CAPITAL_FLOW", 1),
  eventIntelligenceEngine: envNum("META_WEIGHT_EVENT_INTEL", 1),
  marketMemoryEngine: envNum("META_WEIGHT_MARKET_MEMORY", 1),
  narrativeEngine: envNum("META_WEIGHT_NARRATIVE", 1),
  strategyEngine: envNum("META_WEIGHT_STRATEGY", 1),
  crossAssetEngine: envNum("META_WEIGHT_CROSS_ASSET", 1),
};

const META_WEIGHT_MIN = envNum("META_WEIGHT_MIN", 0.2);
const META_WEIGHT_MAX = envNum("META_WEIGHT_MAX", 3);
const META_HISTORY_LIMIT = Math.max(
  10,
  Math.floor(envNum("META_HISTORY_LIMIT", 500))
);
const META_MIN_CONTRIBUTION = envNum("META_MIN_CONTRIBUTION", 0.1);

/* =========================================================
   LEARNING RATE LOGIC
========================================================= */

function getLearningRate(riskMode = "neutral") {
  const normalized = normalizeKeyPart(riskMode, "neutral");

  const rates = {
    risk_off: envNum("META_LR_RISK_OFF", 0.08),
    neutral: envNum("META_LR_NEUTRAL", 0.05),
    risk_on: envNum("META_LR_RISK_ON", 0.06),
  };

  return rates[normalized] || rates.neutral;
}

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
    `regime:${normalizeKeyPart(regime, "neutral")}`,
    `risk:${normalizeKeyPart(riskMode, "neutral")}`,
    `strategy:${normalizeKeyPart(strategy, "balanced")}`,
    `narrative:${normalizeKeyPart(dominantNarrative, "none")}`,
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

  const neutralBand = envNum("META_OUTCOME_NEUTRAL_BAND", 0.01);
  const scale = envNum("META_OUTCOME_SCALE", 5);
  const minScore = envNum("META_OUTCOME_MIN", -1.5);
  const maxScore = envNum("META_OUTCOME_MAX", 1.5);

  if (Math.abs(r) < neutralBand) return 0;

  return clamp(r * scale, minScore, maxScore);
}

/* =========================================================
   ADJUST ENGINE WEIGHTS
========================================================= */

function adjustEngineWeights(
  currentWeights = {},
  contributions = {},
  outcomeScore = 0,
  riskMode = "neutral"
) {
  const updated = { ...currentWeights };
  const learningRate = getLearningRate(riskMode);

  for (const engine of Object.keys(DEFAULT_ENGINE_WEIGHTS)) {
    const contribution = safe(contributions[engine], 0);
    const current = safe(
      updated[engine],
      DEFAULT_ENGINE_WEIGHTS[engine] ?? 1
    );

    // Nur Engines anpassen, die wirklich etwas beigetragen haben
    if (contribution <= META_MIN_CONTRIBUTION) {
      updated[engine] = clamp(current, META_WEIGHT_MIN, META_WEIGHT_MAX);
      continue;
    }

    const delta = contribution * safe(outcomeScore) * learningRate;
    updated[engine] = clamp(current + delta, META_WEIGHT_MIN, META_WEIGHT_MAX);
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
    outcomeScore,
    context?.riskMode
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
      history: [...currentContext.history, historyEntry].slice(
        -META_HISTORY_LIMIT
      ),
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
