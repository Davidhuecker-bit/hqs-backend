import express from "express";
import cors from "cors";
import fs from "fs";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const DATA_FILE = "latest.json";

/* =========================
   🔹 FALLBACK MARKTDATEN
   ========================= */
const FALLBACK_DATA = [
  { symbol: "AAPL", score: 82.4 },
  { symbol: "MSFT", score: 79.1 },
  { symbol: "NVDA", score: 76.9 },
  { symbol: "GOOGL", score: 74.3 },
  { symbol: "AMZN", score: 72.8 }
];

/* =========================
   🔹 HILFSFUNKTION
   ========================= */
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

/* =========================
   🔹 MARKTDATEN LADEN
   ========================= */
async function fetchMarketData() {
  try {
    // 👉 hier später echte Datenquelle (Yahoo, Polygon, etc.)
    // aktuell simuliert → absichtlich stabil
    const liveDataAvailable = false;

    if (!liveDataAvailable) {
      console.log("⚠️ Live-Daten nicht verfügbar → Fallback aktiv");
      saveData(FALLBACK_DATA);
      return FALLBACK_DATA;
    }

    // Beispiel (noch deaktiviert):
    // const res = await fetch("https://...");
    // const json = await res.json();

    return FALLBACK_DATA;
  } catch (err) {
    console.error("❌ Fehler beim Laden der Marktdaten:", err.message);
    saveData(FALLBACK_DATA);
    return FALLBACK_DATA;
  }
}

/* =========================
   🔹 ROUTES
   ========================= */

// Healthcheck
app.get("/", (_, res) => {
  res.send("HQS Backend OK");
});

// Market Endpoint (Frontend nutzt DAS)
app.get("/market", async (_, res) => {
  if (!fs.existsSync(DATA_FILE)) {
    await fetchMarketData();
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE));
  res.json(data);
});

// Manuelles Update (temporär, aber extrem nützlich)
app.get("/force-update", async (_, res) => {
  const data = await fetchMarketData();
  res.json({
    status: "ok",
    updated: data.length
  });
});

/* =========================
   🔹 SERVER START
   ========================= */
app.listen(PORT, () => {
  console.log(`✅ HQS Backend läuft auf Port ${PORT}`);
});
