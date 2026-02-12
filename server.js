const express = require("express");
const cors = require("cors");
const axios = require("axios");
const NodeCache = require("node-cache");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 8080;

/* ================= API KEY CHECK ================= */

const API_KEY = process.env.ALPHA_VANTAGE_API_KEY;

if (!API_KEY) {
  console.error("❌ ALPHA_VANTAGE_API_KEY not set in environment!");
  process.exit(1);
}

console.log("🚀 HQS Backend 2.5 Starting...");
console.log("🔐 API Key loaded securely");

/* ================= MIDDLEWARE ================= */

app.use(cors());
app.use(express.json());

/* ================= CACHE ================= */

const cache = new NodeCache({ stdTTL: 300 });

/* ================= HQS ENGINE 2.5 ================= */

class HQSEngine {
  normalize(value, min, max) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, (value - min) / (max - min)));
  }

  calculateScore({ changePercent, volume }) {
    const avgVolume = 30000000;

    // 1️⃣ Intraday Momentum (30%)
    const intradayScore = this.normalize(changePercent, -3, 3);

    // 2️⃣ Relative Volume (25%)
    const relativeVolume = volume / avgVolume;
    const volumeScore = this.normalize(relativeVolume, 0.5, 2);

    // 3️⃣ Strength Bias (20%)
    const strengthScore =
      changePercent > 0
        ? this.normalize(changePercent, 0, 5)
        : 0.2;

    // 4️⃣ Stability (15%)
    const stabilityScore =
      changePercent < -3
        ? 0
        : changePercent < 0
        ? 0.3
        : 1;

    // 5️⃣ Acceleration (10%)
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
          apikey: API_KEY,
        },
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
    console.error(`AlphaVantage Error for ${symbol}:`, err.message);
    return null;
  }
}

/* ================= ROUTES ================= */

app.get("/", (req, res) => {
  res.json({
    system: "HQS Hyper-Quant",
    version: "2.5",
    status: "online",
    endpoints: ["/health", "/market", "/hqs/:symbol"],
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

/* ===== MARKET OVERVIEW ===== */

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

      stocks.push({
        symbol: quote.symbol,
        price: quote.price,
        changePercent: quote.changePercent,
        volume: quote.volume,
        hqsScore: score,
        hqsRating: hqsEngine.getRating(score),
        timestamp: quote.timestamp,
      });

      // AlphaVantage Free Limit Safety
      await new Promise((r) => setTimeout(r, 1200));
    }

    if (stocks.length === 0) {
      return res.status(503).json({
        success: false,
        message: "API rate limit reached",
      });
    }

    stocks.sort((a, b) => b.hqsScore - a.hqsScore);

    res.json({
      success: true,
      source: "Alpha Vantage API",
      timestamp: new Date().toISOString(),
      count: stocks.length,
      stocks,
    });

  } catch (err) {
    console.error("Market endpoint error:", err);
    res.status(500).json({
      success: false,
      error: "Internal Server Error",
    });
  }
});

/* ===== SINGLE STOCK ===== */

app.get("/hqs/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const quote = await fetchQuote(symbol);

    if (!quote) {
      return res.status(404).json({
        success: false,
        message: "Symbol not found or API limit reached",
      });
    }

    const score = hqsEngine.calculateScore({
      changePercent: quote.changePercent,
      volume: quote.volume,
    });

    res.json({
      success: true,
      symbol,
      price: quote.price,
      changePercent: quote.changePercent,
      volume: quote.volume,
      hqsScore: score,
      hqsRating: hqsEngine.getRating(score),
      timestamp: quote.timestamp,
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error: "Internal Server Error",
    });
  }
});

/* ===== 404 HANDLER ===== */

app.use((req, res) => {
  res.status(404).json({
    error: "Endpoint not found",
  });
});

/* ===== START SERVER ===== */

app.listen(PORT, () => {
  console.log("=================================");
  console.log("🚀 HQS Backend 2.5 Live");
  console.log(`📍 Port: ${PORT}`);
  console.log("=================================");
});
