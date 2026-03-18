"use strict";

/*
  Forward Learning Service (v2) - STABIL / DB-SAFE
  ------------------------------------------------------------
  Zweck:
  - Nimmt factor_history Einträge (Einzelaktien) ohne Forward-Label
  - Sucht einen "Basis-Snapshot" nach MIN_DELAY Minuten
  - Berechnet Forward Returns (1d / 3d) als Prozent ab BASIS-SNAPSHOT
  - Schreibt Labels zurück in factor_history via updateForwardReturns(rowId, ret1d, ret3d)

  Wichtig:
  - Keine neuen Tabellen
  - Läuft safe: wenn Daten fehlen -> skip
*/

const { Pool } = require("pg");
const logger = require("../utils/logger");
const { updateForwardReturns } = require("./factorHistory.repository");
const { getUsdToEurRate, convertUsdToEur } = require("./fx.service");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Wie viele offene Records pro Run bearbeiten
const DEFAULT_LIMIT = Number(process.env.FORWARD_LEARNING_LIMIT || 40);

// Minimaler Abstand in Minuten zwischen factor_history Event und "Basis-Snapshot"
const MIN_DELAY_MINUTES = Number(process.env.FORWARD_LEARNING_MIN_DELAY_MINUTES || 10);

function toMsMinutes(minutes) {
  const m = Number(minutes);
  return (Number.isFinite(m) && m > 0 ? m : 0) * 60 * 1000;
}

function percentChange(oldPrice, newPrice) {
  const o = Number(oldPrice);
  const n = Number(newPrice);
  if (!Number.isFinite(o) || !Number.isFinite(n) || o <= 0) return null;
  return ((n - o) / o) * 100;
}

function toIso(dt) {
  try {
    return new Date(dt).toISOString();
  } catch {
    return null;
  }
}

/**
 * Resolves the EUR price from a market_snapshots row.
 * New snapshots already store EUR; legacy USD rows are converted using the
 * stored fx_rate (audit trail) or the current live rate as fallback.
 *
 * For legacy rows: price_usd is NULL (old write path never set it), so
 * we use price as the USD base — that IS the original USD value for those rows.
 */
async function _resolveEurPrice(row) {
  if (!row) return null;
  const currency = String(row.currency || "EUR").toUpperCase();
  if (currency !== "USD") {
    const p = Number(row.price);
    return Number.isFinite(p) && p > 0 ? p : null;
  }
  // Legacy USD snapshot: price_usd holds the original USD value on new rows;
  // on pre-fix rows price_usd is NULL and price IS the USD value.
  const priceUsdField = row.price_usd !== null ? Number(row.price_usd) : null;
  const base = priceUsdField !== null && Number.isFinite(priceUsdField)
    ? priceUsdField
    : Number(row.price); // pre-fix legacy: price field contains USD
  if (!Number.isFinite(base) || base <= 0) return null;
  const storedRate = row.fx_rate !== null ? Number(row.fx_rate) : null;
  const rate = (storedRate !== null && Number.isFinite(storedRate) && storedRate > 0)
    ? storedRate
    : await getUsdToEurRate().catch(() => null);
  const eur = convertUsdToEur(base, rate);
  return eur !== null && eur > 0 ? eur : null;
}

async function findFirstSnapshotAtOrAfter(symbol, isoTime) {
  const res = await pool.query(
    `
    SELECT price, price_usd, currency, fx_rate, created_at
    FROM market_snapshots
    WHERE symbol = $1
      AND created_at >= $2
    ORDER BY created_at ASC
    LIMIT 1
    `,
    [symbol, isoTime]
  );

  return res.rows?.[0] || null;
}

async function runForwardLearning() {
  try {
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

    const rows = baseRows.rows || [];
    if (!rows.length) {
      logger.info("Forward learning: nothing to update");
      return { updated: 0 };
    }

    let updated = 0;

    for (const row of rows) {
      const rowId = Number(row.id);
      const symbol = String(row.symbol || "").trim().toUpperCase();
      if (!Number.isFinite(rowId) || rowId <= 0 || !symbol) continue;

      const createdAt = new Date(row.created_at);
      const baseTimeMs = createdAt.getTime();
      if (!Number.isFinite(baseTimeMs)) continue;

      // 1) Basis-Zeitpunkt: created_at + MIN_DELAY
      const baseSnapshotMinTime = new Date(baseTimeMs + toMsMinutes(MIN_DELAY_MINUTES));
      const baseMinIso = toIso(baseSnapshotMinTime);
      if (!baseMinIso) continue;

      // 2) Basis-Snapshot finden
      const baseSnap = await findFirstSnapshotAtOrAfter(symbol, baseMinIso);
      if (!baseSnap) continue;

      const basePrice = await _resolveEurPrice(baseSnap);
      const baseSnapTime = new Date(baseSnap.created_at);
      const baseSnapMs = baseSnapTime.getTime();

      if (basePrice === null || !Number.isFinite(basePrice) || basePrice <= 0) continue;
      if (!Number.isFinite(baseSnapMs)) continue;

      // 3) Targets ab BASIS-SNAPSHOT (wichtig!)
      const t1dIso = toIso(new Date(baseSnapMs + 24 * 60 * 60 * 1000));
      const t3dIso = toIso(new Date(baseSnapMs + 72 * 60 * 60 * 1000));
      if (!t1dIso || !t3dIso) continue;

      const snap1d = await findFirstSnapshotAtOrAfter(symbol, t1dIso);
      const snap3d = await findFirstSnapshotAtOrAfter(symbol, t3dIso);

      const price1d = snap1d ? await _resolveEurPrice(snap1d) : null;
      const price3d = snap3d ? await _resolveEurPrice(snap3d) : null;

      const ret1d = price1d !== null ? percentChange(basePrice, price1d) : null;
      const ret3d = price3d !== null ? percentChange(basePrice, price3d) : null;

      // 4) Nur speichern wenn wir überhaupt was berechnen konnten
      if (ret1d === null && ret3d === null) continue;

      await updateForwardReturns(rowId, ret1d, ret3d);
      updated++;

      logger.info("Forward learning updated", {
        id: rowId,
        symbol,
        basePrice,
        baseSnapAt: toIso(baseSnap.created_at),
        ret1d,
        ret3d,
      });
    }

    logger.info("Forward learning done", { updated });
    return { updated };
  } catch (err) {
    logger.error("Forward learning fatal", { message: err.message });
    return { updated: 0, error: err.message };
  }
}

module.exports = { runForwardLearning };
