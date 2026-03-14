"use strict";

/*
  Sector Coherence Check  –  Recursive Meta-Learning
  ---------------------------------------------------
  Measures the correlation risk within the 40-stock portfolio by monitoring
  "sector leaders".  When a sector leader's intra-day price falls by more than
  LEADER_FALL_THRESHOLD the system tightens the warning thresholds for every
  other stock in that sector by THRESHOLD_SHARPENING_FACTOR (15 %).

  The sharpened state is held in an in-memory map with a TTL of
  SHARPENED_TTL_MS.  Once the TTL expires the thresholds revert to their base
  values automatically.

  Usage (called from opportunityScanner or guardianService):
    const { getSharpenedThresholds } = require('./sectorCoherence.service');
    const t = getSharpenedThresholds('MSFT');
    // t.guardianThresholdSafe, t.guardianThresholdVolatile, t.guardianThresholdDanger
    // t.sectorAlert (boolean), t.sharpened (boolean), t.leaderTrigger (string|null)
*/

const logger = require("../utils/logger");

/* =========================================================
   SECTOR DEFINITIONS
   First symbol in each array is the "leader"; the rest are followers.
========================================================= */

const SECTOR_GROUPS = {
  Technologie: ["AAPL", "MSFT", "GOOGL", "GOOG", "NVDA", "META", "AMZN", "TSLA",
                "AMD", "INTC", "CRM", "ORCL", "ADBE", "NFLX", "QCOM", "AVGO",
                "NOW", "SNOW"],
  Finanzen:    ["JPM", "BAC", "GS", "MS", "WFC", "BLK", "C", "AXP",
                "V", "MA", "PYPL", "SCHW"],
  Energie:     ["XOM", "CVX", "COP", "EOG", "SLB", "BP", "SHEL", "OXY",
                "MPC", "PSX", "NEE", "DUK"],
  Gesundheit:  ["JNJ", "PFE", "ABBV", "MRK", "UNH", "LLY", "BMY", "GILD", "AMGN"],
  Konsum:      ["WMT", "COST", "PG", "KO", "PEP", "MCD", "NKE", "SBUX", "HD"],
  Industrie:   ["CAT", "HON", "BA", "GE", "MMM", "DE", "UPS", "RTX", "LMT"],
  Rohstoffe:   ["FCX", "NEM", "BHP", "RIO", "VALE", "ALB", "GLD", "SLV", "GDX"],
};

// Reverse map: symbol → { sector, isLeader }
const SYMBOL_META = {};
for (const [sector, members] of Object.entries(SECTOR_GROUPS)) {
  for (let i = 0; i < members.length; i++) {
    SYMBOL_META[members[i]] = { sector, isLeader: i === 0 };
  }
}

/* =========================================================
   CONSTANTS
========================================================= */

// Leader must drop by at least this fraction to trigger sector sharpening
const LEADER_FALL_THRESHOLD = -0.02; // -2 %

// How much to tighten (lower) follower thresholds when leader falls
const THRESHOLD_SHARPENING_FACTOR = 0.15; // 15 %

// How long the sharpened state is valid
const SHARPENED_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

/* =========================================================
   BASE GUARDIAN THRESHOLDS  (must mirror server.js env vars)
========================================================= */

function getBaseThresholds() {
  return {
    guardianThresholdSafe:     Number(process.env.GUARDIAN_THRESHOLD_SAFE     || 0.35),
    guardianThresholdVolatile: Number(process.env.GUARDIAN_THRESHOLD_VOLATILE || 0.50),
    guardianThresholdDanger:   Number(process.env.GUARDIAN_THRESHOLD_DANGER   || 0.65),
  };
}

/* =========================================================
   IN-MEMORY SHARPENED STATE
   Map: sector → { triggeredAt, leaderSymbol, leaderChange }
========================================================= */

const _sharpenedSectors = new Map();

function _isExpired(entry) {
  return Date.now() - entry.triggeredAt > SHARPENED_TTL_MS;
}

function _pruneExpired() {
  for (const [sector, entry] of _sharpenedSectors.entries()) {
    if (_isExpired(entry)) {
      _sharpenedSectors.delete(sector);
      logger.info(`sectorCoherence: sharpened state expired for sector ${sector}`);
    }
  }
}

/* =========================================================
   PUBLIC API
========================================================= */

/**
 * Notify the coherence engine about a leader's current price change.
 * Call this whenever a fresh quote arrives for a known symbol.
 *
 * @param {string} symbol          - e.g. "AAPL"
 * @param {number} changeFraction  - price change as a fraction (e.g. -0.03 for -3 %)
 */
function notifySectorLeaderQuote(symbol, changeFraction) {
  const sym  = String(symbol || "").trim().toUpperCase();
  const meta = SYMBOL_META[sym];
  if (!meta || !meta.isLeader) return; // not a leader → ignore

  _pruneExpired();

  const change = Number(changeFraction);
  if (!Number.isFinite(change) || change >= LEADER_FALL_THRESHOLD) return;

  // Leader has fallen beyond threshold → activate sharpened mode for sector
  const existing = _sharpenedSectors.get(meta.sector);
  if (!existing || _isExpired(existing)) {
    _sharpenedSectors.set(meta.sector, {
      triggeredAt:  Date.now(),
      leaderSymbol: sym,
      leaderChange: change,
    });

    logger.info(
      `sectorCoherence: sector "${meta.sector}" sharpened – leader ${sym} ` +
      `fell ${(change * 100).toFixed(2)}%`
    );
  }
}

/**
 * Returns the (potentially sharpened) guardian thresholds and sector alert
 * status for the given symbol.
 *
 * @param {string} symbol
 * @returns {{
 *   guardianThresholdSafe:     number,
 *   guardianThresholdVolatile: number,
 *   guardianThresholdDanger:   number,
 *   sharpened:  boolean,
 *   sectorAlert: boolean,
 *   leaderTrigger: string|null,
 *   sector: string|null
 * }}
 */
function getSharpenedThresholds(symbol) {
  _pruneExpired();

  const sym    = String(symbol || "").trim().toUpperCase();
  const meta   = SYMBOL_META[sym] || null;
  const sector = meta?.sector || null;

  const base = getBaseThresholds();

  if (!sector) {
    return { ...base, sharpened: false, sectorAlert: false, leaderTrigger: null, sector };
  }

  const state = _sharpenedSectors.get(sector);
  if (!state || _isExpired(state)) {
    return { ...base, sharpened: false, sectorAlert: false, leaderTrigger: null, sector };
  }

  const f = 1 - THRESHOLD_SHARPENING_FACTOR;
  return {
    guardianThresholdSafe:     parseFloat((base.guardianThresholdSafe     * f).toFixed(4)),
    guardianThresholdVolatile: parseFloat((base.guardianThresholdVolatile * f).toFixed(4)),
    guardianThresholdDanger:   parseFloat((base.guardianThresholdDanger   * f).toFixed(4)),
    sharpened:     true,
    sectorAlert:   true,
    leaderTrigger: state.leaderSymbol,
    sector,
  };
}

/**
 * Returns a snapshot of all currently sharpened sectors.
 * Used by the admin endpoint.
 *
 * @returns {Array<{ sector, leaderSymbol, leaderChange, triggeredAt, expiresAt }>}
 */
function getSharpenedSectorSnapshot() {
  _pruneExpired();

  const result = [];
  for (const [sector, state] of _sharpenedSectors.entries()) {
    result.push({
      sector,
      leaderSymbol: state.leaderSymbol,
      leaderChange: Number((state.leaderChange * 100).toFixed(2)),
      triggeredAt:  new Date(state.triggeredAt).toISOString(),
      expiresAt:    new Date(state.triggeredAt + SHARPENED_TTL_MS).toISOString(),
    });
  }

  return result;
}

/**
 * Returns the complete sector definitions including leader/follower metadata.
 * Useful for admin visualisation.
 */
function getSectorDefinitions() {
  const result = {};
  for (const [sector, members] of Object.entries(SECTOR_GROUPS)) {
    result[sector] = {
      leader:    members[0],
      followers: members.slice(1),
    };
  }
  return result;
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  notifySectorLeaderQuote,
  getSharpenedThresholds,
  getSharpenedSectorSnapshot,
  getSectorDefinitions,
  SECTOR_GROUPS,
  SYMBOL_META,
  LEADER_FALL_THRESHOLD,
  THRESHOLD_SHARPENING_FACTOR,
};
