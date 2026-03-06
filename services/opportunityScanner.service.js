"use strict";

const { Pool } = require("pg");
const logger = require("../utils/logger");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function norm0to1(x) {
  const n = safeNum(x, 0);
  if (n > 1.5) return clamp(n / 100, 0, 1);
  return clamp(n, 0, 1);
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
   OPPORTUNITY TYPE CLASSIFICATION
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

function generateReason(row) {
  const reasons = [];

  const quality = norm0to1(row.quality);
  const stability = norm0to1(row.stability);
  const relative = norm0to1(row.relative);
  const momentum = norm0to1(row.momentum);
  const volatility = safeNum(row.volatility, 0);

  if (quality >= 0.65) reasons.push("gute Firma");
  if (stability >= 0.65) reasons.push("stabil");
  if (relative >= 0.65) reasons.push("stärker als der Markt");

  if (momentum >= 0.50 && momentum <= 0.85)
    reasons.push("läuft gut, aber nicht überhitzt");

  if (volatility > 0.9)
    reasons.push("Achtung: schwankt stark");

  if (!reasons.length)
    reasons.push("solide Werte");

  return reasons.slice(0, 3).join(" + ");
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

  const regime = options.regime
    ? String(options.regime).trim().toLowerCase()
    : null;

  const res = await pool.query(
    `
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
    `
  );

  let rows = res.rows || [];

  if (minHqs !== null) {
    rows = rows.filter((r) => safeNum(r.hqs_score, 0) >= minHqs);
  }

  if (regime) {
    rows = rows.filter(
      (r) => String(r.regime || "").toLowerCase() === regime
    );
  }

  const opportunities = rows.map((row) => {
    const opportunityScore = calculateOpportunityScore(row);

    return {
      symbol: String(row.symbol || "").toUpperCase(),
      regime: row.regime ?? null,

      type: classifyOpportunity(row),

      hqsScore: safeNum(row.hqs_score, 0),

      opportunityScore,
      confidence: calculateConfidence(row, opportunityScore),

      reason: generateReason(row),

      trend: row.trend ?? null,
      volatility: row.volatility ?? null,
      scenarios: row.scenarios ?? null,

      advancedUpdatedAt: row.advanced_updated_at
        ? new Date(row.advanced_updated_at).toISOString()
        : null,
    };
  });

  opportunities.sort((a, b) => b.opportunityScore - a.opportunityScore);

  const out = opportunities.slice(0, limit);

  logger.info("getTopOpportunities", {
    limit,
    minHqs,
    regime,
    returned: out.length,
  });

  return out;
}

module.exports = {
  getTopOpportunities,
};
