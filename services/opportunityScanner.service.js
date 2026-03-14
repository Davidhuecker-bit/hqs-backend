"use strict";

const { Pool } = require("pg");
const logger = require("../utils/logger");

const {
  buildScoringNewsContext,
  getScoringActiveMarketNewsBySymbols,
} = require("./marketNews.service");
const {
  loadLatestOutcomeTrackingBySymbols,
} = require("./outcomeTracking.repository");
const {
  loadRuntimeState,
  RUNTIME_STATE_MARKET_MEMORY_KEY,
  RUNTIME_STATE_META_LEARNING_KEY,
} = require("./discoveryLearning.repository");
const { buildMarketSentiment } = require("./marketSentiment.service");
const { buildMarketBuzz } = require("./marketBuzz.service");
const { buildTrendingStock } = require("./trendingStocks.service");
const { buildEarlySignals } = require("./earlySignal.service");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =========================================================
   IN-MEMORY PREVIEW STORES
========================================================= */

let marketMemoryStore = {};
let metaLearningStore = {};
let runtimePreviewStoresLoaded = false;
const OPPORTUNITY_NEWS_LIMIT = Math.max(
  1,
  Math.min(Number(process.env.OPPORTUNITY_NEWS_LIMIT || 5), 10)
);
const OPPORTUNITY_REASON_LIMIT = 4;
const SIGNAL_REASON_LIMIT = 4;
const SIGNAL_DIRECTION_THRESHOLD = 0.12;

/* =========================================================
   UTIL
========================================================= */

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeObject(value, fallback = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }

  try {
    if (typeof structuredClone === "function") {
      return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return fallback;
  }
}

async function ensureRuntimePreviewStoresLoaded() {
  if (runtimePreviewStoresLoaded) return;

  const [persistedMarketMemory, persistedMetaLearning] = await Promise.all([
    loadRuntimeState(RUNTIME_STATE_MARKET_MEMORY_KEY),
    loadRuntimeState(RUNTIME_STATE_META_LEARNING_KEY),
  ]);

  marketMemoryStore = safeObject(persistedMarketMemory, {});
  metaLearningStore = safeObject(persistedMetaLearning, {});
  runtimePreviewStoresLoaded = true;
}

function norm0to1(x) {
  const n = safeNum(x, 0);
  if (n > 1.5) return clamp(n / 100, 0, 1);
  return clamp(n, 0, 1);
}

function uniqueTexts(values = [], maxItems = SIGNAL_REASON_LIMIT) {
  const seen = new Set();
  const result = [];

  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "")
      .replace(/\s+/g, " ")
      .trim();

    if (!text) continue;

    const key = text.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(text);

    if (result.length >= maxItems) break;
  }

  return result;
}

function normalizeSignalDirection(directionScore) {
  const score = clamp(safeNum(directionScore, 0), -1, 1);

  if (score >= SIGNAL_DIRECTION_THRESHOLD) return "bullish";
  if (score <= -SIGNAL_DIRECTION_THRESHOLD) return "bearish";
  return "neutral";
}

function buildSignalSummary(signalContext = {}) {
  if (!signalContext || typeof signalContext !== "object") return null;

  const parts = [];
  const direction = signalContext.signalDirection || "neutral";
  const earlySignalType = signalContext.earlySignalType || null;
  const trendLevel = signalContext.trendLevel || null;
  const buzzScore = clamp(safeNum(signalContext.buzzScore, 0), 0, 100);
  const signalStrength = clamp(safeNum(signalContext.signalStrength, 0), 0, 100);

  if (direction === "bullish") {
    parts.push("bullisches Signal");
  } else if (direction === "bearish") {
    parts.push("bearisches Signal");
  } else if (signalStrength > 0) {
    parts.push("neutrales Signal");
  }

  if (trendLevel) {
    parts.push(`Trend ${trendLevel}`);
  }

  if (earlySignalType === "potential_breakout") {
    parts.push("frühes Breakout");
  } else if (earlySignalType === "early_interest") {
    parts.push("frühes Interesse");
  }

  if (buzzScore >= 60) {
    parts.push(`Buzz ${Math.round(buzzScore)}`);
  }

  return parts.length ? parts.join(" · ") : null;
}

function buildSignalReasons({
  sentimentScore,
  buzzScore,
  trendLevel,
  earlySignalType,
  newsContext,
}) {
  const reasons = [];

  if (earlySignalType === "potential_breakout") {
    reasons.push("frühes Breakout-Signal");
  } else if (earlySignalType === "early_interest") {
    reasons.push("frühes Marktinteresse");
  }

  if (trendLevel === "exploding" || trendLevel === "very_hot") {
    reasons.push(`Trend ${trendLevel}`);
  } else if (trendLevel === "hot") {
    reasons.push("Trend hot");
  }

  if (buzzScore >= 70) {
    reasons.push("hoher Markt-Buzz");
  } else if (buzzScore >= 50) {
    reasons.push("solider Markt-Buzz");
  }

  if (sentimentScore >= 20) {
    reasons.push("positives Sentiment");
  } else if (sentimentScore <= -20) {
    reasons.push("negatives Sentiment");
  }

  if (!reasons.length) {
    reasons.push(...uniqueTexts(newsContext?.reasons, SIGNAL_REASON_LIMIT));
  }

  return uniqueTexts(reasons, SIGNAL_REASON_LIMIT);
}

function buildSignalContext(row = {}, newsContext = null, newsItems = []) {
  const symbol = String(row?.symbol || "").trim().toUpperCase();
  if (!symbol) return null;

  const marketSentiment = buildMarketSentiment({
    sentimentScore:
      newsContext?.marketSentiment?.sentimentScore ??
      safeNum(newsContext?.directionScore, 0) * 100,
    buzzScore:
      newsContext?.marketSentiment?.buzzScore ??
      newsContext?.strengthScore ??
      0,
    mentionCount:
      newsContext?.marketSentiment?.mentionCount ??
      newsContext?.activeCount ??
      0,
    reasons:
      newsContext?.marketSentiment?.reasons?.length
        ? newsContext.marketSentiment.reasons
        : newsContext?.reasons,
    sourceBreakdown: newsContext?.marketSentiment?.sourceBreakdown,
  });

  const marketBuzz =
    buildMarketBuzz({
      newsItems: Array.isArray(newsItems) ? newsItems : [],
    }).find((entry) => String(entry?.symbol || "").toUpperCase() === symbol) || null;

  const momentumScore = Math.round(norm0to1(row?.momentum) * 100);
  const trendSignal = buildTrendingStock({
    symbol,
    buzzScore:
      marketBuzz?.buzzScore ??
      safeNum(marketSentiment?.buzzScore, 0),
    priceMomentum: momentumScore,
  });

  const earlySignal = buildEarlySignals([
    {
      symbol,
      buzzScore:
        trendSignal?.buzzScore ??
        marketBuzz?.buzzScore ??
        0,
      priceMomentum: trendSignal?.priceMomentum ?? momentumScore,
      trendScore: trendSignal?.trendScore,
      trendLevel: trendSignal?.trendLevel,
    },
  ])[0] || null;

  const sentimentScore = clamp(
    safeNum(marketSentiment?.sentimentScore, 0),
    -100,
    100
  );
  const buzzScore = clamp(
    safeNum(marketBuzz?.buzzScore, marketSentiment?.buzzScore),
    0,
    100
  );
  const trendScore = clamp(safeNum(trendSignal?.trendScore, 0), 0, 100);
  const earlySignalStrength = clamp(safeNum(earlySignal?.strength, 0), 0, 100);
  const trendBias = clamp(safeNum(row?.trend, 0), -1, 1);
  const momentumBias = clamp((momentumScore - 50) / 50, -1, 1);
  const normalizedSentimentDirection = (sentimentScore / 100) * 0.5;
  const normalizedSentimentStrength = Math.abs(sentimentScore) * 0.2;

  let signalDirectionScore = clamp(
    normalizedSentimentDirection + momentumBias * 0.35 + trendBias * 0.15,
    -1,
    1
  );

  if (earlySignal?.signal && signalDirectionScore >= 0) {
    signalDirectionScore = clamp(signalDirectionScore + 0.08, -1, 1);
  }

  const signalStrength = clamp(
    Math.round(
      trendScore * 0.55 +
        normalizedSentimentStrength +
        buzzScore * 0.1 +
        earlySignalStrength * 0.15
    ),
    0,
    100
  );

  const directionAligned =
    (signalDirectionScore >= SIGNAL_DIRECTION_THRESHOLD && trendBias >= 0) ||
    (signalDirectionScore <= -SIGNAL_DIRECTION_THRESHOLD && trendBias < 0);

  const signalConfidence = clamp(
    Math.round(
      signalStrength * 0.45 +
        clamp(safeNum(newsContext?.weightedConfidence, 0), 0, 100) * 0.25 +
        clamp(safeNum(newsContext?.activeCount, 0), 0, 4) * 5 +
        (directionAligned ? 10 : 0)
    ),
    0,
    100
  );

  const signalContext = {
    sentimentScore,
    buzzScore,
    trendScore,
    trendLevel: trendSignal?.trendLevel || null,
    earlySignalType: earlySignal?.signal || null,
    earlySignalStrength,
    signalStrength,
    signalDirection: normalizeSignalDirection(signalDirectionScore),
    signalDirectionScore: Number(signalDirectionScore.toFixed(2)),
    signalConfidence,
    summary: null,
    reasons: [],
  };

  signalContext.summary = buildSignalSummary(signalContext);
  signalContext.reasons = buildSignalReasons({
    sentimentScore,
    buzzScore,
    trendLevel: signalContext.trendLevel,
    earlySignalType: signalContext.earlySignalType,
    newsContext,
  });

  return signalContext;
}

async function loadOpportunityNewsContextBySymbols(
  symbols = [],
  limitPerSymbol = OPPORTUNITY_NEWS_LIMIT
) {
  const normalizedSymbols = [
    ...new Set(
      (Array.isArray(symbols) ? symbols : [])
        .map((symbol) => String(symbol || "").trim().toUpperCase())
        .filter(Boolean)
    ),
  ];

  if (!normalizedSymbols.length) {
    return {
      scoringActiveNewsBySymbol: {},
      newsContextBySymbol: {},
    };
  }

  const scoringActiveNewsBySymbol = await getScoringActiveMarketNewsBySymbols(
    normalizedSymbols,
    limitPerSymbol
  );

  const newsContextBySymbol = normalizedSymbols.reduce((result, symbol) => {
    result[symbol] = buildScoringNewsContext(
      scoringActiveNewsBySymbol?.[symbol] || []
    );
    return result;
  }, {});

  return {
    scoringActiveNewsBySymbol,
    newsContextBySymbol,
  };
}

/* =========================================================
   OPPORTUNITY SCORE
========================================================= */

function calculateOpportunityScore(row) {
  const hqs = safeNum(row.hqs_score, 0);

  const momentum = norm0to1(row.momentum);
  const quality = norm0to1(row.quality);
  const stability = norm0to1(row.stability);
  const relative = norm0to1(row.relative);

  const volatility = safeNum(row.volatility, 0);

  const score =
    hqs * 0.55 +
    momentum * 10 +
    quality * 18 +
    stability * 18 +
    relative * 10 -
    volatility * 12;

  return clamp(Number(score.toFixed(2)), 0, 100);
}

/* =========================================================
   CONFIDENCE SCORE
========================================================= */

function calculateConfidence(row, opportunityScore) {
  const hqs = safeNum(row.hqs_score, 0);
  const quality = norm0to1(row.quality);
  const stability = norm0to1(row.stability);
  const volatility = safeNum(row.volatility, 0);

  let c =
    hqs * 0.35 +
    quality * 25 +
    stability * 25 -
    volatility * 18 +
    clamp(opportunityScore, -20, 80) * 0.3;

  return clamp(Math.round(c), 0, 100);
}

/* =========================================================
   OPPORTUNITY TYPE
========================================================= */

function classifyOpportunity(row) {
  const momentum = norm0to1(row.momentum);
  const quality = norm0to1(row.quality);
  const stability = norm0to1(row.stability);
  const volatility = safeNum(row.volatility, 0);
  const trend = safeNum(row.trend, 0);

  if (momentum > 0.75) return "momentum";

  if (trend > 0.10 && volatility < 0.30) {
    return "breakout";
  }

  if (quality > 0.7 && stability > 0.7) {
    return "quality";
  }

  return "balanced";
}

/* =========================================================
   REASON GENERATOR
========================================================= */

function generateReason(row, newsContext = null) {
  const reasons = [];

  const quality = norm0to1(row.quality);
  const stability = norm0to1(row.stability);
  const relative = norm0to1(row.relative);
  const momentum = norm0to1(row.momentum);
  const volatility = safeNum(row.volatility, 0);

  if (quality >= 0.65) reasons.push("gute Firma");
  if (stability >= 0.65) reasons.push("stabil");
  if (relative >= 0.65) reasons.push("stärker als der Markt");

  if (momentum >= 0.50 && momentum <= 0.85) {
    reasons.push("läuft gut");
  }

  if (volatility > 0.9) {
    reasons.push("hohe Schwankung");
  }

  if (safeNum(newsContext?.activeCount, 0) > 0) {
    if (newsContext?.direction === "bullish") {
      reasons.push("positive News-Lage");
    } else if (newsContext?.direction === "bearish") {
      reasons.push("negative News-Lage");
    }

    if (newsContext?.dominantEventType) {
      reasons.push(`News-Fokus ${newsContext.dominantEventType}`);
    }
  }

  if (!reasons.length) {
    reasons.push("solide Werte");
  }

  return Array.from(new Set(reasons)).slice(0, OPPORTUNITY_REASON_LIMIT).join(" + ");
}

function formatOpportunityNewsContext(newsContext = null) {
  if (!newsContext || safeNum(newsContext?.activeCount, 0) <= 0) return null;

  return {
    activeCount: safeNum(newsContext?.activeCount, 0),
    direction: newsContext?.direction || "neutral",
    directionScore: safeNum(newsContext?.directionScore, 0),
    strengthScore: safeNum(newsContext?.strengthScore, 0),
    dominantEventType: newsContext?.dominantEventType || null,
    weightedRelevance: safeNum(newsContext?.weightedRelevance, 0),
    weightedConfidence: safeNum(newsContext?.weightedConfidence, 0),
    weightedMarketImpact: safeNum(newsContext?.weightedMarketImpact, 0),
    summary: newsContext?.summary || null,
  };
}

function formatOpportunitySignalContext(signalContext = null) {
  if (!signalContext || safeNum(signalContext?.signalStrength, 0) <= 0) return null;

  return {
    sentimentScore: safeNum(signalContext?.sentimentScore, 0),
    buzzScore: safeNum(signalContext?.buzzScore, 0),
    trendScore: safeNum(signalContext?.trendScore, 0),
    trendLevel: signalContext?.trendLevel || null,
    earlySignalType: signalContext?.earlySignalType || null,
    earlySignalStrength: safeNum(signalContext?.earlySignalStrength, 0),
    signalStrength: safeNum(signalContext?.signalStrength, 0),
    signalDirection: signalContext?.signalDirection || "neutral",
    signalDirectionScore: safeNum(signalContext?.signalDirectionScore, 0),
    signalConfidence: safeNum(signalContext?.signalConfidence, 0),
    summary: signalContext?.summary || null,
    reasons: Array.isArray(signalContext?.reasons)
      ? signalContext.reasons.slice(0, SIGNAL_REASON_LIMIT)
      : [],
  };
}

function hasPersistedBatchResult(tracked = null) {
  const payload = safeObject(tracked?.payload, {});
  const finalView = safeObject(payload?.finalView, {});
  return Boolean(
    Object.keys(finalView).length ||
      Object.keys(safeObject(payload?.orchestrator, {})).length
  );
}

function buildOpportunityFromBatchResult(row, tracked = null) {
  if (!hasPersistedBatchResult(tracked)) return null;

  const payload = safeObject(tracked?.payload, {});
  const finalView = safeObject(payload?.finalView, {});
  const globalContext = safeObject(finalView?.globalContext, {});
  const brain = safeObject(payload?.brain, {});
  const strategy = safeObject(payload?.strategy, safeObject(finalView?.strategy, {}));
  const features = safeObject(payload?.features, safeObject(finalView?.features, {}));
  const orchestrator = safeObject(
    payload?.orchestrator,
    safeObject(globalContext?.orchestrator, {})
  );
  const newsContextCandidate = finalView?.newsContext ?? globalContext?.newsContext ?? null;
  const signalContextCandidate =
    finalView?.signalContext ?? globalContext?.signalContext ?? null;
  const newsContext =
    newsContextCandidate &&
    typeof newsContextCandidate === "object" &&
    !Array.isArray(newsContextCandidate)
      ? newsContextCandidate
      : null;
  const signalContext =
    signalContextCandidate &&
    typeof signalContextCandidate === "object" &&
    !Array.isArray(signalContextCandidate)
      ? signalContextCandidate
      : null;
  const discoveries = Array.isArray(payload?.discoveries)
    ? payload.discoveries
    : Array.isArray(finalView?.discoveries)
      ? finalView.discoveries
      : [];
  const narratives = Array.isArray(payload?.narratives)
    ? payload.narratives
    : Array.isArray(finalView?.narratives)
      ? finalView.narratives
      : [];
  const opportunityScore = calculateOpportunityScore(row);

  return {
    symbol: String(row?.symbol || "").trim().toUpperCase(),

    regime: row?.regime ?? tracked?.regime ?? finalView?.regime ?? null,
    type: classifyOpportunity(row),

    hqsScore: safeNum(row?.hqs_score, finalView?.hqsScore),
    opportunityScore,
    confidence: calculateConfidence(row, opportunityScore),

    aiScore: safeNum(finalView?.aiScore, brain?.aiScore),
    finalConviction: safeNum(finalView?.finalConviction, tracked?.finalConviction),
    finalConfidence: safeNum(finalView?.finalConfidence, tracked?.finalConfidence),
    finalRating: finalView?.finalRating || null,
    finalDecision: finalView?.finalDecision || null,

    strategy: strategy?.strategy || null,
    strategyLabel: strategy?.strategyLabel || null,

    narratives,
    discoveries,

    trend: row?.trend ?? null,
    volatility: row?.volatility ?? null,
    resilienceScore: safeNum(payload?.resilienceScore, finalView?.resilienceScore),

    opportunityStrength: safeNum(
      orchestrator?.opportunityStrength,
      tracked?.opportunityStrength
    ),
    orchestratorConfidence: safeNum(
      orchestrator?.orchestratorConfidence,
      tracked?.orchestratorConfidence
    ),

    whyInteresting: Array.isArray(finalView?.whyInteresting)
      ? finalView.whyInteresting
      : [],
    reason: generateReason(row, newsContext),
    newsContext: formatOpportunityNewsContext(newsContext),
    newsAdjustment: safeNum(finalView?.components?.newsAdjustment, 0),
    signalAdjustment: safeNum(finalView?.components?.signalAdjustment, 0),
    signalContext: formatOpportunitySignalContext(signalContext),

    marketMemory: safeObject(globalContext?.marketMemory, null),
    metaLearning: safeObject(globalContext?.metaLearning, null),

    advancedUpdatedAt: row?.advanced_updated_at
      ? new Date(row.advanced_updated_at).toISOString()
      : null,
  };
}

function buildFallbackOpportunity(row, tracked = null) {
  const payload = safeObject(tracked?.payload, {});
  const finalView = safeObject(payload?.finalView, {});
  const globalContext = safeObject(finalView?.globalContext, {});
  const brain = safeObject(payload?.brain, {});
  const strategy = safeObject(payload?.strategy, safeObject(finalView?.strategy, {}));
  const newsContextCandidate = finalView?.newsContext ?? globalContext?.newsContext ?? null;
  const signalContextCandidate =
    finalView?.signalContext ?? globalContext?.signalContext ?? null;
  const newsContext =
    newsContextCandidate &&
    typeof newsContextCandidate === "object" &&
    !Array.isArray(newsContextCandidate)
      ? newsContextCandidate
      : null;
  const signalContext =
    signalContextCandidate &&
    typeof signalContextCandidate === "object" &&
    !Array.isArray(signalContextCandidate)
      ? signalContextCandidate
      : null;
  const discoveries = Array.isArray(payload?.discoveries)
    ? payload.discoveries
    : Array.isArray(finalView?.discoveries)
      ? finalView.discoveries
      : [];
  const narratives = Array.isArray(payload?.narratives)
    ? payload.narratives
    : Array.isArray(finalView?.narratives)
      ? finalView.narratives
      : [];
  const opportunityScore = calculateOpportunityScore(row);

  return {
    symbol: String(row?.symbol || "").trim().toUpperCase(),

    regime: row?.regime ?? tracked?.regime ?? finalView?.regime ?? null,
    type: classifyOpportunity(row),

    hqsScore: safeNum(row?.hqs_score, finalView?.hqsScore),
    opportunityScore,
    confidence: calculateConfidence(row, opportunityScore),

    aiScore: safeNum(finalView?.aiScore, brain?.aiScore),
    finalConviction: safeNum(finalView?.finalConviction, tracked?.finalConviction),
    finalConfidence: safeNum(finalView?.finalConfidence, tracked?.finalConfidence),
    finalRating: finalView?.finalRating || null,
    finalDecision: finalView?.finalDecision || null,

    strategy: strategy?.strategy || null,
    strategyLabel: strategy?.strategyLabel || null,

    narratives,
    discoveries,

    trend: row?.trend ?? null,
    volatility: row?.volatility ?? null,
    resilienceScore: safeNum(payload?.resilienceScore, finalView?.resilienceScore),

    opportunityStrength: safeNum(
      payload?.orchestrator?.opportunityStrength,
      tracked?.opportunityStrength
    ),
    orchestratorConfidence: safeNum(
      payload?.orchestrator?.orchestratorConfidence,
      tracked?.orchestratorConfidence
    ),

    whyInteresting: Array.isArray(finalView?.whyInteresting)
      ? finalView.whyInteresting
      : [],
    reason: generateReason(row, newsContext),
    newsContext: formatOpportunityNewsContext(newsContext),
    newsAdjustment: safeNum(finalView?.components?.newsAdjustment, 0),
    signalAdjustment: safeNum(finalView?.components?.signalAdjustment, 0),
    signalContext: formatOpportunitySignalContext(signalContext),

    marketMemory: safeObject(globalContext?.marketMemory, null),
    metaLearning: safeObject(globalContext?.metaLearning, null),

    advancedUpdatedAt: row?.advanced_updated_at
      ? new Date(row.advanced_updated_at).toISOString()
      : null,
  };
}

async function hydrateOpportunityRuntimeState() {
  await ensureRuntimePreviewStoresLoaded();

  return {
    marketMemoryKeys: Object.keys(safeObject(marketMemoryStore, {})).length,
    metaLearningKeys: Object.keys(safeObject(metaLearningStore, {})).length,
  };
}

/* =========================================================
   MAIN SERVICE
========================================================= */

async function getTopOpportunities(arg = 10) {
  let options;

  if (typeof arg === "object" && arg !== null) {
    options = arg;
  } else {
    options = { limit: Number(arg) || 10 };
  }

  const limit = clamp(Number(options.limit || 10), 1, 25);

  const minHqs =
    options.minHqs === null || options.minHqs === undefined
      ? null
      : clamp(Number(options.minHqs), 0, 100);

  const regime =
    options.regime
      ? String(options.regime).trim().toLowerCase()
      : null;

  const res = await pool.query(`
    WITH latest_hqs AS (
      SELECT DISTINCT ON (symbol)
        symbol,
        hqs_score,
        momentum,
        quality,
        stability,
        relative,
        regime,
        created_at
      FROM hqs_scores
      ORDER BY symbol, created_at DESC
    )

    SELECT
      h.symbol,
      h.hqs_score,
      h.momentum,
      h.quality,
      h.stability,
      h.relative,
      COALESCE(h.regime, m.regime) AS regime,

      COALESCE(
        m.volatility,
        m.volatility_annual,
        m.vol_annual,
        0
      ) AS volatility,

      m.trend,
      m.scenarios,
      m.updated_at AS advanced_updated_at

    FROM latest_hqs h
    LEFT JOIN market_advanced_metrics m
      ON m.symbol = h.symbol

    ORDER BY h.hqs_score DESC
    LIMIT 250
  `);

  let rows = res.rows || [];

  if (minHqs !== null) {
    rows = rows.filter((r) => safeNum(r.hqs_score, 0) >= minHqs);
  }

  if (regime) {
    rows = rows.filter(
      (r) => String(r.regime || "").toLowerCase() === regime
    );
  }

  let persistedOutcomeBySymbol = {};
  if (rows.length) {
    try {
      persistedOutcomeBySymbol = await loadLatestOutcomeTrackingBySymbols(
        rows.map((row) => row.symbol)
      );
    } catch (error) {
      logger.warn("Opportunity batch result load failed", {
        message: error.message,
      });
    }
  }

  const opportunities = rows.map((row) => {
    const normalizedSymbol = String(row?.symbol || "").trim().toUpperCase();
    const persistedOpportunity = buildOpportunityFromBatchResult(
      row,
      persistedOutcomeBySymbol?.[normalizedSymbol] || null
    );

    if (persistedOpportunity) {
      return persistedOpportunity;
    }

    return buildFallbackOpportunity(
      row,
      persistedOutcomeBySymbol?.[normalizedSymbol] || null
    );
  });

  const persistedCount = rows.filter((row) => {
    const normalizedSymbol = String(row?.symbol || "").trim().toUpperCase();
    return hasPersistedBatchResult(persistedOutcomeBySymbol?.[normalizedSymbol] || null);
  }).length;
  const fallbackCount = Math.max(0, opportunities.length - persistedCount);

  opportunities.sort((a, b) => {
    if (b.finalConviction !== a.finalConviction) {
      return b.finalConviction - a.finalConviction;
    }

    if (b.finalConfidence !== a.finalConfidence) {
      return b.finalConfidence - a.finalConfidence;
    }

    return b.opportunityScore - a.opportunityScore;
  });

  const out = opportunities.slice(0, limit);

  logger.info("getTopOpportunities", {
    limit,
    minHqs,
    regime,
    persistedCount,
    fallbackCount,
    returned: out.length,
  });

  return out;
}

module.exports = {
  buildSignalContext,
  hydrateOpportunityRuntimeState,
  loadOpportunityNewsContextBySymbols,
  getTopOpportunities,
};
