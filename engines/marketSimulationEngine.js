"use strict";

/*
  Market Simulation Engine
  Simulates different market conditions
*/

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

/* ===============================
   SCENARIO DEFINITIONS
================================ */

const SCENARIOS = {

  bull_market: {
    trendBoost: 0.15,
    volatilityShift: -0.05,
    label: "Bull Market Expansion"
  },

  bear_market: {
    trendBoost: -0.15,
    volatilityShift: 0.12,
    label: "Bear Market Stress"
  },

  volatility_spike: {
    trendBoost: -0.05,
    volatilityShift: 0.25,
    label: "Volatility Shock"
  },

  momentum_surge: {
    trendBoost: 0.25,
    volatilityShift: -0.02,
    label: "Momentum Expansion"
  }

};

/* ===============================
   APPLY SCENARIO
================================ */

function simulateScenario(features, advanced, scenarioKey) {

  const scenario = SCENARIOS[scenarioKey];

  if (!scenario) return null;

  const trend = safe(advanced?.trend);
  const volatility = safe(advanced?.volatilityAnnual);

  const simulatedTrend = trend + scenario.trendBoost;
  const simulatedVolatility = volatility + scenario.volatilityShift;

  return {

    scenario: scenarioKey,
    label: scenario.label,

    simulatedTrend,
    simulatedVolatility

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
================================ */

function calculateResilience(simulations) {

  if (!simulations.length) return 0;

  let score = 0;

  for (const sim of simulations) {

    if (sim.simulatedTrend > 0) score += 1;

  }

  return score / simulations.length;

}

module.exports = {
  runMarketSimulations,
  calculateResilience
};
