"use strict";

/*
  Narrative Engine
  Detects macro and sector narratives

  Compatible upgraded version:
  - more robust sector matching
  - weighted narratives internally
  - configurable thresholds and boosts
  - capped total boost
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function envNum(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .trim();
}

function sectorMatches(sector, sectorList) {
  const normalizedSector = normalizeText(sector);
  if (!normalizedSector) return false;

  return sectorList.some((entry) => {
    const normalizedEntry = normalizeText(entry);
    return (
      normalizedSector === normalizedEntry ||
      normalizedSector.includes(normalizedEntry) ||
      normalizedEntry.includes(normalizedSector)
    );
  });
}

/* ===============================
   NARRATIVE DEFINITIONS
================================ */

const NARRATIVES = {
  ai_infrastructure: {
    sectors: ["semiconductors", "software", "datacenter", "chips", "hardware"],
    label: "AI Infrastructure Boom",
    weight: envNum("NARRATIVE_WEIGHT_AI_INFRA", 1.2),
    boost: envNum("NARRATIVE_BOOST_AI_INFRA", 6),
  },

  energy_supercycle: {
    sectors: ["energy", "oil", "gas", "renewables", "utilities"],
    label: "Energy Supercycle",
    weight: envNum("NARRATIVE_WEIGHT_ENERGY", 1.0),
    boost: envNum("NARRATIVE_BOOST_ENERGY", 5),
  },

  defense_growth: {
    sectors: ["defense", "aerospace", "security"],
    label: "Defense Spending Growth",
    weight: envNum("NARRATIVE_WEIGHT_DEFENSE", 1.1),
    boost: envNum("NARRATIVE_BOOST_DEFENSE", 5),
  },

  cloud_expansion: {
    sectors: ["cloud", "software", "datacenter", "saas"],
    label: "Cloud Expansion",
    weight: envNum("NARRATIVE_WEIGHT_CLOUD", 0.9),
    boost: envNum("NARRATIVE_BOOST_CLOUD", 4),
  },
};

const TREND_THRESHOLD = envNum("NARRATIVE_TREND_THRESHOLD", 0.12);
const RELATIVE_THRESHOLD = envNum("NARRATIVE_RELATIVE_THRESHOLD", 0.55);
const MAX_TOTAL_BOOST = envNum("NARRATIVE_MAX_TOTAL_BOOST", 15);

/* ===============================
   DETECT NARRATIVE
================================ */

function detectNarrative(symbolData) {
  const sector = normalizeText(symbolData?.sector);
  const trend = safe(symbolData?.trend);
  const relativeStrength = safe(symbolData?.relative);

  const matches = [];

  if (!sector) return matches;

  for (const [key, narrative] of Object.entries(NARRATIVES)) {
    if (!sectorMatches(sector, narrative.sectors)) continue;

    if (trend > TREND_THRESHOLD || relativeStrength > RELATIVE_THRESHOLD) {
      matches.push({
        type: key,
        label: narrative.label,
      });
    }
  }

  return matches;
}

/* ===============================
   NARRATIVE SCORE BOOST
================================ */

function narrativeBoost(narratives = []) {
  if (!Array.isArray(narratives) || !narratives.length) return 0;

  let totalBoost = 0;

  for (const n of narratives) {
    const narrativeType = n?.type;
    if (!narrativeType) continue;

    const config = NARRATIVES[narrativeType];
    if (!config) continue;

    const weightedBoost = safe(config.boost) * safe(config.weight, 1);
    totalBoost += weightedBoost;
  }

  return Math.min(MAX_TOTAL_BOOST, Math.round(totalBoost));
}

module.exports = {
  detectNarrative,
  narrativeBoost,
};
