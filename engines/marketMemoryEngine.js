"use strict";

/*
  Market Memory Engine

  Speichert und bewertet wiederkehrende Markt-Setups.
  Ziel:
  - historische Muster erkennen
  - Erfolgsquote berechnen
  - durchschnittliche Performance messen
  - Memory Score erzeugen

  Final compatible version:
  - gleiche Exporte
  - gleiche Hauptstruktur
  - verbesserte Statistik mit leichter Zeitgewichtung
  - robustere Konsistenzmessung
  - konfigurierbare Grenzen / History-Limit
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
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

const MEMORY_HISTORY_LIMIT = Math.max(
  20,
  Math.floor(envNum("MEMORY_HISTORY_LIMIT", 500))
);

const MEMORY_FEATURE_THRESHOLD = envNum("MEMORY_FEATURE_THRESHOLD", 0.6);
const MEMORY_NEUTRAL_STD_FLOOR = envNum("MEMORY_STD_FLOOR", 0.1);

/* =========================================================
   SETUP SIGNATURE
========================================================= */

function buildSetupSignature({
  regime = "neutral",
  strategy = "balanced",
  discoveries = [],
  narratives = [],
  features = {},
  crossSignals = [],
} = {}) {
  const featureKeys = Object.keys(features || {})
    .filter((k) => safe(features[k]) > MEMORY_FEATURE_THRESHOLD)
    .sort();

  const discoveryKeys = (discoveries || [])
    .map((d) => d?.type)
    .filter(Boolean)
    .map((v) => normalizeKeyPart(v))
    .sort();

  const narrativeKeys = (narratives || [])
    .map((n) => n?.type || n?.label)
    .filter(Boolean)
    .map((v) => normalizeKeyPart(v))
    .sort();

  const crossKeys = (crossSignals || [])
    .map((s) => s?.type || s?.label)
    .filter(Boolean)
    .map((v) => normalizeKeyPart(v))
    .sort();

  return [
    `regime:${normalizeKeyPart(regime, "neutral")}`,
    `strategy:${normalizeKeyPart(strategy, "balanced")}`,
    `features:${featureKeys.join("+") || "none"}`,
    `discoveries:${discoveryKeys.join("+") || "none"}`,
    `narratives:${narrativeKeys.join("+") || "none"}`,
    `cross:${crossKeys.join("+") || "none"}`,
  ].join("|");
}

/* =========================================================
   MEMORY STATS
========================================================= */

function calculateWeightedStats(history = []) {
  if (!Array.isArray(history) || !history.length) {
    return { successRate: 0, averageReturn: 0 };
  }

  let totalWeight = 0;
  let weightedWins = 0;
  let weightedReturn = 0;

  history.forEach((h, index) => {
    // leichte lineare Gewichtung: neuere Einträge zählen etwas mehr
    const weight = (index + 1) / history.length;

    totalWeight += weight;

    if (safe(h?.actualReturn) > 0) {
      weightedWins += weight;
    }

    weightedReturn += safe(h?.actualReturn) * weight;
  });

  return {
    successRate: totalWeight > 0 ? weightedWins / totalWeight : 0,
    averageReturn: totalWeight > 0 ? weightedReturn / totalWeight : 0,
  };
}

function calculateSuccessRate(history = []) {
  return calculateWeightedStats(history).successRate;
}

function calculateAverageReturn(history = []) {
  return calculateWeightedStats(history).averageReturn;
}

function calculateAverageConfidence(history = []) {
  if (!Array.isArray(history) || !history.length) return 0;

  const avg =
    history.reduce((sum, h) => sum + safe(h?.confidence), 0) / history.length;

  return clamp(avg, 0, 1);
}

function calculateConsistency(history = []) {
  if (!Array.isArray(history) || history.length < 3) return 0.5;

  const returns = history.map((h) => safe(h?.actualReturn));
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;

  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) /
    returns.length;

  const std = Math.sqrt(Math.max(variance, 0));

  // sharpe-like consistency:
  // je kleiner die Streuung relativ zum Mean, desto besser
  return clamp(1 - std / (Math.abs(mean) + MEMORY_NEUTRAL_STD_FLOOR), 0, 1);
}

/* =========================================================
   MEMORY SCORE
========================================================= */

function calculateMemoryScore({
  successRate = 0,
  averageReturn = 0,
  averageConfidence = 0,
  consistency = 0.5,
  occurrences = 0,
} = {}) {
  const success = safe(successRate) * 50;
  const avgReturnScore = clamp(safe(averageReturn) * 100, -10, 20);
  const conf = safe(averageConfidence) * 15;
  const cons = safe(consistency) * 20;
  const freq = clamp(safe(occurrences) * 0.5, 0, 10);

  return clamp(
    Math.round(success + avgReturnScore + conf + cons + freq),
    0,
    100
  );
}

/* =========================================================
   MEMORY DECISION
========================================================= */

function classifyMemoryEdge(memoryScore) {
  const s = safe(memoryScore);

  if (s >= 85) return "very_strong";
  if (s >= 70) return "strong";
  if (s >= 55) return "moderate";
  if (s >= 40) return "weak";

  return "unproven";
}

/* =========================================================
   UPDATE MEMORY STORE
========================================================= */

function updateMemoryStore(memoryStore = {}, entry = {}) {
  const signature = entry.signature;

  if (!signature) return memoryStore;

  const nextStore = { ...memoryStore };

  if (!nextStore[signature]) {
    nextStore[signature] = [];
  }

  nextStore[signature] = [...nextStore[signature], entry].slice(
    -MEMORY_HISTORY_LIMIT
  );

  return nextStore;
}

/* =========================================================
   ANALYZE MEMORY
========================================================= */

function analyzeSetupMemory(memoryStore = {}, signature) {
  const history = Array.isArray(memoryStore?.[signature])
    ? memoryStore[signature]
    : [];

  const successRate = calculateSuccessRate(history);
  const averageReturn = calculateAverageReturn(history);
  const averageConfidence = calculateAverageConfidence(history);
  const consistency = calculateConsistency(history);
  const occurrences = history.length;

  const memoryScore = calculateMemoryScore({
    successRate,
    averageReturn,
    averageConfidence,
    consistency,
    occurrences,
  });

  return {
    signature,
    occurrences,
    successRate,
    averageReturn,
    averageConfidence,
    consistency,
    memoryScore,
    memoryEdge: classifyMemoryEdge(memoryScore),
  };
}

/* =========================================================
   CREATE MEMORY ENTRY
========================================================= */

function createMemoryEntry({
  symbol,
  signature,
  prediction = 0,
  actualReturn = 0,
  confidence = 0,
  regime = "neutral",
  strategy = "balanced",
} = {}) {
  return {
    symbol: symbol || null,
    signature,
    prediction: safe(prediction),
    actualReturn: safe(actualReturn),
    confidence: clamp(safe(confidence), 0, 1),
    regime,
    strategy,
    timestamp: new Date().toISOString(),
  };
}

/* =========================================================
   MAIN ENGINE
========================================================= */

function evaluateMarketMemory({
  memoryStore = {},
  symbol,
  regime,
  strategy,
  discoveries = [],
  narratives = [],
  features = {},
  crossSignals = [],
  prediction = 0,
  actualReturn = 0,
  confidence = 0,
  persist = false,
} = {}) {
  const signature = buildSetupSignature({
    regime,
    strategy,
    discoveries,
    narratives,
    features,
    crossSignals,
  });

  const entry = createMemoryEntry({
    symbol,
    signature,
    prediction,
    actualReturn,
    confidence,
    regime,
    strategy,
  });

  const updatedStore = persist
    ? updateMemoryStore(memoryStore, entry)
    : memoryStore;

  const memoryStats = analyzeSetupMemory(updatedStore, signature);

  return {
    signature,
    entry,
    memoryStats,
    updatedStore,
  };
}

module.exports = {
  buildSetupSignature,
  updateMemoryStore,
  analyzeSetupMemory,
  createMemoryEntry,
  evaluateMarketMemory,
};
