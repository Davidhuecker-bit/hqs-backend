"use strict";

/*
  System Intelligence Service  –  Meta-Layer / Self-Assessment
  ─────────────────────────────────────────────────────────────
  Aggregates health signals from every existing intelligence layer and
  computes a single System Intelligence Score (SIS, 0–100).

  Design principles (2030-2035 vision, implemented today):
  ─────────────────────────────────────────────────────────
  1. Pure read-only aggregation – no new DB tables, no external API calls.
  2. All data comes from existing tables / exported service functions.
  3. Each layer score is independently explainable and measurable.
  4. The whole report can be switched off or replaced without side effects.
  5. Low-budget: runs in a single request, no background jobs needed.

  Layers scored (total = 100 pts)
  ─────────────────────────────────
  • Prediction Quality      (0–25): agent forecast accuracy over last 30 days
  • Capital Protection      (0–20): Guardian near-miss records + saved-capital
  • Portfolio Twin          (0–20): active virtual positions + PnL health
  • Adaptive Learning       (0–15): dynamic-weight divergence from flat baseline
  • Innovation Awareness    (0–10): tech-radar discovery count
  • Pattern Memory          (0–10): verified outcome records accumulated

  Future-advantage documentation (as required by Leitidee §10)
  ─────────────────────────────────────────────────────────────
  CREATED: Unified system self-awareness – the system now evaluates its own
           intelligence across all six layers in a single API call.
  REUSED:  agent_forecasts, dynamic_weights, guardian_near_miss,
           virtual_positions, tech_radar_entries, outcome_tracking tables.
  NOT BUILT: A separate DB table for SIS history (YAGNI – the score is
             ephemeral and can be derived on demand; persistence can be
             added when trend analysis is needed).
  WHY BEST: Zero marginal cost, zero new dependencies, fully explainable
            score, and a direct upgrade path to scheduled SIS snapshots.
*/

const { Pool } = require("pg");
const logger = require("../utils/logger");

const { getAgentWisdomScores } = require("./agentForecast.repository");
const { getAgentWeights, DEFAULT_WEIGHT } = require("./causalMemory.repository");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =========================================================
   CONSTANTS
========================================================= */

// Max points per layer
const MAX_PREDICTION   = 25;
const MAX_PROTECTION   = 20;
const MAX_TWIN         = 20;
const MAX_LEARNING     = 15;
const MAX_INNOVATION   = 10;
const MAX_PATTERN      = 10;

// Thresholds for full marks
const PREDICTION_FULL_ACCURACY = 70;   // % agent accuracy → full Prediction score
const PROTECTION_FULL_MISSES   = 10;   // near-miss records → full Protection score
const TWIN_FULL_POSITIONS      = 5;    // open virtual positions → full Twin score
const INNOVATION_FULL_ENTRIES  = 20;   // tech_radar entries → full Innovation score
const PATTERN_FULL_RECORDS     = 30;   // verified outcome records → full Pattern score

// Weight deviation that earns full Learning score (abs delta from default per agent)
const LEARNING_FULL_DEVIATION  = 0.10;

/* =========================================================
   LAYER QUERIES  (lightweight, read-only)
========================================================= */

async function _queryCapitalProtection() {
  try {
    const res = await pool.query(`
      SELECT
        COUNT(*)                                            AS total_misses,
        COALESCE(SUM(saved_capital), 0)                    AS total_saved,
        COUNT(*) FILTER (WHERE saved_capital IS NOT NULL)  AS evaluated
      FROM guardian_near_miss
    `);
    const row = res.rows[0] || {};
    return {
      totalMisses:  Number(row.total_misses  || 0),
      totalSaved:   Number(row.total_saved   || 0),
      evaluated:    Number(row.evaluated     || 0),
    };
  } catch (err) {
    logger.warn("systemIntelligence: guardian_near_miss query failed", { message: err.message });
    return { totalMisses: 0, totalSaved: 0, evaluated: 0 };
  }
}

async function _queryPortfolioTwin() {
  try {
    const res = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'open')           AS open_count,
        COUNT(*) FILTER (WHERE status = 'closed')         AS closed_count,
        COALESCE(SUM(pnl_eur)
          FILTER (WHERE status = 'open'),   0)            AS unrealised_pnl,
        COALESCE(SUM(pnl_eur)
          FILTER (WHERE status = 'closed'), 0)            AS realised_pnl
      FROM virtual_positions
    `);
    const row = res.rows[0] || {};
    return {
      openCount:     Number(row.open_count    || 0),
      closedCount:   Number(row.closed_count  || 0),
      unrealisedPnl: Number(row.unrealised_pnl || 0),
      realisedPnl:   Number(row.realised_pnl   || 0),
    };
  } catch (err) {
    logger.warn("systemIntelligence: virtual_positions query failed", { message: err.message });
    return { openCount: 0, closedCount: 0, unrealisedPnl: 0, realisedPnl: 0 };
  }
}

async function _queryInnovation() {
  try {
    const res = await pool.query(`
      SELECT
        COUNT(*)                                                        AS total,
        COUNT(*) FILTER (WHERE relevance = 'high')                     AS high,
        COUNT(*) FILTER (WHERE scanned_at >= NOW() - INTERVAL '7 days') AS recent
      FROM tech_radar_entries
    `);
    const row = res.rows[0] || {};
    return {
      total:  Number(row.total  || 0),
      high:   Number(row.high   || 0),
      recent: Number(row.recent || 0),
    };
  } catch (err) {
    logger.warn("systemIntelligence: tech_radar_entries query failed", { message: err.message });
    return { total: 0, high: 0, recent: 0 };
  }
}

async function _queryPatternMemory() {
  try {
    const res = await pool.query(`
      SELECT
        COUNT(*)                                         AS total,
        COUNT(*) FILTER (WHERE actual_return IS NOT NULL) AS verified,
        COUNT(*) FILTER (WHERE pattern_key IS NOT NULL)   AS with_pattern
      FROM outcome_tracking
    `);
    const row = res.rows[0] || {};
    return {
      total:       Number(row.total       || 0),
      verified:    Number(row.verified    || 0),
      withPattern: Number(row.with_pattern || 0),
    };
  } catch (err) {
    logger.warn("systemIntelligence: outcome_tracking query failed", { message: err.message });
    return { total: 0, verified: 0, withPattern: 0 };
  }
}

/* =========================================================
   SCORING HELPERS
========================================================= */

function _clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function _scorePrediction(wisdom) {
  const scores = wisdom.scores || [];
  const withData = scores.filter((s) => s.total >= 3 && s.accuracy !== null);
  if (!withData.length) {
    return { score: 0, status: "inactive", detail: "Keine verifizierten Prognosen vorhanden" };
  }
  const avgAcc = withData.reduce((s, a) => s + a.accuracy, 0) / withData.length;
  const ratio  = _clamp(avgAcc / PREDICTION_FULL_ACCURACY, 0, 1);
  const score  = Math.round(ratio * MAX_PREDICTION);
  const status = score >= MAX_PREDICTION * 0.7 ? "healthy" : score > 0 ? "degraded" : "inactive";
  return {
    score,
    status,
    detail: `⌀ ${Math.round(avgAcc)}% Genauigkeit über ${withData.length} Agenten`,
    avgAccuracy: Math.round(avgAcc),
    bestAgent: wisdom.bestAgent,
    consensus: wisdom.consensus,
  };
}

function _scoreProtection(protection) {
  const { totalMisses, totalSaved } = protection;
  if (totalMisses === 0) {
    return { score: 0, status: "inactive", detail: "Kein Guardian-Eingriff protokolliert" };
  }
  const ratio = _clamp(totalMisses / PROTECTION_FULL_MISSES, 0, 1);
  const score = Math.round(ratio * MAX_PROTECTION);
  const status = score >= MAX_PROTECTION * 0.5 ? "healthy" : "degraded";
  return {
    score,
    status,
    detail: `${totalMisses} Eingriffe · € ${Math.round(totalSaved).toLocaleString("de-DE")} Kapitalschutz`,
    totalMisses,
    totalSaved: Math.round(totalSaved * 100) / 100,
  };
}

function _scoreTwin(twin) {
  const { openCount, closedCount, unrealisedPnl, realisedPnl } = twin;
  const totalPositions = openCount + closedCount;
  if (totalPositions === 0) {
    return { score: 0, status: "inactive", detail: "Keine virtuellen Positionen" };
  }
  const ratio  = _clamp(openCount / TWIN_FULL_POSITIONS, 0, 1);
  const pnlBonus = (unrealisedPnl + realisedPnl) > 0 ? 2 : 0;
  const score  = Math.round(ratio * (MAX_TWIN - 2)) + pnlBonus;
  const status = openCount > 0 ? "healthy" : "degraded";
  return {
    score: Math.min(score, MAX_TWIN),
    status,
    detail: `${openCount} offen · ${closedCount} geschlossen · PnL € ${(unrealisedPnl + realisedPnl).toFixed(0)}`,
    openCount,
    closedCount,
    totalPnl: Math.round((unrealisedPnl + realisedPnl) * 100) / 100,
  };
}

function _scoreLearning(weights) {
  let totalDev = 0;
  let agentCount = 0;
  for (const [, weight] of Object.entries(weights)) {
    totalDev += Math.abs(weight - DEFAULT_WEIGHT);
    agentCount++;
  }
  if (agentCount === 0) {
    return { score: 0, status: "inactive", detail: "Keine Agenten-Gewichte geladen" };
  }
  const avgDev = totalDev / agentCount;
  const ratio  = _clamp(avgDev / LEARNING_FULL_DEVIATION, 0, 1);
  const score  = Math.round(ratio * MAX_LEARNING);
  const status = score >= MAX_LEARNING * 0.5 ? "healthy" : score > 0 ? "degraded" : "inactive";

  const dominant = Object.entries(weights).sort((a, b) => b[1] - a[1])[0];
  const dominantName = dominant ? dominant[0] : "–";
  return {
    score,
    status,
    detail: score > 0
      ? `Lernabweichung: ⌀ ${(avgDev * 100).toFixed(1)}pp · Dominant: ${dominantName}`
      : "Gewichte noch auf Standardwerten – Causal-Memory läuft noch nicht",
    weights,
    avgDeviation: Math.round(avgDev * 10000) / 10000,
  };
}

function _scoreInnovation(innovation) {
  const { total, high, recent } = innovation;
  if (total === 0) {
    return { score: 0, status: "inactive", detail: "Tech-Radar noch nicht gelaufen" };
  }
  const ratio = _clamp(total / INNOVATION_FULL_ENTRIES, 0, 1);
  const score = Math.round(ratio * MAX_INNOVATION);
  const status = recent > 0 ? "healthy" : "degraded";
  return {
    score,
    status,
    detail: `${total} Entdeckungen gesamt · ${high} hohe Relevanz · ${recent} letzte 7 Tage`,
    total,
    highRelevance: high,
    recentCount: recent,
  };
}

function _scorePattern(pattern) {
  const { total, verified, withPattern } = pattern;
  if (verified === 0) {
    return { score: 0, status: "inactive", detail: "Noch keine verifizierten Outcomes" };
  }
  const ratio = _clamp(verified / PATTERN_FULL_RECORDS, 0, 1);
  const score = Math.round(ratio * MAX_PATTERN);
  const status = withPattern > 0 ? "healthy" : score > 0 ? "degraded" : "inactive";
  return {
    score,
    status,
    detail: `${verified} verifizierte Outcomes · ${withPattern} mit Pattern-Key`,
    total,
    verified,
    withPattern,
  };
}

/* =========================================================
   MATURITY LABEL
========================================================= */

function _maturityLabel(sis) {
  if (sis >= 86) return { key: "elite",       label: "Elite",         color: "#8b5cf6" };
  if (sis >= 71) return { key: "advanced",    label: "Fortgeschritten", color: "#3b82f6" };
  if (sis >= 51) return { key: "operational", label: "Operativ",      color: "#10b981" };
  if (sis >= 31) return { key: "developing",  label: "Entwicklung",   color: "#f59e0b" };
  return               { key: "emerging",     label: "Initialisierung", color: "#ef4444" };
}

/* =========================================================
   RECOMMENDATIONS  (autonomous, derived from weak layers)
========================================================= */

function _buildRecommendations(layers) {
  const recs = [];

  const pred     = layers.find((l) => l.id === "prediction");
  const protect  = layers.find((l) => l.id === "protection");
  const twin     = layers.find((l) => l.id === "twin");
  const learning = layers.find((l) => l.id === "learning");
  const innov    = layers.find((l) => l.id === "innovation");
  const pattern  = layers.find((l) => l.id === "pattern");

  if (pred?.status === "inactive") {
    recs.push({
      priority: 1,
      layer: "Prediction Quality",
      action: "Tägliche Forecast-Verifikation aktivieren",
      howTo: "scheduleDailyForecastVerification() läuft bereits – warte auf verifizierten 24h-Forecast-Zyklus.",
    });
  } else if (pred?.score < MAX_PREDICTION * 0.6 && pred?.score > 0) {
    recs.push({
      priority: 2,
      layer: "Prediction Quality",
      action: "Genauigkeit steigern: Debate-Gewichte per Causal-Memory anpassen",
      howTo: "Causal-Memory-Job läuft täglich um 04:00 Uhr und passt Agent-Gewichte an.",
    });
  }

  if (protect?.status === "inactive") {
    recs.push({
      priority: 1,
      layer: "Capital Protection",
      action: "Guardian Protocol prüfen – noch keine Eingriffe protokolliert",
      howTo: "Guardian läuft in analyzeStockWithGuardian(). Erhöhe Signal-Frequenz oder prüfe Guardian-Schwellwerte.",
    });
  }

  if (twin?.status === "inactive") {
    recs.push({
      priority: 2,
      layer: "Portfolio Twin",
      action: "Virtuelle Positionen aktivieren",
      howTo: "PORTFOLIO_TWIN_AUTO_OPEN=true setzen oder POST /api/admin/portfolio-twin/open aufrufen.",
    });
  }

  if (learning?.status === "inactive") {
    recs.push({
      priority: 3,
      layer: "Adaptive Learning",
      action: "Causal-Memory starten – Gewichte liegen noch auf Default",
      howTo: "Mindestens 3 verifizierte Forecasts pro Agent sind nötig bevor Gewichte angepasst werden.",
    });
  }

  if (innov?.status === "inactive") {
    recs.push({
      priority: 3,
      layer: "Innovation Awareness",
      action: "Tech-Radar-Scan starten",
      howTo: "scheduleTechRadarScan() läuft täglich um 06:00 Uhr oder manuell via POST /api/admin/tech-radar/scan.",
    });
  }

  if (pattern?.status === "inactive") {
    recs.push({
      priority: 3,
      layer: "Pattern Memory",
      action: "Outcome-Tracking befüllen – Pattern-Key-Spalte noch leer",
      howTo: "Pattern Memory entsteht automatisch mit Opportunity-Scans + 7d-Verifikations-Job.",
    });
  }

  // If all layers healthy, add evolution hint
  if (recs.length === 0) {
    recs.push({
      priority: 4,
      layer: "System",
      action: "Alle Schichten operativ – nächste Evolution erwägen",
      howTo: "Prüfe Tech-Radar für neue Quant-Finance-Methoden oder erweitere den Stress-Test auf breitere Szenarien.",
    });
  }

  return recs.sort((a, b) => a.priority - b.priority).slice(0, 3);
}

/* =========================================================
   MAIN REPORT FUNCTION
========================================================= */

/**
 * Builds a full System Intelligence Report by aggregating metrics from all
 * existing subsystems.  Pure read – no writes, no external calls.
 *
 * @returns {Promise<{
 *   sis: number,
 *   maturity: object,
 *   layers: object[],
 *   recommendations: object[],
 *   generatedAt: string
 * }>}
 */
async function getSystemIntelligenceReport() {
  // Fetch all inputs in parallel – no sequential dependencies
  const [wisdom, weights, protection, twin, innovation, pattern] = await Promise.all([
    getAgentWisdomScores({ windowDays: 30 }).catch((err) => {
      logger.warn("systemIntelligence: getAgentWisdomScores failed", { message: err.message });
      return { scores: [], consensus: false, bestAgent: null };
    }),
    getAgentWeights().catch((err) => {
      logger.warn("systemIntelligence: getAgentWeights failed", { message: err.message });
      return {};
    }),
    _queryCapitalProtection(),
    _queryPortfolioTwin(),
    _queryInnovation(),
    _queryPatternMemory(),
  ]);

  const predLayer     = { id: "prediction",  label: "Prediction Quality",    icon: "🎯", max: MAX_PREDICTION, ..._scorePrediction(wisdom) };
  const protectLayer  = { id: "protection",  label: "Capital Protection",     icon: "🛡️", max: MAX_PROTECTION, ..._scoreProtection(protection) };
  const twinLayer     = { id: "twin",        label: "Portfolio Twin",         icon: "📊", max: MAX_TWIN,       ..._scoreTwin(twin) };
  const learningLayer = { id: "learning",    label: "Adaptive Learning",      icon: "🧠", max: MAX_LEARNING,   ..._scoreLearning(weights) };
  const innovLayer    = { id: "innovation",  label: "Innovation Awareness",   icon: "🚀", max: MAX_INNOVATION, ..._scoreInnovation(innovation) };
  const patternLayer  = { id: "pattern",     label: "Pattern Memory",         icon: "🔮", max: MAX_PATTERN,    ..._scorePattern(pattern) };

  const layers = [predLayer, protectLayer, twinLayer, learningLayer, innovLayer, patternLayer];

  const sis = layers.reduce((s, l) => s + l.score, 0);
  const maturity = _maturityLabel(sis);
  const recommendations = _buildRecommendations(layers);

  return {
    sis,
    sisMax: 100,
    maturity,
    layers,
    recommendations,
    generatedAt: new Date().toISOString(),
  };
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  getSystemIntelligenceReport,
};
