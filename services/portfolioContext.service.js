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
      alreadyOwned:        boolean   – open virtual position exists
      onWatchlist:         boolean   – symbol is in active watchlist
      novelty:             boolean   – not owned AND not on watchlist (new discovery)
      duplicationRisk:     boolean   – already owned (adding more = concentration risk)
      portfolioFit:        'owned' | 'watchlist' | 'new'
      portfolioContextLabel: string  – German UI label
    }

  Design rules:
    - One round-trip per symbol set (two queries total, not N)
    - Graceful fallback: unknown context when DB is unavailable
    - No live provider calls, no new tables, no new background jobs
*/

const { Pool } = require("pg");
const logger = require("../utils/logger");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* ─── fallback context ─────────────────────────────────────────────────────── */

const UNKNOWN_CONTEXT = Object.freeze({
  alreadyOwned:         false,
  onWatchlist:          false,
  novelty:              false,
  duplicationRisk:      false,
  portfolioFit:         "new",
  portfolioContextLabel: "Kein Kontext verfügbar",
});

/* ─── helpers ──────────────────────────────────────────────────────────────── */

function buildContext(owned, watched) {
  if (owned) {
    return {
      alreadyOwned:         true,
      onWatchlist:          watched,
      novelty:              false,
      duplicationRisk:      true,
      portfolioFit:         "owned",
      portfolioContextLabel: "Bereits im Portfolio – Aufstockung prüfen",
    };
  }
  if (watched) {
    return {
      alreadyOwned:         false,
      onWatchlist:          true,
      novelty:              false,
      duplicationRisk:      false,
      portfolioFit:         "watchlist",
      portfolioContextLabel: "Auf Beobachtungsliste – Einstiegs-Signal",
    };
  }
  return {
    alreadyOwned:         false,
    onWatchlist:          false,
    novelty:              true,
    duplicationRisk:      false,
    portfolioFit:         "new",
    portfolioContextLabel: "Neue Entdeckung – erste Prüfung empfohlen",
  };
}

/* ─── main export ──────────────────────────────────────────────────────────── */

/**
 * Load portfolio context for an array of symbols in two DB round-trips.
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
    // ── 1. Open virtual positions ──────────────────────────────────────────
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

    // ── 3. Build context per symbol ────────────────────────────────────────
    for (const sym of upper) {
      ctxMap.set(sym, buildContext(ownedSet.has(sym), watchedSet.has(sym)));
    }

    logger.debug("[portfolioContext] context built", {
      total:   upper.length,
      owned:   ownedSet.size,
      watched: watchedSet.size,
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
