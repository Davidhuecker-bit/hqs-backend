"use strict";

/**
 * Strategy Engine
 * Derives the strategy and score adjustment from market conditions.
 * When a researchReport from researchEngine is provided, the breakout
 * strategy is confirmed via research signals (chain mode) rather than
 * re-evaluating the raw volatility/trend condition.
 *
 * Compatible replacement:
 * - same function names
 * - same input signature
 * - same output shape
 */

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function envNum(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(val, min = 0, max = 100) {
  const n = safe(val, min);
  return Math.max(min, Math.min(max, n));
}

const DEFAULT_CONFIG = {
  momentumTrendStrength: envNum("STRAT_MOM_STRENGTH", 1.5),
  momentumTrendMin: envNum("STRAT_MOM_TREND", 0.2),

  breakoutVolatilityMax: envNum("STRAT_BREAK_VOLA", 0.2),
  breakoutTrendMin: envNum("STRAT_BREAK_TREND", 0.1),

  defensiveVolatilityMin: envNum("STRAT_DEF_VOLA", 0.7),

  scoreAdjustments: {
    momentum: envNum("STRAT_SCORE_MOMENTUM", 5),
    breakout: envNum("STRAT_SCORE_BREAKOUT", 3),
    defensive: envNum("STRAT_SCORE_DEFENSIVE", -4),
    balanced: envNum("STRAT_SCORE_BALANCED", 0),
  },
};

function isBreakoutConfirmed(volatility, trend, researchReport, cfg) {
  if (researchReport && Array.isArray(researchReport.researchSignals)) {
    return researchReport.researchSignals.some(
      (s) =>
        s &&
        s.hypothesis === "volatility_breakout" &&
        safe(s.strength, 0) > 0.5
    );
  }

  return (
    volatility < cfg.breakoutVolatilityMax &&
    trend > cfg.breakoutTrendMin
  );
}

function detectStrategy(features, advanced, researchReport, customConfig = {}) {
  const cfg = {
    ...DEFAULT_CONFIG,
    ...customConfig,
    scoreAdjustments: {
      ...DEFAULT_CONFIG.scoreAdjustments,
      ...(customConfig.scoreAdjustments || {}),
    },
  };

  const trend = safe(advanced?.trend);
  const volatility = Math.max(0, safe(advanced?.volatilityAnnual));
  const trendStrength = safe(features?.trendStrength);

  if (
    trendStrength > cfg.momentumTrendStrength &&
    trend > cfg.momentumTrendMin
  ) {
    return {
      strategy: "momentum",
      label: "Momentum Strategy",
    };
  }

  if (isBreakoutConfirmed(volatility, trend, researchReport, cfg)) {
    return {
      strategy: "breakout",
      label: "Breakout Setup",
    };
  }

  if (volatility > cfg.defensiveVolatilityMin) {
    return {
      strategy: "defensive",
      label: "Defensive Setup",
    };
  }

  return {
    strategy: "balanced",
    label: "Balanced Market",
  };
}

/* ===============================
   STRATEGY SCORE ADJUSTMENT
================================ */

function adjustScoreForStrategy(aiScore, strategy, customConfig = {}) {
  const cfg = {
    ...DEFAULT_CONFIG,
    ...customConfig,
    scoreAdjustments: {
      ...DEFAULT_CONFIG.scoreAdjustments,
      ...(customConfig.scoreAdjustments || {}),
    },
  };

  let adjusted = safe(aiScore);

  adjusted += safe(cfg.scoreAdjustments[strategy], 0);

  return clamp(adjusted, 0, 100);
}

function applyStrategy(symbol, aiScore, features, advanced, researchReport = null) {
  const strategyInfo = detectStrategy(features, advanced, researchReport);

  const adjustedScore = adjustScoreForStrategy(
    aiScore,
    strategyInfo.strategy
  );

  return {
    symbol,
    strategy: strategyInfo.strategy,
    strategyLabel: strategyInfo.label,
    strategyAdjustedScore: adjustedScore,
  };
}

module.exports = {
  applyStrategy,
};
