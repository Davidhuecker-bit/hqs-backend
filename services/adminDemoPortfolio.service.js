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

  Pipeline-Logik (Reihenfolge):
    1. Core fehlt (snapshot/score/metrics alle 0) => rot
    2. Core vorhanden, aber alt/unsicher          => gelb
    3. Nur News fehlen                            => gelb (nicht rot)
    4. Alles Kernrelevante vorhanden und frisch    => grün

  News = supplementäre Datenquelle, kein Pflichtfeld für green.

  Response-Shape pro Holding:
    { symbol, companyName, lastSnapshotAt, lastPrice,
      changePercent, priceChangeAvailable,
      hqsScore, confidence, signal, regime,
      latestNews, latestNewsCount,
      advancedMetrics, advancedMetricsAvailable,
      dataStatus, errorDetail, pipeline,
      missingSources, weakSources,
      statusReason, statusReasonLabel,
      dataAgeHours, freshness,
      completenessScore, reliabilityScore,
      sortKeys }
*/

const { Pool } = require("pg");
const logger = require("../utils/logger");
const { getUsdToEurRate, convertUsdToEur } = require("./fx.service");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =========================================================
   CURATED SYMBOL SET  (~20 well-known, diversified stocks)
   Exported as DEMO_ADMIN_SYMBOLS for external consumers.
========================================================= */

const DEMO_ADMIN_SYMBOLS = [
  "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN",
  "META", "TSLA", "JPM", "BAC", "GS",
  "XOM", "CVX", "JNJ", "PFE", "UNH",
  "WMT", "COST", "CAT", "V", "MA",
];

// Backwards-compatible alias
const CURATED_SYMBOLS = DEMO_ADMIN_SYMBOLS;

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
   CONFIGURABLE STALE-HOURS  (ENV with sensible defaults)
========================================================= */

const DEMO_SNAPSHOT_STALE_HOURS = Number(process.env.DEMO_SNAPSHOT_STALE_HOURS) || 24;
const DEMO_SCORE_STALE_HOURS    = Number(process.env.DEMO_SCORE_STALE_HOURS)    || 48;
const DEMO_METRICS_STALE_HOURS  = Number(process.env.DEMO_METRICS_STALE_HOURS)  || 48;
const DEMO_NEWS_STALE_HOURS     = Number(process.env.DEMO_NEWS_STALE_HOURS)     || 72;
const DEMO_SNAPSHOT_HARD_STALE_HOURS = Number(process.env.DEMO_SNAPSHOT_HARD_STALE_HOURS) || 72;

/* =========================================================
   STATUS REASON LABELS  (stable keys → german labels)
========================================================= */

const STATUS_REASON_LABELS = {
  complete:              "Alle Kerndaten vollständig und aktuell",
  missing_snapshot:      "Snapshot fehlt",
  missing_score:         "HQS-Score fehlt",
  missing_metrics:       "Advanced Metrics fehlen",
  missing_news_only:     "Nur News fehlen (Kerndaten ok)",
  stale_snapshot:        "Snapshot veraltet",
  low_confidence:        "Geringe Daten-Konfidenz",
  partial_multi_source:  "Mehrere Kernquellen unvollständig",
};

/**
 * Returns the correct base price for a snapshot row.
 * - USD rows prefer price_usd (raw provider price), fall back to price.
 * - EUR rows use price as-is.
 */
function basePrice(row) {
  const currency = String(row?.currency || "EUR").toUpperCase();
  const priceField = row?.price;
  const usdPrice = row?.price_usd;
  if (currency === "USD") {
    return usdPrice !== null && usdPrice !== undefined ? usdPrice : priceField;
  }
  return priceField;
}

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
    let fxRateCache = null;
    let cachedValidFxRate = null;
    const ensureFxRate = async () => {
      if (fxRateCache !== null) return fxRateCache;
      fxRateCache = await getUsdToEurRate();
      if (Number.isFinite(fxRateCache) && fxRateCache > 0) {
        cachedValidFxRate = fxRateCache;
      }
      return fxRateCache;
    };

    // Fetch several recent snapshots per symbol (limit 4) so we can choose the best EUR-normalized row
    // and still compute changePercent even if the latest rows are stale or missing prices.
    const res = await pool.query(`
      SELECT symbol, price, price_usd, currency, fx_rate, source, created_at, changes_percentage, previous_close, rn
      FROM (
        SELECT symbol, price, price_usd, currency, fx_rate, source, created_at, changes_percentage, previous_close,
               ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY created_at DESC NULLS LAST) AS rn
        FROM market_snapshots
        WHERE symbol = ANY($1::text[])
      ) ranked
      WHERE rn <= 4
      ORDER BY symbol, rn
    `, [symbols]);

    // Group rows by symbol
    const grouped = new Map();
    for (const row of res.rows) {
      if (!grouped.has(row.symbol)) grouped.set(row.symbol, []);
      grouped.get(row.symbol).push(row);
    }

    for (const [symbol, rows] of grouped) {
      if (!rows?.length) continue;

      const selectionLog = [];
      const candidates = [];

      for (const row of rows) {
        const createdAtIso = row.created_at ? new Date(row.created_at).toISOString() : null;
        const ageHours = safeAgeHours(createdAtIso);
        const isHardStale = ageHours !== null && ageHours > DEMO_SNAPSHOT_HARD_STALE_HOURS;
        const rowCurrency = String(row.currency || "EUR").toUpperCase();

        let rateToUse = null;
        let rateSource = null;
        if (row.fx_rate !== null && Number.isFinite(Number(row.fx_rate)) && Number(row.fx_rate) > 0) {
          rateToUse = Number(row.fx_rate);
          cachedValidFxRate = rateToUse;
          rateSource = "snapshot_fx_rate";
        } else {
          rateToUse = await ensureFxRate();
          rateSource = "fx_service";
          if (((!Number.isFinite(rateToUse)) || rateToUse <= 0) && cachedValidFxRate) {
            selectionLog.push(`using cachedValidFxRate for ${symbol}`);
            rateToUse = cachedValidFxRate;
            rateSource = "cached_valid_fx_rate";
          }
        }

        const base = basePrice(row);
        let priceEur = base !== null ? Number(base) : null;
        let fxApplied = false;
        let fxReason = null;

        if (rowCurrency === "USD") {
          const converted = convertUsdToEur(priceEur, rateToUse);
          if (converted !== null) {
            priceEur = converted;
            fxApplied = true;
            fxReason = rateSource || "unknown";
          } else if (Number.isFinite(rateToUse)) {
            fxReason = "conversion_failed";
            priceEur = null; // avoid returning an unconverted USD price when EUR conversion fails
          } else {
            fxReason = "fx_missing";
            priceEur = null;
          }
        }

        const hasPrice = priceEur !== null && Number.isFinite(priceEur);
        candidates.push({
          row,
          createdAtIso,
          ageHours,
          isHardStale,
          rowCurrency,
          rateToUse,
          priceEur: hasPrice ? priceEur : null,
          fxApplied,
          fxReason,
          hasPrice,
        });
      }

      // Rank candidates: prefer non-hard-stale, freshest age, has price, EUR-native
      candidates.sort((a, b) => {
        const aHard = a.isHardStale ? 1 : 0;
        const bHard = b.isHardStale ? 1 : 0;
        if (aHard !== bHard) return aHard - bHard;
        const aAge = a.ageHours ?? Number.POSITIVE_INFINITY;
        const bAge = b.ageHours ?? Number.POSITIVE_INFINITY;
        if (aAge !== bAge) return aAge - bAge;
        if (a.hasPrice !== b.hasPrice) return a.hasPrice ? -1 : 1;
        const aEurNative = a.rowCurrency === "EUR" ? 1 : 0;
        const bEurNative = b.rowCurrency === "EUR" ? 1 : 0;
        if (aEurNative !== bEurNative) return bEurNative - aEurNative;
        return 0;
      });

      const primary = candidates[0];
      const secondary = candidates.find((c) => c !== primary && c.priceEur !== null);

      if (!primary) continue;

      let changePercent = null;
      let changePercentSource = null;
      const basePrevClose = primary.row.previous_close !== null ? Number(primary.row.previous_close) : null;
      let previousClose = basePrevClose;
      if (primary.rowCurrency === "USD" && basePrevClose !== null) {
        previousClose = convertUsdToEur(basePrevClose, primary.rateToUse) ?? basePrevClose;
      }

      // 1. Provider-supplied changes_percentage
      if (primary.row.changes_percentage !== null) {
        const val = Number(primary.row.changes_percentage);
        if (Number.isFinite(val)) {
          changePercent = val;
          changePercentSource = "provider";
          selectionLog.push("changePercent from provider changes_percentage");
        }
      }

      // 2. Compute from price vs previous_close (if provider gave previousClose but not changePercent)
      if (changePercent === null && primary.priceEur !== null && previousClose !== null && previousClose !== 0) {
        changePercent = ((primary.priceEur - previousClose) / previousClose) * 100;
        changePercentSource = "previous_close";
        selectionLog.push("changePercent computed from previous_close");
      }

      // 3. Compute from latest price vs second-most-recent usable snapshot price
      if (changePercent === null && primary.priceEur !== null && secondary && secondary.priceEur !== null) {
        const prevPrice = secondary.priceEur;
        if (prevPrice !== 0) {
          changePercent = ((primary.priceEur - prevPrice) / prevPrice) * 100;
          changePercentSource = "secondary_snapshot";
          selectionLog.push("changePercent computed from secondary snapshot");
        }
      }

      // Round to 2 decimal places for clean output
      if (primary.priceEur !== null && changePercent !== null) {
        changePercent = Math.round(changePercent * 100) / 100;
      } else if (primary.priceEur === null) {
        changePercent = null;
      }

      const selectedCurrency = "EUR";
      const hardStaleReason = primary.isHardStale ? `hard-stale>${DEMO_SNAPSHOT_HARD_STALE_HOURS}h` : null;
      const selectionStatus = primary.isHardStale
        ? hardStaleReason
        : (primary.hasPrice ? "ok" : "no-price");
      selectionLog.push({
        event: "selected_snapshot",
        currency: primary.rowCurrency,
        createdAt: primary.createdAtIso,
        ageHours: primary.ageHours,
        fxApplied: primary.fxApplied,
        fxSource: primary.fxReason || "n/a",
        priceSource: primary.row.source || null,
        status: selectionStatus,
      });

      const finalPrice = primary.isHardStale ? null : primary.priceEur;
      const finalChangePercent = finalPrice === null ? null : changePercent;

      map.set(symbol, {
        price: finalPrice,
        createdAt: primary.createdAtIso,
        changePercent: finalChangePercent,
        currency: selectedCurrency,
        priceSource: primary.row.source || null,
        fxApplied: primary.fxApplied,
        originalCurrency: primary.rowCurrency === "EUR" ? null : primary.rowCurrency,
        snapshotDebug: {
          selectionLog,
          ageHours: primary.ageHours,
          hardStale: primary.isHardStale,
          fxRate: primary.rateToUse ?? null,
          secondaryUsed: Boolean(secondary),
          changePercentSource,
        },
      });

      if (primary.rowCurrency === "USD" && finalPrice === null) {
        logger.warn("adminDemoPortfolio: USD snapshot could not be converted; dropping price", {
          symbol,
          createdAt: primary.createdAtIso,
          fxSource: primary.fxReason,
        });
      }
      if (primary.isHardStale) {
        logger.warn("adminDemoPortfolio: hard-stale snapshot selected; price dropped", {
          symbol,
          createdAt: primary.createdAtIso,
          ageHours: primary.ageHours,
        });
      } else {
        logger.info("adminDemoPortfolio: snapshot selected", {
          symbol,
          createdAt: primary.createdAtIso,
          ageHours: primary.ageHours,
          currency: primary.rowCurrency,
          fxApplied: primary.fxApplied,
          fxSource: primary.fxReason,
          changePercentSource: changePercentSource,
          priceSource: primary.row.source || null,
        });
      }
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
   TIMESTAMP / FRESHNESS HELPERS
========================================================= */

/**
 * Safely compute age in hours from an ISO timestamp string.
 * Returns null if timestamp is missing, invalid, or in the future.
 */
function safeAgeHours(isoString) {
  if (!isoString) return null;
  try {
    const ts = new Date(isoString).getTime();
    if (!Number.isFinite(ts)) return null;
    const diff = Date.now() - ts;
    if (diff < 0) return 0;
    return Math.round((diff / 3600000) * 100) / 100;
  } catch (_) {
    return null;
  }
}

/**
 * Determine if a source is fresh based on its age and the configured threshold.
 * Returns true if data is present and within the stale threshold.
 * Returns false if age is null (missing) or exceeds the threshold.
 */
function isFresh(ageHours, staleThreshold) {
  if (ageHours === null) return false;
  return ageHours <= staleThreshold;
}

/* =========================================================
   CENTRALIZED STATUS EVALUATION
   ─────────────────────────────
   Single function that determines ALL diagnostic fields
   for one holding. Evaluation order:

   1. Core fehlt (snapshot/score/metrics alle 0)     => rot
   2. Core vorhanden, aber alt/unsicher              => gelb
   3. Nur News fehlen                                => gelb (nicht rot)
   4. Alles Kernrelevante vorhanden und frisch       => grün

   News = supplementary, never sole cause for red.
========================================================= */

function evaluateHoldingDiagnostics(holding, timestamps) {
  const snapshotOk = holding.lastPrice !== null;
  const scoreOk    = holding.hqsScore !== null;
  const metricsOk  = holding.advancedMetrics !== null;
  const newsPresent = holding.latestNewsCount > 0;

  // --- Data age ---
  const snapshotAgeHours = safeAgeHours(timestamps.snapshot);
  const scoreAgeHours    = safeAgeHours(timestamps.score);
  const metricsAgeHours  = safeAgeHours(timestamps.metrics);
  const newsAgeHours     = safeAgeHours(timestamps.news);

  // --- Freshness ---
  const snapshotFresh = snapshotOk && isFresh(snapshotAgeHours, DEMO_SNAPSHOT_STALE_HOURS);
  const scoreFresh    = scoreOk    && isFresh(scoreAgeHours, DEMO_SCORE_STALE_HOURS);
  const metricsFresh  = metricsOk  && isFresh(metricsAgeHours, DEMO_METRICS_STALE_HOURS);
  const newsFresh     = newsPresent && isFresh(newsAgeHours, DEMO_NEWS_STALE_HOURS);
  const newsOk        = newsPresent && newsFresh;

  // --- Missing / weak sources ---
  const missingSources = [];
  const weakSources    = [];

  if (!snapshotOk) missingSources.push("snapshot");
  else if (!snapshotFresh) weakSources.push("snapshot");

  if (!scoreOk) missingSources.push("score");
  else if (!scoreFresh) weakSources.push("score");

  if (!metricsOk) missingSources.push("advancedMetrics");
  else if (!metricsFresh) weakSources.push("advancedMetrics");

  if (!newsPresent) missingSources.push("news");
  else if (!newsFresh) weakSources.push("news");

  // --- Failing stage (primary) ---
  const coreMissing = [];
  if (!snapshotOk) coreMissing.push("snapshot");
  if (!scoreOk)    coreMissing.push("score");
  if (!metricsOk)  coreMissing.push("metrics");

  const failingStage = coreMissing.length > 0
    ? coreMissing[0]
    : (!newsOk ? "news" : null);

  // --- Overall status + statusReason ---
  const coreOkCount = [snapshotOk, scoreOk, metricsOk].filter(Boolean).length;
  const coreStaleCount = [
    snapshotOk && !snapshotFresh,
    scoreOk && !scoreFresh,
    metricsOk && !metricsFresh,
  ].filter(Boolean).length;

  let overallStatus;
  let statusReason;

  if (coreOkCount === 0) {
    // Rule 1: All core missing => red
    overallStatus = "red";
    statusReason = coreMissing.length > 1 ? "partial_multi_source" : ("missing_" + coreMissing[0]);
  } else if (coreOkCount < 3) {
    // Some core missing => yellow or red
    if (coreOkCount === 1) {
      // Only 1 of 3 core sources → red
      overallStatus = "red";
    } else {
      overallStatus = "yellow";
    }
    if (coreMissing.length > 1) {
      statusReason = "partial_multi_source";
    } else if (!snapshotOk) {
      statusReason = "missing_snapshot";
    } else if (!scoreOk) {
      statusReason = "missing_score";
    } else {
      statusReason = "missing_metrics";
    }
  } else if (coreStaleCount > 0) {
    // Rule 2: Core present but stale => yellow
    overallStatus = "yellow";
    if (!snapshotFresh) statusReason = "stale_snapshot";
    else statusReason = "low_confidence";
  } else if (!newsOk) {
    // Rule 3: Only news missing => yellow (not red)
    overallStatus = "yellow";
    statusReason = "missing_news_only";
  } else {
    // Rule 4: All core present, fresh, and news present => green
    overallStatus = "green";
    statusReason = "complete";
  }

  const statusReasonLabel = STATUS_REASON_LABELS[statusReason] || statusReason;

  // --- Completeness score (0-100) ---
  // 4 sources, core sources weighted higher: snapshot 30, score 30, metrics 25, news 15
  let completenessScore = 0;
  if (snapshotOk) completenessScore += 30;
  if (scoreOk)    completenessScore += 30;
  if (metricsOk)  completenessScore += 25;
  if (newsOk)     completenessScore += 15;

  // --- Reliability score (0-100) ---
  // Based on freshness of available sources
  let reliabilityScore = 0;
  let reliabilityDivisor = 0;
  if (snapshotOk) { reliabilityDivisor += 30; if (snapshotFresh) reliabilityScore += 30; }
  if (scoreOk)    { reliabilityDivisor += 30; if (scoreFresh)    reliabilityScore += 30; }
  if (metricsOk)  { reliabilityDivisor += 25; if (metricsFresh)  reliabilityScore += 25; }
  if (newsOk)     { reliabilityDivisor += 15; if (newsFresh)     reliabilityScore += 15; }
  // Normalize to 0-100 based on what is available
  if (reliabilityDivisor > 0) {
    reliabilityScore = Math.round((reliabilityScore / reliabilityDivisor) * 100);
  }

  // --- Problem weight (higher = more problematic, for sorting) ---
  const statusWeight = { red: 100, yellow: 50, green: 0 };
  const problemWeight = (statusWeight[overallStatus] || 0)
    + (coreMissing.length * 20)
    + (coreStaleCount * 10)
    + (!newsOk ? 5 : 0);

  // --- Derive dataStatus from overallStatus (backwards compat) ---
  let dataStatus;
  if (overallStatus === "green") dataStatus = "complete";
  else if (overallStatus === "red") dataStatus = "missing";
  else dataStatus = "partial";

  return {
    pipeline: {
      snapshotOk,
      scoreOk,
      metricsOk,
      newsOk,
      snapshotFresh,
      scoreFresh,
      metricsFresh,
      newsFresh,
      failingStage,
      overallStatus,
    },
    missingSources,
    weakSources,
    statusReason,
    statusReasonLabel,
    dataAgeHours: {
      snapshotAgeHours,
      scoreAgeHours,
      metricsAgeHours,
      newsAgeHours,
    },
    freshness: {
      snapshotFresh,
      scoreFresh,
      metricsFresh,
      newsFresh,
    },
    completenessScore,
    reliabilityScore,
    dataStatus,
    problemWeight,
  };
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
  const reasonCounts = {};
  const missingSourceCounts = { snapshot: 0, score: 0, metrics: 0, news: 0 };
  const staleCounts = { snapshot: 0, score: 0, metrics: 0, news: 0 };
  let totalCompleteness = 0;
  let totalReliability = 0;

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

      // Timestamps for freshness calculation
      const timestamps = {
        snapshot: snap?.createdAt ?? null,
        score:    score?.createdAt ?? null,
        metrics:  metric?.updatedAt ?? null,
        news:     newsArr.length > 0 ? newsArr[0].publishedAt : null,
      };

      if (snap?.price == null || snap?.snapshotDebug?.hardStale) {
        logger.info("adminDemoPortfolio: snapshot missing or stale for symbol", {
          symbol,
          reason: snap?.snapshotDebug?.hardStale ? "hard-stale-snapshot" : "no-price",
        });
      }
      if (newsArr.length === 0) {
        logger.info("adminDemoPortfolio: no news for symbol", { symbol });
      } else if (!isFresh(safeAgeHours(timestamps.news), DEMO_NEWS_STALE_HOURS)) {
        logger.info("adminDemoPortfolio: stale news for symbol", {
          symbol,
          latestNewsAt: timestamps.news,
          ageHours: safeAgeHours(timestamps.news),
        });
      }

      const holding = {
        symbol,
        companyName: COMPANY_NAMES[symbol] || symbol,
        lastSnapshotAt: snap?.createdAt ?? null,
        lastPrice: snap?.price ?? null,
        currency: snap?.currency || "EUR",
        priceSource: snap?.priceSource || null,
        fxApplied: snap?.fxApplied ?? null,
        originalCurrency: snap?.originalCurrency ?? null,
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
        dataStatus: null,
        errorDetail: null,
        pipeline: null,
        // New diagnostic fields (set below)
        missingSources: null,
        weakSources: null,
        statusReason: null,
        statusReasonLabel: null,
        dataAgeHours: null,
        freshness: null,
        completenessScore: null,
        reliabilityScore: null,
        sortKeys: null,
      };

      // --- Central evaluation ---
      const diag = evaluateHoldingDiagnostics(holding, timestamps);

      holding.pipeline          = diag.pipeline;
      holding.dataStatus        = diag.dataStatus;
      holding.missingSources    = diag.missingSources;
      holding.weakSources       = diag.weakSources;
      holding.statusReason      = diag.statusReason;
      holding.statusReasonLabel = diag.statusReasonLabel;
      holding.dataAgeHours      = diag.dataAgeHours;
      holding.freshness         = diag.freshness;
      holding.completenessScore = diag.completenessScore;
      holding.reliabilityScore  = diag.reliabilityScore;

      // Sort keys for frontend convenience
      holding.sortKeys = {
        hqsScore:          holding.hqsScore ?? -1,
        confidence:        holding.confidence ?? -1,
        completenessScore: diag.completenessScore,
        reliabilityScore:  diag.reliabilityScore,
        snapshotAgeHours:  diag.dataAgeHours.snapshotAgeHours ?? 99999,
        problemWeight:     diag.problemWeight,
      };

      // Track core bottlenecks only (news is supplementary)
      if (!diag.pipeline.snapshotOk) bottleneckCounts.snapshot++;
      if (!diag.pipeline.scoreOk) bottleneckCounts.score++;
      if (!diag.pipeline.metricsOk) bottleneckCounts.metrics++;

      // Track missing / stale counts
      if (!diag.pipeline.snapshotOk) missingSourceCounts.snapshot++;
      if (!diag.pipeline.scoreOk)    missingSourceCounts.score++;
      if (!diag.pipeline.metricsOk)  missingSourceCounts.metrics++;
      if (!diag.pipeline.newsOk)     missingSourceCounts.news++;
      if (diag.pipeline.snapshotOk && !diag.pipeline.snapshotFresh) staleCounts.snapshot++;
      if (diag.pipeline.scoreOk    && !diag.pipeline.scoreFresh)    staleCounts.score++;
      if (diag.pipeline.metricsOk  && !diag.pipeline.metricsFresh)  staleCounts.metrics++;
      if (holding.latestNewsCount > 0 && !diag.pipeline.newsFresh)  staleCounts.news++;

      // Track reason counts
      reasonCounts[diag.statusReason] = (reasonCounts[diag.statusReason] || 0) + 1;

      totalCompleteness += diag.completenessScore;
      totalReliability  += diag.reliabilityScore;

      statusCounts[diag.pipeline.overallStatus]++;
      holdings.push(holding);
    } catch (err) {
      partialErrors.push({ symbol, error: err.message });
      holdings.push({
        symbol,
        companyName: COMPANY_NAMES[symbol] || symbol,
        lastSnapshotAt: null,
        lastPrice: null,
        currency: "EUR",
        priceSource: null,
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
          metricsOk: false,
          newsOk: false,
          snapshotFresh: false,
          scoreFresh: false,
          metricsFresh: false,
          newsFresh: false,
          failingStage: "snapshot",
          overallStatus: "red",
        },
        missingSources: ["snapshot", "score", "advancedMetrics", "news"],
        weakSources: [],
        statusReason: "partial_multi_source",
        statusReasonLabel: STATUS_REASON_LABELS["partial_multi_source"],
        dataAgeHours: { snapshotAgeHours: null, scoreAgeHours: null, metricsAgeHours: null, newsAgeHours: null },
        freshness: { snapshotFresh: false, scoreFresh: false, metricsFresh: false, newsFresh: false },
        completenessScore: 0,
        reliabilityScore: 0,
        sortKeys: {
          hqsScore: -1,
          confidence: -1,
          completenessScore: 0,
          reliabilityScore: 0,
          snapshotAgeHours: 99999,
          problemWeight: 165, // red(100) + 3 missing core(60) + no news(5)
        },
      });
      statusCounts.red++;
      reasonCounts["partial_multi_source"] = (reasonCounts["partial_multi_source"] || 0) + 1;
      missingSourceCounts.snapshot++;
      missingSourceCounts.score++;
      missingSourceCounts.metrics++;
      missingSourceCounts.news++;
    }
  }

  // --- Derive top bottleneck (core pipeline only) ---
  let topBottleneck = null;
  let topBottleneckCount = 0;
  const maxMissing = Math.max(
    bottleneckCounts.snapshot,
    bottleneckCounts.score,
    bottleneckCounts.metrics,
  );
  if (maxMissing > 0) {
    topBottleneckCount = maxMissing;
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

  const holdingCount = holdings.length;
  const avgCompleteness = holdingCount > 0 ? Math.round(totalCompleteness / holdingCount) : 0;
  const avgReliability  = holdingCount > 0 ? Math.round(totalReliability / holdingCount)  : 0;

  return {
    success: true,
    portfolioId: "DEMO_ADMIN_20",
    portfolioName: "Internes Admin-Prüfportfolio",
    symbolCount: symbols.length,
    currency: "EUR",
    priceSource: "massive",
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
      topBottleneckCount,
      byReason: reasonCounts,
      avgCompletenessScore: avgCompleteness,
      avgReliabilityScore: avgReliability,
      missingSourceCounts,
      staleCounts,
    },
  };
}

module.exports = { getAdminDemoPortfolio, DEMO_ADMIN_SYMBOLS };
