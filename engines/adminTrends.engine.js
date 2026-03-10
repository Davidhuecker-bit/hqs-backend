"use strict";

// engines/adminTrends.engine.js
// Erkennt Entwicklungen über Zeitfenster hinweg.
// Vergleicht 24h, 7 Tage und 30 Tage, soweit Daten vorhanden sind.

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pctDelta(current, previous) {
  const c = safeNum(current, 0);
  const p = safeNum(previous, 0);

  if (p === 0 && c === 0) return 0;
  if (p === 0) return 100;

  return Number((((c - p) / Math.abs(p)) * 100).toFixed(2));
}

function absoluteDelta(current, previous) {
  return Number((safeNum(current, 0) - safeNum(previous, 0)).toFixed(2));
}

function classifyTrend(delta, goodDirection = "up") {
  const d = safeNum(delta, 0);

  if (goodDirection === "up") {
    if (d >= 15) return "strong_improvement";
    if (d >= 5) return "improving";
    if (d <= -15) return "strong_decline";
    if (d <= -5) return "declining";
    return "stable";
  }

  if (goodDirection === "down") {
    if (d <= -15) return "strong_improvement";
    if (d <= -5) return "improving";
    if (d >= 15) return "strong_decline";
    if (d >= 5) return "declining";
    return "stable";
  }

  return "stable";
}

function buildMetricTrend(current, previous, options = {}) {
  const {
    label = "unknown",
    goodDirection = "up",
  } = options;

  const currentValue = safeNum(current, 0);
  const previousValue = safeNum(previous, 0);
  const deltaAbs = absoluteDelta(currentValue, previousValue);
  const deltaPct = pctDelta(currentValue, previousValue);
  const trend = classifyTrend(deltaPct, goodDirection);

  return {
    label,
    current: currentValue,
    previous: previousValue,
    deltaAbs,
    deltaPct,
    trend,
  };
}

function buildAdminTrends({
  current = {},
  previous24h = {},
  previous7d = {},
  previous30d = {},
} = {}) {
  const metrics24h = {
    systemHealth: buildMetricTrend(
      current?.diagnostics?.health?.systemHealthScore,
      previous24h?.diagnostics?.health?.systemHealthScore,
      { label: "System Health", goodDirection: "up" }
    ),
    learningHealth: buildMetricTrend(
      current?.diagnostics?.health?.learningHealthScore,
      previous24h?.diagnostics?.health?.learningHealthScore,
      { label: "Learning Health", goodDirection: "up" }
    ),
    discoveryHealth: buildMetricTrend(
      current?.diagnostics?.health?.discoveryHealthScore,
      previous24h?.diagnostics?.health?.discoveryHealthScore,
      { label: "Discovery Health", goodDirection: "up" }
    ),
    calculationTrust: buildMetricTrend(
      current?.validation?.trust?.overallCalculationTrust,
      previous24h?.validation?.trust?.overallCalculationTrust,
      { label: "Calculation Trust", goodDirection: "up" }
    ),
    snapshotCoverage: buildMetricTrend(
      current?.insights?.coverage?.snapshotUniverseCoverage,
      previous24h?.insights?.coverage?.snapshotUniverseCoverage,
      { label: "Snapshot Coverage", goodDirection: "up" }
    ),
    advancedCoverage: buildMetricTrend(
      current?.insights?.coverage?.advancedCoverageVsSnapshots,
      previous24h?.insights?.coverage?.advancedCoverageVsSnapshots,
      { label: "Advanced Metrics Coverage", goodDirection: "up" }
    ),
    outcomeCoverage: buildMetricTrend(
      current?.insights?.coverage?.outcomeCoverageVsSnapshots,
      previous24h?.insights?.coverage?.outcomeCoverageVsSnapshots,
      { label: "Outcome Coverage", goodDirection: "up" }
    ),
  };

  const metrics7d = {
    systemHealth: buildMetricTrend(
      current?.diagnostics?.health?.systemHealthScore,
      previous7d?.diagnostics?.health?.systemHealthScore,
      { label: "System Health", goodDirection: "up" }
    ),
    learningHealth: buildMetricTrend(
      current?.diagnostics?.health?.learningHealthScore,
      previous7d?.diagnostics?.health?.learningHealthScore,
      { label: "Learning Health", goodDirection: "up" }
    ),
    calculationTrust: buildMetricTrend(
      current?.validation?.trust?.overallCalculationTrust,
      previous7d?.validation?.trust?.overallCalculationTrust,
      { label: "Calculation Trust", goodDirection: "up" }
    ),
  };

  const metrics30d = {
    systemHealth: buildMetricTrend(
      current?.diagnostics?.health?.systemHealthScore,
      previous30d?.diagnostics?.health?.systemHealthScore,
      { label: "System Health", goodDirection: "up" }
    ),
    learningHealth: buildMetricTrend(
      current?.diagnostics?.health?.learningHealthScore,
      previous30d?.diagnostics?.health?.learningHealthScore,
      { label: "Learning Health", goodDirection: "up" }
    ),
    calculationTrust: buildMetricTrend(
      current?.validation?.trust?.overallCalculationTrust,
      previous30d?.validation?.trust?.overallCalculationTrust,
      { label: "Calculation Trust", goodDirection: "up" }
    ),
  };

  const highlights = [];

  const all24h = Object.values(metrics24h);
  for (const metric of all24h) {
    if (metric.trend === "strong_improvement") {
      highlights.push({
        type: "positive",
        title: `${metric.label} verbessert sich stark`,
        detail: `Veränderung in 24h: ${metric.deltaPct}%`,
      });
    }

    if (metric.trend === "strong_decline") {
      highlights.push({
        type: "negative",
        title: `${metric.label} fällt deutlich ab`,
        detail: `Veränderung in 24h: ${metric.deltaPct}%`,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    last24h: metrics24h,
    last7d: metrics7d,
    last30d: metrics30d,
    highlights,
  };
}

module.exports = {
  buildAdminTrends,
};
