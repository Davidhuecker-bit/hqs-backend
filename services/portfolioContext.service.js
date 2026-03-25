"use strict";

/*
  Portfolio Context Service – Step 4: Personalized Decision Layer
  ---------------------------------------------------------------
  Enriches any set of symbols with customer-context signals derived from
  real existing data sources only (no new tables, no live provider calls):

    - virtual_positions  (open positions in the portfolio twin)
    - watchlist_symbols  (active tracked symbols)

  Exported:
    buildPortfolioContextForSymbols(symbols)   → Map<symbol, context>
    enrichWithPortfolioContext(item, ctxMap)   → item with portfolioContext merged

  Context shape per symbol:
    {
      alreadyOwned:              boolean   – open virtual position exists
      onWatchlist:               boolean   – symbol is in active watchlist
      novelty:                   boolean   – not owned AND not on watchlist
      duplicationRisk:           boolean   – already owned (adding more = concentration risk)
      portfolioFit:              'owned' | 'watchlist' | 'new'
      portfolioContextLabel:     string    – German UI label

      // Portfolio intelligence (Step 4 extension)
      sectorOverlap:             boolean   – candidate is in a sector already held
      concentrationRisk:         'high' | 'medium' | 'none'  – sector weight in portfolio
      diversificationBenefit:    boolean   – adds a sector not yet represented
      portfolioRole:             'additive' | 'redundant' | 'diversifier' | 'complement' | 'unknown'
      portfolioPriority:         'high' | 'medium' | 'low'  – derived from intelligence signals
      portfolioIntelligenceLabel: string | null  – German badge for UI
    }

  Design rules:
    - Three DB round-trips per symbol set (not N)
    - Graceful fallback: unknown context when DB is unavailable
    - No live provider calls, no new tables, no new background jobs
    - Sector mapping reuses getSector() from capitalAllocation.service
*/

const logger = require("../utils/logger");
const { getSector } = require("./capitalAllocation.service");

const { getSharedPool } = require("../config/database");
const pool = getSharedPool();
/* ─── fallback context ─────────────────────────────────────────────────────── */

const UNKNOWN_CONTEXT = Object.freeze({
  alreadyOwned:              false,
  onWatchlist:               false,
  novelty:                   false,
  duplicationRisk:           false,
  portfolioFit:              "new",
  portfolioContextLabel:     "Kein Kontext verfügbar",
  sectorOverlap:             false,
  concentrationRisk:         "none",
  diversificationBenefit:    false,
  portfolioRole:             "unknown",
  portfolioPriority:         "medium",
  portfolioIntelligenceLabel: null,
});

/* ─── helpers ──────────────────────────────────────────────────────────────── */

/**
 * Derive portfolio intelligence signals for a single candidate symbol.
 *
 * @param {string} candidateSector          – sector label for this symbol
 * @param {object} portfolioSectorBreakdown – sector → {positionCount, pct} from open positions
 */
function _buildIntelligence(candidateSector, portfolioSectorBreakdown) {
  const sectorData = portfolioSectorBreakdown && candidateSector
    ? (portfolioSectorBreakdown[candidateSector] || null)
    : null;
  const sectorOverlap       = sectorData !== null && sectorData.positionCount > 0;
  const currentSectorPct    = sectorData ? sectorData.pct : 0;
  const concentrationRisk   = currentSectorPct > 40 ? "high" : currentSectorPct > 25 ? "medium" : "none";
  return { sectorOverlap, concentrationRisk };
}

/**
 * Build the full context object for a single symbol.
 *
 * @param {boolean} owned
 * @param {boolean} watched
 * @param {string}  candidateSector
 * @param {object}  portfolioSectorBreakdown  – may be null when portfolio is empty
 */
function buildContext(owned, watched, candidateSector, portfolioSectorBreakdown) {
  const { sectorOverlap, concentrationRisk } = _buildIntelligence(
    candidateSector,
    portfolioSectorBreakdown
  );

  const diversificationBenefit = !owned && !sectorOverlap;

  let portfolioRole;
  if (owned) {
    portfolioRole = "additive";
  } else if (sectorOverlap) {
    portfolioRole = "redundant";
  } else if (!watched) {
    portfolioRole = "diversifier";
  } else {
    portfolioRole = "complement";
  }

  let portfolioPriority;
  if (diversificationBenefit && concentrationRisk === "none") {
    portfolioPriority = "high";
  } else if (concentrationRisk === "high" || owned) {
    portfolioPriority = "low";
  } else {
    portfolioPriority = "medium";
  }

  let portfolioIntelligenceLabel = null;
  if (concentrationRisk === "high") {
    portfolioIntelligenceLabel = "Erhöht Konzentrationsrisiko";
  } else if (concentrationRisk === "medium" && sectorOverlap) {
    portfolioIntelligenceLabel = "Sektorüberschneidung – prüfen";
  } else if (diversificationBenefit) {
    portfolioIntelligenceLabel = "Ergänzt Portfolio – neuer Sektor";
  } else if (portfolioRole === "redundant") {
    portfolioIntelligenceLabel = "Eher redundant – Sektor bereits vertreten";
  }

  const intelligence = {
    sectorOverlap,
    concentrationRisk,
    diversificationBenefit,
    portfolioRole,
    portfolioPriority,
    portfolioIntelligenceLabel,
  };

  if (owned) {
    return {
      alreadyOwned:          true,
      onWatchlist:           watched,
      novelty:               false,
      duplicationRisk:       true,
      portfolioFit:          "owned",
      portfolioContextLabel: "Bereits im Portfolio – Aufstockung prüfen",
      ...intelligence,
    };
  }
  if (watched) {
    return {
      alreadyOwned:          false,
      onWatchlist:           true,
      novelty:               false,
      duplicationRisk:       false,
      portfolioFit:          "watchlist",
      portfolioContextLabel: "Auf Beobachtungsliste – Einstiegs-Signal",
      ...intelligence,
    };
  }
  return {
    alreadyOwned:          false,
    onWatchlist:           false,
    novelty:               true,
    duplicationRisk:       false,
    portfolioFit:          "new",
    portfolioContextLabel: "Neue Entdeckung – erste Prüfung empfohlen",
    ...intelligence,
  };
}

/* ─── main export ──────────────────────────────────────────────────────────── */

/**
 * Load portfolio context for an array of symbols in three DB round-trips.
 *
 * Round-trip 1: owned symbols (filtered to candidates)
 * Round-trip 2: watchlist membership (filtered to candidates)
 * Round-trip 3: ALL open virtual positions (for portfolio sector breakdown)
 *
 * @param {string[]} symbols
 * @returns {Promise<Map<string, object>>}  key = UPPER-CASE symbol
 */
async function buildPortfolioContextForSymbols(symbols) {
  const ctxMap = new Map();
  if (!Array.isArray(symbols) || symbols.length === 0) return ctxMap;

  const upper = [...new Set(symbols.map((s) => String(s || "").trim().toUpperCase()).filter(Boolean))];
  if (upper.length === 0) return ctxMap;

  // Initialise all symbols with unknown context so callers always get a value.
  for (const sym of upper) {
    ctxMap.set(sym, { ...UNKNOWN_CONTEXT });
  }

  try {
    // ── 1. Open virtual positions (candidate symbols only) ─────────────────
    const vpRes = await pool.query(
      `SELECT DISTINCT symbol
         FROM virtual_positions
        WHERE status = 'open'
          AND symbol = ANY($1::text[])`,
      [upper]
    );
    const ownedSet = new Set(vpRes.rows.map((r) => String(r.symbol).toUpperCase()));

    // ── 2. Active watchlist symbols ────────────────────────────────────────
    const wlRes = await pool.query(
      `SELECT DISTINCT symbol
         FROM watchlist_symbols
        WHERE is_active = TRUE
          AND symbol = ANY($1::text[])`,
      [upper]
    );
    const watchedSet = new Set(wlRes.rows.map((r) => String(r.symbol).toUpperCase()));

    // ── 3. Portfolio sector breakdown (ALL open positions, not just candidates)
    //    Used to derive concentrationRisk / diversificationBenefit per candidate.
    const allOpenRes = await pool.query(
      `SELECT symbol, COALESCE(allocated_eur, 0) AS allocated_eur
         FROM virtual_positions
        WHERE status = 'open'`
    );
    const portfolioSectorBreakdown = {};
    let portfolioTotalEur = 0;
    for (const row of allOpenRes.rows) {
      const sec = getSector(String(row.symbol || "").toUpperCase());
      const eur = Number(row.allocated_eur) || 0;
      if (!portfolioSectorBreakdown[sec]) {
        portfolioSectorBreakdown[sec] = { allocatedEur: 0, positionCount: 0, pct: 0 };
      }
      portfolioSectorBreakdown[sec].allocatedEur += eur;
      portfolioSectorBreakdown[sec].positionCount++;
      portfolioTotalEur += eur;
    }
    if (portfolioTotalEur > 0) {
      for (const sec of Object.keys(portfolioSectorBreakdown)) {
        portfolioSectorBreakdown[sec].pct =
          Math.round((portfolioSectorBreakdown[sec].allocatedEur / portfolioTotalEur) * 10000) / 100;
      }
    }

    // ── 4. Build context per symbol ────────────────────────────────────────
    for (const sym of upper) {
      const candidateSector = getSector(sym);
      ctxMap.set(
        sym,
        buildContext(ownedSet.has(sym), watchedSet.has(sym), candidateSector, portfolioSectorBreakdown)
      );
    }

    logger.debug("[portfolioContext] context built", {
      total:    upper.length,
      owned:    ownedSet.size,
      watched:  watchedSet.size,
      sectors:  Object.keys(portfolioSectorBreakdown).length,
    });
  } catch (err) {
    logger.warn("[portfolioContext] buildPortfolioContextForSymbols failed – returning unknown context", {
      message: err.message,
    });
    // ctxMap already has UNKNOWN_CONTEXT for all symbols – safe fallback
  }

  return ctxMap;
}

/**
 * Merge portfolio context from ctxMap into an opportunity/stock item.
 * The original item is not mutated; a new object is returned.
 *
 * @param {object} item        – opportunity or stock object with a `symbol` field
 * @param {Map}    ctxMap      – result of buildPortfolioContextForSymbols
 * @returns {object}
 */
function enrichWithPortfolioContext(item, ctxMap) {
  const sym = String(item?.symbol || "").trim().toUpperCase();
  const ctx = ctxMap?.get(sym) || { ...UNKNOWN_CONTEXT };
  return { ...item, portfolioContext: ctx };
}

module.exports = {
  buildPortfolioContextForSymbols,
  enrichWithPortfolioContext,
};
