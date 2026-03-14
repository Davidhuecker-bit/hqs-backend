"use strict";

const {
  calculateTrendScore,
  determineTrendLevel,
} = require("./trendingStocks.service");

const SCORE_MIN = 0;
const SCORE_MAX = 100;
const EARLY_INTEREST_BUZZ_THRESHOLD = 70;
const EARLY_INTEREST_MOMENTUM_THRESHOLD = 10;
const POTENTIAL_BREAKOUT_BUZZ_THRESHOLD = 85;
const POTENTIAL_BREAKOUT_MOMENTUM_THRESHOLD = 5;
const BREAKOUT_STRENGTH_BONUS = 5;

function normalizeItems(items) {
  if (Array.isArray(items)) return items;
  if (items && typeof items === "object") return [items];
  return [];
}

function normalizeInputItem(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  return input;
}

function normalizeSymbol(value) {
  const symbol = String(value || "").trim().toUpperCase();
  return symbol || null;
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundNumber(value, digits = 2) {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function normalizeScore(value, fallback = 0) {
  return roundNumber(clamp(safeNumber(value, fallback), SCORE_MIN, SCORE_MAX));
}

function normalizeTrendLevel(value) {
  const trendLevel = String(value || "").trim().toLowerCase();
  return trendLevel || null;
}

function buildNormalizedItem(input = {}) {
  const normalizedInput = normalizeInputItem(input);
  if (!normalizedInput) return null;

  const symbol = normalizeSymbol(normalizedInput.symbol);
  if (!symbol) return null;

  const buzzScore = normalizeScore(normalizedInput.buzzScore, 0);
  const priceMomentum = normalizeScore(normalizedInput.priceMomentum, 0);
  const volumeSpike = normalizeScore(normalizedInput.volumeSpike, 0);
  const fallbackTrendScore = calculateTrendScore({
    buzzScore,
    priceMomentum,
    volumeSpike,
  });
  const trendScore = normalizeScore(normalizedInput.trendScore, fallbackTrendScore);
  const trendLevel =
    normalizeTrendLevel(normalizedInput.trendLevel) ||
    determineTrendLevel(trendScore);

  return {
    symbol,
    buzzScore,
    priceMomentum,
    trendScore,
    trendLevel,
  };
}

function determineSignalType(input = {}) {
  const buzzScore = normalizeScore(input.buzzScore, 0);
  const priceMomentum = normalizeScore(input.priceMomentum, 0);

  if (
    buzzScore > POTENTIAL_BREAKOUT_BUZZ_THRESHOLD &&
    priceMomentum < POTENTIAL_BREAKOUT_MOMENTUM_THRESHOLD
  ) {
    return "potential_breakout";
  }

  if (
    buzzScore > EARLY_INTEREST_BUZZ_THRESHOLD &&
    priceMomentum < EARLY_INTEREST_MOMENTUM_THRESHOLD
  ) {
    return "early_interest";
  }

  return null;
}

function calculateStrength(signal, input = {}) {
  const baseStrength = normalizeScore(input.buzzScore, 0);
  if (signal === "potential_breakout") {
    return normalizeScore(baseStrength + BREAKOUT_STRENGTH_BONUS, baseStrength);
  }

  return baseStrength;
}

function buildEarlySignals(items = []) {
  return normalizeItems(items).reduce((signals, item) => {
    const normalizedItem = buildNormalizedItem(item);
    if (!normalizedItem) return signals;

    const signal = determineSignalType(normalizedItem);
    if (!signal) return signals;

    signals.push({
      symbol: normalizedItem.symbol,
      signal,
      strength: calculateStrength(signal, normalizedItem),
      buzzScore: normalizedItem.buzzScore,
      priceMomentum: normalizedItem.priceMomentum,
      trendScore: normalizedItem.trendScore,
      trendLevel: normalizedItem.trendLevel,
    });

    return signals;
  }, []);
}

module.exports = {
  buildEarlySignals,
};
