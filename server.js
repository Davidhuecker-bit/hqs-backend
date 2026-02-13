// =====================================================
// HQS ENTERPRISE BACKEND v8
// Stable, Railway-kompatibel, ohne await/Syntax-Fehler
// =====================================================

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const NodeCache = require("node-cache");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT) || 8080;

// ============================
// KONFIGURATION
// ============================
const SYMBOLS = (process.env.SYMBOLS ||
  "AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,VTI,QQQ,IEMG")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const REQUEST_TIMEOUT_MS = Number(process.env.MARKET_TIMEOUT_MS) || 8000;
const CACHE_TTL_SECONDS = Number(process.env.MARKET_CACHE_TTL_SECONDS) || 600; // 10 min
const LAST_KNOWN_GOOD_TTL_SECONDS =
  Number(process.env.MARKET_LAST_GOOD_TTL_SECONDS) || 86400; // 24h

const cache = new NodeCache({
  stdTTL: CACHE_TTL_SECONDS,
  useClones: false,
});

app.use(cors());
app.use(express.json());

// ============================
// HEALTH CHECK
// ============================
app.get("/", (req, res) => {
  res.json({
    success: true,
    system: "HQS Enterprise Backend",
    version: "8.0",
    status: "Running",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ============================
// HELPERS
// ============================
function classifyMarketCap(marketCap) {
  if (!Number.isFinite(marketCap) || marketCap <= 0) return "Unknown";
  if (marketCap >= 200_000_000_000) return "Large Cap";
  if (marketCap >= 10_000_000_000) return "Mid Cap";
  return "Small Cap";
}

function calculateHQS(data) {
  let score = 50;

  const changePercent = Number(data.regularMarketChangePercent || 0);
  const marketCap = Number(data.marketCap || 0);
  const volume = Number(data.regularMarketVolume || 0);
  const avgVolume = Number(data.averageDailyVolume3Month || 1);

  // Momentum
  if (changePercent > 2) score += 15;
  if (changePercent > 5) score += 10;
  if (changePercent < -2) score -= 10;

  // Groesse/Stabilitaet
  if (marketCap > 500_000_000_000) score += 10;
  if (marketCap > 1_000_000_000_000) score += 5;

  // Volumen-Dynamik
  if (volume > avgVolume) score += 10;

  // Clamp 0..100
  if (score > 100) score = 100;
  if (score < 0) score = 0;

  return Math.round(score);
}

function getRating(score) {
  if (score >= 85) return "Strong Buy";
  if (score >= 70) return "Buy";
  if (score >= 55) return "Neutral";
  if (score >= 40) return "Weak";
  return "Sell";
}

async function fetchQuoteForSymbol(symbol) {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;

  const response = await axios.get(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json",
    },
    timeout: REQUEST_TIMEOUT_MS,
  });

  const item = response.data?.quoteResponse?.result?.[0];
  if (!item) return null;

  const hqsScore = calculateHQS(item);

  return {
    symbol: item.symbol || symbol,
    name: item.shortName || item.longName || symbol,
    type: item.quoteType || "UNKNOWN",
    price: Number(item.regularMarketPrice || 0),
    change: Number(item.regularMarketChange || 0),
    changePercent: Number(item.regularMarketChangePercent || 0),
    marketCap: Number(item.marketCap || 0),
    volume: Number(item.regularMarketVolume || 0),
    capCategory: classifyMarketCap(Number(item.marketCap || 0)),
    hqsScore,
    rating: getRating(hqsScore),
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
        count: cached.length,
        failedSymbols: 0,
        stocks: cached,
      });
    }

    const settled = await Promise.allSettled(
      SYMBOLS.map((symbol) => fetchQuoteForSymbol(symbol))
    );

    const stocks = settled
      .filter((entry) => entry.status === "fulfilled" && entry.value)
      .map((entry) => entry.value)
      .sort((a, b) => b.hqsScore - a.hqsScore);

    const failedSymbols = settled.filter(
      (entry) => entry.status === "rejected" || !entry.value
    ).length;

    if (stocks.length === 0) {
      const lastKnownGood = cache.get("lastKnownGood");
      if (lastKnownGood && Array.isArray(lastKnownGood) && lastKnownGood.length > 0) {
        return res.json({
          success: true,
          source: "stale-cache",
          stale: true,
          count: lastKnownGood.length,
          failedSymbols: SYMBOLS.length,
          notice:
            "Live-Marktdaten sind aktuell nicht erreichbar. Letzte verfuegbare Daten werden angezeigt.",
          stocks: lastKnownGood,
        });
      }

      return res.status(502).json({
        success: false,
        message: "Keine gueltigen Marktdaten verfuegbar",
        failedSymbols: SYMBOLS.length,
      });
    }

    cache.set("marketData", stocks);
    cache.set("lastKnownGood", stocks, LAST_KNOWN_GOOD_TTL_SECONDS);

    return res.json({
      success: true,
      source: "Yahoo Finance",
      count: stocks.length,
      failedSymbols,
      stocks,
    });
  } catch (error) {
    console.error("MARKET ERROR:", error.response?.data || error.message);

    const lastKnownGood = cache.get("lastKnownGood");
    if (lastKnownGood && Array.isArray(lastKnownGood) && lastKnownGood.length > 0) {
      return res.json({
        success: true,
        source: "stale-cache",
        stale: true,
        count: lastKnownGood.length,
        notice:
          "Live-Marktdaten sind aktuell nicht erreichbar. Letzte verfuegbare Daten werden angezeigt.",
        stocks: lastKnownGood,
      });
    }

    return res.status(500).json({
      success: false,
      message: "Fehler beim Laden der Marktdaten",
    });
  }
});

// ============================
// GLOBAL ERROR HANDLER
// ============================
app.use((err, req, res, next) => {
  console.error("GLOBAL ERROR:", err.stack || err.message);
  res.status(500).json({
    success: false,
    message: "Internal Server Error",
  });
});

// ============================
// START SERVER
// ============================
app.listen(PORT, () => {
  console.log(`HQS Enterprise laeuft auf Port ${PORT}`);
});
