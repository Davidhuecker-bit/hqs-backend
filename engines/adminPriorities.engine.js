"use strict";

// engines/adminPriorities.engine.js
// Baut aus Diagnostics, Validation, Tuning und Alerts
// eine klare Prioritätenliste für dein Admin-Kontrollzentrum.

const { classifyMaturityPhase } = require("./maturityClassification");

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pushIf(list, item) {
  if (!item || !item.key) return;
  list.push(item);
}

function sortByPriority(items = []) {
  const rank = {
    immediate: 4,
    next: 3,
    later: 2,
    monitor: 1,
  };

  return [...items].sort((a, b) => {
    const aRank = rank[a.bucket] || 0;
    const bRank = rank[b.bucket] || 0;

    if (bRank !== aRank) return bRank - aRank;
    return safeNum(b.score, 0) - safeNum(a.score, 0);
  });
}

function buildPriorityBuckets(items = []) {
  return {
    immediate: items.filter((i) => i.bucket === "immediate"),
    next: items.filter((i) => i.bucket === "next"),
    later: items.filter((i) => i.bucket === "later"),
    monitor: items.filter((i) => i.bucket === "monitor"),
  };
}

function buildAdminPriorities({
  insights = {},
  diagnostics = {},
  validation = {},
  tuning = {},
  alerts = {},
  maturitySummary = null,
} = {}) {
  const priorities = [];

  const systemHealth = safeNum(diagnostics?.health?.systemHealthScore, 0);
  const learningHealth = safeNum(diagnostics?.health?.learningHealthScore, 0);

  const snapshotCoverage = safeNum(insights?.coverage?.snapshotUniverseCoverage, 0);
  const advancedCoverage = safeNum(insights?.coverage?.advancedCoverageVsSnapshots, 0);
  const outcomeCoverage = safeNum(insights?.coverage?.outcomeCoverageVsSnapshots, 0);
  const outcomeCompletion = safeNum(insights?.activity?.outcomes?.completionRate, 0);

  const calculationTrust = safeNum(validation?.trust?.overallCalculationTrust, 0);
  const hqsConfidence = safeNum(validation?.trust?.hqsConfidence, 0);
  const learningConfidence = safeNum(validation?.trust?.learningConfidence, 0);
  const discoveryConfidence = safeNum(validation?.trust?.discoveryConfidence, 0);

  const scale450 = Boolean(diagnostics?.scaling?.scale450?.allowed);
  const scale600 = Boolean(diagnostics?.scaling?.scale600?.allowed);

  const topBottleneck = diagnostics?.summary?.topBottleneck || null;
  const nextBestExpansion = diagnostics?.summary?.nextBestExpansion || "us_broader_universe";

  if (systemHealth < 55) {
    pushIf(priorities, {
      key: "stabilize_system_core",
      bucket: "immediate",
      score: 100,
      title: "Kernsystem stabilisieren",
      detail: "Der Gesamtzustand ist kritisch. Vor jeder Erweiterung muss das Grundsystem stabilisiert werden.",
      reason: "System Health zu niedrig",
    });
  }

  if (snapshotCoverage < 55) {
    pushIf(priorities, {
      key: "raise_snapshot_coverage",
      bucket: "immediate",
      score: 98,
      title: "Snapshot-Abdeckung erhöhen",
      detail: "Zu wenig vom aktiven Universe wird aktuell verarbeitet. Das blockiert Lernen, Skalierung und Ausbau.",
      reason: "Universe-Abdeckung zu niedrig",
    });
  }

  if (advancedCoverage < 50) {
    const mc = classifyMaturityPhase(maturitySummary);

    if (mc.phase === "hard_problems") {
      // Genuine data problem – immediate priority
      pushIf(priorities, {
        key: "improve_advanced_metrics_pipeline",
        bucket: "immediate",
        score: 97,
        title: "Datenpipeline: echte Probleme beheben",
        detail: `${mc.hardProblems} von ${mc.total} Symbolen haben harte Datenlücken. Die Pipeline muss vor Skalierung repariert werden.`,
        reason: "Harte Datenprobleme dominieren",
      });
    } else if (mc.phase === "early_phase") {
      // Natural early phase – no immediate action needed
      pushIf(priorities, {
        key: "improve_advanced_metrics_pipeline",
        bucket: "next",
        score: 68,
        title: "Datenbasis weiter reifen lassen",
        detail: `Viele Werte sind noch im Aufbau (${mc.earlyPhaseCount} von ${mc.total} in früher Phase). US-Abdeckung und historische Tiefe wachsen noch.`,
        reason: "Natürliche Frühphase – Datenbasis wächst",
      });
    } else if (mc.phase === "developing") {
      // Mix – developing symbols present, growing confidence
      pushIf(priorities, {
        key: "improve_advanced_metrics_pipeline",
        bucket: "next",
        score: 72,
        title: "Datenbasis weiter ausbauen",
        detail: `Mehrere Werte sind bereits belastbarer. Datenbasis wächst noch – weiter beobachten und US-Abdeckung ausbauen.`,
        reason: "Aufbauphase – Datenlage verbessert sich",
      });
    } else {
      // Fallback: no maturitySummary available
      pushIf(priorities, {
        key: "improve_advanced_metrics_pipeline",
        bucket: "immediate",
        score: 97,
        title: "Advanced-Metrics-Pipeline priorisieren",
        detail: "Die Weiterverarbeitung nach dem Snapshot ist aktuell ein Haupthebel für bessere Aussagekraft und Skalierung.",
        reason: "Advanced Metrics Coverage zu niedrig",
      });
    }
  }

  if (outcomeCoverage < 45 || outcomeCompletion < 35) {
    pushIf(priorities, {
      key: "deepen_outcome_tracking",
      bucket: "immediate",
      score: 95,
      title: "Outcome-Tracking vertiefen",
      detail: "Zu wenige rückgeprüfte Fälle begrenzen die Lernqualität und adaptive Gewichte.",
      reason: "Zu wenig belastbare Lernfälle",
    });
  }

  if (calculationTrust < 50) {
    pushIf(priorities, {
      key: "strengthen_calculation_trust",
      bucket: "immediate",
      score: 93,
      title: "Berechnungsvertrauen erhöhen",
      detail: "Mehrere zentrale Berechnungen sind noch nicht stark genug belegt. Vor aggressivem Tuning sollte die Datenbasis verbessert werden.",
      reason: "Overall Calculation Trust zu niedrig",
    });
  }

  if (learningConfidence < 60) {
    pushIf(priorities, {
      key: "protect_weight_adjustments",
      bucket: "next",
      score: 84,
      title: "Gewichte vorerst vorsichtig anpassen",
      detail: "Adaptive Gewichte sollten noch nicht aggressiv verändert werden, solange Learning zu dünn ist.",
      reason: "Learning Confidence noch zu niedrig",
    });
  }

  if (hqsConfidence < 60) {
    pushIf(priorities, {
      key: "stabilize_hqs_quality",
      bucket: "next",
      score: 82,
      title: "HQS-Aussagekraft absichern",
      detail: "HQS läuft, sollte aber erst mit stärkerer Outcome- und Zusatzdatenbasis härter getunt werden.",
      reason: "HQS Confidence begrenzt",
    });
  }

  if (discoveryConfidence < 60) {
    pushIf(priorities, {
      key: "broaden_discovery",
      bucket: "next",
      score: 80,
      title: "Discovery verbreitern",
      detail: "Discovery sollte über mehr Symbole und vielfältigere Setups laufen, bevor größere Skalierung sinnvoll ist.",
      reason: "Discovery zu eng",
    });
  }

  if (!scale450) {
    pushIf(priorities, {
      key: "delay_scaling_450",
      bucket: "next",
      score: 79,
      title: "Skalierung auf 450 noch zurückstellen",
      detail: "Erst Kernengpässe lösen, dann kontrollierten Ausbau freigeben.",
      reason: "Scale Readiness 450 noch nicht ausreichend",
    });
  }

  if (scale450 && !scale600) {
    pushIf(priorities, {
      key: "prepare_controlled_scale_test",
      bucket: "next",
      score: 74,
      title: "Kontrollierten Ausbau auf 450 vorbereiten",
      detail: "Das System wirkt stabil genug für einen ersten sauberen Ausbau, aber 600 wären noch zu früh.",
      reason: "450 testbar, 600 noch blockiert",
    });
  }

  if (scale600) {
    pushIf(priorities, {
      key: "plan_mid_scale_expansion",
      bucket: "later",
      score: 66,
      title: "Mittlere Skalierung planen",
      detail: "Das System nähert sich einer stärkeren Vergrößerung. Diese sollte aber weiter kontrolliert erfolgen.",
      reason: "Scale 600 wirkt erreichbar",
    });
  }

  if (topBottleneck === "advanced_metrics") {
    const mc = classifyMaturityPhase(maturitySummary);

    if (mc.phase === "hard_problems") {
      pushIf(priorities, {
        key: "fix_top_bottleneck_advanced",
        bucket: "immediate",
        score: 94,
        title: "Top-Engpass: echte Datenprobleme in Advanced Metrics",
        detail: `Die Advanced-Metrics-Schicht hat harte Datenlücken (${mc.hardProblems} von ${mc.total} Symbolen). Pipeline-Fehler prüfen.`,
        reason: "Top Bottleneck erkannt – echte Probleme",
      });
    } else if (mc.phase !== "unknown") {
      pushIf(priorities, {
        key: "fix_top_bottleneck_advanced",
        bucket: "next",
        score: 74,
        title: "Top-Engpass: Advanced Metrics – Datenbasis reift",
        detail: "Advanced Metrics ist aktuell limitierender Faktor, aber primär durch natürliche Frühphase – nicht durch echte Fehler.",
        reason: "Top Bottleneck erkannt – Aufbauphase",
      });
    } else {
      pushIf(priorities, {
        key: "fix_top_bottleneck_advanced",
        bucket: "immediate",
        score: 94,
        title: "Top-Engpass: Advanced Metrics beheben",
        detail: "Das Kontrollzentrum erkennt die Advanced-Metrics-Schicht aktuell als Hauptblocker.",
        reason: "Top Bottleneck erkannt",
      });
    }
  }

  if (topBottleneck === "snapshot_coverage") {
    pushIf(priorities, {
      key: "fix_top_bottleneck_snapshots",
      bucket: "immediate",
      score: 94,
      title: "Top-Engpass: Snapshot-Abdeckung beheben",
      detail: "Das System verarbeitet zu wenig Breite aus dem aktiven Universe.",
      reason: "Top Bottleneck erkannt",
    });
  }

  if (topBottleneck === "outcome_tracking") {
    pushIf(priorities, {
      key: "fix_top_bottleneck_outcomes",
      bucket: "immediate",
      score: 94,
      title: "Top-Engpass: Outcome-Tracking beheben",
      detail: "Das Lernen ist zu stark durch unzureichend abgeschlossene Outcome-Fälle begrenzt.",
      reason: "Top Bottleneck erkannt",
    });
  }

  if (nextBestExpansion === "us_broader_universe") {
    pushIf(priorities, {
      key: "expand_us_before_new_market",
      bucket: "later",
      score: 60,
      title: "US zuerst weiter verbreitern",
      detail: "Der größte Hebel liegt aktuell eher im breiteren US-Universum als im direkten Marktwechsel.",
      reason: "US-Ausbau bringt aktuell mehr Nutzen",
    });
  }

  if (nextBestExpansion === "china") {
    pushIf(priorities, {
      key: "prepare_china_expansion",
      bucket: "later",
      score: 58,
      title: "China-Ausbau vorbereiten",
      detail: "China wird vom System als nächster sinnvoller Ausbau gesehen, aber nicht vor den Kernengpässen.",
      reason: "China Readiness steigt",
    });
  }

  if (nextBestExpansion === "europe") {
    pushIf(priorities, {
      key: "prepare_europe_expansion",
      bucket: "later",
      score: 58,
      title: "Europa-Ausbau vorbereiten",
      detail: "Europa wird vom System als nächster sinnvoller Ausbau gesehen, aber nicht vor den Kernengpässen.",
      reason: "Europe Readiness steigt",
    });
  }

  if (learningHealth >= 75 && calculationTrust >= 70) {
    pushIf(priorities, {
      key: "monitor_for_next_release",
      bucket: "monitor",
      score: 44,
      title: "System auf nächste Freigabestufe beobachten",
      detail: "Mehrere Kernwerte sind bereits gut. Jetzt Entwicklung beobachten und stabile Bestätigung abwarten.",
      reason: "Gute Grundstabilität vorhanden",
    });
  }

  const topTuningTargets = Array.isArray(tuning?.topTuningTargets)
    ? tuning.topTuningTargets
    : [];

  for (const item of topTuningTargets.slice(0, 3)) {
    pushIf(priorities, {
      key: `tuning_${item.key}`,
      bucket: item.priority === "high" ? "next" : "later",
      score: item.priority === "high" ? 72 : 50,
      title: item.title,
      detail: item.detail,
      reason: "Tuning-Engine Empfehlung",
    });
  }

  const alertSummary = alerts?.summary || {};
  if (safeNum(alertSummary.criticalCount, 0) > 0) {
    pushIf(priorities, {
      key: "resolve_critical_alerts",
      bucket: "immediate",
      score: 99,
      title: "Kritische Warnungen zuerst abarbeiten",
      detail: "Es gibt mindestens eine kritische Warnung im Kontrollzentrum.",
      reason: "Critical Alerts vorhanden",
    });
  }

  const sorted = sortByPriority(priorities);
  const buckets = buildPriorityBuckets(sorted);

  return {
    generatedAt: new Date().toISOString(),
    all: sorted,
    immediate: buckets.immediate,
    next: buckets.next,
    later: buckets.later,
    monitor: buckets.monitor,
    summary: {
      topPriority: sorted[0] || null,
      immediateCount: buckets.immediate.length,
      nextCount: buckets.next.length,
      laterCount: buckets.later.length,
      monitorCount: buckets.monitor.length,
    },
  };
}

module.exports = {
  buildAdminPriorities,
};
