import express from "express";
import fetch from "node-fetch";
import cron from "node-cron";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3001;

const ASSETS = [
  { name: "MSCI World ETF", symbol: "URTH" },
  { name: "MSCI Emerging Markets ETF", symbol: "EEM" },
  { name: "MSCI IT ETF", symbol: "IXN" },
  { name: "Tech Large Caps", symbol: "QQQ" },
  { name: "Tech Mid Caps", symbol: "MDY" },
  { name: "Tech Small Caps", symbol: "IJR" },
];

const momentumScore = (m3, m6, m12) =>
  0.25 * m3 + 0.35 * m6 + 0.4 * m12;

async function fetchMarketData() {
  const result = [];

  for (const a of ASSETS) {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${a.symbol}?range=1y&interval=1d`
    );
    const json = await res.json();
    const prices = json.chart.result[0].indicators.quote[0].close.filter(Boolean);

    const pct = (x, y) => ((y - x) / x) * 100;

    result.push({
      ...a,
      m3: pct(prices.at(-63), prices.at(-1)),
      m6: pct(prices.at(-126), prices.at(-1)),
      m12: pct(prices[0], prices.at(-1)),
    });
  }

  const ranked = result
    .map(a => ({ ...a, score: momentumScore(a.m3, a.m6, a.m12) }))
    .sort((a, b) => b.score - a.score);

  fs.writeFileSync("latest.json", JSON.stringify(ranked, null, 2));
  return ranked;
}

app.get("/api/hqs", async (_, res) => {
  if (!fs.existsSync("latest.json")) {
    await fetchMarketData();
  }
  res.json(JSON.parse(fs.readFileSync("latest.json")));
});

// 🔄 Cron: jeden Monat am 1. um 06:00
cron.schedule("0 6 1 * *", async () => {
  console.log("🔄 HQS Monatslauf");
  await fetchMarketData();
});

app.listen(PORT, () =>
  console.log(`HQS Backend läuft auf Port ${PORT}`)
);
