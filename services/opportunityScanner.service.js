"use strict";

const { Pool } = require("pg");
const logger = require("../utils/logger");

const {
  buildScoringNewsContext,
  getScoringActiveMarketNewsBySymbols,
} = require("./marketNews.service");
const {
  loadLatestOutcomeTrackingBySymbols,
  buildStructuredPatternSignature,
  getPatternStats,
  computeRecommendationOutcomeBySymbols, // ✅ Step 6: adaptive signal hook
} = require("./outcomeTracking.repository");
const {
  loadRuntimeState,
  RUNTIME_STATE_MARKET_MEMORY_KEY,
  RUNTIME_STATE_META_LEARNING_KEY,
} = require("./discoveryLearning.repository");
const { buildMarketSentiment } = require("./marketSentiment.service");
const { buildMarketBuzz } = require("./marketBuzz.service");
const { buildTrendingStock } = require("./trendingStocks.service");
const { buildEarlySignals } = require("./earlySignal.service");
const { classifyMarketRegime } = require("./regimeDetection.service");
const { recordAutonomyDecision, logNearMiss } = require("./autonomyAudit.repository");
const { runAgenticDebate } = require("./agenticDebate.service");
const { getInterMarketCorrelation } = require("./interMarketCorrelation.service");
const { logAgentForecasts } = require("./agentForecast.repository");
const { getAgentWeights, buildMetaRationale } = require("./causalMemory.repository");
const { getSharpenedThresholds } = require("./sectorCoherence.service");
// World State: unified global market truth (regime + cross-asset + sector + agents)
const { getWorldState, classifyWorldStateAge } = require("./worldState.service");
// Capital Allocation Layer: position sizing, risk-budget, sector caps
const { applyCapitalAllocation } = require("./capitalAllocation.service");
// Portfolio Twin: virtual position tracking (Stage 2 – auto live-integration)
const {
  hasOpenVirtualPosition,
  openVirtualPositionFromAllocation,
} = require("./portfolioTwin.service");
// Step 4: Personalized Decision Layer – portfolio/watchlist context per symbol
const {
  buildPortfolioContextForSymbols,
  enrichWithPortfolioContext,
} = require("./portfolioContext.service");
// Step 5: User attention level – derived from portfolio/delta/action signals
const { computeUserAttentionLevel } = require("./notifications.repository");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =========================================================
   IN-MEMORY PREVIEW STORES
========================================================= */

let marketMemoryStore = {};
let metaLearningStore = {};
let runtimePreviewStoresLoaded = false;
const OPPORTUNITY_NEWS_LIMIT = Math.max(
  1,
  Math.min(Number(process.env.OPPORTUNITY_NEWS_LIMIT || 5), 10)
);
const OPPORTUNITY_REASON_LIMIT = 4;
const SIGNAL_REASON_LIMIT = 4;
const SIGNAL_DIRECTION_THRESHOLD = 0.12;

/* =========================================================
   GUARDIAN PROTOCOL CONSTANTS
========================================================= */

// Base robustness thresholds per market cluster (executeSafetyFirst)
const GUARDIAN_THRESHOLD_SAFE = Number(
  process.env.GUARDIAN_THRESHOLD_SAFE || 0.35
);
const GUARDIAN_THRESHOLD_VOLATILE = Number(
  process.env.GUARDIAN_THRESHOLD_VOLATILE || 0.50
);
const GUARDIAN_THRESHOLD_DANGER = Number(
  process.env.GUARDIAN_THRESHOLD_DANGER || 0.65
);

/* =========================================================
   UTIL
========================================================= */

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeObject(value, fallback = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }

  try {
    if (typeof structuredClone === "function") {
      return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return fallback;
  }
}

/**
 * Returns a small sort-score adjustment for a candidate based on its
 * portfolio intelligence context.  Diversifiers get a gentle boost;
 * candidates that would increase concentration risk get a gentle penalty.
 * The delta is kept small (±5) so conviction/confidence remain dominant.
 *
 * @param {object|null} ctx  – portfolioContext from enrichWithPortfolioContext
 * @returns {number}  adjustment to add to the effective conviction score
 */
const PORTFOLIO_DIVERSIFICATION_BONUS    =  3;
const PORTFOLIO_HIGH_CONCENTRATION_PENALTY = -5;
const PORTFOLIO_MED_CONCENTRATION_PENALTY  = -2;

function _portfolioIntelligenceBonus(ctx) {
  if (!ctx) return 0;
  let bonus = 0;
  if (ctx.diversificationBenefit) bonus += PORTFOLIO_DIVERSIFICATION_BONUS;
  if (ctx.concentrationRisk === "high")   bonus += PORTFOLIO_HIGH_CONCENTRATION_PENALTY;
  else if (ctx.concentrationRisk === "medium") bonus += PORTFOLIO_MED_CONCENTRATION_PENALTY;
  return bonus;
}

// ── Delta/Change Context ──────────────────────────────────────────────────────
// Small sort-score adjustment based on delta priority.
// Elevated signals get a gentle nudge up; degraded signals get a nudge down.
// Kept small (±3) so conviction/portfolio bonuses stay dominant.
const DELTA_ELEVATED_BONUS   =  2;
const DELTA_DEGRADED_PENALTY = -3;

function _deltaPriorityBonus(deltaCtx) {
  if (!deltaCtx) return 0;
  if (deltaCtx.deltaPriority === "elevated") return DELTA_ELEVATED_BONUS;
  if (deltaCtx.deltaPriority === "degraded") return DELTA_DEGRADED_PENALTY;
  return 0;
}

// ── User Affinity Bonus (Step 6 Block 2) ─────────────────────────────────────
// Applies a light per-user preference adjustment to the sort score.
// Kept minimal (±2) so conviction/portfolio/delta factors stay dominant.
// Only applied when userPreferenceHints are explicitly passed in by the caller.
const USER_AFFINITY_BONUS   =  2;
const USER_AFFINITY_PENALTY = -2;

/**
 * Returns a small sort-score adjustment (±2) based on per-user preference hints.
 * - risk_averse users: boost reduce_risk / avoid_adding actions
 * - opportunity_seeker users: boost starter_position / watchlist_upgrade actions
 * No change for neutral, missing, or unmatched combinations.
 *
 * @param {object}      opp   – opportunity with nextAction attached
 * @param {object|null} hints – computeUserPreferenceHints() result
 * @returns {number}
 */
function _userAffinityBonus(opp, hints) {
  if (!hints || !hints.riskSensitivity) return 0;
  const actionType = opp.nextAction?.actionType || null;
  if (!actionType) return 0;
  const RISK_ACTIONS = ["reduce_risk", "avoid_adding"];
  const OPP_ACTIONS  = ["starter_position", "watchlist_upgrade", "rebalance_review"];
  // Pure opportunity actions (excludes rebalance_review which is portfolio maintenance,
  // not penalized for risk-averse users).
  const OPP_PUSH_ACTIONS = ["starter_position", "watchlist_upgrade"];
  if (hints.riskSensitivity === "risk_averse" && RISK_ACTIONS.includes(actionType)) {
    return USER_AFFINITY_BONUS;
  }
  if (hints.riskSensitivity === "opportunity_seeker" && OPP_ACTIONS.includes(actionType)) {
    return USER_AFFINITY_BONUS;
  }
  // Gentle counter-signal: risk_averse user sees a pure buy-side signal → slight nudge down.
  // rebalance_review is excluded: portfolio maintenance is neutral for all risk profiles.
  if (hints.riskSensitivity === "risk_averse" && OPP_PUSH_ACTIONS.includes(actionType)) {
    return USER_AFFINITY_PENALTY;
  }
  return 0;
}

// ── Adaptive Priority Layer (Step 6 Block 4 – with Guardrails) ───────────────
// Combines userPreferenceHints, adaptiveSignalHints, deltaContext, nextAction
// and actionOrchestration into a transparent, small per-opportunity priority
// adjustment. Supersedes the simpler _userAffinityBonus in the sort (±2→±3).
// All signal contributions are traceable via adaptivePriorityReason.
// Only applied when userPreferenceHints are passed in and sampleSize ≥ 3.
//
// Guardrails (Block 4):
//   • Critical-attention opportunities are NEVER demoted by adaptive signals.
//   • Risk/reduce signals (reduce_risk, avoid_adding, risk_increased) are
//     NEVER penalised by notificationFatigue – user safety > delivery comfort.
//   • Boost/penalty is hard-capped at ±3; any raw overflow is surfaced as
//     guardrailApplied so callers can trace the clipping.
const ADAPTIVE_BOOST_MAX =  3;
const ADAPTIVE_BOOST_MIN = -3;

/**
 * Computes a transparent adaptive priority adjustment for one opportunity.
 * Called after the full opportunity is assembled (adaptiveSignalHints,
 * nextAction, deltaContext, actionOrchestration all attached).
 *
 * Signal contributions (capped at ±3 total):
 *   riskSensitivity=risk_averse  + risk-type change/action      → +2
 *   explorationAffinity=high     + new_signal/gaining_relevance  → +2
 *   riskSensitivity=opportunity_seeker + elevated buy signal     → +1
 *   outcomeSuccessRate ≥ 0.6 (≥3 evaluated outcomes)            → +1
 *   outcomeSuccessRate < 0.3 (≥5 evaluated outcomes)            → -1
 *   notificationFatigue=high     + push-type delivery            → -1
 *     (BLOCKED for risk/critical signals – guardrail)
 *
 * @param {object}      opp   – fully enriched opportunity
 * @param {object|null} hints – computeUserPreferenceHints() result
 * @returns {{ adaptivePriorityBoost: number, adaptivePriorityReason: string|null,
 *             deliveryPreferenceFit: string, adjustedRecommendationPriority: string,
 *             guardrailApplied: string|null }}
 */
function _computeAdaptivePriorityLayer(opp, hints) {
  const baseAttn = opp.userAttentionLevel || "low";
  const noChange = {
    adaptivePriorityBoost: 0,
    adaptivePriorityReason: null,
    deliveryPreferenceFit: "unknown",
    adjustedRecommendationPriority: baseAttn,
    guardrailApplied: null,
  };
  if (!hints || (hints.sampleSize || 0) < 3) return noChange;

  let boost = 0;
  const reasons = [];
  let guardrailApplied = null;

  const actionType    = opp.nextAction?.actionType     || null;
  const changeType    = opp.deltaContext?.changeType    || "stable";
  const deltaPriority = opp.deltaContext?.deltaPriority || "stable";
  const deliveryMode  = opp.actionOrchestration?.deliveryMode || null;
  const sh            = opp.adaptiveSignalHints         || {};

  // Guardrail: is this a risk-critical signal that must stay dominant?
  // Risk actions and explicit risk-increase signals are never suppressed by
  // preference signals – user safety and governance take priority.
  const isRiskCriticalSignal = (
    baseAttn === "critical" ||
    changeType === "risk_increased" ||
    actionType === "reduce_risk" ||
    actionType === "avoid_adding"
  );

  // Signal 1: risk-averse user + risk-type signal → boost risk/reduce signals
  if (hints.riskSensitivity === "risk_averse") {
    if (changeType === "risk_increased" ||
        actionType === "reduce_risk" ||
        actionType === "avoid_adding") {
      boost += 2;
      reasons.push("riskAverse+riskSignal");
    }
  }

  // Signal 2: exploration-affinity user + new/gaining signal → boost discovery
  if (hints.explorationAffinity === "high") {
    if (changeType === "new_signal" || changeType === "gaining_relevance") {
      boost += 2;
      reasons.push("explorationAffinity+newSignal");
    }
  }

  // Signal 3: opportunity seeker + elevated buy signal → small additional boost
  if (hints.riskSensitivity === "opportunity_seeker") {
    if ((actionType === "starter_position" || actionType === "watchlist_upgrade") &&
        deltaPriority === "elevated") {
      boost += 1;
      reasons.push("opportunitySeeker+elevatedSignal");
    }
  }

  // Signal 4: outcome track-record quality (only when ≥3 recorded outcomes)
  if (sh.outcomeDataAvailable && (sh.outcomeSampleSize || 0) >= 3) {
    const sr = sh.successRate ?? null;
    if (sr !== null && sr >= 0.6) {
      boost += 1;
      reasons.push("highSuccessRate");
    } else if (sr !== null && sr < 0.3 && (sh.outcomeSampleSize || 0) >= 5) {
      boost -= 1;
      reasons.push("lowSuccessRate");
    }
  }

  // Signal 5: notification fatigue → reduce push pressure for non-critical delivery.
  // GUARDRAIL: fatigue never suppresses risk/critical signals. User safety > delivery comfort.
  if (hints.notificationFatigue === "high" &&
      deliveryMode &&
      deliveryMode !== "passive_briefing" &&
      deliveryMode !== "none") {
    if (isRiskCriticalSignal) {
      // Blocked – risk/critical topics must reach the user regardless of fatigue.
      // Reason key uses "notificationFatigue-guardrail" to distinguish from
      // the normal "notificationFatigue" penalty; both are traceable in ADAPTIVE_REASON_LABELS.
      reasons.push("notificationFatigue-guardrail");
      guardrailApplied = guardrailApplied || "fatigue-suppression-blocked:risk-critical";
    } else {
      boost -= 1;
      reasons.push("notificationFatigue");
    }
  }

  // Clamp to ±3 and record if the raw value was clipped.
  const rawBoost = boost;
  const adaptivePriorityBoost = Math.max(
    ADAPTIVE_BOOST_MIN,
    Math.min(ADAPTIVE_BOOST_MAX, rawBoost)
  );
  if (rawBoost !== adaptivePriorityBoost) {
    guardrailApplied = guardrailApplied
      || `boost-cap(raw=${rawBoost},capped=${adaptivePriorityBoost})`;
  }

  // deliveryPreferenceFit: does the delivery mode match the user's historical preference?
  let deliveryPreferenceFit = "neutral";
  if (hints.preferredDeliveryMode && deliveryMode) {
    if (deliveryMode === hints.preferredDeliveryMode ||
        (hints.briefingAffinity === "high" && deliveryMode.includes("briefing"))) {
      deliveryPreferenceFit = "high";
    } else if (hints.notificationFatigue === "high" && deliveryMode === "notification") {
      deliveryPreferenceFit = "low";
    }
  }

  // adjustedRecommendationPriority: apply boost to attention level (one tier max).
  // Capped at "high" (index 2): "critical" is reserved for base-signal strength only,
  // never created through adaptive boosting alone.
  // GUARDRAIL: critical items are NEVER demoted – adaptive layer is purely additive for them.
  const ATTN_TIERS = ["low", "medium", "high", "critical"];
  const baseIdx    = ATTN_TIERS.indexOf(baseAttn);
  let adjIdx       = baseIdx >= 0 ? baseIdx : 0;
  if (adaptivePriorityBoost >= 2 && adjIdx < 2) adjIdx = Math.min(adjIdx + 1, 2); // cap at "high"
  if (adaptivePriorityBoost <= -2 && adjIdx > 0 && baseAttn !== "critical") {
    adjIdx = Math.max(adjIdx - 1, 0);
  } else if (adaptivePriorityBoost <= -2 && baseAttn === "critical") {
    guardrailApplied = guardrailApplied || "critical-demotion-blocked";
  }
  const adjustedRecommendationPriority = ATTN_TIERS[adjIdx];

  return {
    adaptivePriorityBoost,
    adaptivePriorityReason: reasons.length > 0 ? reasons.join("+") : null,
    deliveryPreferenceFit,
    adjustedRecommendationPriority,
    guardrailApplied,
  };
}

/**
 * Compute delta/change context for an opportunity.
 *
 * Compares the freshly computed raw market score (_rawScore, from current
 * market snapshot data) to the last stored conviction value (from
 * outcome_tracking).  Uses only already-loaded data – no extra DB calls.
 *
 * @param {object}      opp     – enriched opportunity (portfolioContext present)
 * @param {object|null} tracked – persisted outcome record for this symbol
 * @returns {object}  deltaContext
 */
function computeDeltaContext(opp, tracked) {
  const rawScore      = safeNum(opp._rawScore, safeNum(opp.hqsScore, 0));
  const prevConviction = tracked ? safeNum(tracked.finalConviction, 0) : null;
  const hasHistory    = prevConviction !== null && prevConviction > 0;
  const convictionDelta = hasHistory ? rawScore - prevConviction : 0;

  const portfolioRole      = opp.portfolioContext?.portfolioRole      || "unknown";
  const concentrationRisk  = opp.portfolioContext?.concentrationRisk  || "none";
  const robustness         = safeNum(opp.robustnessScore, 0);
  const signalDir          = opp.signalContext?.signalDirection        || "neutral";
  const earlySignal        = opp.signalContext?.earlySignalType        || null;

  // NEW: first appearance in the scanner (no prior outcome_tracking record).
  // Use _rawScore consistently (same source as the convictionDelta comparison).
  const newToWatch = !hasHistory && rawScore >= 50;

  // GAINING RELEVANCE: raw market score noticeably above last stored conviction,
  // or bullish signal with early-signal indicator when no prior history.
  const becameMoreRelevant = hasHistory
    ? convictionDelta >= 5
    : (signalDir === "bullish" && earlySignal != null);

  // LOST CONVICTION: raw score fell below stored conviction, or bearish signal.
  const lostConviction = hasHistory
    ? convictionDelta <= -5
    : signalDir === "bearish";

  // BECAME RISKIER: concentration already critical, or score dropped + low robustness.
  const becameRiskier = concentrationRisk === "high" ||
    (hasHistory && convictionDelta <= -3 && robustness < 0.45);

  // PORTFOLIO IMPACT CHANGED: watchlist symbol now showing meaningful momentum.
  // Uses a lower threshold (3 vs 5) than becameMoreRelevant because complement
  // symbols need less lift to warrant attention.  changeType priority (line 195)
  // ensures becameMoreRelevant wins when both flags fire simultaneously.
  const portfolioImpactChanged = portfolioRole === "complement" &&
    (hasHistory ? convictionDelta >= 3 : signalDir === "bullish");

  // ── changeType: single most important signal ─────────────────────────────
  let changeType = "stable";
  if      (newToWatch)            changeType = "new_signal";
  else if (becameMoreRelevant)    changeType = "gaining_relevance";
  else if (becameRiskier)         changeType = "risk_increased";
  else if (lostConviction)        changeType = "losing_conviction";
  else if (portfolioImpactChanged) changeType = "portfolio_impact_changed";

  // ── deltaPriority: frontend badge tier ───────────────────────────────────
  let deltaPriority = "stable";
  if (changeType === "new_signal" || changeType === "gaining_relevance" || changeType === "portfolio_impact_changed") {
    deltaPriority = "elevated";
  } else if (changeType === "risk_increased") {
    deltaPriority = "caution";
  } else if (changeType === "losing_conviction") {
    deltaPriority = "degraded";
  }

  return {
    changeType,
    deltaPriority,
    becameMoreRelevant,
    becameRiskier,
    newToWatch,
    lostConviction,
    portfolioImpactChanged,
    _convictionDelta: hasHistory ? Number(convictionDelta.toFixed(1)) : null,
  };
}

/**
 * Derive a concrete next action from delta, portfolio and conviction signals.
 *
 * Uses only already-computed inputs – no extra DB calls.
 * Rules are intentionally simple, defensive and traceable:
 *   first match wins; order reflects risk-priority (protect before grow).
 *
 * @param {object} opp – opportunity enriched with portfolioContext and deltaContext
 * @returns {{ actionType, actionPriority, actionReason, nextActionLabel }}
 */
function computeNextAction(opp) {
  const fallbackScore    = safeNum(opp.hqsScore, 0);
  const conviction       = safeNum(opp.finalConviction, fallbackScore);
  const pCtx             = opp.portfolioContext || {};
  const dCtx             = opp.deltaContext     || {};

  const alreadyOwned       = Boolean(pCtx.alreadyOwned);
  const concentrationRisk  = pCtx.concentrationRisk  || "none";
  const diversification    = Boolean(pCtx.diversificationBenefit);
  const portfolioPriority  = pCtx.portfolioPriority  || "medium";

  const becameRiskier      = Boolean(dCtx.becameRiskier);
  const lostConviction     = Boolean(dCtx.lostConviction);
  const newToWatch         = Boolean(dCtx.newToWatch);
  const becameMoreRelevant = Boolean(dCtx.becameMoreRelevant);
  const deltaPriority      = dCtx.deltaPriority || "stable";

  // ── Rule table (first match wins) ────────────────────────────────────────
  // R1: existing position + high concentration + became riskier → reduce risk
  if (alreadyOwned && concentrationRisk === "high" && becameRiskier) {
    return {
      actionType:      "reduce_risk",
      actionPriority:  "high",
      actionReason:    "Bestehende Position bei hohem Konzentrationsrisiko und gestiegenem Risiko",
      nextActionLabel: "Risiko reduzieren",
    };
  }

  // R2: existing position + high concentration (no becameRiskier needed) → avoid adding
  if (alreadyOwned && concentrationRisk === "high") {
    return {
      actionType:      "avoid_adding",
      actionPriority:  "medium",
      actionReason:    "Konzentrationsrisiko bereits hoch – keine weitere Aufstockung empfohlen",
      nextActionLabel: "Nicht aufstocken",
    };
  }

  // R3: existing position lost conviction → rebalance review
  if (alreadyOwned && lostConviction) {
    return {
      actionType:      "rebalance_review",
      actionPriority:  "medium",
      actionReason:    "Conviction gesunken – Rebalancing-Prüfung empfohlen",
      nextActionLabel: "Rebalancing prüfen",
    };
  }

  // R4: not owned + high conviction + diversification + gaining/new → starter position
  if (!alreadyOwned && conviction >= 70 && diversification && (newToWatch || becameMoreRelevant)) {
    return {
      actionType:      "starter_position",
      actionPriority:  "high",
      actionReason:    "Hohe Conviction, Diversifikationsmehrwert und steigende Relevanz",
      nextActionLabel: "Einstiegsposition prüfen",
    };
  }

  // R5: not owned + decent conviction + high portfolio priority or new signal → watchlist upgrade
  if (!alreadyOwned && conviction >= 65 && (portfolioPriority === "high" || newToWatch)) {
    return {
      actionType:      "watchlist_upgrade",
      actionPriority:  "medium",
      actionReason:    "Gutes Signal mit hoher Portfoliopriorität – Watchlist-Aufnahme empfohlen",
      nextActionLabel: "Watchlist aufwerten",
    };
  }

  // R6: lost conviction (not owned) or degraded delta → observe
  if (lostConviction || deltaPriority === "degraded") {
    return {
      actionType:      "observe",
      actionPriority:  "low",
      actionReason:    "Conviction gesunken – nur beobachten",
      nextActionLabel: "Beobachten",
    };
  }

  // R7: stable signal, already owned → hold
  if (alreadyOwned && deltaPriority === "stable") {
    return {
      actionType:      "hold",
      actionPriority:  "low",
      actionReason:    "Stabiles Signal ohne klare Änderung",
      nextActionLabel: "Halten",
    };
  }

  // R8: fallback – observe
  return {
    actionType:      "observe",
    actionPriority:  "low",
    actionReason:    "Kein klares Handlungssignal – weiter beobachten",
    nextActionLabel: "Beobachten",
  };
}

/**
 * Step 5 – Action-Orchestration Layer
 *
 * Derives HOW the system should treat this opportunity for the user:
 * notification, briefing, follow-up, escalation, or passive observation.
 *
 * Uses only already-computed signals – no extra DB calls.
 * Rules are simple, transparent, and trace back to a single most-important driver.
 * First match wins (priority order: protect first, then grow, then observe).
 *
 * @param {object} opp – opportunity enriched with userAttentionLevel, nextAction, deltaContext
 * @returns {{
 *   actionFlowStage:  'escalate'|'notify'|'brief'|'observe'|'none',
 *   deliveryMode:     'briefing_and_notification'|'notification'|'briefing'|'passive_briefing'|'none',
 *   escalationLevel:  'high'|'medium'|'low'|'none',
 *   followUpNeeded:   boolean,
 *   followUpReason:   string|null,
 *   reviewWindow:     'immediate'|'short'|'medium'|'long'|null,
 * }}
 */
function computeActionOrchestration(opp) {
  const attentionLevel = opp.userAttentionLevel || "low";
  const actionType     = opp.nextAction?.actionType     || "observe";
  const deltaPriority  = opp.deltaContext?.deltaPriority || "stable";

  // ── Rule table (first match wins) ────────────────────────────────────────

  // O1: critical + reduce_risk → immediate escalation, full dual-channel push
  if (attentionLevel === "critical" && actionType === "reduce_risk") {
    return {
      actionFlowStage: "escalate",
      deliveryMode:    "briefing_and_notification",
      escalationLevel: "high",
      followUpNeeded:  true,
      followUpReason:  "Kritisches Konzentrationsrisiko – sofortige Überprüfung empfohlen",
      reviewWindow:    "immediate",
    };
  }

  // O2: high attention + reduce_risk → escalate, dual push
  if (attentionLevel === "high" && actionType === "reduce_risk") {
    return {
      actionFlowStage: "escalate",
      deliveryMode:    "briefing_and_notification",
      escalationLevel: "high",
      followUpNeeded:  true,
      followUpReason:  "Risikoreduktion empfohlen – Positionsüberprüfung nötig",
      reviewWindow:    "immediate",
    };
  }

  // O3: high attention + starter_position → push notification, follow-up needed
  if (attentionLevel === "high" && actionType === "starter_position") {
    return {
      actionFlowStage: "notify",
      deliveryMode:    "notification",
      escalationLevel: "medium",
      followUpNeeded:  true,
      followUpReason:  "Einstiegsgelegenheit – Entscheidung innerhalb kurzer Zeit empfohlen",
      reviewWindow:    "short",
    };
  }

  // O4: high attention + rebalance_review → brief + follow-up
  if (attentionLevel === "high" && actionType === "rebalance_review") {
    return {
      actionFlowStage: "notify",
      deliveryMode:    "notification",
      escalationLevel: "medium",
      followUpNeeded:  true,
      followUpReason:  "Rebalancing-Prüfung empfohlen",
      reviewWindow:    "short",
    };
  }

  // O5: medium attention + watchlist_upgrade → briefing, no immediate follow-up
  if (attentionLevel === "medium" && actionType === "watchlist_upgrade") {
    return {
      actionFlowStage: "brief",
      deliveryMode:    "briefing",
      escalationLevel: "low",
      followUpNeeded:  false,
      followUpReason:  null,
      reviewWindow:    "medium",
    };
  }

  // O6: degraded delta + observe → passive briefing, short follow-up window
  if (deltaPriority === "degraded" && actionType === "observe") {
    return {
      actionFlowStage: "observe",
      deliveryMode:    "passive_briefing",
      escalationLevel: "none",
      followUpNeeded:  true,
      followUpReason:  "Sinkende Überzeugung – erneute Prüfung kurzfristig empfohlen",
      reviewWindow:    "short",
    };
  }

  // O7: stable delta + hold → passive briefing, long window
  if (deltaPriority === "stable" && actionType === "hold") {
    return {
      actionFlowStage: "observe",
      deliveryMode:    "passive_briefing",
      escalationLevel: "none",
      followUpNeeded:  false,
      followUpReason:  null,
      reviewWindow:    "long",
    };
  }

  // O8: any remaining high attention → notify
  if (attentionLevel === "high") {
    return {
      actionFlowStage: "notify",
      deliveryMode:    "notification",
      escalationLevel: "medium",
      followUpNeeded:  false,
      followUpReason:  null,
      reviewWindow:    "short",
    };
  }

  // O9: medium attention → briefing
  if (attentionLevel === "medium") {
    return {
      actionFlowStage: "brief",
      deliveryMode:    "briefing",
      escalationLevel: "low",
      followUpNeeded:  false,
      followUpReason:  null,
      reviewWindow:    "medium",
    };
  }

  // O10: low attention / no signal → no active delivery
  return {
    actionFlowStage: "observe",
    deliveryMode:    "none",
    escalationLevel: "none",
    followUpNeeded:  false,
    followUpReason:  null,
    reviewWindow:    null,
  };
}

/* =========================================================
   STEP 7 BLOCK 1: ACTION-READINESS & APPROVAL LAYER
   Classifies each opportunity into a controlled action tier.
   Uses only already-computed signals. No DB calls. No automation.
   Rules are simple, explicit, and governance-compatible.
   First match wins (protect before grow before observe).
=========================================================== */

/**
 * Derive the action-readiness tier for an opportunity.
 *
 * @param {object} opp – fully enriched opportunity (nextAction, deltaContext,
 *                       actionOrchestration, portfolioContext, robustnessScore,
 *                       signalContext, userAttentionLevel all expected)
 * @returns {{
 *   actionReadiness:    'review_required'|'proposal_ready'|'monitor_only'|'insufficient_confidence',
 *   approvalRequired:   boolean,
 *   approvalReason:     string|null,
 *   executionScope:     'position'|'watchlist'|'portfolio_review'|'observation',
 *   actionSafetyLevel:  'safe'|'caution'|'restricted',
 *   automationEligible: false,
 * }}
 */
function computeActionReadiness(opp) {
  const actionType     = opp.nextAction?.actionType     || "observe";
  const actionPriority = opp.nextAction?.actionPriority || "low";
  const attention      = opp.userAttentionLevel          || "low";
  const escalation     = opp.actionOrchestration?.escalationLevel || "none";
  const robustness     = safeNum(opp.robustnessScore, 0);
  const signalConf = opp.signalContext
    ? safeNum(opp.signalContext.signalConfidence, 0)  // absent signalConfidence within existing context is treated conservatively (0)
    : null; // no signal context at all → skip the confidence gate (robustness guard is sufficient)
  const portfolioCtx   = opp.portfolioContext || {};

  // AR-0: insufficient confidence guard – robustness or signal basis too thin
  // Checked before action-type rules so bad data never generates a false proposal.
  // signalConf gate only fires when signal context exists (null means context absent, not poor quality).
  if (robustness < 0.30 || (signalConf !== null && signalConf < 35)) {
    return {
      actionReadiness:    "insufficient_confidence",
      approvalRequired:   false,
      approvalReason:     "Datenbasis zu gering für Handlungsempfehlung – Signal noch nicht reif",
      executionScope:     "observation",
      actionSafetyLevel:  "caution",
      automationEligible: false,
    };
  }

  // AR-1: critical/risk/escalation signals → human approval required
  if (
    actionType === "reduce_risk" ||
    (actionType === "avoid_adding" && portfolioCtx.concentrationRisk === "high") ||
    attention === "critical" ||
    escalation === "high"
  ) {
    const parts = [];
    if (actionType === "reduce_risk") parts.push("Risikoreduktion bei bestehender Position");
    if (portfolioCtx.concentrationRisk === "high") parts.push("hohes Konzentrationsrisiko");
    if (attention === "critical") parts.push("kritischer Aufmerksamkeitslevel");
    // Include escalation reason alongside the others (not mutually exclusive)
    if (escalation === "high") parts.push("hohe Eskalationsstufe");
    return {
      actionReadiness:    "review_required",
      approvalRequired:   true,
      approvalReason:     parts.join(" · ") || "Risikobasierte Aktion erfordert manuelle Freigabe",
      executionScope:     actionType === "reduce_risk" ? "position" : "portfolio_review",
      actionSafetyLevel:  "restricted",
      automationEligible: false,
    };
  }

  // AR-2: rebalance review → portfolio change needs approval
  if (actionType === "rebalance_review") {
    return {
      actionReadiness:    "review_required",
      approvalRequired:   true,
      approvalReason:     "Rebalancing-Prüfung erfordert manuelle Überprüfung der Portfolioposition",
      executionScope:     "portfolio_review",
      actionSafetyLevel:  "caution",
      automationEligible: false,
    };
  }

  // AR-3: clear buy/upgrade at non-critical profile → structured proposal, no auto-execution
  if (
    (actionType === "starter_position" || actionType === "watchlist_upgrade") &&
    portfolioCtx.concentrationRisk !== "high" &&
    actionPriority !== "low"
  ) {
    return {
      actionReadiness:    "proposal_ready",
      approvalRequired:   false,
      approvalReason:     null,
      executionScope:     actionType === "starter_position" ? "position" : "watchlist",
      actionSafetyLevel:  "safe",
      automationEligible: false,
    };
  }

  // AR-4: hold or observe → monitor only, no action needed
  if (actionType === "hold" || actionType === "observe") {
    return {
      actionReadiness:    "monitor_only",
      approvalRequired:   false,
      approvalReason:     null,
      executionScope:     "observation",
      actionSafetyLevel:  "safe",
      automationEligible: false,
    };
  }

  // AR-5: fallback (avoid_adding without high concentration, low-priority upgrade, etc.)
  return {
    actionReadiness:    "monitor_only",
    approvalRequired:   false,
    approvalReason:     null,
    executionScope:     "observation",
    actionSafetyLevel:  "safe",
    automationEligible: false,
  };
}

/**
 * Step 7 Block 2: Derive an approval-queue entry from an already-computed
 * action-readiness result and the surrounding opportunity signals.
 *
 * Pure derivation — no execution, no new DB calls.
 * Returns null when actionReadiness is absent.
 *
 * Output fields:
 *   pendingApproval      – true only for review_required + approvalRequired
 *   reviewReason         – human-readable reason (from approvalReason or derived)
 *   reviewPriority       – 'high' | 'medium' | 'low' | null
 *   approvalQueueBucket  – 'risk_review' | 'proposal_bucket' | 'insufficient_data' | null
 *   reviewSummary        – one-liner for UI/briefing display
 *
 * @param {object} opp – opportunity with actionReadiness, nextAction,
 *                       actionOrchestration, portfolioContext
 * @returns {object|null}
 */
function computeApprovalQueueEntry(opp) {
  const ar = opp.actionReadiness;
  if (!ar) return null;

  const readiness      = ar.actionReadiness;
  const approvalReq    = ar.approvalRequired;
  const approvalReason = ar.approvalReason;
  const actionType     = opp.nextAction?.actionType     || "observe";
  const actionPriority = opp.nextAction?.actionPriority || "low";
  const escalation     = opp.actionOrchestration?.escalationLevel || "none";
  const portfolioCtx   = opp.portfolioContext || {};

  // Tier 1: insufficient_confidence → not ready for any queue, observe only
  if (readiness === "insufficient_confidence") {
    return {
      pendingApproval:     false,
      reviewReason:        approvalReason || null,
      reviewPriority:      null,
      approvalQueueBucket: "insufficient_data",
      reviewSummary:       "Zu wenig Daten – Signal noch nicht reif. Weiter beobachten.",
    };
  }

  // Tier 2: monitor_only → no queue entry needed
  if (readiness === "monitor_only") {
    return {
      pendingApproval:     false,
      reviewReason:        null,
      reviewPriority:      null,
      approvalQueueBucket: null,
      reviewSummary:       null,
    };
  }

  // Tier 3: proposal_ready → structured proposal, no approval gating
  if (readiness === "proposal_ready") {
    return {
      pendingApproval:     false,
      reviewReason:        null,
      reviewPriority:      actionPriority === "high" ? "medium" : "low",
      approvalQueueBucket: "proposal_bucket",
      reviewSummary:       "Strukturierter Vorschlag – zur Prüfung bereit, keine automatische Ausführung.",
    };
  }

  // Tier 4: review_required + approvalRequired → pending approval
  if (readiness === "review_required" && approvalReq) {
    // Priority: high escalation AND high actionPriority → high
    //           either condition → medium
    //           fallback → low
    let reviewPriority = "low";
    if (escalation === "high" && actionPriority === "high") {
      reviewPriority = "high";
    } else if (escalation === "high" || actionPriority === "high") {
      reviewPriority = "medium";
    }

    // Bucket: risk-driven actions → risk_review; otherwise → proposal_bucket
    const isRiskDriven =
      actionType === "reduce_risk" ||
      actionType === "rebalance_review" ||
      portfolioCtx.concentrationRisk === "high";
    const approvalQueueBucket = isRiskDriven ? "risk_review" : "proposal_bucket";
    const bucketLabel = approvalQueueBucket === "risk_review"
      ? "Risiko-Review"
      : "Vorschlags-Review";

    return {
      pendingApproval:     true,
      reviewReason:        approvalReason || "Freigabe erforderlich",
      reviewPriority,
      approvalQueueBucket,
      reviewSummary:       `Wartet auf Freigabe (${bucketLabel}): ${approvalReason || "manuelle Prüfung nötig"}`,
    };
  }

  // Fallback: review_required without explicit approvalRequired flag
  return {
    pendingApproval:     false,
    reviewReason:        approvalReason || null,
    reviewPriority:      null,
    approvalQueueBucket: null,
    reviewSummary:       null,
  };
}

/**
 * Step 7 Block 3: Approval Decision Layer – derives a concrete decision state
 * for review/approval cases from already-computed signals.
 *
 * Pure derivation — no execution, no automatic approval, no new DB calls.
 * Turns "this case needs review" into "this case is in state X because Y".
 *
 * Decision statuses:
 *   pending_review     – review required, risk or contradictions present
 *   approved_candidate – review required but data is strong & consistent → likely approvable
 *   rejected_candidate – review required with problematic constellation → likely not approvable
 *   deferred_review    – review required but contradictory/weak data → defer until clearer
 *   needs_more_data    – insufficient or thin data basis → cannot decide yet
 *
 * Only review_required cases enter the decision logic. Other tiers
 * (proposal_ready, monitor_only, insufficient_confidence) are mapped
 * transparently without pretending to be approved.
 *
 * @param {object} opp – opportunity with actionReadiness, approvalQueueEntry,
 *                       finalConviction, finalConfidence, robustnessScore,
 *                       signalContext, portfolioContext, nextAction, actionOrchestration
 * @returns {object}
 */
// Decision-layer thresholds (named constants for clarity and tuning)
const DL_CONVICTION_STRONG  = 65;   // finalConviction threshold for "strong"
const DL_CONFIDENCE_GOOD    = 60;   // finalConfidence threshold for "good"
const DL_ROBUSTNESS_GOOD    = 0.55; // robustnessScore threshold for "good"
const DL_SIGNAL_CONF_GOOD   = 55;   // signalConfidence threshold for "good"
const DL_REJECT_MIN_RISK    = 3;    // minimum riskSignals count for rejection
const DL_REJECT_MAX_QUALITY = 1;    // maximum dataQuality count for rejection
const DL_APPROVE_MIN_QUALITY = 3;   // minimum dataQuality count for approval candidate
const DL_APPROVE_MAX_RISK   = 1;    // maximum riskSignals count for approval candidate
const DL_DEFER_MIN_RISK     = 2;    // minimum riskSignals for deferred review
const DL_DEFER_MIN_QUALITY  = 2;    // minimum dataQuality for deferred review (conflicting signals)

function computeDecisionLayer(opp) {
  const ar        = opp.actionReadiness;
  const aq        = opp.approvalQueueEntry;
  if (!ar) return null;

  const readiness      = ar.actionReadiness;
  const approvalReq    = ar.approvalRequired;
  const safetyLevel    = ar.actionSafetyLevel    || "safe";
  const conviction     = safeNum(opp.finalConviction, 0);
  const confidence     = safeNum(opp.finalConfidence, 0);
  const robustness     = safeNum(opp.robustnessScore, 0);
  const signalConf     = opp.signalContext
    ? safeNum(opp.signalContext.signalConfidence, 0)
    : null;
  const escalation     = opp.actionOrchestration?.escalationLevel || "none";
  const concRisk       = opp.portfolioContext?.concentrationRisk  || "none";
  const actionType     = opp.nextAction?.actionType               || "observe";
  const reviewPriority = aq?.reviewPriority                       || null;

  // ── Tier 0: insufficient_confidence → needs_more_data (clear separation) ──
  if (readiness === "insufficient_confidence") {
    return {
      decisionStatus:    "needs_more_data",
      decisionReason:    "Datenbasis zu gering für eine Entscheidung – Robustness oder Signalqualität unzureichend",
      approvalOutcome:   null,
      decisionReadiness: "not_ready",
      reviewDecision:    null,
    };
  }

  // ── Tier 1: monitor_only → outside decision logic (no approval case) ──
  if (readiness === "monitor_only") {
    return {
      decisionStatus:    null,
      decisionReason:    null,
      approvalOutcome:   null,
      decisionReadiness: "not_applicable",
      reviewDecision:    null,
    };
  }

  // ── Tier 2: proposal_ready → not auto-approved, transparent pass-through ──
  if (readiness === "proposal_ready") {
    return {
      decisionStatus:    null,
      decisionReason:    null,
      approvalOutcome:   "proposal_pending",
      decisionReadiness: "proposal_available",
      reviewDecision:    null,
    };
  }

  // ── Tier 3: review_required → decision logic applies ──
  if (readiness === "review_required") {
    // Signal quality indicators
    const hasStrongConviction  = conviction >= DL_CONVICTION_STRONG;
    const hasGoodConfidence    = confidence >= DL_CONFIDENCE_GOOD;
    const hasGoodRobustness    = robustness >= DL_ROBUSTNESS_GOOD;
    const hasStrongSignal      = signalConf === null || signalConf >= DL_SIGNAL_CONF_GOOD;
    const dataQuality          = [hasStrongConviction, hasGoodConfidence, hasGoodRobustness, hasStrongSignal]
      .filter(Boolean).length;

    // Risk / contradiction indicators
    const hasHighConcentration = concRisk === "high";
    const hasHighEscalation    = escalation === "high";
    const isRiskAction         = actionType === "reduce_risk";
    const hasRestricted        = safetyLevel === "restricted";
    const riskSignals          = [hasHighConcentration, hasHighEscalation, isRiskAction, hasRestricted]
      .filter(Boolean).length;

    // Decision D-1: High risk + problematic constellation → rejected_candidate
    if (riskSignals >= DL_REJECT_MIN_RISK && dataQuality <= DL_REJECT_MAX_QUALITY) {
      return {
        decisionStatus:    "rejected_candidate",
        decisionReason:    "Mehrere Risikosignale bei schwacher Datenbasis – Freigabe nicht empfohlen",
        approvalOutcome:   "rejection_likely",
        decisionReadiness: "review_complete",
        reviewDecision:    "reject",
      };
    }

    // Decision D-2: Strong data + low contradiction → approved_candidate
    if (dataQuality >= DL_APPROVE_MIN_QUALITY && riskSignals <= DL_APPROVE_MAX_RISK && !isRiskAction) {
      const reason = approvalReq
        ? "Starke Datenbasis und konsistente Signale – Freigabe-Kandidat, manuelle Bestätigung erforderlich"
        : "Datenqualität hoch, geringe Widersprüche – empfohlener Kandidat";
      return {
        decisionStatus:    "approved_candidate",
        decisionReason:    reason,
        approvalOutcome:   "approval_likely",
        decisionReadiness: "review_complete",
        reviewDecision:    "approve_candidate",
      };
    }

    // Decision D-3: Mixed/weak signals → deferred_review or needs_more_data
    if (dataQuality <= DL_REJECT_MAX_QUALITY) {
      return {
        decisionStatus:    "needs_more_data",
        decisionReason:    "Signale zu schwach oder unvollständig für eine sichere Entscheidung",
        approvalOutcome:   null,
        decisionReadiness: "not_ready",
        reviewDecision:    null,
      };
    }

    if (riskSignals >= DL_DEFER_MIN_RISK && dataQuality >= DL_DEFER_MIN_QUALITY) {
      return {
        decisionStatus:    "deferred_review",
        decisionReason:    "Widersprüchliche Signale – starke Daten, aber erhöhtes Risiko – zurückgestellt",
        approvalOutcome:   null,
        decisionReadiness: "deferred",
        reviewDecision:    "defer",
      };
    }

    // Decision D-4: Default for review_required → pending_review
    const parts = [];
    if (hasHighEscalation) parts.push("hohe Eskalation");
    if (hasHighConcentration) parts.push("Konzentrationsrisiko");
    if (!hasStrongConviction) parts.push("moderate Conviction");
    return {
      decisionStatus:    "pending_review",
      decisionReason:    parts.length
        ? `Manuelle Prüfung erforderlich: ${parts.join(", ")}`
        : "Review erforderlich – Entscheidung steht aus",
      approvalOutcome:   null,
      decisionReadiness: "awaiting_review",
      reviewDecision:    null,
    };
  }

  // Fallback: unknown readiness tier → null decision
  return {
    decisionStatus:    null,
    decisionReason:    null,
    approvalOutcome:   null,
    decisionReadiness: "not_applicable",
    reviewDecision:    null,
  };
}

// ── Step 7 Block 4: Controlled Approval Action Flow ────────────────────────
// Answers: "What is the next controlled system step after the decision?"
// No execution, no automation – only controlled follow-up classification.
// Derives approvalFlowStatus, postDecisionAction, closureStatus,
// nextReviewAt, deferUntil, executionIntent, actionLifecycleStage.
function computeControlledApprovalFlow(opp) {
  const dl = opp.decisionLayer;
  if (!dl) return null;

  const ds = dl.decisionStatus;
  const readiness = opp.actionReadiness?.actionReadiness || null;
  const approvalOutcome = dl.approvalOutcome || null;

  // ── Path 1: approved_candidate → ready for manual action ──
  if (ds === "approved_candidate") {
    return {
      approvalFlowStatus:  "approved_pending_action",
      postDecisionAction:  "ready_for_manual_action",
      closureStatus:       null,
      nextReviewAt:        null,
      deferUntil:          null,
      executionIntent:     "manual_confirmation_required",
      actionLifecycleStage: "post_decision",
    };
  }

  // ── Path 2: rejected_candidate → closed ──
  if (ds === "rejected_candidate") {
    return {
      approvalFlowStatus:  "closed",
      postDecisionAction:  "no_action",
      closureStatus:       "closed_rejected",
      nextReviewAt:        null,
      deferUntil:          null,
      executionIntent:     "none",
      actionLifecycleStage: "closed",
    };
  }

  // ── Path 3: deferred_review → deferred with scheduled re-check ──
  if (ds === "deferred_review") {
    const now = new Date();
    const deferDays = 3;
    const deferDate = new Date(now.getTime() + deferDays * 24 * 60 * 60 * 1000);
    return {
      approvalFlowStatus:  "deferred",
      postDecisionAction:  "wait_for_reassessment",
      closureStatus:       null,
      nextReviewAt:        deferDate.toISOString(),
      deferUntil:          deferDate.toISOString(),
      executionIntent:     "reassess_after_data_update",
      actionLifecycleStage: "deferred",
    };
  }

  // ── Path 4: needs_more_data → waiting for more data ──
  if (ds === "needs_more_data") {
    return {
      approvalFlowStatus:  "waiting_for_more_data",
      postDecisionAction:  "collect_more_signals",
      closureStatus:       null,
      nextReviewAt:        null,
      deferUntil:          null,
      executionIntent:     "passive_observation",
      actionLifecycleStage: "pre_decision",
    };
  }

  // ── Path 5: pending_review → awaiting review ──
  if (ds === "pending_review") {
    return {
      approvalFlowStatus:  "awaiting_review",
      postDecisionAction:  "pending_human_review",
      closureStatus:       null,
      nextReviewAt:        null,
      deferUntil:          null,
      executionIntent:     "awaiting_manual_assessment",
      actionLifecycleStage: "in_review",
    };
  }

  // ── Path 6: proposal_ready (no decision status) → not in real approval flow ──
  if (readiness === "proposal_ready" && approvalOutcome === "proposal_pending") {
    return {
      approvalFlowStatus:  "proposal_available",
      postDecisionAction:  "user_may_review_proposal",
      closureStatus:       null,
      nextReviewAt:        null,
      deferUntil:          null,
      executionIntent:     "no_approval_needed",
      actionLifecycleStage: "proposal",
    };
  }

  // ── Path 7: monitor_only / no decision → outside approval flow ──
  return null;
}

async function ensureRuntimePreviewStoresLoaded() {
  if (runtimePreviewStoresLoaded) return;

  const [persistedMarketMemory, persistedMetaLearning] = await Promise.all([
    loadRuntimeState(RUNTIME_STATE_MARKET_MEMORY_KEY),
    loadRuntimeState(RUNTIME_STATE_META_LEARNING_KEY),
  ]);

  marketMemoryStore = safeObject(persistedMarketMemory, {});
  metaLearningStore = safeObject(persistedMetaLearning, {});
  runtimePreviewStoresLoaded = true;
}

function norm0to1(x) {
  const n = safeNum(x, 0);
  if (n > 1.5) return clamp(n / 100, 0, 1);
  return clamp(n, 0, 1);
}

function uniqueTexts(values = [], maxItems = SIGNAL_REASON_LIMIT) {
  const seen = new Set();
  const result = [];

  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "")
      .replace(/\s+/g, " ")
      .trim();

    if (!text) continue;

    const key = text.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(text);

    if (result.length >= maxItems) break;
  }

  return result;
}

function normalizeSignalDirection(directionScore) {
  const score = clamp(safeNum(directionScore, 0), -1, 1);

  if (score >= SIGNAL_DIRECTION_THRESHOLD) return "bullish";
  if (score <= -SIGNAL_DIRECTION_THRESHOLD) return "bearish";
  return "neutral";
}

function buildSignalSummary(signalContext = {}) {
  if (!signalContext || typeof signalContext !== "object") return null;

  const parts = [];
  const direction = signalContext.signalDirection || "neutral";
  const earlySignalType = signalContext.earlySignalType || null;
  const trendLevel = signalContext.trendLevel || null;
  const buzzScore = clamp(safeNum(signalContext.buzzScore, 0), 0, 100);
  const signalStrength = clamp(safeNum(signalContext.signalStrength, 0), 0, 100);

  if (direction === "bullish") {
    parts.push("bullisches Signal");
  } else if (direction === "bearish") {
    parts.push("bearisches Signal");
  } else if (signalStrength > 0) {
    parts.push("neutrales Signal");
  }

  if (trendLevel) {
    parts.push(`Trend ${trendLevel}`);
  }

  if (earlySignalType === "potential_breakout") {
    parts.push("frühes Breakout");
  } else if (earlySignalType === "early_interest") {
    parts.push("frühes Interesse");
  }

  if (buzzScore >= 60) {
    parts.push(`Buzz ${Math.round(buzzScore)}`);
  }

  return parts.length ? parts.join(" · ") : null;
}

function buildSignalReasons({
  sentimentScore,
  buzzScore,
  trendLevel,
  earlySignalType,
  newsContext,
}) {
  const reasons = [];

  if (earlySignalType === "potential_breakout") {
    reasons.push("frühes Breakout-Signal");
  } else if (earlySignalType === "early_interest") {
    reasons.push("frühes Marktinteresse");
  }

  if (trendLevel === "exploding" || trendLevel === "very_hot") {
    reasons.push(`Trend ${trendLevel}`);
  } else if (trendLevel === "hot") {
    reasons.push("Trend hot");
  }

  if (buzzScore >= 70) {
    reasons.push("hoher Markt-Buzz");
  } else if (buzzScore >= 50) {
    reasons.push("solider Markt-Buzz");
  }

  if (sentimentScore >= 20) {
    reasons.push("positives Sentiment");
  } else if (sentimentScore <= -20) {
    reasons.push("negatives Sentiment");
  }

  if (!reasons.length) {
    reasons.push(...uniqueTexts(newsContext?.reasons, SIGNAL_REASON_LIMIT));
  }

  return uniqueTexts(reasons, SIGNAL_REASON_LIMIT);
}

function buildSignalContext(row = {}, newsContext = null, newsItems = [], socialPosts = []) {
  const symbol = String(row?.symbol || "").trim().toUpperCase();
  if (!symbol) return null;

  const marketSentiment = buildMarketSentiment({
    sentimentScore:
      newsContext?.marketSentiment?.sentimentScore ??
      safeNum(newsContext?.directionScore, 0) * 100,
    buzzScore:
      newsContext?.marketSentiment?.buzzScore ??
      newsContext?.strengthScore ??
      0,
    mentionCount:
      newsContext?.marketSentiment?.mentionCount ??
      newsContext?.activeCount ??
      0,
    reasons:
      newsContext?.marketSentiment?.reasons?.length
        ? newsContext.marketSentiment.reasons
        : newsContext?.reasons,
    sourceBreakdown: newsContext?.marketSentiment?.sourceBreakdown,
  });

  const marketBuzz =
    buildMarketBuzz({
      newsItems: Array.isArray(newsItems) ? newsItems : [],
      socialPosts: Array.isArray(socialPosts) ? socialPosts : [],
    }).find((entry) => String(entry?.symbol || "").toUpperCase() === symbol) || null;

  const momentumScore = Math.round(norm0to1(row?.momentum) * 100);
  const trendSignal = buildTrendingStock({
    symbol,
    buzzScore:
      marketBuzz?.buzzScore ??
      safeNum(marketSentiment?.buzzScore, 0),
    priceMomentum: momentumScore,
  });

  const earlySignal = buildEarlySignals([
    {
      symbol,
      buzzScore:
        trendSignal?.buzzScore ??
        marketBuzz?.buzzScore ??
        0,
      priceMomentum: trendSignal?.priceMomentum ?? momentumScore,
      trendScore: trendSignal?.trendScore,
      trendLevel: trendSignal?.trendLevel,
    },
  ])[0] || null;

  const sentimentScore = clamp(
    safeNum(marketSentiment?.sentimentScore, 0),
    -100,
    100
  );
  const buzzScore = clamp(
    safeNum(marketBuzz?.buzzScore, marketSentiment?.buzzScore),
    0,
    100
  );
  const trendScore = clamp(safeNum(trendSignal?.trendScore, 0), 0, 100);
  const earlySignalStrength = clamp(safeNum(earlySignal?.strength, 0), 0, 100);
  const trendBias = clamp(safeNum(row?.trend, 0), -1, 1);
  const momentumBias = clamp((momentumScore - 50) / 50, -1, 1);
  const normalizedSentimentDirection = (sentimentScore / 100) * 0.5;
  const normalizedSentimentStrength = Math.abs(sentimentScore) * 0.2;

  let signalDirectionScore = clamp(
    normalizedSentimentDirection + momentumBias * 0.35 + trendBias * 0.15,
    -1,
    1
  );

  if (earlySignal?.signal && signalDirectionScore >= 0) {
    signalDirectionScore = clamp(signalDirectionScore + 0.08, -1, 1);
  }

  const signalStrength = clamp(
    Math.round(
      trendScore * 0.55 +
        normalizedSentimentStrength +
        buzzScore * 0.1 +
        earlySignalStrength * 0.15
    ),
    0,
    100
  );

  const directionAligned =
    (signalDirectionScore >= SIGNAL_DIRECTION_THRESHOLD && trendBias >= 0) ||
    (signalDirectionScore <= -SIGNAL_DIRECTION_THRESHOLD && trendBias < 0);

  const signalConfidence = clamp(
    Math.round(
      signalStrength * 0.45 +
        clamp(safeNum(newsContext?.weightedConfidence, 0), 0, 100) * 0.25 +
        clamp(safeNum(newsContext?.activeCount, 0), 0, 4) * 5 +
        (directionAligned ? 10 : 0)
    ),
    0,
    100
  );

  const signalContext = {
    sentimentScore,
    buzzScore,
    trendScore,
    trendLevel: trendSignal?.trendLevel || null,
    earlySignalType: earlySignal?.signal || null,
    earlySignalStrength,
    signalStrength,
    signalDirection: normalizeSignalDirection(signalDirectionScore),
    signalDirectionScore: Number(signalDirectionScore.toFixed(2)),
    signalConfidence,
    summary: null,
    reasons: [],
  };

  signalContext.summary = buildSignalSummary(signalContext);
  signalContext.reasons = buildSignalReasons({
    sentimentScore,
    buzzScore,
    trendLevel: signalContext.trendLevel,
    earlySignalType: signalContext.earlySignalType,
    newsContext,
  });

  return signalContext;
}

async function loadOpportunityNewsContextBySymbols(
  symbols = [],
  limitPerSymbol = OPPORTUNITY_NEWS_LIMIT
) {
  const normalizedSymbols = [
    ...new Set(
      (Array.isArray(symbols) ? symbols : [])
        .map((symbol) => String(symbol || "").trim().toUpperCase())
        .filter(Boolean)
    ),
  ];

  if (!normalizedSymbols.length) {
    return {
      scoringActiveNewsBySymbol: {},
      newsContextBySymbol: {},
    };
  }

  const scoringActiveNewsBySymbol = await getScoringActiveMarketNewsBySymbols(
    normalizedSymbols,
    limitPerSymbol
  );

  const newsContextBySymbol = normalizedSymbols.reduce((result, symbol) => {
    result[symbol] = buildScoringNewsContext(
      scoringActiveNewsBySymbol?.[symbol] || []
    );
    return result;
  }, {});

  return {
    scoringActiveNewsBySymbol,
    newsContextBySymbol,
  };
}

/* =========================================================
   OPPORTUNITY SCORE
========================================================= */

function calculateOpportunityScore(row) {
  const hqs = safeNum(row.hqs_score, 0);

  const momentum = norm0to1(row.momentum);
  const quality = norm0to1(row.quality);
  const stability = norm0to1(row.stability);
  const relative = norm0to1(row.relative);

  const volatility = safeNum(row.volatility, 0);

  const score =
    hqs * 0.55 +
    momentum * 10 +
    quality * 18 +
    stability * 18 +
    relative * 10 -
    volatility * 12;

  return clamp(Number(score.toFixed(2)), 0, 100);
}

/* =========================================================
   CONFIDENCE SCORE
========================================================= */

function calculateConfidence(row, opportunityScore) {
  const hqs = safeNum(row.hqs_score, 0);
  const quality = norm0to1(row.quality);
  const stability = norm0to1(row.stability);
  const volatility = safeNum(row.volatility, 0);

  let c =
    hqs * 0.35 +
    quality * 25 +
    stability * 25 -
    volatility * 18 +
    clamp(opportunityScore, -20, 80) * 0.3;

  return clamp(Math.round(c), 0, 100);
}

/* =========================================================
   STRESS-TEST ENGINE
========================================================= */

const STRESS_SCENARIO_COUNT = 10;
const STRESS_PERCENT_MIN = 0.05;
const STRESS_PERCENT_MAX = 0.15;
const STRESS_ANTIFRAGILE_THRESHOLD = 0.8;
const STRESS_MIN_HQS_SCORE = 35;
const STRESS_MIN_OPPORTUNITY_SCORE = 30;
const STRESS_MIN_OPPORTUNITY_STRENGTH = 20;

function randomStressFactor() {
  return STRESS_PERCENT_MIN + Math.random() * (STRESS_PERCENT_MAX - STRESS_PERCENT_MIN);
}

function simulateMarketStress(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return [];

  const variants = [];

  for (let i = 0; i < STRESS_SCENARIO_COUNT; i++) {
    const volumeStress = randomStressFactor();
    const rsiStress = randomStressFactor();
    const priceStress = randomStressFactor();

    const features = safeObject(snapshot.features, {});
    const signalCtx = safeObject(snapshot.signalContext, {});
    const orchestratorCtx = safeObject(snapshot.orchestrator, {});

    variants.push({
      hqsScore: safeNum(snapshot.hqsScore, 0),
      features: {
        momentum: Math.max(0, safeNum(features.momentum, 0) * (1 - rsiStress)),
        quality: safeNum(features.quality, 0),
        stability: safeNum(features.stability, 0),
        relative: Math.max(0, safeNum(features.relative, 0) * (1 - rsiStress)),
        volatility: safeNum(features.volatility, 0),
        trendStrength: Math.max(0, safeNum(features.trendStrength, 0) * (1 - rsiStress)),
        relativeVolume: Math.max(0, safeNum(features.relativeVolume, 0) * (1 - volumeStress)),
        liquidityScore: Math.max(0, safeNum(features.liquidityScore, 0) * (1 - volumeStress)),
      },
      signalContext: {
        signalStrength: Math.max(0, safeNum(signalCtx.signalStrength, 0) * (1 - rsiStress)),
        trendScore: Math.max(0, safeNum(signalCtx.trendScore, 0) * (1 - rsiStress)),
        signalDirectionScore: safeNum(signalCtx.signalDirectionScore, 0),
        signalConfidence: safeNum(signalCtx.signalConfidence, 0),
        buzzScore: Math.max(0, safeNum(signalCtx.buzzScore, 0) * (1 - volumeStress)),
        sentimentScore: safeNum(signalCtx.sentimentScore, 0),
        trendLevel: signalCtx.trendLevel || null,
        earlySignalType: signalCtx.earlySignalType || null,
      },
      orchestrator: {
        opportunityStrength: Math.max(0, safeNum(orchestratorCtx.opportunityStrength, 0) * (1 - priceStress)),
        orchestratorConfidence: Math.max(0, safeNum(orchestratorCtx.orchestratorConfidence, 0) * (1 - priceStress)),
      },
      entryPrice: Math.max(0, safeNum(snapshot.entryPrice, 0) * (1 - priceStress)),
    });
  }

  return variants;
}

function meetsMinimumSignalCriteria(stressedSnapshot) {
  const hqs = safeNum(stressedSnapshot?.hqsScore, 0);
  const features = stressedSnapshot?.features || {};

  const stressedRow = {
    hqs_score: hqs,
    momentum: features.momentum,
    quality: features.quality,
    stability: features.stability,
    relative: features.relative,
    volatility: features.volatility,
  };

  const opportunityScore = calculateOpportunityScore(stressedRow);
  const opportunityStrength = safeNum(stressedSnapshot?.orchestrator?.opportunityStrength, 0);

  return (
    hqs >= STRESS_MIN_HQS_SCORE &&
    opportunityScore >= STRESS_MIN_OPPORTUNITY_SCORE &&
    opportunityStrength >= STRESS_MIN_OPPORTUNITY_STRENGTH
  );
}

function calculateRobustnessScore(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return 0;

  const variants = simulateMarketStress(snapshot);
  if (!variants.length) return 0;

  const passing = variants.filter((v) => meetsMinimumSignalCriteria(v)).length;
  return Number((passing / variants.length).toFixed(2));
}

/* =========================================================
   OPPORTUNITY TYPE
========================================================= */

function classifyOpportunity(row) {
  const momentum = norm0to1(row.momentum);
  const quality = norm0to1(row.quality);
  const stability = norm0to1(row.stability);
  const volatility = safeNum(row.volatility, 0);
  const trend = safeNum(row.trend, 0);

  if (momentum > 0.75) return "momentum";

  if (trend > 0.10 && volatility < 0.30) {
    return "breakout";
  }

  if (quality > 0.7 && stability > 0.7) {
    return "quality";
  }

  return "balanced";
}

/* =========================================================
   REASON GENERATOR
========================================================= */

function generateReason(row, newsContext = null) {
  const reasons = [];

  const quality = norm0to1(row.quality);
  const stability = norm0to1(row.stability);
  const relative = norm0to1(row.relative);
  const momentum = norm0to1(row.momentum);
  const volatility = safeNum(row.volatility, 0);

  if (quality >= 0.65) reasons.push("gute Firma");
  if (stability >= 0.65) reasons.push("stabil");
  if (relative >= 0.65) reasons.push("stärker als der Markt");

  if (momentum >= 0.50 && momentum <= 0.85) {
    reasons.push("läuft gut");
  }

  if (volatility > 0.9) {
    reasons.push("hohe Schwankung");
  }

  if (safeNum(newsContext?.activeCount, 0) > 0) {
    if (newsContext?.direction === "bullish") {
      reasons.push("positive News-Lage");
    } else if (newsContext?.direction === "bearish") {
      reasons.push("negative News-Lage");
    }

    if (newsContext?.dominantEventType) {
      reasons.push(`News-Fokus ${newsContext.dominantEventType}`);
    }
  }

  if (!reasons.length) {
    reasons.push("solide Werte");
  }

  return Array.from(new Set(reasons)).slice(0, OPPORTUNITY_REASON_LIMIT).join(" + ");
}

function formatOpportunityNewsContext(newsContext = null) {
  if (!newsContext || safeNum(newsContext?.activeCount, 0) <= 0) return null;

  return {
    activeCount: safeNum(newsContext?.activeCount, 0),
    direction: newsContext?.direction || "neutral",
    directionScore: safeNum(newsContext?.directionScore, 0),
    strengthScore: safeNum(newsContext?.strengthScore, 0),
    dominantEventType: newsContext?.dominantEventType || null,
    weightedRelevance: safeNum(newsContext?.weightedRelevance, 0),
    weightedConfidence: safeNum(newsContext?.weightedConfidence, 0),
    weightedMarketImpact: safeNum(newsContext?.weightedMarketImpact, 0),
    summary: newsContext?.summary || null,
  };
}

function formatOpportunitySignalContext(signalContext = null) {
  if (!signalContext || safeNum(signalContext?.signalStrength, 0) <= 0) return null;

  return {
    sentimentScore: safeNum(signalContext?.sentimentScore, 0),
    buzzScore: safeNum(signalContext?.buzzScore, 0),
    trendScore: safeNum(signalContext?.trendScore, 0),
    trendLevel: signalContext?.trendLevel || null,
    earlySignalType: signalContext?.earlySignalType || null,
    earlySignalStrength: safeNum(signalContext?.earlySignalStrength, 0),
    signalStrength: safeNum(signalContext?.signalStrength, 0),
    signalDirection: signalContext?.signalDirection || "neutral",
    signalDirectionScore: safeNum(signalContext?.signalDirectionScore, 0),
    signalConfidence: safeNum(signalContext?.signalConfidence, 0),
    summary: signalContext?.summary || null,
    reasons: Array.isArray(signalContext?.reasons)
      ? signalContext.reasons.slice(0, SIGNAL_REASON_LIMIT)
      : [],
  };
}

function hasPersistedBatchResult(tracked = null) {
  const payload = safeObject(tracked?.payload, {});
  const finalView = safeObject(payload?.finalView, {});
  return Boolean(
    Object.keys(finalView).length ||
      Object.keys(safeObject(payload?.orchestrator, {})).length
  );
}

function buildOpportunityFromBatchResult(row, tracked = null) {
  if (!hasPersistedBatchResult(tracked)) return null;

  const payload = safeObject(tracked?.payload, {});
  const finalView = safeObject(payload?.finalView, {});
  const globalContext = safeObject(finalView?.globalContext, {});
  const brain = safeObject(payload?.brain, {});
  const strategy = safeObject(payload?.strategy, safeObject(finalView?.strategy, {}));
  const features = safeObject(payload?.features, safeObject(finalView?.features, {}));
  const orchestrator = safeObject(
    payload?.orchestrator,
    safeObject(globalContext?.orchestrator, {})
  );
  const historicalContext = safeObject(payload?.historicalContext, {});
  const newsContextCandidate = finalView?.newsContext ?? globalContext?.newsContext ?? null;
  const signalContextCandidate =
    finalView?.signalContext ?? globalContext?.signalContext ?? null;
  const newsContext =
    newsContextCandidate &&
    typeof newsContextCandidate === "object" &&
    !Array.isArray(newsContextCandidate)
      ? newsContextCandidate
      : null;
  const signalContext =
    signalContextCandidate &&
    typeof signalContextCandidate === "object" &&
    !Array.isArray(signalContextCandidate)
      ? signalContextCandidate
      : null;
  const discoveries = Array.isArray(payload?.discoveries)
    ? payload.discoveries
    : Array.isArray(finalView?.discoveries)
      ? finalView.discoveries
      : [];
  const narratives = Array.isArray(payload?.narratives)
    ? payload.narratives
    : Array.isArray(finalView?.narratives)
      ? finalView.narratives
      : [];
  // Prefer integrationEngine chain outputs over local raw recomputation.
  const chainConviction = safeNum(
    finalView?.finalConviction,
    safeNum(tracked?.finalConviction, 0)
  );
  const chainConfidence = safeNum(
    finalView?.finalConfidence,
    safeNum(tracked?.finalConfidence, 0)
  );
  const opportunityScore = chainConviction > 0
    ? chainConviction
    : calculateOpportunityScore(row);
  const confidence = chainConfidence > 0
    ? chainConfidence
    : calculateConfidence(row, opportunityScore);
  const robustnessScore = safeNum(historicalContext?.robustness, 0);

  return {
    symbol: String(row?.symbol || "").trim().toUpperCase(),

    regime: row?.regime ?? tracked?.regime ?? finalView?.regime ?? null,
    // Prefer strategyEngine output from chain; fall back to raw classification.
    type: strategy?.strategy || classifyOpportunity(row),

    hqsScore: safeNum(row?.hqs_score, safeNum(finalView?.hqsScore, 0)),
    opportunityScore,
    confidence,

    aiScore: safeNum(finalView?.aiScore, safeNum(brain?.aiScore, 0)),
    finalConviction: chainConviction,
    finalConfidence: chainConfidence,
    finalRating: finalView?.finalRating || null,
    finalDecision: finalView?.finalDecision || null,

    strategy: strategy?.strategy || null,
    strategyLabel: strategy?.strategyLabel || null,

    narratives,
    discoveries,

    trend: row?.trend ?? null,
    volatility: row?.volatility ?? null,
    resilienceScore: safeNum(
      payload?.resilienceScore,
      safeNum(finalView?.resilienceScore, 0)
    ),

    opportunityStrength: safeNum(
      orchestrator?.opportunityStrength,
      safeNum(tracked?.opportunityStrength, 0)
    ),
    orchestratorConfidence: safeNum(
      orchestrator?.orchestratorConfidence,
      safeNum(tracked?.orchestratorConfidence, 0)
    ),

    whyInteresting: Array.isArray(finalView?.whyInteresting)
      ? finalView.whyInteresting
      : [],
    reason: generateReason(row, newsContext),
    newsContext: formatOpportunityNewsContext(newsContext),
    newsAdjustment: safeNum(finalView?.components?.newsAdjustment, 0),
    signalAdjustment: safeNum(finalView?.components?.signalAdjustment, 0),
    signalContext: formatOpportunitySignalContext(signalContext),

    marketMemory: safeObject(globalContext?.marketMemory, null),
    metaLearning: safeObject(globalContext?.metaLearning, null),

    robustnessScore,
    antifragile: robustnessScore > STRESS_ANTIFRAGILE_THRESHOLD,

    // _rawScore: fresh market-data score used by computeDeltaContext to derive
    // conviction delta vs the stored (integrationEngine chain) finalConviction.
    _rawScore: calculateOpportunityScore(row),

    advancedUpdatedAt: row?.advanced_updated_at
      ? new Date(row.advanced_updated_at).toISOString()
      : null,
  };
}

function buildFallbackOpportunity(row, tracked = null) {
  const payload = safeObject(tracked?.payload, {});
  const finalView = safeObject(payload?.finalView, {});
  const globalContext = safeObject(finalView?.globalContext, {});
  const brain = safeObject(payload?.brain, {});
  const strategy = safeObject(payload?.strategy, safeObject(finalView?.strategy, {}));
  const orchestrator = safeObject(
    payload?.orchestrator,
    safeObject(globalContext?.orchestrator, {})
  );
  const historicalContext = safeObject(payload?.historicalContext, {});
  const newsContextCandidate = finalView?.newsContext ?? globalContext?.newsContext ?? null;
  const signalContextCandidate =
    finalView?.signalContext ?? globalContext?.signalContext ?? null;
  const newsContext =
    newsContextCandidate &&
    typeof newsContextCandidate === "object" &&
    !Array.isArray(newsContextCandidate)
      ? newsContextCandidate
      : null;
  const signalContext =
    signalContextCandidate &&
    typeof signalContextCandidate === "object" &&
    !Array.isArray(signalContextCandidate)
      ? signalContextCandidate
      : null;
  const discoveries = Array.isArray(payload?.discoveries)
    ? payload.discoveries
    : Array.isArray(finalView?.discoveries)
      ? finalView.discoveries
      : [];
  const narratives = Array.isArray(payload?.narratives)
    ? payload.narratives
    : Array.isArray(finalView?.narratives)
      ? finalView.narratives
      : [];
  const opportunityScore = calculateOpportunityScore(row);
  const robustnessScore = safeNum(historicalContext?.robustness, 0);

  return {
    symbol: String(row?.symbol || "").trim().toUpperCase(),

    regime: row?.regime ?? tracked?.regime ?? finalView?.regime ?? null,
    // Prefer strategyEngine output from chain; fall back to raw classification.
    type: strategy?.strategy || classifyOpportunity(row),

    hqsScore: safeNum(row?.hqs_score, safeNum(finalView?.hqsScore, 0)),
    opportunityScore,
    confidence: calculateConfidence(row, opportunityScore),

    aiScore: safeNum(finalView?.aiScore, safeNum(brain?.aiScore, 0)),
    finalConviction: safeNum(
      finalView?.finalConviction,
      safeNum(tracked?.finalConviction, 0)
    ),
    finalConfidence: safeNum(
      finalView?.finalConfidence,
      safeNum(tracked?.finalConfidence, 0)
    ),
    finalRating: finalView?.finalRating || null,
    finalDecision: finalView?.finalDecision || null,

    strategy: strategy?.strategy || null,
    strategyLabel: strategy?.strategyLabel || null,

    narratives,
    discoveries,

    trend: row?.trend ?? null,
    volatility: row?.volatility ?? null,
    resilienceScore: safeNum(
      payload?.resilienceScore,
      safeNum(finalView?.resilienceScore, 0)
    ),

    opportunityStrength: safeNum(
      orchestrator?.opportunityStrength,
      safeNum(tracked?.opportunityStrength, 0)
    ),
    orchestratorConfidence: safeNum(
      orchestrator?.orchestratorConfidence,
      safeNum(tracked?.orchestratorConfidence, 0)
    ),

    whyInteresting: Array.isArray(finalView?.whyInteresting)
      ? finalView.whyInteresting
      : [],
    reason: generateReason(row, newsContext),
    newsContext: formatOpportunityNewsContext(newsContext),
    newsAdjustment: safeNum(finalView?.components?.newsAdjustment, 0),
    signalAdjustment: safeNum(finalView?.components?.signalAdjustment, 0),
    signalContext: formatOpportunitySignalContext(signalContext),

    marketMemory: safeObject(globalContext?.marketMemory, null),
    metaLearning: safeObject(globalContext?.metaLearning, null),

    robustnessScore,
    antifragile: robustnessScore > STRESS_ANTIFRAGILE_THRESHOLD,

    // _rawScore: fresh market-data score (same as opportunityScore here since
    // fallback always recomputes from row). Used by computeDeltaContext.
    _rawScore: calculateOpportunityScore(row),

    advancedUpdatedAt: row?.advanced_updated_at
      ? new Date(row.advanced_updated_at).toISOString()
      : null,
  };
}

async function hydrateOpportunityRuntimeState() {
  await ensureRuntimePreviewStoresLoaded();

  return {
    marketMemoryKeys: Object.keys(safeObject(marketMemoryStore, {})).length,
    metaLearningKeys: Object.keys(safeObject(metaLearningStore, {})).length,
  };
}

/* =========================================================
   GUARDIAN PROTOCOL
========================================================= */

/**
 * Evaluates whether a signal should be suppressed for wealth protection.
 *
 * The robustness threshold is adjusted upward in unfavourable market clusters:
 *   Safe     → GUARDIAN_THRESHOLD_SAFE
 *   Volatile → GUARDIAN_THRESHOLD_VOLATILE
 *   Danger   → GUARDIAN_THRESHOLD_DANGER
 *
 * @param {object} opportunity  - built opportunity object
 * @param {string} marketCluster - 'Safe' | 'Volatile' | 'Danger'
 * @returns {{ suppressed: boolean, reason: string|null, threshold: number }}
 */
function executeSafetyFirst(opportunity, marketCluster = "Safe") {
  const robustness = safeNum(opportunity?.robustnessScore, 0);

  let threshold;
  switch (String(marketCluster)) {
    case "Danger":
      threshold = GUARDIAN_THRESHOLD_DANGER;
      break;
    case "Volatile":
      threshold = GUARDIAN_THRESHOLD_VOLATILE;
      break;
    default:
      threshold = GUARDIAN_THRESHOLD_SAFE;
  }

  if (robustness < threshold) {
    return {
      suppressed: true,
      reason: "Wealth Protection",
      detail: `Signal suppressed: robustness_score ${robustness.toFixed(2)} below threshold ${threshold.toFixed(2)} in ${marketCluster} market`,
      threshold,
    };
  }

  return { suppressed: false, reason: null, detail: null, threshold };
}

/* =========================================================
   HUMAN-CENTRIC INSIGHT BUILDER
========================================================= */

/**
 * Converts a raw opportunity object into a human-readable Insight.
 * The backend performs all interpretation – callers receive finished,
 * actionable conclusions rather than technical raw data.
 *
 * @param {object} opportunity
 * @param {object} guardianResult  - result of executeSafetyFirst()
 * @param {string} marketCluster   - 'Safe' | 'Volatile' | 'Danger'
 * @returns {object} insight
 */
function buildOpportunityInsight(opportunity, guardianResult, marketCluster) {
  const symbol = String(opportunity?.symbol || "").trim().toUpperCase();
  const conviction = safeNum(opportunity?.finalConviction, 0);
  const robustness = safeNum(opportunity?.robustnessScore, 0);
  const antifragile = Boolean(opportunity?.antifragile);

  // Risk level
  let riskLevel;
  if (marketCluster === "Danger" || robustness < 0.3) {
    riskLevel = "HIGH";
  } else if (marketCluster === "Volatile" || robustness < 0.55) {
    riskLevel = "MEDIUM";
  } else {
    riskLevel = "LOW";
  }

  // Human recommendation (German: system targets German-speaking users throughout)
  // Note: debateApproved is explicitly checked for `false` (not falsy) to distinguish
  // "debate voted reject" from "no debate result available" (null/undefined).
  let recommendation;
  if (guardianResult.suppressed) {
    const blockedByDebate = guardianResult.debateApproved === false;
    recommendation = blockedByDebate
      ? "Kein Analytisches Signal – Schwarmintelligenz-Konsens verweigert"
      : "Kein Analytisches Signal – Wealth Protection aktiv";
  } else if (conviction >= 80) {
    recommendation = "Starke Technische Übereinstimmung – aktiv beobachten";
  } else if (conviction >= 65) {
    recommendation = "Technische Übereinstimmung – weitere Prüfung empfohlen";
  } else if (conviction >= 50) {
    recommendation = "Analytisches Signal – Watchlist, kein sofortiger Handlungsbedarf";
  } else {
    recommendation = "Kein klares Analytisches Signal – kein Handlungsbedarf";
  }

  // Title label: distinguish Debate-blocked from robustness-blocked signals
  // debateApproved === false means the 3-agent consensus rejected; all other
  // suppressed cases are robustness / Wealth-Protection blocks.
  const suppressionLabel =
    guardianResult.suppressed && guardianResult.debateApproved === false
      ? "Schutzmodus"
      : "Wealth Protection";

  // Stability narrative
  const stabilityNote = antifragile
    ? "Das Signal hat alle Stressszenarien bestanden und gilt als antifragil."
    : robustness >= 0.55
    ? "Das Signal zeigt gute Stabilität unter Marktdruck."
    : "Das Signal reagiert empfindlich auf Marktschwankungen.";

  // Summary — include debate summary when available (Invisible Rationale)
  const existingReason = String(opportunity?.reason || "").trim();
  const debateSummary = String(guardianResult?.debateSummary || "").trim();
  let summary = existingReason
    ? `${symbol}: ${existingReason}. ${stabilityNote}`
    : `${symbol}: ${stabilityNote}`;

  if (debateSummary) {
    summary = `${summary} 🤖 Interne Debatte: ${debateSummary}`;
  }

  // Portfolio intelligence note: surface role/concentration for non-suppressed signals
  const portfolioCtx = opportunity?.portfolioContext;
  if (!guardianResult.suppressed && portfolioCtx?.portfolioRole) {
    const roleMap = {
      additive:    "Aufstockung bestehender Position",
      redundant:   "Sektor bereits im Portfolio vertreten",
      diversifier: "Ergänzt Portfolio mit neuem Sektor",
      complement:  "Ergänzt Watchlist-Abdeckung",
    };
    const roleNote = roleMap[portfolioCtx.portfolioRole];
    const concNote = portfolioCtx.concentrationRisk === "high"
      ? " – Konzentrationsrisiko erhöht"
      : portfolioCtx.concentrationRisk === "medium"
      ? " – Sektorgewicht prüfen"
      : "";
    if (roleNote) {
      summary = `${summary} 📊 Portfolio: ${roleNote}${concNote}.`;
    }
  }

  // Inter-market warning note
  if (guardianResult.interMarketWarning) {
    summary += " ⚠️ Frühwarnung: BTC und Gold zeigen gleichzeitig Risikoabbau.";
  }

  return {
    title: guardianResult.suppressed
      ? `${symbol} – Gesperrt (${suppressionLabel})`
      : `${symbol} – ${opportunity?.finalRating || "Signal erkannt"}`,
    summary,
    recommendation,
    riskLevel,
    marketClimate: marketCluster,
    protectionStatus: guardianResult.suppressed
      ? {
          active: true,
          reason: guardianResult.reason,
          detail: guardianResult.detail,
          debateApproved: guardianResult.debateApproved ?? null,
          debateSummary: debateSummary || null,
        }
      : { active: false },
    debate: guardianResult.debateVotes
      ? {
          approved: guardianResult.debateApproved,
          approvalCount: Object.values(guardianResult.debateVotes).filter(
            (v) => v?.vote === "approve"
          ).length,
          summary: debateSummary || null,
        }
      : null,
    interMarketWarning: Boolean(guardianResult.interMarketWarning),
    robustnessScore: Number(robustness.toFixed(2)),
    antifragile,
    finalConviction: Number(conviction.toFixed(1)),
  };
}

/* =========================================================
   MAIN SERVICE
========================================================= */

async function getTopOpportunities(arg = 10) {
  let options;

  if (typeof arg === "object" && arg !== null) {
    options = arg;
  } else {
    options = { limit: Number(arg) || 10 };
  }

  const limit = clamp(Number(options.limit || 10), 1, 25);

  const minHqs =
    options.minHqs === null || options.minHqs === undefined
      ? null
      : clamp(Number(options.minHqs), 0, 100);

  const regime =
    options.regime
      ? String(options.regime).trim().toLowerCase()
      : null;

  // Step 6 Block 2: optional per-user preference hints from the caller (e.g. route handler).
  // Null-safe: the scanner runs without user context by default – hints are purely additive.
  const userPreferenceHints =
    options.userPreferenceHints && typeof options.userPreferenceHints === "object"
      ? options.userPreferenceHints
      : null;

  const res = await pool.query(`
    WITH latest_hqs AS (
      SELECT DISTINCT ON (symbol)
        symbol,
        hqs_score,
        momentum,
        quality,
        stability,
        relative,
        regime,
        created_at
      FROM hqs_scores
      ORDER BY symbol, created_at DESC
    )

    SELECT
      h.symbol,
      h.hqs_score,
      h.momentum,
      h.quality,
      h.stability,
      h.relative,
      COALESCE(h.regime, m.regime) AS regime,

      COALESCE(m.volatility_annual, m.volatility_daily, 0) AS volatility,

      m.trend,
      m.scenarios,
      m.updated_at AS advanced_updated_at

    FROM latest_hqs h
    LEFT JOIN market_advanced_metrics m
      ON m.symbol = h.symbol

    ORDER BY h.hqs_score DESC
    LIMIT 250
  `);

  let rows = res.rows || [];

  if (minHqs !== null) {
    rows = rows.filter((r) => safeNum(r.hqs_score, 0) >= minHqs);
  }

  if (regime) {
    rows = rows.filter(
      (r) => String(r.regime || "").toLowerCase() === regime
    );
  }

  let persistedOutcomeBySymbol = {};
  if (rows.length) {
    try {
      persistedOutcomeBySymbol = await loadLatestOutcomeTrackingBySymbols(
        rows.map((row) => row.symbol)
      );
    } catch (error) {
      logger.warn("Opportunity batch result load failed", {
        message: error.message,
      });
    }
  }

  // Step 6: Adaptive signal hook – load recommendation outcomes for all candidate
  // symbols in one batch query. Attached as adaptiveSignalHints per opportunity.
  // Non-blocking: errors are silently swallowed so the rest of the pipeline is unaffected.
  let recommendationOutcomeBySymbol = {};
  if (rows.length) {
    try {
      recommendationOutcomeBySymbol = await computeRecommendationOutcomeBySymbols(
        rows.map((row) => row.symbol)
      );
    } catch (_rcErr) {
      // Defensive: adaptive signals are optional – pipeline continues without them.
    }
  }

  const opportunities = rows.map((row) => {
    const normalizedSymbol = String(row?.symbol || "").trim().toUpperCase();
    const persistedOpportunity = buildOpportunityFromBatchResult(
      row,
      persistedOutcomeBySymbol?.[normalizedSymbol] || null
    );

    if (persistedOpportunity) {
      return persistedOpportunity;
    }

    return buildFallbackOpportunity(
      row,
      persistedOutcomeBySymbol?.[normalizedSymbol] || null
    );
  });

  const persistedCount = rows.filter((row) => {
    const normalizedSymbol = String(row?.symbol || "").trim().toUpperCase();
    return hasPersistedBatchResult(persistedOutcomeBySymbol?.[normalizedSymbol]);
  }).length;
  const fallbackCount = Math.max(0, opportunities.length - persistedCount);

  opportunities.sort((a, b) => {
    if (b.finalConviction !== a.finalConviction) {
      return b.finalConviction - a.finalConviction;
    }

    if (b.finalConfidence !== a.finalConfidence) {
      return b.finalConfidence - a.finalConfidence;
    }

    return b.hqsScore - a.hqsScore;
  });

  // ── Step 4: Personalized Decision Layer ─────────────────────────────────
  // One round-trip: load open virtual positions + watchlist membership for all
  // candidate symbols, then merge portfolio context into each opportunity.
  // Graceful fallback: context defaults to unknown when DB is unavailable.
  let portfolioCtxMap = new Map();
  try {
    portfolioCtxMap = await buildPortfolioContextForSymbols(
      opportunities.map((o) => o.symbol)
    );
  } catch (ctxErr) {
    logger.warn("getTopOpportunities: portfolio context load failed – continuing without", {
      message: ctxErr.message,
    });
  }
  const opportunitiesWithCtx = opportunities.map((o) =>
    enrichWithPortfolioContext(o, portfolioCtxMap)
  );

  // ── Step 4b: Delta/Change Context ───────────────────────────────────────
  // Compute per-symbol change signals using already-loaded outcome_tracking data
  // (persistedOutcomeBySymbol) and the fresh raw market score (_rawScore).
  // No extra DB calls. Attaches deltaContext to each opportunity.
  // ── Step 4c: Next Action Layer ───────────────────────────────────────────
  // Derive a concrete next action hint per opportunity using already-computed
  // portfolio context and fresh delta signals. No extra DB calls.
  const opportunitiesWithDelta = opportunitiesWithCtx.map((o) => {
    const tracked     = persistedOutcomeBySymbol?.[o.symbol] || null;
    const deltaContext = computeDeltaContext(o, tracked);
    const nextAction   = computeNextAction({ ...o, deltaContext });
    // Step 5: Derive user attention level from combined portfolio/delta/action signals.
    // Simple transparent rules – first match wins (see computeUserAttentionLevel).
    const pCtx = o.portfolioContext || {};
    const attention = computeUserAttentionLevel({
      alreadyOwned:      Boolean(pCtx.alreadyOwned),
      onWatchlist:       Boolean(pCtx.onWatchlist),
      concentrationRisk: pCtx.concentrationRisk  || "none",
      deltaPriority:     deltaContext.deltaPriority || "stable",
      portfolioPriority: pCtx.portfolioPriority   || "medium",
      actionPriority:    nextAction.actionPriority || "low",
      changesPercentage: safeNum(o.changesPercentage ?? o.changePercent, 0),
      hqsScore:          safeNum(o.hqsScore, 50),
    });
    // Step 5b: Action-Orchestration – derive HOW to treat this opportunity
    // (deliveryMode, escalationLevel, followUpNeeded, reviewWindow) from the
    // already-computed attention level, next action and delta context.
    const oppWithAttention = { ...o, deltaContext, nextAction, userAttentionLevel: attention.level, attentionReason: attention.reason };
    const actionOrchestration = computeActionOrchestration(oppWithAttention);
    // Step 6: Adaptive signal hook – attach recommendation outcome from evaluated
    // outcome_tracking history. This is an informational hook; no scoring changes.
    const rcOutcome = recommendationOutcomeBySymbol?.[o.symbol] || null;
    const adaptiveSignalHints = rcOutcome ? {
      recommendationOutcome:  rcOutcome.recommendationOutcome,
      avgActualReturn:        rcOutcome.avgActualReturn,
      successRate:            rcOutcome.successRate,
      outcomeDataAvailable:   true,
      outcomeSampleSize:      rcOutcome.sampleSize,
    } : { outcomeDataAvailable: false };
    // Step 6 Block 3: Compute adaptive priority layer from all available per-user
    // and outcome signals. Attaches boost + reason + delivery fit + adjusted priority.
    // Supersedes _userAffinityBonus in the sort – includes more signals at same ±3 range.
    const oppFull = { ...oppWithAttention, actionOrchestration, adaptiveSignalHints };
    const adaptivePriority = _computeAdaptivePriorityLayer(oppFull, userPreferenceHints);
    // Step 7 Block 1: compute action-readiness tier (classification only, no execution)
    const actionReadiness = computeActionReadiness(oppFull);
    // Step 7 Block 2: derive approval-queue entry (collection/prioritisation layer)
    const approvalQueueEntry = computeApprovalQueueEntry({ ...oppFull, actionReadiness });
    // Step 7 Block 3: derive decision layer – concrete decision state for review/approval cases
    const decisionLayer = computeDecisionLayer({ ...oppFull, actionReadiness, approvalQueueEntry });
    // Step 7 Block 4: derive controlled approval flow – next controlled follow-up step after decision
    const controlledApprovalFlow = computeControlledApprovalFlow({ ...oppFull, actionReadiness, decisionLayer });
    return { ...oppFull, ...adaptivePriority, actionReadiness, approvalQueueEntry, decisionLayer, controlledApprovalFlow };
  });

  // Portfolio-intelligence + delta-aware + adaptive priority re-sort.
  // Conviction/confidence still dominate; combined bonus is ±3–10 pts.
  // adaptivePriorityBoost (Step 6 Block 3) is pre-computed per opportunity;
  // it incorporates riskSensitivity, explorationAffinity, outcome quality,
  // notificationFatigue, and opportunitySeeker signals (max ±3).
  opportunitiesWithDelta.sort((a, b) => {
    const aAdj = safeNum(a.finalConviction, safeNum(a.hqsScore, 0))
      + _portfolioIntelligenceBonus(a.portfolioContext)
      + _deltaPriorityBonus(a.deltaContext)
      + safeNum(a.adaptivePriorityBoost, 0);  // Step 6 Block 3: pre-computed adaptive layer
    const bAdj = safeNum(b.finalConviction, safeNum(b.hqsScore, 0))
      + _portfolioIntelligenceBonus(b.portfolioContext)
      + _deltaPriorityBonus(b.deltaContext)
      + safeNum(b.adaptivePriorityBoost, 0);  // Step 6 Block 3: pre-computed adaptive layer
    if (bAdj !== aAdj) return bAdj - aAdj;
    if (b.finalConfidence !== a.finalConfidence) return b.finalConfidence - a.finalConfidence;
    return safeNum(b.hqsScore, 0) - safeNum(a.hqsScore, 0);
  });

  // ── World State: single source of global market truth ───────────────────
  // Replaces three individual async calls (regime, inter-market, agent weights)
  // with one unified getWorldState() lookup that is already cached in-memory.
  // Also exposes orchestrator_global, capital_flow_summary, and news_pulse for
  // use by debate/guardian/insight building.
  // Falls back to direct service calls if world_state is unavailable.
  let marketRegime = { cluster: "Safe", capturedAt: new Date().toISOString() };
  let interMarketData = null;
  let agentWeights = null;
  let orchestratorGlobal = null;
  let capitalFlowSummary = null;
  let globalNewsPulse = null;
  let riskMode = "neutral";
  let uncertainty = 0;

  try {
    const ws = await getWorldState();
    const _wsFreshness = classifyWorldStateAge(ws);
    if (_wsFreshness === "hard_stale") {
      // Hard-stale: do not use as authoritative input – trigger the fallback below.
      logger.warn(
        "getTopOpportunities: world_state is hard_stale – falling back to direct service calls",
        { created_at: ws?.created_at }
      );
      throw new Error("world_state hard_stale – defensive fallback active");
    }
    if (_wsFreshness === "stale") {
      logger.warn(
        "getTopOpportunities: world_state is stale – using with degraded trust",
        { created_at: ws?.created_at }
      );
    }
    marketRegime = {
      cluster:      ws.regime.cluster,
      avgHqs:       ws.regime.avgHqs,
      bearRatio:    ws.regime.bearRatio,
      highVolRatio: ws.regime.highVolRatio,
      totalSymbols: ws.regime.totalSymbols,
      capturedAt:   ws.created_at,
    };
    interMarketData = {
      btc:          ws.cross_asset_state.btc,
      gold:         ws.cross_asset_state.gold,
      earlyWarning: ws.cross_asset_state.earlyWarning,
      timestamp:    ws.created_at,
    };
    agentWeights        = ws.agent_calibration.weights;
    orchestratorGlobal  = ws.orchestrator_global  || null;
    capitalFlowSummary  = ws.capital_flow_summary  || null;
    globalNewsPulse     = ws.news_pulse            || null;
    riskMode            = ws.risk_mode             || "neutral";
    uncertainty         = safeNum(ws.uncertainty, 0);
  } catch (wsErr) {
    logger.warn(
      "getTopOpportunities: world_state unavailable – falling back to direct service calls",
      { message: wsErr.message }
    );
    // Fallback: call the individual services directly (pre-world_state behaviour)
    try {
      marketRegime = await classifyMarketRegime();
    } catch (_) { /* default Safe stays */ }
    try {
      interMarketData = await getInterMarketCorrelation();
    } catch (_) { /* continues without cross-asset data */ }
    try {
      agentWeights = await getAgentWeights();
    } catch (_) { /* agentWeights stays null – debate uses its internal defaults */ }
  }

  const marketCluster = marketRegime.cluster;

  // ── Agentic Debate + Guardian Protocol + Insight building ───────────────
  let suppressedCount = 0;
  let debateBlockedCount = 0;
  const withInsights = await Promise.all(opportunitiesWithDelta.map(async (opp) => {
    // 1. Meta-Rationale: historical context for this symbol
    let metaRationale = null;
    try {
      metaRationale = await buildMetaRationale(opp.symbol);
    } catch (_) {
      // non-critical – continue without meta-rationale
    }

    // 1b. Sector Coherence: check whether sector alert is active for this symbol
    const sectorThresholds = getSharpenedThresholds(opp.symbol);

    // 1c. Pattern Memory: derive structured key for this opportunity's signal setup
    //     and look up historical performance statistics for identical setups.
    let patternContext = null;
    try {
      const { patternKey } = buildStructuredPatternSignature({
        regime:          opp.regime,
        volatility:      opp.volatility,
        trendStrength:   opp.signalContext?.trendScore,
        sentimentScore:  opp.signalContext?.sentimentScore,
        newsDirection:   opp.newsContext?.direction,
        buzzScore:       opp.signalContext?.buzzScore,
        signalDirection: opp.signalContext?.signalDirection,
        robustnessScore: opp.robustnessScore,
        hqsScore:        opp.hqsScore,
        finalConviction: opp.finalConviction,
      });
      patternContext = await getPatternStats(patternKey);
    } catch (_) {
      // non-critical – continue without pattern context
    }

    // 2. Run the three-agent debate (GROWTH_BIAS, RISK_SKEPTIC, MACRO_JUDGE)
    const debateResult = runAgenticDebate(
      opp,
      marketCluster,
      opp.signalContext || null,
      interMarketData,
      {
        dynamicWeights: agentWeights,
        metaRationale,
        sectorAlert: sectorThresholds.sectorAlert,
        patternContext,
      }
    );

    // 3. Guardian Protocol robustness check
    const guardianResult = executeSafetyFirst(opp, marketCluster);

    // Signal is suppressed if EITHER debate or Guardian blocks it
    const debateBlocked = !debateResult.approved;
    const suppressed = debateBlocked || guardianResult.suppressed;

    if (suppressed) {
      suppressedCount++;
      if (debateBlocked && !guardianResult.suppressed) debateBlockedCount++;
    }

    // Augment guardianResult with debate context for insight and rationale
    const enrichedGuardian = {
      ...guardianResult,
      suppressed,
      debateApproved: debateResult.approved,
      debateSummary: debateResult.debateSummary,
      debateVotes: debateResult.votes,
      interMarketWarning: Boolean(interMarketData?.earlyWarning),
      // Global orchestrator risk mode from world_state (available when present)
      globalRiskMode: orchestratorGlobal?.riskMode?.mode || null,
    };

    const insight = buildOpportunityInsight(opp, enrichedGuardian, marketCluster);

    // Fire-and-forget audit log
    const tracked = persistedOutcomeBySymbol?.[opp.symbol] || null;
    const rawSnap = tracked?.raw_input_snapshot || null;
    const auditSnapshot = rawSnap || {
      hqsScore: opp.hqsScore,
      robustnessScore: opp.robustnessScore,
      finalConviction: opp.finalConviction,
      regime: opp.regime,
      capturedAt: new Date().toISOString(),
    };

    // Fire-and-forget: log per-agent 24h forecasts for Prediction-Self-Audit
    logAgentForecasts({
      symbol: opp.symbol,
      marketCluster,
      debateApproved: debateResult.approved,
      entryPrice: opp.entryPrice || null,
      votes: debateResult.votes,
    }).catch((fErr) => {
      logger.warn("getTopOpportunities: agent forecast log failed", {
        symbol: opp.symbol,
        message: fErr.message,
      });
    });

    recordAutonomyDecision({
      symbol: opp.symbol,
      decisionType: "opportunity_signal",
      decisionValue: suppressed
        ? "SUPPRESSED"
        : opp.finalDecision || "EVALUATED",
      marketCluster,
      robustnessScore: safeNum(opp.robustnessScore, 0),
      guardianApplied: true,
      suppressed,
      suppressionReason: suppressed
        ? (debateBlocked ? "Debate Consensus Failed" : "Kapitalschutz-Aktion")
        : null,
      rawInputSnapshot: {
        ...auditSnapshot,
        debate: {
          approved: debateResult.approved,
          approvalCount: debateResult.approvalCount,
          summary: debateResult.debateSummary,
        },
        interMarket: interMarketData
          ? {
              earlyWarning: interMarketData.earlyWarning,
              btcSignal: interMarketData.btc?.signal || null,
              goldSignal: interMarketData.gold?.signal || null,
            }
          : null,
      },
    }).catch((auditErr) => {
      logger.warn("getTopOpportunities: audit log failed", {
        symbol: opp.symbol,
        message: auditErr.message,
      });
    });

    // Virtual Capital Protector: log near-miss for blocked signals
    if (suppressed) {
      logNearMiss({
        symbol: opp.symbol,
        marketCluster,
        robustnessScore: safeNum(opp.robustnessScore, 0),
        entryPriceRef: null,
        debateApproved: debateResult.approved,
        debateSummary: debateResult.debateSummary,
        debateResult: {
          approved: debateResult.approved,
          approvalCount: debateResult.approvalCount,
          votes: debateResult.votes,
        },
      }).catch((nmErr) => {
        logger.warn("getTopOpportunities: near-miss log failed", {
          symbol: opp.symbol,
          message: nmErr.message,
        });
      });
    }

    return {
      ...opp,
      suppressed,
      suppressionReason: suppressed
        ? (debateBlocked ? "Debate Consensus Failed" : "Kapitalschutz-Aktion")
        : null,
      debateResult: {
        approved: debateResult.approved,
        approvalCount: debateResult.approvalCount,
        debateSummary: debateResult.debateSummary,
      },
      insight,
      // Pass sector-alert flag to the Capital Allocation Layer
      sectorAlert: sectorThresholds.sectorAlert,
    };
  }));

  // Keep only non-suppressed signals in the final output (guardian enforcement)
  // Capital Allocation runs on ALL non-suppressed candidates BEFORE the limit-slice
  // so the budget logic can reject weaker signals and keep capacity for stronger ones.
  const candidates = withInsights.filter((opp) => !opp.suppressed);

  // ── Capital Allocation Layer ─────────────────────────────────────────────
  // Pure, O(n) budget distribution. No DB calls. Falls back gracefully.
  // maxPositions is set to 2× the requested limit so the allocation engine
  // has a larger candidate pool to work with: it can reject weaker signals
  // and still fill up to `limit` approved positions in the final slice.
  const ALLOC_MIN_POSITIONS = 5;   // floor: always consider at least 5 candidates
  const ALLOC_MAX_POSITIONS = 20;  // ceiling: cap to avoid over-allocating budget

  let allocatedCandidates = candidates;
  let budgetSummary       = null;
  try {
    const allocResult = applyCapitalAllocation(
      candidates,
      { riskMode, uncertainty },
      {
        totalBudgetEur: safeNum(Number(process.env.ALLOCATION_BUDGET_EUR), 10000),
        maxPositions:   clamp(limit * 2, ALLOC_MIN_POSITIONS, ALLOC_MAX_POSITIONS),
      }
    );
    allocatedCandidates = allocResult.opportunities;
    budgetSummary       = allocResult.budgetSummary;
  } catch (allocErr) {
    logger.warn("getTopOpportunities: capital allocation layer failed – returning without allocation fields", {
      message: allocErr.message,
    });
  }

  // ── Portfolio Twin Stage 2: auto live-integration ───────────────────────
  // For every allocation-approved candidate with positionSizeEur > 0,
  // attempt to open a virtual position (sequential to avoid DB pool pressure).
  // Duplicate guard: skip if an open position for the symbol already exists.
  // Can be disabled via PORTFOLIO_TWIN_AUTO_OPEN=false env var.
  const autoOpenEnabled = process.env.PORTFOLIO_TWIN_AUTO_OPEN !== "false";
  const virtualOpenResults = [];
  for (const opp of allocatedCandidates) {
    // Gate 0: feature flag
    if (!autoOpenEnabled) {
      virtualOpenResults.push({ symbol: opp.symbol, virtualPositionOpened: false, virtualPositionSkippedReason: "autoOpenDisabled" });
      continue;
    }

    // Gate 1: only approved allocations
    if (!opp.allocationApproved) {
      logger.debug("portfolioTwin: skip – allocationApproved=false", { symbol: opp.symbol });
      virtualOpenResults.push({ symbol: opp.symbol, virtualPositionOpened: false, virtualPositionSkippedReason: "allocationApproved=false" });
      continue;
    }

    // Gate 2: must have positive position size
    const positionSizeEur = safeNum(opp.positionSizeEur, 0);
    if (positionSizeEur <= 0) {
      logger.debug("portfolioTwin: skip – positionSizeEur<=0", { symbol: opp.symbol });
      virtualOpenResults.push({ symbol: opp.symbol, virtualPositionOpened: false, virtualPositionSkippedReason: "positionSizeEur<=0" });
      continue;
    }

    // Gate 3: must have a valid entry price
    const entryPrice = safeNum(opp.entryPrice, 0);
    if (entryPrice <= 0) {
      logger.debug("portfolioTwin: skip – entryPrice not available", { symbol: opp.symbol });
      virtualOpenResults.push({ symbol: opp.symbol, virtualPositionOpened: false, virtualPositionSkippedReason: "entryPriceMissing" });
      continue;
    }

    // Gate 4: duplicate guard – skip if open position already exists
    try {
      const alreadyOpen = await hasOpenVirtualPosition(opp.symbol);
      if (alreadyOpen) {
        logger.info("portfolioTwin: skip – open position already exists", { symbol: opp.symbol });
        virtualOpenResults.push({ symbol: opp.symbol, virtualPositionOpened: false, virtualPositionSkippedReason: "alreadyOpen" });
        continue;
      }
    } catch (guardErr) {
      logger.warn("portfolioTwin: duplicate guard check failed – skipping open", {
        symbol: opp.symbol, message: guardErr.message,
      });
      virtualOpenResults.push({ symbol: opp.symbol, virtualPositionOpened: false, virtualPositionSkippedReason: "guardCheckFailed" });
      continue;
    }

    // All gates passed – open the virtual position
    try {
      await openVirtualPositionFromAllocation({
        symbol:             opp.symbol,
        entryPrice,
        allocatedEur:       positionSizeEur,
        allocatedPct:       safeNum(opp.positionSizePct, 0),
        convictionTier:     opp.convictionTier     || null,
        riskModeAtEntry:    riskMode               || null,
        uncertaintyAtEntry: uncertainty,
        sourceRunId:        opp.sourceRunId        || null,
      });
      logger.info("portfolioTwin: virtual position opened via scanner flow", {
        symbol: opp.symbol, entryPrice, positionSizeEur,
      });
      virtualOpenResults.push({ symbol: opp.symbol, virtualPositionOpened: true });
    } catch (openErr) {
      logger.warn("portfolioTwin: openVirtualPositionFromAllocation failed", {
        symbol: opp.symbol, message: openErr.message,
      });
      virtualOpenResults.push({ symbol: opp.symbol, virtualPositionOpened: false, virtualPositionSkippedReason: openErr.message });
    }
  }

  // Attach virtualPositionOpened / virtualPositionSkippedReason to each candidate
  const vpBySymbol = Object.fromEntries(
    virtualOpenResults.map((r) => [r.symbol, r])
  );
  const allocatedWithVp = allocatedCandidates.map((opp) => {
    const vr = vpBySymbol[opp.symbol];
    if (!vr) return opp;
    const extra = { virtualPositionOpened: vr.virtualPositionOpened };
    if (!vr.virtualPositionOpened && vr.virtualPositionSkippedReason) {
      extra.virtualPositionSkippedReason = vr.virtualPositionSkippedReason;
    }
    return { ...opp, ...extra };
  });

  const out = allocatedWithVp.slice(0, limit);

  logger.info("getTopOpportunities", {
    limit,
    minHqs,
    regime,
    marketCluster,
    riskMode,
    uncertainty:             Number(uncertainty.toFixed(2)),
    persistedCount,
    fallbackCount,
    suppressedCount,
    debateBlockedCount,
    interMarketWarning:      Boolean(interMarketData?.earlyWarning),
    orchestratorGlobalMode:  orchestratorGlobal?.riskMode?.mode || null,
    capitalFlowBullish:      capitalFlowSummary?.flowSummary?.bullish ?? null,
    newsPulseDirection:      globalNewsPulse?.direction || null,
    allocationApproved:      budgetSummary ? budgetSummary.approvedPositions : null,
    budgetConsumedPct:       budgetSummary ? budgetSummary.consumedBudgetPct : null,
    virtualPositionsOpened:  virtualOpenResults.filter((r) => r.virtualPositionOpened).length,
    userAffinityActive:      userPreferenceHints ? userPreferenceHints.riskSensitivity || null : null,
    adaptivePriorityLayer:   userPreferenceHints ? "block3_active" : null,
    returned: out.length,
  });

  return out;
}

module.exports = {
  buildSignalContext,
  hydrateOpportunityRuntimeState,
  loadOpportunityNewsContextBySymbols,
  getTopOpportunities,
  simulateMarketStress,
  calculateRobustnessScore,
  executeSafetyFirst,
  buildOpportunityInsight,
  computeActionOrchestration,
  computeActionReadiness,
  computeApprovalQueueEntry,
  computeDecisionLayer,
};
