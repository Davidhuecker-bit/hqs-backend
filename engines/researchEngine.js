"use strict";

/*
  Autonomous Research Engine
  Generates and evaluates market hypotheses
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

/* ===============================
   HYPOTHESIS GENERATION
================================ */

function generateHypotheses(symbolData, features, advanced) {

  const hypotheses = [];

  const trend = safe(advanced?.trend);
  const volatility = safe(advanced?.volatilityAnnual);
  const volumeAccel = safe(features?.volumeAcceleration);
  const trendStrength = safe(features?.trendStrength);

  if (trendStrength > 1.2 && volumeAccel > 0.4) {
    hypotheses.push({
      type: "momentum_continuation",
      label: "Momentum Continuation Hypothesis"
    });
  }

  if (volatility < 0.2 && trend > 0.1) {
    hypotheses.push({
      type: "volatility_breakout",
      label: "Volatility Compression Breakout"
    });
  }

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
================================ */

function runResearch(symbol, symbolData, features, advanced, aiScore) {

  const hypotheses = generateHypotheses(symbolData, features, advanced);

  const evaluations = evaluateHypotheses(hypotheses, aiScore);

  return buildResearchReport(symbol, hypotheses, evaluations);

}

module.exports = {
  runResearch
};
