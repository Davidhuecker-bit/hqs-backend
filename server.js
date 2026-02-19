const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { getMarketData } = require("./services/marketService");

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
// MARKET ROUTE
// ============================

app.get(["/market", "/api/market"], async (req, res) => {
  try {
    const symbol = req.query.symbol || "NVDA";

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
// STATUS
// ============================

app.get(["/admin-bypass-status", "/api/admin-bypass-status"], (req, res) => {
  res.json({ active: true, mode: "HQS AI Hybrid Online" });
});

app.listen(PORT, () => {
  console.log(`🚀 HQS Backend läuft auf Port ${PORT}`);
});
