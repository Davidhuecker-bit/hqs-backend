import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;

/* ===========================
   MIDDLEWARE
=========================== */
app.use(cors());
app.use(express.json());

/* ===========================
   HEALTH CHECKS
=========================== */
app.get("/", (req, res) => {
  res.send("HQS Backend OK");
});

app.get("/ping", (req, res) => {
  res.send("pong");
});

/* ===========================
   HQS ASSET SETUP
=========================== */
const ASSETS = [
  { name: "MSCI World", symbol: "URTH" },
  { name: "Emerging Markets", symbol: "EEM" },
  { name: "US Bonds", symbol: "BND" },
  { name: "Cash (Risk-Off)", symbol: "SHY" },
  { name: "Nasdaq 100", symbol: "QQQ" }
];

/* ===========================
   HQS SCORE FUNCTION
=========================== */
function momentumScore(m3, m6, m12) {
  return 0.25 * m3 + 0.35 * m6 + 0.4 * m12;
}

/* ===========================
   MARKET DATA FETCH
=========================== */
async function fetchMarketData() {
  const results = [];

  for (const asset of ASSETS) {
    try {
      const response = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${asset.symbol}?range=1y&interval=1d`
      );
      const data = await response.json();

      const prices =
        data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(
          Number.isFinite
        ) || [];

      if (prices.length < 252) continue;

      const pct = (from, to) => ((to - from) / from) * 100;

      const m3 = pct(prices.at(-63), prices.at(-1));
      const m6 = pct(prices.at(-126), prices.at(-1));
      const m12 = pct(prices.at(-252), prices.at(-1));

      results.push({
        name: asset.name,
        symbol: asset.symbol,
        m3: Number(m3.toFixed(2)),
        m6: Number(m6.toFixed(2)),
        m12: Number(m12.toFixed(2)),
        score: Number(momentumScore(m3, m6, m12).toFixed(2))
      });
    } catch (err) {
      console.error(`Fehler bei ${asset.symbol}`, err.message);
    }
  }

  const ranked = results.sort((a, b) => b.score - a.score);
  fs.writeFileSync("latest.json", JSON.stringify(ranked, null, 2));

  return ranked.length;
}

/* ===========================
   API ENDPOINTS
=========================== */
app.get("/force-update", async (req, res) => {
  const updated = await fetchMarketData();
  res.json({ status: "ok", updated });
});

app.get("/market", async (req, res) => {
  if (!fs.existsSync("latest.json")) {
    await fetchMarketData();
  }
  const data = JSON.parse(fs.readFileSync("latest.json"));
  res.json(data);
});

/* ===========================
   SERVER START
=========================== */
app.listen(PORT, () => {
  console.log(`✅ HQS Backend läuft auf Port ${PORT}`);
});
