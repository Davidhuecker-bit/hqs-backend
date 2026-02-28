"use strict";

/*
  HQS STOCK ORCHESTRATOR
  -----------------------
  Pro Aktie:
  - Backtest Analyse
  - HQS Score Berechnung
  - KI Interpretation
  - Gewichte werden nur geladen (nicht ständig recalibriert)
*/

const { simulateBacktest } = require("./backtest.service");
const { buildHQSResponse } = require("./hqsEngine");
const { buildInsight } = require("./aiInterpretation.service");
const { loadLastWeights } = require("./weightHistory.repository");

async function runStockHQSWorkflow({
  symbol,
  historicalPrices,
  latestMarketData,
  regime = "neutral"
}) {
  if (!symbol) {
    throw new Error("Symbol required");
  }

  /* =========================
     1. BACKTEST (nur Analyse)
  ========================== */

  const trades = simulateBacktest(historicalPrices || []);

  const volatilityScore =
    trades.length > 0
      ? trades.reduce((a, t) => a + Math.abs(t.return), 0) / trades.length
      : 0;

  /* =========================
     2. HQS ENGINE
  ========================== */

  const hqsResult = await buildHQSResponse(latestMarketData);

  /* =========================
     3. KI INTERPRETATION
  ========================== */

  const insight = buildInsight({
    hqsScore: hqsResult.hqsScore,
    breakdown: hqsResult.breakdown,
    regime
  });

  return {
    symbol,
    price: latestMarketData.price,
    regime,
    hqsScore: hqsResult.hqsScore,
    breakdown: hqsResult.breakdown,
    rating: hqsResult.rating,
    decision: hqsResult.decision,
    aiInsight: insight,
    backtestVolatility: volatilityScore,
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  runStockHQSWorkflow
};
