"use strict";

// services/universe.service.js
// Lädt 1x täglich eine Symbol-Liste (Universe) und speichert sie in DB.
// Standard: FMP stock list (US Universe). Später erweiterbar auf Global.

const axios = require("axios");
const logger = require("../utils/logger");

const {
  initUniverseTables,
  upsertUniverseSymbols,
  countActiveUniverse,
} = require("./universe.repository");

const FMP_API_KEY = process.env.FMP_API_KEY;

function normalizeFmpRow(r) {
  const symbol = String(r?.symbol ?? "").trim().toUpperCase();
  if (!symbol) return null;

  const type = String(r?.type ?? "").trim();
  const exchange = String(r?.exchangeShortName ?? r?.exchange ?? "").trim();
  const name = String(r?.name ?? "").trim();
  const country = String(r?.country ?? "").trim();
  const currency = String(r?.currency ?? "").trim();

  return {
    symbol,
    name: name || null,
    exchange: exchange || null,
    type: type || null,
    country: country || null,
    currency: currency || null,
    is_active: true,
    priority: 1,
  };
}

function buildExchangeAllowList() {
  const env = String(process.env.UNIVERSE_EXCHANGES || "").trim();
  if (!env) return new Set(["NASDAQ", "NYSE", "AMEX"]);
  return new Set(
    env
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  );
}

function buildTypeAllowList() {
  const env = String(process.env.UNIVERSE_TYPES || "").trim();
  if (!env) return new Set(["STOCK"]);
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

async function fetchFmpStockList() {
  if (!FMP_API_KEY) throw new Error("Missing FMP_API_KEY");

  const url = `https://financialmodelingprep.com/stable/stock-list?apikey=${encodeURIComponent(
    FMP_API_KEY
  )}`;

  logger.info("Fetching FMP universe list", {
    endpoint: "stable/stock-list",
  });

  const res = await axios.get(url, {
    timeout: 30000,
    headers: {
      Accept: "application/json",
      "User-Agent": "HQS-Quant-System/8.1.0",
    },
    validateStatus: () => true,
  });

  if (res.status === 401 || res.status === 403) {
    const preview =
      typeof res.data === "string"
        ? res.data.slice(0, 300)
        : JSON.stringify(res.data || {}).slice(0, 300);

    throw new Error(
      `FMP stable/stock-list access denied (${res.status}) preview=${preview}`
    );
  }

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`FMP stable/stock-list failed with status ${res.status}`);
  }

  const data = res?.data;

  if (!Array.isArray(data)) {
    const preview =
      typeof data === "string"
        ? data.slice(0, 300)
        : JSON.stringify(data || {}).slice(0, 300);

    throw new Error(
      `FMP stable/stock-list returned non-array response preview=${preview}`
    );
  }

  return data;
}

/**
 * Refresh Universe into DB.
 * Default scope: US (NASDAQ/NYSE/AMEX) common stocks.
 */
async function refreshUniverse() {
  await initUniverseTables();

  const exchangeAllow = buildExchangeAllowList();
  const typeAllow = buildTypeAllowList();

  logger.info("Universe refresh started", {
    exchanges: Array.from(exchangeAllow).join(","),
    types: Array.from(typeAllow).join(","),
  });

  const raw = await fetchFmpStockList();

  const items = [];
  for (const r of raw) {
    const item = normalizeFmpRow(r);
    if (!item) continue;

    const ex = String(item.exchange ?? "").toUpperCase();
    const ty = String(item.type ?? "").toUpperCase();

    if (exchangeAllow.size && !exchangeAllow.has(ex)) continue;
    if (typeAllow.size && !typeAllow.has(ty)) continue;
    if (!shouldKeepSymbol(item.symbol)) continue;

    items.push(item);
  }

  if (!items.length) {
    throw new Error("Universe refresh produced 0 symbols after filters");
  }

  const { insertedOrUpdated } = await upsertUniverseSymbols(items);
  const activeCount = await countActiveUniverse();

  logger.info("Universe refresh completed", {
    insertedOrUpdated,
    activeCount,
  });

  return { insertedOrUpdated, activeCount };
}

module.exports = {
  refreshUniverse,
};
