const { fetchQuote } = require("./providerService");
const { buildHQSResponse } = require("../hqsEngine");
const { Redis } = require("@upstash/redis");

// ============================
// REDIS SETUP (Upstash)
// ============================

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ============================
// DEFAULT SYMBOLS (Snapshot)
// ============================

const DEFAULT_SYMBOLS = ["NVDA"]; // später erweiterbar

// ============================
// SNAPSHOT BUILDER
// ============================

async function buildMarketSnapshot() {
  const symbolsString = DEFAULT_SYMBOLS.join(",");

  const rawData = await fetchQuote(symbolsString);

  const result = rawData.map(item => buildHQSResponse(item));

  // Snapshot 60 Sekunden gültig
  await redis.set("market:snapshot", result, { ex: 60 });

  console.log("🔥 Snapshot aktualisiert");

  return result;
}

// ============================
// MAIN DATA FETCH
// ============================

async function getMarketData(symbol) {

  // 1️⃣ Einzelnes Symbol gewünscht
  if (symbol) {
    const rawData = await fetchQuote(symbol);
    return rawData.map(item => buildHQSResponse(item));
  }

  // 2️⃣ Snapshot aus Redis holen
  const snapshot = await redis.get("market:snapshot");

  if (snapshot) {
    console.log("⚡ Snapshot Cache Hit");
    return snapshot;
  }

  // 3️⃣ Fallback → neu bauen
  console.log("⚠ Kein Snapshot → baue neu");
  return await buildMarketSnapshot();
}

module.exports = {
  getMarketData,
  buildMarketSnapshot,
};
