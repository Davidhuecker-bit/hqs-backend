"use strict";

/**
 * Global Market Data Normalizer
 * - robust numeric parsing
 * - calculates change + changesPercentage if missing
 * - consistent null checks (no falsy-bugs)
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

function hasNum(x) {
  return x !== null && x !== undefined && Number.isFinite(Number(x));
}

function calculateChangePercent(price, previousClose) {
  if (!hasNum(price) || !hasNum(previousClose) || Number(previousClose) === 0) return null;
  return ((Number(price) - Number(previousClose)) / Number(previousClose)) * 100;
}

function calculateChange(price, previousClose) {
  if (!hasNum(price) || !hasNum(previousClose)) return null;
  return Number(price) - Number(previousClose);
}

function normalizeMarketData(raw, source, region) {
  if (!raw || typeof raw !== "object") return null;

  const symbol = String(raw.symbol || raw.ticker || raw.T || "")
    .trim()
    .toUpperCase();

  if (!symbol) return null;

  const price = toNumberOrNull(raw.price ?? raw.c ?? raw.last);
  const open = toNumberOrNull(raw.open ?? raw.o);

  // previousClose may come in many forms; if missing, use open as fallback
  let previousClose = toNumberOrNull(raw.previousClose ?? raw.pc);
  if (previousClose === null && open !== null) previousClose = open;

  // provider can supply either change or percent or both
  let change = toNumberOrNull(raw.change ?? raw.d);
  let changesPercentage = toNumberOrNull(raw.changesPercentage ?? raw.changePercent ?? raw.dp);

  // compute missing values if possible
  if (changesPercentage === null && price !== null && previousClose !== null) {
    changesPercentage = calculateChangePercent(price, previousClose);
  }

  if (change === null && price !== null && previousClose !== null) {
    change = calculateChange(price, previousClose);
  }

  // if change missing but percent + previousClose present, compute change
  if (change === null && changesPercentage !== null && previousClose !== null) {
    change = (Number(previousClose) * Number(changesPercentage)) / 100;
  }

  return {
    symbol,
    exchange: String(raw.exchange || raw.market || "").trim() || null,
    region: String(region || "unknown"),

    price,
    change,
    changesPercentage,

    high: toNumberOrNull(raw.high ?? raw.h),
    low: toNumberOrNull(raw.low ?? raw.l),
    open,
    previousClose,

    volume: toNumberOrNull(raw.volume ?? raw.v),

    timestamp: new Date().toISOString(),
    source: String(source || "unknown"),
  };
}

module.exports = { normalizeMarketData };
