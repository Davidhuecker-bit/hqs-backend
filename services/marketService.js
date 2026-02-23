const { fetchQuote } = require("./providerService");
const { buildHQSResponse } = require("../hqsEngine");
const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DEFAULT_SYMBOLS = (process.env.GUARDIAN_SYMBOLS || "AAPL,MSFT,NVDA,AMD")
  .split(",")
  .map((symbol) => String(symbol || "").trim().toUpperCase())
  .filter((symbol) => /^[A-Z0-9.-]{1,12}$/.test(symbol));

async function readSnapshotCache() {
  try {
    const cached = await redis.get("market:snapshot");
    if (!cached) return null;
    return typeof cached === "string" ? JSON.parse(cached) : cached;
  } catch (error) {
    console.error("⚠️ Snapshot Cache Read Error:", error.message);
    return null;
  }
}

async function writeSnapshotCache(payload) {
  try {
    await redis.set("market:snapshot", JSON.stringify(payload), { ex: 60 });
  } catch (error) {
    console.error("⚠️ Snapshot Cache Write Error:", error.message);
  }
}

// ============================
// SNAPSHOT BUILDER
// ============================

async function buildMarketSnapshot() {
  try {
    // Finnhub /quote liefert pro Symbol, daher bauen wir den Snapshot iterativ.
    const results = [];
    for (const symbol of DEFAULT_SYMBOLS) {
      const data = await fetchQuote(symbol);
      if (data && data[0]) {
        const hqsData = await buildHQSResponse(data[0]);
        if (hqsData) results.push(hqsData);
      }
    }

    if (results.length === 0) {
      throw new Error("Finnhub lieferte keine Daten für den Snapshot.");
    }

    // Snapshot 60 Sekunden in Redis speichern
    await writeSnapshotCache(results);
    console.log("🔥 Finnhub Snapshot aktualisiert");
    return results;
    
  } catch (error) {
    console.error("❌ Snapshot Error:", error.message);
    const staleData = await readSnapshotCache();
    return Array.isArray(staleData) ? staleData : [];
  }
}

// ============================
// MAIN DATA FETCH
// ============================

async function getMarketData(symbol) {
  if (symbol) {
    const data = await fetchQuote(symbol);
    if (!Array.isArray(data) || data.length === 0) return [];
    const mapped = await Promise.all(data.map((item) => buildHQSResponse(item)));
    return mapped.filter(Boolean);
  }

  // Cache Check
  const cached = await readSnapshotCache();
  if (Array.isArray(cached) && cached.length > 0) {
    console.log("⚡ Snapshot Cache Hit (Finnhub)");
    return cached;
  }

  return buildMarketSnapshot();
}

module.exports = {
  getMarketData,
  buildMarketSnapshot,
};
