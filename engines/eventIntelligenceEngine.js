"use strict";

/*
  Event Intelligence Engine

  Erkennt makroökonomische Ereignisse
  und deren Auswirkungen auf Märkte

  Final compatible version:
  - same main export
  - same primary return structure
  - enhanced severity-aware detection
  - richer but backward-safe output
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v, min = 0, max = 1) {
  return Math.max(min, Math.min(max, v));
}

function envNum(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/* =========================================================
   CONFIG
========================================================= */

const CONFIG = {
  geopolitical: {
    oilMin: envNum("EVENT_GEO_OIL_MIN", 0.10),
    goldMin: envNum("EVENT_GEO_GOLD_MIN", 0.06),
    vixWeight: envNum("EVENT_GEO_VIX_WEIGHT", 1.0),
    severityDivisor: envNum("EVENT_GEO_SEVERITY_DIV", 0.5),
  },
  inflation: {
    oilMin: envNum("EVENT_INFL_OIL_MIN", 0.10),
    bondsMax: envNum("EVENT_INFL_BONDS_MAX", -0.05),
    severityDivisor: envNum("EVENT_INFL_SEVERITY_DIV", 0.4),
  },
  tightening: {
    dollarMin: envNum("EVENT_TIGHT_DOLLAR_MIN", 0.05),
    yieldMin: envNum("EVENT_TIGHT_YIELD_MIN", 0.05),
    techMax: envNum("EVENT_TIGHT_TECH_MAX", -0.04),
    severityDivisor: envNum("EVENT_TIGHT_SEVERITY_DIV", 0.4),
  },
  stressCap: envNum("EVENT_MACRO_STRESS_CAP", 1),
};

/* =========================================================
   EVENT DETECTION
========================================================= */

function detectGeopoliticalShock(data) {
  const oil = safe(data?.oilTrend);
  const gold = safe(data?.goldTrend);
  const vix = safe(data?.vixTrend, 0);

  if (oil > CONFIG.geopolitical.oilMin && gold > CONFIG.geopolitical.goldMin) {
    const severity = clamp(
      (oil + gold + vix * CONFIG.geopolitical.vixWeight) /
        CONFIG.geopolitical.severityDivisor,
      0.1,
      1
    );

    return {
      type: "geopolitical_shock",
      label: "Geopolitical Conflict Signal",
      severity,
    };
  }

  return null;
}

function detectInflationShock(data) {
  const oil = safe(data?.oilTrend);
  const bonds = safe(data?.bondTrend);

  if (oil > CONFIG.inflation.oilMin && bonds < CONFIG.inflation.bondsMax) {
    const severity = clamp(
      (oil + Math.abs(bonds)) / CONFIG.inflation.severityDivisor,
      0.1,
      1
    );

    return {
      type: "inflation_shock",
      label: "Inflation Pressure Signal",
      severity,
    };
  }

  return null;
}

function detectMonetaryShift(data) {
  const dollar = safe(data?.dollarTrend);
  const yields = safe(
    data?.bondYieldTrend,
    safe(data?.bondTrend, 0) * -1
  );
  const tech = safe(data?.techTrend);

  const tighteningByYieldAndTech =
    dollar > CONFIG.tightening.dollarMin &&
    yields > CONFIG.tightening.yieldMin &&
    tech < CONFIG.tightening.techMax;

  const tighteningByLegacyFallback =
    dollar > Math.max(CONFIG.tightening.dollarMin, 0.08) &&
    tech < Math.min(CONFIG.tightening.techMax, -0.05);

  if (tighteningByYieldAndTech || tighteningByLegacyFallback) {
    const severity = clamp(
      (dollar + Math.max(0, yields) + Math.abs(Math.min(0, tech))) /
        CONFIG.tightening.severityDivisor,
      0.1,
      1
    );

    return {
      type: "tightening_cycle",
      label: "Monetary Tightening Cycle",
      severity,
    };
  }

  return null;
}

/* =========================================================
   SECTOR IMPACT
========================================================= */

function mapSectorImpact(events) {
  const sectors = {
    energy: 0,
    gold: 0,
    defense: 0,
    technology: 0,
    airlines: 0,
    banks: 0,
    real_estate: 0,
  };

  for (const e of events || []) {
    const s = safe(e?.severity, 1);

    if (e.type === "geopolitical_shock") {
      sectors.energy += 3 * s;
      sectors.gold += 2 * s;
      sectors.defense += 4 * s;
      sectors.airlines -= 2 * s;
      sectors.technology -= 0.5 * s;
    }

    if (e.type === "inflation_shock") {
      sectors.energy += 2 * s;
      sectors.gold += 2 * s;
      sectors.technology -= 2 * s;
      sectors.real_estate -= 1 * s;
    }

    if (e.type === "tightening_cycle") {
      sectors.banks += 3 * s;
      sectors.technology -= 3 * s;
      sectors.real_estate -= 2 * s;
    }
  }

  // optional rounding for cleaner downstream display/debugging
  for (const key of Object.keys(sectors)) {
    sectors[key] = Number(sectors[key].toFixed(3));
  }

  return sectors;
}

/* =========================================================
   MACRO STRESS
========================================================= */

function calculateMacroStressScore(events = []) {
  if (!Array.isArray(events) || !events.length) return 0;

  const total = events.reduce((sum, e) => sum + safe(e?.severity, 0), 0);
  return clamp(total, 0, CONFIG.stressCap);
}

/* =========================================================
   MAIN ENGINE
========================================================= */

function analyzeMacroEvents(data = {}) {
  const events = [];

  const geo = detectGeopoliticalShock(data);
  if (geo) events.push(geo);

  const infl = detectInflationShock(data);
  if (infl) events.push(infl);

  const mon = detectMonetaryShift(data);
  if (mon) events.push(mon);

  const sectorImpact = mapSectorImpact(events);
  const macroStressScore = calculateMacroStressScore(events);

  return {
    events,
    sectorImpact,
    eventSummary: events.map((e) =>
      e?.severity
        ? `${e.label} (${Math.round(safe(e.severity) * 100)}%)`
        : e.label
    ),
    macroStressScore,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  analyzeMacroEvents,
};
