const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { getMarketData, buildMarketSnapshot } = require("./services/marketService");
const { buildHQSResponse } = require("./hqsEngine");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({
  origin: [
    "https://dhsystemhqs.de",
    "https://www.dhsystemhqs.de",
    "http://localhost:3000"
  ],
  methods: ["GET", "POST"]
}));

app.use(express.json());

// ============================
// MARKET ROUTE (bestehend)
// ============================

app.get(["/market", "/api/market"], async (req, res) => {
  try {
    const symbol = req.query.symbol || null;

    const stocks = await getMarketData(symbol);

    res.json({ success: true, stocks });

  } catch (error) {
    console.error("Market Fehler:", error.message);

    res.status(500).json({
      success: false,
      message: "Marktdaten konnten nicht geladen werden.",
      error: error.message
    });
  }
});

// ============================
// 🔥 HQS ROUTE (NEU)
// ============================

app.get(["/hqs", "/api/hqs"], async (req, res) => {
  try {
    const symbol = req.query.symbol;

    if (!symbol) {
      return res.status(400).json({
        success: false,
        message: "Symbol fehlt."
      });
    }

    const marketData = await getMarketData(symbol.toUpperCase());

    if (!marketData) {
      return res.status(404).json({
        success: false,
        message: "Symbol nicht gefunden."
      });
    }

    const hqsResult = await buildHQSResponse(marketData);

    res.json({
      success: true,
      data: hqsResult
    });

  } catch (error) {
    console.error("HQS Fehler:", error.message);

    res.status(500).json({
      success: false,
      message: "HQS Berechnung fehlgeschlagen.",
      error: error.message
    });
  }
});

// ============================
// STATUS
// ============================

app.get(["/admin-bypass-status", "/api/admin-bypass-status"], (req, res) => {
  res.json({ active: true, mode: "HQS AI Hybrid Online" });
});

// ============================
// SERVER START
// ============================

app.listen(PORT, async () => {
  console.log(`🚀 HQS Backend läuft auf Port ${PORT}`);

  // 🔥 Direkt beim Start Snapshot bauen
  try {
    await buildMarketSnapshot();
  } catch (err) {
    console.error("Initial Snapshot Fehler:", err.message);
  }
});

// ============================
// 🔥 WARMUP JOB
// ============================

setInterval(async () => {
  try {
    await buildMarketSnapshot();
  } catch (err) {
    console.error("Warmup Fehler:", err.message);
  }
}, 15 * 60 * 1000); // alle 15 Minuten
