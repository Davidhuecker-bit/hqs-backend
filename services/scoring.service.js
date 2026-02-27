// services/scoring.service.js
// Phase 2 – HQS Scoring Layer
// Deterministisch. Kein Crash. Keine externen Deps.

"use strict";

// ============================
// SCORE BERECHNUNG
// ============================

function calculateHQSScore(marketItem) {
  if (!marketItem || typeof marketItem !== "object") {
    return null;
  }

  const symbol = String(marketItem.symbol || "").trim().toUpperCase();
  if (!symbol) return null;

  const change = typeof marketItem.change === "number" ? marketItem.change : 0;
  const marketCap = typeof marketItem.marketCap === "number" ? marketItem.marketCap : 0;
  const volume = typeof marketItem.volume === "number" ? marketItem.volume : 0;

  // ============================
  // BASIS SCORE
  // ============================

  let score = 50;

  // Change-Bonus/-Malus
  if (change > 2) score += 10;
  else if (change < -2) score -= 10;

  // MarketCap-Bonus/-Malus
  if (marketCap > 200e9) score += 10;
  else if (marketCap > 0 && marketCap < 5e9) score -= 10;

  // Volume-Bonus
  if (volume > 1e6) score += 5;

  // Score begrenzen: 0–100
  score = Math.max(0, Math.min(100, score));

  // ============================
  // RATING
  // ============================

  let rating;
  if (score >= 70) rating = "BULLISH";
  else if (score <= 40) rating = "BEARISH";
  else rating = "NEUTRAL";

  // ============================
  // RISK
  // ============================

  let risk;
  if (marketCap > 200e9) risk = "LOW";
  else if (marketCap >= 20e9) risk = "MEDIUM";
  else risk = "HIGH";

  // ============================
  // MOMENTUM (normalisiert: -1 bis +1, skaliert 0–100)
  // ============================

  const rawMomentum = typeof marketItem.changesPercentage === "number" ? marketItem.changesPercentage : 0;
  const momentum = Math.max(-100, Math.min(100, Math.round(rawMomentum * 10) / 10));

  // ============================
  // STABILITY (invers zu absoluter Preisschwankung)
  // ============================

  const high = typeof marketItem.high === "number" ? marketItem.high : 0;
  const low = typeof marketItem.low === "number" ? marketItem.low : 0;
  const price = typeof marketItem.price === "number" && marketItem.price > 0 ? marketItem.price : 1;
  const range = high - low;
  const relativeRange = range / price;
  const stability = Math.round(Math.max(0, Math.min(100, 100 - relativeRange * 1000)));

  // ============================
  // OUTPUT
  // ============================

  return {
    symbol,
    price: marketItem.price !== undefined ? marketItem.price : null,
    score,
    rating,
    risk,
    momentum,
    stability,
    timestamp: Date.now(),
  };
}

// ============================
// EXPORT
// ============================

module.exports = {
  calculateHQSScore,
};