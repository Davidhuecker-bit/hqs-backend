"use strict";

/*
  Cross Asset Intelligence Engine

  Analysiert Zusammenhänge zwischen:
  - Dollar (DXY)
  - Gold
  - Oil
  - VIX
  - Bonds

  Erkennt Makro-Zyklen und Kapitalflüsse.
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/* =========================================================
   SIGNAL DETECTION
========================================================= */

function detectCommodityExpansion(data) {

  const dollar = safe(data.dollarTrend);
  const gold = safe(data.goldTrend);
  const oil = safe(data.oilTrend);

  if (dollar < -0.05 && gold > 0.08 && oil > 0.08) {

    return {
      type: "commodity_expansion",
      label: "Commodity Expansion Cycle",
      strength: clamp((gold + oil) / 2, 0, 1)
    };

  }

  return null;
}

function detectDollarStrength(data) {

  const dollar = safe(data.dollarTrend);
  const gold = safe(data.goldTrend);

  if (dollar > 0.06 && gold < -0.03) {

    return {
      type: "dollar_strength",
      label: "Dollar Strength Cycle",
      strength: clamp(dollar, 0, 1)
    };

  }

  return null;
}

function detectEnergyShock(data) {

  const oil = safe(data.oilTrend);

  if (oil > 0.12) {

    return {
      type: "energy_shock",
      label: "Energy Price Shock",
      strength: clamp(oil, 0, 1)
    };

  }

  return null;
}

function detectRiskOff(data) {

  const vix = safe(data.vixTrend);
  const stocks = safe(data.marketTrend);

  if (vix > 0.15 && stocks < -0.05) {

    return {
      type: "risk_off",
      label: "Risk-Off Environment",
      strength: clamp(vix, 0, 1)
    };

  }

  return null;
}

/* =========================================================
   SECTOR IMPACT
========================================================= */

function buildSectorImpact(signals) {

  const sectors = {
    energy: 0,
    commodities: 0,
    technology: 0,
    defensive: 0,
    gold_miners: 0
  };

  for (const s of signals) {

    if (s.type === "commodity_expansion") {

      sectors.energy += 2;
      sectors.commodities += 2;
      sectors.gold_miners += 1;

    }

    if (s.type === "energy_shock") {

      sectors.energy += 3;

    }

    if (s.type === "dollar_strength") {

      sectors.technology -= 1;
      sectors.commodities -= 1;

    }

    if (s.type === "risk_off") {

      sectors.defensive += 2;
      sectors.technology -= 1;

    }

  }

  return sectors;

}

/* =========================================================
   MAIN ENGINE
========================================================= */

function analyzeCrossAssetEnvironment(data = {}) {

  const signals = [];

  const commodity = detectCommodityExpansion(data);
  if (commodity) signals.push(commodity);

  const dollar = detectDollarStrength(data);
  if (dollar) signals.push(dollar);

  const energy = detectEnergyShock(data);
  if (energy) signals.push(energy);

  const risk = detectRiskOff(data);
  if (risk) signals.push(risk);

  const sectorImpact = buildSectorImpact(signals);

  return {

    signals,

    sectorImpact,

    macroSummary: signals.map(s => s.label),

  };

}

module.exports = {
  analyzeCrossAssetEnvironment
};
