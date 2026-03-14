"use strict";

/*
  MockPortfolioEngine
  -------------------
  Loads up to 40 distinct stocks from the DB (outcome_tracking → autonomy_audit fallback),
  enriches each entry with a sector label and returns a normalised portfolio payload.
*/

const { Pool } = require("pg");
const logger = require("../utils/logger");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =========================================================
   SECTOR MAP  (well-known symbols → German sector label)
========================================================= */

const SECTOR_MAP = {
  // Technology
  AAPL: "Technologie", MSFT: "Technologie", GOOGL: "Technologie",
  GOOG: "Technologie", NVDA: "Technologie", META: "Technologie",
  AMZN: "Technologie", TSLA: "Technologie", AMD: "Technologie",
  INTC: "Technologie", CRM: "Technologie", ORCL: "Technologie",
  ADBE: "Technologie", NFLX: "Technologie", QCOM: "Technologie",
  AVGO: "Technologie", NOW: "Technologie", SNOW: "Technologie",
  // Finance
  JPM: "Finanzen", BAC: "Finanzen", GS: "Finanzen",
  MS: "Finanzen", WFC: "Finanzen", BLK: "Finanzen",
  C: "Finanzen", AXP: "Finanzen", V: "Finanzen",
  MA: "Finanzen", PYPL: "Finanzen", SCHW: "Finanzen",
  // Energy
  XOM: "Energie", CVX: "Energie", COP: "Energie",
  EOG: "Energie", SLB: "Energie", BP: "Energie",
  SHEL: "Energie", OXY: "Energie", MPC: "Energie",
  PSX: "Energie", NEE: "Energie", DUK: "Energie",
  // Healthcare
  JNJ: "Gesundheit", PFE: "Gesundheit", ABBV: "Gesundheit",
  MRK: "Gesundheit", UNH: "Gesundheit", LLY: "Gesundheit",
  BMY: "Gesundheit", GILD: "Gesundheit", AMGN: "Gesundheit",
  // Consumer
  WMT: "Konsum", COST: "Konsum", PG: "Konsum",
  KO: "Konsum", PEP: "Konsum", MCD: "Konsum",
  NKE: "Konsum", SBUX: "Konsum", HD: "Konsum",
  // Industrials
  CAT: "Industrie", HON: "Industrie", BA: "Industrie",
  GE: "Industrie", MMM: "Industrie", DE: "Industrie",
  UPS: "Industrie", RTX: "Industrie", LMT: "Industrie",
  // Materials / Commodities
  FCX: "Rohstoffe", NEM: "Rohstoffe", BHP: "Rohstoffe",
  RIO: "Rohstoffe", VALE: "Rohstoffe", ALB: "Rohstoffe",
};

function assignSector(symbol) {
  return SECTOR_MAP[String(symbol || "").toUpperCase()] || "Sonstige";
}

/* =========================================================
   NORMALISE A ROW FROM outcome_tracking
========================================================= */

function normaliseOutcomeRow(row) {
  const snap = row.raw_input_snapshot || {};
  const robustness =
    Number(
      snap.historical_context?.robustness ??
      snap.robustness ??
      row.final_conviction / 100 ??
      0.5
    ) || 0.5;

  const marketRegime =
    snap.market_regime ??
    snap.regime ??
    row.regime ??
    "neutral";

  return {
    id: row.id,
    symbol: String(row.symbol || "").toUpperCase(),
    sector: assignSector(row.symbol),
    robustness_score: Math.min(1, Math.max(0, Number(robustness) || 0.5)),
    market_regime: String(marketRegime).toLowerCase(),
    analysis_rationale: row.analysis_rationale || null,
    hqs_score: Number(row.hqs_score) || null,
    final_conviction: Number(row.final_conviction) || null,
    strategy: row.strategy || null,
    predicted_at: row.predicted_at || null,
    has_snapshot: Boolean(row.raw_input_snapshot),
    source: "outcome_tracking",
  };
}

/* =========================================================
   NORMALISE A ROW FROM autonomy_audit
========================================================= */

function normaliseAuditRow(row) {
  return {
    id: row.id,
    symbol: String(row.symbol || "").toUpperCase(),
    sector: assignSector(row.symbol),
    robustness_score: Math.min(1, Math.max(0, Number(row.robustness_score) || 0.5)),
    market_regime: String(row.market_cluster || "neutral").toLowerCase(),
    analysis_rationale: row.suppression_reason
      ? `Entscheidung: ${row.decision_value}. ${row.suppression_reason}`
      : `Entscheidung: ${row.decision_value || "–"}`,
    hqs_score: null,
    final_conviction: null,
    strategy: row.decision_type || null,
    predicted_at: row.decided_at || null,
    has_snapshot: Boolean(row.raw_input_snapshot),
    source: "autonomy_audit",
  };
}

/* =========================================================
   FETCH 40 PORTFOLIO ITEMS
========================================================= */

const PORTFOLIO_SIZE = 40;

async function getMockPortfolio() {
  let rows = [];

  // --- Primary: outcome_tracking ---
  try {
    const res = await pool.query(`
      SELECT DISTINCT ON (symbol)
        id, symbol, regime, strategy,
        hqs_score, final_conviction,
        predicted_at,
        raw_input_snapshot,
        analysis_rationale
      FROM outcome_tracking
      WHERE symbol IS NOT NULL
      ORDER BY symbol, predicted_at DESC NULLS LAST
      LIMIT 200
    `);
    rows = res.rows.map(normaliseOutcomeRow);
  } catch (err) {
    logger.warn("mockPortfolio: outcome_tracking query failed", { message: err.message });
  }

  // --- Fallback / supplement: autonomy_audit ---
  if (rows.length < PORTFOLIO_SIZE) {
    try {
      const existing = new Set(rows.map((r) => r.symbol));
      const res = await pool.query(`
        SELECT DISTINCT ON (symbol)
          id, symbol, decision_type, decision_value,
          market_cluster, robustness_score,
          guardian_applied, suppressed, suppression_reason,
          raw_input_snapshot, decided_at
        FROM autonomy_audit
        WHERE symbol IS NOT NULL
        ORDER BY symbol, decided_at DESC NULLS LAST
        LIMIT 200
      `);
      for (const row of res.rows) {
        const sym = String(row.symbol || "").toUpperCase();
        if (!existing.has(sym)) {
          rows.push(normaliseAuditRow(row));
          existing.add(sym);
        }
      }
    } catch (err) {
      logger.warn("mockPortfolio: autonomy_audit query failed", { message: err.message });
    }
  }

  // If DB is empty (first run / no data) fall back to a curated static seed so
  // the admin tab always shows something meaningful.
  if (rows.length === 0) {
    rows = buildStaticSeed();
  }

  // Shuffle for variety, then pick up to 40
  rows = fisherYatesShuffle(rows).slice(0, PORTFOLIO_SIZE);

  // Sort by robustness_score descending
  rows.sort((a, b) => b.robustness_score - a.robustness_score);

  return rows;
}

/* =========================================================
   FETCH A SINGLE RAW INPUT SNAPSHOT (evidence linking)
========================================================= */

async function getSnapshotById({ id, source }) {
  if (source === "autonomy_audit") {
    const res = await pool.query(
      `SELECT id, symbol, decision_type, decision_value,
              market_cluster, robustness_score,
              guardian_applied, suppressed, suppression_reason,
              raw_input_snapshot, decided_at
       FROM autonomy_audit WHERE id = $1`,
      [Number(id)]
    );
    if (!res.rows.length) return null;
    const row = res.rows[0];
    return {
      id: row.id,
      symbol: row.symbol,
      decided_at: row.decided_at,
      decision_type: row.decision_type,
      decision_value: row.decision_value,
      raw_input_snapshot: row.raw_input_snapshot,
    };
  }

  // default: outcome_tracking
  const res = await pool.query(
    `SELECT id, symbol, regime, strategy, hqs_score,
            final_conviction, final_confidence,
            predicted_at, raw_input_snapshot, analysis_rationale
     FROM outcome_tracking WHERE id = $1`,
    [Number(id)]
  );
  if (!res.rows.length) return null;
  return res.rows[0];
}

/* =========================================================
   FETCH LATEST AUDIT FEED ENTRIES
========================================================= */

async function getAuditFeed({ limit = 25 } = {}) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  try {
    const res = await pool.query(
      `SELECT id, symbol, decision_type, decision_value,
              market_cluster, robustness_score,
              guardian_applied, suppressed, suppression_reason,
              decided_at
       FROM autonomy_audit
       ORDER BY decided_at DESC
       LIMIT $1`,
      [safeLimit]
    );
    return res.rows;
  } catch (err) {
    logger.warn("mockPortfolio: audit-feed query failed", { message: err.message });
    return [];
  }
}

/* =========================================================
   HELPERS
========================================================= */

function fisherYatesShuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Static seed used only when both DB tables are empty */
function buildStaticSeed() {
  const seed = [
    { symbol: "AAPL", regime: "risk_on", robustness: 0.92, conviction: 88, strategy: "momentum" },
    { symbol: "MSFT", regime: "risk_on", robustness: 0.88, conviction: 85, strategy: "quality" },
    { symbol: "NVDA", regime: "risk_on", robustness: 0.95, conviction: 91, strategy: "momentum" },
    { symbol: "JPM",  regime: "neutral", robustness: 0.76, conviction: 72, strategy: "balanced" },
    { symbol: "XOM",  regime: "neutral", robustness: 0.71, conviction: 68, strategy: "value" },
    { symbol: "JNJ",  regime: "risk_off", robustness: 0.83, conviction: 79, strategy: "quality" },
    { symbol: "BAC",  regime: "neutral", robustness: 0.74, conviction: 70, strategy: "balanced" },
    { symbol: "GOOGL", regime: "risk_on", robustness: 0.87, conviction: 83, strategy: "momentum" },
    { symbol: "META", regime: "risk_on", robustness: 0.84, conviction: 80, strategy: "momentum" },
    { symbol: "WMT",  regime: "risk_off", robustness: 0.79, conviction: 75, strategy: "quality" },
    { symbol: "CVX",  regime: "neutral", robustness: 0.69, conviction: 65, strategy: "value" },
    { symbol: "PFE",  regime: "risk_off", robustness: 0.72, conviction: 68, strategy: "quality" },
    { symbol: "GS",   regime: "neutral", robustness: 0.77, conviction: 73, strategy: "balanced" },
    { symbol: "TSLA", regime: "risk_on", robustness: 0.81, conviction: 77, strategy: "momentum" },
    { symbol: "NEE",  regime: "neutral", robustness: 0.73, conviction: 69, strategy: "value" },
    { symbol: "CAT",  regime: "neutral", robustness: 0.70, conviction: 66, strategy: "balanced" },
    { symbol: "AMD",  regime: "risk_on", robustness: 0.89, conviction: 85, strategy: "momentum" },
    { symbol: "V",    regime: "neutral", robustness: 0.82, conviction: 78, strategy: "quality" },
    { symbol: "MA",   regime: "neutral", robustness: 0.83, conviction: 79, strategy: "quality" },
    { symbol: "AMZN", regime: "risk_on", robustness: 0.90, conviction: 86, strategy: "momentum" },
    { symbol: "UNH",  regime: "risk_off", robustness: 0.85, conviction: 81, strategy: "quality" },
    { symbol: "ABBV", regime: "risk_off", robustness: 0.78, conviction: 74, strategy: "quality" },
    { symbol: "LLY",  regime: "risk_off", robustness: 0.86, conviction: 82, strategy: "quality" },
    { symbol: "COP",  regime: "neutral", robustness: 0.67, conviction: 63, strategy: "value" },
    { symbol: "HON",  regime: "neutral", robustness: 0.72, conviction: 68, strategy: "balanced" },
    { symbol: "BA",   regime: "risk_off", robustness: 0.61, conviction: 57, strategy: "value" },
    { symbol: "KO",   regime: "risk_off", robustness: 0.80, conviction: 76, strategy: "quality" },
    { symbol: "PEP",  regime: "risk_off", robustness: 0.81, conviction: 77, strategy: "quality" },
    { symbol: "NKE",  regime: "neutral", robustness: 0.74, conviction: 70, strategy: "balanced" },
    { symbol: "CRM",  regime: "risk_on", robustness: 0.83, conviction: 79, strategy: "momentum" },
    { symbol: "ORCL", regime: "risk_on", robustness: 0.79, conviction: 75, strategy: "momentum" },
    { symbol: "COST", regime: "risk_off", robustness: 0.85, conviction: 81, strategy: "quality" },
    { symbol: "FCX",  regime: "neutral", robustness: 0.65, conviction: 61, strategy: "value" },
    { symbol: "MRK",  regime: "risk_off", robustness: 0.77, conviction: 73, strategy: "quality" },
    { symbol: "WFC",  regime: "neutral", robustness: 0.73, conviction: 69, strategy: "balanced" },
    { symbol: "AVGO", regime: "risk_on", robustness: 0.88, conviction: 84, strategy: "momentum" },
    { symbol: "INTC", regime: "neutral", robustness: 0.63, conviction: 59, strategy: "value" },
    { symbol: "MCD",  regime: "risk_off", robustness: 0.82, conviction: 78, strategy: "quality" },
    { symbol: "SLB",  regime: "neutral", robustness: 0.68, conviction: 64, strategy: "value" },
    { symbol: "HD",   regime: "neutral", robustness: 0.76, conviction: 72, strategy: "balanced" },
  ];

  const regimeRationale = {
    risk_on: "Marktregime zeigt konstruktives Momentum. System bewertet Einstiegschancen positiv auf Basis robuster Liquiditäts- und Trendindikatoren.",
    risk_off: "Defensives Regime erkannt. System priorisiert Kapitalschutz und qualitativ hochwertige Titel mit geringer Volatilität.",
    neutral: "Neutrales Marktregime. System hält ausgewogene Positionierung zwischen Wachstum und Schutz.",
  };

  return seed.map((s, i) => ({
    id: i + 1,
    symbol: s.symbol,
    sector: assignSector(s.symbol),
    robustness_score: s.robustness,
    market_regime: s.regime,
    analysis_rationale: regimeRationale[s.regime] || null,
    hqs_score: Math.round(s.conviction * 1.1),
    final_conviction: s.conviction,
    strategy: s.strategy,
    predicted_at: new Date(Date.now() - Math.random() * 86400000 * 3).toISOString(),
    has_snapshot: false,
    source: "static_seed",
  }));
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  getMockPortfolio,
  getSnapshotById,
  getAuditFeed,
};
