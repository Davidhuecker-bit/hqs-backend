"use strict";

// engines/adminCausality.engine.js
// Baut Ursache-Wirkung-Ketten für dein Kontrollzentrum.
// Zeigt, welcher Engpass welche Folgeprobleme auslöst.

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pushChain(list, chain) {
  if (!chain || !chain.key) return;
  list.push(chain);
}

function sortChains(chains = []) {
  return [...chains].sort((a, b) => safeNum(b.score, 0) - safeNum(a.score, 0));
}

function buildAdminCausality({
  insights = {},
  diagnostics = {},
  validation = {},
  targets = {},
} = {}) {
  const chains = [];

  const snapshotCoverage = safeNum(insights?.coverage?.snapshotUniverseCoverage, 0);
  const advancedCoverage = safeNum(insights?.coverage?.advancedCoverageVsSnapshots, 0);
  const outcomeCoverage = safeNum(insights?.coverage?.outcomeCoverageVsSnapshots, 0);
  const outcomeCompletion = safeNum(insights?.activity?.outcomes?.completionRate, 0);

  const systemHealth = safeNum(diagnostics?.health?.systemHealthScore, 0);
  const learningHealth = safeNum(diagnostics?.health?.learningHealthScore, 0);
  const discoveryHealth = safeNum(diagnostics?.health?.discoveryHealthScore, 0);

  const calculationTrust = safeNum(validation?.trust?.overallCalculationTrust, 0);
  const hqsConfidence = safeNum(validation?.trust?.hqsConfidence, 0);
  const learningConfidence = safeNum(validation?.trust?.learningConfidence, 0);
  const discoveryConfidence = safeNum(validation?.trust?.discoveryConfidence, 0);
  const regimeConfidence = safeNum(validation?.trust?.regimeConfidence, 0);

  const scale450Allowed = Boolean(diagnostics?.scaling?.scale450?.allowed);
  const scale600Allowed = Boolean(diagnostics?.scaling?.scale600?.allowed);
  const scale1000Allowed = Boolean(diagnostics?.scaling?.scale1000?.allowed);

  const nextBestExpansion = diagnostics?.summary?.nextBestExpansion || "us_broader_universe";

  const weakest600 = targets?.summaries?.scaling600?.weakest || null;
  const weakest1000 = targets?.summaries?.scaling1000?.weakest || null;
  const weakestChina = targets?.summaries?.expansionChina?.weakest || null;

  if (advancedCoverage < 55) {
    pushChain(chains, {
      key: "advanced_metrics_chain",
      score: 98,
      title: "Advanced-Metrics-Engpass blockiert mehrere Ebenen",
      cause: "Zu wenige Snapshots werden zu Advanced Metrics weiterverarbeitet.",
      effects: [
        "Calculation Trust bleibt zu niedrig",
        "Simulationen bleiben zu modelllastig",
        "Learning bekommt zu wenig tiefe Zusatzdaten",
        "Skalierung auf 600 oder mehr wird unsauber",
      ],
      blockedArea: "scaling_and_calculation_quality",
      recommendation: "Advanced-Metrics-Pipeline zuerst stärken.",
    });
  }

  if (snapshotCoverage < 60) {
    pushChain(chains, {
      key: "snapshot_coverage_chain",
      score: 97,
      title: "Niedrige Snapshot-Abdeckung limitiert das ganze System",
      cause: "Zu wenig vom aktiven Universe wird tatsächlich verarbeitet.",
      effects: [
        "Weniger Daten für HQS und Learning",
        "Discovery bleibt enger als nötig",
        "Skalierungsentscheidungen werden unsicher",
        "Neue Märkte bringen zu früh zusätzliche Last",
      ],
      blockedArea: "breadth_and_scaling",
      recommendation: "Breite und Verarbeitungsquote erhöhen, bevor weiter ausgebaut wird.",
    });
  }

  if (outcomeCoverage < 45 || outcomeCompletion < 40) {
    pushChain(chains, {
      key: "outcome_tracking_chain",
      score: 96,
      title: "Schwaches Outcome-Tracking bremst echtes Lernen",
      cause: "Zu wenige verarbeitete Fälle werden sauber rückgeprüft und abgeschlossen.",
      effects: [
        "Learning Confidence bleibt niedrig",
        "Gewichte sind noch zu wenig belegt",
        "Regime-Anpassung bleibt vorsichtig",
        "Tuning ist riskanter als nötig",
      ],
      blockedArea: "learning_and_weights",
      recommendation: "Outcome-Tracking-Qualität und Abschlussrate priorisieren.",
    });
  }

  if (calculationTrust < 60) {
    pushChain(chains, {
      key: "calculation_trust_chain",
      score: 88,
      title: "Niedriges Berechnungsvertrauen blockiert aggressive Optimierung",
      cause: "Mehrere Kernberechnungen sind noch nicht stark genug datenbasiert abgesichert.",
      effects: [
        "Score-Tuning bleibt unsicher",
        "Skalierung sollte zurückhaltend erfolgen",
        "Neue Marktlogik würde auf dünnem Fundament aufsetzen",
      ],
      blockedArea: "tuning_and_expansion",
      recommendation: "Erst Datenbasis und Coverage erhöhen, dann härter optimieren.",
    });
  }

  if (learningConfidence < 60) {
    pushChain(chains, {
      key: "learning_confidence_chain",
      score: 84,
      title: "Schwaches Learning-Vertrauen hält die Gewichte zurück",
      cause: "Zu wenig belastbare Lernfälle und Outcome-Abschlüsse.",
      effects: [
        "Adaptive Weights bleiben vorsichtig",
        "Regime-Lernen entwickelt sich langsamer",
        "Scale-Readiness steigt langsamer",
      ],
      blockedArea: "weights_and_regime_learning",
      recommendation: "Lernbasis vertiefen, bevor Gewichte aggressiv nachjustiert werden.",
    });
  }

  if (discoveryConfidence < 60 || discoveryHealth < 60) {
    pushChain(chains, {
      key: "discovery_chain",
      score: 80,
      title: "Discovery ist noch nicht breit genug für starke Expansion",
      cause: "Discovery ist noch nicht ausreichend breit, vielfältig oder rückgeprüft.",
      effects: [
        "Chancenbild bleibt enger",
        "Neue Universen würden noch nicht optimal genutzt",
        "Marktausbau bringt weniger als möglich",
      ],
      blockedArea: "opportunity_breadth",
      recommendation: "Discovery zuerst über mehr Symbole und Setups verbreitern.",
    });
  }

  if (!scale450Allowed) {
    pushChain(chains, {
      key: "scale450_block_chain",
      score: 78,
      title: "450 Aktien werden noch durch Kernschwächen blockiert",
      cause: "System Health, Coverage oder Learning reichen noch nicht stabil genug.",
      effects: [
        "Kontrollierter Ausbau sollte verschoben werden",
        "Mehr Last würde die Engpässe verstärken",
      ],
      blockedArea: "scale450",
      recommendation: "Erst Hauptengpässe stabilisieren, dann 450 freigeben.",
    });
  }

  if (scale450Allowed && !scale600Allowed) {
    pushChain(chains, {
      key: "scale600_block_chain",
      score: 76,
      title: "600 Aktien werden durch mittlere Reife-Lücken blockiert",
      cause: weakest600
        ? `${weakest600.title} liegt noch unter Zielniveau.`
        : "Mindestens ein Kernziel für 600 Aktien ist noch nicht erreicht.",
      effects: [
        "Mittlere Skalierung bleibt riskant",
        "Mehr Universe-Breite würde noch nicht stabil verarbeitet",
      ],
      blockedArea: "scale600",
      recommendation: "Gezielt die größte 600er-Lücke schließen, dann erneut bewerten.",
    });
  }

  if (scale600Allowed && !scale1000Allowed) {
    pushChain(chains, {
      key: "scale1000_block_chain",
      score: 72,
      title: "1000 Aktien werden noch durch High-End-Lücken blockiert",
      cause: weakest1000
        ? `${weakest1000.title} liegt noch deutlich unter dem Ziel für Großskalierung.`
        : "Die High-End-Zielwerte für Großskalierung sind noch nicht stabil genug erreicht.",
      effects: [
        "Großes Universe-Risiko wäre noch zu hoch",
        "Lern- und Verarbeitungsqualität könnten kippen",
      ],
      blockedArea: "scale1000",
      recommendation: "Erst High-End-Zielwerte stabil erreichen, dann 1000 freigeben.",
    });
  }

  if (nextBestExpansion === "china" && weakestChina) {
    pushChain(chains, {
      key: "china_expansion_chain",
      score: 64,
      title: "China wird interessant, aber noch durch Restlücken gebremst",
      cause: `${weakestChina.title} ist noch die größte offene Lücke für den China-Ausbau.`,
      effects: [
        "China ist noch nicht voll freigabereif",
        "Ein zu früher Ausbau würde auf einem schwächeren Fundament starten",
      ],
      blockedArea: "china_expansion",
      recommendation: "Erst die größte China-Ziellücke schließen, dann Marktausbau starten.",
    });
  }

  if (systemHealth >= 75 && calculationTrust >= 70 && learningConfidence >= 65) {
    pushChain(chains, {
      key: "positive_scale_chain",
      score: 58,
      title: "Stabilität und Vertrauen öffnen den Weg für kontrollierten Ausbau",
      cause: "Mehrere Kernkennzahlen liegen bereits im guten Bereich.",
      effects: [
        "Skalierung wird realistischer",
        "Tuning kann gezielter erfolgen",
        "Marktausbau wird planbarer",
      ],
      blockedArea: "none",
      recommendation: "Nächsten Ausbau kontrolliert und in Stufen testen.",
    });
  }

  const sorted = sortChains(chains);

  return {
    generatedAt: new Date().toISOString(),
    chains: sorted,
    summary: {
      topChain: sorted[0] || null,
      blockedScale450: !scale450Allowed,
      blockedScale600: !scale600Allowed,
      blockedScale1000: !scale1000Allowed,
      nextBestExpansion,
    },
  };
}

module.exports = {
  buildAdminCausality,
};
