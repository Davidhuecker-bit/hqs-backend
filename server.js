require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// ===============================
// DATABASE
// ===============================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// ===============================
// ENSURE TABLES (SAFE MIGRATION)
// ===============================

async function ensureTablesExist() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_snapshots (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      price NUMERIC,
      hqs_score INTEGER,
      open NUMERIC,
      high NUMERIC,
      low NUMERIC,
      volume BIGINT,
      source TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS prices_daily (
      symbol TEXT NOT NULL,
      date DATE NOT NULL,
      open NUMERIC,
      high NUMERIC,
      low NUMERIC,
      close NUMERIC,
      volume BIGINT,
      source TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (symbol, date)
    );
  `);

  console.log("✅ Tables ensured");
}

// ===============================
// MASSIVE (POLYGON) PROVIDER
// ===============================

const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;

async function fetchSnapshot(symbol) {
  const url = `https://api.massive.com/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${MASSIVE_API_KEY}`;

  const response = await axios.get(url);

  if (!response.data.results || response.data.results.length === 0) {
    throw new Error("No data from Massive");
  }

  const data = response.data.results[0];

  return {
    symbol,
    price: data.c,
    open: data.o,
    high: data.h,
    low: data.l,
    volume: data.v,
    source: "MASSIVE",
  };
}

// ===============================
// SAVE SNAPSHOT
// ===============================

async function saveSnapshot(snapshot) {
  await pool.query(
    `
    INSERT INTO market_snapshots 
    (symbol, price, open, high, low, volume, source)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `,
    [
      snapshot.symbol,
      snapshot.price,
      snapshot.open,
      snapshot.high,
      snapshot.low,
      snapshot.volume,
      snapshot.source,
    ]
  );
}

// ===============================
// BUILD MARKET SNAPSHOT
// ===============================

async function buildMarketSnapshot() {
  const symbols = ["AAPL", "MSFT", "NVDA", "AMD"];

  console.log("📊 Building market snapshot...");

  for (const symbol of symbols) {
    try {
      const data = await fetchSnapshot(symbol);
      await saveSnapshot(data);
      console.log(`✅ Snapshot saved for ${symbol}`);
    } catch (err) {
      console.error(`❌ Snapshot error for ${symbol}`, err.message);
    }
  }

  console.log("✅ Snapshot complete");
}

// ===============================
// ROUTES
// ===============================

app.get("/", (req, res) => {
  res.json({ status: "HQS Backend running" });
});

app.get("/snapshot", async (req, res) => {
  try {
    await buildMarketSnapshot();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// START SERVER
// ===============================

app.listen(PORT, async () => {
  console.log(`🚀 HQS Backend running on port ${PORT}`);

  try {
    await ensureTablesExist();
    await buildMarketSnapshot();
  } catch (err) {
    console.error("Startup error:", err.message);
  }
});
