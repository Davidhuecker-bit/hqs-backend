// =====================================================
// HQS ENTERPRISE BACKEND v9
// Financial Modeling Prep integriert (Yahoo entfernt)
// Railway kompatibel
// =====================================================

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const NodeCache = require("node-cache");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT) || 8080;

// ============================
// CONFIG
// ============================

const SYMBOLS = (process.env.SYMBOLS ||
  "AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,VTI,QQQ,IEMG")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const API_KEY = process.env.FMP_API_KEY;

if (!API_KEY) {
  console.error("FMP_API_KEY fehlt in Railway Variables");
}

const BASE_URL = "https://financialmodelingprep.com/stable";

const REQUEST_TIMEOUT_MS = 8000;
const CACHE_TTL_SECONDS = 600;
const LAST_KNOWN_GOOD_TTL_SECONDS = 86400;

const cache = new NodeCache({
  stdTTL: CACHE_TTL_SECONDS,
  useClones: false,
});

app.use(cors());
app.use(express.json());

// ============================
// HEALTH
// ============================

app.get("/", (req, res) => {
  res.json({
    success: true,
    system: "HQS Enterprise Backend",
    version: "9.0",
    provider: "Financial Modeling Prep",
    status: "Running",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
  });
});

// ============================
// HELPERS
// ============================

function classifyMarketCap(marketCap) {
  if (!Number.isFinite(marketCap)) return "Unknown";
  if (marketCap >= 200_000_000_000) return "Large Cap";
  if (marketCap >= 10_000_000_000) return "Mid Cap";
  return "Small Cap";
}

function calculateHQS(data) {

  let score = 50;

  const changePercent = Number(data.changesPercentage || 0);
  const marketCap = Number(data.marketCap || 0);
  const volume = Number(data.volume || 0);
  const avgVolume = Number(data.avgVolume || 1);

  if (changePercent > 2) score += 15;
  if (changePercent > 5) score += 10;
  if (changePercent < -2) score -= 10;

  if (marketCap > 500_000_000_000) score += 10;
  if (marketCap > 1_000_000_000_000) score += 5;

  if (volume > avgVolume) score += 10;

  score = Math.max(0, Math.min(100, score));

  return Math.round(score);
}

function getRating(score) {
  if (score >= 85) return "Strong Buy";
  if (score >= 70) return "Buy";
  if (score >= 55) return "Neutral";
  if (score >= 40) return "Weak";
  return "Sell";
}

// ============================
// FETCH FROM FMP
// ============================

async function fetchQuote(symbol) {

  const url = `${BASE_URL}/quote?symbol=${symbol}&apikey=${API_KEY}`;

  const response = await axios.get(url, {
    timeout: REQUEST_TIMEOUT_MS
  });

  const item = response.data?.[0];

  if (!item) return null;

  const score = calculateHQS(item);

  return {

    symbol: item.symbol,

    name: item.name,

    price: item.price,

    change: item.change,

    changePercent: item.changesPercentage,

    marketCap: item.marketCap,

    volume: item.volume,

    capCategory: classifyMarketCap(item.marketCap),

    hqsScore: score,

    rating: getRating(score)

  };

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

    const results = await Promise.allSettled(
      SYMBOLS.map(fetchQuote)
    );

    const stocks = results
      .filter(r => r.status === "fulfilled" && r.value)
      .map(r => r.value)
      .sort((a, b) => b.hqsScore - a.hqsScore);

    if (stocks.length === 0) {

      return res.status(500).json({

        success: false,

        message: "Keine Marktdaten verfügbar"

      });

    }

    cache.set("marketData", stocks);

    cache.set("lastKnownGood", stocks, LAST_KNOWN_GOOD_TTL_SECONDS);

    res.json({

      success: true,

      source: "Financial Modeling Prep",

      count: stocks.length,

      stocks

    });

  }
  catch (error) {

    console.error("FMP ERROR:", error.message);

    res.status(500).json({

      success: false,

      message: "API Fehler"

    });

  }

});

// ============================
// ERROR HANDLER
// ============================

app.use((err, req, res, next) => {

  console.error(err);

  res.status(500).json({

    success: false,

    message: "Internal Server Error"

  });

});

// ============================
// START
// ============================

app.listen(PORT, () => {

  console.log("HQS Backend läuft auf Port", PORT);

});
