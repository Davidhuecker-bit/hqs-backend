import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import cron from "node-cron";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3001;

// ===========================
// MIDDLEWARE
// ===========================
app.use(cors());
app.use(express.json());

// ===========================
// HEALTH CHECK (WICHTIG!)
// ===========================
app.get("/ping", (_, res) => {
  res.send("pong");
});

// ===========================
// ASSET-UNIVERSUM
// ===========================
const ASSETS = [
  { name: "MSCI World ETF", symbol: "URTH" },
  { name: "MSCI Emerging Markets ETF", symbol: "EEM" },
  { name: "MSCI IT ETF", symbol: "IXN" },
  { name: "Tech Large Caps", symbol: "QQQ" },
  { name: "Tech Mid Caps", symbol: "MDY" },
  { name: "Tech Small Caps", symbol: "IJR" },
];

// ===========================
// MOMENTUM SCORE
// ===========================
const momentumScore = (m3, m6, m12) =>
  0.25 * m3 + 0.35 * m6 + 0.4 * m12;

// ===========================
// FETCH & BERECHNUNG
// ===========================
async function fetchMarketData() {
  const result = [];

  for (const asset of ASSETS) {
    try {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${asset.symbol}?range=1y&interval=1d`
      );

      if (!res.ok) throw new Error(`Yahoo API Fehler ${asset.symbol}`);

      const json = await res.json();
      const prices =
        json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(
          Number.isFinite
        ) || [];

      if (prices.length < 252) continue;

      const pct = (from, to) => ((to - from) / from) * 100;

      result.push({
        ...asset,
        m3: pct(prices.at(-63), prices.at(-1)),
        m6: pct(prices.at(-126), prices.at(-1)),
        m12: pct(prices.at(-252), prices.at(-1)),
      });
    } catch (err) {
      console.error(`❌ ${asset.symbol}:`, err.message);
    }
  }

  const ranked = result
    .map(a => ({ ...a, score: momentumScore(a.m3, a.m6, a.m12) }))
    .sort((a, b) => b.score - a.score);

  fs.writeFileSync("latest.json", JSON.stringify(ranked, null, 2));
  return ranked;
}

// ===========================
// API ROUTE (Frontend)
// ===========================
app.get("/market", async (_, res) => {
  try {
    if (!fs.existsSync("latest.json")) {
      await fetchMarketData();
    }

    const data = JSON.parse(fs.readFileSync("latest.json", "utf8"));
    res.json(data);
  } catch (err) {
    console.error("❌ API Fehler:", err.message);
    res.status(500).json({ error: "Market data unavailable" });
  }
});

// ===========================
// CRON (nur wenn Instanz aktiv)
// ===========================
cron.schedule("0 6 1 * *", async () => {
  console.log("🔄 HQS Monatslauf");
  await fetchMarketData();
});

// ===========================
// SERVER START
// ===========================
app.listen(PORT, () => {
  console.log(`✅ HQS Backend läuft auf Port ${PORT}`);
});
