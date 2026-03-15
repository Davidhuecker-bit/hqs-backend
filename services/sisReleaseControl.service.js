"use strict";

/*
  SIS Release Control Service  –  Operational Freigabe-/Skalierungslogik
  ────────────────────────────────────────────────────────────────────────
  Derives deterministic, explainable operational release decisions from
  already-existing data sources (SIS report, world state, portfolio twin).

  Design principles (low-budget, 2030–2035 vision):
  ──────────────────────────────────────────────────
  1. Pure derivation layer – no new DB tables, no background jobs.
  2. All inputs come from getSystemIntelligenceReport(), getWorldState(),
     and getPortfolioTwinSnapshot() which already exist.
  3. Every gate is independently explainable: granted + reason per flag.
  4. Thresholds are constants – easy to tune, no ML required.
  5. Fail-safe: if any input service fails, the function degrades to the
     most conservative output without throwing.

  Released flags:
  ───────────────
  • allowAutoPositionOpen    – virtual positions may be opened automatically
  • allowBroaderDiscovery    – discovery may scan a wider symbol universe
  • allowAggressiveWeights   – swarm agent weights may be pushed aggressively
  • allowScaleTo450          – budget may be scaled toward €450 equivalent
  • allowScaleTo600          – budget may be scaled toward €600 equivalent
  • allowChinaExpansion      – China segment may be included in scans
  • allowEuropeExpansion     – Europe segment may be included in scans
  • recommendedMode          – conservative | controlled | expansion-ready

  Future-advantage documentation (Leitidee §10):
  ───────────────────────────────────────────────
  REUSED:  systemIntelligence (SIS layers), worldState (riskMode, uncertainty,
           regime cluster), portfolioTwin (drawdown, winRate, twinMaturity).
  NOT BUILT: Broker integration, complex rebalancing, Monte Carlo simulation,
             new DB tables, external APIs, scheduled jobs.
  WHY BEST: Zero marginal cost, deterministic decision trail, fully auditable
            by admin, direct path to autonomous operation in Stage 4.
*/

const logger = require("../utils/logger");
const { getSystemIntelligenceReport } = require("./systemIntelligence.service");
const { getWorldState } = require("./worldState.service");
const { getPortfolioTwinSnapshot } = require("./portfolioTwin.service");

/* =========================================================
   CONSTANTS  (tune here, no code changes needed)
========================================================= */

// SIS thresholds per gate
const SIS_AUTO_OPEN          = 40;   // minimum SIS for auto-open
const SIS_BROADER_DISCOVERY  = 50;   // minimum SIS for broader scan
const SIS_AGGRESSIVE_WEIGHTS = 65;   // minimum SIS for aggressive agent weighting
const SIS_SCALE_450          = 55;   // minimum SIS to unlock 450 scale
const SIS_SCALE_600          = 70;   // minimum SIS to unlock 600 scale
const SIS_CHINA_EXPANSION    = 60;   // minimum SIS for China segment
const SIS_EUROPE_EXPANSION   = 55;   // minimum SIS for Europe segment
const SIS_EXPANSION_READY    = 70;   // minimum SIS for recommendedMode=expansion-ready
const SIS_CONTROLLED         = 40;   // minimum SIS for recommendedMode=controlled

// Prediction layer minimum score for aggressive weights (out of max 25)
const MIN_PREDICTION_SCORE_AGGRESSIVE = 15;

// Drawdown limits per scale gate
const MAX_DRAWDOWN_SCALE_450  = 15;  // % max drawdown allowed for 450 scale
const MAX_DRAWDOWN_SCALE_600  = 10;  // % max drawdown allowed for 600 scale
const MAX_DRAWDOWN_AUTO_OPEN  = 20;  // % max drawdown allowed for auto-open

// Win rate minimum for 600 scale
const MIN_WIN_RATE_SCALE_600 = 0.5;

/* =========================================================
   GATE EVALUATOR  (single gate → { granted, reason })
========================================================= */

function _gate(granted, reason) {
  return { granted: Boolean(granted), reason: String(reason) };
}

function _evaluateGates(sis, layers, riskMode, drawdownPct, winRate, twinMaturityKey) {
  const predLayer    = layers.find((l) => l.id === "prediction")  || {};
  const learningLayer = layers.find((l) => l.id === "learning")   || {};
  const twinLayer    = layers.find((l) => l.id === "twin")        || {};

  const predScore    = predLayer.score    ?? 0;
  const learningOk   = learningLayer.status !== "inactive";
  const twinActive   = twinLayer.status   !== "inactive";

  const isRiskOff    = riskMode === "risk_off";
  const dd           = drawdownPct ?? 0;

  // ── allowAutoPositionOpen ───────────────────────────────────────────────
  const allowAutoPositionOpen = (() => {
    if (sis < SIS_AUTO_OPEN)
      return _gate(false, `SIS ${sis} < ${SIS_AUTO_OPEN} – System noch nicht reif genug`);
    if (isRiskOff)
      return _gate(false, "Risk-Mode ist risk_off – automatische Positionseröffnung gesperrt");
    if (dd > MAX_DRAWDOWN_AUTO_OPEN)
      return _gate(false, `Drawdown ${dd.toFixed(1)}% überschreitet Grenze ${MAX_DRAWDOWN_AUTO_OPEN}%`);
    return _gate(true, `SIS ${sis} ≥ ${SIS_AUTO_OPEN} · Risk-Mode ${riskMode} · Drawdown ${dd.toFixed(1)}% OK`);
  })();

  // ── allowBroaderDiscovery ───────────────────────────────────────────────
  const allowBroaderDiscovery = (() => {
    if (sis < SIS_BROADER_DISCOVERY)
      return _gate(false, `SIS ${sis} < ${SIS_BROADER_DISCOVERY} – Discovery bleibt im Kern-Universum`);
    if (isRiskOff)
      return _gate(false, "Risk-Mode ist risk_off – Discovery bleibt konservativ");
    return _gate(true, `SIS ${sis} ≥ ${SIS_BROADER_DISCOVERY} · Risk-Mode ${riskMode}`);
  })();

  // ── allowAggressiveWeights ──────────────────────────────────────────────
  const allowAggressiveWeights = (() => {
    if (sis < SIS_AGGRESSIVE_WEIGHTS)
      return _gate(false, `SIS ${sis} < ${SIS_AGGRESSIVE_WEIGHTS} – Gewichte bleiben konservativ`);
    if (predScore < MIN_PREDICTION_SCORE_AGGRESSIVE)
      return _gate(false, `Prediction-Score ${predScore} < ${MIN_PREDICTION_SCORE_AGGRESSIVE} – Genauigkeit noch unzureichend`);
    if (!learningOk)
      return _gate(false, "Adaptive Learning inaktiv – Causal-Memory muss zuerst Gewichte kalibrieren");
    return _gate(true, `SIS ${sis} · Prediction ${predScore} · Learning aktiv`);
  })();

  // ── allowScaleTo450 ─────────────────────────────────────────────────────
  const allowScaleTo450 = (() => {
    if (sis < SIS_SCALE_450)
      return _gate(false, `SIS ${sis} < ${SIS_SCALE_450} – Skalierung auf 450 gesperrt`);
    if (isRiskOff)
      return _gate(false, "Risk-Mode ist risk_off – Skalierung gesperrt");
    if (dd > MAX_DRAWDOWN_SCALE_450)
      return _gate(false, `Drawdown ${dd.toFixed(1)}% überschreitet Limit ${MAX_DRAWDOWN_SCALE_450}%`);
    return _gate(true, `SIS ${sis} ≥ ${SIS_SCALE_450} · Risk-Mode ${riskMode} · Drawdown ${dd.toFixed(1)}% OK`);
  })();

  // ── allowScaleTo600 ─────────────────────────────────────────────────────
  const allowScaleTo600 = (() => {
    if (sis < SIS_SCALE_600)
      return _gate(false, `SIS ${sis} < ${SIS_SCALE_600} – Skalierung auf 600 gesperrt`);
    if (riskMode !== "risk_on")
      return _gate(false, `Risk-Mode ${riskMode} – risk_on erforderlich für 600-Skalierung`);
    if (dd > MAX_DRAWDOWN_SCALE_600)
      return _gate(false, `Drawdown ${dd.toFixed(1)}% überschreitet Limit ${MAX_DRAWDOWN_SCALE_600}% für 600-Skalierung`);
    // winRate is null when no closed positions exist yet – skip the check in that case
    const winRateDisplay = winRate !== null
      ? `${Math.round(winRate * 100)}%`
      : "N/A (noch keine geschlossenen Positionen)";
    if (winRate !== null && winRate < MIN_WIN_RATE_SCALE_600)
      return _gate(false, `Win-Rate ${winRateDisplay} < ${MIN_WIN_RATE_SCALE_600 * 100}% – Portfolio-Performance unzureichend`);
    return _gate(true, `SIS ${sis} ≥ ${SIS_SCALE_600} · risk_on · Drawdown ${dd.toFixed(1)}% · Win-Rate ${winRateDisplay}`);
  })();

  // ── allowChinaExpansion ─────────────────────────────────────────────────
  const allowChinaExpansion = (() => {
    if (sis < SIS_CHINA_EXPANSION)
      return _gate(false, `SIS ${sis} < ${SIS_CHINA_EXPANSION} – China-Expansion gesperrt`);
    if (isRiskOff)
      return _gate(false, "Risk-Mode ist risk_off – regionale Expansion gesperrt");
    return _gate(true, `SIS ${sis} ≥ ${SIS_CHINA_EXPANSION} · Risk-Mode ${riskMode}`);
  })();

  // ── allowEuropeExpansion ─────────────────────────────────────────────────
  const allowEuropeExpansion = (() => {
    if (sis < SIS_EUROPE_EXPANSION)
      return _gate(false, `SIS ${sis} < ${SIS_EUROPE_EXPANSION} – Europa-Expansion gesperrt`);
    if (isRiskOff)
      return _gate(false, "Risk-Mode ist risk_off – regionale Expansion gesperrt");
    return _gate(true, `SIS ${sis} ≥ ${SIS_EUROPE_EXPANSION} · Risk-Mode ${riskMode}`);
  })();

  return {
    allowAutoPositionOpen,
    allowBroaderDiscovery,
    allowAggressiveWeights,
    allowScaleTo450,
    allowScaleTo600,
    allowChinaExpansion,
    allowEuropeExpansion,
  };
}

/* =========================================================
   RECOMMENDED MODE
========================================================= */

function _deriveRecommendedMode(sis, riskMode) {
  if (sis >= SIS_EXPANSION_READY && riskMode === "risk_on") {
    return {
      mode: "expansion-ready",
      label: "Expansionsbereit",
      color: "#10b981",
      description: "System reif und Markt günstig – kontrollierte Expansion möglich",
    };
  }
  if (sis >= SIS_CONTROLLED && riskMode !== "risk_off") {
    return {
      mode: "controlled",
      label: "Kontrolliert",
      color: "#3b82f6",
      description: "System entwickelt sich – konservativ-kontrollierter Betrieb empfohlen",
    };
  }
  return {
    mode: "conservative",
    label: "Konservativ",
    color: "#f59e0b",
    description: sis < SIS_CONTROLLED
      ? `SIS ${sis} zu niedrig für erweitertes Betriebsfenster`
      : "Risk-Mode ist risk_off – konservativer Betrieb aktiv",
  };
}

/* =========================================================
   CONTROL STATUS  (technisch / operativ / bewusst blockiert)
========================================================= */

function _buildControlStatus(gates) {
  const labels = {
    allowAutoPositionOpen:   "Automatische Positionseröffnung",
    allowBroaderDiscovery:   "Erweiterter Discovery-Scan",
    allowAggressiveWeights:  "Aggressive Agenten-Gewichtung",
    allowScaleTo450:         "Skalierung auf 450",
    allowScaleTo600:         "Skalierung auf 600",
    allowChinaExpansion:     "China-Segment",
    allowEuropeExpansion:    "Europa-Segment",
  };

  const technicallyPossible   = [];
  const operationallyReleased = [];
  const deliberatelyBlocked   = [];

  for (const [key, gate] of Object.entries(gates)) {
    const label = labels[key] || key;
    if (gate.granted) {
      operationallyReleased.push({ key, label, reason: gate.reason });
    } else {
      // All blocked flags are deterministically blocked (not randomly – always explainable)
      deliberatelyBlocked.push({ key, label, reason: gate.reason });
    }
    // All flags are always technically possible (no hard wiring)
    technicallyPossible.push({ key, label });
  }

  return { technicallyPossible, operationallyReleased, deliberatelyBlocked };
}

/* =========================================================
   BLOCKERS + NEXT STEP
========================================================= */

function _buildBlockersAndNextStep(gates, sis, riskMode, sisLayers) {
  const blockers = Object.entries(gates)
    .filter(([, g]) => !g.granted)
    .map(([key, g]) => ({ key, reason: g.reason }));

  let nextStep = "Alle Gates freigegeben – System in Expansionsbereitschaft prüfen.";

  if (riskMode === "risk_off") {
    nextStep = "Risk-Mode auf risk_off – auf Marktberuhigung warten oder Regime-Schwellwerte überprüfen.";
  } else if (sis < SIS_AUTO_OPEN) {
    nextStep = `SIS liegt bei ${sis}. Mindestens ${SIS_AUTO_OPEN} Punkte für Auto-Open nötig. ` +
      "Prediction-Qualität und Guardian-Eingriffe erhöhen.";
  } else if (sis < SIS_BROADER_DISCOVERY) {
    nextStep = `SIS liegt bei ${sis}. ${SIS_BROADER_DISCOVERY} Punkte für breiten Discovery-Scan. ` +
      "Mehr verifizierte Forecasts und Pattern-Memory-Einträge sammeln.";
  } else if (sis < SIS_SCALE_450) {
    nextStep = `SIS liegt bei ${sis}. ${SIS_SCALE_450} Punkte für Skalierung auf 450. ` +
      "Adaptive Learning aktivieren und Outcome-Tracking befüllen.";
  } else if (sis < SIS_CHINA_EXPANSION) {
    nextStep = `SIS liegt bei ${sis}. ${SIS_CHINA_EXPANSION} Punkte für China-Expansion. ` +
      "Weitere verifizierte Outcomes und höhere Agent-Genauigkeit erforderlich.";
  } else if (sis < SIS_AGGRESSIVE_WEIGHTS) {
    nextStep = `SIS liegt bei ${sis}. ${SIS_AGGRESSIVE_WEIGHTS} Punkte für aggressive Gewichtung. ` +
      "Causal-Memory muss mindestens 3 verifizierte Forecasts pro Agent akkumuliert haben.";
  } else if (sis < SIS_SCALE_600) {
    nextStep = `SIS liegt bei ${sis}. ${SIS_SCALE_600} Punkte für 600-Skalierung. ` +
      "Portfolio-Win-Rate ≥ 50% und risk_on Marktbedingungen erforderlich.";
  } else {
    // SIS is high enough – check layer-specific next steps
    const weakLayer = sisLayers
      .filter((l) => l.status !== "healthy")
      .sort((a, b) => (b.max - b.score) - (a.max - a.score))[0];
    if (weakLayer) {
      nextStep = `Layer '${weakLayer.label}' kann noch verbessert werden (${weakLayer.score}/${weakLayer.max} Pkt). ` +
        "Damit wäre SIS-Reife für Stage 4 / Advanced Twin vorbereitet.";
    }
  }

  return { biggestBlockers: blockers, nextStep };
}

/* =========================================================
   MAIN FUNCTION
========================================================= */

/**
 * Derives a full operational release status from existing system intelligence,
 * world state, and portfolio twin data.
 *
 * Pure derivation – no DB writes, no external API calls.
 *
 * @returns {Promise<object>}
 */
async function getOperationalReleaseStatus() {
  // ── Fetch all inputs in parallel ─────────────────────────────────────────
  const [sisReport, worldState, twinSnapshot] = await Promise.all([
    getSystemIntelligenceReport().catch((err) => {
      logger.warn("sisReleaseControl: getSystemIntelligenceReport failed", { message: err.message });
      return { sis: 0, layers: [], maturity: { key: "emerging", label: "Fehler", color: "#ef4444" } };
    }),
    getWorldState().catch((err) => {
      logger.warn("sisReleaseControl: getWorldState failed", { message: err.message });
      return { risk_mode: "risk_off", uncertainty: 1, regime: { cluster: "Danger" } };
    }),
    getPortfolioTwinSnapshot({ limit: 200 }).catch((err) => {
      logger.warn("sisReleaseControl: getPortfolioTwinSnapshot failed", { message: err.message });
      return { maxDrawdownPct: null, winRate: null, twinMaturity: { key: "uninitialized" } };
    }),
  ]);

  const sis         = sisReport.sis        ?? 0;
  const layers      = sisReport.layers     ?? [];
  const riskMode    = worldState.risk_mode ?? "risk_off";
  const drawdownPct = twinSnapshot.maxDrawdownPct ?? 0;
  const winRate     = twinSnapshot.winRate        ?? null;
  const twinMatKey  = twinSnapshot.twinMaturity?.key ?? "uninitialized";

  // ── Evaluate gates ────────────────────────────────────────────────────────
  const gates = _evaluateGates(sis, layers, riskMode, drawdownPct, winRate, twinMatKey);

  // ── Recommended mode ──────────────────────────────────────────────────────
  const recommendedMode = _deriveRecommendedMode(sis, riskMode);

  // ── Control status (technical / operational / blocked) ────────────────────
  const controlStatus = _buildControlStatus(gates);

  // ── Blockers + next step ──────────────────────────────────────────────────
  const { biggestBlockers, nextStep } = _buildBlockersAndNextStep(gates, sis, riskMode, layers);

  const grantedCount = Object.values(gates).filter((g) => g.granted).length;
  const blockerCount = Object.values(gates).length - grantedCount;

  return {
    sis,
    riskMode,
    recommendedMode,
    ...gates,
    controlStatus,
    biggestBlockers,
    nextStep,
    grantedCount,
    blockerCount,
    generatedAt: new Date().toISOString(),
  };
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  getOperationalReleaseStatus,
};
