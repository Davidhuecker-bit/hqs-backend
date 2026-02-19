const { fetchQuote } = require("./providerService");
const { buildHQSResponse } = require("../hqsEngine");
const Redis = require("@upstash/redis");

const redis = Redis.fromEnv();

// 🔥 Später erweiterbar (Top 20 etc.)
const DEFAULT_SYMBOLS = ["NVDA"];

// ============================
// SNAPSHOT BUILDER
// ============================

async function buildMarketSnapshot() {
  const symbolsString = DEFAULT_SYMBOLS.join(",");

  const rawData = await fetchQuote(symbolsString);

  const result = rawData.map(item => buildHQSResponse(item));

  // Snapshot 60 Sekunden gültig
  await redis.set("market:snapshot", result, { ex: 60 });

  console.log("📊 Snapshot aktualisiert");

  return result;
}

// ============================
// MAIN DATA FETCH
// ============================

async function getMarketData(symbol) {

  // 1️⃣ Wenn einzelnes Symbol gewünscht
  if (symbol) {
    const rawData = await fetchQuote(symbol);
    return rawData.map(item => buildHQSResponse(item));
  }

  // 2️⃣ Snapshot holen
  const snapshot = await redis.get("market:snapshot");

  if (snapshot) {
    console.log("⚡ Snapshot Cache Hit");
    return snapshot;
  }

  // 3️⃣ Fallback wenn Snapshot noch nicht existiert
  console.log("⚠️ Kein Snapshot – baue neu");
  return await buildMarketSnapshot();
}

module.exports = {
  getMarketData,
  buildMarketSnapshot
};
