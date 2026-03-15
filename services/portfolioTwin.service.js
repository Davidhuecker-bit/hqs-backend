"use strict";

/*
  Portfolio Twin Service – Capital Twin (Stage 1 → Stage 4)
  ----------------------------------------------------------
  Virtual portfolio tracking layer.  No broker, no real trades.
  Only re-uses existing DB infrastructure (market_snapshots) and
  existing allocation fields from capitalAllocation.service.js.

  Functions exported:
    ensureVirtualPositionsTable()
    openVirtualPositionFromAllocation(data)
    refreshOpenVirtualPositions()
    closeVirtualPosition(id, reason)
    getPortfolioTwinSnapshot()   ← Stage 3: win rate, avg gain/loss, deployed capital, maturity
    getStage4Analysis()          ← Stage 4: drawdown, concentration risk, correlation approx,
                                             counterfactual hints

  Design rules followed:
    - no new external API calls
    - no new background jobs
    - price refresh reads from market_snapshots (already populated by snapshot pipeline)
    - stateless pure helpers, all state in DB
    - worldState consumed opportunistically (graceful fallback on unavailability)
*/

const { Pool } = require("pg");
const logger   = require("../utils/logger");
const { getSector } = require("./capitalAllocation.service");

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

  // Stage 4: current drawdown (live equity vs historical peak)
  const currentDrawdownPct = _calcCurrentDrawdown(equityCurve, unrealizedPnlEur);

  const budget = safeNum(Number(process.env.ALLOCATION_BUDGET_EUR), 10000);

  // Stage 3: extended metrics (win rate, avg gain/loss, deployed capital, maturity)
  const stage3 = _computeStage3Metrics(closedPositions, openPositions, budget);

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
    currentDrawdownPct,
    // Stage 3 metrics
    winRate:            stage3.winRate,
    hitRate:            stage3.hitRate,
    avgGainEur:         stage3.avgGainEur,
    avgLossEur:         stage3.avgLossEur,
    avgGainPct:         stage3.avgGainPct,
    avgLossPct:         stage3.avgLossPct,
    deployedCapitalEur: stage3.deployedCapitalEur,
    deployedCapitalPct: stage3.deployedCapitalPct,
    twinMaturity:       stage3.twinMaturity,
    openPct:            stage3.openPct,
    closedPct:          stage3.closedPct,
    openPositions,
    closedPositions,
    equityCurve,
  };
}

/* =========================================================
   HELPERS – Stage 3: win rate, avg gain/loss, twin maturity
========================================================= */

/**
 * Derives a twin maturity label from operational state.
 * Used as a lightweight readiness indicator for release control.
 */
function _twinMaturityLabel(openCount, winRate, closedCount) {
  const total = openCount + closedCount;
  if (total === 0) {
    return { key: "uninitialized", label: "Nicht initialisiert", color: "#9ca3af" };
  }
  if (openCount >= 5 && winRate !== null && winRate >= 0.6 && closedCount >= 10) {
    return { key: "advanced", label: "Fortgeschritten", color: "#3b82f6" };
  }
  if (openCount >= 3 && winRate !== null && winRate >= 0.5) {
    return { key: "operational", label: "Operativ", color: "#10b981" };
  }
  if (openCount >= 1 || closedCount >= 3) {
    return { key: "developing", label: "Entwicklung", color: "#f59e0b" };
  }
  return { key: "emerging", label: "Initialisierung", color: "#ef4444" };
}

/**
 * Computes Stage 3 performance metrics from already-fetched position arrays.
 * Pure function – no DB calls.
 *
 * @param {object[]} closedPositions  – formatted closed position objects
 * @param {object[]} openPositions    – formatted open position objects
 * @param {number}   budget           – total allocation budget in EUR
 * @returns {object}
 */
function _computeStage3Metrics(closedPositions, openPositions, budget) {
  // ── Win rate / hit rate ──────────────────────────────────────────────────
  const closedWithPnl = closedPositions.filter((p) => p.pnlEur !== null);
  const winners = closedWithPnl.filter((p) => safeNum(p.pnlEur) > 0);
  const losers  = closedWithPnl.filter((p) => safeNum(p.pnlEur) <= 0);

  // winRate: fractional (0–1), used by release-control gates for threshold comparisons
  // hitRate: percentage (0–100), used for display/UI purposes
  const winRate = closedWithPnl.length > 0
    ? Math.round((winners.length / closedWithPnl.length) * 1000) / 1000
    : null;
  const hitRate = winRate !== null
    ? Math.round(winRate * 1000) / 10   // 0–100 %
    : null;

  // ── Average gain / average loss ─────────────────────────────────────────
  const avgGainEur = winners.length > 0
    ? Math.round(winners.reduce((s, p) => s + safeNum(p.pnlEur), 0) / winners.length * 100) / 100
    : null;
  const avgLossEur = losers.length > 0
    ? Math.round(losers.reduce((s, p) => s + safeNum(p.pnlEur), 0) / losers.length * 100) / 100
    : null;
  const avgGainPct = winners.length > 0
    ? Math.round(winners.reduce((s, p) => s + safeNum(p.pnlPct), 0) / winners.length * 10000) / 10000
    : null;
  const avgLossPct = losers.length > 0
    ? Math.round(losers.reduce((s, p) => s + safeNum(p.pnlPct), 0) / losers.length * 10000) / 10000
    : null;

  // ── Deployed capital ─────────────────────────────────────────────────────
  const deployedCapitalEur = openPositions.reduce((s, p) => s + safeNum(p.allocatedEur), 0);
  const deployedCapitalPct = budget > 0
    ? Math.round((deployedCapitalEur / budget) * 10000) / 100
    : null;

  // ── Portfolio twin maturity ───────────────────────────────────────────────
  const twinMaturity = _twinMaturityLabel(openPositions.length, winRate, closedPositions.length);

  // ── Open / closed distribution ───────────────────────────────────────────
  const totalPositions = openPositions.length + closedPositions.length;
  const openPct  = totalPositions > 0
    ? Math.round((openPositions.length / totalPositions) * 1000) / 10
    : null;
  const closedPct = totalPositions > 0
    ? Math.round((closedPositions.length / totalPositions) * 1000) / 10
    : null;

  return {
    winRate,
    hitRate,
    avgGainEur,
    avgLossEur,
    avgGainPct,
    avgLossPct,
    deployedCapitalEur: Math.round(deployedCapitalEur * 100) / 100,
    deployedCapitalPct,
    twinMaturity,
    openPct,
    closedPct,
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
   STAGE 4 – HELPERS
========================================================= */

/**
 * Computes the current drawdown percentage from the equity peak.
 * Combines realized PnL curve + current unrealized PnL to get "live equity".
 *
 * @param {object[]} equityCurve   – output from _buildEquityCurve()
 * @param {number}   unrealizedPnl – current open-position unrealized PnL
 * @returns {number|null}          – 0–100 percentage (or null if insufficient data)
 */
function _calcCurrentDrawdown(equityCurve, unrealizedPnl) {
  // Peak realized equity
  let peakRealized = 0;
  for (const pt of equityCurve) {
    if (pt.cumulativePnlEur > peakRealized) peakRealized = pt.cumulativePnlEur;
  }
  const lastRealized = equityCurve.length > 0
    ? equityCurve[equityCurve.length - 1].cumulativePnlEur
    : 0;
  const currentEquity = lastRealized + safeNum(unrealizedPnl);
  const peakEquity    = Math.max(peakRealized, currentEquity);

  if (peakEquity <= 0) return null;
  const dd = (peakEquity - currentEquity) / peakEquity;
  return Math.round(Math.max(0, dd) * 10000) / 100; // percent, 2dp
}

/**
 * Paket B – Concentration / Cluster Risk Flags.
 *
 * Pure heuristic – no external calls, no heavy maths.
 * Uses getSector() from capitalAllocation for sector labelling.
 *
 * @param {object[]} openPositions – formatted open position objects
 * @param {string}   worldRiskMode – e.g. "risk_on" | "neutral" | "risk_off"
 * @returns {object}  concentration flags + supporting detail
 */
function _computeConcentrationFlags(openPositions, worldRiskMode) {
  if (!openPositions.length) {
    return {
      sectorConcentrationHigh:       false,
      clusterConcentrationHigh:      false,
      tooManyHighRiskPositions:      false,
      tooManySameThemePositions:     false,
      defensiveMismatchToWorldState: false,
      sectorBreakdown:               {},
      riskModeBreakdown:             {},
      details:                       [],
      concentrationScore:            0,
    };
  }

  const totalEur = openPositions.reduce((s, p) => s + safeNum(p.allocatedEur), 0);

  // ── Sector grouping ──────────────────────────────────────────────────────
  const sectorEur    = {};   // sector → allocated EUR
  const sectorCount  = {};   // sector → position count
  for (const p of openPositions) {
    const sec = getSector(p.symbol);
    sectorEur[sec]   = (sectorEur[sec]   || 0) + safeNum(p.allocatedEur);
    sectorCount[sec] = (sectorCount[sec] || 0) + 1;
  }

  const sectorBreakdown = {};
  for (const [sec, eur] of Object.entries(sectorEur)) {
    sectorBreakdown[sec] = {
      allocatedEur:   Math.round(eur * 100) / 100,
      pct:            totalEur > 0 ? Math.round((eur / totalEur) * 10000) / 100 : 0,
      positionCount:  sectorCount[sec] || 0,
    };
  }

  // ── Risk mode grouping ───────────────────────────────────────────────────
  const riskModeCount = {};
  for (const p of openPositions) {
    const rm = p.riskModeAtEntry || "unknown";
    riskModeCount[rm] = (riskModeCount[rm] || 0) + 1;
  }

  const riskModeBreakdown = {};
  for (const [rm, cnt] of Object.entries(riskModeCount)) {
    riskModeBreakdown[rm] = {
      count: cnt,
      pct:   Math.round((cnt / openPositions.length) * 10000) / 100,
    };
  }

  // ── Flags ────────────────────────────────────────────────────────────────
  const details = [];
  let concentrationScore = 0;

  // Flag 1: Any single sector > 40 % of portfolio EUR
  const maxSectorPct  = totalEur > 0
    ? Math.max(...Object.values(sectorEur).map((e) => e / totalEur * 100))
    : 0;
  const sectorConcentrationHigh = maxSectorPct > 40;
  if (sectorConcentrationHigh) {
    const topSec = Object.entries(sectorEur).sort((a, b) => b[1] - a[1])[0];
    details.push(`Sektor "${topSec[0]}" macht ${Math.round(maxSectorPct)} % aus (Schwelle: 40 %)`);
    concentrationScore += 30;
  }

  // Flag 2: Any sector has >= 3 positions (cluster risk)
  const maxSectorCount = Math.max(...Object.values(sectorCount));
  const clusterConcentrationHigh = maxSectorCount >= 3;
  if (clusterConcentrationHigh) {
    const topSec = Object.entries(sectorCount).sort((a, b) => b[1] - a[1])[0];
    details.push(`Cluster "${topSec[0]}" hat ${topSec[1]} offene Positionen`);
    concentrationScore += 20;
  }

  // Flag 3: More than 50 % of positions entered in risk_on mode while worldState says risk_off
  const riskOnCount = (riskModeCount["risk_on"] || 0);
  const riskOnPct   = riskOnCount / openPositions.length * 100;
  const tooManyHighRiskPositions = riskOnPct > 50;
  if (tooManyHighRiskPositions) {
    details.push(`${Math.round(riskOnPct)} % der Positionen in "risk_on"-Modus eröffnet`);
    concentrationScore += 20;
  }

  // Flag 4: >= 4 positions open simultaneously (same theme concentration proxy)
  // Distinct from clusterConcentrationHigh (which is per-sector): this flag
  // fires when the overall open position count is high regardless of sector.
  const tooManySameThemePositions = openPositions.length >= 4;
  if (tooManySameThemePositions) {
    details.push(`${openPositions.length} gleichzeitig offene Positionen – Themen-/Klumpenrisiko prüfen`);
    concentrationScore += 10;
  }

  // Flag 5: Defensive mismatch – risk_off world but majority of positions are risk_on
  const defensiveMismatchToWorldState =
    worldRiskMode === "risk_off" && riskOnPct > 50;
  if (defensiveMismatchToWorldState) {
    details.push(`WorldState: risk_off – aber ${Math.round(riskOnPct)} % der Positionen sind risk_on`);
    concentrationScore += 30;
  }

  concentrationScore = Math.min(100, concentrationScore);

  return {
    sectorConcentrationHigh,
    clusterConcentrationHigh,
    tooManyHighRiskPositions,
    tooManySameThemePositions,
    defensiveMismatchToWorldState,
    sectorBreakdown,
    riskModeBreakdown,
    details,
    concentrationScore,
  };
}

/**
 * Paket C – Lightweight Correlation Approximation.
 *
 * Uses sector / risk-mode grouping as a proxy for correlation.
 * No external data, no NxN matrix – just structural approximation.
 *
 * @param {object[]} openPositions
 * @param {object}   sectorBreakdown – from _computeConcentrationFlags
 * @returns {object}
 */
function _computeCorrelationApprox(openPositions, sectorBreakdown) {
  const n = openPositions.length;
  if (n < 2) {
    return {
      correlationRiskScore:    0,
      topCorrelationWarnings:  [],
      concentrationDrivers:    [],
    };
  }

  // ── Herfindahl-style concentration index (sector weight² sum) ───────────
  let hhi = 0;
  for (const sec of Object.values(sectorBreakdown)) {
    const w = (sec.pct || 0) / 100;
    hhi += w * w;
  }
  // HHI ranges 1/n (perfectly diversified) to 1 (fully concentrated).
  // Map to 0–100: score = (HHI - 1/n) / (1 - 1/n) * 100
  const hhiRange = n > 1 ? (n - 1) / n : 1;  // normalization range: max HHI above the uniform baseline 1/n
  const baseConc = 1 / n;
  const correlationRiskScore = hhiRange > 0
    ? Math.round(Math.min(100, Math.max(0, (hhi - baseConc) / hhiRange) * 100))
    : 0;

  // ── Top warnings: sectors with > 1 position ───────────────────────────
  const topCorrelationWarnings = Object.entries(sectorBreakdown)
    .filter(([, s]) => s.positionCount >= 2)
    .sort((a, b) => b[1].pct - a[1].pct)
    .slice(0, 3)
    .map(([sec, s]) => ({
      sector:        sec,
      positionCount: s.positionCount,
      weightPct:     s.pct,
      warning:       `${s.positionCount} Positionen in ${sec} (${s.pct} % Gewicht) – erhöhte Korrelation`,
    }));

  // ── Concentration drivers: top sectors by weight ─────────────────────
  const concentrationDrivers = Object.entries(sectorBreakdown)
    .sort((a, b) => b[1].pct - a[1].pct)
    .slice(0, 3)
    .map(([sec, s]) => ({
      sector:       sec,
      weightPct:    s.pct,
      allocatedEur: s.allocatedEur,
    }));

  return {
    correlationRiskScore,
    topCorrelationWarnings,
    concentrationDrivers,
  };
}

/**
 * Paket D – Counterfactual / What-if Basis.
 *
 * Compares current portfolio metrics against simple hypothetical variants:
 *  1. Trimmed: each position capped at 10 % of total budget
 *  2. SectorCapped: no single sector > 30 % of total budget
 *  3. RiskOff: risk_on positions scaled to 60 %
 *
 * All calculations are pure arithmetic on existing data – no new DB calls.
 *
 * @param {object[]} openPositions
 * @param {number}   totalAllocatedEur
 * @param {object}   concentrationFlags
 * @returns {object}
 */
function _computeCounterfactual(openPositions, totalAllocatedEur, concentrationFlags) {
  if (!openPositions.length) {
    return {
      counterfactualSummary:        "Keine offenen Positionen – kein Counterfactual verfügbar",
      savedDrawdownEstimate:        null,
      reducedConcentrationEstimate: null,
      alternativeAllocationHints:   [],
    };
  }

  const hints = [];
  let reducedConcentrationEst = null;

  // ── Variant 1: Trimmed (each position capped at 10 % of total budget) ──────
  const trimmedTotal = openPositions.reduce(
    (s, p) => s + Math.min(safeNum(p.allocatedEur), totalAllocatedEur * 0.1), 0
  );
  const trimmedSavingPct = totalAllocatedEur > 0
    ? Math.round((1 - trimmedTotal / totalAllocatedEur) * 10000) / 100
    : null;

  // Estimate drawdown savings: less capital deployed → lower absolute drawdown impact.
  // Factor 0.6 is a conservative approximation (drawdown impact scales sub-linearly with
  // capital reduction – not 1:1 – because diversified trimming reduces correlated losses).
  // This is intentionally rough and should be re-calibrated from historical data.
  const savedDrawdownEstimate = trimmedSavingPct !== null
    ? Math.round(trimmedSavingPct * 0.6 * 100) / 100  // heuristic: ~60 % of capital-reduction benefit
    : null;

  if (trimmedSavingPct !== null && trimmedSavingPct > 5) {
    hints.push({
      variant: "Trimmed",
      description: `Positionen auf max. 10 % des Budgets gekappt → ${trimmedSavingPct} % weniger eingesetztes Kapital`,
      estimatedImpact: `ca. -${savedDrawdownEstimate} % Drawdown-Puffer`,
    });
  }

  // ── Variant 2: Sector-capped (max 30 % per sector) ───────────────────
  if (concentrationFlags.sectorConcentrationHigh) {
    const topSector = Object.entries(concentrationFlags.sectorBreakdown)
      .sort((a, b) => b[1].pct - a[1].pct)[0];
    if (topSector) {
      const [sec, data] = topSector;
      const cappedPct   = 30;
      const excessPct   = Math.max(0, data.pct - cappedPct);
      reducedConcentrationEst = Math.round(excessPct * 10) / 10;
      hints.push({
        variant: "SectorCapped",
        description: `Sektor "${sec}" auf ${cappedPct} % gekappt (aktuell ${data.pct} %)`,
        estimatedImpact: `ca. -${reducedConcentrationEst} % Sektor-Konzentration`,
      });
    }
  }

  // ── Variant 3: Risk-Off scaled (risk_on positions × 0.6) ─────────────
  if (concentrationFlags.defensiveMismatchToWorldState || concentrationFlags.tooManyHighRiskPositions) {
    const riskOnPositions  = openPositions.filter((p) => p.riskModeAtEntry === "risk_on");
    const riskOnTotal      = riskOnPositions.reduce((s, p) => s + safeNum(p.allocatedEur), 0);
    const riskOffScaled    = riskOnTotal * 0.6;
    const scaledSavingEur  = Math.round((riskOnTotal - riskOffScaled) * 100) / 100;
    hints.push({
      variant: "RiskOffScaled",
      description: `${riskOnPositions.length} risk_on-Positionen auf 60 % skaliert → € ${scaledSavingEur} freigegeben`,
      estimatedImpact: `Risikoreduktion bei WorldState risk_off`,
    });
  }

  const summaryParts = [];
  if (savedDrawdownEstimate !== null && savedDrawdownEstimate > 0) {
    summaryParts.push(`geschätzter Drawdown-Puffer bei Trimming: -${savedDrawdownEstimate} %`);
  }
  if (reducedConcentrationEst !== null && reducedConcentrationEst > 0) {
    summaryParts.push(`Sektor-Konzentration reduzierbar um ca. ${reducedConcentrationEst} %`);
  }

  const counterfactualSummary = summaryParts.length > 0
    ? summaryParts.join("; ")
    : "Portfolio innerhalb normaler Grenzen – kein kritisches Counterfactual";

  return {
    counterfactualSummary,
    savedDrawdownEstimate,
    reducedConcentrationEstimate: reducedConcentrationEst,
    alternativeAllocationHints:   hints,
  };
}

/**
 * Paket A + B + C + D combined: Stage 4 analysis.
 *
 * Builds the full Stage 4 intelligence block from existing virtual_positions data.
 * Reads worldState opportunistically (graceful fallback on failure).
 *
 * @param {{ limit?: number }} opts
 * @returns {Promise<object>}
 */
async function getStage4Analysis({ limit = 100 } = {}) {
  // Load worldState for risk_mode (graceful – never throws)
  let worldRiskMode = "neutral";
  try {
    const { getWorldState } = require("./worldState.service");
    const ws = await getWorldState();
    worldRiskMode = ws?.risk_mode || "neutral";
  } catch (_) {
    // fallback to neutral – no hard failure
  }

  // Fetch open positions
  const openRes = await pool.query(
    `SELECT * FROM virtual_positions WHERE status = 'open' ORDER BY opened_at DESC LIMIT $1`,
    [Math.min(limit, 200)]
  );
  const openPositions = openRes.rows.map(_formatRow);

  // Fetch closed positions (for equity curve)
  const closedRes = await pool.query(
    `SELECT * FROM virtual_positions WHERE status = 'closed' ORDER BY closed_at DESC LIMIT $1`,
    [Math.min(limit, 200)]
  );
  const closedPositions = closedRes.rows.map(_formatRow);

  // ── Equity curve + drawdowns ──────────────────────────────────────────
  const equityCurve      = _buildEquityCurve(closedPositions);
  const maxDrawdownPct   = _calcMaxDrawdown(equityCurve);
  const unrealizedPnlEur = openPositions.reduce((s, p) => s + safeNum(p.pnlEur), 0);
  const currentDrawdownPct = _calcCurrentDrawdown(equityCurve, unrealizedPnlEur);

  // ── Concentration flags (Paket B) ─────────────────────────────────────
  const concentrationFlags = _computeConcentrationFlags(openPositions, worldRiskMode);

  // ── Correlation approximation (Paket C) ──────────────────────────────
  const correlationApprox  = _computeCorrelationApprox(
    openPositions,
    concentrationFlags.sectorBreakdown
  );

  // ── Total allocated ───────────────────────────────────────────────────
  const totalAllocatedEur = openPositions.reduce((s, p) => s + safeNum(p.allocatedEur), 0);

  // ── Counterfactual (Paket D) ──────────────────────────────────────────
  const counterfactual = _computeCounterfactual(
    openPositions,
    totalAllocatedEur,
    concentrationFlags
  );

  // ── Active flags summary ──────────────────────────────────────────────
  const activeFlags = [
    concentrationFlags.sectorConcentrationHigh       && "sectorConcentrationHigh",
    concentrationFlags.clusterConcentrationHigh      && "clusterConcentrationHigh",
    concentrationFlags.tooManyHighRiskPositions      && "tooManyHighRiskPositions",
    concentrationFlags.tooManySameThemePositions     && "tooManySameThemePositions",
    concentrationFlags.defensiveMismatchToWorldState && "defensiveMismatchToWorldState",
  ].filter(Boolean);

  return {
    generatedAt:        new Date().toISOString(),
    stage:              4,
    worldRiskMode,
    openPositionsCount: openPositions.length,
    // Paket A
    currentDrawdownPct,
    maxDrawdownPct:  maxDrawdownPct !== null ? Math.round(maxDrawdownPct * 10000) / 100 : null,
    unrealizedPnlEur: Math.round(unrealizedPnlEur * 100) / 100,
    totalAllocatedEur: Math.round(totalAllocatedEur * 100) / 100,
    equityPoints:    equityCurve.slice(-20),          // last 20 for compact transport
    // Paket B
    concentrationFlags,
    activeFlags,
    // Paket C
    correlationApprox,
    // Paket D
    counterfactual,
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
  getStage4Analysis,
  listVirtualPositions,
};
