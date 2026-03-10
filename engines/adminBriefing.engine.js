"use strict";

// engines/adminBriefing.engine.js
// Baut eine verständliche Chef-Zusammenfassung für dein Kontrollzentrum.

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pickTop(list = []) {
  return Array.isArray(list) && list.length ? list[0] : null;
}

function buildAdminBriefing({
  insights = {},
  diagnostics = {},
  validation = {},
  tuning = {},
  trends = {},
  alerts = {},
  priorities = {},
  targets = {},
  causality = {},
  release = {},
} = {}) {
  const systemHealth = safeNum(diagnostics?.health?.systemHealthScore, 0);
  const systemBand = diagnostics?.health?.systemHealthBand || "warning";
  const calcTrust = safeNum(validation?.trust?.overallCalculationTrust, 0);
  const trustBand = validation?.trust?.overallTrustBand || "thin";

  const topBottleneck = diagnostics?.summary?.topBottleneckTitle || "Kein klarer Engpass erkannt";
  const topPriority = priorities?.summary?.topPriority || null;
  const topAlert = alerts?.summary?.topAlert || null;
  const topChain = causality?.summary?.topChain || null;

  const scale450 = release?.scale?.scale450 || null;
  const scale600 = release?.scale?.scale600 || null;
  const scale1000 = release?.scale?.scale1000 || null;

  const usRelease = release?.expansion?.usBroaderUniverse || null;
  const chinaRelease = release?.expansion?.china || null;
  const europeRelease = release?.expansion?.europe || null;

  const trendHighlights = Array.isArray(trends?.highlights) ? trends.highlights : [];
  const positiveTrend = trendHighlights.find((h) => h.type === "positive") || null;
  const negativeTrend = trendHighlights.find((h) => h.type === "negative") || null;

  const weakest600 = targets?.summaries?.scaling600?.weakest || null;
  const weakest1000 = targets?.summaries?.scaling1000?.weakest || null;

  let overallStatus = "Das System läuft in einem mittleren Zustand.";
  if (systemBand === "excellent") overallStatus = "Das System läuft aktuell sehr stark und stabil.";
  else if (systemBand === "good") overallStatus = "Das System läuft aktuell stabil.";
  else if (systemBand === "critical") overallStatus = "Das System läuft aktuell kritisch und braucht sofort Aufmerksamkeit.";

  let trustStatus = "Die wichtigsten Berechnungen sind aktuell nur teilweise belastbar.";
  if (trustBand === "trusted") trustStatus = "Die wichtigsten Berechnungen wirken aktuell belastbar.";
  else if (trustBand === "usable") trustStatus = "Die wichtigsten Berechnungen sind brauchbar, aber noch nicht maximal abgesichert.";
  else if (trustBand === "unreliable") trustStatus = "Die wichtigsten Berechnungen sind aktuell noch nicht verlässlich genug.";

  let scaleStatus = "Noch keine saubere Skalierungsfreigabe.";
  if (scale600?.allowed) scaleStatus = "Das System ist bereit für einen kontrollierten Ausbau auf 600 Aktien.";
  else if (scale450?.allowed) scaleStatus = "Ein kontrollierter Ausbau auf 450 Aktien ist aktuell testbar.";
  else scaleStatus = "Das aktuelle Niveau sollte vor weiterer Skalierung erst stabilisiert werden.";

  let expansionStatus = "Der nächste sinnvolle Ausbau liegt aktuell im breiteren US-Universum.";
  if (chinaRelease?.allowed) expansionStatus = "China ist aktuell als nächster Ausbau freigabereif.";
  else if (europeRelease?.allowed) expansionStatus = "Europa ist aktuell als nächster Ausbau freigabereif.";
  else if (usRelease?.allowed) expansionStatus = "Ein breiteres US-Universum ist aktuell der sauberste nächste Ausbau.";

  const biggestRisk = topAlert
    ? {
        title: topAlert.title,
        detail: topAlert.detail,
      }
    : {
        title: "Kein akuter Großalarm erkannt",
        detail: "Es wurde aktuell keine dominierende kritische Warnung erkannt.",
      };

  const biggestChance = positiveTrend
    ? {
        title: positiveTrend.title,
        detail: positiveTrend.detail,
      }
    : scale450?.allowed
      ? {
          title: "450 Aktien testbar",
          detail: "Das System ist stark genug für einen ersten kontrollierten Ausbau.",
        }
      : {
          title: "US zuerst verbreitern",
          detail: "Der größte Hebel liegt aktuell eher im Ausbau des bestehenden US-Systems.",
        };

  const nextAction = topPriority
    ? {
        title: topPriority.title,
        detail: topPriority.detail,
      }
    : {
        title: "System beobachten",
        detail: "Aktuell gibt es keine dominierende Einzelpriorität.",
      };

  const scalingReport = {
    scale450: {
      status: scale450?.status || "blocked",
      allowed: Boolean(scale450?.allowed),
      reason: scale450?.reason || null,
      nextStep: scale450?.nextStep || null,
    },
    scale600: {
      status: scale600?.status || "blocked",
      allowed: Boolean(scale600?.allowed),
      reason: scale600?.reason || null,
      nextStep: scale600?.nextStep || null,
    },
    scale1000: {
      status: scale1000?.status || "blocked",
      allowed: Boolean(scale1000?.allowed),
      reason: scale1000?.reason || null,
      nextStep: scale1000?.nextStep || null,
    },
  };

  const expansionReport = {
    usBroaderUniverse: {
      status: usRelease?.status || "blocked",
      allowed: Boolean(usRelease?.allowed),
      reason: usRelease?.reason || null,
      nextStep: usRelease?.nextStep || null,
    },
    china: {
      status: chinaRelease?.status || "blocked",
      allowed: Boolean(chinaRelease?.allowed),
      reason: chinaRelease?.reason || null,
      nextStep: chinaRelease?.nextStep || null,
    },
    europe: {
      status: europeRelease?.status || "blocked",
      allowed: Boolean(europeRelease?.allowed),
      reason: europeRelease?.reason || null,
      nextStep: europeRelease?.nextStep || null,
    },
  };

  const adminText = [
    overallStatus,
    `Der aktuelle Hauptengpass ist: ${topBottleneck}.`,
    trustStatus,
    scaleStatus,
    expansionStatus,
    topChain ? `Die wichtigste Ursache-Wirkung-Kette lautet: ${topChain.title}.` : null,
    negativeTrend ? `Auffällig negativ: ${negativeTrend.title}.` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const dailyBrief = [
    overallStatus,
    `System Health liegt bei ${systemHealth}.`,
    `Calculation Trust liegt bei ${calcTrust}.`,
    `Größter Engpass: ${topBottleneck}.`,
    scale450?.allowed
      ? "450 Aktien sind aktuell testbar."
      : "450 Aktien sind aktuell noch nicht freigegeben.",
    scale600?.allowed
      ? "600 Aktien sind aktuell freigegeben."
      : weakest600
        ? `Für 600 Aktien ist aktuell die größte Lücke: ${weakest600.title}.`
        : "600 Aktien sind aktuell noch nicht freigegeben.",
    chinaRelease?.allowed
      ? "China ist als nächster Ausbau freigegeben."
      : "China ist aktuell noch nicht freigegeben.",
  ].join(" ");

  const weeklyBrief = [
    overallStatus,
    positiveTrend ? `Wichtigste positive Entwicklung: ${positiveTrend.title}.` : "Keine dominante positive Entwicklung erkannt.",
    negativeTrend ? `Wichtigste negative Entwicklung: ${negativeTrend.title}.` : "Keine dominante negative Entwicklung erkannt.",
    biggestRisk ? `Größte Gefahr: ${biggestRisk.title}.` : null,
    biggestChance ? `Größte Chance: ${biggestChance.title}.` : null,
    weakest1000
      ? `Für 1000 Aktien ist aktuell die größte Hürde: ${weakest1000.title}.`
      : "Für 1000 Aktien wurde keine einzelne Hauptlücke erkannt.",
    nextAction ? `Wichtigster nächster Schritt: ${nextAction.title}.` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    generatedAt: new Date().toISOString(),

    executiveSummary: {
      overallStatus,
      trustStatus,
      scaleStatus,
      expansionStatus,
    },

    biggestRisk,
    biggestChance,
    nextAction,

    scalingReport,
    expansionReport,

    adminText,
    dailyBrief,
    weeklyBrief,

    quickBoard: {
      systemHealth,
      calculationTrust: calcTrust,
      topBottleneck,
      scale450Allowed: Boolean(scale450?.allowed),
      scale600Allowed: Boolean(scale600?.allowed),
      scale1000Allowed: Boolean(scale1000?.allowed),
      chinaAllowed: Boolean(chinaRelease?.allowed),
      europeAllowed: Boolean(europeRelease?.allowed),
      usBroaderUniverseAllowed: Boolean(usRelease?.allowed),
    },
  };
}

module.exports = {
  buildAdminBriefing,
};
