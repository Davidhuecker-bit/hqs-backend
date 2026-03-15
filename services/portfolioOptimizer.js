"use strict";

/*
  HQS Portfolio Optimizer – Score Weighted Allocation
  ----------------------------------------------------
  optimizePortfolio          – original score-proportional weights (unchanged)
  optimizePortfolioWithCaps  – sector-cap-aware extension using capitalAllocation
*/

const { getSector, DEFAULT_MAX_SECTOR_PCT } = require("./capitalAllocation.service");

function safe(v, f = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

// ── Original (unchanged) ──────────────────────────────────────────────────────

function optimizePortfolio(stocks = []) {
  if (!Array.isArray(stocks) || stocks.length === 0) {
    return [];
  }

  const totalScore = stocks.reduce(
    (sum, s) => sum + safe(s.hqsScore),
    0
  );

  if (totalScore === 0) {
    const equalWeight = 100 / stocks.length;

    return stocks.map(stock => ({
      symbol: stock.symbol,
      allocation: Number(equalWeight.toFixed(2))
    }));
  }

  return stocks.map(stock => {
    const weight =
      (safe(stock.hqsScore) / totalScore) * 100;

    return {
      symbol: stock.symbol,
      allocation: Number(weight.toFixed(2))
    };
  });
}

// ── Sector-cap-aware optimizer ────────────────────────────────────────────────

/**
 * Score-weighted allocation with per-sector caps (water-filling algorithm).
 *
 * Algorithm:
 *   1. Identify which sectors would naturally exceed maxSectorPct.
 *   2. Cap those sectors at exactly maxSectorPct (one at a time, worst first).
 *   3. Redistribute freed budget proportionally to uncapped sectors.
 *   4. Repeat until no sector exceeds cap or budget is exhausted.
 *
 * Edge case: when there are too few sectors to absorb the budget at ≤ maxSectorPct
 * (e.g. only 3 sectors at 30% cap = 90% < 100%), the remainder is distributed
 * proportionally to all sectors so allocations still sum to 100%.
 *
 * @param {Array<{ symbol: string, hqsScore: number }>} stocks
 * @param {object} [options]
 * @param {number}  [options.maxSectorPct=30]  - max allocation % per sector (default: 30)
 *
 * @returns {Array<{
 *   symbol:     string,
 *   allocation: number,
 *   sector:     string,
 *   capped:     boolean,
 * }>}
 */
function optimizePortfolioWithCaps(stocks = [], options = {}) {
  if (!Array.isArray(stocks) || stocks.length === 0) return [];

  const maxSectorPct = clamp(safe(options.maxSectorPct, DEFAULT_MAX_SECTOR_PCT), 1, 100);

  // Attach sector labels
  const items = stocks.map(s => ({
    symbol:   String(s.symbol || "").toUpperCase(),
    hqsScore: safe(s.hqsScore, 0),
    sector:   getSector(s.symbol),
    capped:   false,
  }));

  // Aggregate scores by sector
  const sectorScores = {};
  for (const item of items) {
    sectorScores[item.sector] = safe(sectorScores[item.sector], 0) + item.hqsScore;
  }

  // Water-filling: iteratively cap the most over-represented free sector
  const cappedSectors = {};  // sector → capped allocation %

  for (;;) {
    const freeSectors = Object.keys(sectorScores).filter(s => cappedSectors[s] === undefined);
    if (freeSectors.length === 0) break;

    const usedBudget  = Object.values(cappedSectors).reduce((s, v) => s + v, 0);
    const freeBudget  = Math.max(0, 100 - usedBudget);
    const freeScore   = freeSectors.reduce((s, sec) => s + sectorScores[sec], 0) || 1;

    // Find the sector with the highest natural share among free sectors
    let worstSec   = null;
    let worstShare = 0;
    for (const sec of freeSectors) {
      const share = (sectorScores[sec] / freeScore) * freeBudget;
      if (share > worstShare) { worstSec = sec; worstShare = share; }
    }

    // If it's not over the cap, we're done
    if (!worstSec || worstShare <= maxSectorPct + 0.001) break;

    cappedSectors[worstSec] = maxSectorPct;
    items.filter(i => i.sector === worstSec).forEach(i => { i.capped = true; });
  }

  // Final allocation
  const usedBudget = Object.values(cappedSectors).reduce((s, v) => s + v, 0);
  const freeBudget = Math.max(0, 100 - usedBudget);
  const freeSectors = Object.keys(sectorScores).filter(s => cappedSectors[s] === undefined);
  const freeScore   = freeSectors.reduce((s, sec) => s + sectorScores[sec], 0) || 0;

  // If all sectors are capped (freeBudget leftover but no free sectors), distribute
  // the remainder proportionally to all sectors (best-effort: avoids unallocated budget).
  const totalScore = Object.values(sectorScores).reduce((s, v) => s + v, 0) || 1;

  return items.map(item => {
    let alloc = 0;

    if (cappedSectors[item.sector] !== undefined) {
      // Distribute cap proportionally within sector by hqsScore
      const secScore = sectorScores[item.sector] || 1;
      alloc = (item.hqsScore / secScore) * cappedSectors[item.sector];
    } else if (freeScore > 0) {
      // Free sector: proportional to hqsScore within available free budget
      alloc = (item.hqsScore / freeScore) * freeBudget;
    }

    // Distribute any remaining leftover (when all sectors capped, freeBudget > 0, freeScore = 0)
    if (freeSectors.length === 0 && freeBudget > 0) {
      alloc += (item.hqsScore / totalScore) * freeBudget;
    }

    return {
      symbol:     item.symbol,
      allocation: Number(alloc.toFixed(2)),
      sector:     item.sector,
      capped:     item.capped,
    };
  });
}

module.exports = { optimizePortfolio, optimizePortfolioWithCaps };
