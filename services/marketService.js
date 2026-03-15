"use strict";

/*
  HQS Market System – Enterprise AI Market Pipeline
  DB-first snapshot scanning (universe-first)

  Enthält:
  - Step 1: Snapshot Summary
  - Step 2: System Health Score
  - Step 3: Priority-aware Snapshot Loading
  - Step 4: Extended Diagnostics (source + tier)
  - Step 5: Run Recommendations / Quality Warnings
  - Batch Snapshot Scanning mit persistentem Offset
*/

const { fetchQuote } = require("./providerService");
const { normalizeMarketData } = require("./marketNormalizer");
const { buildHQSResponse } = require("../hqsEngine");

const { getHistoricalPrices } = require("./historicalService");

const { buildTrendScore } = require("../engines/trendEngine");
const { monteCarloSimulation } = require("../engines/monteCarloEngine");
const { detectMarketRegime } = require("../engines/marketRegimeEngine");

const { buildFeatures } = require("../engines/featureEngine");
const { discoverOpportunities } = require("../engines/discoveryEngine");
const { detectNarrative } = require("../engines/narrativeEngine");
const {
  runMarketSimulations,
  calculateResilience,
} = require("../engines/marketSimulationEngine");
const { runResearch } = require("../engines/researchEngine");
const { buildAIScore } = require("../engines/marketBrain");
const { applyStrategy } = require("../engines/strategyEngine");
const { buildIntegratedMarketView } = require("../engines/integrationEngine");

const { analyzeCrossAssetEnvironment } = require("../engines/crossAssetEngine");
const { analyzeCapitalFlows } = require("../engines/capitalFlowEngine");
const { analyzeMacroEvents } = require("../engines/eventIntelligenceEngine");
const {
  evaluateMarketMemory,
  buildSetupSignature,
} = require("../engines/marketMemoryEngine");
const { evaluateMetaLearning } = require("../engines/metaLearningEngine");
const { orchestrateMarket } = require("../engines/marketOrchestrator");

const { computeAdaptiveWeights } = require("./weightHistory.repository");

const {
  initWatchlistTable,
  seedDefaultWatchlist,
  getActiveWatchlistSymbols,
} = require("./watchlist.repository");

const {
  initAdvancedMetricsTable,
  upsertAdvancedMetrics,
  loadAdvancedMetrics,
} = require("./advancedMetrics.repository");

const {
  initOutcomeTrackingTable,
  createOutcomeTrackingEntry,
  buildAnalysisRationale,
  buildStructuredPatternSignature,
} = require("./outcomeTracking.repository");
const {
  initUniverseTables,
  getUniverseBatch,
  listActiveUniverseSymbols,
} = require("./universe.repository");
const {
  loadRuntimeState,
  RUNTIME_STATE_MARKET_MEMORY_KEY,
  RUNTIME_STATE_META_LEARNING_KEY,
} = require("./discoveryLearning.repository");

const { initJobLocksTable, acquireLock } = require("./jobLock.repository");
const { initMarketNewsTable } = require("./marketNews.repository");
const {
  buildSignalContext,
  loadOpportunityNewsContextBySymbols,
  calculateRobustnessScore,
} = require("./opportunityScanner.service");
const { collectSocialSignals } = require("./socialScanner.service");

const logger = require("../utils/logger");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const HIST_PERIOD = String(process.env.HIST_PERIOD || "1y").toLowerCase();
const MC_SIMS = Number(process.env.MC_SIMS || 800);
const OUTCOME_HORIZON_DAYS = Number(process.env.OUTCOME_HORIZON_DAYS || 30);

const SNAPSHOT_SYMBOL_LIMIT = Number(process.env.SNAPSHOT_SYMBOL_LIMIT || 250);
const SNAPSHOT_BATCH_SIZE = Number(process.env.SNAPSHOT_BATCH_SIZE || 80);
const SNAPSHOT_REGION = String(process.env.SNAPSHOT_REGION || "us").toLowerCase().trim();
const SNAPSHOT_FAIL_FAST_THRESHOLD = Number(process.env.SNAPSHOT_FAIL_FAST_THRESHOLD || 35);

const SNAPSHOT_STATE_KEY = "snapshot_watchlist_offset";

/* =========================================================
   IN-MEMORY AI STORES
========================================================= */

let marketMemoryStore = {};
let metaLearningStore = {};
let runtimePreviewStoresLoaded = false;

/* =========================================================
   UTIL
========================================================= */

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

async function ensureRuntimePreviewStoresLoaded() {
  if (runtimePreviewStoresLoaded) return;

  const [persistedMarketMemory, persistedMetaLearning] = await Promise.all([
    loadRuntimeState(RUNTIME_STATE_MARKET_MEMORY_KEY),
    loadRuntimeState(RUNTIME_STATE_META_LEARNING_KEY),
  ]);

  marketMemoryStore =
    persistedMarketMemory &&
    typeof persistedMarketMemory === "object" &&
    !Array.isArray(persistedMarketMemory)
      ? persistedMarketMemory
      : {};

  metaLearningStore =
    persistedMetaLearning &&
    typeof persistedMetaLearning === "object" &&
    !Array.isArray(persistedMetaLearning)
      ? persistedMetaLearning
      : {};

  runtimePreviewStoresLoaded = true;
}

async function hydrateMarketRuntimeState() {
  await ensureRuntimePreviewStoresLoaded();

  return {
    marketMemoryKeys: Object.keys(marketMemoryStore || {}).length,
    metaLearningKeys: Object.keys(metaLearningStore || {}).length,
  };
}

async function loadPrimaryMarketSymbols(limit = 250) {
  const safeLimit = clamp(Number(limit) || 250, 1, 2000);
  const universeSymbols = await listActiveUniverseSymbols(safeLimit, {
    country: SNAPSHOT_REGION,
  });

  if (universeSymbols.length) {
    return universeSymbols;
  }

  logger.warn("Universe empty for market data list; falling back to watchlist_symbols", {
    limit: safeLimit,
    region: SNAPSHOT_REGION,
  });

  return getActiveWatchlistSymbols(safeLimit);
}

function pct(part, total) {
  const p = Number(part);
  const t = Number(total);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return 0;
  return (p / t) * 100;
}

function normalizePriority(priority) {
  return clamp(safeNum(priority, 100), 1, 9999);
}

function classifyPriorityTier(priority) {
  const p = normalizePriority(priority);

  if (p <= 30) return "core";
  if (p <= 80) return "high";
  if (p <= 180) return "standard";
  return "extended";
}

function createEmptyTierStats() {
  return {
    total: 0,
    quotesLoaded: 0,
    normalizedOk: 0,
    historicalOk: 0,
    snapshotsSaved: 0,
    outcomeTracked: 0,
    failed: 0,
    skipped: 0,
  };
}

function createEmptySourceStats() {
  return {
    total: 0,
    normalizedOk: 0,
    snapshotsSaved: 0,
    outcomeTracked: 0,
    failed: 0,
  };
}

function ensureTierBucket(summary, tier) {
  if (!summary.byTier[tier]) {
    summary.byTier[tier] = createEmptyTierStats();
  }
  return summary.byTier[tier];
}

function ensureSourceBucket(summary, source) {
  const key = String(source || "unknown").toUpperCase();
  if (!summary.bySource[key]) {
    summary.bySource[key] = createEmptySourceStats();
  }
  return summary.bySource[key];
}

function buildSystemHealth(summary) {
  const symbolsTotal = safeNum(summary?.symbolsTotal, 0);
  const normalizedOk = safeNum(summary?.normalizedOk, 0);
  const historicalOk = safeNum(summary?.historicalOk, 0);
  const outcomeTracked = safeNum(summary?.outcomeTracked, 0);
  const failed = safeNum(summary?.failed, 0);
  const snapshotsSaved = safeNum(summary?.snapshotsSaved, 0);
  const skipped = safeNum(summary?.skipped, 0);

  const successRate = pct(normalizedOk, symbolsTotal);
  const historicalCoverage = pct(historicalOk, normalizedOk || symbolsTotal);
  const trackingCoverage = pct(outcomeTracked, snapshotsSaved || normalizedOk || symbolsTotal);
  const failureRate = pct(failed, symbolsTotal);
  const skipRate = pct(skipped, symbolsTotal);
  const snapshotCoverage = pct(snapshotsSaved, symbolsTotal);

  const score = clamp(
    Math.round(
      successRate * 0.32 +
      historicalCoverage * 0.20 +
      trackingCoverage * 0.18 +
      snapshotCoverage * 0.20 +
      (100 - failureRate) * 0.07 +
      (100 - skipRate) * 0.03
    ),
    0,
    100
  );

  let status = "critical";
  if (score >= 90) status = "excellent";
  else if (score >= 75) status = "good";
  else if (score >= 55) status = "warning";

  return {
    successRate: Number(successRate.toFixed(2)),
    historicalCoverage: Number(historicalCoverage.toFixed(2)),
    trackingCoverage: Number(trackingCoverage.toFixed(2)),
    snapshotCoverage: Number(snapshotCoverage.toFixed(2)),
    failureRate: Number(failureRate.toFixed(2)),
    skipRate: Number(skipRate.toFixed(2)),
    systemHealthScore: score,
    status,
  };
}

function buildRunRecommendations(summary, health) {
  const recommendations = [];

  if (safeNum(summary.totalActiveSymbols, 0) < 100) {
    recommendations.push("Aktive Symbolbasis ist noch zu klein für starkes Lernen.");
  }

  if (safeNum(summary.symbolsTotal, 0) < safeNum(summary.batchSize, 0)) {
    recommendations.push("Batch kleiner als erwartet: Universe oder Filter prüfen.");
  }

  if (safeNum(health.successRate, 0) < 85) {
    recommendations.push("Quote-/Normalisierungs-Erfolgsrate prüfen.");
  }

  if (safeNum(health.historicalCoverage, 0) < 70) {
    recommendations.push("Historische Datenabdeckung ist zu niedrig.");
  }

  if (safeNum(health.trackingCoverage, 0) < 85) {
    recommendations.push("Outcome-Tracking schreibt nicht für genug Symbole.");
  }

  if (safeNum(health.failureRate, 0) > 10) {
    recommendations.push("Fehlerquote zu hoch: Provider/Inputs prüfen.");
  }

  if (safeNum(summary.failed, 0) >= SNAPSHOT_FAIL_FAST_THRESHOLD) {
    recommendations.push("Viele Symbolfehler in einem Lauf: genauer Log-Check nötig.");
  }

  if (!recommendations.length) {
    recommendations.push("Lauf sieht gesund aus.");
  }

  return recommendations;
}

/* =========================================================
   SNAPSHOT STATE TABLE
========================================================= */

async function initSnapshotStateTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS snapshot_scan_state (
      key TEXT PRIMARY KEY,
      offset_value INTEGER DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

async function loadSnapshotOffset() {
  try {
    const res = await pool.query(
      `
      SELECT offset_value
      FROM snapshot_scan_state
      WHERE key = $1
      LIMIT 1
      `,
      [SNAPSHOT_STATE_KEY]
    );

    if (!res.rows.length) return 0;

    return clamp(safeNum(res.rows[0].offset_value, 0), 0, 1000000);
  } catch (err) {
    logger.error("loadSnapshotOffset error", { message: err.message });
    return 0;
  }
}

async function saveSnapshotOffset(offsetValue) {
  const val = clamp(safeNum(offsetValue, 0), 0, 1000000);

  try {
    await pool.query(
      `
      INSERT INTO snapshot_scan_state (key, offset_value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key)
      DO UPDATE SET
        offset_value = EXCLUDED.offset_value,
        updated_at = NOW()
      `,
      [SNAPSHOT_STATE_KEY, val]
    );
  } catch (err) {
    logger.error("saveSnapshotOffset failed", { offset: val, message: err.message });
  }
}

async function countActiveSnapshotSymbols(region = SNAPSHOT_REGION) {
  const res = await pool.query(
    `
    SELECT COUNT(*)::int AS c
    FROM watchlist_symbols
    WHERE is_active = TRUE
      AND LOWER(COALESCE(region, 'us')) = $1
    `,
    [String(region || "us").toLowerCase()]
  );

  return safeNum(res.rows?.[0]?.c, 0);
}

async function getSnapshotCandidates(limit = SNAPSHOT_BATCH_SIZE) {
  const batchSize = clamp(Number(limit) || SNAPSHOT_BATCH_SIZE, 1, SNAPSHOT_SYMBOL_LIMIT);
  await initUniverseTables();

  const universeBatch = await getUniverseBatch(batchSize, undefined, {
    country: SNAPSHOT_REGION,
  });

  const universeItems = Array.isArray(universeBatch?.items)
    ? universeBatch.items
    : [];

  if (universeItems.length) {
    const candidates = universeItems
      .map((item) => {
        const priority = normalizePriority(item.priority);
        return {
          symbol: String(item.symbol || "").trim().toUpperCase(),
          priority,
          tier: classifyPriorityTier(priority),
          region: String(item.country || SNAPSHOT_REGION || "us").toLowerCase(),
        };
      })
      .filter((item) => item.symbol);

    const tierMix = candidates.reduce((acc, item) => {
      acc[item.tier] = (acc[item.tier] || 0) + 1;
      return acc;
    }, {});

    logger.info("Snapshot candidates loaded", {
      count: candidates.length,
      batchSize,
      totalActive: safeNum(universeBatch?.totalActive, 0),
      offsetUsed: safeNum(universeBatch?.cursor, 0),
      nextOffset: safeNum(universeBatch?.nextCursor, 0),
      wrapped: Boolean(universeBatch?.wrapped),
      region: SNAPSHOT_REGION,
      source: "universe_symbols",
      tierMix,
    });

    return {
      totalActive: safeNum(universeBatch?.totalActive, candidates.length),
      batchSize,
      offsetUsed: safeNum(universeBatch?.cursor, 0),
      nextOffset: safeNum(universeBatch?.nextCursor, 0),
      wrapped: Boolean(universeBatch?.wrapped),
      candidates,
    };
  }

  const totalActive = await countActiveSnapshotSymbols(SNAPSHOT_REGION);

  if (!totalActive) {
    logger.warn("No snapshot candidates found in watchlist_symbols", {
      region: SNAPSHOT_REGION,
      limit: batchSize,
    });

    return {
      totalActive: 0,
      batchSize,
      offsetUsed: 0,
      nextOffset: 0,
      wrapped: false,
      candidates: [],
    };
  }

  let offset = await loadSnapshotOffset();
  if (offset >= totalActive) {
    offset = 0;
    await saveSnapshotOffset(0);
  }

  let wrapped = false;

  let res = await pool.query(
    `
    SELECT
      symbol,
      priority,
      region
    FROM watchlist_symbols
    WHERE is_active = TRUE
      AND LOWER(COALESCE(region, 'us')) = $1
    ORDER BY priority ASC, symbol ASC
    OFFSET $2
    LIMIT $3
    `,
    [SNAPSHOT_REGION, offset, batchSize]
  );

  let rows = Array.isArray(res.rows) ? res.rows : [];

  if (!rows.length && totalActive > 0) {
    wrapped = true;
    offset = 0;

    res = await pool.query(
      `
      SELECT
        symbol,
        priority,
        region
      FROM watchlist_symbols
      WHERE is_active = TRUE
        AND LOWER(COALESCE(region, 'us')) = $1
      ORDER BY priority ASC, symbol ASC
      OFFSET 0
      LIMIT $2
      `,
      [SNAPSHOT_REGION, batchSize]
    );

    rows = Array.isArray(res.rows) ? res.rows : [];
  }

  const candidates = rows
    .map((row) => {
      const symbol = String(row.symbol || "").trim().toUpperCase();
      const priority = normalizePriority(row.priority);
      const region = String(row.region || "us").toLowerCase();
      const tier = classifyPriorityTier(priority);

      return {
        symbol,
        priority,
        tier,
        region,
      };
    })
    .filter((row) => row.symbol);

  const nextOffset =
    totalActive > 0
      ? (offset + candidates.length) % totalActive
      : 0;

  const tierMix = candidates.reduce((acc, item) => {
    acc[item.tier] = (acc[item.tier] || 0) + 1;
    return acc;
  }, {});

  logger.info("Snapshot candidates loaded", {
    count: candidates.length,
    batchSize,
    totalActive,
    offsetUsed: offset,
    nextOffset,
    wrapped,
    region: SNAPSHOT_REGION,
    source: "watchlist_symbols_fallback",
    tierMix,
  });

  return {
    totalActive,
    batchSize,
    offsetUsed: offset,
    nextOffset,
    wrapped,
    candidates,
  };
}

/* =========================================================
   TABLE INIT
========================================================= */

async function ensureTablesExist() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_snapshots (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      price NUMERIC,
      open NUMERIC,
      high NUMERIC,
      low NUMERIC,
      volume BIGINT,
      source TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hqs_scores (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      hqs_score NUMERIC,
      momentum NUMERIC,
      quality NUMERIC,
      stability NUMERIC,
      relative NUMERIC,
      regime TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await initAdvancedMetricsTable();
  await initJobLocksTable();
  await initWatchlistTable();
  await seedDefaultWatchlist();
  await initOutcomeTrackingTable();
  await initSnapshotStateTable();
  await initMarketNewsTable();
  await initUniverseTables();

  logger.info("Tables ensured");
}

/* =========================================================
   LOAD LATEST HQS SCORE
========================================================= */

async function loadLatestHqsScore(symbol) {
  try {
    const res = await pool.query(
      `
      SELECT
        hqs_score,
        momentum,
        quality,
        stability,
        relative,
        regime,
        created_at
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
      hqsScore: row.hqs_score !== null ? Number(row.hqs_score) : null,
      momentum: row.momentum !== null ? Number(row.momentum) : null,
      quality: row.quality !== null ? Number(row.quality) : null,
      stability: row.stability !== null ? Number(row.stability) : null,
      relative: row.relative !== null ? Number(row.relative) : null,
      regime: row.regime ?? null,
      hqsCreatedAt: row.created_at
        ? new Date(row.created_at).toISOString()
        : null,
    };
  } catch (err) {
    logger.error("loadLatestHqsScore error", { message: err.message });
    return null;
  }
}

/* =========================================================
   MONTE CARLO SCENARIOS
========================================================= */

function buildMultiHorizonScenarios(S, mu, sigmaDaily, simulations) {
  const price0 = safeNum(S, 0);
  const drift = safeNum(mu, 0);
  const sig = safeNum(sigmaDaily, 0);

  if (!Number.isFinite(price0) || price0 <= 0) return null;

  const sim =
    Number.isFinite(simulations) && simulations > 100 ? simulations : 800;

  const h30 = monteCarloSimulation(price0, drift, sig, 30, sim);
  const h90 = monteCarloSimulation(price0, drift, sig, 90, sim);
  const h180 = monteCarloSimulation(price0, drift, sig, 180, sim);
  const h252 = monteCarloSimulation(price0, drift, sig, 252, sim);

  return {
    horizons: {
      "30": { base: h30.realistic, bull: h30.optimistic, bear: h30.pessimistic },
      "90": { base: h90.realistic, bull: h90.optimistic, bear: h90.pessimistic },
      "180": { base: h180.realistic, bull: h180.optimistic, bear: h180.pessimistic },
      "252": { base: h252.realistic, bull: h252.optimistic, bear: h252.pessimistic },
    },
  };
}

/* =========================================================
   HELPER: MACRO / FLOW FALLBACK CONTEXT
========================================================= */

function buildMacroContextFallback({ trendData, normalized }) {
  return {
    vixTrend: safeNum(trendData?.volatilityAnnual, 0) - 0.2,
    marketBreadth: safeNum(trendData?.trend, 0) > 0 ? 0.62 : 0.42,
    dollarTrend: 0,
    marketTrend: safeNum(trendData?.trend, 0),
    oilTrend: 0,
    goldTrend: 0,
    bondTrend: 0,
    techTrend: safeNum(normalized?.changesPercentage, 0) / 100,
  };
}

function buildCapitalFlowFallback({ normalized }) {
  const volume = safeNum(normalized?.volume, 0);
  const avgVolume = safeNum(normalized?.avgVolume, volume || 1);

  return {
    sectorData: normalized?.sector
      ? [
          {
            sector: String(normalized.sector).toLowerCase(),
            performance: safeNum(normalized?.changesPercentage, 0) / 100,
          },
        ]
      : [],
    etfFlows: [],
    advancers: safeNum(normalized?.changesPercentage, 0) >= 0 ? 3200 : 1800,
    decliners: safeNum(normalized?.changesPercentage, 0) >= 0 ? 1800 : 3200,
    volumeData: {
      volume,
      avgVolume,
    },
  };
}

/* =========================================================
   SNAPSHOT PIPELINE
========================================================= */

async function buildMarketSnapshot() {
  await ensureRuntimePreviewStoresLoaded();

  const won = await acquireLock("snapshot_job", 12 * 60);

  if (!won) {
    logger.warn("Snapshot job skipped (lock held)");
    return;
  }

  logger.info("Building market snapshot...");

  const summary = {
    totalActiveSymbols: 0,
    batchSize: SNAPSHOT_BATCH_SIZE,
    batchOffsetStart: 0,
    batchOffsetEnd: 0,
    batchWrapped: false,
    symbolsTotal: 0,
    quotesLoaded: 0,
    normalizedOk: 0,
    historicalOk: 0,
    hqsBuilt: 0,
    snapshotsSaved: 0,
    hqsSaved: 0,
    outcomeTracked: 0,
    skipped: 0,
    failed: 0,
    byTier: {},
    bySource: {},
  };

  const batch = await getSnapshotCandidates(SNAPSHOT_BATCH_SIZE);

  summary.totalActiveSymbols = batch.totalActive;
  summary.batchSize = batch.batchSize;
  summary.batchOffsetStart = batch.offsetUsed;
  summary.batchOffsetEnd = batch.nextOffset;
  summary.batchWrapped = batch.wrapped;
  summary.symbolsTotal = batch.candidates.length;

  if (!batch.candidates.length) {
    const health = buildSystemHealth(summary);
    const recommendations = buildRunRecommendations(summary, health);

    logger.warn("No symbols available for snapshot run");
    logger.info("Snapshot complete", {
      summary,
      health,
      recommendations,
    });
    return;
  }

  let scoringActiveNewsBySymbol = {};
  let newsContextBySymbol = {};

  try {
    ({
      scoringActiveNewsBySymbol,
      newsContextBySymbol,
    } = await loadOpportunityNewsContextBySymbols(
      batch.candidates.map((candidate) => candidate.symbol)
    ));
  } catch (error) {
    logger.warn("Snapshot news context load failed", {
      message: error.message,
    });
  }

  let socialPosts = [];
  try {
    socialPosts = await collectSocialSignals();
  } catch (error) {
    logger.warn("Social signals load failed", { message: error.message });
  }

  for (const candidate of batch.candidates) {
    const symbol = candidate.symbol;
    const tier = candidate.tier;

    ensureTierBucket(summary, tier).total++;

    try {
      const raw = await fetchQuote(symbol);
      if (!raw || !raw.length) {
        summary.skipped++;
        ensureTierBucket(summary, tier).skipped++;
        continue;
      }

      summary.quotesLoaded++;
      ensureTierBucket(summary, tier).quotesLoaded++;

      const providerSource = String(raw?.[0]?.source || "massive").toLowerCase();
      ensureSourceBucket(summary, providerSource).total++;

      const normalized = normalizeMarketData(raw[0], providerSource, "us");
      if (!normalized) {
        summary.skipped++;
        ensureTierBucket(summary, tier).skipped++;
        continue;
      }

      summary.normalizedOk++;
      ensureTierBucket(summary, tier).normalizedOk++;
      ensureSourceBucket(summary, providerSource).normalizedOk++;

      let trendData = null;
      let scenarios = null;

      let regime = "neutral";
      let adaptiveWeights = await computeAdaptiveWeights(regime);

      try {
        const historical = await getHistoricalPrices(symbol, HIST_PERIOD);

        const prices = (historical || [])
          .map((d) => Number(d?.close))
          .filter((n) => Number.isFinite(n) && n > 0);

        if (prices.length >= 30) {
          summary.historicalOk++;
          ensureTierBucket(summary, tier).historicalOk++;

          trendData = buildTrendScore(prices);

          regime = detectMarketRegime(
            trendData.trend,
            trendData.volatilityAnnual
          );

          adaptiveWeights = await computeAdaptiveWeights(regime);

          scenarios = buildMultiHorizonScenarios(
            prices[0],
            trendData.trend,
            trendData.volatilityDaily,
            MC_SIMS
          );

          await upsertAdvancedMetrics(symbol, {
            regime,
            trend: trendData.trend,
            volatilityAnnual: trendData.volatilityAnnual,
            volatilityDaily: trendData.volatilityDaily,
            scenarios,
          });
        } else {
          logger.warn("Historical insufficient", {
            symbol,
            points: prices.length,
            period: HIST_PERIOD,
            tier,
          });
        }
      } catch (histErr) {
        logger.warn("Historical unavailable", {
          symbol,
          message: histErr.message,
          tier,
        });
      }

      const hqs = await buildHQSResponse(
        normalized,
        0,
        adaptiveWeights,
        regime
      );

      const newsContext = newsContextBySymbol?.[symbol] || null;
      const symbolSocialPosts = socialPosts.filter(
        (post) => Array.isArray(post?.symbols) && post.symbols.includes(symbol)
      );
      const signalContext = buildSignalContext(
        {
          symbol,
          momentum: hqs?.breakdown?.momentum,
          trend: trendData?.trend,
        },
        newsContext,
        scoringActiveNewsBySymbol?.[symbol] || [],
        symbolSocialPosts
      );

      if (hqs) {
        summary.hqsBuilt++;
      }

      const features = buildFeatures(normalized, {
        trend: trendData?.trend,
        volatilityAnnual: trendData?.volatilityAnnual,
        avgVolume: normalized.avgVolume,
      });

      const discoveries = discoverOpportunities(
        symbol,
        normalized,
        features,
        trendData
      );

      const narratives = detectNarrative({
        sector: normalized.sector,
        trend: trendData?.trend,
        relative: hqs?.breakdown?.relative,
      });

      const simulations = runMarketSimulations(features, trendData);
      const resilienceScore = calculateResilience(simulations);

      const research = runResearch(
        symbol,
        normalized,
        features,
        trendData,
        hqs?.hqsScore
      );

      const brain = buildAIScore({
        symbol,
        hqsScore: hqs?.hqsScore,
        features,
        advanced: trendData,
        discoveries,
      });

      const strategy = applyStrategy(
        symbol,
        brain?.aiScore,
        features,
        trendData
      );

      const macroContext = buildMacroContextFallback({
        trendData,
        normalized,
      });

      const crossAsset = analyzeCrossAssetEnvironment(macroContext);

      const capitalFlows = analyzeCapitalFlows(
        buildCapitalFlowFallback({ normalized })
      );

      const eventIntelligence = analyzeMacroEvents(macroContext);

      const setupSignature = buildSetupSignature({
        regime,
        strategy: strategy?.strategy || "balanced",
        discoveries,
        narratives,
        features,
        crossSignals: crossAsset?.signals || [],
      });

      const marketMemory = evaluateMarketMemory({
        memoryStore: marketMemoryStore,
        symbol,
        regime,
        strategy: strategy?.strategy || "balanced",
        discoveries,
        narratives,
        features,
        crossSignals: crossAsset?.signals || [],
        prediction: safeNum(brain?.aiScore, 0) / 100,
        actualReturn: 0,
        confidence: 0.5,
        persist: false,
      });

      const metaLearning = evaluateMetaLearning({
        metaStore: metaLearningStore,
        context: {
          regime,
          riskMode: "neutral",
          strategy: strategy?.strategy || "balanced",
          dominantNarrative: narratives?.[0]?.type || "none",
        },
        signalMetrics: {
          trendScore: safeNum(trendData?.trendStrength, 0),
          discoveryCount: discoveries?.length || 0,
          capitalFlowStrength: capitalFlows?.marketBreadth || 0,
          eventCount: eventIntelligence?.events?.length || 0,
          memoryScore: marketMemory?.memoryStats?.memoryScore || 0,
          narrativeCount: narratives?.length || 0,
          strategyScore: safeNum(strategy?.strategyAdjustedScore, 0),
          crossAssetCount: crossAsset?.signals?.length || 0,
        },
        actualReturn: 0,
        symbol,
        persist: false,
      });

      const orchestrator = orchestrateMarket({
        trendData,
        aiScore: brain?.aiScore,
        conviction: brain?.aiScore,
        resilienceScore,
        narratives,
        discoveries,
        crossAssetSignals: crossAsset?.signals || [],
        capitalFlows,
        macroContext: {
          ...macroContext,
          marketBreadth:
            capitalFlows?.marketBreadth ?? macroContext.marketBreadth,
        },
        eventIntelligence,
        marketMemory,
        metaLearning,
        newsContext,
        signalContext,
      });

      const finalView = await buildIntegratedMarketView({
        symbol,
        hqs,
        features,
        discoveries,
        learning: {
          confidence: 0.5,
        },
        brain,
        strategy,
        narratives,
        simulations,
        resilienceScore,
        research,
        newsContext,
        signalContext,
        globalContext: {
          crossAsset,
          capitalFlows,
          eventIntelligence,
          orchestrator,
          marketMemory: marketMemory?.memoryStats || null,
          metaLearning: metaLearning?.trustProfile || null,
          newsContext,
          signalContext,
        },
      });

      logger.info("AI Market View", {
        symbol,
        tier,
        priority: candidate.priority,
        source: normalized.source,
        finalConviction: finalView?.finalConviction,
        finalRating: finalView?.finalRating,
        aiScore: brain?.aiScore,
        opportunityStrength: orchestrator?.opportunityStrength,
        orchestratorConfidence: orchestrator?.orchestratorConfidence,
      });

      await pool.query(
        `
        INSERT INTO market_snapshots
        (symbol, price, open, high, low, volume, source, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        `,
        [
          normalized.symbol,
          normalized.price,
          normalized.open,
          normalized.high,
          normalized.low,
          normalized.volume,
          normalized.source,
        ]
      );
      summary.snapshotsSaved++;
      ensureTierBucket(summary, tier).snapshotsSaved++;
      ensureSourceBucket(summary, providerSource).snapshotsSaved++;

      await pool.query(
        `
        INSERT INTO hqs_scores
        (symbol, hqs_score, momentum, quality, stability, relative, regime, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        `,
        [
          hqs.symbol,
          hqs.hqsScore,
          hqs.breakdown?.momentum ?? null,
          hqs.breakdown?.quality ?? null,
          hqs.breakdown?.stability ?? null,
          hqs.breakdown?.relative ?? null,
          regime,
        ]
      );
      summary.hqsSaved++;

      const rawInputSnapshotData = {
        hqsScore: hqs?.hqsScore,
        hqsBreakdown: hqs?.breakdown || {},
        aiScore: brain?.aiScore,
        regime,
        strategy: strategy?.strategy || null,
        features: {
          momentum: features?.momentum,
          quality: features?.quality,
          stability: features?.stability,
          relative: features?.relative,
          trendStrength: features?.trendStrength,
          relativeVolume: features?.relativeVolume,
          liquidityScore: features?.liquidityScore,
          volatility: features?.volatility,
        },
        signalContext: {
          signalDirection: signalContext?.signalDirection || null,
          signalStrength: signalContext?.signalStrength,
          signalDirectionScore: signalContext?.signalDirectionScore,
          signalConfidence: signalContext?.signalConfidence,
          earlySignalType: signalContext?.earlySignalType || null,
          buzzScore: signalContext?.buzzScore,
          sentimentScore: signalContext?.sentimentScore,
          trendScore: signalContext?.trendScore,
          trendLevel: signalContext?.trendLevel || null,
        },
        newsContext: {
          activeCount: newsContext?.activeCount,
          direction: newsContext?.direction || null,
          directionScore: newsContext?.directionScore,
          strengthScore: newsContext?.strengthScore,
          weightedRelevance: newsContext?.weightedRelevance,
          weightedConfidence: newsContext?.weightedConfidence,
          weightedMarketImpact: newsContext?.weightedMarketImpact,
          dominantEventType: newsContext?.dominantEventType || null,
        },
        orchestrator: {
          opportunityStrength: orchestrator?.opportunityStrength,
          orchestratorConfidence: orchestrator?.orchestratorConfidence,
        },
        memoryScore: marketMemory?.memoryStats?.memoryScore || 0,
        entryPrice: normalized?.price,
        capturedAt: new Date().toISOString(),
      };

      const robustnessScore = calculateRobustnessScore(rawInputSnapshotData);
      rawInputSnapshotData.historical_context = { robustness: robustnessScore };

      // Re-compute pattern signature now that actual robustnessScore is known.
      const { patternKey, patternContext } = buildStructuredPatternSignature({
        regime,
        volatility:      features?.volatility,
        trendStrength:   features?.trendStrength,
        sentimentScore:  signalContext?.sentimentScore,
        newsDirection:   newsContext?.direction,
        buzzScore:       signalContext?.buzzScore,
        signalDirection: signalContext?.signalDirection,
        robustnessScore,
        hqsScore:        hqs?.hqsScore,
        finalConviction: finalView?.finalConviction,
      });

      const trackingEntry = await createOutcomeTrackingEntry({
        symbol: normalized.symbol,
        predictionType: "market_view",
        regime,
        strategy: strategy?.strategy || "balanced",
        hqsScore: hqs?.hqsScore,
        aiScore: brain?.aiScore,
        finalConviction: finalView?.finalConviction,
        finalConfidence: finalView?.finalConfidence,
        memoryScore: marketMemory?.memoryStats?.memoryScore || 0,
        opportunityStrength: orchestrator?.opportunityStrength || 0,
        orchestratorConfidence:
          orchestrator?.orchestratorConfidence || 0,
        setupSignature,
        horizonDays: OUTCOME_HORIZON_DAYS,
        entryPrice: normalized?.price,
        payload: {
          symbol: normalized.symbol,
          priority: candidate.priority,
          tier,
          region: candidate.region,
          regime,
          hqs,
          features,
          discoveries,
          narratives,
          simulations,
          resilienceScore,
          research,
          brain,
          strategy,
          orchestrator,
          finalView,
          historicalContext: { robustness: robustnessScore },
        },
        rawInputSnapshot: rawInputSnapshotData,
        analysisRationale: buildAnalysisRationale({
          hqsScore: hqs?.hqsScore,
          aiScore: brain?.aiScore,
          regime,
          strategy: strategy?.strategy || null,
          features,
          signalContext,
          newsContext,
          orchestrator,
          discoveries,
          narratives,
        }),
        patternKey,
        patternContext,
      });

      if (trackingEntry) {
        summary.outcomeTracked++;
        ensureTierBucket(summary, tier).outcomeTracked++;
        ensureSourceBucket(summary, providerSource).outcomeTracked++;
      }

      logger.info(`Snapshot saved for ${symbol}`);
    } catch (err) {
      summary.failed++;
      ensureTierBucket(summary, tier).failed++;

      logger.error(`Snapshot error for ${symbol}`, {
        message: err.message,
        tier,
        priority: candidate.priority,
      });
    }
  }

  await saveSnapshotOffset(batch.nextOffset);

  const health = buildSystemHealth(summary);
  const recommendations = buildRunRecommendations(summary, health);

  logger.info("Snapshot complete", {
    summary,
    health,
    recommendations,
  });
}

/* =========================================================
   LOAD LATEST SNAPSHOT (DB-first helper)
========================================================= */

async function loadLatestSnapshot(symbol) {
  try {
    const res = await pool.query(
      `
      SELECT
        symbol,
        price,
        open,
        high,
        low,
        volume,
        source,
        created_at AS timestamp
      FROM market_snapshots
      WHERE symbol = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [String(symbol).trim().toUpperCase()]
    );

    if (!res.rows.length) return null;

    const row = res.rows[0];

    return {
      symbol: row.symbol,
      price: row.price !== null ? Number(row.price) : null,
      open: row.open !== null ? Number(row.open) : null,
      high: row.high !== null ? Number(row.high) : null,
      low: row.low !== null ? Number(row.low) : null,
      volume: row.volume !== null ? Number(row.volume) : null,
      source: row.source ?? null,
      timestamp: row.timestamp ? new Date(row.timestamp).toISOString() : null,
    };
  } catch (err) {
    logger.error("loadLatestSnapshot error", { message: err.message });
    return null;
  }
}

/* =========================================================
   MARKET DATA (API / UI)
========================================================= */

async function getMarketData(symbol) {
  try {
    const symbols = symbol
      ? [String(symbol).trim().toUpperCase()]
      : await loadPrimaryMarketSymbols(250);

    const results = [];

    for (const s of symbols) {
      const snapshot = await loadLatestSnapshot(s);
      if (!snapshot) continue;

      const entry = { ...snapshot };

      const hqs = await loadLatestHqsScore(s);
      if (hqs) Object.assign(entry, hqs);

      const adv = await loadAdvancedMetrics(s);

      if (adv) {
        entry.regime = entry.regime ?? adv.regime ?? null;
        entry.trend = adv.trend ?? null;
        entry.volatility = adv.volatility ?? null;
        entry.scenarios = adv.scenarios ?? null;
        entry.advancedUpdatedAt = adv.advancedUpdatedAt ?? null;
      }

      results.push(entry);
    }

    return results;
  } catch (error) {
    logger.error("MarketData Error", {
      message: error.message,
    });

    return [];
  }
}

async function pingDb() {
  await pool.query("SELECT 1");
}

module.exports = {
  getMarketData,
  buildMarketSnapshot,
  hydrateMarketRuntimeState,
  ensureTablesExist,
  pingDb,
};
