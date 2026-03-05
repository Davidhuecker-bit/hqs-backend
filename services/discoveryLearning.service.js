"use strict";

const { Pool } = require("pg");
const logger = require("../utils/logger");

const {
  getPendingDiscoveries7d,
  getPendingDiscoveries30d,
  updateDiscoveryResult7d,
  updateDiscoveryResult30d,
} = require("./discoveryLearning.repository");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function saveDiscovery(symbol, score, price) {
  const sym = String(symbol || "").trim().toUpperCase();
  const s = Number(score);
  const p = Number(price);

  try {
    await pool.query(
      `
      INSERT INTO discovery_history
        (symbol, discovery_score, price_at_discovery, checked_7d, checked_30d)
      VALUES
        ($1, $2, $3, FALSE, FALSE)
      `,
      [
        sym,
        Number.isFinite(s) ? s : null,
        Number.isFinite(p) ? p : null,
      ]
    );
  } catch (e) {
    logger.warn("saveDiscovery failed", {
      symbol: sym,
      message: e.message,
    });
  }
}

async function evaluateDiscoveries() {
  let done7 = 0;
  let done30 = 0;

  // =========================
  // 7D Evaluation
  // =========================
  const rows7 = await getPendingDiscoveries7d(50);

  for (const row of rows7) {
    try {
      const priceNow = await getCurrentPrice(row.symbol);
      const r7 = calcReturnPct(priceNow, row.price_at_discovery);
      if (r7 === null) continue;

      await updateDiscoveryResult7d(row.id, r7);
      done7++;
    } catch (e) {
      logger.warn("7d evaluation failed", {
        id: row.id,
        symbol: row.symbol,
        message: e.message,
      });
    }
  }

  // =========================
  // 30D Evaluation
  // =========================
  const rows30 = await getPendingDiscoveries30d(50);

  for (const row of rows30) {
    try {
      const priceNow = await getCurrentPrice(row.symbol);
      const r30 = calcReturnPct(priceNow, row.price_at_discovery);
      if (r30 === null) continue;

      await updateDiscoveryResult30d(row.id, r30);
      done30++;
    } catch (e) {
      logger.warn("30d evaluation failed", {
        id: row.id,
        symbol: row.symbol,
        message: e.message,
      });
    }
  }

  logger.info("Discovery evaluation finished", {
    updated7d: done7,
    updated30d: done30,
  });

  return { updated7d: done7, updated30d: done30 };
}

async function getCurrentPrice(symbol) {
  const sym = String(symbol || "").trim().toUpperCase();

  const res = await pool.query(
    `
    SELECT price
    FROM market_snapshots
    WHERE symbol = $1
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [sym]
  );

  if (!res.rows.length) return null;

  const price = Number(res.rows[0].price);
  return Number.isFinite(price) ? price : null;
}

function calcReturnPct(priceNow, priceThen) {
  const now = Number(priceNow);
  const then = Number(priceThen);

  if (!Number.isFinite(now)) return null;
  if (!Number.isFinite(then) || then <= 0) return null;

  return ((now - then) / then) * 100;
}

module.exports = {
  saveDiscovery,
  evaluateDiscoveries,
};
