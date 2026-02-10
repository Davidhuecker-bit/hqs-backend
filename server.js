import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// =========================
// HEALTH CHECKS
// =========================
app.get("/", (_, res) => res.send("HQS Backend OK"));
app.get("/ping", (_, res) => res.send("pong"));

// =========================
// ASSET-UNIVERSUM (Stufe 2)
// =========================
const ASSETS = [
  { name: "Apple", symbol: "AAPL" },
  { name: "Microsoft", symbol: "MSFT" },
  { name: "Nvidia", symbol: "NVDA" },
  { name: "Google", symbol: "GOOGL" },
  { name: "Amazon", symbol: "AMZN" },
];

// =========================
// MOMENTUM FORMEL (HQS-Style)
// =========================
const momentumScore = (m3, m6, m12) =>
  0.25 * m3 + 0.35 * m6 + 0.4 * m12;

// =========================
// DATEN FETCH + BERECHNUNG
// =========================
async function fetchMarketData() {
  const results = [];

  for (const asset of ASSETS) {
    try {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${asset.symbol}?range=1y&interval=1d`
      );

      const json = await res.json();
      const prices =
        json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(
          Number.isFinite
        ) || [];

      if (prices.length < 252) continue;

      const pct = (from, to) => ((to - from) / from) * 100;

      const m3 = pct(prices.at(-63), prices.at(-1));
      const m6 = pct(prices.at(-126), prices.at(-1));
      const m12 = pct(prices.at(-252), prices.at(-1));

      results.push({
        symbol: asset.symbol,
        name: asset.name,
        m3: Number(m3.toFixed(2)),
        m6: Number(m6.toFixed(2)),
        m12: Number(m12.toFixed(2)),
        score: Number(momentumScore(m3, m6, m12).toFixed(2)),
      });
    } catch (e) {
      console.error("❌ Fehler bei", asset.symbol, e.message);
    }
  }

  const ranked = results.sort((a, b) => b.score - a.score);

  fs.writeFileSync("latest.json", JSON.stringify(ranked, null, 2));
  return ranked;
}

// =========================
// API: MARKTDATEN
// =========================
app.get("/market", async (_, res) => {
  if (!fs.existsSync("latest.json")) {
    await fetchMarketData();
  }
  res.json(JSON.parse(fs.readFileSync("latest.json")));
});

// =========================
// MANUELLER TRIGGER (Stufe 2)
// =========================
app.get("/force-update", async (_, res) => {
  try {
    const data = await fetchMarketData();
    res.json({ status: "ok", updated: data.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// SERVER START
// =========================
app.listen(PORT, () => {
  console.log(`✅ HQS Backend läuft auf Port ${PORT}`);
});
