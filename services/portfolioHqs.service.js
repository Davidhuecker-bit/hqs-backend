"use strict";

/*
  HQS Diagnosis Engine
  Erklärt WARUM der Score ist wie er ist
*/

function analyzeConcentration(portfolio) {
  const totalWeight = portfolio.reduce((sum, p) => sum + p.weight, 0);
  const regionWeights = {};

  for (const p of portfolio) {
    regionWeights[p.region] =
      (regionWeights[p.region] || 0) + p.weight;
  }

  const maxRegion = Math.max(...Object.values(regionWeights));
  const ratio = maxRegion / totalWeight;

  if (ratio > 0.7) {
    return {
      severity: "high",
      message:
        "Hohe regionale Konzentration erhöht strukturelles Risiko.",
    };
  }

  if (ratio > 0.5) {
    return {
      severity: "medium",
      message:
        "Teilweise Konzentration – Diversifikation könnte verbessert werden.",
    };
  }

  return null;
}

function analyzeMomentumCluster(portfolio) {
  const weak = portfolio.filter(p => p.momentum < 45).length;
  const strong = portfolio.filter(p => p.momentum > 65).length;

  if (weak >= portfolio.length * 0.4) {
    return {
      severity: "high",
      message:
        "Ein signifikanter Teil des Portfolios zeigt schwaches Momentum.",
    };
  }

  if (strong >= portfolio.length * 0.4) {
    return {
      strength: true,
      message:
        "Mehrere Positionen zeigen starkes Momentum.",
    };
  }

  return null;
}

function analyzeInsiderCluster(portfolio) {
  const negative = portfolio.filter(p => p.insider < 0).length;

  if (negative >= portfolio.length * 0.3) {
    return {
      severity: "medium",
      message:
        "Mehrere Positionen zeigen Insider-Verkaufsdruck.",
    };
  }

  return null;
}

function analyzeVolatility(portfolio) {
  const highVol = portfolio.filter(p => p.volatility < 0).length;

  if (highVol >= portfolio.length * 0.5) {
    return {
      severity: "medium",
      message:
        "Erhöhte Intraday-Volatilität im Portfolio.",
    };
  }

  return null;
}

function buildDiagnosis(breakdown, finalScore, marketPhase) {
  const risks = [];
  const strengths = [];

  const concentration = analyzeConcentration(breakdown);
  if (concentration) risks.push(concentration);

  const momentum = analyzeMomentumCluster(breakdown);
  if (momentum) {
    if (momentum.strength) strengths.push(momentum);
    else risks.push(momentum);
  }

  const insider = analyzeInsiderCluster(breakdown);
  if (insider) risks.push(insider);

  const volatility = analyzeVolatility(breakdown);
  if (volatility) risks.push(volatility);

  let structuralRisk = risks.some(r => r.severity === "high");

  let regimeImpact =
    marketPhase === "risk_off"
      ? "Das aktuelle Marktumfeld begünstigt defensive Strategien."
      : marketPhase === "risk_on"
      ? "Das Marktumfeld unterstützt risikofreudige Positionierung."
      : "Neutrales Marktumfeld.";

  return {
    summary:
      finalScore >= 70
        ? "Strukturell solides Portfolio mit Optimierungspotenzial."
        : finalScore >= 50
        ? "Ausgewogenes Portfolio mit erkennbaren Risikofaktoren."
        : "Erhöhtes strukturelles Risiko – Analyse empfohlen.",

    structuralRisk,
    regimeImpact,
    topRisks: risks.slice(0, 3),
    topStrengths: strengths.slice(0, 2),
  };
}

module.exports = {
  buildDiagnosis,
};
