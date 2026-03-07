"use strict";

/*
 Event Intelligence Engine

 Erkennt makroökonomische Ereignisse
 und deren Auswirkungen auf Märkte
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

/* =========================================================
 EVENT DETECTION
========================================================= */

function detectGeopoliticalShock(data) {

  const oil = safe(data.oilTrend);
  const gold = safe(data.goldTrend);

  if (oil > 0.12 && gold > 0.08) {

    return {
      type: "geopolitical_shock",
      label: "Geopolitical Conflict Signal"
    };

  }

  return null;
}

function detectInflationShock(data) {

  const oil = safe(data.oilTrend);
  const bonds = safe(data.bondTrend);

  if (oil > 0.10 && bonds < -0.05) {

    return {
      type: "inflation_shock",
      label: "Inflation Pressure Signal"
    };

  }

  return null;
}

function detectMonetaryShift(data) {

  const dollar = safe(data.dollarTrend);
  const tech = safe(data.techTrend);

  if (dollar > 0.08 && tech < -0.05) {

    return {
      type: "tightening_cycle",
      label: "Monetary Tightening Cycle"
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
    banks: 0

  };

  for (const e of events) {

    if (e.type === "geopolitical_shock") {

      sectors.energy += 2;
      sectors.gold += 2;
      sectors.defense += 2;
      sectors.airlines -= 1;

    }

    if (e.type === "inflation_shock") {

      sectors.energy += 1;
      sectors.gold += 1;
      sectors.technology -= 1;

    }

    if (e.type === "tightening_cycle") {

      sectors.banks += 2;
      sectors.technology -= 2;

    }

  }

  return sectors;

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

  return {

    events,

    sectorImpact,

    eventSummary: events.map(e => e.label)

  };

}

module.exports = {
  analyzeMacroEvents
};
