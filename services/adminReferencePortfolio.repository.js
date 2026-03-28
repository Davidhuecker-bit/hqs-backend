"use strict";

/**
 * Admin Reference Portfolio Repository
 *
 * Canonical source: admin_reference_portfolio table.
 * No dependency on briefing/watchlist/demo tables.
 *
 * Provides:
 *  - initAdminReferencePortfolioTable()  – CREATE TABLE + seed if empty
 *  - getActiveReferenceSymbols()         – ordered list of active symbols+names
 *  - upsertReferencePortfolioEntry()     – add/update a single entry
 *  - enrichReferencePortfolio()          – batch-load snapshots, HQS scores,
 *                                          advanced metrics, news count, outcome
 */

const { getSharedPool } = require("../config/database");

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

const pool = getSharedPool();

// ── initial seed (24 liquid US equities) ─────────────────────────────────────
const INITIAL_SEED = [
  { symbol: "AAPL",  name: "Apple Inc.",                   position_order: 1 },
  { symbol: "MSFT",  name: "Microsoft Corp.",               position_order: 2 },
  { symbol: "GOOGL", name: "Alphabet Inc.",                 position_order: 3 },
  { symbol: "AMZN",  name: "Amazon.com Inc.",               position_order: 4 },
  { symbol: "NVDA",  name: "NVIDIA Corp.",                  position_order: 5 },
  { symbol: "META",  name: "Meta Platforms Inc.",           position_order: 6 },
  { symbol: "TSLA",  name: "Tesla Inc.",                    position_order: 7 },
  { symbol: "AVGO",  name: "Broadcom Inc.",                 position_order: 8 },
  { symbol: "JPM",   name: "JPMorgan Chase & Co.",          position_order: 9 },
  { symbol: "JNJ",   name: "Johnson & Johnson",             position_order: 10 },
  { symbol: "V",     name: "Visa Inc.",                     position_order: 11 },
  { symbol: "PG",    name: "Procter & Gamble Co.",          position_order: 12 },
  { symbol: "MA",    name: "Mastercard Inc.",               position_order: 13 },
  { symbol: "HD",    name: "The Home Depot Inc.",           position_order: 14 },
  { symbol: "UNH",   name: "UnitedHealth Group Inc.",       position_order: 15 },
  { symbol: "MRK",   name: "Merck & Co. Inc.",              position_order: 16 },
  { symbol: "ABBV",  name: "AbbVie Inc.",                   position_order: 17 },
  { symbol: "LLY",   name: "Eli Lilly and Co.",             position_order: 18 },
  { symbol: "COST",  name: "Costco Wholesale Corp.",        position_order: 19 },
  { symbol: "PEP",   name: "PepsiCo Inc.",                  position_order: 20 },
  { symbol: "KO",    name: "The Coca-Cola Co.",             position_order: 21 },
  { symbol: "WMT",   name: "Walmart Inc.",                  position_order: 22 },
  { symbol: "XOM",   name: "Exxon Mobil Corp.",             position_order: 23 },
  { symbol: "CVX",   name: "Chevron Corp.",                 position_order: 24 },
];

// ── table init + seed ─────────────────────────────────────────────────────────

async function initAdminReferencePortfolioTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_reference_portfolio (
      id             SERIAL PRIMARY KEY,
      symbol         TEXT        NOT NULL UNIQUE,
      name           TEXT        NOT NULL DEFAULT '',
      position_order INTEGER     NOT NULL DEFAULT 999,
      is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
      note           TEXT,
      created_at     TIMESTAMP   NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMP   NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_arp_is_active_order
    ON admin_reference_portfolio (is_active, position_order);
  `);

  // Seed only when table is empty
  const { rows } = await pool.query("SELECT COUNT(*) AS cnt FROM admin_reference_portfolio");
  const count = parseInt(rows[0]?.cnt ?? "0", 10);
  if (count === 0) {
    for (const entry of INITIAL_SEED) {
      await pool.query(
        `
        INSERT INTO admin_reference_portfolio (symbol, name, position_order, is_active)
        VALUES ($1, $2, $3, TRUE)
        ON CONFLICT (symbol) DO NOTHING
        `,
        [entry.symbol, entry.name, entry.position_order]
      );
    }
    if (logger?.info) logger.info(`admin_reference_portfolio: seeded initial ${INITIAL_SEED.length} entries`);
  }

  if (logger?.info) logger.info("admin_reference_portfolio ready");
}

// ── read ──────────────────────────────────────────────────────────────────────

/**
 * Returns all active entries ordered by position_order.
 * @returns {Promise<Array<{symbol:string, name:string, position_order:number, note:string|null}>>}
 */
async function getActiveReferenceSymbols() {
  const { rows } = await pool.query(`
    SELECT symbol, name, position_order, note
    FROM admin_reference_portfolio
    WHERE is_active = TRUE
    ORDER BY position_order ASC, symbol ASC
  `);
  return rows.map((r) => ({
    symbol: r.symbol,
    name: r.name,
    position_order: r.position_order,
    note: r.note ?? null,
  }));
}

// ── write ─────────────────────────────────────────────────────────────────────

/**
 * Insert or update a reference portfolio entry.
 * @param {{symbol:string, name?:string, position_order?:number, is_active?:boolean, note?:string}} entry
 */
async function upsertReferencePortfolioEntry({ symbol, name, position_order, is_active, note }) {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) throw new Error("symbol is required");

  await pool.query(
    `
    INSERT INTO admin_reference_portfolio (symbol, name, position_order, is_active, note, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (symbol) DO UPDATE SET
      name           = COALESCE(EXCLUDED.name,           admin_reference_portfolio.name),
      position_order = COALESCE(EXCLUDED.position_order, admin_reference_portfolio.position_order),
      is_active      = COALESCE(EXCLUDED.is_active,      admin_reference_portfolio.is_active),
      note           = EXCLUDED.note,
      updated_at     = NOW()
    `,
    [
      sym,
      name != null ? String(name) : null,
      position_order != null ? Number(position_order) : null,
      is_active != null ? Boolean(is_active) : null,
      note != null ? String(note) : null,
    ]
  );
}

// ── enrichment batch helpers ──────────────────────────────────────────────────

/**
 * Batch-load latest market snapshots.
 * Returns Map<SYMBOL, snapshotRow>.
 */
async function _batchSnapshots(symbols) {
  const map = new Map();
  if (!symbols.length) return map;
  try {
    const { rows } = await pool.query(
      `
      SELECT DISTINCT ON (symbol)
        symbol, price, price_usd, changes_percentage, created_at AS snapshot_at
      FROM market_snapshots
      WHERE symbol = ANY($1::text[])
      ORDER BY symbol, created_at DESC NULLS LAST
      `,
      [symbols]
    );
    for (const r of rows) {
      map.set(r.symbol, {
        price: r.price !== null ? Number(r.price) : null,
        priceUsd: r.price_usd !== null ? Number(r.price_usd) : null,
        changePercent: r.changes_percentage !== null ? Number(r.changes_percentage) : null,
        snapshotAt: r.snapshot_at ? new Date(r.snapshot_at).toISOString() : null,
      });
    }
  } catch (err) {
    if (logger?.warn) logger.warn("adminReferencePortfolio: snapshots batch error", { message: err.message });
  }
  return map;
}

/**
 * Batch-load latest HQS scores.
 * Returns Map<SYMBOL, hqsRow>.
 */
async function _batchHqsScores(symbols) {
  const map = new Map();
  if (!symbols.length) return map;
  try {
    const { rows } = await pool.query(
      `
      SELECT DISTINCT ON (symbol)
        symbol, hqs_score, regime, created_at AS score_at
      FROM hqs_scores
      WHERE symbol = ANY($1::text[])
      ORDER BY symbol, created_at DESC NULLS LAST
      `,
      [symbols]
    );
    for (const r of rows) {
      map.set(r.symbol, {
        hqsScore: r.hqs_score !== null ? Number(r.hqs_score) : null,
        regime: r.regime ?? null,
        scoreAt: r.score_at ? new Date(r.score_at).toISOString() : null,
      });
    }
  } catch (err) {
    if (logger?.warn) logger.warn("adminReferencePortfolio: hqs_scores batch error", { message: err.message });
  }
  return map;
}

/**
 * Batch-load latest advanced metrics.
 * Returns Map<SYMBOL, metricsRow>.
 */
async function _batchAdvancedMetrics(symbols) {
  const map = new Map();
  if (!symbols.length) return map;
  try {
    const { rows } = await pool.query(
      `
      SELECT DISTINCT ON (symbol)
        symbol, regime, trend, volatility_annual, updated_at AS metrics_at
      FROM market_advanced_metrics
      WHERE symbol = ANY($1::text[])
      ORDER BY symbol, updated_at DESC NULLS LAST
      `,
      [symbols]
    );
    for (const r of rows) {
      map.set(r.symbol, {
        regime: r.regime ?? null,
        trend: r.trend !== null ? Number(r.trend) : null,
        volatilityAnnual: r.volatility_annual !== null ? Number(r.volatility_annual) : null,
        metricsAt: r.metrics_at ? new Date(r.metrics_at).toISOString() : null,
      });
    }
  } catch (err) {
    if (logger?.warn) logger.warn("adminReferencePortfolio: advanced_metrics batch error", { message: err.message });
  }
  return map;
}

/**
 * Batch-load news counts per symbol.
 * Returns Map<SYMBOL, count>.
 */
async function _batchNewsCount(symbols) {
  const map = new Map();
  if (!symbols.length) return map;
  try {
    const { rows } = await pool.query(
      `
      SELECT symbol, COUNT(*) AS news_count
      FROM market_news
      WHERE symbol = ANY($1::text[])
        AND lifecycle_state NOT IN ('expired', 'archived')
      GROUP BY symbol
      `,
      [symbols]
    );
    for (const r of rows) {
      map.set(r.symbol, parseInt(r.news_count, 10));
    }
  } catch (err) {
    if (logger?.warn) logger.warn("adminReferencePortfolio: news count batch error", { message: err.message });
  }
  return map;
}

/**
 * Batch-load latest outcome tracking by symbol.
 * Returns Map<SYMBOL, outcomeRow>.
 */
async function _batchOutcomes(symbols) {
  const map = new Map();
  if (!symbols.length) return map;
  try {
    const { rows } = await pool.query(
      `
      SELECT DISTINCT ON (symbol)
        symbol, final_conviction, final_confidence, regime, predicted_at
      FROM outcome_tracking
      WHERE symbol = ANY($1::text[])
        AND prediction_type = 'market_view'
      ORDER BY symbol, predicted_at DESC NULLS LAST, id DESC
      `,
      [symbols]
    );
    for (const r of rows) {
      map.set(r.symbol, {
        finalConviction: r.final_conviction !== null ? Number(r.final_conviction) : null,
        finalConfidence: r.final_confidence !== null ? Number(r.final_confidence) : null,
        outcomeRegime: r.regime ?? null,
        predictedAt: r.predicted_at ? new Date(r.predicted_at).toISOString() : null,
      });
    }
  } catch (err) {
    if (logger?.warn) logger.warn("adminReferencePortfolio: outcomes batch error", { message: err.message });
  }
  return map;
}

// ── conviction bucketing thresholds ──────────────────────────────────────────
const CONVICTION_STRONG_BULLISH = 65;
const CONVICTION_BULLISH = 55;
const CONVICTION_BEARISH = 45;
const CONVICTION_STRONG_BEARISH = 35;

/**
 * Derive a human-readable recommendation label from final_conviction.
 * Mirrors the bucketing used elsewhere in the codebase.
 * @param {number|null} conviction
 * @returns {string|null}
 */
function _convictionToRecommendation(conviction) {
  if (conviction === null || conviction === undefined) return null;
  const v = Number(conviction);
  if (!Number.isFinite(v)) return null;
  if (v >= CONVICTION_STRONG_BULLISH) return "strong_bullish";
  if (v >= CONVICTION_BULLISH) return "bullish";
  if (v <= CONVICTION_STRONG_BEARISH) return "strong_bearish";
  if (v <= CONVICTION_BEARISH) return "bearish";
  return "neutral";
}

// ── main enrichment function ──────────────────────────────────────────────────

/**
 * Enrich a list of reference entries with live backend data.
 *
 * @param {Array<{symbol:string, name:string, position_order:number, note:string|null}>} entries
 * @returns {Promise<{items: Array, summary: object}>}
 */
async function enrichReferencePortfolio(entries) {
  const symbols = entries.map((e) => e.symbol);

  const [snapshots, hqsScores, advancedMetrics, newsCounts, outcomes] =
    await Promise.all([
      _batchSnapshots(symbols),
      _batchHqsScores(symbols),
      _batchAdvancedMetrics(symbols),
      _batchNewsCount(symbols),
      _batchOutcomes(symbols),
    ]);

  let fullyServed = 0;
  let partiallyServed = 0;
  const missingComponentCounts = {};

  const items = entries.map((entry) => {
    const sym = entry.symbol;
    const snap = snapshots.get(sym) ?? null;
    const hqs = hqsScores.get(sym) ?? null;
    const adv = advancedMetrics.get(sym) ?? null;
    const newsCount = newsCounts.get(sym) ?? 0;
    const outcome = outcomes.get(sym) ?? null;

    const hasSnapshot = snap !== null;
    const hasScore = hqs !== null;
    const hasMetrics = adv !== null;
    const hasNews = newsCount > 0;

    const missing = [];
    if (!hasSnapshot) missing.push("snapshot");
    if (!hasScore) missing.push("hqsScore");
    if (!hasMetrics) missing.push("metrics");
    if (!hasNews) missing.push("news");

    for (const c of missing) {
      missingComponentCounts[c] = (missingComponentCounts[c] ?? 0) + 1;
    }

    const isFull = missing.length === 0;
    if (isFull) fullyServed += 1;
    else partiallyServed += 1;

    // Regime: prefer advanced metrics, fall back to hqs, then outcome
    const regime = adv?.regime ?? hqs?.regime ?? outcome?.outcomeRegime ?? null;

    return {
      symbol: sym,
      name: entry.name,
      positionOrder: entry.position_order,
      note: entry.note,

      // market data
      price: snap?.price ?? null,
      priceUsd: snap?.priceUsd ?? null,
      changePercent: snap?.changePercent ?? null,

      // scoring
      hqsScore: hqs?.hqsScore ?? null,
      regime,

      // signal – derived from outcome conviction (no separate signal_history table)
      recommendation: _convictionToRecommendation(outcome?.finalConviction),
      signalStrength: outcome?.finalConviction ?? null,

      // component flags
      hasSnapshot,
      hasScore,
      hasMetrics,
      hasNews,
      newsCount,

      // outcome
      lastOutcomeConviction: outcome?.finalConviction ?? null,
      lastOutcomeConfidence: outcome?.finalConfidence ?? null,
      lastOutcomePredictedAt: outcome?.predictedAt ?? null,

      // component timestamps
      snapshotAt: snap?.snapshotAt ?? null,
      scoreAt: hqs?.scoreAt ?? null,
      metricsAt: adv?.metricsAt ?? null,

      missingComponents: missing,
    };
  });

  // Most-missing component
  let mostMissingComponent = null;
  let maxMissing = 0;
  for (const [comp, cnt] of Object.entries(missingComponentCounts)) {
    if (cnt > maxMissing) {
      maxMissing = cnt;
      mostMissingComponent = comp;
    }
  }

  const summary = {
    totalSymbols: items.length,
    fullyServed,
    partiallyServed,
    missingComponents: missingComponentCounts,
    mostMissingComponent,
    lastUpdate: new Date().toISOString(),
  };

  return { items, summary };
}

// ── exports ───────────────────────────────────────────────────────────────────

module.exports = {
  initAdminReferencePortfolioTable,
  getActiveReferenceSymbols,
  upsertReferencePortfolioEntry,
  enrichReferencePortfolio,
};
