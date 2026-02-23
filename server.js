const express = require("express");
const cors = require("cors");
require("dotenv").config();

// Services laden
const { getMarketData, buildMarketSnapshot } = require("./services/marketService");
const { analyzeStockWithGuardian } = require("./services/guardianService"); 
const {
  parseSymbolsQuery,
  buildGuardianPayload,
  buildMarketNewsPayload,
  buildInsiderSignalPayload,
} = require("./services/frontendAdapter.service");

const app = express();
const PORT = process.env.PORT || 8080;

// ==========================================================
// 🛡️ CORS EINSTELLUNGEN
// ==========================================================
// Erlaubt Anfragen von deinem Dashboard und lokalen Tests
app.use(cors({
  origin: [
    "https://dhsystemhqs.de",
    "https://www.dhsystemhqs.de",
    "https://hqs-frontend-v8.vercel.app", // Falls du noch über Vercel-Domains testest
    "http://localhost:3000"
  ],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());

async function loadStocksBySymbols(symbols) {
  const rows = await Promise.all(
    symbols.map(async (symbol) => {
      const results = await getMarketData(symbol);
      return Array.isArray(results) && results[0] ? results[0] : null;
    }),
  );
  return rows.filter(Boolean);
}

function mapStocksBySymbol(stocks) {
  const symbolMap = {};
  stocks.forEach((stock) => {
    if (!stock || typeof stock !== "object") return;
    const symbol = String(stock.symbol || "").trim().toUpperCase();
    if (!symbol) return;
    symbolMap[symbol] = stock;
  });
  return symbolMap;
}

// ==========================================================
// 🧠 GUARDIAN AI ROUTE (Gemini Integration)
// ==========================================================
// Nutzt den GOOGLE_GEMINI_API_KEY aus Railway
app.get(["/guardian/analyze/:ticker", "/api/guardian/analyze/:ticker"], async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    console.log(`🛡️ Guardian: Starte KI-Analyse für ${ticker}...`);
    
    const analysis = await analyzeStockWithGuardian(ticker);
    
    res.json({
      success: true,
      ticker: ticker,
      timestamp: new Date().toISOString(),
      analysis: analysis
    });
  } catch (error) {
    console.error("Guardian Fehler:", error.message);
    res.status(500).json({
      success: false,
      message: "Guardian Analyse fehlgeschlagen. Bitte GOOGLE_GEMINI_API_KEY in Railway prüfen.",
      error: error.message
    });
  }
});

// ==========================================================
// 🧠 GUARDIAN SNAPSHOT ROUTE (Frontend Contract)
// ==========================================================
app.get(["/guardian", "/api/guardian"], async (req, res) => {
  try {
    const hasSymbolsQuery =
      typeof req.query.symbols === "string" && req.query.symbols.trim().length > 0;
    const generatedAt = new Date().toISOString();
    let stocks = [];

    if (hasSymbolsQuery) {
      const symbols = parseSymbolsQuery(req.query.symbols);
      stocks = await loadStocksBySymbols(symbols);
    } else {
      stocks = await getMarketData();
    }

    const payload = buildGuardianPayload(stocks, { generatedAt });
    res.json(payload);
  } catch (error) {
    console.error("Guardian Snapshot Fehler:", error.message);
    const fallbackPayload = buildGuardianPayload([], { generatedAt: new Date().toISOString() });
    res.json({
      ...fallbackPayload,
      degraded: true,
      message: "Guardian Snapshot mit Fallback-Daten geladen.",
    });
  }
});

// ==========================================================
// 📊 MARKET ROUTE (Jetzt via FINSHEET)
// ==========================================================
app.get(["/market", "/api/market"], async (req, res) => {
  try {
    const symbol =
      typeof req.query.symbol === "string" ? req.query.symbol.trim().toUpperCase() : "";
    const stockData = await getMarketData(symbol || undefined);
    
    res.json({ 
      success: true, 
      source: "Finnhub + HQS Engine",
      stocks: stockData 
    });
  } catch (error) {
    console.error("Market Fehler:", error.message);
    res.status(500).json({
      success: false,
      message: "Marktdaten-Abfrage über Finsheet fehlgeschlagen.",
      error: error.message
    });
  }
});

// ==========================================================
// 🔥 HQS ENGINE ROUTE (Berechnung & Scores)
// ==========================================================
app.get(["/hqs", "/api/hqs"], async (req, res) => {
  try {
    const symbol =
      typeof req.query.symbol === "string" ? req.query.symbol.trim().toUpperCase() : "";
    if (!symbol) return res.status(400).json({ success: false, message: "Symbol fehlt." });

    // Holt Daten inklusive HQS-Scores
    const marketData = await getMarketData(symbol.toUpperCase());
    if (!Array.isArray(marketData) || marketData.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Keine Daten für ${symbol} gefunden.`,
      });
    }

    res.json({ success: true, data: marketData[0] });
  } catch (error) {
    console.error("HQS Fehler:", error.message);
    res.status(500).json({ success: false, message: "HQS Berechnung fehlgeschlagen." });
  }
});

// ==========================================================
// 🗞️ MARKET NEWS ROUTE (Frontend Contract)
// ==========================================================
app.get("/api/market-news", async (req, res) => {
  try {
    const symbols = parseSymbolsQuery(req.query.symbols);
    const stocks = await loadStocksBySymbols(symbols);
    const payload = buildMarketNewsPayload(
      symbols,
      mapStocksBySymbol(stocks),
      new Date().toISOString(),
    );
    res.json(payload);
  } catch (error) {
    console.error("Market News Fehler:", error.message);
    res.json({
      ...buildMarketNewsPayload(parseSymbolsQuery(req.query.symbols)),
      degraded: true,
      message: "News-Fallback aktiv.",
    });
  }
});

// ==========================================================
// 🕵️ INSIDER SIGNAL ROUTE (Frontend Contract)
// ==========================================================
app.get("/api/insider-signal", async (req, res) => {
  try {
    const symbols = parseSymbolsQuery(req.query.symbols);
    const stocks = await loadStocksBySymbols(symbols);
    const payload = buildInsiderSignalPayload(
      symbols,
      mapStocksBySymbol(stocks),
      new Date().toISOString(),
    );
    res.json(payload);
  } catch (error) {
    console.error("Insider Signal Fehler:", error.message);
    res.json({
      ...buildInsiderSignalPayload(parseSymbolsQuery(req.query.symbols)),
      degraded: true,
      message: "Insider-Fallback aktiv.",
    });
  }
});

// ==========================================================
// ⚙️ STATUS & ADMIN BEREICH
// ==========================================================
app.get(["/admin-bypass-status", "/api/admin-bypass-status"], (req, res) => {
  res.json({ 
    active: true, 
    mode: "HQS AI Hybrid Online", 
    engine: "Finsheet Optimized",
    guardian: "Integrated (Gemini 1.5)",
    fallbacks: "Active (Data from 17.02.2026)" 
  });
});

// ==========================================================
// 🚀 SERVER START
// ==========================================================
app.listen(PORT, async () => {
  console.log(`🚀 HQS Backend aktiv auf Port ${PORT}`);
  console.log(`📡 Nutze FINSHEET_API_KEY für Marktdaten`);
  
  try {
    await buildMarketSnapshot();
  } catch (err) {
    console.error("Initial Snapshot Fehler:", err.message);
  }
});

// Cache/Snapshot alle 15 Minuten auffrischen
setInterval(async () => {
  try {
    await buildMarketSnapshot();
  } catch (err) {
    console.error("Warmup Fehler:", err.message);
  }
}, 15 * 60 * 1000);
