"use strict";

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
      symbol TEXT,
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
   SNAPSHOT + HQS PIPELINE
========================================================= */

async function buildMarketSnapshot() {
  console.log("📦 Building market snapshot...");

  for (const symbol of WATCHLIST) {
    try {
      const raw = await fetchQuote(symbol);
      if (!raw || !raw.length) continue;

      const normalized = normalizeMarketData(raw[0], "massive", "us");
      if (!normalized) continue;

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

      // 🔥 HQS berechnen
      const hqs = await buildHQSResponse(normalized);

      // 🔥 Score speichern
      await pool.query(
        `
        INSERT INTO hqs_scores
        (symbol, hqs_score, momentum, quality, stability, relative, regime, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        `,
        [
          hqs.symbol,
          hqs.hqsScore,
          hqs.breakdown.momentum,
          hqs.breakdown.quality,
          hqs.breakdown.stability,
          hqs.breakdown.relative,
          hqs.regime
        ]
      );

      console.log(`✅ Snapshot + HQS saved for ${symbol}`);

    } catch (err) {
      console.error(`❌ Error for ${symbol}:`, err.message);
    }
  }

  console.log("✅ Snapshot complete");
}

/* =========================================================
   MARKET DATA (MIT FERTIGEM SCORE)
========================================================= */

async function getMarketData(symbol) {
  try {
    const symbols = symbol ? [symbol] : WATCHLIST;

    const results = [];

    for (const s of symbols) {
      const raw = await fetchQuote(s);
      if (!raw || !raw.length) continue;

      const normalized = normalizeMarketData(raw[0], "massive", "us");
      if (!normalized) continue;

      const scoreResult = await pool.query(
        `
        SELECT hqs_score
        FROM hqs_scores
        WHERE symbol = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [s]
      );

      normalized.hqsScore =
        scoreResult.rows.length ? Number(scoreResult.rows[0].hqs_score) : null;

      results.push(normalized);
    }

    return results;

  } catch (error) {
    console.error("MarketData Error:", error.message);
    return [];
  }
}

module.exports = {
  getMarketData,
  buildMarketSnapshot,
  ensureTablesExist,
};
