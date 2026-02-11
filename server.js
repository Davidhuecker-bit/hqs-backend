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

console.log("🚀 HQS Backend Starting...");
console.log("🔐 API Key loaded securely");

/* ================= MIDDLEWARE ================= */

app.use(cors());
app.use(express.json());

/* ================= CACHE ================= */

const cache = new NodeCache({ stdTTL: 300 });

/* ================= HQS ENGINE ================= */

class HQSEngine {
  calculateScore(changePercent, volume) {
    let score = 50;

    if (changePercent > 2) score += 15;
    else if (changePercent > 0) score += 5;
    else if (changePercent < -2) score -= 15;

    if (volume > 50000000) score += 10;

    return Math.max(0, Math.min(100, score));
  }

  getRating(score) {
    if (score >= 75) return "STRONG_BUY";
    if (score >= 65) return "BUY";
    if (score >= 55) return "HOLD";
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

    if (!response.data["Global Quote"]) return null;

    const q = response.data["Global Quote"];

    const result = {
      symbol: q["01. symbol"],
      price: parseFloat(q["05. price"]),
      changePercent: parseFloat(
        q["10. change percent"].replace("%", "")
      ),
      volume: parseInt(q["06. volume"]),
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
    version: "5.0",
    status: "online",
    apiConfigured: true,
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

      const score = hqsEngine.calculateScore(
        quote.changePercent,
        quote.volume
      );

      stocks.push({
        symbol: quote.symbol,
        price: quote.price,
        changePercent: quote.changePercent,
        volume: quote.volume,
        hqsScore: score,
        hqsRating: hqsEngine.getRating(score),
        timestamp: quote.timestamp,
      });

      // Alpha Vantage Free Plan Safety (5 calls/min)
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

    const score = hqsEngine.calculateScore(
      quote.changePercent,
      quote.volume
    );

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
  console.log("🚀 HQS Backend Live");
  console.log(`📍 Port: ${PORT}`);
  console.log("=================================");
});
