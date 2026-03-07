"use strict";

/*
  Narrative Engine
  Detects macro and sector narratives
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

/* ===============================
   NARRATIVE DEFINITIONS
================================ */

const NARRATIVES = {

  ai_infrastructure: {
    sectors: ["semiconductors", "software", "datacenter"],
    label: "AI Infrastructure Boom"
  },

  energy_supercycle: {
    sectors: ["energy", "oil", "gas"],
    label: "Energy Supercycle"
  },

  defense_growth: {
    sectors: ["defense", "aerospace"],
    label: "Defense Spending Growth"
  },

  cloud_expansion: {
    sectors: ["cloud", "software", "datacenter"],
    label: "Cloud Expansion"
  }

};

/* ===============================
   DETECT NARRATIVE
================================ */

function detectNarrative(symbolData) {

  const sector = (symbolData?.sector || "").toLowerCase();
  const trend = safe(symbolData?.trend);
  const relativeStrength = safe(symbolData?.relative);

  const matches = [];

  for (const key of Object.keys(NARRATIVES)) {

    const narrative = NARRATIVES[key];

    if (narrative.sectors.includes(sector)) {

      if (trend > 0.15 || relativeStrength > 0.6) {

        matches.push({
          type: key,
          label: narrative.label
        });

      }

    }

  }

  return matches;

}

/* ===============================
   NARRATIVE SCORE BOOST
================================ */

function narrativeBoost(narratives = []) {

  if (!narratives.length) return 0;

  let boost = 0;

  for (const n of narratives) {

    if (n.type === "ai_infrastructure") boost += 6;
    if (n.type === "energy_supercycle") boost += 5;
    if (n.type === "defense_growth") boost += 4;
    if (n.type === "cloud_expansion") boost += 5;

  }

  return boost;

}

module.exports = {
  detectNarrative,
  narrativeBoost
};
