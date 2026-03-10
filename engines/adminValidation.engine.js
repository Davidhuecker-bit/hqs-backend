"use strict";

// engines/adminValidation.engine.js
// Prüft, ob Berechnungen belastbar sind und ob die Datenbasis ausreicht.

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function trustBand(score) {
  const s = safeNum(score, 0);
  if (s >= 85) return "trusted";
  if (s >= 65) return "usable";
  if (s >= 45) return "thin";
  return "unreliable";
}

function buildAdminValidation(insights = {}, diagnostics = {}) {
  const factorRows = safeNum(insights?.activity?.factorHistory?.recentRows, 0);
  const weightRows = safeNum(insights?.activity?.weightHistory?.recentRows, 0);
  const discoveryRows = safeNum(insights?.activity?.discovery?.recentRows, 0);
  const discoverySymbols = safeNum(insights?.activity?.discovery?.recentUniqueSymbols, 0);
  const outcomeRows = safeNum(insights?.activity?.outcomes?.recentRows, 0);
  const outcomeCompletion = safeNum(insights?.activity?.outcomes?.completionRate, 0);
  const advancedCoverage = safeNum(insights?.coverage?.advancedCoverageVsSnapshots, 0);
  const snapshotCoverage = safeNum(insights?.coverage?.snapshotUniverseCoverage, 0);
  const systemHealth = safeNum(diagnostics?.health?.systemHealthScore, 0);
  const learningHealth = safeNum(diagnostics?.health?.learningHealthScore, 0);

  const hqsConfidence = clamp(
    Math.round(
      Math.min(factorRows * 1.5, 100) * 0.35 +
      advancedCoverage * 0.20 +
      outcomeCompletion * 0.20 +
      snapshotCoverage * 0.15 +
      systemHealth * 0.10
    ),
    0,
    100
  );

  const learningConfidence = clamp(
    Math.round(
      outcomeCompletion * 0.40 +
      Math.min(outcomeRows * 2, 100) * 0.20 +
      Math.min(weightRows * 5, 100) * 0.20 +
      learningHealth * 0.20
    ),
    0,
    100
  );

  const discoveryConfidence = clamp(
    Math.round(
      Math.min(discoveryRows * 2.5, 100) * 0.35 +
      Math.min(discoverySymbols * 4, 100) * 0.35 +
      outcomeCompletion * 0.15 +
      snapshotCoverage * 0.15
    ),
    0,
    100
  );

  const simulationConfidence = clamp(
    Math.round(
      advancedCoverage * 0.45 +
      snapshotCoverage * 0.25 +
      Math.min(factorRows * 1.2, 100) * 0.15 +
      systemHealth * 0.15
    ),
    0,
    100
  );

  const regimeConfidence = clamp(
    Math.round(
      Math.min(weightRows * 6, 100) * 0.30 +
      Math.min(factorRows * 1.2, 100) * 0.30 +
      learningHealth * 0.20 +
      outcomeCompletion * 0.20
    ),
    0,
    100
  );

  const overallCalculationTrust = clamp(
    Math.round(
      hqsConfidence * 0.25 +
      learningConfidence * 0.25 +
      discoveryConfidence * 0.15 +
      simulationConfidence * 0.15 +
      regimeConfidence * 0.20
    ),
    0,
    100
  );

  const weakCalculations = [];
  const missingDataAreas = [];
  const dataUpgradeRecommendations = [];

  if (hqsConfidence < 65) {
    weakCalculations.push({
      key: "hqs",
      severity: "medium",
      title: "HQS-Berechnung noch nicht stark genug belegt",
      detail: "Die HQS-Bewertung läuft, ist aber noch nicht optimal mit Outcomes und weiterverarbeiteten Daten abgesichert.",
    });
  }

  if (learningConfidence < 65) {
    weakCalculations.push({
      key: "learning",
      severity: "high",
      title: "Learning-Vertrauen zu niedrig",
      detail: "Für belastbares Lernen fehlen noch genug abgeschlossene Outcomes und stabile Update-Zyklen.",
    });
  }

  if (discoveryConfidence < 65) {
    weakCalculations.push({
      key: "discovery",
      severity: "medium",
      title: "Discovery noch zu dünn",
      detail: "Discovery ist noch nicht breit oder rückgeprüft genug, um sehr stark zu skalieren.",
    });
  }

  if (simulationConfidence < 60) {
    weakCalculations.push({
      key: "simulation",
      severity: "medium",
      title: "Simulationen noch zu modelllastig",
      detail: "Die Simulation basiert noch zu stark auf Annahmen und zu wenig auf tiefer Datenbasis.",
    });
  }

  if (advancedCoverage < 55) {
    missingDataAreas.push({
      key: "advanced_metrics",
      title: "Advanced Metrics fehlen zu oft",
      detail: "Zu wenige Snapshots werden vollständig in weiterführende Kennzahlen überführt.",
    });

    dataUpgradeRecommendations.push("Advanced-Metrics-Abdeckung erhöhen.");
  }

  if (outcomeCompletion < 40) {
    missingDataAreas.push({
      key: "completed_outcomes",
      title: "Zu wenige abgeschlossene Outcome-Fälle",
      detail: "Das System lernt noch aus zu wenig rückgeprüften Ergebnissen.",
    });

    dataUpgradeRecommendations.push("Mehr abgeschlossene Outcome-Fälle sammeln und auswerten.");
  }

  if (snapshotCoverage < 60) {
    missingDataAreas.push({
      key: "snapshot_coverage",
      title: "Universe-Abdeckung zu niedrig",
      detail: "Zu wenig vom aktiven Universe wird im Verhältnis wirklich verarbeitet.",
    });

    dataUpgradeRecommendations.push("Snapshot-Abdeckung erhöhen, bevor stärker skaliert wird.");
  }

  if (factorRows < 20) {
    dataUpgradeRecommendations.push("Mehr frische Factor-History sammeln, bevor Gewichte stärker angepasst werden.");
  }

  if (discoverySymbols < 15) {
    dataUpgradeRecommendations.push("Discovery auf mehr unterschiedliche Symbole und Setups verbreitern.");
  }

  return {
    generatedAt: new Date().toISOString(),

    trust: {
      overallCalculationTrust,
      overallTrustBand: trustBand(overallCalculationTrust),

      hqsConfidence,
      hqsTrustBand: trustBand(hqsConfidence),

      learningConfidence,
      learningTrustBand: trustBand(learningConfidence),

      discoveryConfidence,
      discoveryTrustBand: trustBand(discoveryConfidence),

      simulationConfidence,
      simulationTrustBand: trustBand(simulationConfidence),

      regimeConfidence,
      regimeTrustBand: trustBand(regimeConfidence),
    },

    weakCalculations,
    missingDataAreas,
    dataUpgradeRecommendations,
  };
}

module.exports = {
  buildAdminValidation,
};
