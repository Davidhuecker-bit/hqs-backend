const express = require("express");
const app = express();

const PORT = process.env.PORT || 8080;

/**
 * ============================
 * HEALTH CHECK
 * ============================
 */
app.get("/", (req, res) => {
  res.send("✅ HQS Backend Stage 3 läuft");
});

/**
 * ============================
 * HQS STUFE 3 – SCORE ENGINE
 * ============================
 */
app.get("/hqs/stage3", (req, res) => {

  // Basisdaten (Dummy – später austauschbar)
  const universe = [
    { symbol: "AAPL", momentum: 82, quality: 88, valuation: 70 },
    { symbol: "MSFT", momentum: 79, quality: 90, valuation: 72 },
    { symbol: "NVDA", momentum: 92, quality: 75, valuation: 60 },
    { symbol: "GOOGL", momentum: 74, quality: 85, valuation: 78 },
    { symbol: "AMZN", momentum: 71, quality: 80, valuation: 74 }
  ];

  // Gewichtung (HQS-Logik)
  const WEIGHTS = {
    momentum: 0.4,
    quality: 0.4,
    valuation: 0.2
  };

  const ranked = universe
    .map(stock => {
      const score =
        stock.momentum * WEIGHTS.momentum +
        stock.quality * WEIGHTS.quality +
        stock.valuation * WEIGHTS.valuation;

      return {
        symbol: stock.symbol,
        score: Number(score.toFixed(2))
      };
    })
    .sort((a, b) => b.score - a.score);

  res.json({
    status: "ok",
    stage: 3,
    count: ranked.length,
    ranking: ranked
  });
});

/**
 * ============================
 * SERVER START
 * ============================
 */
app.listen(PORT, () => {
  console.log(`✅ HQS Stufe 3 Backend läuft auf Port ${PORT}`);
});
