const express = require("express");
const cors = require("cors");
const axios = require("axios");
const NodeCache = require("node-cache");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 8080;

const API_KEY = process.env.ALPHA_VANTAGE_API_KEY;

if (!API_KEY) {
  console.error("❌ ALPHA_VANTAGE_API_KEY not set!");
  process.exit(1);
}

app.use(cors());
app.use(express.json());

const cache = new NodeCache({ stdTTL: 300 });

/* ================= HQS ENGINE 2.0 ================= */

class HQSEngine {
  normalize(value, min, max) {
    return Math.max(0, Math.min(1, (value - min) / (max - min)));
  }

  calculateScore({ changePercent, volume }) {
    const avgVolume = 30000000;

    const momentumScore = this.normalize(changePercent, -5, 5);
    const relativeVolume = volume / avgVolume;
    const volumeScore = this.normalize(relativeVolume, 0.5, 2);
    const strengthScore = this.normalize(changePercent, -2, 3);

    const stabilityScore =
      changePercent < 0
        ? 0.3
        : this.normalize(changePercent, 0, 3);

    const finalScore =
      momentumScore * 35 +
      volumeScore * 25 +
      strengthScore * 20 +
      stabilityScore * 20;

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
    console.error(`AlphaVantage error ${symbol}:`, err.message);
    return null;
  }
}

/* ================= ROUTES ================= */

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

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
        ...quote,
        hqsScore: score,
        hqsRating: hqsEngine.getRating(score),
      });

      await new Promise((r) => setTimeout(r, 1200));
    }

    stocks.sort((a, b) => b.hqsScore - a.hqsScore);

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      count: stocks.length,
      stocks,
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error: "Internal Server Error",
    });
  }
});

app.get("/hqs/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const quote = await fetchQuote(symbol);

    if (!quote) {
      return res.status(404).json({
        success: false,
        message: "Symbol not found",
      });
    }

    const score = hqsEngine.calculateScore({
      changePercent: quote.changePercent,
      volume: quote.volume,
    });

    res.json({
      success: true,
      ...quote,
      hqsScore: score,
      hqsRating: hqsEngine.getRating(score),
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error: "Internal Server Error",
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 HQS Backend running on port ${PORT}`);
});
