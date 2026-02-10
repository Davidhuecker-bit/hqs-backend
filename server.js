// server.js – HQS Backend (CommonJS, Railway-stabil)

const express = require("express");
const cors = require("cors");
const yahooFinance = require("yahoo-finance2").default;

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

/**
 * Healthcheck
 */
app.get("/", (req, res) => {
  res.send("HQS Backend OK");
});

/**
 * Ping
 */
app.get("/ping", (req, res) => {
  res.json({ status: "pong" });
});

/**
 * Stage 4 – Marktdaten
 */
app.get("/stage4", async (req, res) => {
  try {
    const symbols = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL"];
    const results = [];

    for (const symbol of symbols) {
      const quote = await yahooFinance.quote(symbol);
      if (!quote?.regularMarketPrice) continue;

      const score = Math.random() * 100; // Platzhalter (läuft sicher!)

      results.push({
        symbol,
        score: Number(score.toFixed(2)),
      });
    }

    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ HQS Backend läuft auf Port ${PORT}`);
});
