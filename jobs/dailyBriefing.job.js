"use strict";

require("dotenv").config();

const logger = require("../utils/logger");
const { acquireLock, initJobLocksTable } = require("../services/jobLock.repository");
const { runJob } = require("../utils/jobRunner");
const { getMarketData } = require("../services/marketService");

const {
  getActiveBriefingUsers,
  getUserWatchlistSymbols,
  createNotificationOncePerDay, // ✅ NEW (anti spam)
  computeUserAttentionLevel,    // ✅ Step 5: attention-level priority
  computeUserState,             // ✅ Step 5 User-State: consolidated state for briefing prioritization
  getOpenFollowUps,             // ✅ Step 5 Follow-up: open follow-ups for review-due boost
  computeUserPreferenceHints,   // ✅ Step 6 Block 2: per-user preference hints
} = require("../services/notifications.repository");

// ✅ OpenAI
const { generateBriefingText } = require("../services/openai.service");

// Read stored discovery picks (written by discoveryNotify job) – no re-scoring
let getLatestDiscoveryPick = null;
try {
  ({ getLatestDiscoveryPick } = require("../services/discoveryEngine.service"));
} catch (_) {
  getLatestDiscoveryPick = null;
}

// ── Attention level ordering ─────────────────────────────────────────────────
const ATTENTION_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

// Step 7 Block 1: Action-Readiness ordering for briefing sort (lower = higher priority).
const ACTION_READINESS_RANK = { review_required: 0, proposal_ready: 1, monitor_only: 2, insufficient_confidence: 3 };

// Step 7 Block 3: Decision-Status ordering for briefing sort (lower = higher priority).
// approved_candidate tops the list as it has a clear decision state, followed by pending_review.
const DECISION_STATUS_RANK = { approved_candidate: 0, pending_review: 1, deferred_review: 2, needs_more_data: 3 };

// Thresholds for stock attention classification based on daily price change and HQS score.
// A significant DROP (≤ -5%) on a scored stock (≥ 55) triggers a high-attention risk alert.
// A significant GAIN (≥ +5%) on a strong-score stock (≥ 65) triggers a medium/high alert.
const ATTENTION_DROP_THRESHOLD     = -5;   // % daily change (negative)
const ATTENTION_GAIN_THRESHOLD     =  5;   // % daily change (positive)
const ATTENTION_DROP_MIN_SCORE     = 55;   // min HQS score for drop alert
const ATTENTION_GAIN_MIN_SCORE     = 65;   // min HQS score for gain alert

/**
 * Compute a simple attention level for a stock using available market data.
 * Uses hqsScore and changesPercentage (already in getMarketData response).
 * No extra DB calls.
 */
function _stockAttentionLevel(stock) {
  const change = Math.abs(Number(stock.changesPercentage) || 0);
  const score  = Number(stock.hqsScore) || 50;

  // High: significant drop on scored stock → risk alert
  if ((Number(stock.changesPercentage) || 0) <= ATTENTION_DROP_THRESHOLD && score >= ATTENTION_DROP_MIN_SCORE) {
    return computeUserAttentionLevel({ actionPriority: "high", changesPercentage: stock.changesPercentage, hqsScore: score });
  }
  // Medium/High: strong upward move on high-score stock
  if (change >= ATTENTION_GAIN_THRESHOLD && score >= ATTENTION_GAIN_MIN_SCORE) {
    return computeUserAttentionLevel({ portfolioPriority: "high", changesPercentage: stock.changesPercentage, hqsScore: score });
  }
  // General: pass through available signals
  return computeUserAttentionLevel({ changesPercentage: stock.changesPercentage, hqsScore: score });
}

/**
 * Derive a minimal Action-Orchestration for a briefing stock using only the
 * already-computed attention level. No extra DB calls.
 *
 * This maps attention level → escalation/deliveryMode for briefing ordering.
 *
 * escalationLevel: 'high' | 'medium' | 'none'
 * followUpNeeded:  boolean – whether the stock warrants explicit follow-up
 * deliveryMode:    'briefing_and_notification' | 'briefing' | 'passive_briefing' | 'none'
 */
function _deriveBriefingOrchestration(stock) {
  const level = stock._attentionLevel || "low";

  if (level === "critical") {
    return { escalationLevel: "high", followUpNeeded: true, deliveryMode: "briefing_and_notification" };
  }
  if (level === "high") {
    return { escalationLevel: "high", followUpNeeded: false, deliveryMode: "briefing_and_notification" };
  }
  if (level === "medium") {
    return { escalationLevel: "medium", followUpNeeded: false, deliveryMode: "briefing" };
  }
  return { escalationLevel: "none", followUpNeeded: false, deliveryMode: "passive_briefing" };
}

/**
 * Sort value for briefing order using Action-Orchestration.
 * Lower = higher priority (appears first in briefing).
 *   0 – review-due follow-up + high escalation (highest urgency)
 *   1 – review-due follow-up + medium escalation
 *   2 – high escalation + follow-up needed (critical risk)
 *   3 – high escalation
 *   4 – medium escalation + follow-up (portfolio/risk change)
 *   5 – medium escalation
 *   6 – attention-based fallback (low/none escalation)
 *
 * @param {object} stock
 * @param {boolean} [userHasOpenFollowUps=false] – true when user has unresolved follow-ups
 */
function _briefingOrchestrationRank(stock, userHasOpenFollowUps = false) {
  const orch = stock._orchestration || {};
  // Review-due follow-ups rank highest when the user has open follow-ups to resolve
  if (userHasOpenFollowUps && orch.followUpNeeded) {
    if (orch.escalationLevel === "high") return 0;
    if (orch.escalationLevel === "medium") return 1;
    return 2;
  }
  if (orch.escalationLevel === "high" && orch.followUpNeeded) return 2;
  if (orch.escalationLevel === "high") return 3;
  if (orch.escalationLevel === "medium" && orch.followUpNeeded) return 4;
  if (orch.escalationLevel === "medium") return 5;
  return 6;
}

/**
 * Build a brief orchestration label for a stock's fact line.
 * Returns empty string for passive/none delivery modes (no clutter for routine stocks).
 */
function _buildOrchLabel(orch) {
  if (!orch?.deliveryMode) return "";
  if (orch.deliveryMode === "passive_briefing" || orch.deliveryMode === "none") return "";
  const followUp = orch.followUpNeeded ? " · Follow-up empfohlen" : "";
  return `, Behandlung: ${orch.deliveryMode}${followUp}`;
}

/**
 * Step 7 Block 1: Derive a brief action-readiness tier for a briefing stock from its
 * already-computed orchestration and attention level. No extra DB calls.
 *
 * "review_required" → critical/high escalation signals
 * "proposal_ready"  → medium escalation + notification-mode delivery
 * "monitor_only"    → passive/none delivery (default for routine stocks)
 */
function _deriveBriefingActionReadiness(stock) {
  const orch  = stock._orchestration || {};
  const level = stock._attentionLevel || "low";
  if (level === "critical" || orch.escalationLevel === "high") return "review_required";
  if (orch.escalationLevel === "medium" &&
      (orch.deliveryMode === "briefing_and_notification" || orch.deliveryMode === "notification")) {
    return "proposal_ready";
  }
  return "monitor_only";
}

/**
 * Step 7 Block 2: Derive the approval-queue bucket for a briefing stock from its
 * already-computed action-readiness tier and orchestration. No extra DB calls.
 *
 * Returns a short label string for briefing display or null for monitor_only.
 */
function _deriveBriefingApprovalBucket(stock) {
  const ar   = stock._actionReadiness  || "monitor_only";
  const orch = stock._orchestration    || {};
  if (ar === "review_required") {
    // High-escalation with follow-up needed → risk review; otherwise proposal-level
    return orch.followUpNeeded ? "risk_review" : "proposal_bucket";
  }
  if (ar === "proposal_ready") return "proposal_bucket";
  return null;
}

// Step 7 Block 3: Decision-status thresholds for briefing derivation
const BRIEFING_DS_STRONG_SCORE = 65;   // HQS score threshold for approved_candidate in briefing
const BRIEFING_DS_WEAK_SCORE   = 45;   // HQS score threshold below which needs_more_data applies

/**
 * Step 7 Block 3: Derive a brief decision status for a briefing stock from its
 * already-computed action-readiness, attention, and orchestration signals.
 * No extra DB calls. Returns null for non-review cases.
 *
 * Maps review_required cases into: approved_candidate, pending_review, needs_more_data
 * based on available signal strength (HQS score as proxy for conviction in briefing context).
 */
function _deriveBriefingDecisionStatus(stock) {
  const ar    = stock._actionReadiness  || "monitor_only";
  const level = stock._attentionLevel   || "low";
  const score = Number(stock.hqsScore ?? 0);

  if (ar !== "review_required") return null;

  // Strong score + non-critical attention → approved_candidate
  if (score >= BRIEFING_DS_STRONG_SCORE && level !== "critical") return "approved_candidate";
  // Weak score → needs_more_data
  if (score < BRIEFING_DS_WEAK_SCORE) return "needs_more_data";
  // Default → pending_review
  return "pending_review";
}

// Step 7 Block 4: Controlled Approval Flow derivation for briefing stocks.
// Maps decision status to the next controlled follow-up classification.
// No execution – only language and ordering context for the briefing.
const APPROVAL_FLOW_STATUS_RANK = {
  approved_pending_action: 0,
  awaiting_review: 1,
  deferred: 2,
  waiting_for_more_data: 3,
  closed: 4,
  proposal_available: 5,
};
const APPROVAL_FLOW_UNRANKED = 6;

const APPROVAL_FLOW_LABELS = {
  approved_pending_action: "🟢 Bereit zur manuellen Aktion",
  awaiting_review:         "⏳ Wartet auf Prüfung",
  deferred:                "⏸ Zurückgestellt",
  waiting_for_more_data:   "📊 Mehr Daten nötig",
  closed:                  "🔴 Abgeschlossen",
  proposal_available:      "📝 Vorschlag verfügbar",
};

function _deriveBriefingApprovalFlowStatus(stock) {
  const ds = stock._decisionStatus;
  if (!ds) {
    // proposal_ready without decision → proposal available
    if (stock._actionReadiness === "proposal_ready") return "proposal_available";
    return null;
  }
  if (ds === "approved_candidate")  return "approved_pending_action";
  if (ds === "rejected_candidate")  return "closed";
  if (ds === "deferred_review")     return "deferred";
  if (ds === "needs_more_data")     return "waiting_for_more_data";
  if (ds === "pending_review")      return "awaiting_review";
  return null;
}

/**
 * Step 7 Block 5: Derive compact audit/safety hints for a briefing stock from its
 * already-computed internal governance signals. No extra DB calls.
 *
 * Returns: { governanceStatus, traceReason, blockedByGuardrail }
 */
function _deriveBriefingAuditHints(stock) {
  const ar    = stock._actionReadiness  || "monitor_only";
  const ds    = stock._decisionStatus   || null;
  const afs   = stock._approvalFlowStatus || null;
  const level = stock._attentionLevel   || "low";

  // governanceStatus: derived from readiness + decision state
  let governanceStatus = "observation";
  if (ar === "review_required")                                    governanceStatus = "review_controlled";
  else if (ar === "proposal_ready")                                governanceStatus = "proposal_available";
  else if (ar === "insufficient_confidence" || ds === "needs_more_data") governanceStatus = "data_limited";
  else if (afs === "closed")                                       governanceStatus = "closed";

  // traceReason: first relevant explanation
  let traceReason = null;
  if (ds === "needs_more_data")      traceReason = "Datenbasis unzureichend – Signalqualität zu gering";
  else if (ds === "deferred_review") traceReason = "Zurückgestellt – Wiedervorlage geplant";
  else if (ds === "rejected_candidate") traceReason = "Risikokonstellation – nicht freigabereif";
  else if (ds === "approved_candidate") traceReason = "Starke Signallage – manuelle Bestätigung empfohlen";
  else if (ar === "review_required") traceReason = "Freigabepflichtig – manuelle Prüfung erforderlich";
  else if (ar === "insufficient_confidence") traceReason = "Signalqualität zu gering für Aktion";

  // blockedByGuardrail: critical attention + review_required signals a guardrail-like condition
  const blockedByGuardrail = (level === "critical" && ar === "review_required");

  return { governanceStatus, traceReason, blockedByGuardrail };
}

/**
 * Step 8 Block 1: Derive a compact governance label for briefing fact lines.
 * Uses safe defaults when no real identity data is available.
 * Returns a short string label or empty string if no governance insight applies.
 */
function _deriveBriefingGovernanceLabel(stock) {
  const ar  = stock._actionReadiness  || "monitor_only";
  const ds  = stock._decisionStatus   || null;
  const afs = stock._approvalFlowStatus || null;

  // Only surface governance labels for review-controlled or approval-requiring signals
  if (ar === "review_required" && ds === "approved_candidate") {
    return " · 🏛 Governance: Freigabe-Kandidat (Operator-Review)";
  }
  if (ar === "review_required") {
    return " · 🏛 Governance: Review-pflichtig (SoD aktiv)";
  }
  if (afs === "closed") {
    return " · 🏛 Governance: Abgeschlossen";
  }
  return "";
}

// ── Urgency/priority resolution ─────────────────────────────────────────────
const URGENCY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Resolves the effective briefing priority by taking the more urgent of the
 * stock-level attention and the user-state briefing urgency.
 * Lower rank = higher urgency.
 */
function _resolveEffectivePriority(stateBriefingUrgency, stockAttentionLevel) {
  const stateRank = URGENCY_RANK[stateBriefingUrgency] ?? 3;
  const stockRank = URGENCY_RANK[stockAttentionLevel] ?? 3;
  return stateRank <= stockRank ? stateBriefingUrgency : stockAttentionLevel;
}

/**
 * Step 6 Block 3 / Block 4: Small adaptive sort adjustment for briefing order.
 * Returns a numeric offset: negative = higher priority (appears earlier).
 * Only used as a third tie-breaker, after orchestration and attention ranks.
 *
 * Guardrail (Block 4): this function only ever returns 0 or -1 (boost toward
 * the front), never +1. Critical/high-attention stocks therefore cannot be
 * demoted by adaptive preference signals – the adaptive layer is purely
 * additive within the tie-breaker slot.
 *
 * @param {object}      stock – stock with _attentionLevel and _attentionReason
 * @param {object|null} hints – computeUserPreferenceHints() result
 * @returns {number}
 */
function _adaptiveBriefingBoost(stock, hints) {
  if (!hints || (hints.sampleSize || 0) < 3) return 0;
  const level  = stock._attentionLevel  || "low";
  const reason = stock._attentionReason || "";
  // risk_averse user: risk/high-attention stocks get a tighter slot in the briefing
  if (hints.riskSensitivity === "risk_averse" &&
      (level === "high" || level === "critical")) {
    return -1;
  }
  // exploration-affinity user: new-signal or discovery-type stocks move up
  if (hints.explorationAffinity === "high" &&
      (reason.toLowerCase().includes("new") || reason.toLowerCase().includes("first"))) {
    return -1;
  }
  return 0;
}

function buildFactsFromMarket(stocks) {
  const lines = [];
  for (const s of stocks) {
    const cp =
      s.changesPercentage !== null && s.changesPercentage !== undefined
        ? Number(s.changesPercentage).toFixed(2) + "%"
        : "unbekannt";

    const score =
      s.hqsScore !== null && s.hqsScore !== undefined ? String(s.hqsScore) : "unbekannt";

    const regime = s.regime || "unbekannt";

    // Include attention level when elevated
    const attnLabel = s._attentionLevel && s._attentionLevel !== "low"
      ? `, Aufmerksamkeit: ${s._attentionLevel}` + (s._attentionReason ? ` (${s._attentionReason})` : "")
      : "";

    // Include orchestration hint when actionable (not passive/none)
    const orchLabel = _buildOrchLabel(s._orchestration);

    // Step 5 Follow-up/Reminder: mark review-due follow-up stocks with a brief note
    const followUpLabel = s._orchestration?.followUpNeeded ? " · Wiedervorlage" : "";

    // Step 7 Block 1: include action-readiness when it signals review or proposal (not routine)
    const arLabel = (s._actionReadiness === "review_required" || s._actionReadiness === "proposal_ready")
      ? `, Aktionsbereitschaft: ${s._actionReadiness}`
      : "";

    // Step 7 Block 2: include approval-queue bucket label for review/proposal cases
    const aqLabel = s._approvalQueueBucket === "risk_review"
      ? " · 🔒 Risiko-Review"
      : s._approvalQueueBucket === "proposal_bucket"
      ? " · 📝 Vorschlag bereit"
      : "";

    // Step 7 Block 3: include decision status label for review cases
    const DECISION_STATUS_LABELS = {
      approved_candidate: "✅ Freigabe-Kandidat",
      pending_review:     "⏳ Prüfung ausstehend",
      deferred_review:    "⏸ Zurückgestellt",
      needs_more_data:    "📊 Mehr Daten nötig",
    };
    const dsLabel = s._decisionStatus && DECISION_STATUS_LABELS[s._decisionStatus]
      ? ` · ${DECISION_STATUS_LABELS[s._decisionStatus]}`
      : "";

    // Step 7 Block 4: include controlled approval flow label for post-decision context
    const afsLabel = s._approvalFlowStatus && APPROVAL_FLOW_LABELS[s._approvalFlowStatus]
      ? ` · ${APPROVAL_FLOW_LABELS[s._approvalFlowStatus]}`
      : "";

    // Step 7 Block 5: include audit/safety hint when governance is not routine observation
    const auditHints = s._auditHints;
    const govLabel = (auditHints?.governanceStatus && auditHints.governanceStatus !== "observation")
      ? ` · Governance: ${auditHints.governanceStatus}`
      : "";
    const guardrailLabel = auditHints?.blockedByGuardrail
      ? " · 🛡 Guardrail aktiv"
      : "";

    // Step 8 Block 1: governance role/SoD label for review-controlled signals
    const governanceRoleLabel = _deriveBriefingGovernanceLabel(s);

    lines.push(
      `- ${s.symbol}: Kurs ${s.price ?? "?"}, Änderung ${cp}, HQS ${score}, Marktphase ${regime}${attnLabel}${orchLabel}${followUpLabel}${arLabel}${aqLabel}${dsLabel}${afsLabel}${govLabel}${guardrailLabel}${governanceRoleLabel}.`
    );
  }
  return lines.join("\n");
}

function buildHiddenWinnerBlock(pick) {
  if (!pick) return "";

  const sym = String(pick.symbol || "").toUpperCase();
  const conf = pick.confidence !== null && pick.confidence !== undefined ? `${pick.confidence}/100` : "unbekannt";
  const reason = pick.reason ? String(pick.reason) : "unbekannt";
  const regime = pick.regime ? String(pick.regime) : "neutral";

  return `
HIDDEN WINNER (Wochen/Monate):
- Kandidat: ${sym}
- Sicherheit: ${conf}
- Marktphase: ${regime}
- Warum: ${reason}

Hinweis: Keine Kauf-/Verkaufsempfehlung. Nur Analyse.
`.trim();
}

async function runDailyBriefing() {
  return runJob("dailyBriefing", async () => {
    await initJobLocksTable();

    const won = await acquireLock("daily_briefing_job", 15 * 60);
    if (!won) {
      logger.warn("[job:dailyBriefing] skipped – lock held");
      return { processedCount: 0, skippedCount: 0 };
    }

    // Load stored discovery pick (produced by discoveryNotify job) – DB-first, no re-scoring
    let hiddenWinner = null;
    if (typeof getLatestDiscoveryPick === "function") {
      try {
        const picks = await getLatestDiscoveryPick(1);
        hiddenWinner = Array.isArray(picks) && picks[0] ? picks[0] : null;
        if (hiddenWinner) logger.info("Hidden winner pick loaded", { symbol: hiddenWinner.symbol });
      } catch (e) {
        logger.warn("Hidden winner pick failed (ignored)", { message: e.message });
      }
    }

  // 1) Aktive User laden
    const users = await getActiveBriefingUsers(500);
    if (!users.length) {
      logger.warn("No active briefing users found");
      return { processedCount: 0, skippedCount: 0 };
    }

  let createdCount = 0;
  let skippedCount = 0;
  let alreadyToday = 0;

  for (const u of users) {
    try {
      const userId = u.id;

      // Step 5 User-State: load consolidated state for this user (single DB call).
      // Used to boost briefing priority when there is a critical/high attention backlog.
      let userState = null;
      try {
        userState = await computeUserState(userId);
      } catch (usErr) {
        logger.warn("Daily briefing: computeUserState failed (ignored)", { userId, message: usErr.message });
      }

      // Step 5 Follow-up/Reminder: load count of open follow-ups for sort-order boost.
      // Uses activeFollowUpCount from userState (no extra DB round-trip).
      const userHasOpenFollowUps = (userState?.activeFollowUpCount ?? 0) > 0;

      // 2) Watchlist je User laden
      const wl = await getUserWatchlistSymbols(userId, 50);
      const symbols = wl.map((x) => x.symbol).filter(Boolean);

      if (!symbols.length) {
        skippedCount++;
        logger.warn("User has no watchlist, skipping", { userId });
        continue;
      }

      // 3) Marktdaten holen (DB-first steckt ja in getMarketData)
      const stocks = [];
      for (const sym of symbols) {
        const arr = await getMarketData(sym);
        if (Array.isArray(arr) && arr[0]) stocks.push(arr[0]);
      }

      if (!stocks.length) {
        skippedCount++;
        logger.warn("No market data for user symbols, skipping", { userId });
        continue;
      }

      // Step 5: Compute attention level per stock, then derive Action-Orchestration,
      // and sort by orchestration priority first (escalation/follow-up), then attention rank.
      for (const s of stocks) {
        const attn = _stockAttentionLevel(s);
        s._attentionLevel = attn.level;
        s._attentionReason = attn.reason;
        // Derive minimal orchestration from attention level for briefing ordering
        s._orchestration = _deriveBriefingOrchestration(s);
        // Step 7 Block 1: derive action-readiness tier from orchestration + attention
        s._actionReadiness = _deriveBriefingActionReadiness(s);
        // Step 7 Block 2: derive approval-queue bucket for clearer briefing labelling
        s._approvalQueueBucket = _deriveBriefingApprovalBucket(s);
        // Step 7 Block 3: derive decision status for review-case language/order
        s._decisionStatus = _deriveBriefingDecisionStatus(s);
        // Step 7 Block 4: derive controlled approval flow status for follow-up language/order
        s._approvalFlowStatus = _deriveBriefingApprovalFlowStatus(s);
        // Step 7 Block 5: derive compact audit/safety hints for fact-line and ordering
        s._auditHints = _deriveBriefingAuditHints(s);
      }
      // Primary sort: orchestration rank (escalation/follow-up urgency, review-due boost when user has open follow-ups)
      // Secondary sort: Step 7 action-readiness (review_required > proposal_ready > monitor_only)
      // Tertiary sort: Step 7 Block 3 decision-status (approved_candidate > pending_review > deferred > needs_more_data)
      // Step 7 Block 4: approval-flow-status as additional tie-breaker after decision-status
      // Quaternary sort: attention level rank (critical → high → medium → low)
      // Quinary sort: Step 6 Block 3 adaptive tie-breaker (risk/exploration preference)
      stocks.sort((a, b) => {
        const orchDiff = _briefingOrchestrationRank(a, userHasOpenFollowUps) - _briefingOrchestrationRank(b, userHasOpenFollowUps);
        if (orchDiff !== 0) return orchDiff;
        const arDiff = (ACTION_READINESS_RANK[a._actionReadiness] ?? 3) - (ACTION_READINESS_RANK[b._actionReadiness] ?? 3);
        if (arDiff !== 0) return arDiff;
        // Step 7 Block 3: decision-status tie-breaker within same action-readiness tier
        const dsDiff = (DECISION_STATUS_RANK[a._decisionStatus] ?? 4) - (DECISION_STATUS_RANK[b._decisionStatus] ?? 4);
        if (dsDiff !== 0) return dsDiff;
        // Step 7 Block 4: approval-flow-status tie-breaker within same decision-status
        const afsDiff = (APPROVAL_FLOW_STATUS_RANK[a._approvalFlowStatus] ?? APPROVAL_FLOW_UNRANKED) - (APPROVAL_FLOW_STATUS_RANK[b._approvalFlowStatus] ?? APPROVAL_FLOW_UNRANKED);
        if (afsDiff !== 0) return afsDiff;
        const attnDiff = (ATTENTION_RANK[a._attentionLevel] ?? 3) - (ATTENTION_RANK[b._attentionLevel] ?? 3);
        if (attnDiff !== 0) return attnDiff;
        return _adaptiveBriefingBoost(a, userPreferenceHints) - _adaptiveBriefingBoost(b, userPreferenceHints);
      });

      // Derive briefing priority from the highest escalation/attention level found.
      // Step 5 User-State: if the user has a critical/high urgency backlog, escalate
      // the briefing priority even when the current stock signals are moderate.
      const topOrch = stocks[0]?._orchestration || {};
      const topAttention = stocks[0]?._attentionLevel || "low";
      const topAttentionReason = stocks[0]?._attentionReason || null;
      const topDeliveryMode = topOrch.deliveryMode || "passive_briefing";

      // Resolve effective priority: user-state urgency may escalate stock-level attention
      const stateBriefingUrgency = userState?.briefingUrgency || "low";
      const effectivePriority = _resolveEffectivePriority(stateBriefingUrgency, topAttention);

      // Step 6 Block 2 / Block 4: User preference hints – use notificationFatigue for
      // delivery downgrade and briefingAffinity / preferredActionType for light adaptation.
      // One CTE query replaces the old computeProductSignals call. Non-fatal.
      //
      // adaptedDeliveryMode starts from the stock-/orchestration-level delivery mode.
      // adaptedActionType starts from urgency logic: "reduce_risk" on high urgency, else null.
      //   → If null, the user's historically preferred action type can fill the slot below.
      //
      // GUARDRAIL (Block 4): delivery-mode downgrade is never applied when effectivePriority
      // or topAttention is "critical". Critical topics must use briefing_and_notification
      // regardless of user fatigue – safety and governance override comfort.
      let adaptedDeliveryMode = topDeliveryMode;
      let adaptedActionType = topOrch.escalationLevel === "high" || stateBriefingUrgency === "critical" ? "reduce_risk" : null;
      let userPreferenceHints = null;
      try {
        userPreferenceHints = await computeUserPreferenceHints(userId, { days: 30 });
        if (userPreferenceHints.sampleSize >= 5) {
          // Downgrade delivery mode for users with high notification fatigue –
          // GUARDRAIL: never downgrade critical priority topics.
          const hasCriticalTopic = (effectivePriority === "critical" || topAttention === "critical");
          if (topDeliveryMode === "briefing_and_notification" &&
              userPreferenceHints.notificationFatigue === "high") {
            if (!hasCriticalTopic) {
              adaptedDeliveryMode = "briefing";
              logger.info("dailyBriefing: delivery downgraded (high notification fatigue)", {
                userId, notificationFatigue: userPreferenceHints.notificationFatigue,
                sampleSize: userPreferenceHints.sampleSize,
              });
            } else {
              // Guardrail triggered: log that downgrade was blocked for critical topic.
              logger.info("dailyBriefing: delivery downgrade blocked (critical topic protected from fatigue gate)", {
                userId, effectivePriority, topAttention,
              });
            }
          }
          // If no urgent action type is set, use the user's historically preferred action type
          if (adaptedActionType === null && userPreferenceHints.preferredActionType) {
            adaptedActionType = userPreferenceHints.preferredActionType;
          }
          if (userPreferenceHints.briefingAffinity) {
            logger.info("dailyBriefing: user briefing affinity", {
              userId, briefingAffinity: userPreferenceHints.briefingAffinity,
            });
          }
        }
      } catch (sigErr) {
        logger.warn("dailyBriefing: computeUserPreferenceHints failed (ignored)", { userId, message: sigErr.message });
      }

      // 4) Fakten bauen
      const facts = buildFactsFromMarket(stocks);

      // 5) OpenAI Text erstellen
      const text = await generateBriefingText({
        userName: "Nutzer",
        symbols,
        facts,
      });

      const titleMatch = text.match(/^TITEL:\s*(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : "Dein Morgen-Update";

      // ✅ NEW: Hidden Winner Block anhängen (wenn vorhanden)
      const body = hiddenWinner ? `${text}\n\n${buildHiddenWinnerBlock(hiddenWinner)}` : text;

      // ✅ 6) In-App Notification speichern (nur 1x pro Tag pro User)
      const created = await createNotificationOncePerDay({
        userId,
        title,
        body,
        kind: "daily_briefing",
        priority: effectivePriority,
        reason: topAttentionReason || userState?.userStateSummary || null,
        actionType: adaptedActionType,
        deliveryMode: adaptedDeliveryMode,
      });

      if (created.inserted) {
        createdCount++;
        logger.info("Daily briefing created", {
          userId, deliveryMode: adaptedDeliveryMode, userStateUrgency: stateBriefingUrgency,
          notificationFatigue: userPreferenceHints?.notificationFatigue || null,
        });
      } else {
        alreadyToday++;
        logger.info("Daily briefing skipped (already today)", { userId });
      }
    } catch (e) {
      // Wichtig: pro User abfangen, damit Job weiterläuft
      logger.error("Daily briefing user failed", {
        userId: u?.id,
        message: e.message,
      });
    }
  }

  return {
    processedCount: createdCount,
    skippedCount: skippedCount + alreadyToday,
    created: createdCount,
    alreadyToday,
    users: users.length,
  };
  });
}

if (require.main === module) {
  runDailyBriefing()
    .then(() => process.exit(0))
    .catch((e) => {
      logger.error("Daily briefing fatal", { message: e.message });
      process.exit(1);
    });
}

module.exports = { runDailyBriefing };
