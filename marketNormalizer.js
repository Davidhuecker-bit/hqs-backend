"use strict";

/**
 * Global Market Data Normalizer
 */

function toNumberOrNull(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === "string") {
    const cleaned = value.replace("%", "").replace(",", ".");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeMarketData(raw, source, region) {
  if (!raw || typeof raw !== "object") return null;

  const symbol = String(raw.symbol || raw.ticker || "")
    .trim()
    .toUpperCase();

  if (!symbol) return null;

  return {
    symbol,
    exchange: String(raw.exchange || raw.market || "").trim() || null,
    region: String(region || "unknown"),

    price: toNumberOrNull(raw.price ?? raw.c ?? raw.last),
    change: toNumberOrNull(raw.change ?? raw.d),
    changesPercentage: toNumberOrNull(
      raw.changesPercentage ?? raw.changePercent ?? raw.dp
    ),

    high: toNumberOrNull(raw.high ?? raw.h),
    low: toNumberOrNull(raw.low ?? raw.l),
    open: toNumberOrNull(raw.open ?? raw.o),
    previousClose: toNumberOrNull(raw.previousClose ?? raw.pc),

    volume: toNumberOrNull(raw.volume ?? raw.v),

    timestamp: new Date().toISOString(),
    source: String(source || "unknown")
  };
}

module.exports = { normalizeMarketData };
