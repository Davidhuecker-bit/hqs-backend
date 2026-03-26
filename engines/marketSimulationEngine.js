"use strict";

/*
  Market Simulation Engine
  Simulates different market conditions

  Final compatible version:
  - same function names
  - same input signature
  - same output contract
  - improved scenario realism
  - improved resilience scoring
  - env-configurable scenario tuning
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

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, safe(v, min)));
}

/* ===============================
   SCENARIO DEFINITIONS
================================ */

const SCENARIOS = {
  bull_market: {
    trendShift: envNum("SIM_BULL_TREND_SHIFT", 0.10),
    volaMult: envNum("SIM_BULL_VOLA_MULT", 0.85),
    label: "Bull Market Expansion",
    impactWeight: envNum("SIM_BULL_WEIGHT", 1.0),
  },

  bear_market: {
    trendShift: envNum("SIM_BEAR_TREND_SHIFT", -0.15),
    volaMult: envNum("SIM_BEAR_VOLA_MULT", 1.40),
    label: "Bear Market Stress",
    impactWeight: envNum("SIM_BEAR_WEIGHT", 1.5),
  },

  volatility_spike: {
    trendShift: envNum("SIM_SPIKE_TREND_SHIFT", -0.05),
    volaMult: envNum("SIM_SPIKE_VOLA_MULT", 1.80),
    label: "Volatility Shock",
    impactWeight: envNum("SIM_SPIKE_WEIGHT", 1.2),
  },

  momentum_surge: {
    trendShift: envNum("SIM_MOM_TREND_SHIFT", 0.20),
    volaMult: envNum("SIM_MOM_VOLA_MULT", 0.90),
    label: "Momentum Expansion",
    impactWeight: envNum("SIM_MOM_WEIGHT", 0.9),
  },
};

const MIN_SIM_VOLA = envNum("SIM_MIN_VOLA", 0.05);
const MAX_SIM_VOLA = envNum("SIM_MAX_VOLA", 1.5);
const HIGH_STRESS_VOLA = envNum("SIM_HIGH_STRESS_VOLA", 0.8);
const NEAR_BREAKDOWN_TREND = envNum("SIM_NEAR_BREAKDOWN_TREND", -0.05);

/* ===============================
   APPLY SCENARIO
================================ */

function simulateScenario(features, advanced, scenarioKey) {
  const scenario = SCENARIOS[scenarioKey];
  if (!scenario) return null;

  const trend = safe(advanced?.trend);
  const volatility = Math.max(0, safe(advanced?.volatilityAnnual, 0.2));

  // Multiplicative volatility stress is more realistic than pure additive shifts
  const simulatedTrend = trend + scenario.trendShift;
  const simulatedVolatility = clamp(
    volatility * scenario.volaMult,
    MIN_SIM_VOLA,
    MAX_SIM_VOLA
  );

  return {
    scenario: scenarioKey,
    label: scenario.label,
    simulatedTrend,
    simulatedVolatility,
    impactWeight: scenario.impactWeight,
  };
}

/* ===============================
   RUN ALL SCENARIOS
================================ */

function runMarketSimulations(features, advanced) {
  const results = [];

  for (const key of Object.keys(SCENARIOS)) {
    const sim = simulateScenario(features, advanced, key);
    if (sim) results.push(sim);
  }

  return results;
}

/* ===============================
   RESILIENCE SCORE
   Returns compatible score in range 0..1
================================ */

function calculateResilience(simulations) {
  if (!Array.isArray(simulations) || !simulations.length) return 0;

  let totalWeight = 0;
  let weightedScore = 0;

  for (const sim of simulations) {
    const weight = safe(sim?.impactWeight, 1);
    const simulatedTrend = safe(sim?.simulatedTrend);
    const simulatedVolatility = safe(sim?.simulatedVolatility);

    let scenarioScore = 0;

    // Core resilience logic:
    // 1. Positive under scenario => strong resilience
    // 2. Slightly negative => partial resilience
    // 3. Deeply negative => weak resilience
    if (simulatedTrend > 0) {
      scenarioScore = 1;
    } else if (simulatedTrend > NEAR_BREAKDOWN_TREND) {
      scenarioScore = 0.5;
    } else {
      scenarioScore = 0;
    }

    // Stress penalty for extreme volatility
    if (simulatedVolatility > HIGH_STRESS_VOLA) {
      scenarioScore *= 0.5;
    }

    weightedScore += scenarioScore * weight;
    totalWeight += weight;
  }

  if (totalWeight <= 0) return 0;

  return weightedScore / totalWeight;
}

module.exports = {
  runMarketSimulations,
  calculateResilience,
};
