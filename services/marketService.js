// services/marketService.js
// HQS Market System (Massive + Normalizer + Snapshot Momentum + Table Init)

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
   SNAPSHOT MOMENTUM
========================================================= */

async function getLastSnapshot(symbol) {
  const result = await pool.query(
    `
    SELECT price
    FROM market_snapshots
    WHERE symbol = $1
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [symbol]
  );

  if (!result.rows.length) return null;

  return Number(result.rows[0].price);
}

function calculateSnapshotChangePercent(currentPrice, previousPrice) {
  if (!currentPrice || !previousPrice) return null;
  return ((currentPrice - previousPrice) / previousPrice) * 100;
}

/* =========================================================
   LIVE MARKET DATA
========================================================= */

async function getMarketData(symbol) {
  try {
    if (symbol) {
      return await processSymbol(symbol.toUpperCase());
    }

    const results = [];

    for (const s of WATCHLIST) {
      const data = await processSymbol(s);
      results.push(...data);
    }

    return results;

  } catch (error) {
    console.error("MarketData Error:", error.message);
    return [];
  }
}

async function processSymbol(symbol) {
  const raw = await fetchQuote(symbol);

  if (!raw || !raw.length) return [];

  const normalized = normalizeMarketData(raw[0], "massive", "us");

  if (!normalized) return [];

  // 🔥 Snapshot Momentum Berechnung
  const lastSnapshotPrice = await getLastSnapshot(symbol);

  if (lastSnapshotPrice) {
    const snapshotChange =
      calculateSnapshotChangePercent(
        normalized.price,
        lastSnapshotPrice
      );

    normalized.changesPercentage = snapshotChange;
  }

  return [normalized];
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

      const normalized =
        normalizeMarketData(raw[0], "massive", "us");

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
