"use strict";

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");
const cron = require("node-cron");

const { buildHQSResponse } = require("./hqsEngine");
const { simulateStrategy } = require("./services/backtestEngine");
const { recalibrate } = require("./services/autoRecalibration.service");
const { initWeightTable, loadLastWeights } = require("./services/weightHistory.repository");
const { initFactorTable } = require("./services/factorHistory.repository");
const { getDefaultWeights } = require("./services/autoFactor.service");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

/* ==============================
   DATABASE
============================== */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* ==============================
   SAFE MIGRATION
============================== */

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

  console.log("✅ Tables ensured and migrated");
}

/* ==============================
   MASSIVE API
============================== */

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
    changesPercentage: r.p || 0,
    source: "MASSIVE",
  };
}

/* ==============================
   BUILD SNAPSHOT + LEARNING LOOP
============================== */

async function buildMarketSnapshot() {
  const symbols = ["AAPL", "MSFT", "NVDA", "AMD"];

  console.log("📊 Building market snapshot...");

  let weights = await loadLastWeights();
  if (!weights) {
    weights = getDefaultWeights();
  }

  const history = [];

  for (const symbol of symbols) {
    try {
      const raw = await fetchSnapshot(symbol);

      const enriched = await buildHQSResponse(raw, weights);

      await pool.query(
        `
        INSERT INTO market_snapshots
        (symbol, price, hqs_score, open, high, low, volume, source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `,
        [
          enriched.symbol,
          enriched.price,
          enriched.hqsScore,
          raw.open,
          raw.high,
          raw.low,
          raw.volume,
          raw.source,
        ]
      );

      history.push({
        symbol: enriched.symbol,
        price: enriched.price,
        hqsScore: enriched.hqsScore,
      });

      console.log(`✅ Snapshot saved for ${symbol}`);
    } catch (err) {
      console.error(`❌ Snapshot error for ${symbol}:`, err.message);
    }
  }

  /* ==============================
     BACKTEST + RECALIBRATION
  ============================== */

  if (history.length > 1) {
    const performance = simulateStrategy(history);

    const regime = "bull"; // später SPY-basierend

    await recalibrate(performance, regime);

    console.log("🧠 Recalibration complete");
  }

  console.log("✅ Snapshot cycle complete");
}

/* ==============================
   CRON JOB (alle 15 Minuten)
============================== */

cron.schedule("*/15 * * * *", async () => {
  console.log("⏱ Running scheduled snapshot...");
  await buildMarketSnapshot();
});

/* ==============================
   API ROUTES
============================== */

app.get("/", (req, res) => {
  res.json({ status: "HQS Backend running" });
});

app.get("/market/latest", async (req, res) => {
  const result = await pool.query(`
    SELECT DISTINCT ON (symbol)
    symbol, price, hqs_score, open, high, low, volume, source, created_at
    FROM market_snapshots
    ORDER BY symbol, created_at DESC;
  `);

  res.json(result.rows);
});

/* ==============================
   START SERVER
============================== */

app.listen(PORT, async () => {
  console.log(`🚀 HQS Backend running on port ${PORT}`);

  try {
    await ensureTablesExist();
    await initWeightTable();
    await initFactorTable();
    await buildMarketSnapshot();
  } catch (err) {
    console.error("Startup error:", err.message);
  }
});
