const express = require("express");
const cors = require("cors");
const axios = require("axios");
const NodeCache = require("node-cache");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.ALPHA_VANTAGE_API_KEY;

if (!API_KEY) {
  console.error("❌ API Key missing");
  process.exit(1);
}

app.use(cors());
app.use(express.json());

const cache = new NodeCache({ stdTTL: 600 });

/* ================= INDICATOR FUNCTIONS ================= */

function calculateRSI(closes, period = 14) {
  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function movingAverage(data, period) {
  const slice = data.slice(0, period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function normalize(value, min, max) {
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

/* ================= FETCH DATA ================= */

async function fetchQuote(symbol) {
  const cacheKey = `quote_${symbol}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const response = await axios.get("https://www.alphavantage.co/query", {
    params: {
      function: "GLOBAL_QUOTE",
      symbol,
      apikey: API_KEY,
    },
  });

  const q = response.data["Global Quote"];
  if (!q) return null;

  const result = {
    price: parseFloat(q["05. price"]),
    changePercent: parseFloat(q["10. change percent"].replace("%", "")),
    volume: parseInt(q["06. volume"]),
  };

  cache.set(cacheKey, result);
  return result;
}

async function fetchDaily(symbol) {
  const cacheKey = `daily_${symbol}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const response = await axios.get("https://www.alphavantage.co/query", {
    params: {
      function: "TIME_SERIES_DAILY",
      symbol,
      apikey: API_KEY,
    },
  });

  const series = response.data["Time Series (Daily)"];
  if (!series) return null;

  const closes = Object.values(series)
    .slice(0, 30)
    .map(d => parseFloat(d["4. close"]));

  cache.set(cacheKey, closes);
  return closes;
}

/* ================= HQS 3.0 ================= */

function calculateHQS({ quote, closes }) {
  const momentum5 =
    ((closes[0] - closes[5]) / closes[5]) * 100;

  const ma20 = movingAverage(closes, 20);
  const trendScore = quote.price > ma20 ? 1 : 0;

  const rsi = calculateRSI(closes);
  const rsiScore = normalize(rsi, 30, 70);

  const relativeVolume = quote.volume / 30000000;
  const volumeScore = normalize(relativeVolume, 0.5, 2);

  const intradayScore = normalize(quote.changePercent, -3, 3);

  const finalScore =
    normalize(momentum5, -5, 10) * 30 +
    rsiScore * 20 +
    trendScore * 20 +
    volumeScore * 15 +
    intradayScore * 15;

  return Math.round(Math.max(0, Math.min(100, finalScore)));
}

/* ================= ROUTES ================= */

app.get("/market", async (req, res) => {
  try {
    const symbols = ["AAPL", "MSFT", "TSLA"]; // wegen API Limit
    const results = [];

    for (const symbol of symbols) {
      const quote = await fetchQuote(symbol);
      const closes = await fetchDaily(symbol);

      if (!quote || !closes) continue;

      const score = calculateHQS({ quote, closes });

      results.push({
        symbol,
        price: quote.price,
        changePercent: quote.changePercent,
        volume: quote.volume,
        hqsScore: score,
      });

      await new Promise(r => setTimeout(r, 12000)); // Rate Limit Safety
    }

    results.sort((a, b) => b.hqsScore - a.hqsScore);

    res.json({
      success: true,
      stocks: results,
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log("🚀 HQS 3.0 Running");
});
