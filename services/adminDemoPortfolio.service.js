"use strict";

/*
  AdminDemoPortfolioService
  -------------------------
  Liefert ein kuratiertes Demo-Portfolio (~20 Symbole) mit echten DB-Daten.
  Keine Mock-Daten, keine Fake-Werte – nur Daten aus:
    • market_snapshots   → lastPrice, lastSnapshotAt, changePercent
    • hqs_scores         → hqsScore, momentum, quality, stability, regime
    • market_advanced_metrics → regime, trend, volatility, scenarios
    • market_news        → latestNews (title, source, publishedAt, sentiment)
    • outcome_tracking   → signal, confidence/conviction

  Defensive Programmierung: Teilfehler liefern null + Status, niemals 500er.

  Pipeline-Logik:
    Core-Pipeline  = snapshotOk + scoreOk + metricsOk  → bestimmt overallStatus
    News           = supplementäre Datenquelle          → newsOk separat gemeldet
    overallStatus  = green (alle Core ok), yellow (teilweise), red (keine Core-Daten)

  Response-Shape pro Holding:
    { symbol, companyName, lastSnapshotAt, lastPrice,
      changePercent, priceChangeAvailable,
      hqsScore, confidence, signal, regime,
      latestNews, latestNewsCount,
      advancedMetrics, advancedMetricsAvailable,
      dataStatus, errorDetail, pipeline }
*/

const { Pool } = require("pg");
const logger = require("../utils/logger");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =========================================================
   CURATED SYMBOL SET  (~20 well-known, diversified stocks)
========================================================= */

const CURATED_SYMBOLS = [
  "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN",
  "META", "TSLA", "JPM", "BAC", "GS",
  "XOM", "CVX", "JNJ", "PFE", "UNH",
  "WMT", "COST", "CAT", "V", "MA",
];

const COMPANY_NAMES = {
  AAPL: "Apple Inc.",
  MSFT: "Microsoft Corp.",
  NVDA: "NVIDIA Corp.",
  GOOGL: "Alphabet Inc.",
  AMZN: "Amazon.com Inc.",
  META: "Meta Platforms Inc.",
  TSLA: "Tesla Inc.",
  JPM: "JPMorgan Chase & Co.",
  BAC: "Bank of America Corp.",
  GS: "Goldman Sachs Group Inc.",
  XOM: "Exxon Mobil Corp.",
  CVX: "Chevron Corp.",
  JNJ: "Johnson & Johnson",
  PFE: "Pfizer Inc.",
  UNH: "UnitedHealth Group Inc.",
  WMT: "Walmart Inc.",
  COST: "Costco Wholesale Corp.",
  CAT: "Caterpillar Inc.",
  V: "Visa Inc.",
  MA: "Mastercard Inc.",
};

/* =========================================================
   BATCH LOADERS  (one query per data source, all symbols)
========================================================= */

/**
 * Latest snapshot per symbol from market_snapshots.
 * Returns Map<symbol, { price, createdAt, changesPercentage, previousClose }>.
 *
 * changePercent sources (in priority order):
 *   1. changes_percentage column on the latest snapshot (from provider)
 *   2. Computed from latest price vs previous_close column
 *   3. Computed from latest price vs second-most-recent snapshot price
 *   4. null (no valid comparison available)
 */
async function loadSnapshotsBatch(symbols) {
  const map = new Map();
  try {
    // Fetch the two most recent snapshots per symbol so we can compute changePercent
    // if the provider-supplied value is missing
    const res = await pool.query(`
      SELECT symbol, price, created_at, changes_percentage, previous_close, rn
      FROM (
        SELECT symbol, price, created_at, changes_percentage, previous_close,
               ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY created_at DESC NULLS LAST) AS rn
        FROM market_snapshots
        WHERE symbol = ANY($1::text[])
      ) ranked
      WHERE rn <= 2
      ORDER BY symbol, rn
    `, [symbols]);

    // Group rows by symbol
    const grouped = new Map();
    for (const row of res.rows) {
      if (!grouped.has(row.symbol)) grouped.set(row.symbol, []);
      grouped.get(row.symbol).push(row);
    }

    for (const [symbol, rows] of grouped) {
      const latest = rows.find(r => Number(r.rn) === 1);
      const previous = rows.find(r => Number(r.rn) === 2);
      if (!latest) continue;

      const price = latest.price !== null ? Number(latest.price) : null;

      // Determine changePercent from best available source
      let changePercent = null;
      let previousClose = latest.previous_close !== null ? Number(latest.previous_close) : null;

      // 1. Provider-supplied changes_percentage
      if (latest.changes_percentage !== null) {
        const val = Number(latest.changes_percentage);
        if (Number.isFinite(val)) {
          changePercent = val;
        }
      }

      // 2. Compute from price vs previous_close (if provider gave previousClose but not changePercent)
      if (changePercent === null && price !== null && previousClose !== null && previousClose !== 0) {
        changePercent = ((price - previousClose) / previousClose) * 100;
      }

      // 3. Compute from latest price vs second-most-recent snapshot price
      if (changePercent === null && price !== null && previous) {
        const prevPrice = previous.price !== null ? Number(previous.price) : null;
        if (prevPrice !== null && prevPrice !== 0) {
          changePercent = ((price - prevPrice) / prevPrice) * 100;
        }
      }

      // Round to 2 decimal places for clean output
      if (changePercent !== null) {
        changePercent = Math.round(changePercent * 100) / 100;
      }

      map.set(symbol, {
        price,
        createdAt: latest.created_at ? new Date(latest.created_at).toISOString() : null,
        changePercent,
      });
    }
  } catch (err) {
    logger.warn("adminDemoPortfolio: snapshot batch failed", { message: err.message });
  }
  return map;
}

/**
 * Latest HQS score per symbol from hqs_scores.
 * Returns Map<symbol, { hqsScore, momentum, quality, stability, relative, regime, createdAt }>.
 */
async function loadScoresBatch(symbols) {
  const map = new Map();
  try {
    const res = await pool.query(`
      SELECT DISTINCT ON (symbol)
        symbol, hqs_score, momentum, quality, stability, relative, regime, created_at
      FROM hqs_scores
      WHERE symbol = ANY($1::text[])
      ORDER BY symbol, created_at DESC NULLS LAST
    `, [symbols]);
    for (const row of res.rows) {
      map.set(row.symbol, {
        hqsScore: row.hqs_score !== null ? Number(row.hqs_score) : null,
        momentum: row.momentum !== null ? Number(row.momentum) : null,
        quality: row.quality !== null ? Number(row.quality) : null,
        stability: row.stability !== null ? Number(row.stability) : null,
        relative: row.relative !== null ? Number(row.relative) : null,
        regime: row.regime ?? null,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      });
    }
  } catch (err) {
    logger.warn("adminDemoPortfolio: scores batch failed", { message: err.message });
  }
  return map;
}

/**
 * Advanced metrics per symbol from market_advanced_metrics.
 * Returns Map<symbol, { regime, trend, volatilityAnnual, volatilityDaily, scenarios, updatedAt }>.
 */
async function loadMetricsBatch(symbols) {
  const map = new Map();
  try {
    const res = await pool.query(`
      SELECT symbol, regime, trend, volatility_annual, volatility_daily, scenarios, updated_at
      FROM market_advanced_metrics
      WHERE symbol = ANY($1::text[])
    `, [symbols]);
    for (const row of res.rows) {
      map.set(row.symbol, {
        regime: row.regime ?? null,
        trend: row.trend !== null ? Number(row.trend) : null,
        volatilityAnnual: row.volatility_annual !== null ? Number(row.volatility_annual) : null,
        volatilityDaily: row.volatility_daily !== null ? Number(row.volatility_daily) : null,
        scenarios: row.scenarios ?? null,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      });
    }
  } catch (err) {
    logger.warn("adminDemoPortfolio: metrics batch failed", { message: err.message });
  }
  return map;
}

/**
 * Latest news per symbol from market_news (max 3 per symbol).
 * Returns Map<symbol, Array<{ title, source, publishedAt, sentiment }>>.
 */
async function loadNewsBatch(symbols) {
  const map = new Map();
  for (const s of symbols) map.set(s, []);
  try {
    const res = await pool.query(`
      SELECT symbol, title, source, published_at, sentiment_raw
      FROM (
        SELECT symbol, title, source, published_at, sentiment_raw,
               ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY published_at DESC NULLS LAST, id DESC) AS rn
        FROM market_news
        WHERE symbol = ANY($1::text[])
      ) ranked
      WHERE rn <= 3
      ORDER BY symbol, published_at DESC NULLS LAST
    `, [symbols]);
    for (const row of res.rows) {
      const arr = map.get(row.symbol);
      if (arr) {
        arr.push({
          title: row.title ?? null,
          source: row.source ?? null,
          publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
          sentiment: row.sentiment_raw ?? null,
        });
      }
    }
  } catch (err) {
    logger.warn("adminDemoPortfolio: news batch failed", { message: err.message });
  }
  return map;
}

/**
 * Latest outcome tracking row per symbol (for signal / confidence).
 * Returns Map<symbol, { signal, confidence, conviction, regime, predictedAt }>.
 */
async function loadOutcomeBatch(symbols) {
  const map = new Map();
  try {
    const res = await pool.query(`
      SELECT DISTINCT ON (symbol)
        symbol, regime, hqs_score, final_conviction, final_confidence,
        raw_input_snapshot, predicted_at
      FROM outcome_tracking
      WHERE symbol = ANY($1::text[])
      ORDER BY symbol, predicted_at DESC NULLS LAST
    `, [symbols]);
    for (const row of res.rows) {
      const snap = row.raw_input_snapshot || {};
      const signal = snap.signalDirection ?? snap.signal ?? null;
      map.set(row.symbol, {
        signal,
        confidence: row.final_confidence !== null ? Number(row.final_confidence) : null,
        conviction: row.final_conviction !== null ? Number(row.final_conviction) : null,
        regime: row.regime ?? null,
        predictedAt: row.predicted_at ? new Date(row.predicted_at).toISOString() : null,
      });
    }
  } catch (err) {
    logger.warn("adminDemoPortfolio: outcome batch failed", { message: err.message });
  }
  return map;
}

/* =========================================================
   PIPELINE STATUS HELPERS
========================================================= */

/**
 * Pipeline status derivation.
 *
 * Core pipeline (determines overallStatus): snapshotOk, scoreOk, metricsOk
 * Supplementary (reported separately):      newsOk
 *
 * overallStatus:
 *   "green"  — all 3 core sources present
 *   "yellow" — some core sources present
 *   "red"    — no core sources present
 *
 * newsOk is true when at least one real news article exists for the symbol.
 * News absence alone does NOT downgrade overallStatus.
 */
function derivePipelineStatus(holding) {
  const snapshotOk = holding.lastPrice !== null;
  const scoreOk = holding.hqsScore !== null;
  const metricsOk = holding.advancedMetrics !== null;
  const newsOk = holding.latestNewsCount > 0;

  const coreOkCount = [snapshotOk, scoreOk, metricsOk].filter(Boolean).length;

  let overallStatus = "green";
  if (coreOkCount === 0) overallStatus = "red";
  else if (coreOkCount < 3) overallStatus = "yellow";

  return { snapshotOk, scoreOk, newsOk, metricsOk, overallStatus };
}

function deriveDataStatus(pipeline) {
  if (pipeline.overallStatus === "green") return "complete";
  if (pipeline.overallStatus === "red") return "missing";
  return "partial";
}

/* =========================================================
   MAIN: getAdminDemoPortfolio
========================================================= */

async function getAdminDemoPortfolio() {
  const symbols = [...CURATED_SYMBOLS];
  const partialErrors = [];

  // --- Batch-load all data sources in parallel ---
  const [snapshots, scores, metrics, news, outcomes] = await Promise.all([
    loadSnapshotsBatch(symbols),
    loadScoresBatch(symbols),
    loadMetricsBatch(symbols),
    loadNewsBatch(symbols),
    loadOutcomeBatch(symbols),
  ]);

  // --- Assemble holdings ---
  const holdings = [];
  const statusCounts = { green: 0, yellow: 0, red: 0 };
  // Only core pipeline sources count for bottleneck tracking
  const bottleneckCounts = { snapshot: 0, score: 0, metrics: 0 };

  for (const symbol of symbols) {
    try {
      const snap = snapshots.get(symbol) || null;
      const score = scores.get(symbol) || null;
      const metric = metrics.get(symbol) || null;
      const newsArr = news.get(symbol) || [];
      const outcome = outcomes.get(symbol) || null;

      // Derive regime from best available source
      const regime = score?.regime ?? metric?.regime ?? outcome?.regime ?? null;

      // changePercent: from snapshot loader (provider value → computed from previous snapshot → null)
      const changePercent = snap?.changePercent ?? null;

      const holding = {
        symbol,
        companyName: COMPANY_NAMES[symbol] || symbol,
        lastSnapshotAt: snap?.createdAt ?? null,
        lastPrice: snap?.price ?? null,
        changePercent,
        priceChangeAvailable: changePercent !== null,
        hqsScore: score?.hqsScore ?? null,
        confidence: outcome?.confidence ?? null,
        signal: outcome?.signal ?? null,
        regime,
        latestNews: newsArr.length > 0 ? newsArr : null,
        latestNewsCount: newsArr.length,
        advancedMetrics: metric ?? null,
        advancedMetricsAvailable: metric !== null,
        dataStatus: null,   // set below
        errorDetail: null,
        pipeline: null,     // set below
      };

      const pipeline = derivePipelineStatus(holding);
      holding.pipeline = pipeline;
      holding.dataStatus = deriveDataStatus(pipeline);

      // Track core bottlenecks only (news is supplementary)
      if (!pipeline.snapshotOk) bottleneckCounts.snapshot++;
      if (!pipeline.scoreOk) bottleneckCounts.score++;
      if (!pipeline.metricsOk) bottleneckCounts.metrics++;

      statusCounts[pipeline.overallStatus]++;
      holdings.push(holding);
    } catch (err) {
      partialErrors.push({ symbol, error: err.message });
      holdings.push({
        symbol,
        companyName: COMPANY_NAMES[symbol] || symbol,
        lastSnapshotAt: null,
        lastPrice: null,
        changePercent: null,
        priceChangeAvailable: false,
        hqsScore: null,
        confidence: null,
        signal: null,
        regime: null,
        latestNews: null,
        latestNewsCount: 0,
        advancedMetrics: null,
        advancedMetricsAvailable: false,
        dataStatus: "error",
        errorDetail: err.message,
        pipeline: {
          snapshotOk: false,
          scoreOk: false,
          newsOk: false,
          metricsOk: false,
          overallStatus: "red",
        },
      });
      statusCounts.red++;
    }
  }

  // --- Derive top bottleneck (core pipeline only) ---
  let topBottleneck = null;
  const maxMissing = Math.max(
    bottleneckCounts.snapshot,
    bottleneckCounts.score,
    bottleneckCounts.metrics,
  );
  if (maxMissing > 0) {
    if (bottleneckCounts.snapshot === maxMissing) topBottleneck = "snapshot";
    else if (bottleneckCounts.score === maxMissing) topBottleneck = "score";
    else topBottleneck = "metrics";
  }

  // --- Overall data status ---
  let overallDataStatus = "complete";
  if (statusCounts.red > 0 && statusCounts.green === 0 && statusCounts.yellow === 0) {
    overallDataStatus = "missing";
  } else if (statusCounts.yellow > 0 || statusCounts.red > 0) {
    overallDataStatus = "partial";
  }

  return {
    success: true,
    dataStatus: overallDataStatus,
    holdings,
    partialErrors: partialErrors.length > 0 ? partialErrors : [],
    generatedAt: new Date().toISOString(),
    summary: {
      total: holdings.length,
      green: statusCounts.green,
      yellow: statusCounts.yellow,
      red: statusCounts.red,
      topBottleneck,
    },
  };
}

module.exports = { getAdminDemoPortfolio };
