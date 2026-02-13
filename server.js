// =====================================================
// HQS ENTERPRISE BACKEND v7 FINAL FIX
// =====================================================

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const NodeCache = require("node-cache");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 8080;

// ============================
// CONFIG
// ============================

const SYMBOLS = [
  "AAPL",
  "MSFT",
  "NVDA",
  "AMZN",
  "GOOGL",
  "META",
  "TSLA",
  "VTI",
  "QQQ",
  "IEMG"
];

const cache = new NodeCache({ stdTTL: 600 });

// VERY IMPORTANT: allow your domain
app.use(cors({
  origin: [
    "https://dhsystemhqs.de",
    "https://www.dhsystemhqs.de",
    "https://hqs-private-quant.vercel.app"
  ]
}));

app.use(express.json());

// ============================
// HEALTH CHECK
// ============================

app.get("/", (req, res) => {
  res.json({
    success: true,
    system: "HQS Enterprise Backend",
    version: "7.0 FINAL",
    status: "Running"
  });
});

// ============================
// HELPERS
// ============================

function classifyMarketCap(marketCap) {
  if (!marketCap) return "Unknown";
  if (marketCap >= 200_000_000_000) return "Large Cap";
  if (marketCap >= 10_000_000_000) return "Mid Cap";
  return "Small Cap";
}

function calculateHQS(data) {
  let score = 50;

  const changePercent = data.regularMarketChangePercent || 0;
  const marketCap = data.marketCap || 0;
  const volume = data.regularMarketVolume || 0;
  const avgVolume = data.averageDailyVolume3Month || 1;

  if (changePercent > 2) score += 15;
  if (changePercent > 5) score += 10;
  if (changePercent < -2) score -= 10;

  if (marketCap > 500_000_000_000) score += 10;
  if (marketCap > 1_000_000_000_000) score += 5;

  if (volume > avgVolume) score += 10;

  return Math.max(0, Math.min(100, score));
}

function getRating(score) {
  if (score >= 85) return "Strong Buy";
  if (score >= 70) return "Buy";
  if (score >= 55) return "Neutral";
  if (score >= 40) return "Weak";
  return "Sell";
}

// ============================
// MARKET ENDPOINT
// ============================

app.get("/market", async (req, res) => {
  try {

    const cached = cache.get("marketData");
    if (cached) {
      return res.json({
        success: true,
        source: "cache",
        stocks: cached
      });
    }

    const requests = SYMBOLS.map(symbol =>
      axios.get(
        `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbol}`,
        { timeout: 8000 }
      )
    );

    const responses = await Promise.all(requests);

    const stocks = responses
      .map(response => {

        const result = response.data?.quoteResponse?.result;

        if (!result || result.length === 0) return null;

        const data = result[0];
        const score = calculateHQS(data);

        return {
          symbol: data.symbol,
          name: data.shortName,
          price: data.regularMarketPrice,
          changePercent: data.regularMarketChangePercent,
          marketCap: data.marketCap,
          volume: data.regularMarketVolume,
          capCategory: classifyMarketCap(data.marketCap),
          hqsScore: score,
          rating: getRating(score)
        };

      })
      .filter(Boolean)
      .sort((a, b) => b.hqsScore - a.hqsScore);

    cache.set("marketData", stocks);

    res.json({
      success: true,
      source: "live",
      stocks
    });

  } catch (error) {

    console.error(error.message);

    res.status(500).json({
      success: false,
      message: "Market fetch error"
    });

  }
});

// ============================
// START SERVER
// ============================

app.listen(PORT, () => {
  console.log("HQS Backend running on port", PORT);
});
