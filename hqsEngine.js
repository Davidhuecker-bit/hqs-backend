// services/hqsEngine.js
const { getFundamentals } = require("./fundamental.service");
const { saveScoreSnapshot } = require("./factorHistory.repository");

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function safe(v, f = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
}

/* ================= REGIME ================= */

function detectRegime(change) {
  if (change > 2) return "expansion";
  if (change > 0.5) return "bull";
  if (change < -2) return "crash";
  if (change < -0.5) return "bear";
  return "neutral";
}

function regimeMultiplier(regime) {
  switch (regime) {
    case "expansion": return 1.15;
    case "bull": return 1.05;
    case "bear": return 0.95;
    case "crash": return 0.85;
    default: return 1;
  }
}

/* ================= FACTORS ================= */

function calculateMomentum(item) {
  const intraday = safe(item.changesPercentage);
  return clamp(50 + intraday * 3, 0, 100);
}

function calculateVolatility(item) {
  const high = safe(item.high);
  const low = safe(item.low);
  const open = safe(item.open);

  if (!open) return 0;
  const range = ((high - low) / open) * 100;

  if (range < 2) return 5;
  if (range > 6) return -5;
  return 0;
}

function calculateQuality(f) {
  if (!f) return 50;

  let score = 50;

  if (safe(f.revenueGrowth) > 10) score += 10;
  if (safe(f.netMargin) > 15) score += 10;
  if (safe(f.returnOnEquity) > 15) score += 10;
  if (safe(f.debtToEquity) < 1) score += 5;
  if (safe(f.debtToEquity) > 2) score -= 10;

  return clamp(score, 0, 100);
}

function calculateRelative(stockChange, marketProxy = 0.8) {
  const relative = safe(stockChange) - marketProxy;

  if (relative > 2) return 15;
  if (relative > 1) return 8;
  if (relative > 0) return 4;
  if (relative < -2) return -10;
  if (relative < -1) return -5;
  return 0;
}

/* ================= MAIN ================= */

async function buildHQSResponse(item = {}) {
  if (!item.symbol) throw new Error("Missing symbol");

  const fundamentals = await getFundamentals(item.symbol);

  const regime = detectRegime(safe(item.changesPercentage));

  const momentum = calculateMomentum(item);
  const quality = calculateQuality(fundamentals);
  const volatilityAdj = calculateVolatility(item);
  const relative = calculateRelative(item.changesPercentage);

  let base =
    momentum * 0.35 +
    quality * 0.35 +
    (50 + volatilityAdj) * 0.2 +
    (50 + relative) * 0.1;

  base *= regimeMultiplier(regime);

  const finalScore = clamp(Math.round(base), 0, 100);

  await saveScoreSnapshot({
    symbol: item.symbol,
    hqsScore: finalScore,
    momentum,
    quality,
    volatilityAdj,
    relative,
    regime
  });

  return {
    symbol: item.symbol.toUpperCase(),
    price: safe(item.price),
    regime,
    breakdown: { momentum, quality, volatilityAdj, relative },
    hqsScore: finalScore
  };
}

module.exports = { buildHQSResponse };
