"use strict";

const SCORE_MIN = 0;
const SCORE_MAX = 100;
const MOMENTUM_MIN = -100;
const MOMENTUM_MAX = 100;
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

function normalizeBuzzScore(value) {
  return roundNumber(clamp(safeNumber(value, 0), SCORE_MIN, SCORE_MAX));
}

function calculatePriceMomentum(value) {
  return roundNumber(clamp(safeNumber(value, 0), MOMENTUM_MIN, MOMENTUM_MAX));
}

function calculateVolumeSpike(value) {
  const volume = safeNumber(value, 0);
  if (volume <= 0) return 0;

  const logVolume = Math.log10(volume);
  const spikeScore = (logVolume - VOLUME_BASELINE_LOG) * VOLUME_WEIGHT_STEP;
  return roundNumber(clamp(spikeScore, SCORE_MIN, SCORE_MAX));
}

function calculateTrendScore(input = {}) {
  const normalizedInput = normalizeInputObject(input);
  if (!normalizedInput) return 0;

  const buzzScore = normalizeBuzzScore(normalizedInput.buzzScore);
  const priceMomentum = calculatePriceMomentum(normalizedInput.changePercent);
  const volumeSpike = calculateVolumeSpike(normalizedInput.volume);

  return roundNumber(
    clamp(
      buzzScore * 0.5 +
        priceMomentum * 0.3 +
        volumeSpike * 0.2,
      SCORE_MIN,
      SCORE_MAX
    )
  );
}

function determineTrendLevel(trendScore) {
  if (trendScore > 85) return "exploding";
  if (trendScore > 70) return "very_hot";
  if (trendScore > 50) return "hot";
  return "warm";
}

function buildTrendingStock(input = {}) {
  const normalizedInput = normalizeInputObject(input);
  if (!normalizedInput) return null;

  const symbol = normalizeSymbol(normalizedInput.symbol);
  if (!symbol) return null;

  const buzzScore = normalizeBuzzScore(normalizedInput.buzzScore);
  const priceMomentum = calculatePriceMomentum(normalizedInput.changePercent);
  const volumeSpike = calculateVolumeSpike(normalizedInput.volume);
  const trendScore = calculateTrendScore({
    buzzScore,
    changePercent: priceMomentum,
    volume: normalizedInput.volume,
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
