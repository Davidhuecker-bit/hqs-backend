"use strict";

/*
  Research Engine – Hypothesis Evaluation (Pipeline: Stage 2 of 4)

  Contextualizes and evaluates confirmed market discoveries.
  Input discoveries come from discoveryEngine – this layer adds
  confidence scoring and bearish-risk context rather than re-detecting
  the same opportunity conditions.

  Verantwortung: Ableitung von Hypothesen aus discoveryEngine-Output und
  Konfidenz-Bewertung. Bearish-Pressure ist das einzige research-eigene
  Signal ohne discoveryEngine-Gegenstück.

  Ablauf: discoveryEngine → researchEngine → marketBrain → strategyEngine → integrationEngine
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

function clamp(val, min = 0, max = 1) {
  const n = safe(val, min);
  return Math.max(min, Math.min(max, n));
}

const DEFAULT_CONFIG = {
  momentumHighScore: envNum("RESEARCH_MOMENTUM_HIGH_SCORE", 70),
  momentumHighConf: envNum("RESEARCH_MOMENTUM_HIGH_CONF", 0.8),
  momentumBaseConf: envNum("RESEARCH_MOMENTUM_BASE_CONF", 0.5),

  breakoutHighScore: envNum("RESEARCH_BREAKOUT_HIGH_SCORE", 65),
  breakoutHighConf: envNum("RESEARCH_BREAKOUT_HIGH_CONF", 0.7),
  breakoutBaseConf: envNum("RESEARCH_BREAKOUT_BASE_CONF", 0.4),

  bearishLowScore: envNum("RESEARCH_BEARISH_LOW_SCORE", 40),
  bearishHighConf: envNum("RESEARCH_BEARISH_HIGH_CONF", 0.75),
  bearishBaseConf: envNum("RESEARCH_BEARISH_BASE_CONF", 0.3),

  bearishTrendThreshold: envNum("RESEARCH_BEARISH_TREND", -0.1),
  bearishVolThreshold: envNum("RESEARCH_BEARISH_VOL", 0.6),

  signalThreshold: envNum("RESEARCH_SIGNAL_THRESHOLD", 0.6),
};

function normalizeDiscoveries(discoveries) {
  if (!Array.isArray(discoveries)) return [];
  return discoveries.filter(
    (d) => d && typeof d === "object" && typeof d.type === "string"
  );
}

/* ===============================
   HYPOTHESIS GENERATION
   Derives hypotheses from discoveryEngine output (no re-detection).
   Bearish pressure is the one research-only signal with no
   discoveryEngine counterpart.
================================ */

function generateHypotheses(discoveries, features, advanced, config = DEFAULT_CONFIG) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const hypotheses = [];

  const normalized = normalizeDiscoveries(discoveries);
  const discoveryTypes = new Set(normalized.map((d) => d.type));

  if (
    discoveryTypes.has("momentum_explosion") ||
    discoveryTypes.has("trend_acceleration")
  ) {
    hypotheses.push({
      type: "momentum_continuation",
      label: "Momentum Continuation Hypothesis",
    });
  }

  if (discoveryTypes.has("volatility_compression")) {
    hypotheses.push({
      type: "volatility_breakout",
      label: "Volatility Compression Breakout",
    });
  }

  const trend = safe(advanced?.trend);
  const volatility = Math.max(0, safe(advanced?.volatilityAnnual));
  const trendStrength = safe(features?.trendStrength);

  if (
    trend <= cfg.bearishTrendThreshold &&
    volatility >= cfg.bearishVolThreshold
  ) {
    hypotheses.push({
      type: "bearish_pressure",
      label: "Bearish Pressure Hypothesis",
      context: {
        trend,
        volatility,
        trendStrength,
      },
    });
  }

  return hypotheses;
}

/* ===============================
   HYPOTHESIS EVALUATION
================================ */

function evaluateHypotheses(hypotheses, aiScore, features, advanced, config = DEFAULT_CONFIG) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const evaluations = [];

  const score = safe(aiScore);
  const trend = safe(advanced?.trend);
  const volatility = Math.max(0, safe(advanced?.volatilityAnnual));
  const trendStrength = safe(features?.trendStrength);
  const momentum = safe(features?.momentum);
  const acceleration = safe(features?.acceleration);

  for (const h of hypotheses || []) {
    let confidence = 0;

    switch (h.type) {
      case "momentum_continuation":
        confidence =
          score > cfg.momentumHighScore
            ? cfg.momentumHighConf
            : cfg.momentumBaseConf;

        if (trendStrength > 1.2) confidence += 0.05;
        if (momentum > 0.05) confidence += 0.03;
        if (acceleration > 0) confidence += 0.02;
        break;

      case "volatility_breakout":
        confidence =
          score > cfg.breakoutHighScore
            ? cfg.breakoutHighConf
            : cfg.breakoutBaseConf;

        if (volatility < cfg.bearishVolThreshold / 2) confidence += 0.05;
        if (trend > 0.05) confidence += 0.03;
        if (acceleration > 0) confidence += 0.02;
        break;

      case "bearish_pressure":
        confidence =
          score < cfg.bearishLowScore
            ? cfg.bearishHighConf
            : cfg.bearishBaseConf;

        if (trend < -0.15) confidence += 0.05;
        if (volatility > 0.8) confidence += 0.05;
        if (trendStrength < -0.5) confidence += 0.03;
        break;

      default:
        confidence = 0;
        break;
    }

    evaluations.push({
      hypothesis: h.type,
      label: h.label,
      confidence: clamp(confidence, 0, 1),
    });
  }

  return evaluations;
}

/* ===============================
   RESEARCH SUMMARY
================================ */

function buildResearchReport(symbol, hypotheses, evaluations, config = DEFAULT_CONFIG) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return {
    symbol,
    hypotheses,
    evaluations,
    researchSignals: (evaluations || []).filter(
      (e) => safe(e.confidence) >= cfg.signalThreshold
    ),
  };
}

/* ===============================
   MAIN RESEARCH PIPELINE
   discoveries: optional array from discoveryEngine (enables chain mode).
   When omitted, only the bearish-pressure hypothesis is generated.
================================ */

function runResearch(symbol, symbolData, features, advanced, aiScore, discoveries = []) {
  const hypotheses = generateHypotheses(discoveries, features, advanced);
  const evaluations = evaluateHypotheses(
    hypotheses,
    aiScore,
    features,
    advanced
  );

  return buildResearchReport(symbol, hypotheses, evaluations);
}

module.exports = {
  runResearch,
};
