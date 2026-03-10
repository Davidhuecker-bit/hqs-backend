"use strict";

// engines/adminRecommendations.engine.js
// Macht aus Insights, Diagnostics, Validation und Tuning
// verständliche Admin-Empfehlungen.

function buildAdminRecommendations({
  insights = {},
  diagnostics = {},
  validation = {},
  tuning = {},
} = {}) {
  const healthBand = diagnostics?.health?.systemHealthBand || "warning";
  const topBottleneckTitle = diagnostics?.summary?.topBottleneckTitle || "Kein klarer Engpass erkannt";
  const scale450Allowed = Boolean(diagnostics?.summary?.scale450Allowed);
  const scale600Allowed = Boolean(diagnostics?.summary?.scale600Allowed);
  const nextBestExpansion = diagnostics?.summary?.nextBestExpansion || "us_broader_universe";
  const trustBand = validation?.trust?.overallTrustBand || "thin";

  let systemSummary = "Das System läuft in einem mittleren Zustand.";
  if (healthBand === "excellent") systemSummary = "Das System läuft aktuell sehr stark und stabil.";
  else if (healthBand === "good") systemSummary = "Das System läuft aktuell stabil.";
  else if (healthBand === "critical") systemSummary = "Das System läuft aktuell kritisch und braucht Aufmerksamkeit.";

  let trustSummary = "Die Berechnungen sind aktuell nur teilweise belastbar.";
  if (trustBand === "trusted") trustSummary = "Die wichtigsten Berechnungen wirken aktuell belastbar.";
  else if (trustBand === "usable") trustSummary = "Die Berechnungen sind brauchbar, aber noch nicht maximal abgesichert.";
  else if (trustBand === "unreliable") trustSummary = "Die Berechnungen sind aktuell noch nicht verlässlich genug.";

  let scalingSummary = "Noch keine saubere Skalierungsfreigabe.";
  if (scale600Allowed) scalingSummary = "Das System wirkt bereit für einen Ausbau auf 600 Aktien.";
  else if (scale450Allowed) scalingSummary = "Ein Ausbau auf 450 Aktien ist testbar, 600 aber noch nicht.";
  else scalingSummary = "Das aktuelle Niveau sollte erst stabilisiert werden, bevor weiter skaliert wird.";

  let expansionSummary = "US zuerst weiter ausbauen.";
  if (nextBestExpansion === "china") expansionSummary = "China wird als nächster sinnvoller Ausbau erkannt.";
  else if (nextBestExpansion === "europe") expansionSummary = "Europa wird als nächster sinnvoller Ausbau erkannt.";

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

    executiveSummary: {
      systemSummary,
      trustSummary,
      scalingSummary,
      expansionSummary,
      topBottleneckTitle,
    },

    adminText: [
      systemSummary,
      `Der größte aktuelle Engpass ist: ${topBottleneckTitle}.`,
      trustSummary,
      scalingSummary,
      expansionSummary,
    ].join(" "),

    nextActions,
    warnings,
    opportunities,
  };
}

module.exports = {
  buildAdminRecommendations,
};
