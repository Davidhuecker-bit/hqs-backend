"use strict";

/*
  HQS PORTFOLIO ENGINE – CLEAN DB-FIRST
  ------------------------------------
  - Pro Aktie: nur gespeicherten hqsScore aus getMarketData()
  - Keine Live-Neuberechnung im Kunden-Request
  - Keine Gesamtmarkt-Ladung für marketAverage
  - Fehlende Scores werden als pending/missing gekennzeichnet
  - Portfolio Score = gewichteter Schnitt nur aus verfügbaren gespeicherten Scores
*/

const { getMarketData } = require("./marketService");

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function safe(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeNullable(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function deriveRating(score) {
  const s = safe(score, 0);
  return s >= 85 ? "Strong Buy" : s >= 70 ? "Buy" : s >= 50 ? "Hold" : "Risk";
}

function deriveDecision(score) {
  const s = safe(score, 0);
  return s >= 70 ? "KAUFEN" : s >= 50 ? "HALTEN" : "NICHT KAUFEN";
}

async function calculatePortfolioHQS(portfolio = []) {
  if (!Array.isArray(portfolio) || portfolio.length === 0) {
    return { error: "Empty portfolio" };
  }

  /* =========================================
     1) Einzelaktien (nur DB-first, kein Live fallback)
  ========================================= */

  const enriched = [];

  for (const position of portfolio) {
    const symbol = String(position?.symbol || "").trim().toUpperCase();
    if (!symbol) continue;

    const weight = clamp(safe(position?.weight, 1), 0, 1e9);

    // 1) Falls der Client schon marketData mitsendet
    let marketItem =
      position?.marketData && typeof position.marketData === "object"
        ? { ...position.marketData, symbol }
        : null;

    // 2) Sonst gespeicherte Daten über getMarketData(symbol) holen
    if (!marketItem) {
      const md = await getMarketData(symbol);
      if (Array.isArray(md) && md.length) marketItem = md[0];
    }

    const cachedScore =
      marketItem && marketItem.hqsScore !== null && marketItem.hqsScore !== undefined
        ? safeNullable(marketItem.hqsScore)
        : null;

    if (cachedScore !== null) {
      enriched.push({
        symbol,
        weight,
        available: true,
        hqsScore: clamp(Math.round(cachedScore), 0, 100),
        stability: safeNullable(marketItem?.hqsBreakdown?.stability),
        rating: deriveRating(cachedScore),
        decision: deriveDecision(cachedScore),
        source: "database",
      });
      continue;
    }

    // Kein gespeicherter HQS vorhanden -> nur als pending/missing markieren
    enriched.push({
      symbol,
      weight,
      available: false,
      hqsScore: null,
      stability: safeNullable(marketItem?.hqsBreakdown?.stability),
      rating: "Pending",
      decision: "NO_DATA",
      source: "database",
      message: "Für dieses Symbol ist noch kein gespeicherter HQS vorhanden.",
    });
  }

  if (!enriched.length) {
    return { error: "No valid portfolio positions" };
  }

  const availablePositions = enriched.filter((p) => p.available === true);
  const missingPositions = enriched.filter((p) => p.available !== true);

  if (!availablePositions.length) {
    return {
      error: "No stored HQS results available yet",
      message: "Für die Portfolio-Positionen sind noch keine gespeicherten HQS-Werte vorhanden.",
      breakdown: enriched,
      exposure: {
        strongBuy: 0,
        buy: 0,
        hold: 0,
        risk: 0,
        pending: missingPositions.length,
      },
      rebalancing: enriched.map((p) => ({
        symbol: p.symbol,
        action: "Warten auf gespeicherten HQS",
      })),
      meta: {
        symbolCount: enriched.length,
        availableCount: availablePositions.length,
        missingCount: missingPositions.length,
      },
      timestamp: new Date().toISOString(),
    };
  }

  /* =========================================
     2) Portfolio Score (gewichteter Schnitt)
     Nur aus verfügbaren gespeicherten Werten
  ========================================= */

  const totalAvailableWeight =
    availablePositions.reduce((sum, p) => sum + safe(p.weight, 0), 0) || 1;

  let weightedScore = 0;
  let weightedStability = 0;
  let stabilityWeight = 0;

  for (const p of availablePositions) {
    const w = safe(p.weight, 0) / totalAvailableWeight;
    weightedScore += safe(p.hqsScore, 0) * w;

    if (p.stability !== null) {
      weightedStability += safe(p.stability, 0) * w;
      stabilityWeight += w;
    }
  }

  const portfolioScore = clamp(Math.round(weightedScore), 0, 100);
  const portfolioStability =
    stabilityWeight > 0 ? clamp(Math.round(weightedStability), 0, 100) : null;

  /* =========================================
     3) Risikoanalyse
     Nur aus verfügbaren gespeicherten Werten
  ========================================= */

  const highRiskPositions = availablePositions.filter((p) => safe(p.hqsScore, 0) < 50);
  const highRiskWeight =
    highRiskPositions.reduce((sum, p) => sum + safe(p.weight, 0), 0) / totalAvailableWeight;

  const riskLevel =
    portfolioScore >= 75 ? "LOW" : portfolioScore >= 60 ? "MEDIUM" : "HIGH";

  /* =========================================
     4) Exposure Analyse
  ========================================= */

  const exposure = {
    strongBuy: availablePositions.filter((p) => safe(p.hqsScore, 0) >= 85).length,
    buy: availablePositions.filter((p) => {
      const s = safe(p.hqsScore, 0);
      return s >= 70 && s < 85;
    }).length,
    hold: availablePositions.filter((p) => {
      const s = safe(p.hqsScore, 0);
      return s >= 50 && s < 70;
    }).length,
    risk: availablePositions.filter((p) => safe(p.hqsScore, 0) < 50).length,
    pending: missingPositions.length,
  };

  /* =========================================
     5) Rebalancing Vorschläge
  ========================================= */

  const rebalancing = enriched.map((p) => {
    if (!p.available) {
      return { symbol: p.symbol, action: "Warten auf gespeicherten HQS" };
    }

    const s = safe(p.hqsScore, 0);

    if (s >= 80) return { symbol: p.symbol, action: "Gewicht erhöhen" };
    if (s < 50) return { symbol: p.symbol, action: "Gewicht reduzieren" };
    return { symbol: p.symbol, action: "Beibehalten" };
  });

  /* =========================================
     6) Finale Antwort
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
      portfolioScore >= 80
        ? "Strong Portfolio"
        : portfolioScore >= 65
        ? "Healthy"
        : portfolioScore >= 50
        ? "Neutral"
        : "Defensive",
    meta: {
      symbolCount: enriched.length,
      availableCount: availablePositions.length,
      missingCount: missingPositions.length,
    },
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  calculatePortfolioHQS,
};
