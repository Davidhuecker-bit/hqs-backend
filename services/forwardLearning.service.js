"use strict";

/*
  Forward Learning Service (v1)
  ------------------------------------------------------------
  Zweck:
  - Nimmt factor_history Einträge (Einzelaktien) ohne Forward-Label
  - Sucht zugehörige market_snapshots Preise
  - Berechnet Forward Returns (1h / 1d / 3d) als Prozent
  - Schreibt Labels zurück in factor_history

  Wichtig:
  - Keine neuen Tabellen
  - Nutzt dein factorHistory.repository updateForwardReturns()
  - Läuft "safe": wenn Daten fehlen -> skip
*/

const { Pool } = require("pg");
const { updateForwardReturns } = require("./factorHistory.repository");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Wie viele offene Records pro Run bearbeiten
const DEFAULT_LIMIT = Number(process.env.FORWARD_LEARNING_LIMIT || 40);

// Minimaler Abstand in Minuten zwischen factor_history Event und "Basis-Snapshot"
const MIN_DELAY_MINUTES = Number(process.env.FORWARD_LEARNING_MIN_DELAY_MINUTES || 10);

// Hilfsfunktion
function percentChange(oldPrice, newPrice) {
  const o = Number(oldPrice);
  const n = Number(newPrice);
  if (!Number.isFinite(o) || !Number.isFinite(n) || o <= 0) return null;
  return ((n - o) / o) * 100;
}

function toMs(minutes) {
  return Math.max(0, Number(minutes) || 0) * 60 * 1000;
}

async function runForwardLearning() {
  try {
    // 1) Kandidaten suchen (nur EINZELAKTIEN, nicht PORTFOLIO)
    const baseRows = await pool.query(
      `
      SELECT id, symbol, created_at
      FROM factor_history
      WHERE symbol <> 'PORTFOLIO'
        AND (forward_return_1d IS NULL OR forward_return_3d IS NULL)
      ORDER BY created_at ASC
      LIMIT $1
      `,
      [DEFAULT_LIMIT]
    );

    if (!baseRows.rows.length) return;

    for (const row of baseRows.rows) {
      const rowId = Number(row.id);
      const symbol = String(row.symbol || "").trim().toUpperCase();
      if (!rowId || !symbol) continue;

      const baseTime = new Date(row.created_at).getTime();
      if (!Number.isFinite(baseTime)) continue;

      // 2) Snapshots laden (aufsteigend)
      const snapsRes = await pool.query(
        `
        SELECT price, created_at
        FROM market_snapshots
        WHERE symbol = $1
        ORDER BY created_at ASC
        `,
        [symbol]
      );

      const snapshots = snapsRes.rows || [];
      if (!snapshots.length) continue;

      // 3) Basis-Snapshot finden:
      //    - frühester Snapshot, der >= created_at + MIN_DELAY ist
      const baseSnapshotMinTime = baseTime + toMs(MIN_DELAY_MINUTES);

      const baseSnapshot = snapshots.find((s) => {
        const t = new Date(s.created_at).getTime();
        return Number.isFinite(t) && t >= baseSnapshotMinTime;
      });

      if (!baseSnapshot) continue;

      const basePrice = Number(baseSnapshot.price);
      if (!Number.isFinite(basePrice) || basePrice <= 0) continue;

      // 4) Ziel-Zeitpunkte
      const t1h = baseTime + 1 * 60 * 60 * 1000;
      const t1d = baseTime + 24 * 60 * 60 * 1000;
      const t3d = baseTime + 72 * 60 * 60 * 1000;

      // 5) Zielsnapshots suchen (erster Snapshot >= targetTime)
      const snap1h = snapshots.find((s) => new Date(s.created_at).getTime() >= t1h);
      const snap1d = snapshots.find((s) => new Date(s.created_at).getTime() >= t1d);
      const snap3d = snapshots.find((s) => new Date(s.created_at).getTime() >= t3d);

      // 6) Returns berechnen
      const ret1h = snap1h ? percentChange(basePrice, Number(snap1h.price)) : null;
      const ret1d = snap1d ? percentChange(basePrice, Number(snap1d.price)) : null;
      const ret3d = snap3d ? percentChange(basePrice, Number(snap3d.price)) : null;

      // 7) Schreiben:
      // - 1d/3d via NEUEM Interface (rowId, forward1d, forward3d)
      // - 1h optional via ALTEM Interface (symbol, 1, ret1h)
      if (ret1d !== null || ret3d !== null) {
        await updateForwardReturns(rowId, ret1d, ret3d);
      }

      if (ret1h !== null) {
        await updateForwardReturns(symbol, 1, ret1h);
      }
    }

    console.log("🧠 Forward Learning updated");
  } catch (err) {
    console.error("❌ Forward Learning Error:", err.message);
  }
}

module.exports = { runForwardLearning };
