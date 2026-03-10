"use strict";

// engines/adminAlerts.engine.js
// Baut ein Frühwarnsystem für dein Kontrollzentrum.
// Erkennt kritische Zustände, Beobachtungspunkte und positive Signale.

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function hasValue(v) {
  return v !== null && v !== undefined;
}

function pushAlert(list, alert) {
  if (!alert || !alert.key) return;
  list.push(alert);
}

function sortAlerts(alerts = []) {
  const severityRank = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
    positive: 0,
  };

  return [...alerts].sort((a, b) => {
    const aRank = severityRank[a.severity] || 0;
    const bRank = severityRank[b.severity] || 0;

    if (bRank !== aRank) return bRank - aRank;
    return safeNum(b.score, 0) - safeNum(a.score, 0);
  });
}

function buildAdminAlerts({
  insights = {},
  diagnostics = {},
  validation = {},
  tuning = {},
  trends = {},
} = {}) {
  const alerts = [];

  const systemHealth = safeNum(diagnostics?.health?.systemHealthScore, 0);
  const learningHealth = safeNum(diagnostics?.health?.learningHealthScore, 0);
  const discoveryHealth = safeNum(diagnostics?.health?.discoveryHealthScore, 0);
  const providerHealth = safeNum(diagnostics?.health?.providerHealthScore, 0);

  const snapshotCoverage = safeNum(insights?.coverage?.snapshotUniverseCoverage, 0);
  const advancedCoverage = safeNum(insights?.coverage?.advancedCoverageVsSnapshots, 0);
  const outcomeCoverage = safeNum(insights?.coverage?.outcomeCoverageVsSnapshots, 0);
  const outcomeCompletion = safeNum(insights?.activity?.outcomes?.completionRate, 0);

  const overallTrust = safeNum(validation?.trust?.overallCalculationTrust, 0);
  const hqsConfidence = safeNum(validation?.trust?.hqsConfidence, 0);
  const learningConfidence = safeNum(validation?.trust?.learningConfidence, 0);
  const discoveryConfidence = safeNum(validation?.trust?.discoveryConfidence, 0);
  const simulationConfidence = safeNum(validation?.trust?.simulationConfidence, 0);
  const regimeConfidence = safeNum(validation?.trust?.regimeConfidence, 0);

  const scale450 = Boolean(diagnostics?.scaling?.scale450?.allowed);
  const scale600 = Boolean(diagnostics?.scaling?.scale600?.allowed);
  const scale1000 = Boolean(diagnostics?.scaling?.scale1000?.allowed);

  const topBottleneck = diagnostics?.summary?.topBottleneck || null;
  const nextExpansion = diagnostics?.summary?.nextBestExpansion || null;

  const systemHealthTrend24 = trends?.last24h?.systemHealth?.trend || null;
  const learningTrend24 = trends?.last24h?.learningHealth?.trend || null;
  const trustTrend24 = trends?.last24h?.calculationTrust?.trend || null;
  const snapshotCoverageTrend24 = trends?.last24h?.snapshotCoverage?.trend || null;
  const advancedCoverageTrend24 = trends?.last24h?.advancedCoverage?.trend || null;

  if (systemHealth < 55) {
    pushAlert(alerts, {
      key: "system_health_critical",
      severity: "critical",
      score: 99,
      title: "Systemzustand kritisch",
      detail: "Der Gesamtzustand des Systems ist zu schwach und sollte zuerst stabilisiert werden.",
      action: "Kernengpass priorisieren und keine aggressive Skalierung vornehmen.",
    });
  }

  if (snapshotCoverage < 55) {
    pushAlert(alerts, {
      key: "snapshot_coverage_low",
      severity: "high",
      score: 96,
      title: "Snapshot-Abdeckung zu niedrig",
      detail: "Zu wenig vom aktiven Universe wird aktuell wirklich verarbeitet.",
      action: "Snapshot-Pipeline prüfen, bevor neue Märkte oder deutlich mehr Aktien hinzukommen.",
    });
  }

  if (advancedCoverage < 50) {
    pushAlert(alerts, {
      key: "advanced_metrics_low",
      severity: "high",
      score: 95,
      title: "Advanced Metrics zu schwach",
      detail: "Die Weiterverarbeitung der Snapshots reicht noch nicht für starke Skalierung und tiefes Lernen.",
      action: "Advanced-Metrics-Pipeline priorisieren.",
    });
  }

  if (outcomeCoverage < 45 || outcomeCompletion < 35) {
    pushAlert(alerts, {
      key: "outcome_learning_thin",
      severity: "high",
      score: 93,
      title: "Outcome-Lernen zu dünn",
      detail: "Zu wenige verarbeitete oder abgeschlossene Outcome-Fälle begrenzen die Lernqualität.",
      action: "Outcome-Tracking-Qualität und Abschlussrate erhöhen.",
    });
  }

  if (overallTrust < 50) {
    pushAlert(alerts, {
      key: "calculation_trust_low",
      severity: "high",
      score: 91,
      title: "Berechnungsvertrauen zu niedrig",
      detail: "Mehrere zentrale Berechnungen sind aktuell noch nicht stark genug abgesichert.",
      action: "Datenbasis und Weiterverarbeitung ausbauen, bevor stärker getunt wird.",
    });
  }

  if (hqsConfidence < 60) {
    pushAlert(alerts, {
      key: "hqs_confidence_low",
      severity: "medium",
      score: 79,
      title: "HQS-Aussagekraft noch begrenzt",
      detail: "Die HQS-Berechnung läuft, ist aber noch nicht optimal über Outcomes und Zusatzdaten abgesichert.",
      action: "HQS nicht aggressiv umstellen, bevor die Datenbasis stärker ist.",
    });
  }

  if (learningConfidence < 60) {
    pushAlert(alerts, {
      key: "learning_confidence_low",
      severity: "medium",
      score: 81,
      title: "Learning-Vertrauen noch zu niedrig",
      detail: "Adaptive Gewichte und Lernsignale sind noch nicht stark genug belegt.",
      action: "Mehr abgeschlossene Lernfälle sammeln, bevor Gewichte stärker angepasst werden.",
    });
  }

  if (discoveryConfidence < 60) {
    pushAlert(alerts, {
      key: "discovery_confidence_low",
      severity: "medium",
      score: 76,
      title: "Discovery noch nicht breit genug",
      detail: "Discovery ist aktuell noch nicht stark genug abgesichert, um sehr weit zu skalieren.",
      action: "Discovery-Breite und Rückprüfung erhöhen.",
    });
  }

  if (simulationConfidence < 55) {
    pushAlert(alerts, {
      key: "simulation_confidence_low",
      severity: "medium",
      score: 70,
      title: "Simulationen noch zu modelllastig",
      detail: "Die Szenarien sind aktuell brauchbar, aber noch nicht stark datenabgesichert.",
      action: "Mehr historische und weiterverarbeitete Daten einbeziehen.",
    });
  }

  if (regimeConfidence < 55) {
    pushAlert(alerts, {
      key: "regime_confidence_low",
      severity: "medium",
      score: 69,
      title: "Regime-/Weight-Vertrauen noch dünn",
      detail: "Regime-Anpassung und Gewichte sind noch nicht stark genug mit Lernfällen hinterlegt.",
      action: "Regime-Learning erst nach tieferem Outcome-Fundament aggressiver nutzen.",
    });
  }

  if (providerHealth < 60) {
    pushAlert(alerts, {
      key: "provider_health_warning",
      severity: "medium",
      score: 72,
      title: "Provider-Stabilität beobachten",
      detail: "Die aktuelle Verarbeitungs- und Snapshot-Abdeckung deutet auf mögliche Datenfluss-Schwächen hin.",
      action: "Provider- und Snapshot-Flow beobachten.",
    });
  }

  if (topBottleneck) {
    pushAlert(alerts, {
      key: `top_bottleneck_${topBottleneck}`,
      severity: "medium",
      score: 74,
      title: "Größter aktueller Engpass erkannt",
      detail: `Das Kontrollzentrum sieht aktuell "${topBottleneck}" als Hauptblocker.`,
      action: "Diesen Blocker vor größeren Ausbau-Schritten priorisieren.",
    });
  }

  if (!scale450) {
    pushAlert(alerts, {
      key: "scale450_blocked",
      severity: "medium",
      score: 67,
      title: "450 Aktien noch nicht sauber freigegeben",
      detail: "Das System ist aktuell noch nicht stabil genug für den nächsten kontrollierten Ausbau.",
      action: "Erst Kernengpässe und Datenabdeckung verbessern.",
    });
  }

  if (scale450 && !scale600) {
    pushAlert(alerts, {
      key: "scale450_ready_600_blocked",
      severity: "positive",
      score: 58,
      title: "450 testbar, 600 noch nicht",
      detail: "Das System ist auf dem Weg nach oben, aber der nächste größere Schritt braucht noch mehr Stabilität.",
      action: "Kontrollierten Ausbau vorbereiten, 600 aber noch nicht freigeben.",
    });
  }

  if (scale600 && !scale1000) {
    pushAlert(alerts, {
      key: "scale600_ready_1000_blocked",
      severity: "positive",
      score: 63,
      title: "600 wirkt erreichbar, 1000 noch zu früh",
      detail: "Die mittlere Skalierung ist näher gerückt, aber große Ausweitung sollte noch warten.",
      action: "Mittlere Skalierung testen, Großausbau erst später.",
    });
  }

  if (nextExpansion === "us_broader_universe") {
    pushAlert(alerts, {
      key: "expansion_us_first",
      severity: "positive",
      score: 52,
      title: "US zuerst weiter ausbauen",
      detail: "Der größte Hebel liegt aktuell eher in mehr Breite im US-Universum als im Marktwechsel.",
      action: "US-Skalierung priorisieren, bevor neue Regionen aktiv ausgebaut werden.",
    });
  }

  if (nextExpansion === "china") {
    pushAlert(alerts, {
      key: "expansion_china_readying",
      severity: "positive",
      score: 54,
      title: "China rückt als nächster Ausbau näher",
      detail: "Das System bewertet China aktuell als den sinnvollsten nächsten Erweiterungsschritt.",
      action: "China-Daten- und Prozesspfad als nächsten Ausbau vorbereiten.",
    });
  }

  if (nextExpansion === "europe") {
    pushAlert(alerts, {
      key: "expansion_europe_readying",
      severity: "positive",
      score: 54,
      title: "Europa rückt als nächster Ausbau näher",
      detail: "Das System bewertet Europa aktuell als den sinnvollsten nächsten Erweiterungsschritt.",
      action: "Europa-Daten- und Prozesspfad als nächsten Ausbau vorbereiten.",
    });
  }

  if (
    systemHealthTrend24 === "strong_decline" ||
    learningTrend24 === "strong_decline" ||
    trustTrend24 === "strong_decline" ||
    snapshotCoverageTrend24 === "strong_decline" ||
    advancedCoverageTrend24 === "strong_decline"
  ) {
    pushAlert(alerts, {
      key: "trend_decline_warning",
      severity: "high",
      score: 88,
      title: "Mindestens eine Kernkennzahl kippt deutlich",
      detail: "Ein oder mehrere zentrale Bereiche verschlechtern sich im 24h-Vergleich stark.",
      action: "Nicht weiter skalieren, sondern Trendursache prüfen.",
    });
  }

  if (
    systemHealthTrend24 === "strong_improvement" ||
    learningTrend24 === "strong_improvement" ||
    trustTrend24 === "strong_improvement"
  ) {
    pushAlert(alerts, {
      key: "trend_improvement_positive",
      severity: "positive",
      score: 49,
      title: "Kernkennzahlen verbessern sich deutlich",
      detail: "Wichtige Systembereiche entwickeln sich im letzten Zeitfenster klar positiv.",
      action: "Stabilität bestätigen und kontrollierten Ausbau vorbereiten.",
    });
  }

  const tuningTargets = tuning?.topTuningTargets || [];
  for (const item of tuningTargets.slice(0, 2)) {
    pushAlert(alerts, {
      key: `tuning_${item.key}`,
      severity: item.priority === "high" ? "medium" : "low",
      score: item.priority === "high" ? 66 : 42,
      title: `Tuning-Ziel: ${item.title}`,
      detail: item.detail,
      action: "In die nächste technische Prioritätenliste aufnehmen.",
    });
  }

  const critical = sortAlerts(alerts.filter((a) => a.severity === "critical"));
  const high = sortAlerts(alerts.filter((a) => a.severity === "high"));
  const medium = sortAlerts(alerts.filter((a) => a.severity === "medium"));
  const low = sortAlerts(alerts.filter((a) => a.severity === "low"));
  const positive = sortAlerts(alerts.filter((a) => a.severity === "positive"));

  return {
    generatedAt: new Date().toISOString(),
    critical,
    high,
    medium,
    low,
    positive,
    all: sortAlerts(alerts),
    summary: {
      criticalCount: critical.length,
      highCount: high.length,
      mediumCount: medium.length,
      lowCount: low.length,
      positiveCount: positive.length,
      topAlert: sortAlerts(alerts)[0] || null,
    },
  };
}

module.exports = {
  buildAdminAlerts,
};
