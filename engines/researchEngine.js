"use strict";

/*
  Autonomous Research Engine
  Contextualizes and evaluates confirmed market discoveries.
  Input discoveries come from discoveryEngine – this layer adds
  confidence scoring and bearish-risk context rather than re-detecting
  the same opportunity conditions.
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

/* ===============================
   HYPOTHESIS GENERATION
   Derives hypotheses from discoveryEngine output (no re-detection).
   Bearish pressure is the one research-only signal with no
   discoveryEngine counterpart.
================================ */

function generateHypotheses(discoveries, features, advanced) {

  const hypotheses = [];

  const discoveryTypes = new Set((discoveries || []).map(d => d.type));

  if (discoveryTypes.has("momentum_explosion") || discoveryTypes.has("trend_acceleration")) {
    hypotheses.push({
      type: "momentum_continuation",
      label: "Momentum Continuation Hypothesis"
    });
  }

  if (discoveryTypes.has("volatility_compression")) {
    hypotheses.push({
      type: "volatility_breakout",
      label: "Volatility Compression Breakout"
    });
  }

  const trend = safe(advanced?.trend);
  const volatility = safe(advanced?.volatilityAnnual);

  if (trend < -0.1 && volatility > 0.6) {
    hypotheses.push({
      type: "bearish_pressure",
      label: "Bearish Pressure Hypothesis"
    });
  }

  return hypotheses;
}

/* ===============================
   HYPOTHESIS EVALUATION
================================ */

function evaluateHypotheses(hypotheses, aiScore) {

  const evaluations = [];

  for (const h of hypotheses) {

    let confidence = 0;

    if (h.type === "momentum_continuation") {
      confidence = aiScore > 70 ? 0.8 : 0.5;
    }

    if (h.type === "volatility_breakout") {
      confidence = aiScore > 65 ? 0.7 : 0.4;
    }

    if (h.type === "bearish_pressure") {
      confidence = aiScore < 40 ? 0.75 : 0.3;
    }

    evaluations.push({
      hypothesis: h.type,
      label: h.label,
      confidence
    });

  }

  return evaluations;
}

/* ===============================
   RESEARCH SUMMARY
================================ */

function buildResearchReport(symbol, hypotheses, evaluations) {

  return {
    symbol,
    hypotheses,
    evaluations,
    researchSignals: evaluations.filter(e => e.confidence > 0.6)
  };

}

/* ===============================
   MAIN RESEARCH PIPELINE
   discoveries: optional array from discoveryEngine (enables chain mode).
   When omitted, only the bearish-pressure hypothesis is generated.
================================ */

function runResearch(symbol, symbolData, features, advanced, aiScore, discoveries = []) {

  const hypotheses = generateHypotheses(discoveries, features, advanced);

  const evaluations = evaluateHypotheses(hypotheses, aiScore);

  return buildResearchReport(symbol, hypotheses, evaluations);

}

module.exports = {
  runResearch
};
