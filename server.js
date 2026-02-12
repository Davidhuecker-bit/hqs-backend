// =====================================================
// HQS ENTERPRISE BACKEND v7
// Vollständig stabil – Railway kompatibel
// Mit HQS Score, Ranking, Cap-Klassifizierung, ETF Support
// =====================================================

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const NodeCache = require("node-cache");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 8080;

// ============================
// KONFIGURATION
// ============================

// Einzelaktien + ETFs
const SYMBOLS = [
  "AAPL",
  "MSFT",
  "NVDA",
  "AMZN",
  "GOOGL",
  "META",
  "TSLA",
  "VTI",   // ETF
  "QQQ",   // ETF
  "IEMG"   // Emerging Markets ETF
];

const cache = new NodeCache({ stdTTL: 600 }); // 10 Minuten Cache

app.use(cors());
app.use(express.json());

// ============================
// HEALTH CHECK
// ============================
app.get("/", (req, res) => {
  res.json({
    success: true,
    system: "HQS Enterprise Backend",
    version: "7.0",
    status: "Running",
    timestamp: new Date()
  });
});

// ============================
// MARKET CAP KLASSIFIZIERUNG
// ============================
function classifyMarketCap(marketCap) {
  if (!marketCap) return "Unknown";
  if (marketCap >= 200_000_000_000) return "Large Cap";
  if (marketCap >= 10_000_000_000) return "Mid Cap";
  return "Small Cap";
}

// ============================
// HQS SCORE ENGINE
// ============================
function calculateHQS(data) {
  let score = 50;

  const changePercent = data.regularMarketChangePercent || 0;
  const marketCap = data.marketCap || 0;
  const volume = data.regularMarketVolume || 0;
  const avgVolume = data.averageDailyVolume3Month || 1;

  // Momentum
  if (changePercent > 2) score += 15;
  if (changePercent > 5) score += 10;
  if (changePercent < -2) score -= 10;

  // Größe / Stabilität
  if (marketCap > 500_000_000_000) score += 10;
  if (marketCap > 1_000_000_000_000) score += 5;

  // Volumen Dynamik
  if (volume > avgVolume) score += 10;

  // Begrenzung
  if (score > 100) score = 100;
  if (score < 0) score = 0;

  return score;
}

// ============================
// RATING LOGIK
// ============================
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
        count: cached.length,
        stocks: cached
      });
    }

    const requests = SYMBOLS.map(symbol =>
      axios.get(
        `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbol}`,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Accept": "application/json"
          },
          timeout: 8000
        }
      )
    );

    const responses = await Promise.all(requests);

    const stocks = responses
      .map(response => {
        const result = response.data?.quoteResponse?.result;
        if (!result || result.length === 0) return null;

        const data = result[0];
        const hqsScore = calculateHQS(data);

        return {
          symbol: data.symbol,
          name: data.shortName,
          type: data.quoteType,
          price: data.regularMarketPrice,
          change: data.regularMarketChange,
          changePercent: data.regularMarketChangePercent,
          marketCap: data.marketCap,
          volume: data.regularMarketVolume,
          capCategory: classifyMarketCap(data.marketCap),
          hqsScore,
          rating: getRating(hqsScore)
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.hqsScore - a.hqsScore);

    cache.set("marketData", stocks);

    res.json({
      success: true,
      source: "Yahoo Finance",
      count: stocks.length,
      stocks
    });

  } catch (error) {
    console.error("MARKET ERROR:", error.response?.data || error.message);

    res.status(500).json({
      success: false,
      message: "Fehler beim Laden der Marktdaten"
    });
  }
});

    const requests = SYMBOLS.map(symbol =>
      axios.get(
        `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbol}`
      )
    );

    const responses = await Promise.all(requests);

    const stocks = responses
      .map(response => {
        const result = response.data?.quoteResponse?.result;
        if (!result || result.length === 0) return null;

        const data = result[0];
        const hqsScore = calculateHQS(data);

        return {
          symbol: data.symbol,
          name: data.shortName,
          type: data.quoteType, // EQUITY / ETF
          price: data.regularMarketPrice,
          change: data.regularMarketChange,
          changePercent: data.regularMarketChangePercent,
          marketCap: data.marketCap,
          volume: data.regularMarketVolume,
          capCategory: classifyMarketCap(data.marketCap),
          hqsScore,
          rating: getRating(hqsScore)
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.hqsScore - a.hqsScore);

    cache.set("marketData", stocks);

    res.json({
      success: true,
      source: "Yahoo Finance",
      count: stocks.length,
      stocks
    });
  } catch (error) {
    console.error("MARKET ERROR:", error.message);

    res.status(500).json({
      success: false,
      message: "Fehler beim Laden der Marktdaten"
    });
  }
});

// ============================
// GLOBAL ERROR HANDLER
// ============================
app.use((err, req, res, next) => {
  console.error("GLOBAL ERROR:", err.stack);
  res.status(500).json({
    success: false,
    message: "Internal Server Error"
  });
});

// ============================
// START SERVER
// ============================
app.listen(PORT, () => {
  console.log(`🚀 HQS Enterprise läuft auf Port ${PORT}`);
});
