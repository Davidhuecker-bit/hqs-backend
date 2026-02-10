import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

/* =========================
   MIDDLEWARE
========================= */
app.use(cors());
app.use(express.json());

/* =========================
   HEALTH
========================= */
app.get("/", (_, res) => res.send("HQS Backend OK"));
app.get("/ping", (_, res) => res.send("pong"));

/* =========================
   HQS STUFE 3 CONFIG
========================= */

// Asset-Universum (erweiterbar!)
const ASSETS = [
  { symbol: "AAPL", type: "stock" },
  { symbol: "MSFT", type: "stock" },
  { symbol: "NVDA", type: "stock" },
  { symbol: "GOOGL", type: "stock" },
  { symbol: "AMZN", type: "stock" },
  { symbol: "QQQ", type: "etf" },
  { symbol: "EEM", type: "etf" },
  { symbol: "URTH", type: "etf" }
];

// HQS Momentum Score
const score = (m3, m6, m12) =>
  0.25 * m3 + 0.35 * m6 + 0.4 * m12;

/* =========================
   MARKET DATA
========================= */
async function getMomentum(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1y&interval=1d`;
  const res = await fetch(url);
  const json = await res.json();

  const prices =
    json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(Number.isFinite);

  if (!prices || prices.length < 252) return null;

  const pct = (from, to) => ((to - from) / from) * 100;

  return {
    m3: pct(prices.at(-63), prices.at(-1)),
    m6: pct(prices.at(-126), prices.at(-1)),
    m12: pct(prices.at(-252), prices.at(-1))
  };
}

/* =========================
   API: STUFE 3 – PORTFOLIO
========================= */
app.get("/portfolio", async (_, res) => {
  const results = [];

  for (const asset of ASSETS) {
    try {
      const m = await getMomentum(asset.symbol);
      if (!m) continue;

      results.push({
        symbol: asset.symbol,
        type: asset.type,
        score: Number(score(m.m3, m.m6, m.m12).toFixed(2))
      });
    } catch (e) {
      console.error(asset.symbol, e.message);
    }
  }

  // Ranking
  const ranked = results.sort((a, b) => b.score - a.score);

  // Portfolio-Regeln (Stufe 3)
  const TOP_N = 5;
  const selected = ranked.slice(0, TOP_N);

  const weight = Number((100 / TOP_N).toFixed(2));

  const portfolio = selected.map(a => ({
    symbol: a.symbol,
    type: a.type,
    score: a.score,
    weight: weight
  }));

  res.json({
    status: "ok",
    rebalance: "monthly",
    strategy: "HQS Stage 3",
    portfolio
  });
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () =>
  console.log("✅ HQS Stufe 3 Backend läuft auf Port", PORT)
);
