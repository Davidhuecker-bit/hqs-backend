"use strict";

/*
  HQS 2.0 Block 2 – Sector Template Basis
  ────────────────────────────────────────
  Provides:
  - SECTOR_TEMPLATES: simple, auditable set of scoring contexts
  - deriveSectorTemplate(): maps raw sector/industry string to a template key
  - applySectorQualityAdjustment(): sector-aware quality scoring on top of
    the base calculateQuality() result in hqsEngine.js
  - buildSectorContext(): returns full sector meta block for HQS output

  Design principles:
  - Defensive defaults: unknown sector → "default" template (no aggressive assumptions)
  - Same metric is NOT scored identically across sectors
  - No fake peer Z-scores; peerContextAvailable = false unless real data is present
  - Simple, auditable rules only – no black-box ML here
*/

/* =========================================================
   SECTOR TEMPLATES
   Each template defines a named scoring context with:
   - label: display name
   - description: why this context matters
   - qualityAdjustment: per-field weight modifiers relative to base quality score
     (positive = more credit, negative = less credit / different threshold)
   - sectorScoringFlags: human-readable flags to surface in HQS output
========================================================= */

const SECTOR_TEMPLATES = {
  tech: {
    label: "Tech / Growth",
    description: "High-growth, often pre-profit companies; revenue growth weighted higher; debtToEquity less penalised at low-to-moderate levels",
    qualityAdjustment: {
      revenueGrowthBonus: 5,       // extra credit for strong revenue growth (>10%)
      revenueGrowthHighBonus: 3,   // extra for >20%
      netMarginBonus: 0,           // margin matters but less so than growth
      netMarginHighBonus: 0,
      roePenaltyThreshold: 0,      // ROE threshold unchanged
      debtToEquityLowBonus: 2,     // debt<1 still good but smaller bonus
      debtToEquityHighPenalty: -5, // debt>2 still bad but softer penalty (growth cos may carry debt)
    },
    sectorScoringFlags: ["growth_weighted", "debt_tolerant_if_moderate"],
  },

  financial: {
    label: "Financial",
    description: "Banks, insurers, asset managers; debtToEquity is a structural metric not a risk signal; ROE is the primary quality driver",
    qualityAdjustment: {
      revenueGrowthBonus: 0,
      revenueGrowthHighBonus: 0,
      netMarginBonus: 3,           // margin still valuable
      netMarginHighBonus: 2,
      roePenaltyThreshold: 0,      // ROE same threshold
      debtToEquityLowBonus: -3,    // low D/E is NOT necessarily good for banks (levered by design)
      debtToEquityHighPenalty: 0,  // high D/E is NORMAL for financials – no penalty
    },
    sectorScoringFlags: ["roe_primary", "debt_structural_not_penalised"],
  },

  industrial: {
    label: "Industrial",
    description: "Manufacturing, logistics, construction; moderate margins expected; moderate debt is normal for capex-heavy operations",
    qualityAdjustment: {
      revenueGrowthBonus: 2,
      revenueGrowthHighBonus: 2,
      netMarginBonus: 2,
      netMarginHighBonus: 2,
      roePenaltyThreshold: 0,
      debtToEquityLowBonus: 3,     // low debt is good
      debtToEquityHighPenalty: -6, // high debt slightly softer than default
    },
    sectorScoringFlags: ["capex_moderate_debt_tolerated"],
  },

  defensive: {
    label: "Defensive / Consumer",
    description: "Consumer staples, utilities, healthcare; stable margins valued over growth; low debt strongly preferred",
    qualityAdjustment: {
      revenueGrowthBonus: -2,      // growth is less important here
      revenueGrowthHighBonus: -1,
      netMarginBonus: 4,           // margin stability is key
      netMarginHighBonus: 4,
      roePenaltyThreshold: 0,
      debtToEquityLowBonus: 6,     // low debt strongly rewarded
      debtToEquityHighPenalty: -12, // high debt strongly penalised
    },
    sectorScoringFlags: ["margin_stability_primary", "low_debt_strongly_preferred"],
  },

  real_asset: {
    label: "Real Asset / Capital Intensive",
    description: "Energy, mining, real estate, infrastructure; high debt is structural; asset-backed revenue; ROE less reliable",
    qualityAdjustment: {
      revenueGrowthBonus: 2,
      revenueGrowthHighBonus: 1,
      netMarginBonus: 1,
      netMarginHighBonus: 1,
      roePenaltyThreshold: 0,
      debtToEquityLowBonus: 1,     // low debt is positive but less decisive
      debtToEquityHighPenalty: -3, // debt is expected – softer penalty
    },
    sectorScoringFlags: ["asset_backed", "debt_structural_softer_penalty"],
  },

  default: {
    label: "Default",
    description: "Sector not identified or not covered by a specific template; base scoring applies unchanged",
    qualityAdjustment: {
      revenueGrowthBonus: 0,
      revenueGrowthHighBonus: 0,
      netMarginBonus: 0,
      netMarginHighBonus: 0,
      roePenaltyThreshold: 0,
      debtToEquityLowBonus: 0,
      debtToEquityHighPenalty: 0,
    },
    sectorScoringFlags: [],
  },
};

/* =========================================================
   SECTOR → TEMPLATE MAPPING
   Maps raw sector/industry strings to a SECTOR_TEMPLATES key.
   Matching is case-insensitive, partial-string based.
   Falls back to "default" when sector is unknown or ambiguous.
========================================================= */

const SECTOR_KEYWORD_MAP = [
  // tech / growth
  { keywords: ["technology", "tech", "software", "semiconductor", "internet", "telecom", "communication", "media", "information"], template: "tech" },
  // financial
  { keywords: ["financial", "finance", "bank", "insurance", "asset management", "brokerage", "capital market", "mortgage", "diversified financial"], template: "financial" },
  // industrial
  { keywords: ["industrial", "manufacturing", "aerospace", "defense", "construction", "machinery", "engineering", "transport", "logistics", "airline", "railroad", "shipping"], template: "industrial" },
  // defensive / consumer
  { keywords: ["consumer staple", "consumer defensive", "healthcare", "health care", "pharmaceutical", "pharma", "biotech", "utility", "utilities", "retail", "food", "beverage", "household"], template: "defensive" },
  // real asset / capital intensive
  { keywords: ["energy", "oil", "gas", "mining", "metal", "material", "real estate", "reit", "infrastructure", "commodity", "resource", "chemical"], template: "real_asset" },
];

/**
 * deriveSectorTemplate(sector, industry)
 * Returns a SECTOR_TEMPLATES key ("tech" | "financial" | "industrial" | "defensive" | "real_asset" | "default").
 * Never throws – always returns a safe string.
 */
function deriveSectorTemplate(sector, industry) {
  const combined = [
    String(sector || "").toLowerCase().trim(),
    String(industry || "").toLowerCase().trim(),
  ].join(" ");

  if (!combined.trim()) return "default";

  for (const entry of SECTOR_KEYWORD_MAP) {
    for (const kw of entry.keywords) {
      if (combined.includes(kw)) {
        return entry.template;
      }
    }
  }

  return "default";
}

/* =========================================================
   SECTOR-AWARE QUALITY ADJUSTMENT
   Receives the already-computed base quality score (0–100)
   and applies template-specific deltas. Returns adjusted score
   still clamped to [0, 100].

   Also returns appliedAdjustments[] for transparency.
========================================================= */

function clamp(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function safe(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * applySectorQualityAdjustment(baseQuality, fundamentals, templateKey)
 * Returns { adjustedQuality, appliedAdjustments }
 * where appliedAdjustments is a string[] describing what changed.
 */
function applySectorQualityAdjustment(baseQuality, fundamentals, templateKey) {
  const template = SECTOR_TEMPLATES[templateKey] || SECTOR_TEMPLATES.default;
  const adj = template.qualityAdjustment;
  const appliedAdjustments = [];

  if (!fundamentals) {
    return {
      adjustedQuality: clamp(baseQuality, 0, 100),
      appliedAdjustments: [],
    };
  }

  let delta = 0;

  // Revenue growth adjustments
  if (safe(fundamentals.revenueGrowth) > 10 && adj.revenueGrowthBonus !== 0) {
    delta += adj.revenueGrowthBonus;
    appliedAdjustments.push(`revenueGrowth>10: ${adj.revenueGrowthBonus > 0 ? "+" : ""}${adj.revenueGrowthBonus}`);
  }
  if (safe(fundamentals.revenueGrowth) > 20 && adj.revenueGrowthHighBonus !== 0) {
    delta += adj.revenueGrowthHighBonus;
    appliedAdjustments.push(`revenueGrowth>20: ${adj.revenueGrowthHighBonus > 0 ? "+" : ""}${adj.revenueGrowthHighBonus}`);
  }

  // Net margin adjustments
  if (safe(fundamentals.netMargin) > 15 && adj.netMarginBonus !== 0) {
    delta += adj.netMarginBonus;
    appliedAdjustments.push(`netMargin>15: ${adj.netMarginBonus > 0 ? "+" : ""}${adj.netMarginBonus}`);
  }
  if (safe(fundamentals.netMargin) > 25 && adj.netMarginHighBonus !== 0) {
    delta += adj.netMarginHighBonus;
    appliedAdjustments.push(`netMargin>25: ${adj.netMarginHighBonus > 0 ? "+" : ""}${adj.netMarginHighBonus}`);
  }

  // Debt-to-equity adjustments (overrides base scoring deltas when template differs from default)
  if (safe(fundamentals.debtToEquity) < 1 && adj.debtToEquityLowBonus !== 0) {
    delta += adj.debtToEquityLowBonus;
    appliedAdjustments.push(`debtToEquity<1: ${adj.debtToEquityLowBonus > 0 ? "+" : ""}${adj.debtToEquityLowBonus}`);
  }
  if (safe(fundamentals.debtToEquity) > 2 && adj.debtToEquityHighPenalty !== 0) {
    delta += adj.debtToEquityHighPenalty;
    appliedAdjustments.push(`debtToEquity>2: ${adj.debtToEquityHighPenalty}`);
  }

  const adjustedQuality = clamp(Math.round(baseQuality + delta), 0, 100);

  return { adjustedQuality, appliedAdjustments };
}

/* =========================================================
   BUILD SECTOR CONTEXT
   Main entry point called by hqsEngine.buildHQSResponse().
   Returns sector meta block for HQS output and DB storage.
========================================================= */

/**
 * buildSectorContext(entityMeta, fundamentals)
 *
 * entityMeta: { sector, industry } from entity_map or market normalizer.
 *             May be null/undefined → defensive default.
 * fundamentals: already-resolved fundamentals record (or null).
 *
 * Returns {
 *   sectorTemplate,        // template key string
 *   sectorLabel,           // human-readable label
 *   sectorScoringFlags,    // string[]
 *   peerContextAvailable,  // boolean – false until real peer data exists
 *   normalizationMeta,     // { basis, templateApplied, peerBasis }
 *   sectorReason,          // short human-readable explanation
 * }
 */
function buildSectorContext(entityMeta, fundamentals) {
  const rawSector = entityMeta?.sector || null;
  const rawIndustry = entityMeta?.industry || null;

  const templateKey = deriveSectorTemplate(rawSector, rawIndustry);
  const template = SECTOR_TEMPLATES[templateKey];

  // peerContextAvailable signals whether sector-template-based normalization is active.
  // No external peer-group data is used yet; this is a sector-template-level reference
  // (not a true per-company peer comparison). It is set true only when:
  //   - a named (non-default) template was identified, AND
  //   - fundamentals are present to act on the template adjustments.
  // Consumers should treat "true" as "sector-aware scoring applied via template defaults",
  // not as "full peer-group Z-score normalization available".
  const peerContextAvailable = (templateKey !== "default") && (fundamentals != null);

  const normalizationMeta = {
    basis: peerContextAvailable ? "sector_template_defaults" : "no_peer_context",
    templateApplied: templateKey,
    peerBasis: peerContextAvailable
      ? `Sector template "${template.label}" used as normalization reference`
      : "No peer context; base scoring unchanged",
  };

  let sectorReason;
  if (templateKey === "default") {
    sectorReason = rawSector
      ? `Sector "${rawSector}" did not match any known template; default scoring applied`
      : "No sector information available; default scoring applied";
  } else {
    const src = rawSector ? `"${rawSector}"` : "industry metadata";
    sectorReason = `Sector ${src} matched template "${template.label}": ${template.description}`;
  }

  return {
    sectorTemplate: templateKey,
    sectorLabel: template.label,
    sectorScoringFlags: [...template.sectorScoringFlags],
    peerContextAvailable,
    normalizationMeta,
    sectorReason,
  };
}

module.exports = {
  SECTOR_TEMPLATES,
  deriveSectorTemplate,
  applySectorQualityAdjustment,
  buildSectorContext,
};
