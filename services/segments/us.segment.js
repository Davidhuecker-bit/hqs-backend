"use strict";

// services/usSegmentService.js
// Schlanker US-Service ohne feste Aktienlisten.
// Massive-first über marketService/getMarketData.
// Die Symbolauswahl kommt aus Universe/DB oder wird direkt übergeben.

const { getMarketData } = require("./marketService");

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function uniqueSymbols(list = []) {
  return [...new Set(list.map(normalizeSymbol).filter(Boolean))];
}

async function getUSData(symbol) {
  const safeSymbol = normalizeSymbol(symbol);
  const timestamp = new Date().toISOString();

  if (!safeSymbol) {
    return {
      success: false,
      segment: "usa",
      provider: null,
      symbol: null,
      data: null,
      fallbackUsed: false,
      error: "Symbol fehlt",
      timestamp,
    };
  }

  try {
    const rows = await getMarketData(safeSymbol);
    const item = Array.isArray(rows) && rows.length ? rows[0] : null;

    if (!item) {
      return {
        success: false,
        segment: "usa",
        provider: "massive",
        symbol: safeSymbol,
        data: null,
        fallbackUsed: false,
        error: `Keine US-Daten für ${safeSymbol} gefunden`,
        timestamp,
      };
    }

    return {
      success: true,
      segment: "usa",
      provider: String(item.source || "massive").toLowerCase(),
      symbol: safeSymbol,
      data: item,
      fallbackUsed: false,
      timestamp,
    };
  } catch (error) {
    return {
      success: false,
      segment: "usa",
      provider: null,
      symbol: safeSymbol,
      data: null,
      fallbackUsed: false,
      error: error.message,
      timestamp,
    };
  }
}

async function getUSMarketData(symbols = []) {
  const safeSymbols = uniqueSymbols(symbols);

  if (!safeSymbols.length) return [];

  const settled = await Promise.allSettled(
    safeSymbols.map((symbol) => getMarketData(symbol))
  );

  const results = [];

  for (let i = 0; i < settled.length; i += 1) {
    const entry = settled[i];
    const symbol = safeSymbols[i];

    if (entry.status !== "fulfilled") {
      console.warn(
        `[usSegmentService] Fehler bei ${symbol}:`,
        entry.reason?.message || entry.reason
      );
      continue;
    }

    const rows = entry.value;
    const item = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (!item) continue;

    results.push({
      ...item,
      symbol,
      segment: "usa",
      provider: String(item.source || "massive").toLowerCase(),
    });
  }

  return results;
}

module.exports = {
  getUSData,
  getUSMarketData,
};
