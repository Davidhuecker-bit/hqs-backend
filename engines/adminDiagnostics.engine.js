"use strict";

// engines/adminDiagnostics.engine.js
// Baut aus den Rohdaten von adminInsights.service.js
// eine klare Systemdiagnose für dein Admin-Kontrollzentrum.

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hasRecentTimestamp(isoString, maxHours = 24) {
  if (!isoString) return false;
  const ts = new Date(isoString).getTime();
  if (!Number.isFinite(ts)) return false;
  const diffHours = (Date.now() - ts) / (1000 * 60 * 60);
  return diffHours <= maxHours;
}

function scoreBand(score) {
  const s = safeNum(score, 0);
  if (s >= 90) return "excellent";
  if (s >= 75) return "good";
  if (s >= 55) return "warning";
  return "critical";
}

function classifyReadiness(score) {
  const s = safeNum(score, 0);
  if (s >= 85) return "ready";
  if (s >= 65) return "almost_ready";
  if (s >= 45) return "needs_work";
  return "not_ready";
}

function buildHealthScores(insights) {
  const snapshotUniverseCoverage = safeNum(insights?.coverage?.snapshotUniverseCoverage, 0);
  const advancedCoverageVsSnapshots = safeNum(insights?.coverage?.advancedCoverageVsSnapshots, 0);
  const outcomeCoverageVsSnapshots = safeNum(insights?.coverage?.outcomeCoverageVsSnapshots, 0);

  const latestSnapshotAt = insights?.quickFacts?.latestSnapshotAt || null;
  const latestFactorUpdateAt = insights?.quickFacts?.latestFactorUpdateAt || null;
  const latestDiscoveryAt = insights?.quickFacts?.latestDiscoveryAt || null;

  const recentSnapshotBonus = hasRecentTimestamp(latestSnapshotAt, 24) ? 100 : 35;
  const recentFactorBonus = hasRecentTimestamp(latestFactorUpdateAt, 24) ? 100 : 40;
  const recentDiscoveryBonus = hasRecentTimestamp(latestDiscoveryAt, 48) ? 100 : 45;

  const systemHealthScore = clamp(
    Math.round(
      snapshotUniverseCoverage * 0.30 +
      advancedCoverageVsSnapshots * 0.20 +
      outcomeCoverageVsSnapshots * 0.20 +
      recentSnapshotBonus * 0.15 +
      recentFactorBonus * 0.10 +
      recentDiscoveryBonus * 0.05
    ),
    0,
    100
  );

  const learningHealthScore = clamp(
    Math.round(
      safeNum(insights?.activity?.outcomes?.completionRate, 0) * 0.45 +
      Math.min(safeNum(insights?.activity?.weightHistory?.recentRows, 0) * 4, 100) * 0.20 +
      Math.min(safeNum(insights?.activity?.factorHistory?.recentRows, 0) * 1.2, 100) * 0.20 +
      (hasRecentTimestamp(latestFactorUpdateAt, 24) ? 100 : 35) * 0.15
    ),
    0,
    100
  );

  const discoveryHealthScore = clamp(
    Math.round(
      Math.min(safeNum(insights?.activity?.discovery?.recentRows, 0) * 2.5, 100) * 0.45 +
      Math.min(safeNum(insights?.activity?.discovery?.recentUniqueSymbols, 0) * 4, 100) * 0.35 +
      (hasRecentTimestamp(latestDiscoveryAt, 48) ? 100 : 40) * 0.20
    ),
    0,
    100
  );

  const providerHealthScore = clamp(
    Math.round(
      safeNum(insights?.coverage?.snapshotUniverseCoverage, 0) * 0.55 +
      (hasRecentTimestamp(latestSnapshotAt, 24) ? 100 : 30) * 0.45
    ),
    0,
    100
  );

  return {
    systemHealthScore,
    systemHealthBand: scoreBand(systemHealthScore),

    learningHealthScore,
    learningHealthBand: scoreBand(learningHealthScore),

    discoveryHealthScore,
    discoveryHealthBand: scoreBand(discoveryHealthScore),

    providerHealthScore,
    providerHealthBand: scoreBand(providerHealthScore),
  };
}

function detectBottlenecks(insights) {
  const issues = [];

  const snapshotUniverseCoverage = safeNum(insights?.coverage?.snapshotUniverseCoverage, 0);
  const advancedCoverageVsSnapshots = safeNum(insights?.coverage?.advancedCoverageVsSnapshots, 0);
  const outcomeCoverageVsSnapshots = safeNum(insights?.coverage?.outcomeCoverageVsSnapshots, 0);
  const hqsCoverageVsSnapshots = safeNum(insights?.coverage?.hqsCoverageVsSnapshots, 0);

  if (snapshotUniverseCoverage < 55) {
    issues.push({
      key: "snapshot_coverage",
      severity: "high",
      score: 95,
      title: "Zu wenig Universe-Abdeckung",
      detail: "Zu wenige aktive Symbole werden im Verhältnis zum Universe verarbeitet.",
    });
  }

  if (advancedCoverageVsSnapshots < 50) {
    issues.push({
      key: "advanced_metrics",
      severity: "high",
      score: 92,
      title: "Advanced Metrics zu schwach",
      detail: "Zu wenige Snapshot-Daten werden in Advanced Metrics weiterverarbeitet.",
    });
  }

  if (outcomeCoverageVsSnapshots < 45) {
    issues.push({
      key: "outcome_tracking",
      severity: "high",
      score: 90,
      title: "Outcome-Tracking zu dünn",
      detail: "Zu wenige verarbeitete Werte landen im Outcome-Tracking.",
    });
  }

  if (hqsCoverageVsSnapshots < 40) {
    issues.push({
      key: "hqs_persistence",
      severity: "medium",
      score: 72,
      title: "HQS-Persistenz schwach",
      detail: "Es werden deutlich mehr Snapshots als HQS-Einträge geschrieben.",
    });
  }

  if (!hasRecentTimestamp(insights?.quickFacts?.latestSnapshotAt, 24)) {
    issues.push({
      key: "snapshot_stale",
      severity: "high",
      score: 96,
      title: "Snapshot-Lauf nicht aktuell",
      detail: "Es wurde seit längerer Zeit kein frischer Snapshot erkannt.",
    });
  }

  if (!hasRecentTimestamp(insights?.quickFacts?.latestFactorUpdateAt, 24)) {
    issues.push({
      key: "learning_stale",
      severity: "medium",
      score: 78,
      title: "Learning-Daten nicht aktuell",
      detail: "Factor- oder Learning-Historie wurde zuletzt nicht frisch aktualisiert.",
    });
  }

  if (!hasRecentTimestamp(insights?.quickFacts?.latestDiscoveryAt, 48)) {
    issues.push({
      key: "discovery_stale",
      severity: "medium",
      score: 68,
      title: "Discovery stagniert",
      detail: "Discovery-Historie wirkt in den letzten 48 Stunden zu inaktiv.",
    });
  }

  issues.sort((a, b) => b.score - a.score);

  return {
    all: issues,
    top: issues[0] || null,
  };
}

function buildScalingReadiness(insights, healthScores) {
  const activeUniverse = safeNum(insights?.universe?.active, 0);
  const snapshotCoverage = safeNum(insights?.coverage?.snapshotUniverseCoverage, 0);
  const advancedCoverage = safeNum(insights?.coverage?.advancedCoverageVsSnapshots, 0);
  const outcomeCoverage = safeNum(insights?.coverage?.outcomeCoverageVsSnapshots, 0);
  const systemHealth = safeNum(healthScores?.systemHealthScore, 0);
  const learningHealth = safeNum(healthScores?.learningHealthScore, 0);

  const baseScore = clamp(
    Math.round(
      snapshotCoverage * 0.30 +
      advancedCoverage * 0.20 +
      outcomeCoverage * 0.20 +
      systemHealth * 0.20 +
      learningHealth * 0.10
    ),
    0,
    100
  );

  const capacityBias =
    activeUniverse >= 900 ? 10 :
    activeUniverse >= 600 ? 6 :
    activeUniverse >= 300 ? 3 :
    0;

  const readiness450Score = clamp(baseScore + 8 + capacityBias, 0, 100);
  const readiness600Score = clamp(baseScore - 4 + capacityBias, 0, 100);
  const readiness1000Score = clamp(baseScore - 18 + capacityBias, 0, 100);

  return {
    currentActiveUniverse: activeUniverse,

    scale450: {
      score: readiness450Score,
      status: classifyReadiness(readiness450Score),
      allowed: readiness450Score >= 65,
    },

    scale600: {
      score: readiness600Score,
      status: classifyReadiness(readiness600Score),
      allowed: readiness600Score >= 70,
    },

    scale1000: {
      score: readiness1000Score,
      status: classifyReadiness(readiness1000Score),
      allowed: readiness1000Score >= 80,
    },
  };
}

function buildExpansionReadiness(insights, healthScores) {
  const activeUniverse = safeNum(insights?.universe?.active, 0);
  const systemHealth = safeNum(healthScores?.systemHealthScore, 0);
  const learningHealth = safeNum(healthScores?.learningHealthScore, 0);
  const advancedCoverage = safeNum(insights?.coverage?.advancedCoverageVsSnapshots, 0);
  const outcomeCoverage = safeNum(insights?.coverage?.outcomeCoverageVsSnapshots, 0);

  const usReadiness = clamp(
    Math.round(systemHealth * 0.40 + learningHealth * 0.20 + advancedCoverage * 0.20 + outcomeCoverage * 0.20),
    0,
    100
  );

  const chinaReadiness = clamp(
    Math.round(systemHealth * 0.30 + learningHealth * 0.20 + advancedCoverage * 0.20 + outcomeCoverage * 0.10 + (activeUniverse >= 300 ? 20 : 5)),
    0,
    100
  );

  const europeReadiness = clamp(
    Math.round(systemHealth * 0.30 + learningHealth * 0.20 + advancedCoverage * 0.20 + outcomeCoverage * 0.10 + (activeUniverse >= 300 ? 18 : 5)),
    0,
    100
  );

  let nextBestExpansion = "us_broader_universe";
  if (chinaReadiness >= 75 && chinaReadiness >= europeReadiness) {
    nextBestExpansion = "china";
  } else if (europeReadiness >= 75 && europeReadiness > chinaReadiness) {
    nextBestExpansion = "europe";
  }

  return {
    us: {
      score: usReadiness,
      status: classifyReadiness(usReadiness),
    },
    china: {
      score: chinaReadiness,
      status: classifyReadiness(chinaReadiness),
    },
    europe: {
      score: europeReadiness,
      status: classifyReadiness(europeReadiness),
    },
    nextBestExpansion,
  };
}

function buildWarningsAndOpportunities(insights, healthScores, bottlenecks, scaling, expansion) {
  const warnings = [];
  const opportunities = [];

  if (bottlenecks?.top) {
    warnings.push({
      type: "bottleneck",
      level: bottlenecks.top.severity,
      title: bottlenecks.top.title,
      detail: bottlenecks.top.detail,
    });
  }

  if (safeNum(insights?.coverage?.advancedCoverageVsSnapshots, 0) < 55) {
    warnings.push({
      type: "coverage",
      level: "high",
      title: "Advanced-Metrics-Abdeckung zu niedrig",
      detail: "Die Weiterverarbeitung nach dem Snapshot reicht noch nicht für eine saubere Skalierung.",
    });
  }

  if (safeNum(insights?.activity?.outcomes?.completionRate, 0) < 35) {
    warnings.push({
      type: "learning",
      level: "medium",
      title: "Zu wenig abgeschlossene Outcomes",
      detail: "Das System lernt noch nicht aus genug abgeschlossenen Fällen.",
    });
  }

  if (scaling?.scale450?.allowed) {
    opportunities.push({
      type: "scaling",
      title: "450 Aktien testbar",
      detail: "Das System wirkt stabil genug für einen ersten Ausbau über den aktuellen Stand.",
    });
  }

  if (safeNum(healthScores?.discoveryHealthScore, 0) >= 70) {
    opportunities.push({
      type: "discovery",
      title: "Discovery arbeitet brauchbar",
      detail: "Die Discovery-Aktivität ist hoch genug, um weitere Breite auszuwerten.",
    });
  }

  if (expansion?.nextBestExpansion === "us_broader_universe") {
    opportunities.push({
      type: "expansion",
      title: "US-Universum zuerst verbreitern",
      detail: "Der größte Hebel liegt aktuell eher im breiteren US-Scan als im Marktwechsel.",
    });
  }

  return {
    warnings,
    opportunities,
  };
}

function buildAdminDiagnostics(insights = {}) {
  const health = buildHealthScores(insights);
  const bottlenecks = detectBottlenecks(insights);
  const scaling = buildScalingReadiness(insights, health);
  const expansion = buildExpansionReadiness(insights, health);
  const signals = buildWarningsAndOpportunities(
    insights,
    health,
    bottlenecks,
    scaling,
    expansion
  );

  return {
    generatedAt: new Date().toISOString(),

    health,
    bottlenecks,
    scaling,
    expansion,

    warnings: signals.warnings,
    opportunities: signals.opportunities,

    summary: {
      systemHealthScore: health.systemHealthScore,
      systemHealthBand: health.systemHealthBand,
      topBottleneck: bottlenecks.top?.key || null,
      topBottleneckTitle: bottlenecks.top?.title || null,
      scale450Allowed: scaling.scale450.allowed,
      scale600Allowed: scaling.scale600.allowed,
      scale1000Allowed: scaling.scale1000.allowed,
      nextBestExpansion: expansion.nextBestExpansion,
    },
  };
}

module.exports = {
  buildAdminDiagnostics,
};
