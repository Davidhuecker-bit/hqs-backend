"use strict";

/**
 * Admin Reference Portfolio Repository
 *
 * Canonical source: admin_reference_portfolio table.
 * No dependency on briefing/watchlist/demo tables.
 *
 * Provides:
 *  - initAdminReferencePortfolioTable()  – CREATE TABLE + seed if empty,
 *                                          enrolls all symbols into universe_symbols
 *                                          so the snapshot pipeline covers them
 *  - getActiveReferenceSymbols()         – ordered list of active symbols+names
 *  - upsertReferencePortfolioEntry()     – add/update a single entry (also
 *                                          enrolls in universe pipeline if active)
 *  - enrichReferencePortfolio()          – batch-load snapshots, HQS scores,
 *                                          advanced metrics, news count, outcome;
 *                                          includes per-symbol pipeline diagnostics
 */

const { getSharedPool } = require("../config/database");

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

// Lazy-load universe helpers to avoid potential circular-require issues at
// module load time.  Both functions are stable exports of universe.repository.
let _ensureTrackedSymbol = null;
let _initUniverseTables = null;
function _getUniverseHelpers() {
  if (!_ensureTrackedSymbol || !_initUniverseTables) {
    const ur = require("./universe.repository");
    _ensureTrackedSymbol = ur.ensureTrackedSymbol;
    _initUniverseTables = ur.initUniverseTables;
  }
  return { ensureTrackedSymbol: _ensureTrackedSymbol, initUniverseTables: _initUniverseTables };
}

const pool = getSharedPool();

// Priority used when enrolling reference portfolio symbols in universe_symbols.
// Lower value = scanned earlier in each batch cycle.
const REFERENCE_UNIVERSE_PRIORITY = 10;

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

  // Enroll all active reference symbols into universe_symbols so the snapshot
  // pipeline covers them.  This is the critical bridge: without it the symbols
  // exist only in the admin table and never receive market_snapshots / HQS
  // scores / advanced metrics from the writer pipeline.
  await _enrollActiveSymbolsInUniverse();

  if (logger?.info) logger.info("admin_reference_portfolio ready");
}

/**
 * Fetch all active reference symbols and register each one in universe_symbols
 * with high priority (REFERENCE_UNIVERSE_PRIORITY).  Idempotent – safe to call
 * on every startup.
 */
async function _enrollActiveSymbolsInUniverse() {
  try {
    const { initUniverseTables, ensureTrackedSymbol } = _getUniverseHelpers();
    await initUniverseTables();

    const { rows } = await pool.query(
      `SELECT symbol FROM admin_reference_portfolio WHERE is_active = TRUE ORDER BY position_order ASC`
    );

    let enrolled = 0;
    for (const row of rows) {
      const result = await ensureTrackedSymbol(row.symbol, {
        priority: REFERENCE_UNIVERSE_PRIORITY,
        source: "admin_reference_portfolio",
      });
      if (result?.enrolled) enrolled += 1;
    }

    if (logger?.info) {
      logger.info("admin_reference_portfolio: universe enrollment complete", {
        total: rows.length,
        newlyEnrolled: enrolled,
        priority: REFERENCE_UNIVERSE_PRIORITY,
      });
    }
  } catch (err) {
    // Non-fatal: log but don't crash the init chain
    if (logger?.warn) logger.warn("admin_reference_portfolio: universe enrollment failed", { message: err.message });
  }
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
 * When the entry is active (or defaulting to active), the symbol is also
 * enrolled in universe_symbols so the snapshot pipeline will cover it.
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

  // Enroll in universe pipeline when the entry is active (or when is_active is
  // not explicitly set to false, i.e. inheriting active=TRUE default).
  if (is_active !== false) {
    try {
      const { ensureTrackedSymbol } = _getUniverseHelpers();
      await ensureTrackedSymbol(sym, {
        priority: REFERENCE_UNIVERSE_PRIORITY,
        source: "admin_reference_portfolio_upsert",
      });
    } catch (err) {
      if (logger?.warn) logger.warn("admin_reference_portfolio: universe enroll on upsert failed", { symbol: sym, message: err.message });
    }
  }
}

// ── enrichment batch helpers ──────────────────────────────────────────────────

/**
 * Batch-check which symbols are present in universe_symbols and whether they
 * are active.  Returns Map<SYMBOL, { inUniverse: boolean, isActive: boolean }>.
 *
 * This is the key diagnostic: if a symbol is NOT in universe_symbols it will
 * never be scanned by the snapshot pipeline, which explains absent snapshots,
 * HQS scores, advanced metrics and derived outcomes.
 */
async function _batchUniverseStatus(symbols) {
  const map = new Map();
  if (!symbols.length) return map;
  try {
    const { rows } = await pool.query(
      `SELECT symbol, is_active FROM universe_symbols WHERE symbol = ANY($1::text[])`,
      [symbols]
    );
    for (const r of rows) {
      map.set(r.symbol, { inUniverse: true, isActive: Boolean(r.is_active) });
    }
  } catch (err) {
    if (logger?.warn) logger.warn("adminReferencePortfolio: universe status batch error", { message: err.message });
  }
  return map;
}

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
 * Batch-load latest HQS scores (including sub-components).
 * Returns Map<SYMBOL, hqsRow>.
 */
async function _batchHqsScores(symbols) {
  const map = new Map();
  if (!symbols.length) return map;
  try {
    const { rows } = await pool.query(
      `
      SELECT DISTINCT ON (symbol)
        symbol, hqs_score, momentum, quality, stability, relative,
        regime, created_at AS score_at
      FROM hqs_scores
      WHERE symbol = ANY($1::text[])
      ORDER BY symbol, created_at DESC NULLS LAST
      `,
      [symbols]
    );
    for (const r of rows) {
      map.set(r.symbol, {
        hqsScore: r.hqs_score !== null ? Number(r.hqs_score) : null,
        momentum: r.momentum !== null ? Number(r.momentum) : null,
        quality: r.quality !== null ? Number(r.quality) : null,
        stability: r.stability !== null ? Number(r.stability) : null,
        relative: r.relative !== null ? Number(r.relative) : null,
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
 * Batch-load latest outcome tracking by symbol (with all key fields).
 * Returns Map<SYMBOL, outcomeRow>.
 */
async function _batchOutcomes(symbols) {
  const map = new Map();
  if (!symbols.length) return map;
  try {
    const { rows } = await pool.query(
      `
      SELECT DISTINCT ON (symbol)
        symbol, final_conviction, final_confidence, regime, strategy,
        hqs_score AS outcome_hqs, ai_score, memory_score,
        opportunity_strength, orchestrator_confidence, predicted_at
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
        strategy: r.strategy ?? null,
        outcomeHqs: r.outcome_hqs !== null ? Number(r.outcome_hqs) : null,
        aiScore: r.ai_score !== null ? Number(r.ai_score) : null,
        memoryScore: r.memory_score !== null ? Number(r.memory_score) : null,
        opportunityStrength: r.opportunity_strength !== null ? Number(r.opportunity_strength) : null,
        orchestratorConfidence: r.orchestrator_confidence !== null ? Number(r.orchestrator_confidence) : null,
        predictedAt: r.predicted_at ? new Date(r.predicted_at).toISOString() : null,
      });
    }
  } catch (err) {
    if (logger?.warn) logger.warn("adminReferencePortfolio: outcomes batch error", { message: err.message });
  }
  return map;
}

/**
 * Batch-load latest news headlines per symbol (up to 3).
 * Returns Map<SYMBOL, Array<{title, source, sentiment, publishedAt}>>.
 */
async function _batchLatestNews(symbols) {
  const map = new Map();
  if (!symbols.length) return map;
  try {
    const { rows } = await pool.query(
      `
      SELECT symbol, title, source, sentiment_raw, published_at, source_type
      FROM (
        SELECT symbol, title, source, sentiment_raw, published_at, source_type,
          ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY published_at DESC NULLS LAST) AS rn
        FROM market_news
        WHERE symbol = ANY($1::text[])
          AND lifecycle_state NOT IN ('expired', 'archived')
      ) ranked
      WHERE rn <= 3
      ORDER BY symbol ASC, published_at DESC NULLS LAST
      `,
      [symbols]
    );
    for (const r of rows) {
      if (!map.has(r.symbol)) map.set(r.symbol, []);
      map.get(r.symbol).push({
        title: r.title ?? null,
        source: r.source ?? null,
        sentiment: r.sentiment_raw ?? null,
        sourceType: r.source_type ?? null,
        publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
      });
    }
  } catch (err) {
    if (logger?.warn) logger.warn("adminReferencePortfolio: latestNews batch error", { message: err.message });
  }
  return map;
}

// ── completeness scoring ──────────────────────────────────────────────────────
const COMPONENT_COUNT = 4; // snapshot, hqsScore, metrics, news
const COMPLETENESS_PER_COMPONENT = Math.round(100 / COMPONENT_COUNT);

// ── freshness helpers ────────────────────────────────────────────────────────
const FRESHNESS_THRESHOLDS_H = {
  snapshot: 4,   // market snapshots should be < 4h old
  score: 6,      // HQS scores should be < 6h old
  metrics: 48,   // advanced metrics should be < 48h old
  news: 72,      // news should be < 72h old
};

/**
 * Compute data-age in hours and freshness flags.
 * @param {{snapshotAt:string|null, scoreAt:string|null, metricsAt:string|null, latestNewsAt:string|null}} ts
 * @returns {{dataAgeHours:object, freshness:object}}
 */
function _computeFreshness(ts) {
  const now = Date.now();
  const age = (isoStr) => {
    if (!isoStr) return null;
    const ms = now - new Date(isoStr).getTime();
    return ms > 0 ? Math.round((ms / 3_600_000) * 10) / 10 : 0;
  };
  const snapshotAgeHours = age(ts.snapshotAt);
  const scoreAgeHours = age(ts.scoreAt);
  const metricsAgeHours = age(ts.metricsAt);
  const newsAgeHours = age(ts.latestNewsAt);

  return {
    dataAgeHours: { snapshotAgeHours, scoreAgeHours, metricsAgeHours, newsAgeHours },
    freshness: {
      snapshotFresh: snapshotAgeHours !== null && snapshotAgeHours <= FRESHNESS_THRESHOLDS_H.snapshot,
      scoreFresh: scoreAgeHours !== null && scoreAgeHours <= FRESHNESS_THRESHOLDS_H.score,
      metricsFresh: metricsAgeHours !== null && metricsAgeHours <= FRESHNESS_THRESHOLDS_H.metrics,
      newsFresh: newsAgeHours !== null && newsAgeHours <= FRESHNESS_THRESHOLDS_H.news,
    },
  };
}

/**
 * Derive a traffic-light dataStatus from component availability and freshness.
 * "green"  = all 4 components present & fresh
 * "yellow" = ≤ 1 missing or stale
 * "red"    = ≥ 2 missing or stale
 */
function _deriveDataStatus(missing, freshness) {
  const staleCount = Object.values(freshness).filter((v) => v === false).length;
  const totalIssues = missing.length + staleCount;
  if (totalIssues === 0) return "green";
  if (totalIssues <= 1) return "yellow";
  return "red";
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
 * Derive a machine-readable pipeline status per symbol.
 * This makes the root cause of missing data explicit so the admin view can
 * distinguish between "never in pipeline", "pipeline ran but no data yet",
 * "data stale", and "fully operational".
 *
 * Values:
 *  "not_in_universe"   – symbol is absent from universe_symbols; the snapshot
 *                        scanner will never pick it up → root cause of all
 *                        downstream missing data
 *  "universe_inactive" – symbol is in universe_symbols but is_active=FALSE;
 *                        scanner skips inactive symbols
 *  "no_data_yet"       – symbol is in the active pipeline but no snapshot
 *                        has been written yet (pipeline hasn't run yet, or
 *                        initial scan hasn't reached this symbol)
 *  "data_stale"        – snapshot exists but is older than the freshness
 *                        threshold; downstream data (score, metrics) may
 *                        also be stale
 *  "ok"                – snapshot present and fresh
 */
function _derivePipelineStatus(universeEntry, hasSnapshot, snapshotFresh) {
  if (!universeEntry || !universeEntry.inUniverse) return "not_in_universe";
  if (!universeEntry.isActive) return "universe_inactive";
  if (!hasSnapshot) return "no_data_yet";
  if (!snapshotFresh) return "data_stale";
  return "ok";
}

/**
 * Enrich a list of reference entries with live backend data.
 *
 * Delivers both the "Endprodukt-Sicht" (final product view) and the
 * "Integritäts-/Kontrollsicht" (integrity/control view) per symbol.
 * The control view now includes a per-symbol `pipelineStatus` field that
 * clearly names the root cause when data is missing.
 *
 * @param {Array<{symbol:string, name:string, position_order:number, note:string|null}>} entries
 * @returns {Promise<{items: Array, summary: object}>}
 */
async function enrichReferencePortfolio(entries) {
  const symbols = entries.map((e) => e.symbol);

  const [snapshots, hqsScores, advancedMetrics, newsCounts, latestNews, outcomes, universeStatus] =
    await Promise.all([
      _batchSnapshots(symbols),
      _batchHqsScores(symbols),
      _batchAdvancedMetrics(symbols),
      _batchNewsCount(symbols),
      _batchLatestNews(symbols),
      _batchOutcomes(symbols),
      _batchUniverseStatus(symbols),
    ]);

  let fullyServed = 0;
  let partiallyServed = 0;
  const missingComponentCounts = {};
  let hqsScoreSum = 0;
  let hqsScoreCount = 0;
  let completenessSum = 0;
  let greenCount = 0;
  let yellowCount = 0;
  let redCount = 0;
  const pipelineStatusCounts = {};

  const items = entries.map((entry) => {
    const sym = entry.symbol;
    const snap = snapshots.get(sym) ?? null;
    const hqs = hqsScores.get(sym) ?? null;
    const adv = advancedMetrics.get(sym) ?? null;
    const newsCount = newsCounts.get(sym) ?? 0;
    const newsItems = latestNews.get(sym) ?? [];
    const outcome = outcomes.get(sym) ?? null;
    const universeEntry = universeStatus.get(sym) ?? null;

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

    // Completeness: COMPLETENESS_PER_COMPONENT per component present
    const completenessScore =
      (hasSnapshot ? COMPLETENESS_PER_COMPONENT : 0) +
      (hasScore ? COMPLETENESS_PER_COMPONENT : 0) +
      (hasMetrics ? COMPLETENESS_PER_COMPONENT : 0) +
      (hasNews ? COMPLETENESS_PER_COMPONENT : 0);
    completenessSum += completenessScore;

    // Regime: prefer advanced metrics, fall back to hqs, then outcome
    const regime = adv?.regime ?? hqs?.regime ?? outcome?.outcomeRegime ?? null;

    // Freshness & data status
    const latestNewsAt = newsItems.length > 0 ? newsItems[0].publishedAt : null;
    const { dataAgeHours, freshness } = _computeFreshness({
      snapshotAt: snap?.snapshotAt ?? null,
      scoreAt: hqs?.scoreAt ?? null,
      metricsAt: adv?.metricsAt ?? null,
      latestNewsAt,
    });
    const dataStatus = _deriveDataStatus(missing, freshness);
    if (dataStatus === "green") greenCount += 1;
    else if (dataStatus === "yellow") yellowCount += 1;
    else redCount += 1;

    // Pipeline status – root cause of missing data
    const pipelineStatus = _derivePipelineStatus(universeEntry, hasSnapshot, freshness.snapshotFresh);
    pipelineStatusCounts[pipelineStatus] = (pipelineStatusCounts[pipelineStatus] ?? 0) + 1;

    // HQS score aggregation
    if (hqs?.hqsScore !== null && hqs?.hqsScore !== undefined) {
      hqsScoreSum += hqs.hqsScore;
      hqsScoreCount += 1;
    }

    return {
      symbol: sym,
      name: entry.name,
      positionOrder: entry.position_order,
      note: entry.note,

      // ── Endprodukt-Sicht (final product view) ─────────────────

      // market data
      price: snap?.price ?? null,
      priceUsd: snap?.priceUsd ?? null,
      changePercent: snap?.changePercent ?? null,

      // scoring (HQS)
      hqsScore: hqs?.hqsScore ?? null,
      momentum: hqs?.momentum ?? null,
      quality: hqs?.quality ?? null,
      stability: hqs?.stability ?? null,
      relative: hqs?.relative ?? null,
      regime,

      // advanced metrics
      trend: adv?.trend ?? null,
      volatilityAnnual: adv?.volatilityAnnual ?? null,

      // recommendation / signal / conviction
      recommendation: _convictionToRecommendation(outcome?.finalConviction),
      signalStrength: outcome?.finalConviction ?? null,
      confidence: outcome?.finalConfidence ?? null,
      strategy: outcome?.strategy ?? null,

      // orchestrator / memory sub-scores
      aiScore: outcome?.aiScore ?? null,
      memoryScore: outcome?.memoryScore ?? null,
      opportunityStrength: outcome?.opportunityStrength ?? null,
      orchestratorConfidence: outcome?.orchestratorConfidence ?? null,

      // latest news headlines
      latestNews: newsItems,
      newsCount,

      // ── Integritäts-/Kontrollsicht (integrity/control view) ───

      // component flags
      hasSnapshot,
      hasScore,
      hasMetrics,
      hasNews,

      // data quality
      dataStatus,
      completenessScore,
      freshness,
      dataAgeHours,

      // pipeline diagnostics: root cause of missing data
      inUniversePipeline: Boolean(universeEntry?.inUniverse),
      universeActive: Boolean(universeEntry?.isActive),
      pipelineStatus,

      // outcome timestamps
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
    supplyRate: items.length > 0 ? Math.round((fullyServed / items.length) * 100) : 0,
    avgHqsScore: hqsScoreCount > 0 ? Math.round((hqsScoreSum / hqsScoreCount) * 10) / 10 : null,
    avgCompleteness: items.length > 0 ? Math.round(completenessSum / items.length) : 0,
    statusBreakdown: { green: greenCount, yellow: yellowCount, red: redCount },
    missingComponents: missingComponentCounts,
    mostMissingComponent,
    pipelineStatusBreakdown: pipelineStatusCounts,
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
