"use strict";

// engines/adminTargets.engine.js
// Soll-Ist-System für dein Kontrollzentrum.
// Zeigt aktuellen Wert, Zielwert, Lücke und Status.

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round2(value) {
  return Number(safeNum(value, 0).toFixed(2));
}

function buildTargetEntry({
  key,
  title,
  current,
  target,
  unit = "%",
  higherIsBetter = true,
}) {
  const currentValue = round2(current);
  const targetValue = round2(target);

  let gap;
  let progress;

  if (higherIsBetter) {
    gap = round2(targetValue - currentValue);
    progress = targetValue > 0 ? round2((currentValue / targetValue) * 100) : 0;
  } else {
    gap = round2(currentValue - targetValue);
    progress = currentValue <= targetValue
      ? 100
      : targetValue > 0
        ? round2((targetValue / currentValue) * 100)
        : 0;
  }

  progress = clamp(progress, 0, 100);

  let status = "far";
  if (progress >= 100) status = "reached";
  else if (progress >= 85) status = "close";
  else if (progress >= 65) status = "mid";
  else status = "far";

  return {
    key,
    title,
    current: currentValue,
    target: targetValue,
    gap: round2(gap),
    progress,
    status,
    unit,
  };
}

function buildAdminTargets({
  insights = {},
  diagnostics = {},
  validation = {},
} = {}) {
  const snapshotCoverage = safeNum(insights?.coverage?.snapshotUniverseCoverage, 0);
  const advancedCoverage = safeNum(insights?.coverage?.advancedCoverageVsSnapshots, 0);
  const outcomeCoverage = safeNum(insights?.coverage?.outcomeCoverageVsSnapshots, 0);
  const outcomeCompletion = safeNum(insights?.activity?.outcomes?.completionRate, 0);

  const systemHealth = safeNum(diagnostics?.health?.systemHealthScore, 0);
  const learningHealth = safeNum(diagnostics?.health?.learningHealthScore, 0);
  const discoveryHealth = safeNum(diagnostics?.health?.discoveryHealthScore, 0);

  const calculationTrust = safeNum(validation?.trust?.overallCalculationTrust, 0);
  const hqsConfidence = safeNum(validation?.trust?.hqsConfidence, 0);
  const learningConfidence = safeNum(validation?.trust?.learningConfidence, 0);
  const discoveryConfidence = safeNum(validation?.trust?.discoveryConfidence, 0);
  const simulationConfidence = safeNum(validation?.trust?.simulationConfidence, 0);
  const regimeConfidence = safeNum(validation?.trust?.regimeConfidence, 0);

  const targets = {
    stabilityCore: [
      buildTargetEntry({
        key: "system_health",
        title: "System Health",
        current: systemHealth,
        target: 80,
      }),
      buildTargetEntry({
        key: "snapshot_coverage",
        title: "Snapshot Coverage",
        current: snapshotCoverage,
        target: 75,
      }),
      buildTargetEntry({
        key: "advanced_coverage",
        title: "Advanced Metrics Coverage",
        current: advancedCoverage,
        target: 70,
      }),
      buildTargetEntry({
        key: "outcome_coverage",
        title: "Outcome Coverage",
        current: outcomeCoverage,
        target: 65,
      }),
    ],

    learningCore: [
      buildTargetEntry({
        key: "learning_health",
        title: "Learning Health",
        current: learningHealth,
        target: 75,
      }),
      buildTargetEntry({
        key: "outcome_completion",
        title: "Outcome Completion",
        current: outcomeCompletion,
        target: 50,
      }),
      buildTargetEntry({
        key: "learning_confidence",
        title: "Learning Confidence",
        current: learningConfidence,
        target: 70,
      }),
      buildTargetEntry({
        key: "regime_confidence",
        title: "Regime Confidence",
        current: regimeConfidence,
        target: 65,
      }),
    ],

    calculationCore: [
      buildTargetEntry({
        key: "calculation_trust",
        title: "Overall Calculation Trust",
        current: calculationTrust,
        target: 75,
      }),
      buildTargetEntry({
        key: "hqs_confidence",
        title: "HQS Confidence",
        current: hqsConfidence,
        target: 70,
      }),
      buildTargetEntry({
        key: "discovery_confidence",
        title: "Discovery Confidence",
        current: discoveryConfidence,
        target: 65,
      }),
      buildTargetEntry({
        key: "simulation_confidence",
        title: "Simulation Confidence",
        current: simulationConfidence,
        target: 60,
      }),
    ],

    scaling450: [
      buildTargetEntry({
        key: "scale450_system_health",
        title: "System Health für 450 Aktien",
        current: systemHealth,
        target: 72,
      }),
      buildTargetEntry({
        key: "scale450_snapshot_coverage",
        title: "Snapshot Coverage für 450 Aktien",
        current: snapshotCoverage,
        target: 70,
      }),
      buildTargetEntry({
        key: "scale450_advanced_coverage",
        title: "Advanced Coverage für 450 Aktien",
        current: advancedCoverage,
        target: 60,
      }),
      buildTargetEntry({
        key: "scale450_outcome_completion",
        title: "Outcome Completion für 450 Aktien",
        current: outcomeCompletion,
        target: 40,
      }),
    ],

    scaling600: [
      buildTargetEntry({
        key: "scale600_system_health",
        title: "System Health für 600 Aktien",
        current: systemHealth,
        target: 80,
      }),
      buildTargetEntry({
        key: "scale600_snapshot_coverage",
        title: "Snapshot Coverage für 600 Aktien",
        current: snapshotCoverage,
        target: 80,
      }),
      buildTargetEntry({
        key: "scale600_advanced_coverage",
        title: "Advanced Coverage für 600 Aktien",
        current: advancedCoverage,
        target: 72,
      }),
      buildTargetEntry({
        key: "scale600_outcome_completion",
        title: "Outcome Completion für 600 Aktien",
        current: outcomeCompletion,
        target: 50,
      }),
      buildTargetEntry({
        key: "scale600_learning_confidence",
        title: "Learning Confidence für 600 Aktien",
        current: learningConfidence,
        target: 72,
      }),
    ],

    scaling1000: [
      buildTargetEntry({
        key: "scale1000_system_health",
        title: "System Health für 1000 Aktien",
        current: systemHealth,
        target: 88,
      }),
      buildTargetEntry({
        key: "scale1000_snapshot_coverage",
        title: "Snapshot Coverage für 1000 Aktien",
        current: snapshotCoverage,
        target: 88,
      }),
      buildTargetEntry({
        key: "scale1000_advanced_coverage",
        title: "Advanced Coverage für 1000 Aktien",
        current: advancedCoverage,
        target: 82,
      }),
      buildTargetEntry({
        key: "scale1000_outcome_completion",
        title: "Outcome Completion für 1000 Aktien",
        current: outcomeCompletion,
        target: 62,
      }),
      buildTargetEntry({
        key: "scale1000_calculation_trust",
        title: "Calculation Trust für 1000 Aktien",
        current: calculationTrust,
        target: 82,
      }),
    ],

    expansionChina: [
      buildTargetEntry({
        key: "china_system_health",
        title: "System Health für China-Ausbau",
        current: systemHealth,
        target: 78,
      }),
      buildTargetEntry({
        key: "china_discovery_health",
        title: "Discovery Health für China-Ausbau",
        current: discoveryHealth,
        target: 70,
      }),
      buildTargetEntry({
        key: "china_discovery_confidence",
        title: "Discovery Confidence für China-Ausbau",
        current: discoveryConfidence,
        target: 68,
      }),
      buildTargetEntry({
        key: "china_regime_confidence",
        title: "Regime Confidence für China-Ausbau",
        current: regimeConfidence,
        target: 65,
      }),
    ],
  };

  function summarizeGroup(group = []) {
    if (!group.length) {
      return {
        averageProgress: 0,
        reachedCount: 0,
        closeCount: 0,
        farCount: 0,
        weakest: null,
      };
    }

    const averageProgress = round2(
      group.reduce((sum, item) => sum + safeNum(item.progress, 0), 0) / group.length
    );

    const reachedCount = group.filter((i) => i.status === "reached").length;
    const closeCount = group.filter((i) => i.status === "close").length;
    const farCount = group.filter((i) => i.status === "far").length;

    const weakest = [...group].sort((a, b) => a.progress - b.progress)[0] || null;

    return {
      averageProgress,
      reachedCount,
      closeCount,
      farCount,
      weakest,
    };
  }

  const summaries = {
    stabilityCore: summarizeGroup(targets.stabilityCore),
    learningCore: summarizeGroup(targets.learningCore),
    calculationCore: summarizeGroup(targets.calculationCore),
    scaling450: summarizeGroup(targets.scaling450),
    scaling600: summarizeGroup(targets.scaling600),
    scaling1000: summarizeGroup(targets.scaling1000),
    expansionChina: summarizeGroup(targets.expansionChina),
  };

  return {
    generatedAt: new Date().toISOString(),
    targets,
    summaries,
  };
}

module.exports = {
  buildAdminTargets,
};
