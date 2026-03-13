"use strict";

// services/universe.service.js
// Lädt eine Symbol-Liste (Universe) und speichert sie in DB.
// Primärquelle: Massive Reference Tickers
// Fallback: interne Tabellen, falls externe Quelle ausfällt

const axios = require("axios");
const { Pool } = require("pg");
const logger = require("../utils/logger");

const {
  initUniverseTables,
  upsertUniverseSymbols,
  countActiveUniverse,
} = require("./universe.repository");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const MASSIVE_API_KEY = String(
  process.env.MASSIVE_API_KEY ||
  process.env.POLYGON_API_KEY ||
  ""
).trim();

const UNIVERSE_LIMIT = Math.max(
  50,
  Math.min(Number(process.env.UNIVERSE_LIMIT || 300), 5000)
);

const FALLBACK_UNIVERSE_LIMIT = Math.max(
  50,
  Math.min(Number(process.env.FALLBACK_UNIVERSE_LIMIT || 300), 1000)
);

function normalizeMassiveRow(r) {
  const symbol = String(r?.ticker ?? r?.symbol ?? "").trim().toUpperCase();
  if (!symbol) return null;

  const type = String(r?.type ?? "").trim().toUpperCase();
  const name = String(r?.name ?? "").trim();
  const locale = String(r?.locale ?? "").trim().toUpperCase();
  const market = String(r?.market ?? "").trim().toUpperCase();
  const exchange = String(
    r?.primary_exchange ??
    r?.exchange ??
    r?.exchange_short_name ??
    ""
  ).trim().toUpperCase();

  return {
    symbol,
    name: name || null,
    exchange: exchange || null,
    type: type || null,
    country: locale || null,
    currency: null,
    market: market || null,
    is_active: true,
    priority: 1,
  };
}

function normalizeInternalRow(r) {
  const symbol = String(r?.symbol ?? "").trim().toUpperCase();
  if (!symbol) return null;

  return {
    symbol,
    name: null,
    exchange: null,
    type: "CS",
    country: "US",
    currency: null,
    market: "STOCKS",
    is_active: true,
    priority: 5,
  };
}

function buildMarketAllowList() {
  const env = String(process.env.UNIVERSE_MARKETS || "").trim();
  if (!env) return new Set(["STOCKS"]);
  return new Set(
    env
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  );
}

function buildLocaleAllowList() {
  const env = String(process.env.UNIVERSE_LOCALES || "").trim();
  if (!env) return new Set(["US"]);
  return new Set(
    env
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  );
}

function buildTypeAllowList() {
  const env = String(process.env.UNIVERSE_TYPES || "").trim();
  if (!env) return new Set(["CS", "COMMON STOCK", "STOCK"]);
  return new Set(
    env
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  );
}

function shouldKeepSymbol(symbol) {
  if (!symbol) return false;
  if (symbol.length > 15) return false;
  if (/\s/.test(symbol)) return false;
  return true;
}

async function tryFetchMassiveTickers(limit = UNIVERSE_LIMIT) {
  if (!MASSIVE_API_KEY) {
    logger.warn("MASSIVE_API_KEY fehlt - nutze internen Universe-Fallback");
    return null;
  }

  const allRows = [];
  let nextUrl = "https://api.massive.com/v3/reference/tickers";
  let pageCount = 0;

  while (nextUrl && allRows.length < limit) {
    try {
      const urlObj = new URL(nextUrl);

      if (!urlObj.searchParams.get("apikey")) {
        urlObj.searchParams.set("apikey", MASSIVE_API_KEY);
      }
      if (!urlObj.searchParams.get("market")) {
        urlObj.searchParams.set("market", "stocks");
      }
      if (!urlObj.searchParams.get("active")) {
        urlObj.searchParams.set("active", "true");
      }
      if (!urlObj.searchParams.get("limit")) {
        urlObj.searchParams.set("limit", String(Math.min(limit, 1000)));
      }

      const finalUrl = urlObj.toString();

      logger.info("Fetching Massive universe list", {
        page: pageCount + 1,
        url: finalUrl,
      });

      const res = await axios.get(finalUrl, {
        timeout: 30000,
        headers: {
          Accept: "application/json",
          "User-Agent": "HQS-Quant-System/8.1.0",
        },
        validateStatus: () => true,
      });

      if (res.status < 200 || res.status >= 300) {
        const preview =
          typeof res.data === "string"
            ? res.data.slice(0, 300)
            : JSON.stringify(res.data || {}).slice(0, 300);

        logger.warn("Massive universe endpoint failed", {
          status: res.status,
          preview,
        });
        return null;
      }

      const rows = Array.isArray(res?.data?.results) ? res.data.results : [];
      allRows.push(...rows);
      pageCount += 1;

      if (allRows.length >= limit) break;

      nextUrl = typeof res?.data?.next_url === "string" ? res.data.next_url : null;
    } catch (error) {
      logger.warn("Massive universe fetch error", {
        message: error.message,
      });
      return null;
    }
  }

  logger.info("Massive universe list loaded", {
    rows: allRows.length,
    pages: pageCount,
  });

  return allRows.slice(0, limit);
}

async function fetchDistinctSymbolsFromTable(tableName, limit) {
  const allowedTables = new Set(["outcome_tracking", "market_snapshots", "hqs_scores"]);
  if (!allowedTables.has(tableName)) return [];

  try {
    const query = `
      SELECT symbol, MAX(created_marker) AS latest_marker
      FROM (
        SELECT
          symbol,
          COALESCE(created_at, NOW()) AS created_marker
        FROM ${tableName}
        WHERE symbol IS NOT NULL
          AND TRIM(symbol) <> ''
      ) t
      GROUP BY symbol
      ORDER BY latest_marker DESC
      LIMIT $1
    `;

    const res = await pool.query(query, [limit]);
    return (res.rows || [])
      .map((row) => String(row.symbol || "").trim().toUpperCase())
      .filter(Boolean);
  } catch (error) {
    logger.warn("Fallback symbol fetch failed", {
      table: tableName,
      message: error.message,
    });
    return [];
  }
}

async function fetchInternalUniverseFallback(limit = FALLBACK_UNIVERSE_LIMIT) {
  logger.info("Building fallback universe from internal tables", { limit });

  const buckets = await Promise.all([
    fetchDistinctSymbolsFromTable("outcome_tracking", limit),
    fetchDistinctSymbolsFromTable("market_snapshots", limit),
    fetchDistinctSymbolsFromTable("hqs_scores", limit),
  ]);

  const merged = [];
  const seen = new Set();

  for (const list of buckets) {
    for (const symbol of list) {
      const normalized = String(symbol || "").trim().toUpperCase();
      if (!normalized) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      merged.push(normalized);
      if (merged.length >= limit) break;
    }
    if (merged.length >= limit) break;
  }

  logger.info("Fallback universe built from internal tables", {
    symbols: merged.length,
  });

  return merged.map((symbol) => normalizeInternalRow({ symbol }));
}

async function refreshUniverse() {
  await initUniverseTables();

  const marketAllow = buildMarketAllowList();
  const localeAllow = buildLocaleAllowList();
  const typeAllow = buildTypeAllowList();

  logger.info("Universe refresh started", {
    markets: Array.from(marketAllow).join(","),
    locales: Array.from(localeAllow).join(","),
    types: Array.from(typeAllow).join(","),
    universeLimit: UNIVERSE_LIMIT,
    fallbackUniverseLimit: FALLBACK_UNIVERSE_LIMIT,
  });

  const massiveRaw = await tryFetchMassiveTickers(UNIVERSE_LIMIT);

  let items = [];

  if (Array.isArray(massiveRaw) && massiveRaw.length) {
    for (const r of massiveRaw) {
      const item = normalizeMassiveRow(r);
      if (!item) continue;

      const market = String(item.market ?? "").toUpperCase();
      const locale = String(item.country ?? "").toUpperCase();
      const type = String(item.type ?? "").toUpperCase();

      if (marketAllow.size && market && !marketAllow.has(market)) continue;
      if (localeAllow.size && locale && !localeAllow.has(locale)) continue;
      if (typeAllow.size && type && !typeAllow.has(type)) continue;
      if (!shouldKeepSymbol(item.symbol)) continue;

      items.push(item);
    }

    logger.info("Universe filtered from Massive", {
      filteredItems: items.length,
    });
  }

  if (!items.length) {
    logger.warn("Massive lieferte keine nutzbaren Universe-Symbole - wechsle auf internen Fallback");
    items = await fetchInternalUniverseFallback(FALLBACK_UNIVERSE_LIMIT);
    items = items.filter((item) => item && shouldKeepSymbol(item.symbol));
  }

  if (!items.length) {
    throw new Error("Universe refresh produced 0 symbols after Massive + internal fallback");
  }

  const { insertedOrUpdated } = await upsertUniverseSymbols(items);
  const activeCount = await countActiveUniverse();

  logger.info("Universe refresh completed", {
    insertedOrUpdated,
    activeCount,
    source: massiveRaw && massiveRaw.length ? "massive" : "internal_fallback",
  });

  return { insertedOrUpdated, activeCount };
}

module.exports = {
  refreshUniverse,
};
