"use strict";

/**
 * Maturity Profile Engine – V1
 *
 * Pure computation engine (no DB writes, no side-effects).
 * Produces a `maturity_profile` per symbol based on four pillars:
 *   A) Quantity   – how many usable history days exist
 *   B) Quality    – data completeness / coverage
 *   C) Consistency – signal stability
 *   D) Recency    – data freshness
 *
 * Weights (V1): Quantity 35%, Quality 30%, Consistency 20%, Recency 15%
 *
 * Levels:
 *   0–25   → seed
 *   26–50  → early
 *   51–75  → developing
 *   76–100 → mature
 */

// ── Helpers ────────────────────────────────────────────────────────────────

/** Clamp a number to [min, max]. Returns 0 for non-finite values. */
function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

/** Round to one decimal place. */
function round1(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}

/** Safe array length. */
function safeLen(arr) {
  return Array.isArray(arr) ? arr.length : 0;
}

/** Parse a numeric field, returning fallback for non-finite values. */
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : (fallback !== undefined ? fallback : 0);
}

// ── Pillar A: Quantity Score ──────────────────────────────────────────────

/**
 * Evaluate how many usable history days are available.
 * Target range: 0–60 days.  Gradual ramp, never binary.
 *
 * Mapping:
 *   0       → 0
 *   1–5     → 5–15
 *   6–14    → 16–35
 *   15–29   → 36–65
 *   30–60   → 66–95
 *   60+     → 95–100
 */
function computeQuantityScore(historyDays) {
  const d = clamp(historyDays, 0, 365);
  if (d === 0) return 0;
  if (d <= 5)  return round1(5 + (d / 5) * 10);            // 5–15
  if (d <= 14) return round1(16 + ((d - 6) / 8) * 19);     // 16–35
  if (d <= 29) return round1(36 + ((d - 15) / 14) * 29);   // 36–65
  if (d <= 60) return round1(66 + ((d - 30) / 30) * 29);   // 66–95
  // 60+ → asymptotic approach to 100
  return round1(Math.min(95 + ((d - 60) / 300) * 5, 100));
}

// ── Pillar B: Quality Score ──────────────────────────────────────────────

/**
 * Evaluate data quality / coverage.
 *
 * Inputs considered:
 *   - historyDays   – how many price records we have
 *   - missingDays   – estimated gap days
 *   - hasNews       – boolean
 *   - hasPriceFields – are open/high/low/close basically present?
 *
 * The quality score is a weighted blend of sub-factors.
 */
function computeQualityScore({ historyDays, missingDays, hasNews, hasPriceFields }) {
  const days = num(historyDays);
  const missing = num(missingDays);

  // Sub-factor 1: Price coverage ratio (40%)
  // If we have history, what fraction is gap-free?
  let coverageRatio = 1;
  if (days > 0) {
    const totalExpected = days + missing;
    coverageRatio = totalExpected > 0 ? days / totalExpected : 1;
  } else {
    coverageRatio = 0;
  }
  const coverageScore = clamp(coverageRatio * 100, 0, 100);

  // Sub-factor 2: Price field completeness (25%)
  const fieldScore = hasPriceFields ? 100 : 20;

  // Sub-factor 3: News availability (15%)
  const newsScore = hasNews ? 100 : 30;

  // Sub-factor 4: Minimum data threshold (20%)
  // Rewards having *any* data at all, steep ramp to 10 days
  let thresholdScore;
  if (days === 0) thresholdScore = 0;
  else if (days < 10) thresholdScore = round1((days / 10) * 70);
  else thresholdScore = 100;

  return round1(
    coverageScore * 0.4 +
    fieldScore * 0.25 +
    newsScore * 0.15 +
    thresholdScore * 0.2
  );
}

// ── Pillar C: Consistency Score ──────────────────────────────────────────

/**
 * Evaluate how stable/consistent the signal is.
 *
 * Inputs:
 *   - trend             – trend score (typically -1..1)
 *   - volatilityAnnual  – annual volatility (0..∞)
 *   - volatilityDaily   – daily volatility (0..∞)
 *   - historyDays       – data length affects reliability
 *
 * Philosophy:
 *   - Very high volatility → lower consistency (noisy signal)
 *   - Defined trend (non-zero) with moderate vol → higher consistency
 *   - Very few data points → lower (signal is unreliable)
 */
function computeConsistencyScore({ trend, volatilityAnnual, volatilityDaily, historyDays }) {
  const t       = num(trend);
  const volA    = num(volatilityAnnual);
  const volD    = num(volatilityDaily);
  const days    = num(historyDays);

  // Sub-factor 1: Volatility stability (40%)
  // Lower annualized vol → higher stability.  Cap vol at 200% for scoring.
  const volNorm = clamp(volA, 0, 2);
  const volScore = round1((1 - volNorm / 2) * 100);

  // Sub-factor 2: Trend definition (30%)
  // A clearer trend (higher absolute value) → more defined signal.
  // trend is typically in [-1, 1] range
  const trendAbs = Math.min(Math.abs(t), 1);
  const trendScore = round1(trendAbs * 100);

  // Sub-factor 3: Data reliability (30%)
  // More data → more reliable.  Ramps up to 30 days, then plateaus.
  let reliabilityScore;
  if (days === 0) reliabilityScore = 0;
  else if (days < 5) reliabilityScore = round1((days / 5) * 30);
  else if (days < 30) reliabilityScore = round1(30 + ((days - 5) / 25) * 70);
  else reliabilityScore = 100;

  return round1(
    volScore * 0.4 +
    trendScore * 0.3 +
    reliabilityScore * 0.3
  );
}

// ── Pillar D: Recency Score ──────────────────────────────────────────────

/**
 * Evaluate freshness of data.
 *
 * Inputs:
 *   - snapshotAgeHours       – hours since last snapshot
 *   - advancedMetricsAgeHours – hours since last advanced metrics update (optional)
 *
 * Fresh data (< 6h) → 100
 * Moderately old (6–24h) → gradual decrease
 * Stale (24–72h) → low but non-zero
 * Very stale (> 72h) → near-zero
 */
function computeRecencyScore({ snapshotAgeHours, advancedMetricsAgeHours }) {
  const snapAge = num(snapshotAgeHours, 999);
  const amAge   = num(advancedMetricsAgeHours, 999);

  // Use the best (freshest) available age
  const bestAge = Math.min(snapAge, amAge);

  if (bestAge <= 1)  return 100;
  if (bestAge <= 6)  return round1(100 - ((bestAge - 1) / 5) * 15);       // 85–100
  if (bestAge <= 24) return round1(85  - ((bestAge - 6) / 18) * 45);      // 40–85
  if (bestAge <= 72) return round1(40  - ((bestAge - 24) / 48) * 30);     // 10–40
  return round1(Math.max(10 - ((bestAge - 72) / 168) * 10, 0));           // 0–10
}

// ── Level Mapping ────────────────────────────────────────────────────────

function mapLevel(score) {
  const s = clamp(score, 0, 100);
  if (s <= 25) return "seed";
  if (s <= 50) return "early";
  if (s <= 75) return "developing";
  return "mature";
}

// ── Warnings ─────────────────────────────────────────────────────────────

function buildWarnings({ historyDays, missingDays, hasNews, snapshotAgeHours, consistencyScore }) {
  const warnings = [];
  const days    = num(historyDays);
  const missing = num(missingDays);
  const snapAge = num(snapshotAgeHours, 999);

  if (days === 0)           warnings.push("no_history");
  else if (days < 15)       warnings.push("limited_history");

  if (missing > 0 && days > 0 && (missing / (days + missing)) > 0.15) {
    warnings.push("history_gaps");
  }

  if (!hasNews)             warnings.push("no_news");
  if (snapAge > 48)         warnings.push("stale_snapshot");
  if (num(consistencyScore) < 30) warnings.push("unstable_signal");

  return warnings;
}

// ── Main Entry Point ─────────────────────────────────────────────────────

/**
 * Build a complete maturity profile for a symbol.
 *
 * @param {Object} input
 * @param {number}  input.historyDays            – number of usable price data points
 * @param {number}  [input.missingDays=0]         – estimated missing/gap days
 * @param {boolean} [input.hasNews=false]         – whether news is available
 * @param {boolean} [input.hasPriceFields=true]   – basic OHLC fields present?
 * @param {number}  [input.snapshotAgeHours=0]    – hours since last snapshot
 * @param {number}  [input.advancedMetricsAgeHours] – hours since last adv. metrics
 * @param {number}  [input.trend=0]               – trend score (-1..1)
 * @param {number}  [input.volatilityAnnual=0]    – annualized volatility
 * @param {number}  [input.volatilityDaily=0]     – daily volatility
 *
 * @returns {Object} maturity_profile
 */
function buildMaturityProfile(input) {
  const inp = input && typeof input === "object" ? input : {};

  const historyDays            = num(inp.historyDays);
  const missingDays            = num(inp.missingDays);
  const hasNews                = Boolean(inp.hasNews);
  const hasPriceFields         = inp.hasPriceFields !== false; // default true
  const snapshotAgeHours       = num(inp.snapshotAgeHours);
  const advancedMetricsAgeHours = inp.advancedMetricsAgeHours != null
    ? num(inp.advancedMetricsAgeHours) : undefined;
  const trend                  = num(inp.trend);
  const volatilityAnnual       = num(inp.volatilityAnnual);
  const volatilityDaily        = num(inp.volatilityDaily);

  // ── Compute the four pillar scores ──
  const quantityScore = computeQuantityScore(historyDays);

  const qualityScore = computeQualityScore({
    historyDays,
    missingDays,
    hasNews,
    hasPriceFields,
  });

  const consistencyScore = computeConsistencyScore({
    trend,
    volatilityAnnual,
    volatilityDaily,
    historyDays,
  });

  const recencyScore = computeRecencyScore({
    snapshotAgeHours,
    advancedMetricsAgeHours,
  });

  // ── Weighted mix (V1 weights) ──
  const rawScore =
    quantityScore    * 0.35 +
    qualityScore     * 0.30 +
    consistencyScore * 0.20 +
    recencyScore     * 0.15;

  const maturityScore = clamp(Math.round(rawScore), 0, 100);
  const maturityLevel = mapLevel(maturityScore);

  // ── Warnings ──
  const warnings = buildWarnings({
    historyDays,
    missingDays,
    hasNews,
    snapshotAgeHours,
    consistencyScore,
  });

  return {
    maturityScore,
    maturityLevel,
    quantityScore:    round1(quantityScore),
    qualityScore:     round1(qualityScore),
    consistencyScore: round1(consistencyScore),
    recencyScore:     round1(recencyScore),
    historyDays,
    missingDays,
    hasNews,
    snapshotAgeHours: round1(snapshotAgeHours),
    warnings,
  };
}

module.exports = { buildMaturityProfile };
