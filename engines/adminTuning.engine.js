"use strict";

// engines/adminTuning.engine.js
// Erkennt, an welchen Berechnungen, Gewichten und Modulen
// als Nächstes geschraubt werden sollte.

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function buildAdminTuning(insights = {}, diagnostics = {}, validation = {}) {
  const topTuningTargets = [];
  const weightAdjustmentIdeas = [];
  const scoreWeaknesses = [];
  const engineWeaknesses = [];
  const priorityFixes = [];

  const advancedCoverage = safeNum(insights?.coverage?.advancedCoverageVsSnapshots, 0);
  const outcomeCompletion = safeNum(insights?.activity?.outcomes?.completionRate, 0);
  const discoveryConfidence = safeNum(validation?.trust?.discoveryConfidence, 0);
  const learningConfidence = safeNum(validation?.trust?.learningConfidence, 0);
  const hqsConfidence = safeNum(validation?.trust?.hqsConfidence, 0);
  const systemHealth = safeNum(diagnostics?.health?.systemHealthScore, 0);
  const topBottleneck = diagnostics?.summary?.topBottleneck || null;

  if (advancedCoverage < 55) {
    topTuningTargets.push({
      key: "advanced_metrics_pipeline",
      priority: "high",
      title: "Advanced Metrics Pipeline verbessern",
      detail: "Die Weiterverarbeitung nach dem Snapshot ist der größte Hebel für bessere Diagnose, Learning-Qualität und Skalierung.",
    });
    priorityFixes.push("Advanced-Metrics-Abdeckung priorisieren.");
  }

  if (outcomeCompletion < 40) {
    topTuningTargets.push({
      key: "outcome_tracking_depth",
      priority: "high",
      title: "Outcome-Tracking vertiefen",
      detail: "Ohne genug abgeschlossene Outcomes bleiben Learning und adaptive Gewichte zu schwach belegt.",
    });
    priorityFixes.push("Mehr und sauberere Outcome-Abschlüsse sammeln.");
  }

  if (discoveryConfidence < 65) {
    scoreWeaknesses.push({
      key: "discovery_breadth",
      title: "Discovery ist noch zu eng",
      detail: "Die Discovery-Schicht sollte breiter über verschiedene Symbole und Setup-Typen laufen.",
    });
    priorityFixes.push("Discovery-Breite erhöhen.");
  }

  if (learningConfidence < 65) {
    weightAdjustmentIdeas.push({
      key: "weights_not_yet_strongly_learned",
      title: "Gewichte noch zurückhaltend anpassen",
      detail: "Die Gewichte sollten noch nicht aggressiv verändert werden, solange das Outcome-Lernen zu dünn ist.",
    });
  }

  if (hqsConfidence < 65) {
    scoreWeaknesses.push({
      key: "hqs_reliability",
      title: "HQS noch besser absichern",
      detail: "Die HQS-Bewertung braucht mehr Datenbreite und Outcome-Rückkopplung, bevor stärkere Tuning-Schritte sinnvoll sind.",
    });
  }

  if (topBottleneck === "snapshot_coverage") {
    engineWeaknesses.push({
      key: "snapshot_pipeline",
      title: "Snapshot-Pipeline ist der Hauptengpass",
      detail: "Bevor neue Märkte oder 1000 Aktien sinnvoll werden, muss mehr vom aktiven Universe sauber verarbeitet werden.",
    });
  }

  if (topBottleneck === "advanced_metrics") {
    engineWeaknesses.push({
      key: "advanced_metrics_engine",
      title: "Advanced-Metrics-Schicht ist zu schwach",
      detail: "Hier liegt aktuell der wichtigste technische Hebel für bessere Aussagekraft.",
    });
  }

  if (systemHealth >= 75 && advancedCoverage >= 55 && outcomeCompletion >= 40) {
    topTuningTargets.push({
      key: "controlled_scale_test",
      priority: "medium",
      title: "Kontrollierten Skalierungstest vorbereiten",
      detail: "Das System ist stabil genug, um den nächsten Ausbau in kleinen Schritten zu testen.",
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    topTuningTargets,
    weightAdjustmentIdeas,
    scoreWeaknesses,
    engineWeaknesses,
    priorityFixes,
  };
}

module.exports = {
  buildAdminTuning,
};
