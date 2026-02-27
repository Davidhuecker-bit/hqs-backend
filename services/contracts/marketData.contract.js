// services/contracts/marketData.contract.js
// Phase 1.5 – Global Market Data Contract
// Standardformat fuer alle Marktdaten im HQS-System.
// KEIN API Call. Nur Normalisierung.

"use strict";

// ============================
// SAFE NULL HELPER
// ============================

function safeNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return isNaN(n) ? null : n;
}

// ============================
// normalizeMarketData(rawData, source)
// Contract: always returns standard shape or null.
// Never returns undefined. Never throws.
// ============================

function normalizeMarketData(rawData, source) {
  if (!rawData || typeof rawData !== "object") return null;

  const symbol = String(rawData.symbol || "").trim().toUpperCase();
  if (!symbol) return null;

  const normalized = {
    symbol,
    price: safeNull(rawData.price),
    change: safeNull(rawData.change),
    changesPercentage: safeNull(rawData.changesPercentage),
    high: safeNull(rawData.high),
    low: safeNull(rawData.low),
    open: safeNull(rawData.open),
    previousClose: safeNull(rawData.previousClose),
    volume: safeNull(rawData.volume),
    marketCap: safeNull(rawData.marketCap),
    timestamp: Date.now(),
    source: String(source || "unknown"),
  };

  console.log("[Contract] Normalized " + symbol + " from " + normalized.source);

  return normalized;
}

module.exports = { normalizeMarketData };