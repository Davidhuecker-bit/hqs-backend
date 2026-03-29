"use strict";

/*
  Portfolio View Service
  ----------------------
  Baut die kanonische Kundensicht für Depotpositionen auf Basis
  der vorhandenen Backend-Bausteine.

  Ziele dieser Version:
    - bessere Firmennamen-Fallbacks
    - einfache, kundentaugliche Sprache
    - weniger rohe Systembegriffe im Response
    - keine Schattenlogik außerhalb des Backends
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

function normalizeSymbol(value) {
  return String(value || "").trim().toUpperCase();
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function resolveCompanyName(symbol, marketItem) {
  const rawName = firstNonEmptyString(
    marketItem?.name,
    marketItem?.companyName,
    marketItem?.shortName,
    marketItem?.displayName,
    marketItem?.securityName,
    marketItem?.instrumentName
  );

  if (rawName) return rawName;
  return symbol || "Unbekannter Wert";
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

function translateMissingComponent(component) {
  if (component === "price") return "Kurs";
  if (component === "score") return "Bewertung";
  if (component === "news") return "Nachrichten";
  return "Daten";
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
    return "Diese Aktie wird gerade für dein Depot aufgebaut.";
  }

  if (status === "partial") {
    if (!missingComponents.length) {
      return "Die Analyse ist aktuell nur teilweise verfügbar.";
    }

    const translated = missingComponents.map(translateMissingComponent);

    if (translated.length === 1) {
      return `Ein Baustein fehlt aktuell: ${translated[0]}.`;
    }

    return `Einige Bausteine fehlen aktuell: ${translated.join(", ")}.`;
  }

  if (status === "failed") {
    return "Diese Aktie konnte aktuell nicht vollständig verarbeitet werden.";
  }

  return null;
}

function translateDirection(direction) {
  const value = String(direction || "").trim().toLowerCase();
  if (value === "bullish" || value === "bull") return "positiv";
  if (value === "bearish" || value === "bear") return "negativ";
  if (value === "neutral") return "neutral";
  return null;
}

function translateRegime(regime) {
  const value = String(regime || "").trim().toLowerCase();

  if (!value) return null;
  if (value === "bull" || value === "bullish") return "positiv";
  if (value === "bear" || value === "bearish") return "negativ";
  if (value === "neutral") return "neutral";
  if (value === "expansion") return "Wachstumsphase";
  if (value === "contraction") return "Schwächephase";
  if (value === "recovery") return "Erholungsphase";
  if (value === "breakout") return "Ausbruch";
  if (value === "breakdown") return "Schwäche";
  return regime;
}

function translateTrend(trend) {
  const value = String(trend || "").trim().toLowerCase();

  if (!value) return null;
  if (value === "up" || value === "uptrend" || value === "rising") return "aufwärts";
  if (value === "down" || value === "downtrend" || value === "falling") return "abwärts";
  if (value === "sideways" || value === "flat") return "seitwärts";
  return trend;
}

function translateEventType(eventType) {
  const value = String(eventType || "").trim().toLowerCase();

  if (!value) return null;
  if (value === "product") return "Produkt";
  if (value === "earnings") return "Zahlen";
  if (value === "guidance") return "Ausblick";
  if (value === "m&a") return "Übernahme";
  if (value === "general_news") return "Allgemeine Nachrichten";
  if (value === "macro") return "Makro";
  return eventType;
}

function translateRating(rating, scoreValue) {
  const value = String(rating || "").trim().toLowerCase();

  if (value.includes("strong buy")) return "Sehr stark";
  if (value.includes("buy")) return "Stark";
  if (value.includes("hold")) return "Neutral";
  if (value.includes("sell")) return "Schwach";

  const score = safeNullableNum(scoreValue);
  if (score === null) return null;
  if (score >= 75) return "Sehr stark";
  if (score >= 65) return "Stark";
  if (score >= 50) return "Neutral";
  return "Schwach";
}

function translateDecision(decision, scoreValue) {
  const value = String(decision || "").trim().toLowerCase();

  if (!value) {
    const score = safeNullableNum(scoreValue);
    if (score === null) return null;
    if (score >= 75) return "Aufstocken möglich";
    if (score >= 60) return "Halten";
    if (score >= 45) return "Beobachten";
    return "Derzeit nicht im Fokus";
  }

  if (
    value.includes("strong_buy") ||
    value.includes("strong buy") ||
    value.includes("add") ||
    value.includes("accumulate")
  ) {
    return "Aufstocken möglich";
  }

  if (value.includes("buy") || value.includes("hold")) {
    return "Halten";
  }

  if (value.includes("watch") || value.includes("observe")) {
    return "Beobachten";
  }

  if (value.includes("ignore")) {
    return "Derzeit nicht im Fokus";
  }

  if (value.includes("sell") || value.includes("reduce")) {
    return "Vorsicht";
  }

  return decision;
}

function translateConvictionLabel(rating, scoreValue) {
  const value = String(rating || "").trim().toLowerCase();

  if (value.includes("low conviction")) return "Schwaches Vertrauen";
  if (value.includes("medium conviction")) return "Mittleres Vertrauen";
  if (value.includes("high conviction")) return "Hohes Vertrauen";

  const score = safeNullableNum(scoreValue);
  if (score === null) return null;
  if (score >= 75) return "Hohes Vertrauen";
  if (score >= 60) return "Solides Vertrauen";
  if (score >= 45) return "Mittleres Vertrauen";
  return "Schwaches Vertrauen";
}

function translatePortfolioFit(fit) {
  const value = String(fit || "").trim().toLowerCase();
  if (!value) return null;
  if (value === "owned") return "Bereits im Depot";
  if (value === "candidate") return "Mögliche Ergänzung";
  if (value === "watchlist") return "Auf der Beobachtungsliste";
  return fit;
}

function translateConcentrationRisk(risk) {
  const value = String(risk || "").trim().toLowerCase();
  if (!value) return null;
  if (value === "high") return "hoch";
  if (value === "medium") return "mittel";
  if (value === "low") return "niedrig";
  return risk;
}

function translateWhyInteresting(reasons = []) {
  if (!Array.isArray(reasons)) return [];

  return reasons
    .map((reason) => String(reason || "").trim())
    .filter(Boolean)
    .map((reason) => {
      const lower = reason.toLowerCase();

      if (lower.includes("strong trend")) return "starker Trend";
      if (lower.includes("high liquidity")) return "hohe Liquidität";
      if (lower.includes("fits momentum strategy")) return "passt zur Momentum-Strategie";
      if (lower.includes("active market signal")) return "aktives Marktsignal";
      if (lower.includes("news focus general_news")) return "Nachrichten-Fokus: allgemeine Nachrichten";
      return reason;
    });
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
      dominantEventType: translateEventType(summary.dominantEventType || null),
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
        direction: translateDirection(item?.intelligence?.direction || null),
        eventType: translateEventType(item?.intelligence?.eventType || null),
        relevanceScore: safeNullableNum(item?.intelligence?.relevanceScore),
        confidence: safeNullableNum(item?.intelligence?.confidence),
      },
    })),
  };
}

function normalizeContext(context) {
  if (!context || typeof context !== "object") return null;

  const fit = translatePortfolioFit(context.portfolioFit);
  const concentrationRisk = translateConcentrationRisk(context.concentrationRisk);
  const diversificationBenefit =
    typeof context.diversificationBenefit === "boolean"
      ? context.diversificationBenefit
      : null;

  let portfolioContextLabel = firstNonEmptyString(context.portfolioContextLabel);

  if (!portfolioContextLabel) {
    if (fit === "Bereits im Depot") {
      portfolioContextLabel = "Bereits im Depot – Aufstockung prüfen";
    } else if (fit === "Mögliche Ergänzung") {
      portfolioContextLabel = "Mögliche Ergänzung für dein Depot";
    } else if (fit === "Auf der Beobachtungsliste") {
      portfolioContextLabel = "Schon auf deiner Beobachtungsliste";
    }
  }

  return {
    ...context,
    portfolioFit: fit,
    portfolioContextLabel: portfolioContextLabel || "Einordnung verfügbar",
    concentrationRisk,
    diversificationBenefit,
  };
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
    const symbol = normalizeSymbol(position?.symbol);
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
    const symbol = normalizeSymbol(row?.symbol);
    if (!symbol) continue;
    map.set(symbol, row);
  }

  return map;
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
      const symbol = normalizeSymbol(position?.symbol);
      const marketItem = marketMap.get(symbol) || null;
      const hqsItem = hqsBreakdownMap.get(symbol) || null;
      const context = normalizeContext(contextMap.get(symbol) || null);
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
          ? round(safeNum(position?.pnlPct) * 100, 2)
          : entryPrice && currentPrice
            ? round(((currentPrice - entryPrice) / entryPrice) * 100, 2)
            : null;

      const hasPrice = currentPrice !== null;
      const hasScore = Boolean(hqsItem?.available === true && hqsItem?.hqsScore !== null);
      const hasNews = safeNum(news?.summary?.count, 0) > 0;

      const customerStatus = deriveCustomerStatus({ hasPrice, hasScore, hasNews });
      const missingComponents = buildMissingComponents({ hasPrice, hasScore, hasNews });
      const message = buildCustomerMessage(customerStatus, missingComponents);

      if (customerStatus === "ready") readyCount += 1;
      else if (customerStatus === "partial") partialCount += 1;
      else if (customerStatus === "building") buildingCount += 1;
      else failedCount += 1;

      const translatedRating = translateConvictionLabel(
        hqsItem?.rating || marketItem?.finalRating,
        hqsItem?.hqsScore
      );

      const translatedDecision = translateDecision(
        hqsItem?.decision || marketItem?.finalDecision,
        hqsItem?.hqsScore
      );

      return {
        symbol,
        name: resolveCompanyName(symbol, marketItem),

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

        status: customerStatus,
        message,
        missingComponents,

        score: hasScore
          ? {
              hqsScore: safeNullableNum(hqsItem?.hqsScore),
              rating: translatedRating,
              decision: translatedDecision,
              source: hqsItem?.source || "database",
            }
          : null,

        market: {
          regime: translateRegime(marketItem?.regime || null),
          trend: translateTrend(marketItem?.trend || null),
          volatility: safeNullableNum(marketItem?.volatility),
          finalDecision: translatedDecision,
          finalRating: translateRating(
            hqsItem?.rating || marketItem?.finalRating,
            hqsItem?.hqsScore
          ),
          finalConfidence: safeNullableNum(marketItem?.finalConfidence),
          whyInteresting: translateWhyInteresting(
            Array.isArray(marketItem?.whyInteresting) ? marketItem.whyInteresting : []
          ),
          directionLabel: translateDirection(marketItem?.regime || null),
        },

        context,
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
        rating: translateRating(
          portfolioHqsResult?.rating || null,
          portfolioHqsResult?.portfolioScore
        ),
        riskLevel: translateRegime(portfolioHqsResult?.riskLevel || null) || portfolioHqsResult?.riskLevel || null,
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
