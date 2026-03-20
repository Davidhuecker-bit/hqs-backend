"use strict";

// engines/adminRecommendations.engine.js
// Konkrete Empfehlungen, Next Actions und Maßnahmen für den Admin.
// Die breite Executive Summary liegt bei adminBriefing.engine.js.
//
// Die vier resolveXxxText-Helfer sind als gemeinsame Wahrheitsquelle
// exportiert und werden auch von adminBriefing.engine.js genutzt.

function resolveSystemStatusText(healthBand) {
  if (healthBand === "excellent") return "Das System läuft aktuell sehr stark und stabil.";
  if (healthBand === "good") return "Das System läuft aktuell stabil.";
  if (healthBand === "critical") return "Das System läuft aktuell kritisch und braucht sofort Aufmerksamkeit.";
  return "Das System läuft in einem mittleren Zustand.";
}

function resolveTrustStatusText(trustBand) {
  if (trustBand === "trusted") return "Die wichtigsten Berechnungen wirken aktuell belastbar.";
  if (trustBand === "usable") return "Die wichtigsten Berechnungen sind brauchbar, aber noch nicht maximal abgesichert.";
  if (trustBand === "unreliable") return "Die wichtigsten Berechnungen sind aktuell noch nicht verlässlich genug.";
  return "Die wichtigsten Berechnungen sind aktuell nur teilweise belastbar.";
}

function resolveScalingStatusText(scale600Allowed, scale450Allowed) {
  if (scale600Allowed) return "Das System wirkt bereit für einen Ausbau auf 600 Aktien.";
  if (scale450Allowed) return "Ein Ausbau auf 450 Aktien ist testbar, 600 aber noch nicht.";
  return "Das aktuelle Niveau sollte erst stabilisiert werden, bevor weiter skaliert wird.";
}

function resolveExpansionStatusText(nextBestExpansion) {
  if (nextBestExpansion === "china") return "China wird als nächster sinnvoller Ausbau erkannt.";
  if (nextBestExpansion === "europe") return "Europa wird als nächster sinnvoller Ausbau erkannt.";
  return "US zuerst weiter ausbauen.";
}

function buildAdminRecommendations({
  insights = {},
  diagnostics = {},
  validation = {},
  tuning = {},
} = {}) {
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
    topBottleneckTitle: diagnostics?.summary?.topBottleneckTitle || "Kein klarer Engpass erkannt",
    nextActions,
    warnings,
    opportunities,
  };
}

module.exports = {
  buildAdminRecommendations,
  resolveSystemStatusText,
  resolveTrustStatusText,
  resolveScalingStatusText,
  resolveExpansionStatusText,
};
