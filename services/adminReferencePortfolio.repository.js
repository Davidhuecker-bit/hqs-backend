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
 * Enrich a list of reference entries with live backend data.
 *
 * Delivers both the "Endprodukt-Sicht" (final product view) and the
 * "Integritäts-/Kontrollsicht" (integrity/control view) per symbol.
 *
 * @param {Array<{symbol:string, name:string, position_order:number, note:string|null}>} entries
 * @returns {Promise<{items: Array, summary: object}>}
 */
async function enrichReferencePortfolio(entries) {
  const symbols = entries.map((e) => e.symbol);

  const [snapshots, hqsScores, advancedMetrics, newsCounts, latestNews, outcomes] =
    await Promise.all([
      _batchSnapshots(symbols),
      _batchHqsScores(symbols),
      _batchAdvancedMetrics(symbols),
      _batchNewsCount(symbols),
      _batchLatestNews(symbols),
      _batchOutcomes(symbols),
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

  const items = entries.map((entry) => {
    const sym = entry.symbol;
    const snap = snapshots.get(sym) ?? null;
    const hqs = hqsScores.get(sym) ?? null;
    const adv = advancedMetrics.get(sym) ?? null;
    const newsCount = newsCounts.get(sym) ?? 0;
    const newsItems = latestNews.get(sym) ?? [];
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
