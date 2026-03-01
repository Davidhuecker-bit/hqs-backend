"use strict";

/*
  HQS Market System
  - Massive Provider
  - Normalizer
  - Snapshot Speicherung
  - HQS Berechnung bei Snapshot (mit Market Average)
  - Score Speicherung (hqs_scores)
  - Market liefert gespeicherten Score + Breakdown + Regime
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
   TABLE INIT (Schema-safe Upgrade)
========================================================= */

async function ensureTablesExist() {
  // Markt Snapshots
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

  // HQS Score Historie (gespeichert)
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

  // Schema-safe Upgrade (falls Tabelle schon existiert, aber Spalten fehlen)
  await pool.query(`ALTER TABLE hqs_scores ADD COLUMN IF NOT EXISTS hqs_score NUMERIC;`);
  await pool.query(`ALTER TABLE hqs_scores ADD COLUMN IF NOT EXISTS momentum NUMERIC;`);
  await pool.query(`ALTER TABLE hqs_scores ADD COLUMN IF NOT EXISTS quality NUMERIC;`);
  await pool.query(`ALTER TABLE hqs_scores ADD COLUMN IF NOT EXISTS stability NUMERIC;`);
  await pool.query(`ALTER TABLE hqs_scores ADD COLUMN IF NOT EXISTS relative NUMERIC;`);
  await pool.query(`ALTER TABLE hqs_scores ADD COLUMN IF NOT EXISTS regime TEXT;`);
  await pool.query(`ALTER TABLE hqs_scores ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);

  console.log("✅ Tables ensured");
}

/* =========================================================
   WATCHLIST
========================================================= */

const WATCHLIST = ["AAPL", "MSFT", "NVDA", "AMD"];

/* =========================================================
   SNAPSHOT + HQS PIPELINE (MARKET BASED REGIME)
========================================================= */

async function buildMarketSnapshot() {
  console.log("📦 Building market snapshot...");

  const changes = [];
  const marketData = [];

  // 1) Erst alle Daten sammeln (damit wir marketAverage berechnen können)
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
    changes.length > 0
      ? changes.reduce((a, b) => a + b, 0) / changes.length
      : 0;

  // 2) Dann speichern + HQS berechnen + HQS speichern
  for (const normalized of marketData) {
    try {
      // Snapshot speichern
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

      // HQS berechnen (marketAverage wird als 2. Parameter übergeben)
      const hqs = await buildHQSResponse(normalized, marketAverage);

      // HQS speichern
      await pool.query(
        `
        INSERT INTO hqs_scores
        (symbol, hqs_score, momentum, quality, stability, relative, regime, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        `,
        [
          String(hqs.symbol || normalized.symbol),
          Number(hqs.hqsScore ?? null),
          Number(hqs.breakdown?.momentum ?? null),
          Number(hqs.breakdown?.quality ?? null),
          Number(hqs.breakdown?.stability ?? null),
          Number(hqs.breakdown?.relative ?? null),
          String(hqs.regime ?? "neutral"),
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
   MARKET DATA MIT GESPEICHERTEM SCORE (+ Breakdown)
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

      // letzten gespeicherten Score + Breakdown holen
      const scoreResult = await pool.query(
        `
        SELECT hqs_score, momentum, quality, stability, relative, regime
        FROM hqs_scores
        WHERE symbol = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [s]
      );

      if (scoreResult.rows.length) {
        const row = scoreResult.rows[0];

        normalized.hqsScore = row.hqs_score !== null ? Number(row.hqs_score) : null;

        // optional: fürs Frontend / weitere Services direkt mitgeben
        normalized.hqsBreakdown = {
          momentum: row.momentum !== null ? Number(row.momentum) : null,
          quality: row.quality !== null ? Number(row.quality) : null,
          stability: row.stability !== null ? Number(row.stability) : null,
          relative: row.relative !== null ? Number(row.relative) : null,
        };

        normalized.regime = row.regime || null;
      } else {
        normalized.hqsScore = null;
        normalized.hqsBreakdown = null;
        normalized.regime = null;
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
