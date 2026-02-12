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

/* ================= CACHE =================
   quotes: kurz (5 min)
   daily: lang  (6h) -> spart massiv API calls
=========================================== */
const cache = new NodeCache({ stdTTL: 300 });

/* ================= ALPHA VANTAGE RATE LIMITER =================
   Free Plan: 5 calls/min. Wir erzwingen ~13s Abstand pro API call.
=============================================================== */
let lastAvCallAt = 0;
async function avCall(fn) {
  const minDelay = 13000; // 13s
  const now = Date.now();
  const wait = Math.max(0, minDelay - (now - lastAvCallAt));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const result = await fn();
  lastAvCallAt = Date.now();
  return result;
}

/* ================= INDICATORS ================= */
function normalize(value, min, max) {
  if (!Number.isFinite(value)) return 0;
  if (max === min) return 0;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

// closesChrono: [oldest ... newest]
function calculateRSI(closesChrono, period = 14) {
  if (!Array.isArray(closesChrono) || closesChrono.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  // nur die letzten period+1 Werte verwenden
  const slice = closesChrono.slice(-(period + 1));

  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function movingAverage(closesChrono, period = 20) {
  if (!Array.isArray(closesChrono) || closesChrono.length < period) return null;
  const slice = closesChrono.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/* ================= FETCHERS ================= */
async function fetchQuote(symbol) {
  const cacheKey = `quote_${symbol}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const response = await avCall(() =>
      axios.get("https://www.alphavantage.co/query", {
        params: {
          function: "GLOBAL_QUOTE",
          symbol,
          apikey: API_KEY,
        },
      })
    );

    const q = response.data?.["Global Quote"];
    if (!q) return null;

    const result = {
      symbol: q["01. symbol"],
      price: parseFloat(q["05. price"]),
      changePercent: parseFloat(String(q["10. change percent"] || "0").replace("%", "")) || 0,
      volume: parseInt(q["06. volume"] || "0", 10) || 0,
      timestamp: new Date().toISOString(),
    };

    cache.set(cacheKey, result, 300);
    return result;
  } catch (err) {
    console.error(`AlphaVantage Error (GLOBAL_QUOTE) ${symbol}:`, err.message);
    return null;
  }
}

async function fetchDaily(symbol) {
  const cacheKey = `daily_${symbol}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const response = await avCall(() =>
      axios.get("https://www.alphavantage.co/query", {
        params: {
          function: "TIME_SERIES_DAILY",
          symbol,
          apikey: API_KEY,
        },
      })
    );

    const series = response.data?.["Time Series (Daily)"];
    if (!series) return null;

    // Dates sauber sortieren (neu -> alt)
    const datesDesc = Object.keys(series).sort((a, b) => (a < b ? 1 : -1));

    // wir nehmen 60 Tage für stabile Indikatoren
    const points = datesDesc.slice(0, 60).map((d) => ({
      date: d,
      close: parseFloat(series[d]["4. close"]),
      volume: parseInt(series[d]["5. volume"] || "0", 10) || 0,
    }));

    // Chronologisch (alt -> neu) für RSI/MA
    const pointsChrono = [...points].reverse();

    const result = {
      closesChrono: pointsChrono.map((p) => p.close),
      volumesChrono: pointsChrono.map((p) => p.volume),
      latestClose: points[0]?.close,
      close5dAgo: points[5]?.close, // 5 Handelstage zurück (approx)
      avgVol20: pointsChrono.slice(-20).reduce((a, p) => a + p.volume, 0) / Math.max(1, pointsChrono.slice(-20).length),
    };

    // daily lange cachen (6h)
    cache.set(cacheKey, result, 21600);
    return result;
  } catch (err) {
    console.error(`AlphaVantage Error (DAILY) ${symbol}:`, err.message);
    return null;
  }
}

/* ================= HQS 3.0 ENGINE =================
   Faktoren:
   - 5D Momentum (30)
   - RSI (20)
   - Trend: Price vs MA20 (20)
   - Relative Volume vs AvgVol20 (15)
   - Intraday Move (15)
===================================================== */
class HQSEngine {
  calculateScore({ quote, daily }) {
    const price = quote.price;
    const changePercent = quote.changePercent;
    const volume = quote.volume;

    const { closesChrono, latestClose, close5dAgo, avgVol20 } = daily;

    // 1) 5D Momentum
    let mom5 = null;
    if (Number.isFinite(latestClose) && Number.isFinite(close5dAgo) && close5dAgo !== 0) {
      mom5 = ((latestClose - close5dAgo) / close5dAgo) * 100;
    }
    const momScore = normalize(mom5, -7, 12); // -7%..+12%

    // 2) RSI
    const rsi = calculateRSI(closesChrono, 14);
    // ideal grob 45-65; zu hoch = überhitzt, zu niedrig = schwach
    let rsiScore = 0.5;
    if (rsi !== null) {
      // map 30..70 auf 0..1, außerhalb clamp
      rsiScore = normalize(rsi, 30, 70);
    }

    // 3) Trend vs MA20
    const ma20 = movingAverage(closesChrono, 20);
    const trendScore = ma20 ? (price >= ma20 ? 1 : 0) : 0.5;

    // 4) Relative Volume (heute vs avgVol20)
    const relVol = avgVol20 && avgVol20 > 0 ? volume / avgVol20 : null;
    const volScore = normalize(relVol, 0.6, 2.2);

    // 5) Intraday Move
    const intraScore = normalize(changePercent, -3, 3);

    const final =
      momScore * 30 +
      rsiScore * 20 +
      trendScore * 20 +
      volScore * 15 +
      intraScore * 15;

    const score = Math.round(Math.max(0, Math.min(100, final)));

    return { score, mom5, rsi, ma20, relVol };
  }

  getRating(score) {
    if (score >= 80) return "STRONG_BUY";
    if (score >= 65) return "BUY";
    if (score >= 50) return "HOLD";
    return "SELL";
  }
}

const hqsEngine = new HQSEngine();

/* ================= ROUTES ================= */
app.get("/", (req, res) => {
  res.json({
    system: "HQS Hyper-Quant",
    version: "6.0 (HQS 3.0 Engine)",
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
    // Tipp: Bei Free Plan lieber 3-6 Symbole. Daily ist gecached (6h).
    const symbols = ["AAPL", "MSFT", "GOOGL", "AMZN", "TSLA"];

    const stocks = [];

    for (const symbol of symbols) {
      const quote = await fetchQuote(symbol);
      if (!quote) continue;

      const daily = await fetchDaily(symbol);
      if (!daily) continue;

      const details = hqsEngine.calculateScore({ quote, daily });

      stocks.push({
        symbol: quote.symbol,
        price: quote.price,
        changePercent: quote.changePercent,
        volume: quote.volume,
        hqsScore: details.score,
        hqsRating: hqsEngine.getRating(details.score),
        // Debug/Transparenz (kannst du später ausblenden)
        indicators: {
          mom5: details.mom5,
          rsi: details.rsi,
          ma20: details.ma20,
          relVol: details.relVol,
        },
        timestamp: quote.timestamp,
      });
    }

    if (stocks.length === 0) {
      return res.status(503).json({
        success: false,
        message: "No data (API limit or upstream issue)",
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

    const daily = await fetchDaily(symbol);
    if (!daily) {
      return res.status(503).json({
        success: false,
        message: "Daily data unavailable (API limit or upstream issue)",
      });
    }

    const details = hqsEngine.calculateScore({ quote, daily });
    const score = details.score;

    res.json({
      success: true,
      symbol,
      price: quote.price,
      changePercent: quote.changePercent,
      volume: quote.volume,
      hqsScore: score,
      hqsRating: hqsEngine.getRating(score),
      indicators: {
        mom5: details.mom5,
        rsi: details.rsi,
        ma20: details.ma20,
        relVol: details.relVol,
      },
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
  res.status(404).json({ error: "Endpoint not found" });
});

/* ===== START SERVER ===== */
app.listen(PORT, () => {
  console.log("=================================");
  console.log("🚀 HQS Backend Live");
  console.log(`📍 Port: ${PORT}`);
  console.log("=================================");
});
