"use strict";

// engines/adminRelease.engine.js
// Baut klare Freigabe-/Sperrentscheidungen für Skalierung und Marktausbau.

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function buildDecision({
  key,
  title,
  allowed,
  score,
  confidence,
  blocker = null,
  reason,
  nextStep,
}) {
  return {
    key,
    title,
    status: allowed ? "released" : "blocked",
    allowed: Boolean(allowed),
    score: safeNum(score, 0),
    confidence: safeNum(confidence, 0),
    blocker: blocker || null,
    reason,
    nextStep,
  };
}

function buildAdminRelease({
  diagnostics = {},
  validation = {},
  priorities = {},
  targets = {},
  causality = {},
} = {}) {
  const scale450Score = safeNum(diagnostics?.scaling?.scale450?.score, 0);
  const scale600Score = safeNum(diagnostics?.scaling?.scale600?.score, 0);
  const scale1000Score = safeNum(diagnostics?.scaling?.scale1000?.score, 0);

  const systemHealth = safeNum(diagnostics?.health?.systemHealthScore, 0);
  const learningHealth = safeNum(diagnostics?.health?.learningHealthScore, 0);
  const calculationTrust = safeNum(validation?.trust?.overallCalculationTrust, 0);
  const learningConfidence = safeNum(validation?.trust?.learningConfidence, 0);
  const discoveryConfidence = safeNum(validation?.trust?.discoveryConfidence, 0);
  const regimeConfidence = safeNum(validation?.trust?.regimeConfidence, 0);

  const topPriority = priorities?.summary?.topPriority || null;
  const topChain = causality?.summary?.topChain || null;

  const weakest450 = targets?.summaries?.scaling450?.weakest || null;
  const weakest600 = targets?.summaries?.scaling600?.weakest || null;
  const weakest1000 = targets?.summaries?.scaling1000?.weakest || null;
  const weakestChina = targets?.summaries?.expansionChina?.weakest || null;

  const chinaScore = safeNum(diagnostics?.expansion?.china?.score, 0);
  const europeScore = safeNum(diagnostics?.expansion?.europe?.score, 0);
  const usScore = safeNum(diagnostics?.expansion?.us?.score, 0);

  const release450 =
    scale450Score >= 65 &&
    systemHealth >= 65 &&
    calculationTrust >= 55;

  const release600 =
    scale600Score >= 70 &&
    systemHealth >= 75 &&
    calculationTrust >= 65 &&
    learningConfidence >= 60;

  const release1000 =
    scale1000Score >= 80 &&
    systemHealth >= 85 &&
    calculationTrust >= 75 &&
    learningConfidence >= 70 &&
    discoveryConfidence >= 65 &&
    regimeConfidence >= 60;

  const releaseChina =
    chinaScore >= 75 &&
    systemHealth >= 75 &&
    calculationTrust >= 65 &&
    discoveryConfidence >= 60;

  const releaseEurope =
    europeScore >= 75 &&
    systemHealth >= 75 &&
    calculationTrust >= 65;

  const scale = {
    scale450: buildDecision({
      key: "scale450",
      title: "Freigabe für 450 Aktien",
      allowed: release450,
      score: scale450Score,
      confidence: calculationTrust,
      blocker: release450 ? null : weakest450?.title || topPriority?.title || null,
      reason: release450
        ? "Das System wirkt stabil genug für einen ersten kontrollierten Ausbau."
        : "Mindestens eine Kernvoraussetzung für 450 Aktien ist noch nicht erfüllt.",
      nextStep: release450
        ? "450 in kontrolliertem Testmodus erhöhen."
        : weakest450
          ? `${weakest450.title} zuerst näher ans Ziel bringen.`
          : "Kernengpässe zuerst stabilisieren.",
    }),

    scale600: buildDecision({
      key: "scale600",
      title: "Freigabe für 600 Aktien",
      allowed: release600,
      score: scale600Score,
      confidence: calculationTrust,
      blocker: release600 ? null : weakest600?.title || topChain?.title || null,
      reason: release600
        ? "Die mittlere Skalierung ist unter den aktuellen Bedingungen vertretbar."
        : "Für 600 Aktien fehlen noch Stabilität, Vertrauen oder Lernreife.",
      nextStep: release600
        ? "600 in Stufen testen und eng überwachen."
        : weakest600
          ? `${weakest600.title} gezielt verbessern, bevor 600 freigegeben werden.`
          : "Mittlere Skalierung noch zurückstellen.",
    }),

    scale1000: buildDecision({
      key: "scale1000",
      title: "Freigabe für 1000 Aktien",
      allowed: release1000,
      score: scale1000Score,
      confidence: calculationTrust,
      blocker: release1000 ? null : weakest1000?.title || topChain?.title || null,
      reason: release1000
        ? "Die High-End-Skalierung wirkt unter den aktuellen Bedingungen vertretbar."
        : "Für 1000 Aktien fehlen noch mehrere High-End-Voraussetzungen.",
      nextStep: release1000
        ? "1000 nur kontrolliert und mit enger Überwachung freigeben."
        : weakest1000
          ? `${weakest1000.title} ist aktuell die größte Hürde für 1000 Aktien.`
          : "Großskalierung erst nach stabilen High-End-Werten.",
    }),
  };

  const expansion = {
    usBroaderUniverse: buildDecision({
      key: "us_broader_universe",
      title: "Freigabe für breiteres US-Universum",
      allowed: usScore >= 70 && systemHealth >= 70,
      score: usScore,
      confidence: calculationTrust,
      blocker: usScore >= 70 && systemHealth >= 70 ? null : topPriority?.title || null,
      reason:
        usScore >= 70 && systemHealth >= 70
          ? "Der Ausbau innerhalb des US-Universums ist der aktuell sauberste nächste Schritt."
          : "Das US-System sollte vor weiterer Verbreiterung noch stabiler werden.",
      nextStep:
        usScore >= 70 && systemHealth >= 70
          ? "US-Breite kontrolliert erhöhen."
          : "Erst die Kernstabilität und Coverage weiter verbessern.",
    }),

    china: buildDecision({
      key: "china",
      title: "Freigabe für China-Ausbau",
      allowed: releaseChina,
      score: chinaScore,
      confidence: calculationTrust,
      blocker: releaseChina ? null : weakestChina?.title || topChain?.title || null,
      reason: releaseChina
        ? "China ist unter den aktuellen Bedingungen als nächster Ausbau vertretbar."
        : "China ist noch nicht reif genug für einen sauberen Ausbau.",
      nextStep: releaseChina
        ? "China schrittweise aktivieren."
        : weakestChina
          ? `${weakestChina.title} zuerst schließen, bevor China freigegeben wird.`
          : "China-Ausbau vorerst zurückstellen.",
    }),

    europe: buildDecision({
      key: "europe",
      title: "Freigabe für Europa-Ausbau",
      allowed: releaseEurope,
      score: europeScore,
      confidence: calculationTrust,
      blocker: releaseEurope ? null : topPriority?.title || null,
      reason: releaseEurope
        ? "Europa ist unter den aktuellen Bedingungen als nächster Ausbau vertretbar."
        : "Europa sollte erst nach stärkerer Systemreife freigegeben werden.",
      nextStep: releaseEurope
        ? "Europa kontrolliert vorbereiten und aktivieren."
        : "Europa erst nach weiterer Stabilisierung angehen.",
    }),
  };

  const executive = {
    releaseNow: [],
    blockedNow: [],
  };

  for (const item of [...Object.values(scale), ...Object.values(expansion)]) {
    if (item.allowed) executive.releaseNow.push(item.title);
    else executive.blockedNow.push(item.title);
  }

  return {
    generatedAt: new Date().toISOString(),
    scale,
    expansion,
    executiveSummary: executive,
  };
}

module.exports = {
  buildAdminRelease,
};
