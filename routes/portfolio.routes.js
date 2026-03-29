"use strict";

const express = require("express");
const router = express.Router();

const logger = require("../utils/logger");
const { getPortfolioPositionsView } = require("../services/portfolioView.service");

/* =========================================================
   HELPERS
========================================================= */

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.trunc(n);
}

function normalizeStatus(value) {
  const status = String(value || "open").trim().toLowerCase();
  if (status === "open" || status === "closed" || status === "all") return status;
  return "open";
}

function normalizeSort(value) {
  const sort = String(value || "symbol").trim().toLowerCase();

  // Diese Sorts können wir später im Service ausbauen,
  // ohne die Route nochmal anzufassen.
  if (
    [
      "symbol",
      "score",
      "pnl",
      "value",
      "updated",
      "status",
    ].includes(sort)
  ) {
    return sort;
  }

  return "symbol";
}

function normalizeDirection(value) {
  const dir = String(value || "asc").trim().toLowerCase();
  return dir === "desc" ? "desc" : "asc";
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function buildErrorResponse(message, generatedAt = new Date().toISOString()) {
  return {
    success: false,
    generatedAt,
    summary: {
      totalPositions: 0,
      readyCount: 0,
      buildingCount: 0,
      partialCount: 0,
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
    error: message,
  };
}

/* =========================================================
   GET /api/portfolio/positions
========================================================= */
/*
  Kanonische Kunden-Depotroute.

  Ziel:
    - liefert die fertige Depot-Positionssicht
    - Route bleibt stabil
    - spätere Erweiterungen passieren im Service, nicht hier

  Query params:
    - status=open|closed|all        (default: open)
    - limit=number                  (default: 50)
    - offset=number                 (default: 0)
    - sort=symbol|score|pnl|value|updated|status
    - direction=asc|desc
    - includeNews=true|false        (default: true)
    - includeContext=true|false     (default: true)
    - includeScore=true|false       (default: true)
    - includeSignals=true|false     (default: true)
    - includeOutlook=true|false     (default: true)
    - includeAgents=true|false      (default: true)
    - includeCompare=true|false     (default: true)

  WICHTIG:
    Auch wenn einige Blöcke im Service anfangs noch leer/null sind,
    bleibt die Route gleich. So müssen wir die Datei später nicht ständig anfassen.
*/
router.get("/positions", async (req, res) => {
  const generatedAt = new Date().toISOString();

  try {
    const status = normalizeStatus(req.query.status);
    const limit = parsePositiveInt(req.query.limit, 50);
    const offset = parsePositiveInt(req.query.offset, 0);
    const sort = normalizeSort(req.query.sort);
    const direction = normalizeDirection(req.query.direction);

    const includeNews = normalizeBoolean(req.query.includeNews, true);
    const includeContext = normalizeBoolean(req.query.includeContext, true);
    const includeScore = normalizeBoolean(req.query.includeScore, true);
    const includeSignals = normalizeBoolean(req.query.includeSignals, true);
    const includeOutlook = normalizeBoolean(req.query.includeOutlook, true);
    const includeAgents = normalizeBoolean(req.query.includeAgents, true);
    const includeCompare = normalizeBoolean(req.query.includeCompare, true);

    const result = await getPortfolioPositionsView({
      status,
      limit,
      offset,
      sort,
      direction,
      includeNews,
      includeContext,
      includeScore,
      includeSignals,
      includeOutlook,
      includeAgents,
      includeCompare,
    });

    if (!result || typeof result !== "object") {
      logger.error("[portfolio.routes] Invalid response from getPortfolioPositionsView");
      return res.status(500).json(
        buildErrorResponse("Portfolio-Ansicht konnte nicht korrekt erzeugt werden.", generatedAt)
      );
    }

    if (result.success === false) {
      return res.status(500).json({
        ...buildErrorResponse(
          result.error || "Portfolio-Ansicht konnte nicht geladen werden.",
          result.generatedAt || generatedAt
        ),
        ...(result.summary ? { summary: result.summary } : {}),
        ...(result.portfolio ? { portfolio: result.portfolio } : {}),
        ...(Array.isArray(result.positions) ? { positions: result.positions } : {}),
      });
    }

    return res.json({
      success: true,
      generatedAt: result.generatedAt || generatedAt,
      summary: result.summary || {
        totalPositions: 0,
        readyCount: 0,
        buildingCount: 0,
        partialCount: 0,
        failedCount: 0,
      },
      portfolio: result.portfolio || {
        score: null,
        rating: null,
        riskLevel: null,
        availableCount: 0,
        missingCount: 0,
      },
      positions: Array.isArray(result.positions) ? result.positions : [],
    });
  } catch (error) {
    logger.error("[portfolio.routes] GET /api/portfolio/positions failed", {
      message: error.message,
      stack: error.stack,
    });

    return res.status(500).json(
      buildErrorResponse(
        "Portfolio-Positionen konnten nicht geladen werden.",
        generatedAt
      )
    );
  }
});

/* =========================================================
   GET /api/portfolio/overview
========================================================= */
/*
  Optionaler Alias für spätere kompaktere Portfolio-Karten.
  Nutzt denselben Service, damit keine Doppellogik entsteht.
*/
router.get("/overview", async (req, res) => {
  const generatedAt = new Date().toISOString();

  try {
    const status = normalizeStatus(req.query.status || "open");

    const result = await getPortfolioPositionsView({
      status,
      limit: 200,
      offset: 0,
      sort: "symbol",
      direction: "asc",
      includeNews: true,
      includeContext: true,
      includeScore: true,
      includeSignals: true,
      includeOutlook: true,
      includeAgents: true,
      includeCompare: true,
    });

    if (!result || result.success === false) {
      return res.status(500).json(
        buildErrorResponse(
          result?.error || "Portfolio-Übersicht konnte nicht geladen werden.",
          result?.generatedAt || generatedAt
        )
      );
    }

    return res.json({
      success: true,
      generatedAt: result.generatedAt || generatedAt,
      summary: result.summary || {
        totalPositions: 0,
        readyCount: 0,
        buildingCount: 0,
        partialCount: 0,
        failedCount: 0,
      },
      portfolio: result.portfolio || {
        score: null,
        rating: null,
        riskLevel: null,
        availableCount: 0,
        missingCount: 0,
      },
      positions: Array.isArray(result.positions) ? result.positions : [],
    });
  } catch (error) {
    logger.error("[portfolio.routes] GET /api/portfolio/overview failed", {
      message: error.message,
      stack: error.stack,
    });

    return res.status(500).json(
      buildErrorResponse(
        "Portfolio-Übersicht konnte nicht geladen werden.",
        generatedAt
      )
    );
  }
});

module.exports = router;
