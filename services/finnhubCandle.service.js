// services/finnhubCandle.service.js
const axios = require("axios");

const API_KEY = process.env.FINNHUB_API_KEY;
const BASE_URL = "https://finnhub.io/api/v1";

function toUnixSeconds(date) {
  return Math.floor(date.getTime() / 1000);
}

async function fetchDailyCandles(symbol, fromUnix, toUnix) {
  if (!API_KEY) {
    console.error("❌ FINNHUB_API_KEY fehlt für Candle Service.");
    return null;
  }

  const safeSymbol = String(symbol || "").trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,12}$/.test(safeSymbol)) return null;

  const url =
    `${BASE_URL}/stock/candle?symbol=${safeSymbol}` +
    `&resolution=D&from=${fromUnix}&to=${toUnix}&token=${API_KEY}`;

  try {
    const res = await axios.get(url, { timeout: 12000 });
    const data = res.data;

    // Finnhub: { s:"ok", t:[], o:[], h:[], l:[], c:[], v:[] }
    if (!data || data.s !== "ok" || !Array.isArray(data.t) || data.t.length === 0) {
      console.warn(`⚠️ Finnhub Candle: keine Daten für ${safeSymbol}`);
      return [];
    }

    return data.t.map((t, i) => ({
      date: new Date(t * 1000).toISOString().slice(0, 10), // YYYY-MM-DD
      open: Number(data.o?.[i] ?? null),
      high: Number(data.h?.[i] ?? null),
      low: Number(data.l?.[i] ?? null),
      close: Number(data.c?.[i] ?? null),
      volume: Number(data.v?.[i] ?? null),
    }));
  } catch (err) {
    console.error(`❌ Finnhub Candle Error (${safeSymbol}):`, err.message);
    return null;
  }
}

module.exports = {
  fetchDailyCandles,
  toUnixSeconds,
};
