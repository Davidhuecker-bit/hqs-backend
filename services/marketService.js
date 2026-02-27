// services/marketService.js

const { fetchQuote } = require("./providerService");
const { buildHQSResponse } = require("../hqsEngine");
const { Redis } = require("@upstash/redis");
const { Pool } = require("pg");

// ============================
// REDIS (UPSTASH)
// ============================

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ============================
// POSTGRES (RAILWAY)
// ============================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ============================
// DEFAULT SYMBOLS
// ============================

const DEFAULT_SYMBOLS = (process.env.GUARDIAN_SYMBOLS || "AAPL,MSFT,NVDA,AMD")
  .split(",")
  .map((symbol) => String(symbol || "").trim().toUpperCase())
  .filter((symbol) => /^[A-Z0-9.-]{1,12}$/.test(symbol));

// ============================
// TABLE CREATION
// ============================

async function ensureTablesExist() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS market_snapshots (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(20),
        price NUMERIC,
        hqs_score NUMERIC,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS prices_daily (
        symbol VARCHAR(20) NOT NULL,
        date DATE NOT NULL,
        open NUMERIC,
        high NUMERIC,
        low NUMERIC,
        close NUMERIC,
        volume NUMERIC,
        source VARCHAR(40) DEFAULT 'fmp',
        created_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (symbol, date)
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_prices_daily_symbol_date
      ON prices_daily (symbol, date);
    `);

    console.log("Tabellen geprueft/erstellt (market_snapshots + prices_daily)");
  } catch (err) {
    console.error("Table Creation Error:", err.message);
  }
}

// ============================
// REDIS CACHE
// ============================

async function readSnapshotCache() {
  try {
    const cached = await redis.get("market:snapshot");
    if (!cached) return null;
    return typeof cached === "string" ? JSON.parse(cached) : cached;
  } catch (error) {
    console.error("Snapshot Cache Read Error:", error.message);
    return null;
  }
}

async function writeSnapshotCache(payload) {
  try {
    await redis.set("market:snapshot", JSON.stringify(payload), { ex: 60 });
  } catch (error) {
    console.error("Snapshot Cache Write Error:", error.message);
  }
}

// ============================
// SAVE SNAPSHOT TO POSTGRES
// ============================

async function saveSnapshotToDB(results) {
  try {
    for (const item of results) {
      await pool.query(
        `
        INSERT INTO market_snapshots (symbol, price, hqs_score)
        VALUES ($1, $2, $3)
        `,
        [item.symbol, item.price || 0, item.hqsScore || 0],
      );
    }
    console.log("Snapshot in Postgres gespeichert");
  } catch (err) {
    console.error("DB Insert Error:", err.message);
  }
}

// ============================
// SNAPSHOT BUILDER
// ============================

async function buildMarketSnapshot() {
  try {
    const results = [];

    for (const symbol of DEFAULT_SYMBOLS) {
      try {
        const data = await fetchQuote(symbol);

        if (data && data[0]) {
          const hqsData = await buildHQSResponse(data[0]);
          if (hqsData) results.push(hqsData);
        }
      } catch (err) {
        console.error("Snapshot Error for " + symbol + ":", err.message);
      }
    }

    if (results.length === 0) {
      throw new Error("Kein Provider lieferte Daten fuer Snapshot.");
    }

    await writeSnapshotCache(results);
    await saveSnapshotToDB(results);

    console.log("Market Snapshot aktualisiert (FMP)");
    return results;
  } catch (error) {
    console.error("Snapshot Error:", error.message);
    const staleData = await readSnapshotCache();
    return Array.isArray(staleData) ? staleData : [];
  }
}

// ============================
// MAIN DATA FETCH
// ============================

async function getMarketData(symbol) {
  if (symbol) {
    try {
      const data = await fetchQuote(symbol);
      if (!Array.isArray(data) || data.length === 0) return [];

      const mapped = await Promise.all(
        data.map(async (item) => {
          try {
            return await buildHQSResponse(item);
          } catch (err) {
            console.error("HQS Engine Error for " + (item && item.symbol) + ":", err.message);
            return null;
          }
        }),
      );

      return mapped.filter(Boolean);
    } catch (err) {
      console.error("getMarketData Error:", err.message);
      return [];
    }
  }

  const cached = await readSnapshotCache();
  if (Array.isArray(cached) && cached.length > 0) {
    console.log("Snapshot Cache Hit");
    return cached;
  }

  return buildMarketSnapshot();
}

// ============================
// EXPORTS
// ============================

module.exports = {
  getMarketData,
  buildMarketSnapshot,
  ensureTablesExist,
};