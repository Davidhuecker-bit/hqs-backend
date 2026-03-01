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
  const o = Number(oldPrice);
  const n = Number(newPrice);
  if (!Number.isFinite(o) || !Number.isFinite(n) || o === 0) return null;
  return ((n - o) / o) * 100;
}

/* =========================================================
   FORWARD RETURN LABELING
   - Labelt forward_return_1d und forward_return_3d
   - Updatet per factor_history.id (sicher!)
========================================================= */

async function runForwardLearning() {
  try {
    const baseRows = await pool.query(
      `
      SELECT id, symbol, created_at
      FROM factor_history
      WHERE symbol <> 'PORTFOLIO'
        AND (forward_return_1d IS NULL OR forward_return_3d IS NULL)
      ORDER BY created_at ASC
      LIMIT 200
      `
    );

    if (!baseRows.rows.length) return;

    for (const row of baseRows.rows) {
      const symbol = String(row.symbol || "").trim().toUpperCase();
      if (!symbol) continue;

      const baseTime = new Date(row.created_at).getTime();
      if (!Number.isFinite(baseTime)) continue;

      // Wir holen nur das benötigte Zeitfenster (0..4 Tage nach baseTime)
      const windowEnd = baseTime + 96 * 60 * 60 * 1000;

      const snapshots = await pool.query(
        `
        SELECT price, created_at
        FROM market_snapshots
        WHERE symbol = $1
          AND created_at >= to_timestamp($2 / 1000.0)
          AND created_at <= to_timestamp($3 / 1000.0)
        ORDER BY created_at ASC
        `,
        [symbol, baseTime, windowEnd]
      );

      if (!snapshots.rows.length) continue;

      // Base Snapshot: erster Snapshot ab baseTime
      const baseSnapshot = snapshots.rows.find(
        (s) => new Date(s.created_at).getTime() >= baseTime
      );
      if (!baseSnapshot) continue;

      const basePrice = Number(baseSnapshot.price);
      if (!Number.isFinite(basePrice) || basePrice === 0) continue;

      // 1D / 3D Snapshot: erster Snapshot ab baseTime + offset
      const oneDaySnapshot = snapshots.rows.find(
        (s) => new Date(s.created_at).getTime() >= baseTime + 24 * 60 * 60 * 1000
      );

      const threeDaySnapshot = snapshots.rows.find(
        (s) => new Date(s.created_at).getTime() >= baseTime + 72 * 60 * 60 * 1000
      );

      const forward1d = oneDaySnapshot
        ? percentChange(basePrice, Number(oneDaySnapshot.price))
        : null;

      const forward3d = threeDaySnapshot
        ? percentChange(basePrice, Number(threeDaySnapshot.price))
        : null;

      // Nur updaten, wenn wir etwas haben
      if (forward1d !== null || forward3d !== null) {
        await updateForwardReturns(row.id, forward1d, forward3d);
      }
    }

    console.log("🧠 Forward Learning updated");
  } catch (err) {
    console.error("❌ Forward Learning Error:", err.message);
  }
}

module.exports = { runForwardLearning };
