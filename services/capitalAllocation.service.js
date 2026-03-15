"use strict";

/*
  Capital Allocation Layer
  -------------------------
  Pure, stateless service. No DB calls, no external API calls, no imports
  from other project services (zero circular-dependency risk).

  Converts a ranked list of debate/guardian-approved opportunities into
  controlled capital positions using:

    1. Conviction-tier-based base size
    2. Regime multiplier (risk_on / neutral / risk_off)
    3. Uncertainty penalty (from worldState.uncertainty)
    4. Robustness / antifragility factor
    5. Sector allocation caps (sharpened when sectorAlert is active)
    6. Global risk-budget limit (max total % deployed)
    7. Max-positions cap (concurrent approved positions)

  Key functions:
    calculatePositionSize(params)            → per-opportunity sizing details
    applyCapitalAllocation(opps, ws, opts)   → full budget run with allocation fields

  All sizing constants can be overridden through function options.
*/

const logger = require("../utils/logger");

/* =========================================================
   CONSTANTS
========================================================= */

// Base position sizes (% of total budget) per conviction tier
const BASE_SIZE_BY_TIER = {
  elite:     8.0,  // finalConviction >= 90
  high:      6.0,  // finalConviction >= 80
  strong:    4.0,  // finalConviction >= 65
  watchlist: 2.5,  // finalConviction >= 50
  low:       1.5,  // finalConviction <  50  (floor)
};

// Regime multipliers
const REGIME_MULTIPLIERS = {
  risk_on:  1.00,
  neutral:  0.75,
  risk_off: 0.40,
};

// Uncertainty penalty: at uncertainty=1.0 size is reduced by this fraction
const MAX_UNCERTAINTY_PENALTY = 0.60;

// Antifragility thresholds (mirrors syntheticStressTest ANTIFRAGILE_THRESHOLD)
const ANTIFRAGILE_THRESHOLD    = 0.70;
const ANTIFRAGILE_BONUS        = 1.15;  // antifragile signal: +15 %
const LOW_ROBUSTNESS_FLOOR     = 0.35;  // below this: apply penalty
const LOW_ROBUSTNESS_PENALTY   = 0.80;  // fragile signal: -20 %

// Sector caps
const DEFAULT_MAX_SECTOR_PCT   = 30.0;  // max % of total budget per sector
const SECTOR_ALERT_MAX_PCT     = 20.0;  // reduced cap when sectorAlert is active

// Global deployment caps
const DEFAULT_MAX_POSITIONS    = 10;    // max concurrent approved positions
const DEFAULT_TOTAL_BUDGET_PCT = 80.0;  // max total % of budget to deploy
const MIN_POSITION_PCT         = 1.0;   // never go below this if approved
const MAX_POSITION_PCT         = 15.0;  // absolute hard cap per position

/* =========================================================
   SECTOR LOOKUP
   Mirror of mockPortfolio.service.js / sectorCoherence.service.js
   Kept inline to avoid circular dependencies.
========================================================= */

const SECTOR_LOOKUP = {
  AAPL: "Technologie", MSFT: "Technologie", GOOGL: "Technologie",
  GOOG: "Technologie", NVDA: "Technologie", META: "Technologie",
  AMZN: "Technologie", TSLA: "Technologie", AMD:  "Technologie",
  INTC: "Technologie", CRM:  "Technologie", ORCL: "Technologie",
  ADBE: "Technologie", NFLX: "Technologie", QCOM: "Technologie",
  AVGO: "Technologie", NOW:  "Technologie", SNOW: "Technologie",

  JPM: "Finanzen", BAC:  "Finanzen", GS:   "Finanzen",
  MS:  "Finanzen", WFC:  "Finanzen", BLK:  "Finanzen",
  C:   "Finanzen", AXP:  "Finanzen", V:    "Finanzen",
  MA:  "Finanzen", PYPL: "Finanzen", SCHW: "Finanzen",

  XOM:  "Energie", CVX:  "Energie", COP:  "Energie",
  EOG:  "Energie", SLB:  "Energie", BP:   "Energie",
  SHEL: "Energie", OXY:  "Energie", MPC:  "Energie",
  PSX:  "Energie", NEE:  "Energie", DUK:  "Energie",

  JNJ:  "Gesundheit", PFE:  "Gesundheit", ABBV: "Gesundheit",
  MRK:  "Gesundheit", UNH:  "Gesundheit", LLY:  "Gesundheit",
  BMY:  "Gesundheit", GILD: "Gesundheit", AMGN: "Gesundheit",

  WMT:  "Konsum", COST: "Konsum", PG:   "Konsum",
  KO:   "Konsum", PEP:  "Konsum", MCD:  "Konsum",
  NKE:  "Konsum", SBUX: "Konsum", HD:   "Konsum",

  CAT: "Industrie", HON: "Industrie", BA:  "Industrie",
  GE:  "Industrie", MMM: "Industrie", DE:  "Industrie",
  UPS: "Industrie", RTX: "Industrie", LMT: "Industrie",

  FCX:  "Rohstoffe", NEM:  "Rohstoffe", BHP: "Rohstoffe",
  RIO:  "Rohstoffe", VALE: "Rohstoffe", ALB: "Rohstoffe",
  GLD:  "Rohstoffe", SLV:  "Rohstoffe", GDX: "Rohstoffe",
};

/**
 * Returns the sector label for a symbol, defaulting to "Sonstige".
 * @param {string} symbol
 * @returns {string}
 */
function getSector(symbol) {
  return SECTOR_LOOKUP[String(symbol || "").toUpperCase()] || "Sonstige";
}

/* =========================================================
   UTILS
========================================================= */

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  const x = safeNum(n, min);
  return Math.max(min, Math.min(max, x));
}

/* =========================================================
   CONVICTION TIER
========================================================= */

/**
 * Derives the conviction tier from numeric conviction and/or finalRating string.
 * Numeric thresholds are used as fallback.
 *
 * @param {number} finalConviction  0-100
 * @param {string|null} finalRating e.g. "Elite Conviction" | "High Conviction" | …
 * @returns {"elite"|"high"|"strong"|"watchlist"|"low"}
 */
function getConvictionTier(finalConviction, finalRating) {
  const rating = String(finalRating || "").toLowerCase();
  if (rating.includes("elite"))  return "elite";
  if (rating.includes("high"))   return "high";
  if (rating.includes("strong")) return "strong";
  if (rating.includes("watch"))  return "watchlist";

  const c = safeNum(finalConviction, 0);
  if (c >= 90) return "elite";
  if (c >= 80) return "high";
  if (c >= 65) return "strong";
  if (c >= 50) return "watchlist";
  return "low";
}

/* =========================================================
   calculatePositionSize
========================================================= */

/**
 * Calculate the risk-adjusted position size for a single opportunity.
 *
 * @param {object} p
 * @param {number}  [p.finalConviction=0]     0-100
 * @param {string}  [p.finalRating=null]      "Elite Conviction" | "High Conviction" | …
 * @param {number}  [p.robustnessScore=0.5]   0-1  (antifragility proxy from stressTest)
 * @param {number}  [p.volatility=0]          0-1  (annual vol)
 * @param {string}  [p.riskMode="neutral"]    "risk_on" | "neutral" | "risk_off"
 * @param {number}  [p.uncertainty=0]         0-1  (worldState.uncertainty)
 * @param {boolean} [p.sectorAlert=false]     true when sectorCoherence sharpened
 * @param {number|null} [p.totalBudgetEur=null] reference budget for EUR output
 *
 * @returns {{
 *   convictionTier:    string,
 *   basePct:           number,
 *   regimeMultiplier:  number,
 *   uncertaintyFactor: number,
 *   robustnessFactor:  number,
 *   sectorAlertFactor: number,
 *   positionSizePct:   number,
 *   positionSizeEur:   number|null,
 *   sizingRationale:   string,
 * }}
 */
function calculatePositionSize({
  finalConviction  = 0,
  finalRating      = null,
  robustnessScore  = 0.5,
  volatility       = 0,
  riskMode         = "neutral",
  uncertainty      = 0,
  sectorAlert      = false,
  totalBudgetEur   = null,
} = {}) {
  const conviction = clamp(safeNum(finalConviction, 0), 0, 100);
  const robustness = clamp(safeNum(robustnessScore, 0.5), 0, 1);
  const uncert     = clamp(safeNum(uncertainty, 0), 0, 1);
  const vol        = clamp(safeNum(volatility, 0), 0, 1);
  const rMode      = String(riskMode || "neutral").toLowerCase();

  // 1. Base size from conviction tier
  const tier    = getConvictionTier(conviction, finalRating);
  const basePct = BASE_SIZE_BY_TIER[tier] ?? BASE_SIZE_BY_TIER.low;

  // 2. Regime multiplier
  const regimeMultiplier = REGIME_MULTIPLIERS[rMode] ?? REGIME_MULTIPLIERS.neutral;

  // 3. Uncertainty factor: linear compression
  //    uncertainty=0 → 1.0;  uncertainty=1.0 → (1 - MAX_UNCERTAINTY_PENALTY)
  const uncertaintyFactor = 1 - (uncert * MAX_UNCERTAINTY_PENALTY);

  // 4. Robustness (antifragility) factor
  let robustnessFactor;
  if (robustness >= ANTIFRAGILE_THRESHOLD) {
    robustnessFactor = ANTIFRAGILE_BONUS;
  } else if (robustness < LOW_ROBUSTNESS_FLOOR) {
    robustnessFactor = LOW_ROBUSTNESS_PENALTY;
  } else {
    // Linear interpolation: [LOW_ROBUSTNESS_FLOOR, ANTIFRAGILE_THRESHOLD] → [0.80, 1.0]
    const range = ANTIFRAGILE_THRESHOLD - LOW_ROBUSTNESS_FLOOR;
    robustnessFactor = LOW_ROBUSTNESS_PENALTY
      + ((robustness - LOW_ROBUSTNESS_FLOOR) / range) * (1.0 - LOW_ROBUSTNESS_PENALTY);
  }

  // 5. Sector alert factor
  const sectorAlertFactor = sectorAlert ? 0.80 : 1.00;

  // 6. Volatility micro-adjustment: high vol slightly compresses size
  //    vol=0 → 1.0;  vol=1.0 → 0.90  (max 10% compression)
  const volFactor = 1.0 - (vol * 0.10);

  // 7. Compose
  const rawPct = basePct
    * regimeMultiplier
    * uncertaintyFactor
    * robustnessFactor
    * sectorAlertFactor
    * volFactor;

  const positionSizePct = clamp(
    parseFloat(rawPct.toFixed(2)),
    MIN_POSITION_PCT,
    MAX_POSITION_PCT
  );

  const budget = safeNum(totalBudgetEur, 0);
  const positionSizeEur = budget > 0
    ? parseFloat(((budget * positionSizePct) / 100).toFixed(2))
    : null;

  // 8. Rationale
  const parts = [
    `tier:${tier}(${conviction.toFixed(0)})`,
    `regime:${rMode}(×${regimeMultiplier.toFixed(2)})`,
  ];
  if (uncert > 0.05) {
    parts.push(`uncertainty:−${(uncert * MAX_UNCERTAINTY_PENALTY * 100).toFixed(0)}%`);
  }
  if (Math.abs(robustnessFactor - 1.0) > 0.01) {
    parts.push(`robustness:×${robustnessFactor.toFixed(2)}`);
  }
  if (sectorAlert)  parts.push("sectorAlert:tighter");
  if (vol > 0.20)   parts.push(`vol:${(vol * 100).toFixed(0)}%`);

  return {
    convictionTier:    tier,
    basePct:           parseFloat(basePct.toFixed(2)),
    regimeMultiplier:  parseFloat(regimeMultiplier.toFixed(2)),
    uncertaintyFactor: parseFloat(uncertaintyFactor.toFixed(3)),
    robustnessFactor:  parseFloat(robustnessFactor.toFixed(3)),
    sectorAlertFactor,
    positionSizePct,
    positionSizeEur,
    sizingRationale:   parts.join(" | "),
  };
}

/* =========================================================
   applyCapitalAllocation
========================================================= */

/**
 * Distributes a risk budget across a ranked list of pre-approved opportunities.
 *
 * Inputs:
 *   - opportunities: sorted by priority (highest conviction first),
 *     already passed debate + guardian filters.
 *   - worldStateParams: { riskMode, uncertainty } from worldState.
 *   - options: budget / cap overrides.
 *
 * Outputs per opportunity (fields added to original object):
 *   allocationApproved     boolean
 *   positionSizePct        number  (0 when rejected)
 *   positionSizeEur        number  (0 when rejected, or no budget set)
 *   budgetConsumed         number  (cumulative %, updated after each position)
 *   budgetRemainingAfter   number  (remaining deployable % after this position)
 *   allocationReason       string
 *   regimeAdjustment       number  (multiplier applied)
 *   uncertaintyPenalty     number  (fraction removed, e.g. 0.30 = 30% removed)
 *   sectorCapApplied       boolean
 *   rankAfterAllocation    number|null  (1-based, null when rejected)
 *   convictionTier         string
 *   sector                 string
 *
 * @param {Array<object>} opportunities
 * @param {{ riskMode?: string, uncertainty?: number }} worldStateParams
 * @param {{
 *   totalBudgetEur?:    number,
 *   maxPositions?:      number,
 *   maxSectorPct?:      number,
 *   maxSectorAlertPct?: number,
 *   totalBudgetPct?:    number,
 * }} [options]
 *
 * @returns {{
 *   opportunities: Array<object>,
 *   budgetSummary: object,
 * }}
 */
function applyCapitalAllocation(opportunities, worldStateParams = {}, options = {}) {
  if (!Array.isArray(opportunities) || opportunities.length === 0) {
    return {
      opportunities: [],
      budgetSummary: _buildEmptyBudgetSummary(worldStateParams, options),
    };
  }

  const riskMode    = String(worldStateParams.riskMode   || "neutral").toLowerCase();
  const uncertainty = clamp(safeNum(worldStateParams.uncertainty, 0), 0, 1);

  const totalBudgetEur    = safeNum(
    options.totalBudgetEur ?? Number(process.env.ALLOCATION_BUDGET_EUR),
    10000
  );
  const maxPositions      = clamp(safeNum(options.maxPositions,      DEFAULT_MAX_POSITIONS),    1,  25);
  const maxSectorPct      = clamp(safeNum(options.maxSectorPct,      DEFAULT_MAX_SECTOR_PCT),   5, 100);
  const maxSectorAlertPct = clamp(safeNum(options.maxSectorAlertPct, SECTOR_ALERT_MAX_PCT),      5, 100);
  const totalBudgetPct    = clamp(safeNum(options.totalBudgetPct,    DEFAULT_TOTAL_BUDGET_PCT), 10, 100);

  let consumedBudgetPct = 0;
  let approvedCount     = 0;
  const sectorAllocated = {}; // sector → deployed %

  const result = opportunities.map((opp) => {
    const symbol      = String(opp.symbol || "").toUpperCase();
    const sector      = getSector(symbol);
    // sectorAlert can be carried from opportunityScanner (field: sectorAlert)
    const sectorAlert = Boolean(opp.sectorAlert);

    const sizing = calculatePositionSize({
      finalConviction: safeNum(opp.finalConviction, 0),
      finalRating:     opp.finalRating || null,
      robustnessScore: safeNum(opp.robustnessScore, 0.5),
      volatility:      safeNum(opp.volatility, 0),
      riskMode,
      uncertainty,
      sectorAlert,
      totalBudgetEur,
    });

    let sizePct = sizing.positionSizePct;
    let approved = true;
    let rejectReason = null;
    let sectorCapApplied  = false;
    let budgetCapApplied  = false;
    let posCapApplied     = false;

    // ── Gate 1: max positions ───────────────────────────────────────────────
    if (approvedCount >= maxPositions) {
      approved       = false;
      posCapApplied  = true;
      rejectReason   = `Max Positionen erreicht (${maxPositions})`;
    }

    // ── Gate 2: global budget limit ─────────────────────────────────────────
    if (approved) {
      const remaining = Math.max(0, totalBudgetPct - consumedBudgetPct);
      if (consumedBudgetPct + sizePct > totalBudgetPct) {
        if (remaining < MIN_POSITION_PCT) {
          approved         = false;
          budgetCapApplied = true;
          rejectReason     = "Budget erschöpft";
        } else {
          // Trim to remaining budget (partial allocation)
          sizePct          = parseFloat(remaining.toFixed(2));
          budgetCapApplied = true;
        }
      }
    }

    // ── Gate 3: sector cap ──────────────────────────────────────────────────
    if (approved) {
      const effectiveCap     = sectorAlert ? maxSectorAlertPct : maxSectorPct;
      const currentSectorPct = safeNum(sectorAllocated[sector], 0);

      if (currentSectorPct + sizePct > effectiveCap) {
        const remainingInSector = Math.max(0, effectiveCap - currentSectorPct);
        if (remainingInSector < MIN_POSITION_PCT) {
          approved         = false;
          sectorCapApplied = true;
          rejectReason     = `Sektor-Cap erreicht: ${sector} (max ${effectiveCap}%)`;
        } else {
          // Trim to remaining sector budget
          sizePct          = parseFloat(Math.min(sizePct, remainingInSector).toFixed(2));
          sectorCapApplied = true;
        }
      }
    }

    // ── Commit ───────────────────────────────────────────────────────────────
    if (approved) {
      consumedBudgetPct         += sizePct;
      sectorAllocated[sector]    = safeNum(sectorAllocated[sector], 0) + sizePct;
      approvedCount++;
    } else {
      sizePct = 0;
    }

    const budgetConsumed       = parseFloat(consumedBudgetPct.toFixed(2));
    const budgetRemainingAfter = parseFloat(Math.max(0, totalBudgetPct - consumedBudgetPct).toFixed(2));

    const allocationReason = approved
      ? [
          `Kapital allokiert (${approvedCount}/${maxPositions})`,
          sizing.sizingRationale,
          sectorCapApplied  ? `Sektor-Trim: ${sector}`  : null,
          budgetCapApplied  ? "Budget-Trimming"          : null,
        ].filter(Boolean).join(" | ")
      : rejectReason || "Nicht allokiert";

    return {
      ...opp,
      // ── Allocation fields ───────────────────────────────────────────────
      allocationApproved:   approved,
      positionSizePct:      approved ? sizePct : 0,
      positionSizeEur:      (approved && totalBudgetEur > 0)
        ? parseFloat(((totalBudgetEur * sizePct) / 100).toFixed(2))
        : 0,
      budgetConsumed,
      budgetRemainingAfter,
      allocationReason,
      regimeAdjustment:     sizing.regimeMultiplier,
      uncertaintyPenalty:   parseFloat((1 - sizing.uncertaintyFactor).toFixed(3)),
      sectorCapApplied:     sectorCapApplied || (!approved && posCapApplied === false && rejectReason?.includes("Sektor")),
      rankAfterAllocation:  approved ? approvedCount : null,
      convictionTier:       sizing.convictionTier,
      sector,
    };
  });

  const budgetSummary = {
    totalBudgetEur,
    totalBudgetPct,
    consumedBudgetPct:   parseFloat(consumedBudgetPct.toFixed(2)),
    consumedBudgetEur:   parseFloat(((totalBudgetEur * consumedBudgetPct) / 100).toFixed(2)),
    remainingBudgetPct:  parseFloat(Math.max(0, totalBudgetPct - consumedBudgetPct).toFixed(2)),
    remainingBudgetEur:  parseFloat(
      Math.max(0, (totalBudgetEur * (totalBudgetPct - consumedBudgetPct)) / 100).toFixed(2)
    ),
    approvedPositions:   approvedCount,
    totalCandidates:     opportunities.length,
    riskMode,
    uncertainty:         parseFloat(uncertainty.toFixed(3)),
    maxPositions,
    sectorBreakdown:     Object.fromEntries(
      Object.entries(sectorAllocated).map(([s, pct]) => [s, parseFloat(pct.toFixed(2))])
    ),
    generatedAt:         new Date().toISOString(),
  };

  logger.info("capitalAllocation: run complete", {
    candidates:  opportunities.length,
    approved:    approvedCount,
    consumedPct: budgetSummary.consumedBudgetPct.toFixed(1),
    riskMode,
    uncertainty: uncertainty.toFixed(2),
    sectors:     Object.keys(sectorAllocated).length,
  });

  return { opportunities: result, budgetSummary };
}

/* =========================================================
   HELPERS
========================================================= */

function _buildEmptyBudgetSummary(wsParams = {}, options = {}) {
  const riskMode      = String(wsParams.riskMode || "neutral").toLowerCase();
  const uncertainty   = clamp(safeNum(wsParams.uncertainty, 0), 0, 1);
  const totalBudgetEur = safeNum(
    options.totalBudgetEur ?? Number(process.env.ALLOCATION_BUDGET_EUR),
    10000
  );
  const totalBudgetPct = clamp(safeNum(options.totalBudgetPct, DEFAULT_TOTAL_BUDGET_PCT), 10, 100);

  return {
    totalBudgetEur,
    totalBudgetPct,
    consumedBudgetPct:   0,
    consumedBudgetEur:   0,
    remainingBudgetPct:  totalBudgetPct,
    remainingBudgetEur:  parseFloat(((totalBudgetEur * totalBudgetPct) / 100).toFixed(2)),
    approvedPositions:   0,
    totalCandidates:     0,
    riskMode,
    uncertainty:         parseFloat(uncertainty.toFixed(3)),
    maxPositions:        clamp(safeNum(options.maxPositions, DEFAULT_MAX_POSITIONS), 1, 25),
    sectorBreakdown:     {},
    generatedAt:         new Date().toISOString(),
  };
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  calculatePositionSize,
  applyCapitalAllocation,
  getSector,
  // Constants (exported for tests / admin use)
  REGIME_MULTIPLIERS,
  ANTIFRAGILE_THRESHOLD,
  DEFAULT_MAX_SECTOR_PCT,
  SECTOR_ALERT_MAX_PCT,
  DEFAULT_MAX_POSITIONS,
  DEFAULT_TOTAL_BUDGET_PCT,
};
