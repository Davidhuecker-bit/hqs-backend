// services/marketService.js
// HQS Market System (Massive + Normalizer + Snapshot + Table Init)

"use strict";

const { fetchQuote } = require("./providerService");
const { normalizeMarketData } = require("./marketNormalizer");
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

  console.log("✅ Tables ensured");
}

/* =========================================================
   WATCHLIST
========================================================= */

const WATCHLIST = ["AAPL", "MSFT", "NVDA", "AMD"];

/* =========================================================
   LIVE MARKET DATA (Massive Primary + Normalizer)
========================================================= */

async function getMarketData(symbol) {
  try {
    // Einzelaktie
    if (symbol) {
      const raw = await fetchQuote(symbol.toUpperCase());

      if (!raw || !raw.length) return [];

      return raw
        .map(item =>
          normalizeMarketData(item, "massive", "us")
        )
        .filter(Boolean);
    }

    // Wenn kein Symbol → Watchlist laden
    const results = [];

    for (const s of WATCHLIST) {
      const raw = await fetchQuote(s);

      if (!raw || !raw.length) continue;

      const normalized = raw
        .map(item =>
          normalizeMarketData(item, "massive", "us")
        )
        .filter(Boolean);

      results.push(...normalized);
    }

    return results;

  } catch (error) {
    console.error("MarketData Error:", error.message);
    return [];
  }
}

/* =========================================================
   SNAPSHOT BUILDER
========================================================= */

async function buildMarketSnapshot() {
  console.log("📦 Building market snapshot...");

  for (const symbol of WATCHLIST) {
    try {
      const raw = await fetchQuote(symbol);

      if (!raw || raw.length === 0) {
        throw new Error("No data returned");
      }

      const normalized = normalizeMarketData(
        raw[0],
        "massive",
        "us"
      );

      if (!normalized) continue;

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

      console.log(`✅ Snapshot saved for ${symbol}`);

    } catch (error) {
      console.error(
        `❌ Snapshot error for ${symbol}:`,
        error.message
      );
    }
  }

  console.log("✅ Snapshot complete");
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  getMarketData,
  buildMarketSnapshot,
  ensureTablesExist,
};
