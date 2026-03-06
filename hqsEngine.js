"use strict";

/*
  HQS Engine – Core Stock Scoring Engine (Market-Regime Version B)
  Upgrade:
  - accepts adaptiveWeights (3rd param)
  - accepts regimeHint (4th param) from advanced regime engines
  - keeps DB-first weights as fallback
*/

const { getFundamentals } = require("./services/fundamental.service");
const { saveScoreSnapshot } = require("./services/factorHistory.repository");
const { loadLastWeights } = require("./services/weightHistory.repository");

// optional logger (falls vorhanden)
let logger = null;
try {
  logger = require("./utils/logger");
} catch (_) {
  logger = null;
}

/* =========================================================
   DEFAULT WEIGHTS
========================================================= */

const DEFAULT_WEIGHTS = {
  momentum: 0.35,
  quality: 0.35,
  stability: 0.20,
  relative: 0.10,
};

/* =========================================================
   UTIL
========================================================= */

function clamp(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function safe(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeWeights(weights) {
  const base = weights && typeof weights === "object" ? weights : {};

  let total = 0;

  for (const k of Object.keys(DEFAULT_WEIGHTS)) {
    const val = safe(base[k], 0);
    total += val > 0 ? val : 0;
  }

  if (total <= 0) return { ...DEFAULT_WEIGHTS };

  const normalized = {};

  for (const k of Object.keys(DEFAULT_WEIGHTS)) {
    const val = safe(base[k], 0);
    normalized[k] = (val > 0 ? val : 0) / total;
  }

  return normalized;
}

function mapRegimeHint(regimeHint) {
  if (!regimeHint) return null;

  const r = String(regimeHint).trim().toLowerCase();

  if (r === "bullish") return "bull";
  if (r === "bearish") return "bear";
  if (r === "neutral") return "neutral";

  if (["expansion", "bull", "bear", "crash", "neutral"].includes(r)) return r;

  return null;
}

/* =========================================================
   REGIME DETECTION – MARKET BASED
========================================================= */

function detectRegime(symbolChange, marketAverage) {
  const diff = safe(symbolChange) - safe(marketAverage);

  if (marketAverage > 1 && diff > 0.5) return "expansion";
  if (marketAverage > 0) return "bull";
  if (marketAverage < -1 && diff < -0.5) return "crash";
  if (marketAverage < 0) return "bear";

  return "neutral";
}

function regimeMultiplier(regime) {
  switch (regime) {
    case "expansion":
      return 1.10;
    case "bull":
      return 1.05;
    case "bear":
      return 0.95;
    case "crash":
      return 0.85;
    default:
      return 1;
  }
}

/* =========================================================
   FACTORS
========================================================= */

function calculateMomentum(changePercent, trend = 0) {
  const base = 50 + safe(changePercent) * 3;
  const trendBoost = safe(trend) * 20;
  return clamp(base + trendBoost, 0, 100);
}

function calculateStability(item) {
  const high = safe(item.high);
  const low = safe(item.low);
  const open = safe(item.open);

  if (!open) return 50;

  const range = ((high - low) / open) * 100;

  const stability =
    70 - range * 3;

  return clamp(stability, 20, 85);
}

function calculateQuality(fundamentals) {
  if (!fundamentals) return 50;

  let score = 50;

  if (safe(fundamentals.revenueGrowth) > 10) score += 10;
  if (safe(fundamentals.netMargin) > 15) score += 10;
  if (safe(fundamentals.returnOnEquity) > 15) score += 10;

  if (safe(fundamentals.revenueGrowth) > 20) score += 5;
  if (safe(fundamentals.netMargin) > 25) score += 5;

  if (safe(fundamentals.debtToEquity) < 1) score += 5;
  if (safe(fundamentals.debtToEquity) > 2) score -= 10;

  return clamp(score, 0, 100);
}

function calculateRelativeStrength(symbolChange, marketAverage) {
  const diff = safe(symbolChange) - safe(marketAverage);
  return clamp(50 + diff * 4, 0, 100);
}

/* =========================================================
   MAIN ENGINE
========================================================= */

async function buildHQSResponse(
  item = {},
  marketAverage = 0,
  adaptiveWeights = null,
  regimeHint = null
) {
  try {
    if (!item.symbol) throw new Error("Missing symbol");

    let weightsRaw = null;
    let weightsSource = "default";

    if (adaptiveWeights && typeof adaptiveWeights === "object") {
      weightsRaw = adaptiveWeights;
      weightsSource = "adaptive";
    } else {
      weightsRaw = await loadLastWeights();
      if (weightsRaw) weightsSource = "database";
    }

    const weights = normalizeWeights(weightsRaw || DEFAULT_WEIGHTS);

    let fundamentals = null;

    try {
      fundamentals = await getFundamentals(item.symbol);
    } catch (err) {
      if (logger?.warn)
        logger.warn("Fundamental load failed", { message: err.message });
      else console.warn("Fundamental load failed:", err.message);
    }

    const mappedHint = mapRegimeHint(regimeHint);
    const regime =
      mappedHint || detectRegime(item.changesPercentage, marketAverage);

    const momentum = calculateMomentum(item.changesPercentage, item.trend);
    const stability = calculateStability(item);
    const quality = calculateQuality(fundamentals);
    const relative = calculateRelativeStrength(
      item.changesPercentage,
      marketAverage
    );

    let baseScore =
      momentum * weights.momentum +
      quality * weights.quality +
      stability * weights.stability +
      relative * weights.relative;

    baseScore *= regimeMultiplier(regime);

    const finalScore = clamp(Math.round(baseScore), 0, 100);

    await saveScoreSnapshot({
      symbol: item.symbol,
      hqsScore: finalScore,
      momentum,
      quality,
      stability,
      relative,
      regime,
    });

    return {
      symbol: String(item.symbol).toUpperCase(),
      price: safe(item.price),
      changePercent: safe(item.changesPercentage),
      regime,
      weights,
      weightsSource,
      breakdown: { momentum, quality, stability, relative },
      hqsScore: finalScore,
      rating:
        finalScore >= 85
          ? "Strong Buy"
          : finalScore >= 70
          ? "Buy"
          : finalScore >= 50
          ? "Hold"
          : "Risk",
      decision:
        finalScore >= 70
          ? "KAUFEN"
          : finalScore >= 50
          ? "HALTEN"
          : "NICHT KAUFEN",
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    if (logger?.error)
      logger.error("HQS Engine Error", { message: error.message });
    else console.error("HQS Engine Error:", error.message);

    return {
      symbol: item?.symbol || null,
      hqsScore: null,
      error: "HQS calculation failed",
    };
  }
}

module.exports = { buildHQSResponse };
