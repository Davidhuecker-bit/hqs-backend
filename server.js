// server.js – HQS Backend Stufe 3 (FINAL)
// Multi-Faktor-Scoring: Fundamentals + Momentum + Risiko
// Railway & Vercel kompatibel

import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 8080;

// =======================
// MIDDLEWARE
// =======================
app.use(cors({ origin: "*" }));
app.use(express.json());

// =======================
// HEALTH
// =======================
app.get("/", (_, res) => {
  res.send("HQS Backend OK");
});

app.get("/health", (_, res) => {
  res.json({ status: "ok", stage: 3 });
});

// =======================
// DEMO UNIVERSE (Stufe 3)
// =======================
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
    fundamentals: { pe: 24, growth: 0.11 },
    momentum: { trend: 0.14 },
    risk: { volatility: 0.21 }
  },
  {
    symbol: "AMZN",
    fundamentals: { pe: 55, growth: 0.22 },
    momentum: { trend: 0.19 },
    risk: { volatility: 0.28 }
  }
];

// =======================
// SCORING
// =======================
function scoreAsset(a) {
  const fundamentals =
    (1 / a.fundamentals.pe) * 40 +
    a.fundamentals.growth * 100;

  const momentum = a.momentum.trend * 100;
  const riskPenalty = a.risk.volatility * 50;

  return (
    fundamentals * 0.4 +
    momentum * 0.4 -
    riskPenalty * 0.2
  );
}

// =======================
// API – FRONTEND KOMPATIBEL
// =======================
app.get("/market", (_, res) => {
  const ranked = universe
    .map(a => ({
      symbol: a.symbol,
      score: Number(scoreAsset(a).toFixed(2))
    }))
    .sort((a, b) => b.score - a.score);

  res.json(ranked);
});

// =======================
app.listen(PORT, () => {
  console.log(`✅ HQS Stufe 3 Backend läuft auf Port ${PORT}`);
});
