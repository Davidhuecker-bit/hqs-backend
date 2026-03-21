"use strict";

/*
  HQS Engine – Core Stock Scoring Engine (Market-Regime Version B)
  Upgrade:
  - accepts adaptiveWeights (3rd param)
  - accepts regimeHint (4th param) from advanced regime engines
  - keeps DB-first weights as fallback
  HQS 2.0 Block 1: Data Quality, Confidence & Imputation Basis
  - computeDataQuality() derives confidenceScore, dataQualityFlags,
    imputationFlags, freshnessFlags and confidenceReason from live data
  - HQS output extended with these meta fields (backward compatible)
  HQS 2.0 Block 2: Sector / Peer-Group Normalization & Sector Templates
  - buildSectorContext() derives sectorTemplate, sectorScoringFlags,
    peerContextAvailable, normalizationMeta, sectorReason from entity meta
  - applySectorQualityAdjustment() applies sector-aware quality scoring
  - HQS output extended with sector meta fields (backward compatible)
  - 5th param entityMeta = { sector, industry } passed from marketService
  HQS 2.0 Block 3: Regime-based Weighting, Enhanced Stability & Liquidity Guardrails
  - computeRegimeWeightProfile() derives regime-sensitive factor weights from
    world state context (bull/expansion → momentum; bear/crash → quality+stability)
  - computeEnhancedStabilityMeta() extends stability beyond day range with
    volatility proxy, drawdown proxy, gap stress and price consistency band
  - computeLiquidityGuardrail() derives liquidityTier, slippageRisk and
    illiquidity penalty from available volume/price fields
  - 6th param worldStateCtx passed from marketService for regime context
  HQS 2.1 Block 4: Explainable HQS, Versioning & Event-Awareness Basis
  - computeEventAwareness() derives event risk flags and confidence impact
    from world state context, gap/volume signals and macro cycle indicators
  - computeExplainableTags() generates rule-based, auditable reason tags
    from all available HQS sub-layers (quality, momentum, regime, liquidity,
    sector, confidence, event signals)
  - buildScoreNarrative() builds a short structured narrative string
  - HQS output extended with explainableTags, versionReason, eventAwareness,
    eventRiskFlags, eventConfidenceImpact, scoreNarrative (backward compatible)
*/

const { getFundamentals } = require("./services/fundamental.service");
const { saveScoreSnapshot } = require("./services/factorHistory.repository");
const { loadLastWeights } = require("./services/weightHistory.repository");
const {
  buildSectorContext,
  applySectorQualityAdjustment,
} = require("./services/sectorTemplate");

/* =========================================================
   HQS VERSION
========================================================= */

const HQS_VERSION = "2.1";

// Human-readable reason why this version is active (Block 4 upgrade)
const VERSION_REASON = "HQS 2.1: Explainability, Versioning & Event-Awareness (Block 4)";

// optional logger (falls vorhanden)
let logger = null;
try {
  logger = require("./utils/logger");
} catch (_) {
  logger = null;
}

/* =========================================================
   DEFAULT WEIGHTS
========================================================= */

const DEFAULT_WEIGHTS = {
  momentum: 0.35,
  quality: 0.35,
  stability: 0.20,
  relative: 0.10,
};

/* =========================================================
   UTIL
========================================================= */

function clamp(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function safe(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeWeights(weights) {
  const base = weights && typeof weights === "object" ? weights : {};

  let total = 0;

  for (const k of Object.keys(DEFAULT_WEIGHTS)) {
    const val = safe(base[k], 0);
    total += val > 0 ? val : 0;
  }

  if (total <= 0) return { ...DEFAULT_WEIGHTS };

  const normalized = {};

  for (const k of Object.keys(DEFAULT_WEIGHTS)) {
    const val = safe(base[k], 0);
    normalized[k] = (val > 0 ? val : 0) / total;
  }

  return normalized;
}

function mapRegimeHint(regimeHint) {
  if (!regimeHint) return null;

  const r = String(regimeHint).trim().toLowerCase();

  if (r === "bullish") return "bull";
  if (r === "bearish") return "bear";
  if (r === "neutral") return "neutral";

  if (["expansion", "bull", "bear", "crash", "neutral"].includes(r)) return r;

  return null;
}

/* =========================================================
   REGIME DETECTION – MARKET BASED
========================================================= */

function detectRegime(symbolChange, marketAverage) {
  const diff = safe(symbolChange) - safe(marketAverage);

  if (marketAverage > 1 && diff > 0.5) return "expansion";
  if (marketAverage > 0) return "bull";
  if (marketAverage < -1 && diff < -0.5) return "crash";
  if (marketAverage < 0) return "bear";

  return "neutral";
}

function regimeMultiplier(regime) {
  switch (regime) {
    case "expansion":
      return 1.10;
    case "bull":
      return 1.05;
    case "bear":
      return 0.95;
    case "crash":
      return 0.85;
    default:
      return 1;
  }
}

/* =========================================================
   FACTORS
========================================================= */

function calculateMomentum(changePercent, trend = 0) {
  const base = 50 + safe(changePercent) * 3;
  const trendBoost = safe(trend) * 20;
  return clamp(base + trendBoost, 0, 100);
}

function calculateStability(item) {
  const high = safe(item.high);
  const low = safe(item.low);
  const open = safe(item.open);

  if (!open) return 50;

  const range = ((high - low) / open) * 100;

  const stability =
    70 - range * 3;

  return clamp(stability, 20, 85);
}

function calculateQuality(fundamentals) {
  if (!fundamentals) return 50;

  let score = 50;

  if (safe(fundamentals.revenueGrowth) > 10) score += 10;
  if (safe(fundamentals.netMargin) > 15) score += 10;
  if (safe(fundamentals.returnOnEquity) > 15) score += 10;

  if (safe(fundamentals.revenueGrowth) > 20) score += 5;
  if (safe(fundamentals.netMargin) > 25) score += 5;

  if (safe(fundamentals.debtToEquity) < 1) score += 5;
  if (safe(fundamentals.debtToEquity) > 2) score -= 10;

  return clamp(score, 0, 100);
}

function calculateRelativeStrength(symbolChange, marketAverage) {
  const diff = safe(symbolChange) - safe(marketAverage);
  return clamp(50 + diff * 4, 0, 100);
}

/* =========================================================
   HQS 2.0 – DATA QUALITY, CONFIDENCE & IMPUTATION LAYER
   Derives a transparent confidence score (0–100) and explicit
   flags from the available market and fundamental data.
   Rules are intentionally simple and auditable.
========================================================= */

function computeDataQuality(item, fundamentals) {
  const dataQualityFlags = [];
  const imputationFlags = [];
  const freshnessFlags = [];
  const confidenceReasons = [];

  // ── Market field checks ──────────────────────────────────────────────────
  const missingMarketFields = [];
  if (item.price == null)             missingMarketFields.push("price");
  if (item.changesPercentage == null) missingMarketFields.push("changesPercentage");
  if (item.high == null)              missingMarketFields.push("high");
  if (item.low == null)               missingMarketFields.push("low");
  if (item.open == null)              missingMarketFields.push("open");

  if (missingMarketFields.length > 0) {
    dataQualityFlags.push("missing_market_fields");
    confidenceReasons.push(`Missing market fields: ${missingMarketFields.join(", ")}`);
  }

  // ── Stability imputation check (calculateStability falls back to 50 when open=0) ──
  if (!safe(item.open)) {
    imputationFlags.push("stability_imputed_no_open");
    confidenceReasons.push("Stability estimated: open price unavailable");
  }

  // ── Price range anomaly (high == low or low > high → stale/snapshot issue) ──
  const high = safe(item.high);
  const low = safe(item.low);
  if (high > 0 && low > 0 && high === low) {
    freshnessFlags.push("price_range_static");
    confidenceReasons.push("High == Low: possible stale snapshot");
  }

  // ── Fundamental data checks ──────────────────────────────────────────────
  const hasFundamentals = !!fundamentals;

  if (!hasFundamentals) {
    dataQualityFlags.push("missing_fundamentals");
    imputationFlags.push("quality_factor_imputed");
    confidenceReasons.push("Fundamentals unavailable: quality factor uses default 50");
  } else {
    // Check if fundamentals came from an estimated/fallback source
    const meta = fundamentals._meta || {};
    if (meta.isEstimated) {
      imputationFlags.push("fundamentals_estimated");
      confidenceReasons.push("Fundamentals marked as estimated by data provider");
    }
    if (meta.missingFields && meta.missingFields.length > 0) {
      dataQualityFlags.push("fundamentals_partial");
      confidenceReasons.push(`Fundamental fields missing: ${meta.missingFields.join(", ")}`);
    }
  }

  // ── Freshness check via _qualityMeta from normalizer ────────────────────
  if (item._qualityMeta) {
    const qm = item._qualityMeta;
    if (qm.missingFields && qm.missingFields.length > 0) {
      dataQualityFlags.push("normalizer_missing_fields");
    }
    if (!qm.hasMinimal) {
      freshnessFlags.push("no_minimal_price_data");
      confidenceReasons.push("Normalizer: no valid price available");
    }
  }

  // ── Confidence score: start at 100, deduct for each quality issue ────────
  let confidenceScore = 100;

  // Missing core market data is a significant confidence hit
  confidenceScore -= missingMarketFields.length * 8;

  // Missing fundamentals reduces quality-factor reliability
  if (!hasFundamentals) confidenceScore -= 15;

  // Imputed values lower confidence
  confidenceScore -= imputationFlags.length * 5;

  // Freshness issues
  confidenceScore -= freshnessFlags.length * 7;

  confidenceScore = clamp(Math.round(confidenceScore), 0, 100);

  return {
    confidenceScore,
    dataQualityFlags,
    imputationFlags,
    freshnessFlags,
    confidenceReason: confidenceReasons.length > 0
      ? confidenceReasons.join("; ")
      : "All core data fields present",
  };
}

/* =========================================================
   HQS 2.0 – BLOCK 3: REGIME-BASED WEIGHT PROFILE
   Derives regime-sensitive factor weight overrides from the
   resolved regime label and optional world state context.
   Bull/expansion markets favour Momentum & Relative Strength;
   Bear/crash markets favour Quality & Stability.
   Neutral/unknown falls back to balanced defaults.
   The returned profile is advisory – it is blended on top of
   the adaptive/database weights so existing learning is not
   discarded.
========================================================= */

const REGIME_WEIGHT_PROFILES = {
  expansion: { momentum: 0.40, quality: 0.28, stability: 0.17, relative: 0.15 },
  bull:       { momentum: 0.38, quality: 0.30, stability: 0.18, relative: 0.14 },
  neutral:    { momentum: 0.35, quality: 0.35, stability: 0.20, relative: 0.10 },
  bear:       { momentum: 0.22, quality: 0.40, stability: 0.28, relative: 0.10 },
  crash:      { momentum: 0.15, quality: 0.42, stability: 0.33, relative: 0.10 },
};

// Blend ratio: share of regime profile applied on top of adaptive/learned weights
const REGIME_WEIGHT_BLEND_RATIO = 0.35;

// Liquidity guardrail thresholds (dollar volume)
const HIGH_LIQUIDITY_THRESHOLD   = 50_000_000;
const MEDIUM_LIQUIDITY_THRESHOLD =  5_000_000;

// Volume ratio thresholds (volume / avgVolume)
const LOW_VOLUME_RATIO_THRESHOLD  = 0.25; // far below average → elevated slippage
const HIGH_VOLUME_SPIKE_THRESHOLD = 3;    // unusual spike → flag for event risk

// Enhanced stability band thresholds
const VOLATILE_BAND_VOL_THRESHOLD      = 5;   // volatilityProxy %
const VOLATILE_BAND_DRAWDOWN_THRESHOLD = 4;   // drawdownProxy %
const MODERATE_BAND_VOL_THRESHOLD      = 2.5;
const MODERATE_BAND_DRAWDOWN_THRESHOLD = 2;

// Gap stress threshold (open vs previous close, %)
const GAP_STRESS_THRESHOLD = 2;

function computeRegimeWeightProfile(regime, worldStateCtx) {
  const label = String(regime || "neutral").toLowerCase();

  // If world state signals stress (risk_off) override to bear/crash profile
  // even when the per-symbol regime is labelled neutral.
  let effectiveLabel = label;
  if (worldStateCtx) {
    const riskMode = String(worldStateCtx.risk_mode || "").toLowerCase();
    const volState = String(worldStateCtx.volatility_state || "").toLowerCase();
    if (riskMode === "risk_off" && (effectiveLabel === "neutral" || effectiveLabel === "bull")) {
      effectiveLabel = "bear";
    }
    if (volState === "high" && effectiveLabel === "expansion") {
      effectiveLabel = "bull";
    }
  }

  const profile = REGIME_WEIGHT_PROFILES[effectiveLabel] || REGIME_WEIGHT_PROFILES.neutral;

  return {
    regimeContext:      effectiveLabel,
    regimeWeightProfile: { ...profile },
    profileSource:      effectiveLabel !== label ? "world_state_override" : "regime_direct",
  };
}

/* =========================================================
   HQS 2.0 – BLOCK 3: ENHANCED STABILITY META
   Extends the single-day range stability score with additional
   stability proxies derived from directly available market
   fields (no external lookups).
   Fields:
     volatilityProxy  – intraday range as % of price
     drawdownProxy    – price move from previous close (% abs)
     gapStress        – open vs previous close gap (% abs)
     priceConsistency – directional consistency flag
     stabilityBand    – "stable" / "moderate" / "volatile"
========================================================= */

function computeEnhancedStabilityMeta(item) {
  const price       = safe(item.price);
  const high        = safe(item.high);
  const low         = safe(item.low);
  const open        = safe(item.open);
  const prevClose   = safe(item.previousClose);
  const changesPct  = safe(item.changesPercentage);

  const reasons = [];

  // ── Volatility proxy: intraday range / price ─────────────────────────────
  let volatilityProxy = null;
  if (price > 0 && high > 0 && low > 0) {
    volatilityProxy = Math.round(((high - low) / price) * 1000) / 10; // pct, 1 dp
  }

  // ── Drawdown proxy: absolute % move vs previous close ───────────────────
  let drawdownProxy = null;
  if (prevClose > 0 && price > 0) {
    drawdownProxy = Math.round(Math.abs(((price - prevClose) / prevClose) * 100) * 10) / 10;
  } else if (changesPct !== 0) {
    drawdownProxy = Math.round(Math.abs(changesPct) * 10) / 10;
  }

  // ── Gap stress: overnight gap between open and previous close ───────────
  let gapStress = null;
  if (open > 0 && prevClose > 0) {
    gapStress = Math.round(Math.abs(((open - prevClose) / prevClose) * 100) * 10) / 10;
    if (gapStress > GAP_STRESS_THRESHOLD) reasons.push(`gap_stress_${gapStress.toFixed(1)}pct`);
  }

  // ── Price consistency: open vs close directionality ──────────────────────
  let priceConsistency = "neutral";
  if (open > 0 && price > 0) {
    if (changesPct > 0 && price >= open) priceConsistency = "consistent_up";
    else if (changesPct < 0 && price <= open) priceConsistency = "consistent_down";
    else priceConsistency = "reversal";
  }

  // ── Stability band: aggregate classification ────────────────────────────
  let stabilityBand = "stable";
  const volCheck = volatilityProxy ?? Math.abs(changesPct ?? 0);
  if (volCheck > VOLATILE_BAND_VOL_THRESHOLD || (drawdownProxy !== null && drawdownProxy > VOLATILE_BAND_DRAWDOWN_THRESHOLD)) {
    stabilityBand = "volatile";
    reasons.push("high_intraday_range");
  } else if (volCheck > MODERATE_BAND_VOL_THRESHOLD || (drawdownProxy !== null && drawdownProxy > MODERATE_BAND_DRAWDOWN_THRESHOLD)) {
    stabilityBand = "moderate";
  }
  if (priceConsistency === "reversal") {
    if (stabilityBand === "stable") stabilityBand = "moderate";
    reasons.push("price_reversal_intraday");
  }

  return {
    volatilityProxy,
    drawdownProxy,
    gapStress,
    priceConsistency,
    stabilityBand,
    stabilityReasons: reasons,
  };
}

/* =========================================================
   HQS 2.0 – BLOCK 3: LIQUIDITY & SLIPPAGE GUARDRAIL
   Derives a simple, transparent liquidity classification and
   slippage risk from available volume and price fields only.
   No broker/execution engine is built here – this is a
   protective meta layer.
   Fields:
     liquidityTier   – "high" / "medium" / "low"
     slippageRisk    – "low" / "medium" / "high"
     liquidityPenalty – 0-5 HQS point deduction (transparent)
     liquidityReason – string explanation
========================================================= */

function computeLiquidityGuardrail(item) {
  const price     = safe(item.price);
  const volume    = safe(item.volume);
  const avgVolume = safe(item.avgVolume);

  const reasons = [];

  // ── Dollar volume: primary liquidity signal ─────────────────────────────
  const dollarVolume = price > 0 && volume > 0 ? price * volume : 0;

  let liquidityTier = "medium";
  let slippageRisk  = "medium";

  if (dollarVolume === 0) {
    // No volume data available
    liquidityTier = "low";
    slippageRisk  = "high";
    reasons.push("no_volume_data");
  } else if (dollarVolume >= HIGH_LIQUIDITY_THRESHOLD) {
    liquidityTier = "high";
    slippageRisk  = "low";
  } else if (dollarVolume >= MEDIUM_LIQUIDITY_THRESHOLD) {
    liquidityTier = "medium";
    slippageRisk  = "medium";
    reasons.push("medium_dollar_volume");
  } else {
    liquidityTier = "low";
    slippageRisk  = "high";
    reasons.push("low_dollar_volume");
  }

  // ── Volume ratio: volume vs average volume ──────────────────────────────
  // Only used if avgVolume is cleanly available (> 0)
  if (avgVolume > 0 && volume > 0) {
    const volRatio = volume / avgVolume;
    if (volRatio < LOW_VOLUME_RATIO_THRESHOLD) {
      // Trading far below average – elevated slippage even in high-cap names
      if (liquidityTier === "high") liquidityTier = "medium";
      if (slippageRisk === "low")   slippageRisk  = "medium";
      reasons.push("volume_below_avg_ratio");
    } else if (volRatio > HIGH_VOLUME_SPIKE_THRESHOLD) {
      reasons.push("volume_spike_ratio");
      // High spike may indicate event risk – keep tier but flag
    }
  }

  // ── Illiquidity penalty: moderate and transparent ───────────────────────
  // Penalty is capped at 5 points and only applies for low-tier assets.
  let liquidityPenalty = 0;
  if (liquidityTier === "low")    liquidityPenalty = 5;
  else if (liquidityTier === "medium") liquidityPenalty = 0; // no penalty for medium

  const liquidityReason =
    reasons.length > 0
      ? reasons.join("; ")
      : `${liquidityTier}_liquidity_nominal`;

  return {
    liquidityTier,
    slippageRisk,
    liquidityPenalty,
    liquidityReason,
    dollarVolume: dollarVolume > 0 ? Math.round(dollarVolume) : null,
  };
}

/* =========================================================
   HQS 2.1 – BLOCK 4: EVENT AWARENESS BASIS
   Derives event risk flags and a confidence impact modifier
   from the available world state context and per-symbol
   stability signals.  Only uses directly readable signals –
   no external calendar or news engine is required.
   Defensive default (no_context) when worldStateCtx is absent.
   Fields:
     eventAwareness       – "nominal" / "event_caution" / "event_high_caution" / "no_context"
     eventRiskFlags       – string array of active risk signals
     eventConfidenceImpact – negative modifier (0 to −20) applied on top of confidence
     eventSource          – how the context was derived
========================================================= */

function computeEventAwareness(worldStateCtx, enhancedStabilityMeta) {
  if (!worldStateCtx) {
    return {
      eventAwareness: "no_context",
      eventRiskFlags: [],
      eventConfidenceImpact: 0,
      eventSource: "none",
    };
  }

  const eventRiskFlags = [];
  let eventConfidenceImpact = 0;

  // ── Macro risk mode ─────────────────────────────────────────────────────
  const riskMode = String(worldStateCtx.risk_mode || "").toLowerCase();
  if (riskMode === "risk_off") {
    eventRiskFlags.push("macro_risk_off");
    eventConfidenceImpact -= 5;
  }

  // ── Volatility state ────────────────────────────────────────────────────
  const volState = String(worldStateCtx.volatility_state || "").toLowerCase();
  if (volState === "high") {
    eventRiskFlags.push("elevated_volatility");
    eventConfidenceImpact -= 5;
  } else if (volState === "elevated") {
    eventRiskFlags.push("volatility_elevated");
    eventConfidenceImpact -= 3;
  }

  // ── Macro cycle: contraction signals upcoming earnings/rate pressure ────
  const macroCycle = worldStateCtx.macro_context?.macro_cycle;
  if (macroCycle === "contraction") {
    eventRiskFlags.push("macro_contraction");
    eventConfidenceImpact -= 5;
  }

  // ── News pulse: negative aggregate sentiment ─────────────────────────────
  const newsPulse = worldStateCtx.news_pulse;
  if (newsPulse && typeof newsPulse.sentiment === "number" && newsPulse.sentiment < -0.3) {
    eventRiskFlags.push("negative_news_pulse");
    eventConfidenceImpact -= 3;
  }

  // ── Inter-market early warning ───────────────────────────────────────────
  if (worldStateCtx.inter_market?.early_warning) {
    eventRiskFlags.push("inter_market_warning");
    eventConfidenceImpact -= 4;
  }

  // ── Per-symbol signals: volume spike → possible earnings/corporate event ──
  const stabilityReasons = enhancedStabilityMeta?.stabilityReasons || [];
  if (stabilityReasons.includes("volume_spike_ratio")) {
    eventRiskFlags.push("volume_spike_event");
    eventConfidenceImpact -= 3;
  }

  // ── Gap stress: overnight gap suggests earnings release or macro event ────
  // GAP_STRESS_THRESHOLD = 2 (%) defined at the top of this module alongside
  // other Block 3 thresholds.
  const gapStress = enhancedStabilityMeta?.gapStress;
  if (gapStress != null && gapStress > GAP_STRESS_THRESHOLD) {
    eventRiskFlags.push("gap_stress_detected");
    eventConfidenceImpact -= 3;
  }

  const eventAwareness =
    eventRiskFlags.length === 0
      ? "nominal"
      : eventRiskFlags.length >= 3
      ? "event_high_caution"
      : "event_caution";

  return {
    eventAwareness,
    eventRiskFlags,
    eventConfidenceImpact: clamp(eventConfidenceImpact, -20, 0),
    eventSource: "world_state_derived",
  };
}

/* =========================================================
   HQS 2.1 – BLOCK 4: EXPLAINABLE TAGS
   Generates rule-based, auditable reason tags from all
   available HQS sub-layers.  No generative AI – every tag
   maps to a named, deterministic rule.
   Possible tags:
     quality_leader       quality score ≥ 70 with fundamentals
     stable_uptrend       momentum ≥ 65 AND stability ≥ 60
     regime_tailwind      bull or expansion regime
     regime_headwind      bear or crash regime
     liquidity_watch      low liquidity tier
     low_confidence       confidence score < 60
     sector_adjusted      non-default sector template active
     event_caution        ≥ 1 event risk flag present
     elevated_volatility  volatile stability band
     data_imputed         ≥ 1 imputation flag active
========================================================= */

function computeExplainableTags({
  momentum,
  quality,
  stability,
  regime,
  confidenceScore,
  dataQuality,
  sectorCtx,
  enhancedStabilityMeta,
  liquidityGuardrail,
  eventAwarenessResult,
}) {
  const tags = [];

  // ── Quality leader ────────────────────────────────────────────────────────
  if (quality >= 70 && !dataQuality.dataQualityFlags.includes("missing_fundamentals")) {
    tags.push("quality_leader");
  }

  // ── Stable uptrend ────────────────────────────────────────────────────────
  if (momentum >= 65 && stability >= 60) {
    tags.push("stable_uptrend");
  }

  // ── Regime direction ──────────────────────────────────────────────────────
  if (regime === "expansion" || regime === "bull") {
    tags.push("regime_tailwind");
  } else if (regime === "crash" || regime === "bear") {
    tags.push("regime_headwind");
  }

  // ── Liquidity watch ───────────────────────────────────────────────────────
  if (liquidityGuardrail.liquidityTier === "low") {
    tags.push("liquidity_watch");
  }

  // ── Low confidence ────────────────────────────────────────────────────────
  if (confidenceScore < 60) {
    tags.push("low_confidence");
  }

  // ── Sector adjusted ───────────────────────────────────────────────────────
  if (sectorCtx.sectorTemplate && sectorCtx.sectorTemplate !== "default") {
    tags.push("sector_adjusted");
  }

  // ── Event caution ─────────────────────────────────────────────────────────
  if (eventAwarenessResult.eventRiskFlags.length > 0) {
    tags.push("event_caution");
  }

  // ── Elevated volatility ───────────────────────────────────────────────────
  if (enhancedStabilityMeta.stabilityBand === "volatile") {
    tags.push("elevated_volatility");
  }

  // ── Data imputation active ────────────────────────────────────────────────
  if (dataQuality.imputationFlags.length > 0) {
    tags.push("data_imputed");
  }

  return tags;
}

/* =========================================================
   HQS 2.1 – BLOCK 4: SCORE NARRATIVE
   Builds a short, structured narrative string from key
   signals.  Not marketing copy – factual signal summary.
========================================================= */

function buildScoreNarrative({ finalScore, regime, explainableTags, eventAwareness }) {
  const ratingLabel =
    finalScore >= 85 ? "Strong Buy"
    : finalScore >= 70 ? "Buy"
    : finalScore >= 50 ? "Hold"
    : "Risk";

  const regimeLabel = regime || "neutral";

  const tagSummary =
    explainableTags.length > 0
      ? explainableTags.slice(0, 4).join(", ")
      : "no_tags";

  const eventNote =
    eventAwareness !== "nominal" && eventAwareness !== "no_context"
      ? ` | ${eventAwareness}`
      : "";

  return `HQS ${finalScore} (${ratingLabel}) | ${regimeLabel}${eventNote} | ${tagSummary}`;
}

/* =========================================================
   MAIN ENGINE
========================================================= */

async function buildHQSResponse(
  item = {},
  marketAverage = 0,
  adaptiveWeights = null,
  regimeHint = null,
  entityMeta = null,
  worldStateCtx = null
) {
  try {
    if (!item.symbol) throw new Error("Missing symbol");

    let weightsRaw = null;
    let weightsSource = "default";

    if (adaptiveWeights && typeof adaptiveWeights === "object") {
      weightsRaw = adaptiveWeights;
      weightsSource = "adaptive";
    } else {
      weightsRaw = await loadLastWeights();
      if (weightsRaw) weightsSource = "database";
    }

    let fundamentals = null;

    try {
      fundamentals = await getFundamentals(item.symbol);
    } catch (err) {
      if (logger?.warn)
        logger.warn("Fundamental load failed", { message: err.message });
      else console.warn("Fundamental load failed:", err.message);
    }

    const mappedHint = mapRegimeHint(regimeHint);
    const regime =
      mappedHint || detectRegime(item.changesPercentage, marketAverage);

    // ── HQS 2.0 Block 3: regime weight profile ────────────────────────────
    const regimeProfile = computeRegimeWeightProfile(regime, worldStateCtx);

    // Blend regime profile into the base weights.
    // If adaptive/database weights exist they serve as the primary anchor;
    // the regime profile nudges momentum/quality/stability according to
    // the current market phase while keeping the learned baseline.
    const baseWeightsRaw = normalizeWeights(weightsRaw || DEFAULT_WEIGHTS);
    const regimePW = regimeProfile.regimeWeightProfile;
    const blendedWeights = {
      momentum:  baseWeightsRaw.momentum  * (1 - REGIME_WEIGHT_BLEND_RATIO) + regimePW.momentum  * REGIME_WEIGHT_BLEND_RATIO,
      quality:   baseWeightsRaw.quality   * (1 - REGIME_WEIGHT_BLEND_RATIO) + regimePW.quality   * REGIME_WEIGHT_BLEND_RATIO,
      stability: baseWeightsRaw.stability * (1 - REGIME_WEIGHT_BLEND_RATIO) + regimePW.stability * REGIME_WEIGHT_BLEND_RATIO,
      relative:  baseWeightsRaw.relative  * (1 - REGIME_WEIGHT_BLEND_RATIO) + regimePW.relative  * REGIME_WEIGHT_BLEND_RATIO,
    };
    const weights = normalizeWeights(blendedWeights);

    const momentum = calculateMomentum(item.changesPercentage, item.trend);
    const stability = calculateStability(item);

    // calculateQuality uses first element if fundamentals is an array (Finnhub format)
    const fundamentalsRecord = Array.isArray(fundamentals) ? fundamentals[0] : fundamentals;
    const baseQuality = calculateQuality(fundamentalsRecord);

    // ── HQS 2.0 Block 2: sector context & sector-aware quality adjustment ──
    // entityMeta may come from 5th param (passed by marketService) or fall back
    // to sector hint embedded in item itself (e.g. normalized.sector).
    const resolvedEntityMeta = entityMeta || (item.sector ? { sector: item.sector, industry: item.industry || null } : null);
    const sectorCtx = buildSectorContext(resolvedEntityMeta, fundamentalsRecord);
    const { adjustedQuality, appliedAdjustments } = applySectorQualityAdjustment(
      baseQuality,
      fundamentalsRecord,
      sectorCtx.sectorTemplate
    );
    // Use sector-adjusted quality for final score
    const quality = adjustedQuality;

    const relative = calculateRelativeStrength(
      item.changesPercentage,
      marketAverage
    );

    // ── HQS 2.0 Block 3: enhanced stability meta ──────────────────────────
    const enhancedStabilityMeta = computeEnhancedStabilityMeta(item);

    // ── HQS 2.0 Block 3: liquidity guardrail ─────────────────────────────
    const liquidityGuardrail = computeLiquidityGuardrail(item);

    let baseScore =
      momentum * weights.momentum +
      quality * weights.quality +
      stability * weights.stability +
      relative * weights.relative;

    baseScore *= regimeMultiplier(regime);

    // Apply transparent liquidity penalty (0–5 points, only for low liquidity)
    const scoreBeforeLiquidity = clamp(Math.round(baseScore), 0, 100);
    const finalScore = clamp(scoreBeforeLiquidity - liquidityGuardrail.liquidityPenalty, 0, 100);

    // ── HQS 2.0 Block 1: derive data quality meta ─────────────────────────
    const dataQuality = computeDataQuality(item, fundamentalsRecord);

    // ── HQS 2.1 Block 4: event awareness ──────────────────────────────────
    const eventAwarenessResult = computeEventAwareness(worldStateCtx, enhancedStabilityMeta);

    // ── HQS 2.1 Block 4: explainable tags ─────────────────────────────────
    const explainableTags = computeExplainableTags({
      momentum,
      quality,
      stability,
      regime,
      confidenceScore: dataQuality.confidenceScore,
      dataQuality,
      sectorCtx,
      enhancedStabilityMeta,
      liquidityGuardrail,
      eventAwarenessResult,
    });

    // ── HQS 2.1 Block 4: score narrative ──────────────────────────────────
    const scoreNarrative = buildScoreNarrative({
      finalScore,
      regime,
      explainableTags,
      eventAwareness: eventAwarenessResult.eventAwareness,
    });

    await saveScoreSnapshot({
      symbol: item.symbol,
      hqsScore: finalScore,
      momentum,
      quality,
      stability,
      relative,
      regime,
      hqsVersion: HQS_VERSION,
      confidenceScore: dataQuality.confidenceScore,
      dataQualityMeta: {
        dataQualityFlags: dataQuality.dataQualityFlags,
        freshnessFlags: dataQuality.freshnessFlags,
        confidenceReason: dataQuality.confidenceReason,
      },
      imputationMeta: {
        imputationFlags: dataQuality.imputationFlags,
      },
      // ── HQS 2.0 Block 2: sector scoring meta ──────────────────────────
      sectorTemplate: sectorCtx.sectorTemplate,
      peerContextAvailable: sectorCtx.peerContextAvailable,
      sectorScoringMeta: {
        sectorLabel: sectorCtx.sectorLabel,
        sectorScoringFlags: sectorCtx.sectorScoringFlags,
        normalizationMeta: sectorCtx.normalizationMeta,
        sectorReason: sectorCtx.sectorReason,
        baseQuality,
        appliedAdjustments,
      },
      // ── HQS 2.0 Block 3: regime/stability/liquidity meta ──────────────
      regimeWeightProfile: regimeProfile.regimeWeightProfile,
      enhancedStabilityMeta,
      liquidityMeta: {
        liquidityTier:    liquidityGuardrail.liquidityTier,
        slippageRisk:     liquidityGuardrail.slippageRisk,
        liquidityPenalty: liquidityGuardrail.liquidityPenalty,
        liquidityReason:  liquidityGuardrail.liquidityReason,
        dollarVolume:     liquidityGuardrail.dollarVolume,
      },
      // ── HQS 2.1 Block 4: explainability, versioning & event-awareness ──
      explainableTags,
      versionReason: VERSION_REASON,
      eventAwarenessMeta: {
        eventAwareness:        eventAwarenessResult.eventAwareness,
        eventRiskFlags:        eventAwarenessResult.eventRiskFlags,
        eventConfidenceImpact: eventAwarenessResult.eventConfidenceImpact,
        eventSource:           eventAwarenessResult.eventSource,
      },
    });

    return {
      symbol: String(item.symbol).toUpperCase(),
      price: safe(item.price),
      changePercent: safe(item.changesPercentage),
      regime,
      weights,
      weightsSource,
      breakdown: { momentum, quality, stability, relative },
      hqsScore: finalScore,
      rating:
        finalScore >= 85
          ? "Strong Buy"
          : finalScore >= 70
          ? "Buy"
          : finalScore >= 50
          ? "Hold"
          : "Risk",
      decision:
        finalScore >= 70
          ? "KAUFEN"
          : finalScore >= 50
          ? "HALTEN"
          : "NICHT KAUFEN",
      timestamp: new Date().toISOString(),
      // ── HQS 2.0 Block 1 meta fields ──────────────────────────────────
      hqsVersion: HQS_VERSION,
      confidenceScore: dataQuality.confidenceScore,
      dataQualityFlags: dataQuality.dataQualityFlags,
      imputationFlags: dataQuality.imputationFlags,
      freshnessFlags: dataQuality.freshnessFlags,
      confidenceReason: dataQuality.confidenceReason,
      // ── HQS 2.0 Block 2 sector meta fields ───────────────────────────
      sectorTemplate: sectorCtx.sectorTemplate,
      sectorScoringFlags: sectorCtx.sectorScoringFlags,
      peerContextAvailable: sectorCtx.peerContextAvailable,
      normalizationMeta: sectorCtx.normalizationMeta,
      sectorReason: sectorCtx.sectorReason,
      // ── HQS 2.0 Block 3 regime/stability/liquidity meta fields ───────
      regimeContext:          regimeProfile.regimeContext,
      regimeWeightProfile:    regimeProfile.regimeWeightProfile,
      enhancedStabilityMeta,
      liquidityTier:          liquidityGuardrail.liquidityTier,
      slippageRisk:           liquidityGuardrail.slippageRisk,
      liquidityPenalty:       liquidityGuardrail.liquidityPenalty,
      liquidityReason:        liquidityGuardrail.liquidityReason,
      // ── HQS 2.1 Block 4 explainability / versioning / event meta ─────
      explainableTags,
      versionReason:          VERSION_REASON,
      eventAwareness:         eventAwarenessResult.eventAwareness,
      eventRiskFlags:         eventAwarenessResult.eventRiskFlags,
      eventConfidenceImpact:  eventAwarenessResult.eventConfidenceImpact,
      scoreNarrative,
    };
  } catch (error) {
    if (logger?.error)
      logger.error("HQS Engine Error", { message: error.message });
    else console.error("HQS Engine Error:", error.message);

    return {
      symbol: item?.symbol || null,
      hqsScore: null,
      hqsVersion: HQS_VERSION,
      error: "HQS calculation failed",
    };
  }
}

module.exports = { buildHQSResponse };
