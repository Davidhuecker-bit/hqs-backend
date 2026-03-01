"use strict";

/*
  HQS PORTFOLIO ENGINE – INSTITUTIONAL VERSION
  ---------------------------------------------
  - Aggregates single-stock HQS
  - Weighted portfolio score
  - Risk metrics
  - Exposure analysis
  - Rebalancing suggestion
*/

const { buildHQSResponse } = require("./hqsEngine");

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function safe(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function calculatePortfolioHQS(portfolio = []) {
  if (!Array.isArray(portfolio) || portfolio.length === 0) {
    return { error: "Empty portfolio" };
  }

  /* =========================================
     1️⃣ Einzelaktien berechnen
  ========================================= */

  const enriched = [];

  for (const position of portfolio) {
    if (!position.symbol) continue;

    const hqs = await buildHQSResponse(position.marketData || { symbol: position.symbol });

    enriched.push({
      symbol: position.symbol,
      weight: safe(position.weight, 1),
      hqsScore: safe(hqs.hqsScore),
      stability: safe(hqs.breakdown?.stability),
      rating: hqs.rating,
      decision: hqs.decision
    });
  }

  if (!enriched.length) {
    return { error: "No valid HQS results" };
  }

  /* =========================================
     2️⃣ Portfolio Score (gewichteter Schnitt)
  ========================================= */

  const totalWeight = enriched.reduce((s, p) => s + p.weight, 0);

  let weightedScore = 0;
  let weightedStability = 0;

  for (const p of enriched) {
    weightedScore += p.hqsScore * (p.weight / totalWeight);
    weightedStability += p.stability * (p.weight / totalWeight);
  }

  const portfolioScore = clamp(Math.round(weightedScore), 0, 100);
  const portfolioStability = clamp(Math.round(weightedStability), 0, 100);

  /* =========================================
     3️⃣ Risikoanalyse
  ========================================= */

  const highRiskPositions = enriched.filter(p => p.hqsScore < 50);
  const highRiskWeight =
    highRiskPositions.reduce((s, p) => s + p.weight, 0) / totalWeight;

  const riskLevel =
    portfolioScore >= 75 ? "LOW"
    : portfolioScore >= 60 ? "MEDIUM"
    : "HIGH";

  /* =========================================
     4️⃣ Exposure Analyse
  ========================================= */

  const exposure = {
    strongBuy: enriched.filter(p => p.hqsScore >= 85).length,
    buy: enriched.filter(p => p.hqsScore >= 70 && p.hqsScore < 85).length,
    hold: enriched.filter(p => p.hqsScore >= 50 && p.hqsScore < 70).length,
    risk: enriched.filter(p => p.hqsScore < 50).length
  };

  /* =========================================
     5️⃣ Rebalancing Vorschläge
  ========================================= */

  const rebalancing = enriched.map(p => {
    if (p.hqsScore >= 80) {
      return { symbol: p.symbol, action: "Gewicht erhöhen" };
    }

    if (p.hqsScore < 50) {
      return { symbol: p.symbol, action: "Gewicht reduzieren" };
    }

    return { symbol: p.symbol, action: "Beibehalten" };
  });

  /* =========================================
     6️⃣ Finale Antwort
  ========================================= */

  return {
    portfolioScore,
    portfolioStability,
    riskLevel,
    highRiskWeight: Number((highRiskWeight * 100).toFixed(1)),

    exposure,

    rebalancing,

    breakdown: enriched,

    rating:
      portfolioScore >= 80 ? "Strong Portfolio"
      : portfolioScore >= 65 ? "Healthy"
      : portfolioScore >= 50 ? "Neutral"
      : "Defensive",

    timestamp: new Date().toISOString()
  };
}

module.exports = {
  calculatePortfolioHQS
};
