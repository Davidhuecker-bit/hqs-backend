const { fetchQuote } = require("./providerService");
const { buildHQSResponse } = require("../hqsEngine");
const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DEFAULT_SYMBOLS = ["NVDA"];

// ============================
// SNAPSHOT BUILDER
// ============================

async function buildMarketSnapshot() {
  try {
    // Da Finnhub /quote oft nur pro Symbol erlaubt, mappen wir durch unsere Liste
    const results = [];
    for (const symbol of DEFAULT_SYMBOLS) {
      const data = await fetchQuote(symbol);
      if (data && data[0]) {
        results.push(buildHQSResponse(data[0]));
      }
    }

    if (results.length === 0) {
      throw new Error("Finnhub lieferte keine Daten für den Snapshot.");
    }

    // Snapshot 60 Sekunden in Redis speichern
    await redis.set("market:snapshot", JSON.stringify(results), { ex: 60 });
    console.log("🔥 Finnhub Snapshot aktualisiert");
    return results;
    
  } catch (error) {
    console.error("❌ Snapshot Error:", error.message);
    const staleData = await redis.get("market:snapshot");
    return staleData ? (typeof staleData === 'string' ? JSON.parse(staleData) : staleData) : [];
  }
}

// ============================
// MAIN DATA FETCH
// ============================

async function getMarketData(symbol) {
  if (symbol) {
    const data = await fetchQuote(symbol);
    return data ? data.map(item => buildHQSResponse(item)) : [];
  }

  // Cache Check
  const cached = await redis.get("market:snapshot");
  if (cached) {
    console.log("⚡ Snapshot Cache Hit (Finnhub)");
    return typeof cached === "string" ? JSON.parse(cached) : cached;
  }

  return await buildMarketSnapshot();
}

module.exports = {
  getMarketData,
  buildMarketSnapshot,
};
