"use strict";

/**
 * One-off Backfill Job: backfillSnapshotFx
 * ─────────────────────────────────────────
 * Converts legacy market_snapshots rows that were stored with currency='USD'
 * and fx_rate IS NULL before the EUR write-path was introduced.
 *
 * Strategy (defensive, non-destructive):
 *   1. Find rows WHERE currency = 'USD' AND fx_rate IS NULL
 *   2. For each row, compute a best-effort FX rate:
 *        a. Last known stored fx_rate from a EUR-converted snapshot (most recent)
 *        b. Static env FX_STATIC_USD_EUR (manual override)
 *        c. Skip row if no rate available
 *   3. UPDATE:
 *        price_usd = price   (preserve original USD value)
 *        price     = price * rate  (EUR equivalent)
 *        fx_rate   = rate
 *        currency  = 'EUR'
 *   4. Log summary at end
 *
 * Safe to re-run: the WHERE clause skips already-converted rows.
 *
 * Required ENV:
 *   DATABASE_URL
 *
 * Optional ENV:
 *   FX_STATIC_USD_EUR  – static fallback rate (e.g. 0.92)
 *   BACKFILL_BATCH_SIZE – rows per batch (default: 500)
 *   BACKFILL_DRY_RUN    – set to "true" to preview without writing
 */

require("dotenv").config();

const { Pool } = require("pg");
const logger = require("../utils/logger");
const { runJob } = require("../utils/jobRunner");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const BATCH_SIZE = Number(process.env.BACKFILL_BATCH_SIZE || 500);
const DRY_RUN = String(process.env.BACKFILL_DRY_RUN || "").toLowerCase() === "true";

const PRICE_PRECISION_FACTOR = 1_000_000;

function isValidRate(r) {
  return Number.isFinite(r) && r > 0;
}

function roundPrice(n) {
  return Math.round(n * PRICE_PRECISION_FACTOR) / PRICE_PRECISION_FACTOR;
}

/**
 * Returns the most recently stored non-null fx_rate from market_snapshots
 * (a EUR-converted row written by the new write path).
 */
async function loadLastKnownFxRate() {
  const res = await pool.query(
    `SELECT fx_rate FROM market_snapshots
     WHERE fx_rate IS NOT NULL
       AND currency = 'EUR'
     ORDER BY created_at DESC
     LIMIT 1`
  );
  if (!res.rows.length) return null;
  const r = Number(res.rows[0].fx_rate);
  return isValidRate(r) ? r : null;
}

async function countLegacyRows() {
  const res = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM market_snapshots
     WHERE currency = 'USD'
       AND fx_rate IS NULL`
  );
  return Number(res.rows[0]?.cnt || 0);
}

async function runBackfill() {
  logger.info("backfillSnapshotFx: start", { dryRun: DRY_RUN, batchSize: BATCH_SIZE });

  // Determine rate to use
  let fxRate = null;

  // 1. Try last known stored rate from EUR-converted snapshots
  const storedRate = await loadLastKnownFxRate();
  if (isValidRate(storedRate)) {
    fxRate = storedRate;
    logger.info("backfillSnapshotFx: using last-stored fx_rate from EUR snapshot", { fxRate });
  }

  // 2. Try static env fallback
  if (!isValidRate(fxRate)) {
    const staticRate =
      process.env.FX_STATIC_USD_EUR !== undefined
        ? Number(process.env.FX_STATIC_USD_EUR)
        : null;
    if (isValidRate(staticRate)) {
      fxRate = staticRate;
      logger.info("backfillSnapshotFx: using FX_STATIC_USD_EUR env rate", { fxRate });
    }
  }

  if (!isValidRate(fxRate)) {
    logger.error(
      "backfillSnapshotFx: no usable FX rate available. " +
      "Set FX_STATIC_USD_EUR env var or run after the new snapshot write path " +
      "has stored at least one EUR-converted snapshot.",
      { fxRate }
    );
    return { updated: 0, skipped: 0, error: "no_fx_rate" };
  }

  const totalLegacy = await countLegacyRows();
  logger.info("backfillSnapshotFx: legacy USD rows found", { totalLegacy, fxRate, dryRun: DRY_RUN });

  if (totalLegacy === 0) {
    logger.info("backfillSnapshotFx: nothing to do – no legacy USD rows");
    return { updated: 0, skipped: 0 };
  }

  if (DRY_RUN) {
    logger.info("backfillSnapshotFx: DRY_RUN=true – would update rows", {
      totalLegacy,
      fxRate,
    });
    return { updated: 0, skipped: totalLegacy, dryRun: true };
  }

  let totalUpdated = 0;
  let totalSkipped = 0;

  // Process in batches to avoid locking too many rows at once
  let offset = 0;
  while (true) {
    const batchRes = await pool.query(
      `SELECT id, symbol, price
       FROM market_snapshots
       WHERE currency = 'USD'
         AND fx_rate IS NULL
         AND price IS NOT NULL
         AND price > 0
       ORDER BY created_at ASC
       LIMIT $1 OFFSET $2`,
      [BATCH_SIZE, offset]
    );

    const rows = batchRes.rows;
    if (!rows.length) break;

    let batchUpdated = 0;
    let batchSkipped = 0;

    for (const row of rows) {
      const priceUsd = Number(row.price);
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
        batchSkipped++;
        continue;
      }

      const priceEur = roundPrice(priceUsd * fxRate);
      if (!Number.isFinite(priceEur) || priceEur <= 0) {
        batchSkipped++;
        continue;
      }

      await pool.query(
        `UPDATE market_snapshots
         SET price     = $1,
             price_usd = $2,
             fx_rate   = $3,
             currency  = 'EUR'
         WHERE id = $4
           AND currency = 'USD'
           AND fx_rate IS NULL`,
        [priceEur, priceUsd, fxRate, row.id]
      );

      batchUpdated++;
    }

    totalUpdated += batchUpdated;
    totalSkipped += batchSkipped;
    offset += rows.length;

    logger.info("backfillSnapshotFx: batch done", {
      batchSize: rows.length,
      batchUpdated,
      batchSkipped,
      totalUpdated,
    });

    // Stop if batch was smaller than BATCH_SIZE (last batch)
    if (rows.length < BATCH_SIZE) break;
  }

  logger.info("backfillSnapshotFx: complete", {
    totalLegacy,
    totalUpdated,
    totalSkipped,
    fxRate,
    dryRun: DRY_RUN,
  });

  return { updated: totalUpdated, skipped: totalSkipped };
}

async function run() {
  await runJob(
    "backfillSnapshotFx",
    async () => {
      const result = await runBackfill();
      logger.info("backfillSnapshotFx: job finished", result);
    },
    { pool, dbRetries: 3, dbDelayMs: 2000 }
  );
}

run()
  .then(() => {
    pool.end().catch(() => {});
    process.exit(0);
  })
  .catch((err) => {
    logger.error("backfillSnapshotFx job failed", {
      message: err?.message || String(err),
      stack: err?.stack,
    });
    pool.end().catch(() => {});
    process.exit(1);
  });
