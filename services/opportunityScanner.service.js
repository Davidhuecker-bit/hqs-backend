"use strict";

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/**
 * Opportunity Score Berechnung
 */
function calculateOpportunityScore(row) {
  const hqs = Number(row.hqs_score || 0);
  const momentum = Number(row.momentum || 0);
  const quality = Number(row.quality || 0);
  const stability = Number(row.stability || 0);
  const relative = Number(row.relative || 0);
  const volatility = Number(row.volatility || 0);

  let score =
    hqs * 0.6 +
    momentum * 10 +
    quality * 8 +
    stability * 6 +
    relative * 10 -
    volatility * 5;

  return Number(score.toFixed(2));
}

/**
 * Confidence Berechnung
 */
function calculateConfidence(row) {
  const hqs = Number(row.hqs_score || 0);
  const stability = Number(row.stability || 0);

  const confidence = hqs * 0.7 + stability * 30;

  return Math.min(100, Math.round(confidence));
}

/**
 * Reason Generator
 */
function generateReason(row) {
  const reasons = [];

  if (row.momentum > 0.6) reasons.push("Momentum");
  if (row.quality > 0.6) reasons.push("Quality");
  if (row.stability > 0.6) reasons.push("Stability");
  if (row.relative > 0.6) reasons.push("Relative Strength");

  if (!reasons.length) reasons.push("Balanced Metrics");

  return reasons.join(" + ");
}

/**
 * Top Opportunities holen
 */
async function getTopOpportunities(limit = 10) {
  const result = await pool.query(`
    SELECT
      symbol,
      hqs_score,
      momentum,
      quality,
      stability,
      relative,
      volatility,
      regime
    FROM market_advanced_metrics
    ORDER BY hqs_score DESC
    LIMIT 50
  `);

  const rows = result.rows || [];

  const opportunities = rows.map((row) => {
    const opportunityScore = calculateOpportunityScore(row);

    return {
      symbol: row.symbol,
      regime: row.regime,
      hqsScore: Number(row.hqs_score || 0),
      opportunityScore,
      confidence: calculateConfidence(row),
      reason: generateReason(row),
    };
  });

  opportunities.sort((a, b) => b.opportunityScore - a.opportunityScore);

  return opportunities.slice(0, limit);
}

module.exports = {
  getTopOpportunities,
};
