"use strict";

function normalizeInput(input) {
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

function buildEarlySignals(input = {}) {
  const normalizedInput = normalizeInput(input);
  if (!normalizedInput) return [];

  const symbol = normalizeSymbol(normalizedInput.symbol);
  if (!symbol) return [];

  const buzzScore = safeNumber(normalizedInput.buzzScore, 0);
  const priceMomentum = safeNumber(normalizedInput.priceMomentum, 0);
  const signals = [];

  if (buzzScore > 70 && priceMomentum < 10) {
    signals.push({
      symbol,
      signal: "early_interest",
      strength: buzzScore,
    });
  }

  if (buzzScore > 85 && priceMomentum < 5) {
    signals.push({
      symbol,
      signal: "potential_breakout",
    });
  }

  return signals;
}

module.exports = {
  buildEarlySignals,
};
