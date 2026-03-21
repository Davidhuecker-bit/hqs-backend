"use strict";

const { Pool } = require("pg");

// optional logger (falls vorhanden)
let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

// Regime Normalisierung (wichtig für RL / Queries)
let normalizeRegime = null;
try {
  ({ normalizeRegime } = require("./weightHistory.repository"));
} catch (_) {
  normalizeRegime = null;
}

function normalizeRegimeLocal(regime) {
  const r = String(regime || "").trim().toLowerCase();
  if (r === "bullish") return "bull";
  if (r === "bearish") return "bear";
  if (r === "neutral") return "neutral";
  if (["expansion", "bull", "bear", "crash", "neutral"].includes(r)) return r;
  return "neutral";
}

function normRegime(regime) {
  if (typeof normalizeRegime === "function") return normalizeRegime(regime);
  return normalizeRegimeLocal(regime);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =========================================================
   INIT TABLE (FULL QUANT + SAFE UPGRADE)
========================================================= */

async function initFactorTable() {
  //
  // IMPORTANT: Do NOT add ALTER TABLE ... ADD COLUMN statements here.
  // ALTER TABLE acquires an AccessExclusiveLock on the table, even when the
  // column already exists (IF NOT EXISTS only skips the write, not the lock).
  // Running these on every startup causes lock-contention hangs when
  // HQS-Backend and hqs-scraping-service start concurrently.
  //
  // All columns must be defined in the CREATE TABLE IF NOT EXISTS statement below.

  await pool.query(`
    CREATE TABLE IF NOT EXISTS factor_history (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      hqs_score FLOAT NOT NULL,

      momentum FLOAT,
      quality FLOAT,
      stability FLOAT,
      relative FLOAT,

      regime TEXT NOT NULL,

      market_average FLOAT,
      volatility FLOAT,

      forward_return_1h FLOAT,
      forward_return_1d FLOAT,
      forward_return_3d FLOAT,

      portfolio_return FLOAT,
      factors JSONB,

      -- HQS 2.0 Block 1: Data Quality, Confidence & Imputation meta
      hqs_version TEXT,
      confidence_score FLOAT,
      data_quality_meta JSONB,
      imputation_meta JSONB,

      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  if (logger?.info) logger.info("factor_history ready (FULL QUANT MODE)");
  else console.log("✅ factor_history ready (FULL QUANT MODE)");
}

/* =========================================================
   SAVE SINGLE STOCK SNAPSHOT
   HQS 2.0: accepts optional hqsVersion, confidenceScore,
   dataQualityMeta, imputationMeta for quality-layer storage.
   Falls back gracefully to legacy insert if HQS 2.0 columns
   are not yet present in an existing deployment.
========================================================= */

async function saveScoreSnapshot({
  symbol,
  hqsScore,
  momentum,
  quality,
  stability,
  relative,
  regime,
  marketAverage,
  volatility,
  hqsVersion,
  confidenceScore,
  dataQualityMeta,
  imputationMeta,
}) {
  try {
    const normalizedRegime = normRegime(regime);

    // Try the extended insert that includes HQS 2.0 quality meta columns.
    // If the table was created before these columns existed (legacy deployment),
    // we gracefully fall back to the original insert so existing flow is never broken.
    try {
      await pool.query(
        `
        INSERT INTO factor_history
        (symbol, hqs_score, momentum, quality, stability, relative, regime,
         market_average, volatility,
         hqs_version, confidence_score, data_quality_meta, imputation_meta)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        `,
        [
          String(symbol || "").trim().toUpperCase(),
          Number(hqsScore),
          momentum ?? null,
          quality ?? null,
          stability ?? null,
          relative ?? null,
          normalizedRegime,
          marketAverage ?? null,
          volatility ?? null,
          hqsVersion ?? null,
          confidenceScore != null ? Number(confidenceScore) : null,
          dataQualityMeta ? JSON.stringify(dataQualityMeta) : null,
          imputationMeta ? JSON.stringify(imputationMeta) : null,
        ]
      );
      return;
    } catch (extErr) {
      // Column does not exist in this deployment – fall back to legacy insert.
      // PostgreSQL error code 42703 = undefined_column.
      if (extErr.code === "42703") {
        if (logger?.warn) logger.warn("saveScoreSnapshot: HQS 2.0 columns not yet in table, using legacy insert", { message: extErr.message });
      } else {
        throw extErr;
      }
    }

    // Legacy fallback (pre-HQS-2.0 table schema)
    await pool.query(
      `
      INSERT INTO factor_history
      (symbol, hqs_score, momentum, quality, stability, relative, regime,
       market_average, volatility)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `,
      [
        String(symbol || "").trim().toUpperCase(),
        Number(hqsScore),
        momentum ?? null,
        quality ?? null,
        stability ?? null,
        relative ?? null,
        normalizedRegime,
        marketAverage ?? null,
        volatility ?? null,
      ]
    );
  } catch (err) {
    if (logger?.error) logger.error("saveScoreSnapshot error", { message: err.message });
    else console.error("❌ saveScoreSnapshot error:", err.message);
  }
}

/* =========================================================
   SAVE PORTFOLIO SNAPSHOT (Learning)
========================================================= */

async function saveFactorSnapshot(regime, portfolioReturn, factors) {
  try {
    const normalizedRegime = normRegime(regime);

    await pool.query(
      `
      INSERT INTO factor_history
      (symbol, hqs_score, regime, portfolio_return, factors)
      VALUES ($1,$2,$3,$4,$5)
      `,
      ["PORTFOLIO", 0, normalizedRegime, portfolioReturn ?? null, factors ?? null]
    );
  } catch (err) {
    if (logger?.error) logger.error("saveFactorSnapshot error", { message: err.message });
    else console.error("❌ saveFactorSnapshot error:", err.message);
  }
}

/* =========================================================
   UPDATE FORWARD RETURNS (LABELING)
   ✅ BACKWARD + FORWARD COMPATIBLE

   ALT:
     updateForwardReturns(symbol, hoursAhead, percentChange)

   NEU:
     updateForwardReturns(rowId, forward1d, forward3d)
========================================================= */

async function updateForwardReturns(a, b, c) {
  try {
    // NEW MODE: (rowId, forward1d, forward3d)
    if (Number.isFinite(Number(a)) && typeof b === "number") {
      const rowId = Number(a);
      const forward1d = b;
      const forward3d = c;

      const sets = [];
      const values = [];
      let idx = 1;

      if (forward1d !== null && forward1d !== undefined) {
        sets.push(`forward_return_1d = $${idx++}`);
        values.push(Number(forward1d));
      }

      if (forward3d !== null && forward3d !== undefined) {
        sets.push(`forward_return_3d = $${idx++}`);
        values.push(Number(forward3d));
      }

      if (!sets.length) return;

      values.push(rowId);

      await pool.query(
        `
        UPDATE factor_history
        SET ${sets.join(", ")}
        WHERE id = $${idx}
        `,
        values
      );

      return;
    }

    // OLD MODE: (symbol, hoursAhead, percentChange)
    const symbol = String(a || "").trim().toUpperCase();
    const hoursAhead = Number(b);
    const percentChange = c;

    if (!symbol || !Number.isFinite(hoursAhead)) return;

    let column;
    if (hoursAhead === 1) column = "forward_return_1h";
    else if (hoursAhead === 24) column = "forward_return_1d";
    else column = "forward_return_3d";

    await pool.query(
      `
      UPDATE factor_history
      SET ${column} = $1
      WHERE symbol = $2
        AND ${column} IS NULL
      `,
      [percentChange, symbol]
    );
  } catch (err) {
    if (logger?.error) logger.error("updateForwardReturns error", { message: err.message });
    else console.error("❌ updateForwardReturns error:", err.message);
  }
}

/* =========================================================
   LOAD HISTORY (für Calibration / Reinforcement)
========================================================= */

async function loadFactorHistory(limit = 500) {
  try {
    const res = await pool.query(
      `
      SELECT *
      FROM factor_history
      ORDER BY created_at ASC
      LIMIT $1
      `,
      [limit]
    );

    return res.rows;
  } catch (err) {
    if (logger?.error) logger.error("loadFactorHistory error", { message: err.message });
    else console.error("❌ loadFactorHistory error:", err.message);
    return [];
  }
}

/* =========================================================
   BACKTEST HISTORY (hqs_score + price by symbol)
========================================================= */

async function getBacktestHistory(symbol, limit = 200) {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) return [];

  try {
    const res = await pool.query(
      `
      SELECT fh.hqs_score AS "hqsScore", ms.price
      FROM factor_history fh
      JOIN market_snapshots ms
        ON fh.symbol = ms.symbol
       AND ms.created_at BETWEEN fh.created_at - INTERVAL '30 minutes'
                              AND fh.created_at + INTERVAL '30 minutes'
      WHERE fh.symbol = $1
        AND ms.price IS NOT NULL
        AND fh.hqs_score IS NOT NULL
      ORDER BY fh.created_at ASC
      LIMIT $2
      `,
      [sym, limit]
    );

    return res.rows.map((row) => ({
      hqsScore: Number(row.hqsScore),
      price: Number(row.price),
    }));
  } catch (err) {
    if (logger?.error) logger.error("getBacktestHistory error", { message: err.message });
    else console.error("❌ getBacktestHistory error:", err.message);
    return [];
  }
}

/* =========================================================
   HQS 2.0: DATA QUALITY SUMMARY (admin read-only)
   Returns recent factor_history rows with quality meta,
   trying HQS 2.0 columns first and falling back to legacy
   projection if they are not yet present.
========================================================= */

async function getRecentHqsDataQuality(limit = 50) {
  try {
    // Try with HQS 2.0 columns
    try {
      const res = await pool.query(
        `
        SELECT
          id,
          symbol,
          hqs_score        AS "hqsScore",
          regime,
          hqs_version      AS "hqsVersion",
          confidence_score AS "confidenceScore",
          data_quality_meta AS "dataQualityMeta",
          imputation_meta   AS "imputationMeta",
          created_at        AS "createdAt"
        FROM factor_history
        WHERE symbol <> 'PORTFOLIO'
        ORDER BY created_at DESC
        LIMIT $1
        `,
        [limit]
      );

      return res.rows;
    } catch (extErr) {
      // Column does not exist in this deployment – fall back to legacy projection.
      // PostgreSQL error code 42703 = undefined_column.
      if (extErr.code === "42703") {
        if (logger?.warn) logger.warn("getRecentHqsDataQuality: HQS 2.0 columns not present, using legacy projection");
      } else {
        throw extErr;
      }
    }

    // Legacy fallback projection (no quality meta columns)
    const res = await pool.query(
      `
      SELECT
        id,
        symbol,
        hqs_score  AS "hqsScore",
        regime,
        created_at AS "createdAt"
      FROM factor_history
      WHERE symbol <> 'PORTFOLIO'
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [limit]
    );

    return res.rows.map((row) => ({
      ...row,
      hqsVersion: null,
      confidenceScore: null,
      dataQualityMeta: null,
      imputationMeta: null,
    }));
  } catch (err) {
    if (logger?.error) logger.error("getRecentHqsDataQuality error", { message: err.message });
    else console.error("❌ getRecentHqsDataQuality error:", err.message);
    return [];
  }
}

module.exports = {
  initFactorTable,
  saveScoreSnapshot,
  saveFactorSnapshot,
  loadFactorHistory,
  updateForwardReturns,
  getBacktestHistory,
  getRecentHqsDataQuality,
};
