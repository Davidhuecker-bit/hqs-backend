const express = require("express");
const cors = require("cors");
const axios = require("axios");
const NodeCache = require("node-cache");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 8080;

/* ================= ENV CHECK ================= */

if (!process.env.ALPHA_VANTAGE_API_KEY) {
  console.error("❌ ALPHA_VANTAGE_API_KEY missing");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL missing");
  process.exit(1);
}

console.log("🚀 HQS Backend 3.1 Starting...");

/* ================= MIDDLEWARE ================= */

app.use(cors());
app.use(express.json());

/* ================= DATABASE ================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hqs_history (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(10),
        price NUMERIC,
        change_percent NUMERIC,
        volume BIGINT,
        hqs_score INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("✅ Database initialized");
  } catch (err) {
    console.error("❌ Database init failed:", err.message);
    process.exit(1);
  }
}

/* ================= CACHE ================= */

const cache = new NodeCache({ stdTTL: 300 });

/* ================= HQS ENGINE ================= */

class HQSEngine {
  normalize(value, min, max) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, (value - min) / (max - min)));
  }

  calculateScore({ changePercent, volume }) {
    const avgVolume = 30000000;

    const intradayScore = this.normalize(changePercent, -3, 3);
    const relativeVolume = volume / avgVolume;
    const volumeScore = this.normalize(relativeVolume, 0.5, 2);

    const strengthScore =
      changePercent > 0
        ? this.normalize(changePercent, 0, 5)
        : 0.2;

    const stabilityScore =
      changePercent < -3
        ? 0
        : changePercent < 0
        ? 0.3
        : 1;

    const accelScore = this.normalize(changePercent, -1, 4);

    const finalScore =
      intradayScore * 30 +
      volumeScore * 25 +
      strengthScore * 20 +
      stabilityScore * 15 +
      accelScore * 10;

    return Math.round(Math.max(0, Math.min(100, finalScore)));
  }

  getRating(score) {
    if (score >= 80) return "STRONG_BUY";
    if (score >= 65) return "BUY";
    if (score >= 50) return "HOLD";
    return "SELL";
  }
}

const hqsEngine = new HQSEngine();

/* ================= ALPHA VANTAGE ================= */

async function fetchQuote(symbol) {
  const cacheKey = `quote_${symbol}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const response = await axios.get(
      "https://www.alphavantage.co/query",
      {
        params: {
          function: "GLOBAL_QUOTE",
          symbol,
          apikey: process.env.ALPHA_VANTAGE_API_KEY,
        },
        timeout: 10000,
      }
    );

    const q = response.data["Global Quote"];
    if (!q) return null;

    const result = {
      symbol: q["01. symbol"],
      price: parseFloat(q["05. price"]),
      changePercent: parseFloat(
        (q["10. change percent"] || "0").replace("%", "")
      ),
      volume: parseInt(q["06. volume"] || "0"),
      timestamp: new Date().toISOString(),
    };

    cache.set(cacheKey, result);
    return result;

  } catch (err) {
    console.error("AlphaVantage error:", err.message);
    return null;
  }
}

/* ================= ROUTES ================= */

app.get("/health", (req, res) => {
  res.json({ status: "healthy" });
});

/* ===== MARKET ===== */

app.get("/market", async (req, res) => {
  try {
    const symbols = ["AAPL", "MSFT", "GOOGL", "AMZN", "TSLA"];
    const stocks = [];

    for (const symbol of symbols) {
      const quote = await fetchQuote(symbol);
      if (!quote) continue;

      const score = hqsEngine.calculateScore({
        changePercent: quote.changePercent,
        volume: quote.volume,
      });

      // 🔐 Safe DB Insert
      try {
        await pool.query(
          `INSERT INTO hqs_history 
           (symbol, price, change_percent, volume, hqs_score) 
           VALUES ($1, $2, $3, $4, $5)`,
          [
            quote.symbol,
            quote.price,
            quote.changePercent,
            quote.volume,
            score,
          ]
        );
      } catch (dbErr) {
        console.error("DB insert failed:", dbErr.message);
      }

      stocks.push({
        symbol: quote.symbol,
        price: quote.price,
        changePercent: quote.changePercent,
        volume: quote.volume,
        hqsScore: score,
        hqsRating: hqsEngine.getRating(score),
        timestamp: quote.timestamp,
      });

      await new Promise((r) => setTimeout(r, 1200));
    }

    stocks.sort((a, b) => b.hqsScore - a.hqsScore);

    res.json({
      success: true,
      count: stocks.length,
      stocks,
    });

  } catch (err) {
    console.error("Market error:", err.message);
    res.status(500).json({ success: false });
  }
});

/* ===== HISTORY ===== */

app.get("/history/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();

    const result = await pool.query(
      `SELECT symbol, price, change_percent, volume, hqs_score, created_at
       FROM hqs_history
       WHERE symbol = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [symbol]
    );

    res.json({
      success: true,
      symbol,
      count: result.rows.length,
      history: result.rows,
    });

  } catch (err) {
    console.error("History error:", err.message);
    res.status(500).json({ success: false });
  }
});

/* ================= START ================= */

(async () => {
  await initDatabase();
  app.listen(PORT, () => {
    console.log("=================================");
    console.log("🚀 HQS Backend 3.1 Live");
    console.log("=================================");
  });
})();
