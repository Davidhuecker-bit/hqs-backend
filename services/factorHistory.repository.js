"use strict";

const { getSharedPool } = require("../config/database");

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

const pool = getSharedPool();

/* =========================================================
   INIT TABLE (FULL QUANT + SAFE UPGRADE)
========================================================= */

let _factorTableInitialized = false;

async function initFactorTable() {
  if (_factorTableInitialized) return;
  _factorTableInitialized = true;

  // Step 1: Create the table with the original core schema if it does not exist yet.
  // New deployments will receive the full HQS 2.x schema via the upgrade step below.
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

      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Step 2: Idempotent schema upgrade inside a single transaction.
  // Tables created before HQS 2.0/2.1/2.2 are missing the columns below.
  // Each ADD COLUMN IF NOT EXISTS is a no-op when the column already exists.
  // Wrapping all upgrades in one transaction acquires the table lock only once.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const upgrades = [
      // HQS 2.0 Block 1: Data Quality, Confidence & Imputation meta
      "ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS hqs_version TEXT",
      "ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS confidence_score FLOAT",
      "ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS data_quality_meta JSONB",
      "ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS imputation_meta JSONB",
      // HQS 2.0 Block 2: Sector / Peer-Group Normalization meta
      "ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS sector_template TEXT",
      "ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS peer_context_available BOOLEAN",
      "ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS sector_scoring_meta JSONB",
      // HQS 2.0 Block 3: Regime-based Weighting, Enhanced Stability & Liquidity
      "ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS regime_weight_profile JSONB",
      "ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS enhanced_stability_meta JSONB",
      "ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS liquidity_meta JSONB",
      // HQS 2.1 Block 4: Explainable HQS, Versioning & Event-Awareness
      "ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS explainable_tags JSONB",
      "ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS version_reason TEXT",
      "ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS event_awareness_meta JSONB",
      // HQS 2.2 Block 5: Shadow-HQS, Modellvergleich & Point-in-Time Basis
      "ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS scoring_model_id TEXT",
      "ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS shadow_hqs_score FLOAT",
      "ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS shadow_delta FLOAT",
      "ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS comparison_meta JSONB",
      "ALTER TABLE factor_history ADD COLUMN IF NOT EXISTS point_in_time_context JSONB",
    ];
    for (const sql of upgrades) {
      await client.query(sql);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  if (logger?.info) logger.info("factor_history ready (FULL QUANT MODE)");
  else console.log("✅ factor_history ready (FULL QUANT MODE)");
}

/* =========================================================
   SAVE SINGLE STOCK SNAPSHOT
   Writes the full HQS 2.2 Block-5 schema in one INSERT.
   The table is guaranteed to have the full schema because
   initFactorTable() runs CREATE TABLE + idempotent ALTER TABLE upgrades
   before any snapshot processing. No fallback cascade exists.
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
  sectorTemplate,
  peerContextAvailable,
  sectorScoringMeta,
  regimeWeightProfile,
  enhancedStabilityMeta,
  liquidityMeta,
  explainableTags,
  versionReason,
  eventAwarenessMeta,
  // HQS 2.2 Block 5: Shadow-HQS, model comparison & PIT context
  scoringModelId,
  shadowHqsScore,
  shadowDelta,
  comparisonMeta,
  pointInTimeContext,
}) {
  const normalizedRegime = normRegime(regime);

  try {
    await pool.query(
      `
      INSERT INTO factor_history
      (symbol, hqs_score, momentum, quality, stability, relative, regime,
       market_average, volatility,
       hqs_version, confidence_score, data_quality_meta, imputation_meta,
       sector_template, peer_context_available, sector_scoring_meta,
       regime_weight_profile, enhanced_stability_meta, liquidity_meta,
       explainable_tags, version_reason, event_awareness_meta,
       scoring_model_id, shadow_hqs_score, shadow_delta, comparison_meta, point_in_time_context)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
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
        sectorTemplate ?? null,
        peerContextAvailable != null ? Boolean(peerContextAvailable) : null,
        sectorScoringMeta ? JSON.stringify(sectorScoringMeta) : null,
        regimeWeightProfile ? JSON.stringify(regimeWeightProfile) : null,
        enhancedStabilityMeta ? JSON.stringify(enhancedStabilityMeta) : null,
        liquidityMeta ? JSON.stringify(liquidityMeta) : null,
        explainableTags ? JSON.stringify(explainableTags) : null,
        versionReason ?? null,
        eventAwarenessMeta ? JSON.stringify(eventAwarenessMeta) : null,
        scoringModelId ?? null,
        shadowHqsScore != null ? Number(shadowHqsScore) : null,
        shadowDelta != null ? Number(shadowDelta) : null,
        comparisonMeta ? JSON.stringify(comparisonMeta) : null,
        pointInTimeContext ? JSON.stringify(pointInTimeContext) : null,
      ]
    );

    if (logger?.info) logger.info("factor_history: row saved", {
      symbol: String(symbol || "").trim().toUpperCase(),
      regime: normalizedRegime,
      hqsVersion: hqsVersion ?? null,
      scoringModelId: scoringModelId ?? null,
      persistPath: "block5_full",
    });
  } catch (err) {
    if (logger?.error) logger.error("saveScoreSnapshot: insert failed – ensure initFactorTable() ran before snapshot processing", {
      symbol,
      regime: normalizedRegime,
      message: err.message,
      code: err.code,
    });
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

/* =========================================================
   HQS 2.0 Block 2: SECTOR META SUMMARY (admin read-only)
   Returns recent factor_history rows with sector scoring meta.
   Tries Block 2 columns first, falls back gracefully.
========================================================= */

async function getRecentHqsSectorMeta(limit = 50) {
  try {
    // Try with HQS 2.0 Block 2 columns
    try {
      const res = await pool.query(
        `
        SELECT
          id,
          symbol,
          hqs_score              AS "hqsScore",
          regime,
          hqs_version            AS "hqsVersion",
          sector_template        AS "sectorTemplate",
          peer_context_available AS "peerContextAvailable",
          sector_scoring_meta    AS "sectorScoringMeta",
          created_at             AS "createdAt"
        FROM factor_history
        WHERE symbol <> 'PORTFOLIO'
        ORDER BY created_at DESC
        LIMIT $1
        `,
        [limit]
      );

      return res.rows;
    } catch (extErr) {
      // Block 2 columns not yet present – fall back to partial projection.
      if (extErr.code === "42703") {
        if (logger?.warn) logger.warn("getRecentHqsSectorMeta: Block 2 columns not present, using fallback projection");
      } else {
        throw extErr;
      }
    }

    // Fallback projection (no sector columns)
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
      sectorTemplate: null,
      peerContextAvailable: null,
      sectorScoringMeta: null,
    }));
  } catch (err) {
    if (logger?.error) logger.error("getRecentHqsSectorMeta error", { message: err.message });
    else console.error("❌ getRecentHqsSectorMeta error:", err.message);
    return [];
  }
}

/* =========================================================
   HQS 2.0 Block 3: REGIME / STABILITY / LIQUIDITY META (admin read-only)
   Returns recent factor_history rows with regime weight profile,
   enhanced stability meta and liquidity meta.
   Tries Block 3 columns first, falls back gracefully.
========================================================= */

async function getRecentHqsRegimeMeta(limit = 50) {
  try {
    // Try with HQS 2.0 Block 3 columns
    try {
      const res = await pool.query(
        `
        SELECT
          id,
          symbol,
          hqs_score               AS "hqsScore",
          regime,
          hqs_version             AS "hqsVersion",
          regime_weight_profile   AS "regimeWeightProfile",
          enhanced_stability_meta AS "enhancedStabilityMeta",
          liquidity_meta          AS "liquidityMeta",
          created_at              AS "createdAt"
        FROM factor_history
        WHERE symbol <> 'PORTFOLIO'
        ORDER BY created_at DESC
        LIMIT $1
        `,
        [limit]
      );
      return res.rows;
    } catch (extErr) {
      if (extErr.code === "42703") {
        if (logger?.warn) logger.warn("getRecentHqsRegimeMeta: Block 3 columns not present, using fallback projection");
      } else {
        throw extErr;
      }
    }

    // Fallback projection (no Block 3 columns)
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
      regimeWeightProfile: null,
      enhancedStabilityMeta: null,
      liquidityMeta: null,
    }));
  } catch (err) {
    if (logger?.error) logger.error("getRecentHqsRegimeMeta error", { message: err.message });
    else console.error("❌ getRecentHqsRegimeMeta error:", err.message);
    return [];
  }
}

/* =========================================================
   HQS 2.1 Block 4: EXPLAINABILITY / EVENT-AWARENESS META (admin read-only)
   Returns recent factor_history rows with explainable tags,
   version reason and event awareness meta.
   Tries Block 4 columns first, falls back gracefully.
========================================================= */

async function getRecentHqsExplainabilityMeta(limit = 50) {
  try {
    // Try with HQS 2.1 Block 4 columns
    try {
      const res = await pool.query(
        `
        SELECT
          id,
          symbol,
          hqs_score            AS "hqsScore",
          regime,
          hqs_version          AS "hqsVersion",
          explainable_tags     AS "explainableTags",
          version_reason       AS "versionReason",
          event_awareness_meta AS "eventAwarenessMeta",
          created_at           AS "createdAt"
        FROM factor_history
        WHERE symbol <> 'PORTFOLIO'
        ORDER BY created_at DESC
        LIMIT $1
        `,
        [limit]
      );
      return res.rows;
    } catch (extErr) {
      // Block 4 columns not yet present – fall back to partial projection.
      if (extErr.code === "42703") {
        if (logger?.warn) logger.warn("getRecentHqsExplainabilityMeta: Block 4 columns not present, using fallback projection");
      } else {
        throw extErr;
      }
    }

    // Fallback projection (no Block 4 columns)
    const res = await pool.query(
      `
      SELECT
        id,
        symbol,
        hqs_score  AS "hqsScore",
        regime,
        hqs_version AS "hqsVersion",
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
      explainableTags: null,
      versionReason: null,
      eventAwarenessMeta: null,
    }));
  } catch (err) {
    if (logger?.error) logger.error("getRecentHqsExplainabilityMeta error", { message: err.message });
    else console.error("❌ getRecentHqsExplainabilityMeta error:", err.message);
    return [];
  }
}

/* =========================================================
   HQS 2.2 BLOCK 5: RECENT SHADOW META
   Returns the most recent shadow-HQS comparison records for
   admin read-only inspection.  Falls back gracefully to a
   minimal projection when Block 5 columns are not yet present.
========================================================= */

async function getRecentHqsShadowMeta(limit = 50) {
  try {
    let rows;
    try {
      const res = await pool.query(
        `
        SELECT
          id,
          symbol,
          hqs_score             AS "hqsScore",
          regime,
          hqs_version           AS "hqsVersion",
          scoring_model_id      AS "scoringModelId",
          shadow_hqs_score      AS "shadowHqsScore",
          shadow_delta          AS "shadowDelta",
          comparison_meta       AS "comparisonMeta",
          point_in_time_context AS "pointInTimeContext",
          created_at            AS "createdAt"
        FROM factor_history
        WHERE symbol <> 'PORTFOLIO'
        ORDER BY created_at DESC
        LIMIT $1
        `,
        [limit]
      );
      rows = res.rows;
    } catch (extErr) {
      if (extErr.code === "42703") {
        if (logger?.warn) logger.warn("getRecentHqsShadowMeta: Block 5 columns not present, using fallback projection");
      } else {
        throw extErr;
      }

      // Fallback projection (no Block 5 columns)
      const fallback = await pool.query(
        `
        SELECT
          id,
          symbol,
          hqs_score  AS "hqsScore",
          regime,
          hqs_version AS "hqsVersion",
          created_at AS "createdAt"
        FROM factor_history
        WHERE symbol <> 'PORTFOLIO'
        ORDER BY created_at DESC
        LIMIT $1
        `,
        [limit]
      );
      return fallback.rows.map((row) => ({
        ...row,
        scoringModelId:     null,
        shadowHqsScore:     null,
        shadowDelta:        null,
        comparisonMeta:     null,
        pointInTimeContext: null,
      }));
    }

    return rows;
  } catch (err) {
    if (logger?.error) logger.error("getRecentHqsShadowMeta error", { message: err.message });
    else console.error("❌ getRecentHqsShadowMeta error:", err.message);
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
  getRecentHqsSectorMeta,
  getRecentHqsRegimeMeta,
  getRecentHqsExplainabilityMeta,
  getRecentHqsShadowMeta,
};
