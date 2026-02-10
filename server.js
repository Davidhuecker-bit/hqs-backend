// server.js – HQS Backend Stufe 3
// Multi-Faktor-Scoring: Fundamentals + Momentum + Risiko
// Läuft stabil auf Railway (Port 8080)

const express = require("express");
const app = express();

const PORT = process.env.PORT || 8080;

/**
 * Demo-Daten (später ersetzbar durch echte APIs)
 */
const universe = [
  {
    symbol: "AAPL",
    fundamentals: { pe: 28, growth: 0.12 },
    momentum: { trend: 0.18 },
    risk: { volatility: 0.22 }
  },
  {
    symbol: "MSFT",
    fundamentals: { pe: 30, growth: 0.14 },
    momentum: { trend: 0.16 },
    risk: { volatility: 0.20 }
  },
  {
    symbol: "NVDA",
    fundamentals: { pe: 45, growth: 0.30 },
    momentum: { trend: 0.25 },
    risk: { volatility: 0.35 }
  },
  {
    symbol: "GOOGL",
    fundamentals: { pe: 24, growth: 0.10 },
    momentum: { trend: 0.12 },
    risk: { volatility: 0.18 }
  },
  {
    symbol: "AMZN",
    fundamentals: { pe: 60, growth: 0.18 },
    momentum: { trend: 0.14 },
    risk: { volatility: 0.28 }
  }
];

/**
 * HQS Scoring Engine – Stufe 3
 */
function calculateScore(stock) {
  const fundamentalScore =
    (1 / stock.fundamentals.pe) * 40 +
    stock.fundamentals.growth * 100;

  const momentumScore = stock.momentum.trend * 100;
  const riskPenalty = stock.risk.volatility * 50;

  const totalScore =
    fundamentalScore * 0.4 +
    momentumScore * 0.4 -
    riskPenalty * 0.2;

  return Number(totalScore.toFixed(2));
}

/**
 * Root Healthcheck
 */
app.get("/", (req, res) => {
  res.send("HQS Backend OK");
});

/**
 * Ping
 */
app.get("/ping", (req, res) => {
  res.send("pong");
});

/**
 * HQS Stage 3 Endpoint
 */
app.get("/hqs/stage3", (req, res) => {
  const ranked = universe
    .map(stock => ({
      symbol: stock.symbol,
      score: calculateScore(stock)
    }))
    .sort((a, b) => b.score - a.score);

  res.json({
    status: "ok",
    stage: 3,
    count: ranked.length,
    data: ranked
  });
});

/**
 * Server Start
 */
app.listen(PORT, () => {
  console.log(`✅ HQS Stufe 3 Backend läuft auf Port ${PORT}`);
});
