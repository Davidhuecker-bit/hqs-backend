"use strict";

const SCORE_MIN = 0;
const SCORE_MAX = 100;
const BUZZ_WEIGHT = 0.5;
const MOMENTUM_WEIGHT = 0.3;
const VOLUME_WEIGHT = 0.2;
const EXPLODING_THRESHOLD = 85;
const VERY_HOT_THRESHOLD = 70;
const HOT_THRESHOLD = 50;
const MOMENTUM_BASELINE = 50;
const MOMENTUM_MULTIPLIER = 5;
const VOLUME_BASELINE_LOG = 5;
const VOLUME_WEIGHT_STEP = 25;

function normalizeInputObject(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  return input;
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined) return null;

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isNil(value) {
  return value === null || value === undefined;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundNumber(value, digits = 2) {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function normalizeSymbol(value) {
  const symbol = String(value || "").trim().toUpperCase();
  return symbol || null;
}

function normalizeScore(value) {
  return roundNumber(clamp(safeNumber(value, 0), SCORE_MIN, SCORE_MAX));
}

function calculatePriceMomentum(value) {
  const changePercent = toFiniteNumberOrNull(value);
  if (changePercent === null) return 0;

  return roundNumber(
    clamp(
      changePercent * MOMENTUM_MULTIPLIER + MOMENTUM_BASELINE,
      SCORE_MIN,
      SCORE_MAX
    )
  );
}

function calculateVolumeSpike(value) {
  const volume = safeNumber(value, 0);
  if (volume <= 0) return 0;

  const logVolume = Math.log10(volume);
  const spikeScore = (logVolume - VOLUME_BASELINE_LOG) * VOLUME_WEIGHT_STEP;
  return roundNumber(clamp(spikeScore, SCORE_MIN, SCORE_MAX));
}

function buildTrendComponents(input = {}) {
  const normalizedInput = normalizeInputObject(input);
  if (!normalizedInput) {
    return {
      buzzScore: 0,
      priceMomentum: 0,
      volumeSpike: 0,
    };
  }

  return {
    buzzScore: normalizeScore(normalizedInput.buzzScore),
    priceMomentum: isNil(normalizedInput.priceMomentum)
      ? calculatePriceMomentum(normalizedInput.changePercent)
      : normalizeScore(normalizedInput.priceMomentum),
    volumeSpike: isNil(normalizedInput.volumeSpike)
      ? calculateVolumeSpike(normalizedInput.volume)
      : normalizeScore(normalizedInput.volumeSpike),
  };
}

function calculateTrendScore(input = {}) {
  const normalizedInput = normalizeInputObject(input);
  if (!normalizedInput) return 0;

  const { buzzScore, priceMomentum, volumeSpike } =
    buildTrendComponents(normalizedInput);

  return roundNumber(
    clamp(
      buzzScore * BUZZ_WEIGHT +
        priceMomentum * MOMENTUM_WEIGHT +
        volumeSpike * VOLUME_WEIGHT,
      SCORE_MIN,
      SCORE_MAX
    )
  );
}

function determineTrendLevel(trendScore) {
  const normalizedTrendScore = normalizeScore(trendScore);

  if (normalizedTrendScore > EXPLODING_THRESHOLD) return "exploding";
  if (normalizedTrendScore > VERY_HOT_THRESHOLD) return "very_hot";
  if (normalizedTrendScore > HOT_THRESHOLD) return "hot";
  return "warm";
}

function buildTrendingStock(input = {}) {
  const normalizedInput = normalizeInputObject(input);
  if (!normalizedInput) return null;

  const symbol = normalizeSymbol(normalizedInput.symbol);
  if (!symbol) return null;

  const { buzzScore, priceMomentum, volumeSpike } =
    buildTrendComponents(normalizedInput);
  const trendScore = calculateTrendScore({
    buzzScore,
    priceMomentum,
    volumeSpike,
  });

  return {
    symbol,
    buzzScore,
    priceMomentum,
    volumeSpike,
    trendScore,
    trendLevel: determineTrendLevel(trendScore),
  };
}

module.exports = {
  buildTrendingStock,
  calculatePriceMomentum,
  calculateTrendScore,
  calculateVolumeSpike,
  determineTrendLevel,
};
