"use strict";

/*
  Portfolio Twin Service – Minimal Capital Twin (Stage 1)
  --------------------------------------------------------
  Virtual portfolio tracking layer.  No broker, no real trades.
  Only re-uses existing DB infrastructure (market_snapshots) and
  existing allocation fields from capitalAllocation.service.js.

  Functions exported:
    ensureVirtualPositionsTable()
    openVirtualPositionFromAllocation(data)
    refreshOpenVirtualPositions()
    closeVirtualPosition(id, reason)
    getPortfolioTwinSnapshot()

  Design rules followed:
    - no new external API calls
    - no new background jobs
    - price refresh reads from market_snapshots (already populated by snapshot pipeline)
    - stateless pure helpers, all state in DB
*/

const { Pool } = require("pg");
const logger   = require("../utils/logger");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =========================================================
   TABLE INIT
========================================================= */

async function ensureVirtualPositionsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS virtual_positions (
      id                    BIGSERIAL    PRIMARY KEY,
      symbol                TEXT         NOT NULL,
      status                TEXT         NOT NULL DEFAULT 'open'
                              CHECK (status IN ('open', 'closed')),

      entry_price           NUMERIC(18,6) NOT NULL,
      current_price         NUMERIC(18,6),
      allocated_eur         NUMERIC(14,4) NOT NULL,
      allocated_pct         NUMERIC(8,4)  NOT NULL,

      conviction_tier       TEXT,
      risk_mode_at_entry    TEXT,
      uncertainty_at_entry  NUMERIC(6,4),

      opened_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      closed_at             TIMESTAMPTZ,
      exit_price            NUMERIC(18,6),
      pnl_eur               NUMERIC(14,4),
      pnl_pct               NUMERIC(8,4),
      close_reason          TEXT,
      source_run_id         TEXT
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_virtual_positions_symbol
    ON virtual_positions (symbol, status, opened_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_virtual_positions_status
    ON virtual_positions (status, opened_at DESC);
  `);

  // Unique partial index: prevent duplicate open positions for the same symbol.
  // This is the DB-level guard against race conditions in the auto-open flow.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_virtual_positions_unique_open_symbol
    ON virtual_positions (symbol)
    WHERE status = 'open';
  `);

  logger.info("virtual_positions table ready");
}

/* =========================================================
   HELPERS
========================================================= */

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Fetch the latest stored price for a symbol from market_snapshots.
 * Zero external API cost – reads from data already in the DB.
 */
async function _latestStoredPrice(symbol) {
  try {
    const res = await pool.query(
      `SELECT price FROM market_snapshots
       WHERE symbol = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [String(symbol).trim().toUpperCase()]
    );
    if (!res.rows.length) return null;
    const p = Number(res.rows[0].price);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch (err) {
    logger.warn("portfolioTwin: _latestStoredPrice failed", { symbol, message: err.message });
    return null;
  }
}

function _calcPnl(allocatedEur, entryPrice, currentPrice) {
  if (!entryPrice || !currentPrice || entryPrice <= 0) {
    return { pnlEur: 0, pnlPct: 0 };
  }
  const pnlPct = (currentPrice - entryPrice) / entryPrice;
  const pnlEur = allocatedEur * pnlPct;
  return {
    pnlEur: Math.round(pnlEur * 100) / 100,
    pnlPct: Math.round(pnlPct * 10000) / 10000,
  };
}

/* =========================================================
   DUPLICATE GUARD
========================================================= */

/**
 * Returns true if there is already an open virtual position for the given symbol.
 * Used as a guard before openVirtualPositionFromAllocation to prevent duplicates.
 *
 * @param {string} symbol
 * @returns {Promise<boolean>}
 */
async function hasOpenVirtualPosition(symbol) {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) return false;
  try {
    const res = await pool.query(
      `SELECT 1 FROM virtual_positions
       WHERE symbol = $1 AND status = 'open'
       LIMIT 1`,
      [sym]
    );
    return res.rows.length > 0;
  } catch (err) {
    logger.warn("portfolioTwin: hasOpenVirtualPosition check failed", { symbol: sym, message: err.message });
    // Fail-safe: return true to prevent accidental duplicate insertion on DB error
    return true;
  }
}

/* =========================================================
   OPEN A VIRTUAL POSITION
========================================================= */

/**
 * Opens a new virtual position from a capitalAllocation result.
 *
 * @param {object} data
 *   symbol            {string}  – ticker
 *   entryPrice        {number}  – price at which the virtual position is "entered"
 *   allocatedEur      {number}  – EUR allocated to this position
 *   allocatedPct      {number}  – % of budget allocated (0-100)
 *   convictionTier    {string}  – elite / high / strong / watchlist / low
 *   riskModeAtEntry   {string}  – risk_on / neutral / risk_off
 *   uncertaintyAtEntry{number}  – 0-1
 *   sourceRunId       {string=} – optional trace id
 *
 * @returns {object}  the inserted row
 */
async function openVirtualPositionFromAllocation(data) {
  const symbol            = String(data.symbol || "").trim().toUpperCase();
  const entryPrice        = safeNum(data.entryPrice);
  const allocatedEur      = safeNum(data.allocatedEur);
  const allocatedPct      = safeNum(data.allocatedPct);
  const convictionTier    = data.convictionTier    || null;
  const riskModeAtEntry   = data.riskModeAtEntry   || null;
  const uncertaintyAtEntry= safeNum(data.uncertaintyAtEntry, null);
  const sourceRunId       = data.sourceRunId       || null;

  if (!symbol)       throw new Error("openVirtualPositionFromAllocation: symbol is required");
  if (entryPrice <= 0) throw new Error("openVirtualPositionFromAllocation: entryPrice must be > 0");
  if (allocatedEur <= 0) throw new Error("openVirtualPositionFromAllocation: allocatedEur must be > 0");

  const res = await pool.query(
    `INSERT INTO virtual_positions
       (symbol, status, entry_price, current_price,
        allocated_eur, allocated_pct,
        conviction_tier, risk_mode_at_entry, uncertainty_at_entry,
        source_run_id)
     VALUES ($1, 'open', $2, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      symbol, entryPrice,
      allocatedEur, allocatedPct,
      convictionTier, riskModeAtEntry,
      uncertaintyAtEntry !== null ? uncertaintyAtEntry : null,
      sourceRunId,
    ]
  );

  const row = res.rows[0];
  logger.info("portfolioTwin: virtual position opened", {
    id: row.id, symbol, entryPrice, allocatedEur,
  });
  return _formatRow(row);
}

/* =========================================================
   REFRESH OPEN POSITIONS
========================================================= */

/**
 * Refreshes current_price and unrealized PnL for all open positions
 * using latest prices from market_snapshots (no external API cost).
 *
 * @returns {{ updated: number, skipped: number }}
 */
async function refreshOpenVirtualPositions() {
  const openRes = await pool.query(
    `SELECT id, symbol, entry_price, allocated_eur
     FROM virtual_positions
     WHERE status = 'open'`
  );

  let updated = 0;
  let skipped = 0;

  for (const row of openRes.rows) {
    const price = await _latestStoredPrice(row.symbol);
    if (price === null) { skipped++; continue; }

    const { pnlEur, pnlPct } = _calcPnl(
      safeNum(row.allocated_eur),
      safeNum(row.entry_price),
      price
    );

    await pool.query(
      `UPDATE virtual_positions
       SET current_price = $1,
           pnl_eur       = $2,
           pnl_pct       = $3,
           updated_at    = NOW()
       WHERE id = $4`,
      [price, pnlEur, pnlPct, row.id]
    );
    updated++;
  }

  logger.info("portfolioTwin: refreshOpenVirtualPositions", { updated, skipped });
  return { updated, skipped };
}

/* =========================================================
   CLOSE A VIRTUAL POSITION
========================================================= */

/**
 * Closes a virtual position by id.
 * Fetches latest stored price as exit price unless overridden.
 *
 * @param {number|string} id
 * @param {string}        reason  – e.g. "manual", "stop_loss", "target_reached"
 * @param {number=}       exitPriceOverride
 * @returns {object}      the updated row
 */
async function closeVirtualPosition(id, reason = "manual", exitPriceOverride = null) {
  const checkRes = await pool.query(
    `SELECT * FROM virtual_positions WHERE id = $1`,
    [id]
  );
  if (!checkRes.rows.length) throw new Error(`closeVirtualPosition: position ${id} not found`);

  const pos = checkRes.rows[0];
  if (pos.status === "closed") {
    throw new Error(`closeVirtualPosition: position ${id} is already closed`);
  }

  const exitPrice = exitPriceOverride
    ? safeNum(exitPriceOverride)
    : (await _latestStoredPrice(pos.symbol)) ?? safeNum(pos.entry_price);

  const { pnlEur, pnlPct } = _calcPnl(
    safeNum(pos.allocated_eur),
    safeNum(pos.entry_price),
    exitPrice
  );

  const res = await pool.query(
    `UPDATE virtual_positions
     SET status       = 'closed',
         exit_price   = $1,
         pnl_eur      = $2,
         pnl_pct      = $3,
         close_reason = $4,
         closed_at    = NOW(),
         updated_at   = NOW()
     WHERE id = $5
     RETURNING *`,
    [exitPrice, pnlEur, pnlPct, reason, id]
  );

  const row = res.rows[0];
  logger.info("portfolioTwin: virtual position closed", {
    id: row.id, symbol: row.symbol, pnlEur, reason,
  });
  return _formatRow(row);
}

/* =========================================================
   PORTFOLIO TWIN SNAPSHOT
========================================================= */

/**
 * Returns the current portfolio twin state.
 *
 * @param {{ limit?: number }} opts
 * @returns {object}  snapshot with open/closed positions and aggregated metrics
 */
async function getPortfolioTwinSnapshot({ limit = 50 } = {}) {
  const openRes = await pool.query(
    `SELECT * FROM virtual_positions
     WHERE status = 'open'
     ORDER BY opened_at DESC
     LIMIT $1`,
    [Math.min(limit, 200)]
  );

  const closedRes = await pool.query(
    `SELECT * FROM virtual_positions
     WHERE status = 'closed'
     ORDER BY closed_at DESC
     LIMIT $1`,
    [Math.min(limit, 200)]
  );

  const openPositions   = openRes.rows.map(_formatRow);
  const closedPositions = closedRes.rows.map(_formatRow);

  // Aggregated metrics
  const totalAllocatedEur  = openPositions.reduce((s, p) => s + safeNum(p.allocatedEur), 0);
  const unrealizedPnlEur   = openPositions.reduce((s, p) => s + safeNum(p.pnlEur), 0);
  const realizedPnlEur     = closedPositions.reduce((s, p) => s + safeNum(p.pnlEur), 0);
  const totalPnlEur        = unrealizedPnlEur + realizedPnlEur;

  // Simple equity curve: running sum of realized PnL over closed positions (chronological)
  const equityCurve = _buildEquityCurve(closedPositions);

  // Max drawdown from equity curve (simple, O(n))
  const maxDrawdownPct = _calcMaxDrawdown(equityCurve);

  const budget = safeNum(Number(process.env.ALLOCATION_BUDGET_EUR), 10000);

  return {
    generatedAt:        new Date().toISOString(),
    autoOpenEnabled:    process.env.PORTFOLIO_TWIN_AUTO_OPEN !== "false",
    budget,
    totalAllocatedEur:  Math.round(totalAllocatedEur  * 100) / 100,
    unrealizedPnlEur:   Math.round(unrealizedPnlEur   * 100) / 100,
    realizedPnlEur:     Math.round(realizedPnlEur     * 100) / 100,
    totalPnlEur:        Math.round(totalPnlEur        * 100) / 100,
    openCount:          openPositions.length,
    closedCount:        closedPositions.length,
    maxDrawdownPct:     maxDrawdownPct !== null ? Math.round(maxDrawdownPct * 10000) / 100 : null,
    openPositions,
    closedPositions,
    equityCurve,
  };
}

/* =========================================================
   HELPERS – equity curve + drawdown
========================================================= */

function _buildEquityCurve(closedPositions) {
  // Sort by closed_at ascending to build chronological curve
  const sorted = [...closedPositions].sort(
    (a, b) => new Date(a.closedAt || 0) - new Date(b.closedAt || 0)
  );

  let running = 0;
  return sorted.map((p) => {
    running += safeNum(p.pnlEur);
    return {
      closedAt:       p.closedAt,
      symbol:         p.symbol,
      pnlEur:         safeNum(p.pnlEur),
      cumulativePnlEur: Math.round(running * 100) / 100,
    };
  });
}

function _calcMaxDrawdown(equityCurve) {
  if (!equityCurve.length) return null;
  let peak       = -Infinity;
  let maxDD      = 0;
  for (const point of equityCurve) {
    const v = point.cumulativePnlEur;
    if (v > peak) peak = v;
    const dd = peak > 0 ? (peak - v) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

/* =========================================================
   ROW FORMATTER
========================================================= */

function _formatRow(row) {
  return {
    id:                  row.id,
    symbol:              row.symbol,
    status:              row.status,
    entryPrice:          row.entry_price   !== null ? Number(row.entry_price)   : null,
    currentPrice:        row.current_price !== null ? Number(row.current_price) : null,
    allocatedEur:        row.allocated_eur !== null ? Number(row.allocated_eur) : null,
    allocatedPct:        row.allocated_pct !== null ? Number(row.allocated_pct) : null,
    convictionTier:      row.conviction_tier       ?? null,
    riskModeAtEntry:     row.risk_mode_at_entry     ?? null,
    uncertaintyAtEntry:  row.uncertainty_at_entry !== null
                           ? Number(row.uncertainty_at_entry) : null,
    openedAt:            row.opened_at   ? new Date(row.opened_at).toISOString()   : null,
    updatedAt:           row.updated_at  ? new Date(row.updated_at).toISOString()  : null,
    closedAt:            row.closed_at   ? new Date(row.closed_at).toISOString()   : null,
    exitPrice:           row.exit_price  !== null ? Number(row.exit_price)  : null,
    pnlEur:              row.pnl_eur     !== null ? Number(row.pnl_eur)     : null,
    pnlPct:              row.pnl_pct     !== null ? Number(row.pnl_pct)     : null,
    closeReason:         row.close_reason   ?? null,
    sourceRunId:         row.source_run_id  ?? null,
  };
}

/* =========================================================
   LIST POSITIONS (raw query helper used by admin route)
========================================================= */

/**
 * Returns a paginated list of virtual positions.
 *
 * @param {{ status?: string, limit?: number, offset?: number }} opts
 */
async function listVirtualPositions({ status = null, limit = 50, offset = 0 } = {}) {
  const params = [];
  let where = "";

  if (status === "open" || status === "closed") {
    params.push(status);
    where = `WHERE status = $${params.length}`;
  }

  params.push(Math.min(limit, 200));
  params.push(Math.max(offset, 0));

  const res = await pool.query(
    `SELECT * FROM virtual_positions
     ${where}
     ORDER BY opened_at DESC
     LIMIT $${params.length - 1}
     OFFSET $${params.length}`,
    params
  );

  return res.rows.map(_formatRow);
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  ensureVirtualPositionsTable,
  hasOpenVirtualPosition,
  openVirtualPositionFromAllocation,
  refreshOpenVirtualPositions,
  closeVirtualPosition,
  getPortfolioTwinSnapshot,
  listVirtualPositions,
};
