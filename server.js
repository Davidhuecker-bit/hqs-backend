// server.js – HQS Backend St// server.js – HQS Backend Stufe 4
// Reale Marktdaten + Strategie-Gewichtung
// Railway-kompatibel (PORT, CORS, stabil)

const express = require("express");
const cors = require("cors");
const yahooFinance = require("yahoo-finance2").default;

const app = express();
app.use(cors());

const PORT = process.env.PORT || 8080;

/**
 * Aktien-Universum (erweiterbar)
 */
const symbols = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL"];

/**
 * Strategie-Gewichte
 */
const STRATEGIES = {
  defensiv: { momentum: 0.2, valuation: 0.4, risk: 0.4 },
  balanced: { momentum: 0.33, valuation: 0.33, risk: 0.34 },
  aggressiv: { momentum: 0.5, valuation: 0.3, risk: 0.2 },
};

/**
 * Healthcheck
 */
app.get("/", (req, res) => {
  res.send("HQS Backend Stufe 4 OK");
});

/**
 * Stufe 4 Endpoint
 */
app.get("/stage4", async (req, res) => {
  try {
    const style = req.query.style || "balanced";
    const weights = STRATEGIES[style] || STRATEGIES.balanced;

    const results = [];

    for (const symbol of symbols) {
      const quote = await yahooFinance.quote(symbol);
      const hist = await yahooFinance.historical(symbol, {
        period1: "2024-01-01",
      });

      if (!quote || hist.length < 20) continue;

      const priceNow = quote.regularMarketPrice;
      const priceThen = hist[0].close;
      const momentum = (priceNow - priceThen) / priceThen;

      const volatility =
        hist
          .slice(0, 30)
          .map(d => d.close)
          .reduce((a, b) => a + Math.abs(b - priceNow), 0) / 30 / priceNow;

      const valuation = 1 / (quote.trailingPE || 30);

      const score =
        momentum * weights.momentum +
        valuation * weights.valuation -
        volatility * weights.risk;

      results.push({
        symbol,
        score: Number((score * 100).toFixed(2)),
      });
    }

    results.sort((a, b) => b.score - a.score);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ HQS Stufe 4 Backend läuft auf Port ${PORT}`);
});
