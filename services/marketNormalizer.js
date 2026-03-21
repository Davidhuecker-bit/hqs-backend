"use strict";

/**
 * Global Market Data Normalizer
 * - robust numeric parsing
 * - calculates change + changesPercentage if missing
 * - consistent null checks (no falsy-bugs)
 * - ✅ NEW: optional fields (marketCap, name, currency, avgVolume) for better discovery/UI
 */

function toNumberOrNull(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === "string") {
    const cleaned = value.replace("%", "").replace(",", ".").trim();
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

function toTextOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function normalizeMarketData(raw, source, region) {
  if (!raw || typeof raw !== "object") return null;

  const symbol = String(
    raw.symbol || raw.ticker || raw.T || raw.S || raw.sym || ""
  )
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

  // ✅ extra optional fields (if provider has them)
  const high = toNumberOrNull(raw.high ?? raw.h);
  const low = toNumberOrNull(raw.low ?? raw.l);
  const marketCap = toNumberOrNull(raw.marketCap ?? raw.mktCap ?? raw.market_cap);
  const avgVolume = toNumberOrNull(raw.avgVolume ?? raw.avgVol ?? raw.averageVolume ?? raw.average_volume);
  const currency = toTextOrNull(raw.currency ?? raw.curr);
  const name = toTextOrNull(raw.name ?? raw.companyName ?? raw.company_name);

  // HQS 2.0 Block 1: track which fields are missing/null for quality layer
  const missingFields = [];
  if (price == null)             missingFields.push("price");
  if (changesPercentage == null) missingFields.push("changesPercentage");
  if (high == null)              missingFields.push("high");
  if (low == null)               missingFields.push("low");
  if (open == null)              missingFields.push("open");

  const _qualityMeta = {
    hasMinimal: price !== null,
    missingFields,
  };

  return {
    symbol,
    exchange: toTextOrNull(raw.exchange || raw.market) || null,
    region: String(region || "unknown"),

    price,
    change,
    changesPercentage,

    high,
    low,
    open,
    previousClose,

    volume: toNumberOrNull(raw.volume ?? raw.v),
    avgVolume,

    marketCap,
    currency,
    name,

    timestamp: new Date().toISOString(),
    source: String(source || "unknown"),
    _qualityMeta,
  };
}

module.exports = { normalizeMarketData };
