"use strict";

/*
  HQS Market System
  - Massive Provider
  - Normalizer
  - Snapshot Speicherung
  - HQS Berechnung bei Snapshot
  - Score Speicherung
  - Market liefert gespeicherten Score + Breakdown (DB-first)
*/

const { fetchQuote } = require("./providerService");
const { normalizeMarketData } = require("./marketNormalizer");
const { buildHQSResponse } = require("../hqsEngine");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

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

  console.log("✅ Tables ensured");
}

/* =========================================================
   WATCHLIST
========================================================= */

const WATCHLIST = ["AAPL", "MSFT", "NVDA", "AMD"];

/* =========================================================
   INTERNAL: LOAD LATEST HQS SCORE + BREAKDOWN
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
      hqsCreatedAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    };
  } catch (err) {
    console.error("❌ loadLatestHqsScore error:", err.message);
    return null;
  }
}

/* =========================================================
   SNAPSHOT + HQS PIPELINE (MARKET BASED REGIME)
========================================================= */

async function buildMarketSnapshot() {
  console.log("📦 Building market snapshot...");

  const changes = [];
  const marketData = [];

  // 1) Erst alle Daten sammeln
  for (const symbol of WATCHLIST) {
    try {
      const raw = await fetchQuote(symbol);
      if (!raw || !raw.length) continue;

      const normalized = normalizeMarketData(raw[0], "massive", "us");
      if (!normalized) continue;

      marketData.push(normalized);
      changes.push(Number(normalized.changesPercentage) || 0);
    } catch (err) {
      console.error(`❌ Fetch error for ${symbol}:`, err.message);
    }
  }

  const marketAverage =
    changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;

  // 2) Snapshot + HQS persistieren
  for (const normalized of marketData) {
    try {
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

      // HQS berechnen mit Marktvergleich
      // (falls Engine den 2. Parameter nicht nutzt -> JS ignoriert ihn)
      const hqs = await buildHQSResponse(normalized, marketAverage);

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
          hqs.regime ?? null,
        ]
      );

      console.log(`✅ Snapshot + HQS saved for ${normalized.symbol}`);
    } catch (err) {
      console.error(`❌ Error for ${normalized.symbol}:`, err.message);
    }
  }

  console.log("✅ Snapshot complete");
}

/* =========================================================
   MARKET DATA MIT GESPEICHERTEM SCORE + BREAKDOWN
========================================================= */

async function getMarketData(symbol) {
  try {
    const symbols = symbol ? [String(symbol).trim().toUpperCase()] : WATCHLIST;
    const results = [];

    for (const s of symbols) {
      const raw = await fetchQuote(s);
      if (!raw || !raw.length) continue;

      const normalized = normalizeMarketData(raw[0], "massive", "us");
      if (!normalized) continue;

      // 🔥 DB-first: letzten gespeicherten Score + Breakdown holen
      const cached = await loadLatestHqsScore(s);

      if (cached) {
        normalized.hqsScore = cached.hqsScore;
        normalized.momentum = cached.momentum;
        normalized.quality = cached.quality;
        normalized.stability = cached.stability;
        normalized.relative = cached.relative;
        normalized.regime = cached.regime;
        normalized.hqsCreatedAt = cached.hqsCreatedAt;
      } else {
        normalized.hqsScore = null;
        normalized.momentum = null;
        normalized.quality = null;
        normalized.stability = null;
        normalized.relative = null;
        normalized.regime = null;
        normalized.hqsCreatedAt = null;
      }

      results.push(normalized);
    }

    return results;
  } catch (error) {
    console.error("MarketData Error:", error.message);
    return [];
  }
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  getMarketData,
  buildMarketSnapshot,
  ensureTablesExist,
};
