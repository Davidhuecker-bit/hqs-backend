"use strict";

/**
 * Symbol Summary Builder  (Read-Model Layer – canonical per-symbol output)
 * -------------------------------------------------------------------------
 * Builds and persists a canonical per-symbol summary, stored in the existing
 * ui_summaries table under the key  `symbol_summary:<SYMBOL>`  (e.g.
 * `symbol_summary:AAPL`).
 *
 * This follows the same SWR pattern used by marketSummary.builder.js and
 * guardianStatusSummary.builder.js.  No new table is introduced.
 *
 * Summary fields (see _buildPayload):
 *   symbol, name, price, change, changesPercentage, currency, source,
 *   snapshotTimestamp, hqsScore, rating, decision, finalConfidence, regime,
 *   trend, volatility, whyInteresting, maturityProfile (maturityLevel,
 *   maturityScore), newsSummary, status, missingComponents, updatedAt.
 *
 * Base-field source priority
 * ──────────────────────────
 *   name              : market_snapshots.name (N/A) → universe_symbols.name
 *                       → entity_map.company_name → null
 *   price             : market_snapshots.price → null
 *   change            : price − previousClose (direct) →
 *                       previousClose × changesPercentage / 100 → null
 *   changesPercentage : market_snapshots.changes_percentage → null
 *   currency          : market_snapshots.currency →
 *                       universe_symbols.currency → null
 *   snapshotTimestamp : market_snapshots.created_at → null
 *
 * Status logic:
 *   ready    – snapshot present with non-null price AND hqsScore present
 *   partial  – snapshot + price present but hqsScore or other core data missing
 *   building – no snapshot yet, OR snapshot exists but price is null
 *
 * missingComponents lists all absent pieces; core ones tracked explicitly:
 *   "snapshot" | "price" | "hqsScore" | "advancedMetrics" |
 *   "outcomeTracking" | "news" | "maturityProfile"
 *
 * Read path  : readSymbolSummary(symbol)          → single DB read
 * Build path : refreshSymbolSummary(symbol)       → fetch + write ui_summaries
 * Smart path : getOrBuildSymbolSummary(symbol)    → SWR: fresh→serve,
 *                                                     stale→serve+async,
 *                                                     missing→build sync
 *
 * Fresh threshold: 10 minutes (SYMBOL_SUMMARY_MAX_AGE_MS)
 * Per-symbol parallel-refresh guard: _refreshingSet prevents duplicate work.
 */

const logger = require("../utils/logger");
const { readUiSummary, writeUiSummary } = require("./uiSummary.repository");
const {
  loadLatestOutcomeTrackingBySymbols,
} = require("./outcomeTracking.repository");
const {
  loadAdvancedMetrics,
} = require("./advancedMetrics.repository");
const {
  loadLatestMarketNewsBySymbols,
} = require("./marketNews.repository");
const { getSharedPool } = require("../config/database");

const pool = getSharedPool();

// DB-persisted summary is considered fresh for 10 minutes.
const SYMBOL_SUMMARY_MAX_AGE_MS = 10 * 60 * 1000;

// Per-symbol refresh guard (Set<upperSymbol>).
const _refreshingSet = new Set();

/* =========================================================
   HELPERS
========================================================= */

function _summaryType(symbol) {
  return `symbol_summary:${String(symbol).trim().toUpperCase()}`;
}

function _safeNum(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function _safeStr(v, fallback = null) {
  if (v == null) return fallback;
  const s = String(v).trim();
  return s.length > 0 ? s : fallback;
}

/* =========================================================
   RAW DATA LOADERS
   Each loader catches its own errors so one missing source
   never blocks the whole summary build.
========================================================= */

/**
 * Load the latest market snapshot for a single symbol directly from DB.
 * Returns null if missing or on error.
 *
 * NOTE: market_snapshots has no `name` column; name resolution is done
 * separately via _loadName() which queries universe_symbols / entity_map.
 *
 * @param {string} symbol
 * @returns {Promise<object|null>}
 */
async function _loadSnapshot(symbol) {
  try {
    const res = await pool.query(
      `
      SELECT
        symbol, price, price_usd, open, high, low, volume,
        source, currency, fx_rate, changes_percentage, previous_close,
        created_at AS snapshot_ts
      FROM market_snapshots
      WHERE symbol = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [symbol]
    );
    if (!res.rows.length) return null;
    const row = res.rows[0];
    // Currency: preserve null so _buildPayload can apply the universe fallback.
    const currency = _safeStr(row.currency);
    return {
      symbol:            row.symbol,
      price:             _safeNum(row.price),
      priceUsd:          _safeNum(row.price_usd),
      changesPercentage: _safeNum(row.changes_percentage),
      previousClose:     _safeNum(row.previous_close),
      currency,
      source:            _safeStr(row.source),
      snapshotTimestamp: row.snapshot_ts ? new Date(row.snapshot_ts).toISOString() : null,
    };
  } catch (err) {
    logger.warn("[symbolSummary] _loadSnapshot failed", { symbol, message: err.message });
    return null;
  }
}

/**
 * Load the latest HQS score for a single symbol.
 * Returns null if missing or on error.
 * @param {string} symbol
 * @returns {Promise<object|null>}
 */
async function _loadHqs(symbol) {
  try {
    const res = await pool.query(
      `
      SELECT hqs_score, regime, created_at
      FROM hqs_scores
      WHERE symbol = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [symbol]
    );
    if (!res.rows.length) return null;
    const row = res.rows[0];
    return {
      hqsScore:     _safeNum(row.hqs_score),
      hqsRegime:    _safeStr(row.regime),
      hqsCreatedAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    };
  } catch (err) {
    logger.warn("[symbolSummary] _loadHqs failed", { symbol, message: err.message });
    return null;
  }
}

/**
 * Load company name and currency for a symbol.
 *
 * Priority:
 *   1. universe_symbols.name / universe_symbols.currency  (canonical active source)
 *   2. entity_map.company_name                            (secondary name fallback)
 *   3. null
 *
 * Returns { name: string|null, currency: string|null }.
 *
 * @param {string} symbol
 * @returns {Promise<{name: string|null, currency: string|null}>}
 */
async function _loadName(symbol) {
  try {
    const res = await pool.query(
      `
      SELECT
        COALESCE(u.name, e.company_name) AS resolved_name,
        u.currency                       AS currency
      FROM universe_symbols u
      FULL OUTER JOIN entity_map e ON e.symbol = u.symbol
      WHERE COALESCE(u.symbol, e.symbol) = $1
      LIMIT 1
      `,
      [symbol]
    );
    if (res.rows.length) {
      return {
        name:     _safeStr(res.rows[0].resolved_name),
        currency: _safeStr(res.rows[0].currency),
      };
    }
  } catch (_) {
    // Fallback: try universe_symbols only
    try {
      const r = await pool.query(
        `SELECT name, currency FROM universe_symbols WHERE symbol = $1 LIMIT 1`,
        [symbol]
      );
      if (r.rows.length) {
        return {
          name:     _safeStr(r.rows[0].name),
          currency: _safeStr(r.rows[0].currency),
        };
      }
    } catch (err2) {
      logger.warn("[symbolSummary] _loadName failed", { symbol, message: err2.message });
    }
  }
  return { name: null, currency: null };
}

/* =========================================================
   PAYLOAD BUILDER
========================================================= */

/**
 * Assemble the canonical symbol summary payload from all available sources.
 * Defensive: every source is optional; no null/NaN leaks.
 *
 * Base-field source priority (see file-level comment for full details):
 *   name              → universe_symbols / entity_map
 *   price             → market_snapshots.price
 *   change            → price − previousClose  (direct, primary)
 *                       OR previousClose × changesPercentage / 100 (fallback)
 *   changesPercentage → market_snapshots.changes_percentage
 *   currency          → market_snapshots.currency → universe_symbols.currency
 *   snapshotTimestamp → market_snapshots.created_at
 *
 * @param {string} symbol
 * @returns {Promise<object>}   Full payload ready for writeUiSummary.
 */
async function _buildPayload(symbol) {
  // Fetch all sources in parallel, each catches its own errors.
  const [snapshot, hqs, adv, outcomeMap, newsMap, nameMeta] = await Promise.all([
    _loadSnapshot(symbol),
    _loadHqs(symbol),
    loadAdvancedMetrics(symbol).catch((err) => {
      logger.warn("[symbolSummary] loadAdvancedMetrics failed", { symbol, message: err.message });
      return null;
    }),
    loadLatestOutcomeTrackingBySymbols([symbol]).catch((err) => {
      logger.warn("[symbolSummary] loadLatestOutcomeTrackingBySymbols failed", { symbol, message: err.message });
      return {};
    }),
    loadLatestMarketNewsBySymbols([symbol], 3).catch((err) => {
      logger.warn("[symbolSummary] loadLatestMarketNewsBySymbols failed", { symbol, message: err.message });
      return {};
    }),
    _loadName(symbol),  // returns { name, currency }
  ]);

  const tracked   = outcomeMap?.[symbol] ?? null;
  const finalView = tracked?.payload?.finalView ?? null;
  const matProf   = tracked?.payload?.maturityProfile ?? null;

  // ── name / currency resolution ────────────────────────────────────────────
  // name:     universe_symbols / entity_map (market_snapshots has no name column)
  // currency: market_snapshots.currency → universe_symbols.currency → null
  const resolvedName     = nameMeta?.name ?? null;
  const universeCurrency = nameMeta?.currency ?? null;
  const resolvedCurrency = snapshot?.currency ?? universeCurrency ?? null;

  // ── change: prefer direct price arithmetic over derived formula ───────────
  let resolvedChange = null;
  if (snapshot?.price != null && snapshot?.previousClose != null) {
    resolvedChange = _safeNum(snapshot.price - snapshot.previousClose);
  } else if (snapshot?.previousClose != null && snapshot?.changesPercentage != null) {
    resolvedChange = _safeNum(snapshot.previousClose * snapshot.changesPercentage / 100);
  }

  // ── news summary ──────────────────────────────────────────────────────────
  const newsItems = Array.isArray(newsMap?.[symbol]) ? newsMap[symbol] : [];
  const newsSummary = newsItems.map((n) => ({
    title:       _safeStr(n.title),
    source:      _safeStr(n.source),
    sentiment:   _safeStr(n.sentiment_raw ?? n.sentiment),
    publishedAt: n.published_at ? new Date(n.published_at).toISOString() : null,
  }));

  // ── determine missing components ─────────────────────────────────────────
  // Core (determine status tier):
  //   "snapshot" – no market data at all
  //   "price"    – snapshot row exists but price column is null
  //   "hqsScore" – no HQS score
  // Secondary (informational, don't block `ready`):
  //   "advancedMetrics" | "outcomeTracking" | "news" | "maturityProfile"
  const missingComponents = [];
  if (!snapshot) {
    missingComponents.push("snapshot");
  } else if (snapshot.price == null) {
    missingComponents.push("price");
  }
  if (!hqs?.hqsScore)         missingComponents.push("hqsScore");
  if (!adv)                   missingComponents.push("advancedMetrics");
  if (!tracked)               missingComponents.push("outcomeTracking");
  if (!newsSummary.length)    missingComponents.push("news");
  if (!matProf)               missingComponents.push("maturityProfile");

  // ── status ────────────────────────────────────────────────────────────────
  // building – no usable market data (no snapshot, or snapshot with null price)
  // ready    – snapshot with non-null price AND hqsScore present
  // partial  – snapshot + price present, but hqsScore or other core data missing
  let status;
  if (!snapshot || snapshot.price == null) {
    status = "building";
  } else if (hqs?.hqsScore != null) {
    status = "ready";
  } else {
    status = "partial";
  }

  // ── assemble final payload ────────────────────────────────────────────────
  return {
    symbol,
    name:              resolvedName,

    // price layer (from snapshot)
    price:             snapshot?.price ?? null,
    change:            resolvedChange,
    changesPercentage: snapshot?.changesPercentage ?? null,
    currency:          resolvedCurrency,
    source:            snapshot?.source ?? null,
    snapshotTimestamp: snapshot?.snapshotTimestamp ?? null,

    // HQS layer
    hqsScore:          hqs?.hqsScore ?? null,

    // final view (from outcome_tracking.payload.finalView)
    rating:            _safeStr(finalView?.finalRating),
    decision:          _safeStr(finalView?.finalDecision),
    finalConfidence:   _safeNum(finalView?.finalConfidence ?? tracked?.finalConfidence),
    whyInteresting:    Array.isArray(finalView?.whyInteresting) ? finalView.whyInteresting : [],

    // regime / trend / volatility
    regime:     _safeStr(hqs?.hqsRegime ?? adv?.regime ?? tracked?.regime),
    trend:      _safeNum(adv?.trend),
    volatility: _safeNum(adv?.volatility),

    // maturity (from outcome_tracking.payload.maturityProfile)
    maturityProfile: matProf
      ? {
          maturityLevel: _safeStr(matProf.maturityLevel),
          maturityScore: _safeNum(matProf.maturityScore),
          historyDays:   _safeNum(matProf.historyDays),
          hasNews:       Boolean(matProf.hasNews),
          warnings:      Array.isArray(matProf.warnings) ? matProf.warnings : [],
        }
      : null,
    maturityLevel: _safeStr(matProf?.maturityLevel),
    maturityScore: _safeNum(matProf?.maturityScore),

    // news
    newsSummary,

    // status
    status,
    missingComponents,
    updatedAt: new Date().toISOString(),
  };
}

/* =========================================================
   READ PATH
========================================================= */

/**
 * Read the prepared symbol summary from ui_summaries (single DB query).
 * Returns null if not found or on error.
 *
 * @param {string} symbol
 * @returns {Promise<object|null>}
 */
async function readSymbolSummary(symbol) {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) return null;

  const row = await readUiSummary(_summaryType(sym));
  if (!row) return null;

  const ageMs = row.builtAt ? Date.now() - new Date(row.builtAt).getTime() : Infinity;
  return {
    ...row.payload,
    builtAt:         row.builtAt,
    isPartial:       row.isPartial,
    buildDurationMs: row.buildDurationMs,
    ageMs,
    freshness: ageMs < SYMBOL_SUMMARY_MAX_AGE_MS ? "fresh" : "stale",
  };
}

/* =========================================================
   BUILD / REFRESH PATH
========================================================= */

/**
 * Build the symbol summary from DB sources and persist to ui_summaries.
 * Protected by a per-symbol parallel-refresh guard.
 *
 * @param {string} symbol
 * @returns {Promise<object|null>}  Built payload, or null on skip/failure.
 */
async function refreshSymbolSummary(symbol) {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) return null;

  if (_refreshingSet.has(sym)) {
    logger.info("[symbolSummary] refresh already in progress, skipping", { symbol: sym });
    return null;
  }

  _refreshingSet.add(sym);
  const t0 = Date.now();
  try {
    logger.info("[symbolSummary] building symbol summary", { symbol: sym });

    const payload = await _buildPayload(sym);
    const durationMs = Date.now() - t0;
    const isPartial  = payload.status !== "ready";

    await writeUiSummary(
      _summaryType(sym),
      payload,
      { buildDurationMs: durationMs, isPartial }
    );

    logger.info("[symbolSummary] summary built and persisted", {
      symbol: sym,
      status: payload.status,
      missingComponents: payload.missingComponents,
      durationMs,
    });

    return payload;
  } catch (err) {
    logger.warn("[symbolSummary] refresh failed", { symbol: sym, message: err.message });
    return null;
  } finally {
    _refreshingSet.delete(sym);
  }
}

/* =========================================================
   SMART PATH  (SWR-like on-demand, used by search / depot / radar)
========================================================= */

/**
 * Get the symbol summary with stale-while-revalidate logic:
 *   1. Fresh DB summary  → return immediately.
 *   2. Stale DB summary  → return stale + trigger async refresh.
 *   3. No DB summary     → build synchronously and return.
 *      If symbol is unknown / snapshot missing the returned status
 *      will be `building` – never an error or empty object.
 *
 * @param {string}  symbol
 * @param {{ maxAgeMs?: number }} [opts]
 * @returns {Promise<object>}
 */
async function getOrBuildSymbolSummary(symbol, { maxAgeMs = SYMBOL_SUMMARY_MAX_AGE_MS } = {}) {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) {
    return _buildingFallback("(unknown)");
  }

  const existing = await readSymbolSummary(sym);

  if (existing && existing.ageMs <= maxAgeMs) {
    return existing;
  }

  if (existing) {
    // Stale: return current data + async background refresh
    if (!_refreshingSet.has(sym)) {
      setImmediate(() =>
        refreshSymbolSummary(sym).catch((err) =>
          logger.warn("[symbolSummary] async SWR refresh failed", {
            symbol: sym,
            message: err.message,
          })
        )
      );
    }
    return existing;
  }

  // Cold path: no summary yet – build synchronously
  const built = await refreshSymbolSummary(sym);
  if (built) return { ...built, ageMs: 0, freshness: "fresh", isPartial: built.status !== "ready" };

  // Build itself failed (DB offline, etc.) – return an honest building fallback
  return _buildingFallback(sym);
}

/**
 * Minimal safe fallback when neither DB nor build is available.
 * @param {string} symbol
 * @returns {object}
 */
function _buildingFallback(symbol) {
  return {
    symbol,
    name:              null,
    price:             null,
    change:            null,
    changesPercentage: null,
    currency:          null,
    source:            null,
    snapshotTimestamp: null,
    hqsScore:          null,
    rating:            null,
    decision:          null,
    finalConfidence:   null,
    whyInteresting:    [],
    regime:            null,
    trend:             null,
    volatility:        null,
    maturityProfile:   null,
    maturityLevel:     null,
    maturityScore:     null,
    newsSummary:       [],
    status:            "building",
    missingComponents: ["snapshot", "hqsScore", "advancedMetrics", "outcomeTracking", "news", "maturityProfile"],
    updatedAt:         new Date().toISOString(),
    builtAt:           null,
    ageMs:             Infinity,
    freshness:         "missing",
    isPartial:         true,
    buildDurationMs:   null,
  };
}

module.exports = {
  readSymbolSummary,
  refreshSymbolSummary,
  getOrBuildSymbolSummary,
  SYMBOL_SUMMARY_MAX_AGE_MS,
};
