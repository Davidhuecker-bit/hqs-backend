require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// ==============================
// DATABASE
// ==============================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ==============================
// SAFE TABLE MIGRATION
// ==============================

async function ensureTablesExist() {
  // Basis Tabelle
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_snapshots (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      price NUMERIC,
      hqs_score INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Migration – fehlende Spalten ergänzen
  await pool.query(`ALTER TABLE market_snapshots ADD COLUMN IF NOT EXISTS open NUMERIC;`);
  await pool.query(`ALTER TABLE market_snapshots ADD COLUMN IF NOT EXISTS high NUMERIC;`);
  await pool.query(`ALTER TABLE market_snapshots ADD COLUMN IF NOT EXISTS low NUMERIC;`);
  await pool.query(`ALTER TABLE market_snapshots ADD COLUMN IF NOT EXISTS volume BIGINT;`);
  await pool.query(`ALTER TABLE market_snapshots ADD COLUMN IF NOT EXISTS source TEXT;`);

  // Daily Tabelle
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

  console.log("✅ Tables ensured and migrated");
}

// ==============================
// MASSIVE (Polygon) API
// ==============================

const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;

async function fetchSnapshot(symbol) {
  const url = `https://api.massive.com/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${MASSIVE_API_KEY}`;

  const response = await axios.get(url);

  if (!response.data.results || response.data.results.length === 0) {
    throw new Error("No data from Massive");
  }

  const r = response.data.results[0];

  return {
    symbol,
    price: r.c,
    open: r.o,
    high: r.h,
    low: r.l,
    volume: r.v,
    source: "MASSIVE",
  };
}

// ==============================
// SAVE SNAPSHOT
// ==============================

async function saveSnapshot(data) {
  await pool.query(
    `
    INSERT INTO market_snapshots
    (symbol, price, open, high, low, volume, source)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    `,
    [
      data.symbol,
      data.price,
      data.open,
      data.high,
      data.low,
      data.volume,
      data.source,
    ]
  );
}

// ==============================
// BUILD MARKET SNAPSHOT
// ==============================

async function buildMarketSnapshot() {
  const symbols = ["AAPL", "MSFT", "NVDA", "AMD"];

  console.log("📊 Building market snapshot...");

  for (const symbol of symbols) {
    try {
      const snapshot = await fetchSnapshot(symbol);
      await saveSnapshot(snapshot);
      console.log(`✅ Snapshot saved for ${symbol}`);
    } catch (err) {
      console.error(`❌ Snapshot error for ${symbol}:`, err.message);
    }
  }

  console.log("✅ Snapshot complete");
}

// ==============================
// ROUTES
// ==============================

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

// ==============================
// START SERVER
// ==============================

app.listen(PORT, async () => {
  console.log(`🚀 HQS Backend running on port ${PORT}`);

  try {
    await ensureTablesExist();
    await buildMarketSnapshot();
  } catch (err) {
    console.error("Startup error:", err.message);
  }
});
