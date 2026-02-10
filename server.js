const express = require("express");
const cors = require("cors");
const yahooFinance = require("yahoo-finance2").default;

const app = express();
app.use(cors());

const PORT = process.env.PORT || 8080;

const symbols = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL"];

const STRATEGIES = {
  defensiv: { momentum: 0.2, valuation: 0.4, risk: 0.4 },
  balanced: { momentum: 0.33, valuation: 0.33, risk: 0.34 },
  aggressiv: { momentum: 0.5, valuation: 0.3, risk: 0.2 },
};

app.get("/", (_, res) => {
  res.send("HQS Backend Stufe 4 OK");
});

app.get("/stage4", async (req, res) => {
  try {
    const style = req.query.style || "balanced";
    const weights = STRATEGIES[style] || STRATEGIES.balanced;
    const results = [];

    for (const symbol of symbols) {
      const quote = await yahooFinance.quote(symbol);
      if (!quote?.regularMarketPrice) continue;

      const valuation = 1 / (quote.trailingPE || 30);
      const momentum = quote.regularMarketChangePercent || 0;
      const risk = Math.abs(momentum);

      const score =
        momentum * weights.momentum +
        valuation * weights.valuation -
        risk * weights.risk;

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
  console.log(`✅ HQS Backend läuft auf Port ${PORT}`);
});
