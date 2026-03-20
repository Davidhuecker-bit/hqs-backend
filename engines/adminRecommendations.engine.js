"use strict";

// engines/adminRecommendations.engine.js
// Konkrete Empfehlungen, Next Actions und Maßnahmen für den Admin.
// Die breite Executive Summary liegt bei adminBriefing.engine.js.

function buildAdminRecommendations({
  insights = {},
  diagnostics = {},
  validation = {},
  tuning = {},
} = {}) {
  const topBottleneckTitle = diagnostics?.summary?.topBottleneckTitle || "Kein klarer Engpass erkannt";

  const nextActions = [];
  const tuningTargets = tuning?.topTuningTargets || [];
  for (const item of tuningTargets.slice(0, 3)) {
    nextActions.push(item.title);
  }

  const warnings = (diagnostics?.warnings || []).slice(0, 3).map((w) => ({
    title: w.title,
    detail: w.detail,
  }));

  const opportunities = (diagnostics?.opportunities || []).slice(0, 3).map((o) => ({
    title: o.title,
    detail: o.detail,
  }));

  return {
    generatedAt: new Date().toISOString(),
    topBottleneckTitle,
    nextActions,
    warnings,
    opportunities,
  };
}

module.exports = {
  buildAdminRecommendations,
};
