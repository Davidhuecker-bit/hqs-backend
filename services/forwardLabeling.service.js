"use strict";

const { Pool } = require("pg");
const { updateForwardReturns } = require("./factorHistory.repository");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =========================================================
   HELPER
========================================================= */

function percentChange(oldPrice, newPrice) {
  if (!oldPrice || !newPrice) return null;
  return ((newPrice - oldPrice) / oldPrice) * 100;
}

/* =========================================================
   FORWARD RETURN LABELING
========================================================= */

async function runForwardLearning() {
  try {

    const baseRows = await pool.query(`
      SELECT id, symbol, created_at
      FROM factor_history
      WHERE forward_return_1d IS NULL
      ORDER BY created_at ASC
      LIMIT 200
    `);

    if (!baseRows.rows.length) return;

    for (const row of baseRows.rows) {

      const snapshots = await pool.query(`
        SELECT price, created_at
        FROM market_snapshots
        WHERE symbol = $1
        ORDER BY created_at ASC
      `, [row.symbol]);

      if (!snapshots.rows.length) continue;

      const baseTime = new Date(row.created_at).getTime();

      const baseSnapshot = snapshots.rows.find(
        s => new Date(s.created_at).getTime() >= baseTime
      );

      if (!baseSnapshot) continue;

      const basePrice = Number(baseSnapshot.price);

      const oneDaySnapshot = snapshots.rows.find(
        s => new Date(s.created_at).getTime() >= baseTime + 24 * 60 * 60 * 1000
      );

      const threeDaySnapshot = snapshots.rows.find(
        s => new Date(s.created_at).getTime() >= baseTime + 72 * 60 * 60 * 1000
      );

      if (oneDaySnapshot) {
        await updateForwardReturns(
          row.symbol,
          24,
          percentChange(basePrice, Number(oneDaySnapshot.price))
        );
      }

      if (threeDaySnapshot) {
        await updateForwardReturns(
          row.symbol,
          72,
          percentChange(basePrice, Number(threeDaySnapshot.price))
        );
      }
    }

    console.log("🧠 Forward Learning updated");

  } catch (err) {
    console.error("❌ Forward Learning Error:", err.message);
  }
}

module.exports = { runForwardLearning };
