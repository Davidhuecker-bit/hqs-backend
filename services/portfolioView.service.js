"use strict";

/*
  Portfolio View Service
  ----------------------
  Baut die erste kanonische Kundensicht für Depotpositionen auf Basis
  der bereits vorhandenen Backend-Bausteine:

    - virtual_positions            → portfolioTwin.service.js
    - gespeicherte HQS-Bewertung   → portfolioHqs.service.js
    - Portfolio-Kontext            → portfolioContext.service.js
    - News pro Symbol              → marketNews.service.js
    - Markt-/Stammdaten            → marketService.js

  WICHTIG:
    - Nutzt nur bestehende Backend-Logik
    - Keine Frontend-/Vercel-Schattenlogik
    - Keine Live-Neuberechnung der Kundenlogik im Request
    - Ehrliche Status: ready / partial / building / failed

  HINWEIS:
    virtual_positions enthält aktuell keine echten Depotfelder wie
    quantity / avg_cost aus einer Broker-Anbindung.
    Deshalb arbeitet dieser erste Service mit den vorhandenen Twin-/Allocation-
    Daten und liefert zusätzlich derived/estimated Felder.
*/

const logger = require("../utils/logger");

const { listVirtualPositions } = require("./portfolioTwin.service");
const { calculatePortfolioHQS } = require("./portfolioHqs.service");
const { buildPortfolioContextForSymbols } = require("./portfolioContext.service");
const { getStructuredMarketNewsBySymbols } = require("./marketNews.service");
const { getMarketData } = require("./marketService");

/* ──────────────────────────────────────────────────────────
   Helpers
────────────────────────────────────────────────────────── */

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeNullableNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function uniqueSymbols(positions = []) {
  return [
    ...new Set(
      positions
        .map((p) => String(p?.symbol || "").trim().toUpperCase())
        .filter(Boolean)
    ),
  ];
}

function normalizeStatusFilter(status) {
  const normalized = String(status || "open").trim().toLowerCase();
  if (normalized === "open" || normalized === "closed") return normalized;
  return null;
}

async function buildMarketMap(symbols = []) {
  const entries = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const data = await getMarketData(symbol);
        const item = Array.isArray(data) && data.length ? data[0] : null;
        return [symbol, item];
      } catch (error) {
        logger.warn("[portfolioView] getMarketData failed", {
          symbol,
          message: error.message,
        });
        return [symbol, null];
      }
    })
  );

  return new Map(entries);
}

function buildPortfolioInputForHqs(positions = [], marketMap = new Map()) {
  const totalAllocated =
    positions.reduce((sum, position) => sum + safeNum(position?.allocatedEur, 0), 0) || 1;

  return positions.map((position) => {
    const symbol = String(position?.symbol || "").trim().toUpperCase();
    const allocatedEur = safeNum(position?.allocatedEur, 0);
    const weight = allocatedEur > 0 ? allocatedEur / totalAllocated : 0;
    const marketData = marketMap.get(symbol) || null;

    return {
      symbol,
      weight,
      marketData,
    };
  });
}

function buildHqsBreakdownMap(portfolioHqsResult) {
  const map = new Map();
  const rows = Array.isArray(portfolioHqsResult?.breakdown)
    ? portfolioHqsResult.breakdown
    : [];

  for (const row of rows) {
    const symbol = String(row?.symbol || "").trim().toUpperCase();
    if (!symbol) continue;
    map.set(symbol, row);
  }

  return map;
}

function derivePositionValue(allocatedEur, entryPrice, currentPrice, pnlEur) {
  if (entryPrice > 0 && currentPrice > 0 && allocatedEur > 0) {
    const estimatedShares = allocatedEur / entryPrice;
    return round(estimatedShares * currentPrice, 2);
  }

  if (allocatedEur > 0 && Number.isFinite(pnlEur)) {
    return round(allocatedEur + pnlEur, 2);
  }

  return null;
}

function deriveEstimatedShares(allocatedEur, entryPrice) {
  if (allocatedEur > 0 && entryPrice > 0) {
    return round(allocatedEur / entryPrice, 6);
  }
  return null;
}

function deriveCustomerStatus({ hasPrice, hasScore, hasNews }) {
  if (!hasPrice && !hasScore) return "building";
  if (hasPrice && hasScore && hasNews) return "ready";
  if (hasPrice || hasScore) return "partial";
  return "failed";
}

function buildMissingComponents({ hasPrice, hasScore, hasNews }) {
  const missing = [];
  if (!hasPrice) missing.push("price");
  if (!hasScore) missing.push("score");
  if (!hasNews) missing.push("news");
  return missing;
}

function buildCustomerMessage(status, missingComponents = []) {
  if (status === "building") {
    return "Diese Aktie wird gerade aufgebaut.";
  }

  if (status === "partial") {
    if (!missingComponents.length) {
      return "Die Analyse ist aktuell nur teilweise verfügbar.";
    }

    if (missingComponents.length === 1) {
      return `Ein Baustein fehlt aktuell: ${missingComponents[0]}.`;
    }

    return `Einige Bausteine fehlen aktuell: ${missingComponents.join(", ")}.`;
  }

  if (status === "failed") {
    return "Diese Aktie konnte aktuell nicht vollständig verarbeitet werden.";
  }

  return null;
}

function formatNewsBucket(bucket) {
  const summary = bucket?.summary && typeof bucket.summary === "object" ? bucket.summary : {};
  const items = Array.isArray(bucket?.items) ? bucket.items : [];

  return {
    summary: {
      count: safeNum(summary.count, 0),
      avgRelevance: safeNum(summary.avgRelevance, 0),
      avgConfidence: safeNum(summary.avgConfidence, 0),
      bullishCount: safeNum(summary.bullishCount, 0),
      bearishCount: safeNum(summary.bearishCount, 0),
      neutralCount: safeNum(summary.neutralCount, 0),
      dominantEventType: summary.dominantEventType || null,
      topHeadline: summary.topHeadline || null,
      topRelevanceScore: safeNum(summary.topRelevanceScore, 0),
    },
    items: items.slice(0, 3).map((item) => ({
      title: item?.title || null,
      source: item?.source || null,
      publishedAt: item?.publishedAt || null,
      url: item?.url || null,
      summary: item?.summary || null,
      intelligence: {
        direction: item?.intelligence?.direction || null,
        eventType: item?.intelligence?.eventType || null,
        relevanceScore: safeNullableNum(item?.intelligence?.relevanceScore),
        confidence: safeNullableNum(item?.intelligence?.confidence),
      },
    })),
  };
}

/* ──────────────────────────────────────────────────────────
   Main
────────────────────────────────────────────────────────── */

async function getPortfolioPositionsView({
  status = "open",
  limit = 50,
  offset = 0,
} = {}) {
  const normalizedStatus = normalizeStatusFilter(status);

  try {
    const positions = await listVirtualPositions({
      status: normalizedStatus,
      limit: Math.min(Number(limit) || 50, 200),
      offset: Math.max(Number(offset) || 0, 0),
    });

    if (!positions.length) {
      return {
        success: true,
        generatedAt: new Date().toISOString(),
        summary: {
          totalPositions: 0,
          readyCount: 0,
          partialCount: 0,
          buildingCount: 0,
          failedCount: 0,
        },
        portfolio: {
          score: null,
          rating: null,
          riskLevel: null,
          availableCount: 0,
          missingCount: 0,
        },
        positions: [],
      };
    }

    const symbols = uniqueSymbols(positions);

    const [marketMap, contextMap, newsBySymbol] = await Promise.all([
      buildMarketMap(symbols),
      buildPortfolioContextForSymbols(symbols),
      getStructuredMarketNewsBySymbols(symbols, 3, {
        minRelevance: 0,
      }),
    ]);

    const portfolioInput = buildPortfolioInputForHqs(positions, marketMap);
    const portfolioHqsResult = await calculatePortfolioHQS(portfolioInput);
    const hqsBreakdownMap = buildHqsBreakdownMap(portfolioHqsResult);

    let readyCount = 0;
    let partialCount = 0;
    let buildingCount = 0;
    let failedCount = 0;

    const viewPositions = positions.map((position) => {
      const symbol = String(position?.symbol || "").trim().toUpperCase();
      const marketItem = marketMap.get(symbol) || null;
      const hqsItem = hqsBreakdownMap.get(symbol) || null;
      const context = contextMap.get(symbol) || null;
      const news = formatNewsBucket(newsBySymbol?.[symbol] || { items: [], summary: {} });

      const allocatedEur = safeNum(position?.allocatedEur, 0);
      const entryPrice = safeNullableNum(position?.entryPrice);
      const currentPrice =
        safeNullableNum(marketItem?.price) ??
        safeNullableNum(position?.currentPrice);

      const pnlAbs =
        safeNullableNum(position?.pnlEur) ??
        (allocatedEur > 0 && entryPrice && currentPrice
          ? round(allocatedEur * ((currentPrice - entryPrice) / entryPrice), 2)
          : null);

      const pnlPct =
        safeNullableNum(position?.pnlPct) !== null
          ? round(safeNum(position.pnlPct) * 100, 2)
          : entryPrice && currentPrice
            ? round(((currentPrice - entryPrice) / entryPrice) * 100, 2)
            : null;

      const hasPrice = currentPrice !== null;
      const hasScore = Boolean(hqsItem?.available === true && hqsItem?.hqsScore !== null);
      const hasNews = safeNum(news?.summary?.count, 0) > 0;

      const status = deriveCustomerStatus({ hasPrice, hasScore, hasNews });
      const missingComponents = buildMissingComponents({ hasPrice, hasScore, hasNews });
      const message = buildCustomerMessage(status, missingComponents);

      if (status === "ready") readyCount += 1;
      else if (status === "partial") partialCount += 1;
      else if (status === "building") buildingCount += 1;
      else failedCount += 1;

      return {
        symbol,
        name: marketItem?.name || null,

        position: {
          source: "virtual_positions",
          allocatedEur: round(allocatedEur, 2),
          allocatedPct: safeNullableNum(position?.allocatedPct),
          entryPrice,
          currentPrice,
          estimatedShares: deriveEstimatedShares(allocatedEur, entryPrice),
          positionValue: derivePositionValue(allocatedEur, entryPrice, currentPrice, pnlAbs),
          pnlAbs,
          pnlPct,
          openedAt: position?.openedAt || null,
          updatedAt: position?.updatedAt || null,
          convictionTier: position?.convictionTier || null,
          riskModeAtEntry: position?.riskModeAtEntry || null,
        },

        status,
        message,
        missingComponents,

        score: hasScore
          ? {
              hqsScore: safeNullableNum(hqsItem?.hqsScore),
              rating: hqsItem?.rating || null,
              decision: hqsItem?.decision || null,
              source: hqsItem?.source || "database",
            }
          : null,

        market: {
          regime: marketItem?.regime || null,
          trend: marketItem?.trend || null,
          volatility: safeNullableNum(marketItem?.volatility),
          finalDecision: marketItem?.finalDecision || null,
          finalRating: marketItem?.finalRating || null,
          finalConfidence: safeNullableNum(marketItem?.finalConfidence),
          whyInteresting: Array.isArray(marketItem?.whyInteresting)
            ? marketItem.whyInteresting
            : [],
        },

        context: context || null,
        news,
      };
    });

    return {
      success: true,
      generatedAt: new Date().toISOString(),
      summary: {
        totalPositions: viewPositions.length,
        readyCount,
        partialCount,
        buildingCount,
        failedCount,
      },
      portfolio: {
        score: safeNullableNum(portfolioHqsResult?.portfolioScore),
        rating: portfolioHqsResult?.rating || null,
        riskLevel: portfolioHqsResult?.riskLevel || null,
        availableCount: safeNum(portfolioHqsResult?.meta?.availableCount, 0),
        missingCount: safeNum(portfolioHqsResult?.meta?.missingCount, 0),
      },
      positions: viewPositions,
    };
  } catch (error) {
    logger.error("[portfolioView] getPortfolioPositionsView failed", {
      message: error.message,
      stack: error.stack,
    });

    return {
      success: false,
      generatedAt: new Date().toISOString(),
      summary: {
        totalPositions: 0,
        readyCount: 0,
        partialCount: 0,
        buildingCount: 0,
        failedCount: 1,
      },
      portfolio: {
        score: null,
        rating: null,
        riskLevel: null,
        availableCount: 0,
        missingCount: 0,
      },
      positions: [],
      error: "Portfolio-Ansicht konnte nicht geladen werden.",
    };
  }
}

module.exports = {
  getPortfolioPositionsView,
};
