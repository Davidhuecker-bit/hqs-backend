// services/marketService.js
// HQS Market System (Massive + Snapshot + Table Init)

const { fetchQuote } = require("./providerService");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ============================
// TABLE INIT
// ============================

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

// ============================
// WATCHLIST
// ============================

const WATCHLIST = ["AAPL", "MSFT", "NVDA", "AMD"];

// ============================
// SNAPSHOT BUILDER
// ============================

async function buildMarketSnapshot() {
  console.log("📦 Building market snapshot...");

  for (const symbol of WATCHLIST) {
    try {
      const data = await fetchQuote(symbol);

      if (!data || data.length === 0) {
        throw new Error("No data returned");
      }

      const quote = data[0];

      await pool.query(
        `
        INSERT INTO market_snapshots 
        (symbol, price, open, high, low, volume, source, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        `,
        [
          quote.symbol,
          quote.price,
          quote.open,
          quote.high,
          quote.low,
          quote.volume,
          quote.source,
        ]
      );

      console.log(`✅ Snapshot saved for ${symbol}`);
    } catch (error) {
      console.error(`❌ Snapshot error for ${symbol}:`, error.message);
    }
  }

  console.log("✅ Snapshot complete");
}

module.exports = {
  buildMarketSnapshot,
  ensureTablesExist,
};
