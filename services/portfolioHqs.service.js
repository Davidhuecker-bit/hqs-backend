"use strict";

/*
  HQS PORTFOLIO ENGINE – FAST + CLEAN (DB-first)
  ---------------------------------------------
  - Pro Aktie: erst gespeicherten hqsScore aus getMarketData() (kommt aus hqs_scores)
  - Fallback: live buildHQSResponse(), wenn hqsScore fehlt
  - Portfolio Score = gewichteter Schnitt
  - Risk metrics / Exposure / Rebalancing bleiben wie bisher
*/

const { getMarketData } = require("./marketService");
// ✅ FIX: eine Ebene nach oben, da hqsEngine.js im Root liegt
const { buildHQSResponse } = require("../hqsEngine");

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function safe(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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
     1) Einzelaktien (DB-first, Live fallback)
  ========================================= */

  const enriched = [];

  for (const position of portfolio) {
    const symbol = String(position?.symbol || "").trim().toUpperCase();
    if (!symbol) continue;

    const weight = clamp(safe(position?.weight, 1), 0, 1e9);

    // 1) Falls der Client schon marketData mitsendet
    let marketItem = position?.marketData && typeof position.marketData === "object"
      ? { ...position.marketData, symbol }
      : null;

    // 2) Sonst DB/Provider über getMarketData holen (liefert hqsScore aus hqs_scores)
    if (!marketItem) {
      const md = await getMarketData(symbol);
      if (Array.isArray(md) && md.length) marketItem = md[0];
    }

    // 3) Wenn wir einen gespeicherten Score haben -> nutzen (keine Live-Berechnung)
    const cachedScore =
      marketItem && marketItem.hqsScore !== null && marketItem.hqsScore !== undefined
        ? safe(marketItem.hqsScore, null)
        : null;

    if (cachedScore !== null) {
      enriched.push({
        symbol,
        weight,
        hqsScore: clamp(Math.round(cachedScore), 0, 100),

        // stability haben wir DB-seitig aktuell nicht sicher -> neutraler Fallback
        stability: safe(marketItem?.stability, 55),

        rating: deriveRating(cachedScore),
        decision: deriveDecision(cachedScore),

        source: "database",
      });

      continue;
    }

    // 4) Live fallback: Score wirklich berechnen
    const hqs = await buildHQSResponse(marketItem || { symbol });

    enriched.push({
      symbol,
      weight,
      hqsScore: safe(hqs.hqsScore, 0),
      stability: safe(hqs.breakdown?.stability, 55),
      rating: hqs.rating || deriveRating(hqs.hqsScore),
      decision: hqs.decision || deriveDecision(hqs.hqsScore),
      source: "live",
    });
  }

  if (!enriched.length) {
    return { error: "No valid HQS results" };
  }

  /* =========================================
     2) Portfolio Score (gewichteter Schnitt)
  ========================================= */

  const totalWeight = enriched.reduce((s, p) => s + safe(p.weight, 0), 0) || 1;

  let weightedScore = 0;
  let weightedStability = 0;

  for (const p of enriched) {
    const w = safe(p.weight, 0) / totalWeight;
    weightedScore += safe(p.hqsScore, 0) * w;
    weightedStability += safe(p.stability, 55) * w;
  }

  const portfolioScore = clamp(Math.round(weightedScore), 0, 100);
  const portfolioStability = clamp(Math.round(weightedStability), 0, 100);

  /* =========================================
     3) Risikoanalyse
  ========================================= */

  const highRiskPositions = enriched.filter((p) => safe(p.hqsScore, 0) < 50);
  const highRiskWeight =
    highRiskPositions.reduce((s, p) => s + safe(p.weight, 0), 0) / totalWeight;

  const riskLevel =
    portfolioScore >= 75 ? "LOW" : portfolioScore >= 60 ? "MEDIUM" : "HIGH";

  /* =========================================
     4) Exposure Analyse
  ========================================= */

  const exposure = {
    strongBuy: enriched.filter((p) => safe(p.hqsScore, 0) >= 85).length,
    buy: enriched.filter((p) => {
      const s = safe(p.hqsScore, 0);
      return s >= 70 && s < 85;
    }).length,
    hold: enriched.filter((p) => {
      const s = safe(p.hqsScore, 0);
      return s >= 50 && s < 70;
    }).length,
    risk: enriched.filter((p) => safe(p.hqsScore, 0) < 50).length,
  };

  /* =========================================
     5) Rebalancing Vorschläge
  ========================================= */

  const rebalancing = enriched.map((p) => {
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
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  calculatePortfolioHQS,
};
