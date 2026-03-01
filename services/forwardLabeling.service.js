"use strict";

const { Pool } = require("pg");
const { updateForwardReturns } = require("./factorHistory.repository");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function percentChange(oldPrice, newPrice) {
  if (!oldPrice || !newPrice) return null;
  return ((newPrice - oldPrice) / oldPrice) * 100;
}

async function runForwardLabeling() {
  try {

    const rows = await pool.query(`
      SELECT id, symbol, created_at
      FROM factor_history
      WHERE forward_return_1h IS NULL
      ORDER BY created_at ASC
      LIMIT 200
    `);

    if (!rows.rows.length) return;

    for (const row of rows.rows) {

      const priceResult = await pool.query(`
        SELECT price, created_at
        FROM market_snapshots
        WHERE symbol = $1
        ORDER BY created_at ASC
      `, [row.symbol]);

      if (!priceResult.rows.length) continue;

      const snapshotList = priceResult.rows;

      const baseSnapshot = snapshotList.find(
        s => new Date(s.created_at).getTime() >= new Date(row.created_at).getTime()
      );

      if (!baseSnapshot) continue;

      const baseTime = new Date(baseSnapshot.created_at).getTime();
      const basePrice = Number(baseSnapshot.price);

      const oneHour = snapshotList.find(
        s => new Date(s.created_at).getTime() >= baseTime + 60 * 60 * 1000
      );

      const oneDay = snapshotList.find(
        s => new Date(s.created_at).getTime() >= baseTime + 24 * 60 * 60 * 1000
      );

      const threeDay = snapshotList.find(
        s => new Date(s.created_at).getTime() >= baseTime + 72 * 60 * 60 * 1000
      );

      if (oneHour) {
        await updateForwardReturns(row.symbol, 1,
          percentChange(basePrice, Number(oneHour.price))
        );
      }

      if (oneDay) {
        await updateForwardReturns(row.symbol, 24,
          percentChange(basePrice, Number(oneDay.price))
        );
      }

      if (threeDay) {
        await updateForwardReturns(row.symbol, 72,
          percentChange(basePrice, Number(threeDay.price))
        );
      }
    }

    console.log("🧠 Forward labeling updated");

  } catch (err) {
    console.error("❌ Forward labeling error:", err.message);
  }
}

module.exports = { runForwardLabeling };
