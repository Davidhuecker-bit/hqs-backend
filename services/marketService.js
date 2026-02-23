const { fetchQuote } = require("./providerService");
const { buildHQSResponse } = require("../hqsEngine");
const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DEFAULT_SYMBOLS = ["NVDA"];

/**
 * Redundanz-Logik: Polygon.io & Alpha Vantage
 */
async function fetchFromFallback(symbols) {
  console.log(`🔄 Primärquelle down. Versuche Fallbacks für: ${symbols}`);
  
  try {
    // 1. Fallback: Polygon.io (Echtzeit-Fokus)
    // const data = await polygonClient.getQuotes(symbols);
    // if (data) return data;

    // 2. Fallback: Alpha Vantage (Multi-Asset Fokus)
    // const data = await alphaVantage.getGlobalQuote(symbols);
    // if (data) return data;

    return null;
  } catch (err) {
    console.error("❌ Alle Fallback-Provider fehlgeschlagen", err.message);
    return null;
  }
}

// ============================
// SNAPSHOT BUILDER
// ============================

async function buildMarketSnapshot() {
  const symbolsString = DEFAULT_SYMBOLS.join(",");
  
  try {
    let rawData = await fetchQuote(symbolsString);

    // Fallback-Kette triggern, falls Hauptquelle leer
    if (!rawData || rawData.length === 0) {
      rawData = await fetchFromFallback(symbolsString);
    }

    if (!rawData || rawData.length === 0) {
      throw new Error("Keine Daten von Primär- oder Fallback-Quellen erhalten.");
    }

    const result = rawData.map(item => buildHQSResponse(item));

    // Snapshot in Redis (Upstash) ablegen
    await redis.set("market:snapshot", JSON.stringify(result), { ex: 60 });
    console.log("🔥 Snapshot aktualisiert");
    return result;
    
  } catch (error) {
    console.error("❌ Snapshot-Build Error:", error.message);
    // Versuche alten Snapshot zu retten (Stale-while-revalidate)
    const staleData = await redis.get("market:snapshot");
    return staleData ? (typeof staleData === 'string' ? JSON.parse(staleData) : staleData) : [];
  }
}

// ============================
// MAIN DATA FETCH
// ============================

async function getMarketData(symbol) {
  // Einzelabfrage
  if (symbol) {
    try {
      let data = await fetchQuote(symbol);
      if (!data || data.length === 0) {
        data = await fetchFromFallback(symbol);
      }
      return data ? data.map(item => buildHQSResponse(item)) : [];
    } catch (e) {
      return { error: "Daten für " + symbol + " nicht verfügbar." };
    }
  }

  // Snapshot-Logik
  const cachedSnapshot = await redis.get("market:snapshot");
  if (cachedSnapshot) {
    console.log("⚡ Snapshot Cache Hit");
    return typeof cachedSnapshot === "string" ? JSON.parse(cachedSnapshot) : cachedSnapshot;
  }

  console.log("⚠ Cache leer → baue Snapshot neu");
  return await buildMarketSnapshot();
}

module.exports = {
  getMarketData,
  buildMarketSnapshot,
};
