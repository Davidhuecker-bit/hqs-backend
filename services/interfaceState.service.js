"use strict";

/*
  Interface State Service  –  „Interface on Demand" Regie-Schicht
  ───────────────────────────────────────────────────────────────
  Aggregates existing system data into a single UI-direction payload.
  No new DB tables, no external API calls – pure derivation from already
  running services.

  Output fields:
  ─────────────
  surfaceMode          "calm" | "warning" | "debate" | "blocked" | "expansion_ready"
  dominantTopic        short key string
  headline             one-line German heading
  executiveNarrative   2–4 sentence plain-text summary
  primaryAction        most important next action
  secondaryActions[]   max 3 additional actions
  uiPriorityPanels[]   panel order hint for the frontend
  deepDiveLevelRecommendation  1 | 2 | 3
  agentDiscourse[]     max 5 agent debate entries

  Design principles:
  ─────────────────
  1. No fake debate – every entry is derived from a concrete system signal.
  2. Deduplicate similar messages.
  3. Only one dominant bottleneck at a time.
  4. Operational plain language, not marketing.
  5. Graceful degradation on any sub-service failure.
*/

const logger = require("../utils/logger");
const { getSystemIntelligenceReport } = require("./systemIntelligence.service");
const { getOperationalReleaseStatus } = require("./sisReleaseControl.service");
const { getWorldState } = require("./worldState.service");
const { getSisTrendSummary } = require("./sisHistory.service");

/* =========================================================
   CONSTANTS
========================================================= */

// SIS thresholds mirrored from sisReleaseControl for surface-mode
const SIS_CALM_MIN      = 65;
const SIS_EXPANSION_MIN = 70;

/* =========================================================
   SURFACE MODE DERIVATION
========================================================= */

/**
 * Derives a surfaceMode from the combination of SIS, risk mode, gates
 * and SIS trend.
 *
 * Priority order:
 *  blocked        → any hard gate blocked AND riskMode=risk_off
 *  warning        → SIS < 40 OR riskMode=risk_off
 *  debate         → multiple significant SIS layer disagreements (some healthy, some inactive)
 *  expansion_ready → SIS ≥ SIS_EXPANSION_MIN AND riskMode=risk_on
 *  calm           → default stable state
 */
function _deriveSurfaceMode(sis, riskMode, gates, layers, trendDirection) {
  const blockerCount = gates ? gates.blockerCount ?? 0 : 0;
  const grantedCount = gates ? gates.grantedCount ?? 0 : 0;

  // Hard blocked: all/most gates closed AND risk off
  if (blockerCount >= 5 && riskMode === "risk_off") return "blocked";

  // Active warning
  if (sis < 40 || riskMode === "risk_off") return "warning";

  // Debate mode: mixed layer health (some healthy, some inactive/degraded)
  if (layers && layers.length > 0) {
    const healthy   = layers.filter((l) => l.status === "healthy").length;
    const inactive  = layers.filter((l) => l.status === "inactive").length;
    if (healthy >= 2 && inactive >= 2) return "debate";
  }

  // Expansion ready
  if (sis >= SIS_EXPANSION_MIN && riskMode === "risk_on") return "expansion_ready";

  // Calm
  return "calm";
}

/* =========================================================
   DOMINANT TOPIC DERIVATION
========================================================= */

/**
 * Returns the single most impactful topic key from system state.
 * Only one dominant bottleneck is surfaced at a time.
 */
function _deriveDominantTopic(sis, riskMode, gates, layers, twinData) {
  // Risk-off is always the dominant concern
  if (riskMode === "risk_off") return "risk_mode";

  // Find the weakest SIS layer (highest gap to max)
  if (layers && layers.length > 0) {
    const weakest = layers
      .filter((l) => l.status !== "healthy" && l.status !== undefined)
      .sort((a, b) => (b.max - b.score) - (a.max - a.score))[0];

    if (weakest) {
      const topicMap = {
        prediction:  "outcome_learning",
        protection:  "capital_protection",
        twin:        "portfolio_twin",
        learning:    "adaptive_learning",
        innovation:  "discovery",
        pattern:     "pattern_memory",
      };
      return topicMap[weakest.id] || "advanced_metrics";
    }
  }

  // Scale gates
  if (gates) {
    if (gates.allowScaleTo600 && !gates.allowScaleTo600.granted) return "scale_600";
    if (gates.allowScaleTo450 && !gates.allowScaleTo450.granted) return "scale_450";
    if (gates.allowChinaExpansion && !gates.allowChinaExpansion.granted) return "china_gate";
    if (gates.allowEuropeExpansion && !gates.allowEuropeExpansion.granted) return "europe_gate";
  }

  if (sis >= SIS_EXPANSION_MIN) return "expansion_ready";

  return "advanced_metrics";
}

/* =========================================================
   HEADLINE + NARRATIVE
========================================================= */

const _SURFACE_HEADLINES = {
  blocked:         "⛔ System blockiert – Eingriff erforderlich",
  warning:         "⚠️ Systemwarnung – Handlungsbedarf",
  debate:          "🤝 Gemischte Signale – Debatte aktiv",
  expansion_ready: "🚀 Expansionsbereit – Freigaben erteilt",
  calm:            "✅ System stabil – kontrollierter Betrieb",
};

function _buildNarrative(surfaceMode, sis, riskMode, dominantTopic, sisRec, trendDir, blockers) {
  const topicLabels = {
    risk_mode:         "Der Markt ist gerade nicht günstig",
    outcome_learning:  "Die Prognose-Genauigkeit kann noch besser werden",
    capital_protection:"Der Guardian hat noch wenig Eingriffe protokolliert",
    portfolio_twin:    "Der Portfolio-Twin hat noch wenig aktive Positionen",
    adaptive_learning: "Das Lerngedächtnis arbeitet noch mit Standardwerten",
    discovery:         "Der Tech-Radar hat noch nicht vollständig gescannt",
    pattern_memory:    "Noch wenige verifizierte Datenpunkte vorhanden",
    scale_450:         "Das Skalierungs-Gate auf €450 ist noch gesperrt",
    scale_600:         "Das Skalierungs-Gate auf €600 ist noch gesperrt",
    china_gate:        "Das China-Expansions-Gate ist gesperrt",
    europe_gate:       "Das Europa-Expansions-Gate ist gesperrt",
    expansion_ready:   "Alle Kern-Gates sind freigegeben",
    advanced_metrics:  "Die Systemmetriken sind insgesamt stabil",
  };
  const topicText = topicLabels[dominantTopic] || dominantTopic;

  const trendText = trendDir === "improving" ? "Das System verbessert sich gerade." :
                    trendDir === "declining"  ? "Der System-Score sinkt – Ursache prüfen." : "";

  switch (surfaceMode) {
    case "blocked":
      return `Das System ist blockiert. Kein automatischer Betrieb möglich. ` +
        `${topicText}. System-Score: ${sis}/100. ${trendText} ` +
        `${blockers.slice(0,2).map(b => b?.reason ?? '–').join(" · ") || "Marktbedingungen prüfen."} ` +
        `Bitte jetzt die Marktlage und den Risk-Mode überprüfen.`;
    case "warning":
      return `Das System ist vorsichtig. ${topicText}. ` +
        `System-Score: ${sis}/100. ${trendText} ` +
        `${sisRec?.action ? `Was jetzt hilft: ${sisRec.action}.` : ""} ` +
        `Nur konservativer Betrieb ist gerade sinnvoll.`;
    case "debate":
      return `Das System sendet gemischte Signale. Einige Bereiche laufen gut, andere brauchen noch Zeit. ` +
        `${topicText}. System-Score: ${sis}/100. ${trendText} ` +
        `Optimist und Skeptiker sind sich nicht einig – der Richter beobachtet.`;
    case "expansion_ready":
      return `Das System ist bereit. Alle wichtigen Gates sind freigegeben. ` +
        `System-Score: ${sis}/100. Markt ist günstig. ${trendText} ` +
        `Kontrollierte Skalierung und breitere Suche sind jetzt möglich.`;
    case "calm":
    default:
      return `Das System läuft stabil. ${topicText}. ` +
        `System-Score: ${sis}/100. ${trendText} ` +
        `${sisRec?.action ? `Nächste Verbesserung: ${sisRec.action}.` : "Kein dringender Handlungsbedarf."}`;
  }
}

/* =========================================================
   ACTIONS DERIVATION
========================================================= */

function _deriveActions(surfaceMode, recs, gates, dominantTopic) {
  const gateActionMap = {
    allowAutoPositionOpen:  "Portfolio-Twin Auto-Open aktivieren (PORTFOLIO_TWIN_AUTO_OPEN=true)",
    allowBroaderDiscovery:  "Discovery-Scan auf breiteres Universum ausweiten",
    allowAggressiveWeights: "Agenten-Gewichte aggressiver kalibrieren",
    allowScaleTo450:        "Budget-Skalierung auf €450 prüfen",
    allowScaleTo600:        "Budget-Skalierung auf €600 prüfen",
    allowChinaExpansion:    "China-Segment in Discovery einschalten",
    allowEuropeExpansion:   "Europa-Segment in Discovery einschalten",
  };

  // Primary action from first SIS recommendation
  const primaryAction = recs && recs.length > 0
    ? recs[0].action
    : "System-Intelligence-Report prüfen";

  // Secondary: next recs + first blocked gate action
  const secondary = [];
  if (recs && recs[1]) secondary.push(recs[1].action);
  if (recs && recs[2]) secondary.push(recs[2].action);

  if (gates) {
    const firstBlocked = Object.entries(gates)
      .filter(([k, v]) => typeof v === "object" && v !== null && v.granted === false)
      .map(([k]) => gateActionMap[k])
      .filter(Boolean)[0];
    if (firstBlocked && secondary.length < 3) secondary.push(firstBlocked);
  }

  return { primaryAction, secondaryActions: secondary.slice(0, 3) };
}

/* =========================================================
   UI PRIORITY PANELS
========================================================= */

function _deriveUiPriorityPanels(surfaceMode) {
  // Returns an ordered array of panel IDs that the frontend should emphasise
  const base = ["chiefSummary", "agentDiscourse"];
  switch (surfaceMode) {
    case "blocked":
      return [...base, "releaseGates", "warnings", "opsPanel", "sisPanel"];
    case "warning":
      return [...base, "warnings", "opsPanel", "sisPanel", "releaseGates"];
    case "debate":
      return [...base, "agentDiscourse", "sisPanel", "sisTrendPanel", "opsPanel"];
    case "expansion_ready":
      return [...base, "releaseGates", "opsPanel", "twin4Panel", "sisPanel"];
    case "calm":
    default:
      return [...base, "sisPanel", "opsPanel", "sisTrendPanel", "twin4Panel"];
  }
}

/* =========================================================
   DEEP DIVE LEVEL RECOMMENDATION
========================================================= */

function _deepDiveLevel(surfaceMode, sis) {
  if (surfaceMode === "blocked" || surfaceMode === "warning") return 3; // show all detail
  if (surfaceMode === "debate")                               return 2;
  if (sis >= SIS_EXPANSION_MIN)                               return 2;
  return 1;
}

/* =========================================================
   AGENT DISCOURSE  (derived from real system signals)
========================================================= */

const AGENTS = {
  OPTIMIST:  { agent: "OPTIMIST",  icon: "📈" },
  SKEPTIKER: { agent: "SKEPTIKER", icon: "🛡️" },
  RICHTER:   { agent: "RICHTER",   icon: "⚖️" },
  GUARDIAN:  { agent: "GUARDIAN",  icon: "🔒" },
};

/**
 * Builds max 5 agent discourse entries from real system signals.
 * Each entry maps a concrete signal to a named agent's perspective.
 */
function _buildAgentDiscourse(sis, riskMode, layers, gates, twinData, trendDir) {
  const entries = [];

  const addEntry = (agent, stance, message, confidence, evidenceTag) => {
    // Deduplicate by evidenceTag – only one entry per tag
    if (!entries.find((e) => e.evidenceTag === evidenceTag)) {
      entries.push({ agent, stance, message, confidence, evidenceTag });
    }
  };

  // ── Risk Mode signal ──────────────────────────────────────────────────────
  if (riskMode === "risk_off") {
    addEntry(
      AGENTS.GUARDIAN.agent, "blocking",
      "Risk-Mode ist auf risk_off gesetzt. Automatische Positionseröffnung ist gesperrt. Marktbedingungen sind nicht günstig.",
      90, "risk_mode"
    );
    addEntry(
      AGENTS.SKEPTIKER.agent, "warning",
      "Solange risk_off aktiv ist, sollten keine aggressiven Skalierungen oder Expansionen initiiert werden.",
      80, "risk_mode_context"
    );
  } else if (riskMode === "risk_on") {
    addEntry(
      AGENTS.OPTIMIST.agent, "supporting",
      `Risk-Mode ist risk_on. Marktbedingungen begünstigen aktiven Betrieb. SIS ${sis}/100.`,
      Math.min(60 + Math.round(sis / 5), 90), "risk_mode"
    );
  } else {
    addEntry(
      AGENTS.RICHTER.agent, "neutral",
      `Markt-Regime ist neutral (${riskMode}). Abwarten bis klare Richtung erkennbar.`,
      55, "risk_mode"
    );
  }

  // ── Prediction Quality ────────────────────────────────────────────────────
  const predLayer = layers ? layers.find((l) => l.id === "prediction") : null;
  if (predLayer) {
    if (predLayer.status === "healthy") {
      addEntry(
        AGENTS.OPTIMIST.agent, "supporting",
        `Prognose-Qualität gut: ${predLayer.detail}.`,
        Math.min(40 + predLayer.score, 90), "outcome_learning"
      );
    } else if (predLayer.status === "inactive") {
      addEntry(
        AGENTS.SKEPTIKER.agent, "warning",
        "Keine verifizierten Prognosen vorhanden. Causal-Memory kann noch nicht lernen.",
        75, "outcome_gap"
      );
    } else {
      addEntry(
        AGENTS.RICHTER.agent, "neutral",
        `Prognose-Qualität ausbaufähig: ${predLayer.detail}.`,
        60, "outcome_learning"
      );
    }
  }

  // ── Portfolio Twin ────────────────────────────────────────────────────────
  const twinLayer = layers ? layers.find((l) => l.id === "twin") : null;
  if (twinLayer) {
    if (twinLayer.status === "inactive") {
      addEntry(
        AGENTS.SKEPTIKER.agent, "warning",
        "Portfolio-Twin hat keine aktiven Positionen. Testbetrieb läuft nicht.",
        70, "portfolio_twin"
      );
    } else if (twinLayer.status === "healthy") {
      addEntry(
        AGENTS.OPTIMIST.agent, "supporting",
        `Portfolio-Twin ist aktiv: ${twinLayer.detail}.`,
        65, "portfolio_twin"
      );
    }
  }

  // ── Scale gates ───────────────────────────────────────────────────────────
  if (gates) {
    const scale600 = gates.allowScaleTo600;
    const scale450 = gates.allowScaleTo450;
    if (scale600 && scale600.granted) {
      addEntry(
        AGENTS.OPTIMIST.agent, "supporting",
        "Skalierungs-Gate auf €600 ist freigegeben. Expansion unter kontrollierten Bedingungen möglich.",
        85, "scale_gate"
      );
    } else if (scale450 && !scale450.granted) {
      addEntry(
        AGENTS.GUARDIAN.agent, "blocking",
        `Skalierung auf €450 gesperrt: ${scale450.reason}.`,
        88, "scale_gate"
      );
    } else if (scale450 && scale450.granted && scale600 && !scale600.granted) {
      addEntry(
        AGENTS.RICHTER.agent, "neutral",
        `€450-Gate offen, €600-Gate noch gesperrt: ${scale600.reason}.`,
        72, "scale_gate"
      );
    }
  }

  // ── SIS Trend ─────────────────────────────────────────────────────────────
  if (trendDir === "declining") {
    addEntry(
      AGENTS.SKEPTIKER.agent, "warning",
      "SIS-Trend zeigt Rückgang. Systemgesundheit verschlechtert sich – Ursache identifizieren.",
      78, "sis_trend"
    );
  } else if (trendDir === "improving") {
    addEntry(
      AGENTS.OPTIMIST.agent, "supporting",
      "SIS-Trend positiv. Das System verbessert sich – Lernkurve aktiv.",
      70, "sis_trend"
    );
  }

  // Limit to 5 entries
  return entries.slice(0, 5);
}

/* =========================================================
   MAIN FUNCTION
========================================================= */

/**
 * Builds the full interface-state payload from existing system services.
 * Pure derivation – no DB writes, no external calls.
 *
 * @returns {Promise<object>}
 */
async function getInterfaceState() {
  // ── Fetch all inputs in parallel ─────────────────────────────────────────
  const [sisReport, opsStatus, worldState, sisTrend] = await Promise.all([
    getSystemIntelligenceReport().catch((err) => {
      logger.warn("interfaceState: getSystemIntelligenceReport failed", { message: err.message });
      return { sis: 0, layers: [], recommendations: [] };
    }),
    getOperationalReleaseStatus().catch((err) => {
      logger.warn("interfaceState: getOperationalReleaseStatus failed", { message: err.message });
      return { sis: 0, riskMode: "risk_off", blockerCount: 7, grantedCount: 0 };
    }),
    getWorldState().catch((err) => {
      logger.warn("interfaceState: getWorldState failed", { message: err.message });
      return { risk_mode: "neutral" };
    }),
    getSisTrendSummary().catch((err) => {
      logger.warn("interfaceState: getSisTrendSummary failed", { message: err.message });
      return { trend: "stable", direction: "stable" };
    }),
  ]);

  const sis      = sisReport.sis       ?? 0;
  const layers   = sisReport.layers    ?? [];
  const recs     = sisReport.recommendations ?? [];
  const riskMode = worldState.risk_mode ?? opsStatus.riskMode ?? "neutral";
  const trendDir = (sisTrend.trend || sisTrend.direction || "stable").toLowerCase();

  // ── Derive all fields ─────────────────────────────────────────────────────
  const surfaceMode    = _deriveSurfaceMode(sis, riskMode, opsStatus, layers, trendDir);
  const dominantTopic  = _deriveDominantTopic(sis, riskMode, opsStatus, layers, null);
  const headline       = _SURFACE_HEADLINES[surfaceMode] || "System-Status";

  const blockers       = opsStatus.biggestBlockers || [];
  const executiveNarrative = _buildNarrative(
    surfaceMode, sis, riskMode, dominantTopic,
    recs[0] || null, trendDir, blockers
  );

  const { primaryAction, secondaryActions } = _deriveActions(surfaceMode, recs, opsStatus, dominantTopic);
  const uiPriorityPanels = _deriveUiPriorityPanels(surfaceMode);
  const deepDiveLevelRecommendation = _deepDiveLevel(surfaceMode, sis);
  const agentDiscourse = _buildAgentDiscourse(sis, riskMode, layers, opsStatus, null, trendDir);

  return {
    surfaceMode,
    dominantTopic,
    headline,
    executiveNarrative: executiveNarrative.trim(),
    primaryAction,
    secondaryActions,
    uiPriorityPanels,
    deepDiveLevelRecommendation,
    agentDiscourse,
    // meta
    sis,
    riskMode,
    blockerCount: opsStatus.blockerCount ?? 0,
    generatedAt: new Date().toISOString(),
  };
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  getInterfaceState,
};
