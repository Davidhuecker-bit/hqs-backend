// services/marketService.js
// HQS Market Snapshot Service (Massive Only)

const { fetchQuote } = require("./providerService");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ============================
// SYMBOLS
// ============================

const WATCHLIST = ["AAPL", "MSFT", "NVDA", "AMD"];

// ============================
// BUILD SNAPSHOT
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
};
