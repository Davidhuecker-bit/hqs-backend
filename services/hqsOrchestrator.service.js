"use strict";

/*
  HQS FULL ORCHESTRATOR
  ----------------------
  Kombiniert:
  - Backtest
  - Portfolio Learning
  - AutoFactor
  - HQS Engine
  - AI Interpretation
*/

const { simulateBacktest } = require("./backtest.service");
const { runPortfolioLearning } = require("./portfolioLearning.service");
const { buildHQSResponse } = require("./hqsEngine");
const { buildInsight } = require("./aiInterpretation.service");
const { loadLastWeights } = require("./weightHistory.repository");

/*
  Hauptfunktion:
  Führt kompletten HQS Zyklus aus
*/

async function runFullHQSWorkflow({
  symbol,
  historicalPrices,
  latestMarketData,
  regime = "neutral"
}) {
  if (!symbol) {
    throw new Error("Symbol required");
  }

  /* =========================
     1. BACKTEST
  ========================== */

  const trades = simulateBacktest(historicalPrices || []);

  /* =========================
     2. PORTFOLIO LEARNING
  ========================== */

  const learningResult = await runPortfolioLearning(trades, regime);

  /* =========================
     3. BUILD HQS SCORE
  ========================== */

  const hqsResult = await buildHQSResponse(latestMarketData);

  /* =========================
     4. AI INTERPRETATION
  ========================== */

  const insight = buildInsight({
    hqsScore: hqsResult.hqsScore,
    breakdown: hqsResult.breakdown,
    regime
  });

  return {
    symbol,
    hqsScore: hqsResult.hqsScore,
    breakdown: hqsResult.breakdown,
    regime,
    decision: hqsResult.decision,
    rating: hqsResult.rating,
    aiInsight: insight,
    learning: learningResult.success || false
  };
}

module.exports = {
  runFullHQSWorkflow
};
