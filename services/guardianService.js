"use strict";

/*
  Guardian Service – OpenAI Analysis Consumer

  Wraps the OpenAI GPT model to produce a human-readable stock analysis
  based on the canonical integrationEngine output fields:
    finalConviction, finalConfidence, finalRating, finalDecision,
    whyInteresting, components (conviction breakdown), hqsScore, regime.

  Verantwortung: Consume integrationEngine canonical output → generate
  natural-language analysis via OpenAI Guardian AI prompt.
  No scoring, no pipeline state.

  Rolle: Consumer (letzte Schicht – liest fertige Engine-Outputs, schreibt nichts zurück)
*/

const OpenAI = require("openai");

// ── Canonical field contract ─────────────────────────────────────────────────
// These are the integrationEngine output fields that Guardian depends on.
// detectMissingCanonicalFields() surfaces gaps so callers know when the
// analysis is based on partial data.
const GUARDIAN_CANONICAL_FIELDS = [
  "finalConviction",
  "finalConfidence",
  "finalRating",
  "finalDecision",
  "whyInteresting",
  "components",
];

/**
 * Returns the list of canonical fields that are absent from marketData.
 * An empty result means the full integrationEngine output is present.
 *
 * @param {object|null} marketData
 * @returns {string[]}  names of missing fields
 */
function detectMissingCanonicalFields(marketData) {
  return GUARDIAN_CANONICAL_FIELDS.filter((field) => marketData?.[field] == null);
}

let client = null;

function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return client;
}

async function analyzeStockWithGuardian(context) {
  const {
    symbol,
    marketData,
  } = context;

  // Read canonical integrationEngine output fields.
  const finalConviction = marketData?.finalConviction ?? null;
  const finalConfidence = marketData?.finalConfidence ?? null;
  const finalRating = marketData?.finalRating ?? null;
  const finalDecision = marketData?.finalDecision ?? null;
  const whyInteresting = Array.isArray(marketData?.whyInteresting) && marketData.whyInteresting.length
    ? marketData.whyInteresting.join(", ")
    : null;
  const hqsScore = marketData?.hqsScore ?? null;
  const regime = marketData?.regime ?? null;
  const components = marketData?.components ?? null;

  // Step 4: read portfolio context if present (pass-through from opportunity scanner).
  const portfolioContext = marketData?.portfolioContext ?? context?.portfolioContext ?? null;

  // Step 4b: read delta context if present (pass-through from opportunity scanner).
  const deltaContext = marketData?.deltaContext ?? context?.deltaContext ?? null;

  // Step 4c: read next action hint if present (computed by opportunityScanner).
  const nextAction = marketData?.nextAction ?? context?.nextAction ?? null;

  // Step 5b: read action-orchestration if present (computed by opportunityScanner).
  const actionOrchestration = marketData?.actionOrchestration ?? context?.actionOrchestration ?? null;

  // Step 5: read feedback/reaction context if present (from notification reaction loop).
  const feedbackContext = marketData?.feedbackContext ?? context?.feedbackContext ?? null;

  // Step 5 Follow-up/Reminder: read follow-up/reminder context if present.
  // Passed through from the caller (route/orchestrator) alongside actionOrchestration.
  const followUpContext = marketData?.followUpContext ?? context?.followUpContext ?? null;

  // Step 5 User-State: read consolidated user state if present (pass-through from route/caller).
  const userState = marketData?.userState ?? context?.userState ?? null;

  // Step 6: Adaptive product signals – read recommendation outcome and track-record hints if present.
  const adaptiveSignalHints = marketData?.adaptiveSignalHints ?? context?.adaptiveSignalHints ?? null;

  // Step 6 Block 2: Per-user preference hints – read behavioral profile if present.
  // Passed through from the caller (route/orchestrator) alongside userState.
  const userPreferenceHints = marketData?.userPreferenceHints ?? context?.userPreferenceHints ?? null;

  // Step 6 Block 3: Adaptive priority signals – read pre-computed boost and reason if present.
  const adaptivePriorityBoost  = marketData?.adaptivePriorityBoost  ?? context?.adaptivePriorityBoost  ?? null;
  const adaptivePriorityReason = marketData?.adaptivePriorityReason ?? context?.adaptivePriorityReason ?? null;
  const adjustedRecommendationPriority = marketData?.adjustedRecommendationPriority ?? context?.adjustedRecommendationPriority ?? null;

  // Step 7 Block 1: Action-Readiness & Approval Layer – read classification if present.
  const actionReadiness = marketData?.actionReadiness ?? context?.actionReadiness ?? null;

  // Step 7 Block 2: Approval-Queue entry – collection/prioritisation layer.
  const approvalQueueEntry = marketData?.approvalQueueEntry ?? context?.approvalQueueEntry ?? null;

  // Step 7 Block 3: Decision Layer – concrete decision state for review/approval cases.
  const decisionLayer = marketData?.decisionLayer ?? context?.decisionLayer ?? null;

  // Step 7 Block 4: Controlled Approval Flow – next controlled follow-up step after decision.
  const controlledApprovalFlow = marketData?.controlledApprovalFlow ?? context?.controlledApprovalFlow ?? null;

  // Step 7 Block 5: Audit/trace/safety layer – condensed governance and guardrail state.
  const auditTrace = marketData?.auditTrace ?? context?.auditTrace ?? null;

  // Step 8 Block 1: Governance context – actor role, SoD, tenant scope classification.
  const governanceContext = marketData?.governanceContext ?? context?.governanceContext ?? null;

  // Step 8 Block 2: Exception fields – operating-console exception classification.
  const exceptionFields = marketData?.exceptionFields ?? context?.exceptionFields ?? null;

  // Step 8 Block 3: Policy Plane – policy version/status/mode, shadow, four-eyes basis.
  const policyPlane = marketData?.policyPlane ?? context?.policyPlane ?? null;

  // Step 8 Block 4: Evidence Package – policyFingerprint, policyValidity, policyApprovalHistory, operatorActionTrace.
  const evidencePackage = marketData?.evidencePackage ?? context?.evidencePackage ?? null;
  const policyValidity  = marketData?.policyValidity  ?? context?.policyValidity  ?? null;

  // Step 8 Block 5: Tenant/resource governance – load band, quota, guardrail.
  const tenantResourceGovernance = marketData?.tenantResourceGovernance ?? context?.tenantResourceGovernance ?? null;

  // Step 8 Block 6: Operational resilience – degradation mode, fallback tier, recovery state.
  const operationalResilience = marketData?.operationalResilience ?? context?.operationalResilience ?? null;

  // Step 9 Block 1: Autonomy level – effective level, cap, escalation, basis.
  const autonomyLevel = marketData?.autonomyLevel ?? context?.autonomyLevel ?? null;

  // Step 9 Block 1: Drift detection – drift signals, level, metronom deviation, baseline state.
  const driftDetection = marketData?.driftDetection ?? context?.driftDetection ?? null;

  // ── Fallback guard ───────────────────────────────────────────────────────
  // Surface any missing canonical fields so pipeline gaps are visible.
  const missingFields = detectMissingCanonicalFields(marketData);
  if (missingFields.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[guardianService] ${symbol}: missing canonical fields: ${missingFields.join(", ")}`
    );
  }
  // If both the primary conviction score and the fallback hqsScore are absent
  // there is no scoring data to base an analysis on.  Return a clear degraded
  // response instead of invoking the AI with empty/null inputs.
  if (finalConviction == null && hqsScore == null) {
    return `[Guardian: degraded – keine Scoring-Daten für ${symbol || "?"} verfügbar. Fehlende Felder: ${missingFields.join(", ")}]`;
  }

  function buildConvictionBlock() {
    if (finalConviction != null) {
      const ratingLabel = finalRating || "–";
      const decisionLabel = finalDecision || "–";
      const confidenceLabel = finalConfidence != null ? `, Confidence: ${finalConfidence}` : "";
      return `Final Conviction: ${finalConviction} (${ratingLabel}, Entscheidung: ${decisionLabel}${confidenceLabel})`;
    }
    return `HQS Score: ${hqsScore ?? "–"}`;
  }

  const convictionBlock = buildConvictionBlock();

  const regimeBlock = regime
    ? `Markt-Regime: ${regime}`
    : "";

  const componentsBlock = components
    ? `Conviction-Breakdown: HQS ${components.hqs ?? "–"}, AI ${components.ai ?? "–"}, StrategyAdj ${components.strategyAdjusted ?? "–"}, Resilience ${components.resilience != null ? Math.round(components.resilience * 100) : "–"}, NewsStrength ${components.newsStrength ?? "–"}`
    : "";

  const whyBlock = whyInteresting
    ? `Auffälligkeiten (Integration Engine): ${whyInteresting}`
    : "";

  // Step 4: portfolio context block – extended with portfolio intelligence signals.
  const portfolioBlock = portfolioContext
    ? `Portfolio-Kontext: ${portfolioContext.portfolioContextLabel || "–"}` +
      ` (portfolioRole: ${portfolioContext.portfolioRole || "–"}` +
      `, concentrationRisk: ${portfolioContext.concentrationRisk || "–"}` +
      `, diversificationBenefit: ${portfolioContext.diversificationBenefit ? "ja" : "nein"}` +
      `, sectorOverlap: ${portfolioContext.sectorOverlap ? "ja" : "nein"}` +
      `, portfolioPriority: ${portfolioContext.portfolioPriority || "–"})`
    : "";

  // Step 4b: delta block – explains what changed since the last engine run.
  // Only added when a non-stable change type is present.
  const DELTA_CHANGE_LABELS = {
    new_signal:             "Neu im Scanner – erste Prüfung empfohlen",
    gaining_relevance:      "Conviction gestiegen – relevanter als zuletzt",
    risk_increased:         "Risiko erhöht – Konzentrationsrisiko oder Score-Rückgang",
    losing_conviction:      "Conviction gesunken – kritisch beobachten",
    portfolio_impact_changed: "Portfolio-Impact geändert – Positionseröffnung prüfen",
  };
  let deltaBlock = "";
  if (deltaContext && deltaContext.changeType && deltaContext.changeType !== "stable") {
    const changeLabel = DELTA_CHANGE_LABELS[deltaContext.changeType] || deltaContext.changeType;
    const deltaParts = [`Delta-Signal: ${changeLabel} (Priorität: ${deltaContext.deltaPriority})`];
    if (deltaContext.newToWatch)            deltaParts.push("Neu relevant");
    if (deltaContext.becameMoreRelevant)    deltaParts.push("Relevanz gestiegen");
    if (deltaContext.becameRiskier)         deltaParts.push("Risiko gestiegen");
    if (deltaContext.lostConviction)        deltaParts.push("Überzeugung verloren");
    if (deltaContext.portfolioImpactChanged) deltaParts.push("Portfolio-Fit geändert");
    if (deltaContext._convictionDelta !== null) {
      const sign = deltaContext._convictionDelta >= 0 ? "+" : "";
      deltaParts.push(`Δ Conviction: ${sign}${deltaContext._convictionDelta}`);
    }
    deltaBlock = deltaParts.join(" · ");
  }

  // Step 4c: next action block – surfaces the computed next action hint.
  function buildNextActionBlock() {
    if (!nextAction?.actionType) return "";
    const parts = [
      `Nächster Schritt: ${nextAction.nextActionLabel}`,
      `(${nextAction.actionType}, Priorität: ${nextAction.actionPriority})`,
      `– ${nextAction.actionReason}`,
    ];
    return parts.join(" ");
  }
  const nextActionBlock = buildNextActionBlock();

  // Step 5b: action-orchestration block – explains why the system chose this delivery mode.
  // Short, factual, no new prompt world – just surfaces the orchestration decision.
  const DELIVERY_MODE_LABELS = {
    briefing_and_notification: "Briefing + Sofort-Benachrichtigung (akuter Handlungsbedarf)",
    notification:  "Sofort-Benachrichtigung (zeitkritisches Signal)",
    briefing:      "Im Tages-Briefing berücksichtigt",
    passive_briefing: "Passiv beobachtet (kein akuter Bedarf)",
    none:          "Kein aktiver Hinweis",
  };
  const REVIEW_WINDOW_LABELS = {
    immediate: "sofort",
    short:     "kurzfristig (1–3 Tage)",
    medium:    "mittelfristig (1–2 Wochen)",
    long:      "langfristig (>2 Wochen)",
  };
  function buildActionOrchestrationBlock() {
    if (!actionOrchestration) return "";
    const parts = [];
    if (actionOrchestration.deliveryMode) {
      parts.push(`System-Behandlung: ${DELIVERY_MODE_LABELS[actionOrchestration.deliveryMode] || actionOrchestration.deliveryMode}`);
    }
    if (actionOrchestration.escalationLevel && actionOrchestration.escalationLevel !== "none") {
      parts.push(`Eskalationsstufe: ${actionOrchestration.escalationLevel}`);
    }
    if (actionOrchestration.followUpNeeded) {
      parts.push(`Follow-up erforderlich: ${actionOrchestration.followUpReason || "ja"}`);
    }
    if (actionOrchestration.reviewWindow) {
      parts.push(`Prüfungsfenster: ${REVIEW_WINDOW_LABELS[actionOrchestration.reviewWindow] || actionOrchestration.reviewWindow}`);
    }
    return parts.length ? parts.join(" · ") : "";
  }
  const actionOrchestrationBlock = buildActionOrchestrationBlock();

  // Step 5: feedback context block – surfaces user reaction signals from the notification loop.
  // Only added when a concrete reaction is present (acted or dismissed).
  const FEEDBACK_SIGNAL_LABELS = {
    positive: "Nutzer hat positiv reagiert (Aktion ausgeführt)",
    negative: "Nutzer hat Hinweis ignoriert oder abgelehnt",
    neutral:  "Nutzer hat den Hinweis gesehen, aber nicht reagiert",
  };
  const RESPONSE_TYPE_LABELS = {
    acted:             "Nutzer hat Maßnahme ergriffen",
    dismissed:         "Nutzer hat Hinweis verworfen",
    starter_position:  "Nutzer hat Einstiegsposition eröffnet",
    watchlist_added:   "Nutzer hat Symbol auf Watchlist gesetzt",
    rebalanced:        "Nutzer hat Rebalancing vorgenommen",
  };
  function buildFeedbackBlock() {
    if (!feedbackContext) return "";
    const parts = [];
    if (feedbackContext.feedbackSignal) {
      parts.push(`Nutzer-Feedback: ${FEEDBACK_SIGNAL_LABELS[feedbackContext.feedbackSignal] || feedbackContext.feedbackSignal}`);
    }
    if (feedbackContext.responseType) {
      parts.push(`Reaktionstyp: ${RESPONSE_TYPE_LABELS[feedbackContext.responseType] || feedbackContext.responseType}`);
    }
    if (feedbackContext.actedAt) {
      parts.push(`Maßnahme am: ${feedbackContext.actedAt}`);
    }
    if (feedbackContext.dismissedAt) {
      parts.push(`Verworfen am: ${feedbackContext.dismissedAt}`);
    }
    if (feedbackContext.followUpOutcome) {
      parts.push(`Follow-up-Outcome: ${feedbackContext.followUpOutcome}`);
    }
    return parts.length ? parts.join(" · ") : "";
  }
  const feedbackBlock = buildFeedbackBlock();

  // Step 5 User-State: surfaces consolidated user state for Guardian context.
  // Only added when userState is present and has a meaningful urgency level.
  const URGENCY_LABELS = {
    critical: "Kritisch",
    high:     "Hoch",
    medium:   "Mittel",
    low:      "Niedrig",
  };
  function buildUserStateBlock() {
    if (!userState) return "";
    const urgencyLabel = URGENCY_LABELS[userState.briefingUrgency] || userState.briefingUrgency;
    const parts = [
      `Nutzer-Gesamtzustand: ${userState.userStateSummary}`,
      `(Briefing-Dringlichkeit: ${urgencyLabel}`,
    ];
    if (userState.openAttentionCount > 0) {
      parts.push(`, offene Aufmerksamkeitssignale: ${userState.openAttentionCount}`);
    }
    if (userState.activeFollowUpCount > 0) {
      parts.push(`, aktive Follow-ups: ${userState.activeFollowUpCount}`);
    }
    if (userState.attentionBacklog > 0) {
      parts.push(`, ungesehene Meldungen: ${userState.attentionBacklog}`);
    }
    if (userState.lastResponseType) {
      parts.push(`, letzte Nutzerreaktion: ${userState.lastResponseType}`);
    }
    parts.push(")");
    return parts.join("");
  }
  const userStateBlock = buildUserStateBlock();

  // Step 5 Follow-up/Reminder: surfaces follow-up/reminder status for Guardian context.
  // Explains why a reminder is due, what action is expected, and when the review window closes.
  const FOLLOW_UP_STATUS_LABELS = {
    overdue:  "Überfällig – Nutzer hat noch nicht reagiert",
    pending:  "Ausstehend – Wiedervorlage geplant",
    closed:   "Abgeschlossen – Nutzeraktion erfolgt oder verworfen",
    none:     "Kein aktiver Follow-up",
  };
  const REMINDER_WINDOW_LABELS = {
    immediate: "sofort (< 2 Stunden)",
    short:     "kurzfristig (< 8 Stunden)",
    medium:    "mittelfristig (< 24 Stunden)",
    long:      "langfristig (> 24 Stunden)",
  };
  function buildFollowUpBlock() {
    if (!followUpContext) return "";
    const parts = [];
    if (followUpContext.followUpStatus) {
      parts.push(`Follow-up-Status: ${FOLLOW_UP_STATUS_LABELS[followUpContext.followUpStatus] || followUpContext.followUpStatus}`);
    }
    if (followUpContext.reminderEligible) {
      parts.push(`Wiedervorlage: ${followUpContext.reminderReason || "ja"}`);
    }
    if (followUpContext.reminderWindow) {
      parts.push(`Erinnerungsfenster: ${REMINDER_WINDOW_LABELS[followUpContext.reminderWindow] || followUpContext.reminderWindow}`);
    }
    if (followUpContext.reviewDue) {
      parts.push("Prüfung fällig: Signal wartet auf Nutzerreaktion");
    }
    if (followUpContext.needsClosure) {
      parts.push("Abschluss empfohlen: Follow-up wurde bearbeitet, Thema kann geschlossen werden");
    }
    if (followUpContext.reminderAt) {
      parts.push(`Nächste Erinnerung: ${followUpContext.reminderAt}`);
    }
    return parts.length ? parts.join(" · ") : "";
  }
  const followUpBlock = buildFollowUpBlock();

  // Step 6: Adaptive product signal block – surfaces track-record hints when available.
  // Brief and optional: only included when outcomeDataAvailable = true.
  function buildAdaptiveSignalBlock() {
    if (!adaptiveSignalHints || !adaptiveSignalHints.outcomeDataAvailable) return "";
    const parts = [];
    if (adaptiveSignalHints.recommendationOutcome != null) {
      parts.push(`Historischer Signalqualitäts-Score: ${adaptiveSignalHints.recommendationOutcome}/100`);
    }
    if (adaptiveSignalHints.successRate != null) {
      parts.push(`Trefferquote vergangener Signale: ${Math.round(adaptiveSignalHints.successRate * 100)}%`);
    }
    if (adaptiveSignalHints.avgActualReturn != null) {
      const retPct = (adaptiveSignalHints.avgActualReturn * 100).toFixed(2);
      parts.push(`Ø Rendite evaluierter Signale: ${retPct}%`);
    }
    if (adaptiveSignalHints.outcomeSampleSize != null) {
      parts.push(`Datenbasis: ${adaptiveSignalHints.outcomeSampleSize} ausgewertete Signal(e)`);
    }
    return parts.length ? parts.join(" · ") : "";
  }
  const adaptiveSignalBlock = buildAdaptiveSignalBlock();

  // Step 6 Block 2: Per-user preference hints block – surfaces behavioral profile when available.
  // Only included when hints are present; short and factual, no new prompt world.
  const RESPONSIVENESS_LABELS = {
    high:   "Reagiert schnell (< 2 Stunden nach Benachrichtigung)",
    medium: "Reagiert moderat (2–24 Stunden nach Benachrichtigung)",
    low:    "Reagiert langsam (> 24 Stunden oder selten)",
  };
  const RISK_SENSITIVITY_LABELS = {
    risk_averse:        "Risikoavers – reagiert bevorzugt auf Risiko-Hinweise",
    opportunity_seeker: "Chancenorientiert – reagiert bevorzugt auf Kaufsignale",
    neutral:            "Ausgewogen – reagiert ähnlich auf Risiko- und Kaufsignale",
  };
  const FATIGUE_LABELS = {
    high:     "Hoch – viele Benachrichtigungen werden ignoriert oder verworfen",
    moderate: "Moderat – gelegentliches Ignorieren von Benachrichtigungen",
    low:      "Niedrig – Nutzer öffnet und bearbeitet Benachrichtigungen regelmäßig",
  };
  const AFFINITY_LABELS = {
    high:   "Hoch",
    medium: "Mittel",
    low:    "Niedrig",
  };
  function buildUserPreferenceBlock() {
    if (!userPreferenceHints) return "";
    const parts = [];
    if (userPreferenceHints.actionResponsiveness) {
      parts.push(`Reaktionsgeschwindigkeit: ${RESPONSIVENESS_LABELS[userPreferenceHints.actionResponsiveness] || userPreferenceHints.actionResponsiveness}`);
    }
    if (userPreferenceHints.riskSensitivity) {
      parts.push(`Risikoempfindlichkeit: ${RISK_SENSITIVITY_LABELS[userPreferenceHints.riskSensitivity] || userPreferenceHints.riskSensitivity}`);
    }
    if (userPreferenceHints.notificationFatigue) {
      parts.push(`Benachrichtigungs-Sättigung: ${FATIGUE_LABELS[userPreferenceHints.notificationFatigue] || userPreferenceHints.notificationFatigue}`);
    }
    if (userPreferenceHints.briefingAffinity) {
      parts.push(`Briefing-Affinität: ${AFFINITY_LABELS[userPreferenceHints.briefingAffinity] || userPreferenceHints.briefingAffinity}`);
    }
    if (userPreferenceHints.explorationAffinity) {
      parts.push(`Explorations-Affinität (Discovery): ${AFFINITY_LABELS[userPreferenceHints.explorationAffinity] || userPreferenceHints.explorationAffinity}`);
    }
    if (userPreferenceHints.preferredDeliveryMode) {
      parts.push(`Bevorzugter Liefermodus: ${userPreferenceHints.preferredDeliveryMode}`);
    }
    return parts.length ? `Nutzer-Verhaltensprofil: ${parts.join(" · ")}` : "";
  }
  const userPreferenceBlock = buildUserPreferenceBlock();

  // Step 6 Block 3: Adaptive priority block – explains why the system prioritized
  // this topic higher or lower based on user-specific adaptive signals.
  // Only included when a non-zero boost is present and reason is available.
  const ADAPTIVE_REASON_LABELS = {
    "riskAverse+riskSignal":            "Nutzer ist risikoavers – Risiko-Signale werden stärker gewichtet",
    "explorationAffinity+newSignal":    "Nutzer hat hohe Entdeckungsaffinität – neue Signale werden hervorgehoben",
    "opportunitySeeker+elevatedSignal": "Nutzer ist chancenorientiert – starke Kaufsignale werden priorisiert",
    "highSuccessRate":                  "Signal-Historie mit hoher Trefferquote – historisch verlässliches Signal",
    "lowSuccessRate":                   "Signal-Historie mit niedriger Trefferquote – Vorsicht geboten",
    "notificationFatigue":              "Nutzer zeigt Benachrichtigungs-Sättigung – Lieferpriorität reduziert",
    "notificationFatigue-guardrail":    "Benachrichtigungs-Sättigung erkannt, aber Risiko-/kritisches Signal bleibt dominant – Guardrail aktiv",
  };
  function buildAdaptivePriorityBlock() {
    if (adaptivePriorityBoost === null || adaptivePriorityBoost === undefined || adaptivePriorityBoost === 0) return "";
    const direction = adaptivePriorityBoost > 0 ? "Priorität erhöht" : "Priorität reduziert";
    const reasonParts = adaptivePriorityReason
      ? adaptivePriorityReason.split("+").map((r) => { const t = r.trim(); return ADAPTIVE_REASON_LABELS[t] || t; }).join(" · ")
      : "Adaptive Priorisierung aktiv";
    const adjPart = adjustedRecommendationPriority
      ? `, angepasste Empfehlungspriorität: ${adjustedRecommendationPriority}`
      : "";
    return `Adaptive Priorisierung (Block 3): ${direction} um ${Math.abs(adaptivePriorityBoost)} Punkte · ${reasonParts}${adjPart}`;
  }
  const adaptivePriorityBlock = buildAdaptivePriorityBlock();

  // Step 7 Block 1: Action-Readiness & Approval Layer block – explains what readiness tier
  // this signal has reached and why a specific governance gate applies.
  // Short and factual: explains observation, approval, proposal, or low-confidence status.
  const ACTION_READINESS_LABELS = {
    review_required:        "Freigabe erforderlich – manuelle Überprüfung nötig vor jeder Aktion",
    proposal_ready:         "Vorschlag bereit – strukturierter Vorschlag, keine automatische Ausführung",
    monitor_only:           "Nur Beobachtung – kein Handlungsbedarf, Situation weiter beobachten",
    insufficient_confidence: "Unzureichende Datenbasis – Signal noch nicht reif für Handlungsempfehlung",
  };
  const ACTION_SAFETY_LABELS = {
    restricted: "Eingeschränkt (Risiko-/Governance-Sperre)",
    caution:    "Vorsicht (erhöhte Aufmerksamkeit empfohlen)",
    safe:       "Unkritisch",
  };
  function buildActionReadinessBlock() {
    if (!actionReadiness) return "";
    const parts = [];
    const readinessLabel = ACTION_READINESS_LABELS[actionReadiness.actionReadiness] || actionReadiness.actionReadiness;
    parts.push(`Aktionsbereitschaft (Step 7): ${readinessLabel}`);
    if (actionReadiness.approvalRequired) {
      parts.push(`Freigabe erforderlich: ${actionReadiness.approvalReason || "ja"}`);
    }
    if (actionReadiness.actionSafetyLevel) {
      parts.push(`Sicherheitsstufe: ${ACTION_SAFETY_LABELS[actionReadiness.actionSafetyLevel] || actionReadiness.actionSafetyLevel}`);
    }
    if (actionReadiness.executionScope && actionReadiness.executionScope !== "observation") {
      parts.push(`Ausführungsbereich: ${actionReadiness.executionScope}`);
    }
    return parts.join(" · ");
  }
  const actionReadinessBlock = buildActionReadinessBlock();

  // Step 7 Block 2: Approval-Queue block – explains the review/approval state concisely.
  // Covers: why pending, why proposal only, why not yet ready.
  const QUEUE_BUCKET_LABELS = {
    risk_review:      "Risiko-Review",
    proposal_bucket:  "Vorschlags-Review",
    insufficient_data: "Datenbasis zu gering",
  };
  function buildApprovalQueueBlock() {
    if (!approvalQueueEntry) return "";
    const parts = [];
    if (approvalQueueEntry.pendingApproval) {
      const bucketLabel = QUEUE_BUCKET_LABELS[approvalQueueEntry.approvalQueueBucket] || approvalQueueEntry.approvalQueueBucket;
      parts.push(`Freigabe ausstehend – Queue: ${bucketLabel}`);
      if (approvalQueueEntry.reviewPriority) {
        parts.push(`Review-Priorität: ${approvalQueueEntry.reviewPriority}`);
      }
      if (approvalQueueEntry.reviewReason) {
        parts.push(`Grund: ${approvalQueueEntry.reviewReason}`);
      }
    } else if (approvalQueueEntry.approvalQueueBucket === "proposal_bucket") {
      parts.push("Strukturierter Vorschlag – bereit zur Prüfung, keine automatische Ausführung");
      if (approvalQueueEntry.reviewPriority) {
        parts.push(`Vorschlags-Priorität: ${approvalQueueEntry.reviewPriority}`);
      }
    } else if (approvalQueueEntry.approvalQueueBucket === "insufficient_data") {
      parts.push("Datenbasis zu gering – Signal noch nicht freigabereif, weiter beobachten");
    }
    return parts.length ? `Freigabe-Queue (Step 7 Block 2): ${parts.join(" · ")}` : "";
  }
  const approvalQueueBlock = buildApprovalQueueBlock();

  // Step 7 Block 3: Decision Layer block – explains the concrete decision state
  // for review/approval cases. Short and verständlich: why is this case pending,
  // why is it a candidate, why does it need more data, or why was it deferred.
  const DECISION_STATUS_LABELS = {
    approved_candidate: "Freigabe-Kandidat – Daten stark und konsistent, manuelle Bestätigung empfohlen",
    pending_review:     "Prüfung ausstehend – manuelle Bewertung erforderlich",
    rejected_candidate: "Abgelehnt – Risikokonstellation spricht gegen Freigabe",
    deferred_review:    "Zurückgestellt – widersprüchliche Signale, erneute Prüfung nach Datenupdate",
    needs_more_data:    "Mehr Daten nötig – Signalbasis reicht noch nicht für eine Entscheidung",
  };
  function buildDecisionLayerBlock() {
    if (!decisionLayer || !decisionLayer.decisionStatus) return "";
    const parts = [];
    const statusLabel = DECISION_STATUS_LABELS[decisionLayer.decisionStatus] || decisionLayer.decisionStatus;
    parts.push(`Entscheidungsstatus (Step 7 Block 3): ${statusLabel}`);
    if (decisionLayer.decisionReason) {
      parts.push(`Begründung: ${decisionLayer.decisionReason}`);
    }
    if (decisionLayer.approvalOutcome) {
      const outcomeLabels = {
        approval_likely:   "Freigabe wahrscheinlich",
        rejection_likely:  "Ablehnung wahrscheinlich",
        proposal_pending:  "Vorschlag ausstehend",
      };
      parts.push(`Erwartetes Ergebnis: ${outcomeLabels[decisionLayer.approvalOutcome] || decisionLayer.approvalOutcome}`);
    }
    if (decisionLayer.decisionReadiness && decisionLayer.decisionReadiness !== "not_applicable") {
      const readinessLabels = {
        review_complete:  "Prüfung abgeschlossen",
        awaiting_review:  "Wartet auf Prüfung",
        deferred:         "Zurückgestellt",
        not_ready:        "Noch nicht entscheidungsreif",
        proposal_available: "Vorschlag verfügbar",
      };
      parts.push(`Entscheidungsreife: ${readinessLabels[decisionLayer.decisionReadiness] || decisionLayer.decisionReadiness}`);
    }
    return parts.join(" · ");
  }
  const decisionLayerBlock = buildDecisionLayerBlock();

  // Step 7 Block 4: Controlled Approval Flow block – explains the next controlled follow-up step.
  const CAF_STATUS_LABELS = {
    approved_pending_action: "Bereit zur manuellen Aktion – Freigabe-Kandidat wartet auf Bestätigung",
    awaiting_review:         "Wartet auf Prüfung – manuelle Bewertung steht noch aus",
    deferred:                "Zurückgestellt – erneute Prüfung nach Datenupdate geplant",
    waiting_for_more_data:   "Mehr Daten nötig – passive Beobachtung bis Signalbasis ausreicht",
    closed:                  "Abgeschlossen – keine weitere Aktion erforderlich",
    proposal_available:      "Vorschlag verfügbar – Nutzer kann eigenständig prüfen",
  };
  const CAF_ACTION_LABELS = {
    ready_for_manual_action:   "Manuelle Bestätigung empfohlen",
    no_action:                 "Keine Aktion erforderlich",
    wait_for_reassessment:     "Abwarten und bei Datenupdate erneut prüfen",
    collect_more_signals:      "Weitere Signale sammeln",
    pending_human_review:      "Manuelle Prüfung ausstehend",
    user_may_review_proposal:  "Nutzer kann Vorschlag prüfen",
  };
  function buildControlledApprovalFlowBlock() {
    if (!controlledApprovalFlow || !controlledApprovalFlow.approvalFlowStatus) return "";
    const parts = [];
    const statusLabel = CAF_STATUS_LABELS[controlledApprovalFlow.approvalFlowStatus] || controlledApprovalFlow.approvalFlowStatus;
    parts.push(`Folgestatus (Step 7 Block 4): ${statusLabel}`);
    if (controlledApprovalFlow.postDecisionAction) {
      const actionLabel = CAF_ACTION_LABELS[controlledApprovalFlow.postDecisionAction] || controlledApprovalFlow.postDecisionAction;
      parts.push(`Nächster Schritt: ${actionLabel}`);
    }
    if (controlledApprovalFlow.closureStatus) {
      parts.push(`Abschlussstatus: ${controlledApprovalFlow.closureStatus === "closed_rejected" ? "Abgelehnt und geschlossen" : controlledApprovalFlow.closureStatus}`);
    }
    if (controlledApprovalFlow.deferUntil) {
      parts.push(`Vertagt bis: ${controlledApprovalFlow.deferUntil}`);
    }
    if (controlledApprovalFlow.actionLifecycleStage) {
      const lifecycleLabels = {
        post_decision: "Nach Entscheidung",
        closed:        "Abgeschlossen",
        deferred:      "Zurückgestellt",
        pre_decision:  "Vor Entscheidung",
        in_review:     "In Prüfung",
        proposal:      "Vorschlagsphase",
      };
      parts.push(`Lebenszyklusphase: ${lifecycleLabels[controlledApprovalFlow.actionLifecycleStage] || controlledApprovalFlow.actionLifecycleStage}`);
    }
    return parts.join(" · ");
  }
  const controlledApprovalFlowBlock = buildControlledApprovalFlowBlock();

  // Step 7 Block 5: Audit/trace/safety block – explains why the system is in this governance state,
  // which guardrail or rule fired, and where the case stands in the controlled lifecycle.
  const GOVERNANCE_STATUS_LABELS = {
    review_controlled:  "Freigabe-kontrolliert – manuelle Prüfung erforderlich",
    proposal_available: "Vorschlag verfügbar – Nutzer kann eigenständig entscheiden",
    data_limited:       "Datenbasis begrenzt – Signalqualität unzureichend für Entscheidung",
    observation:        "Beobachtung – kein Handlungsbedarf, reguläres Monitoring",
    closed:             "Abgeschlossen – keine weitere Aktion erforderlich",
  };
  function buildAuditTraceBlock() {
    if (!auditTrace) return "";
    const parts = [];
    if (auditTrace.governanceStatus) {
      const label = GOVERNANCE_STATUS_LABELS[auditTrace.governanceStatus] || auditTrace.governanceStatus;
      parts.push(`Governance-Status: ${label}`);
    }
    if (auditTrace.blockedByGuardrail) {
      parts.push("⚠ Guardrail aktiv – das System hat die Aktion automatisch begrenzt");
    }
    if (auditTrace.traceReason) {
      parts.push(`Begründung: ${auditTrace.traceReason}`);
    }
    if (auditTrace.tracePath) {
      parts.push(`Lifecycle-Pfad: ${auditTrace.tracePath}`);
    }
    if (Array.isArray(auditTrace.safetyFlags) && auditTrace.safetyFlags.length) {
      parts.push(`Safety-Flags: ${auditTrace.safetyFlags.join(", ")}`);
    }
    return parts.length ? `Audit-Trace (Step 7 Block 5): ${parts.join(" · ")}` : "";
  }
  const auditTraceBlock = buildAuditTraceBlock();

  // Step 8 Block 1: Governance context block – actor role, SoD, tenant scope classification.
  function buildGovernanceContextBlock() {
    if (!governanceContext) return "";
    const parts = [];
    if (governanceContext.actorRole) {
      const roleLabels = {
        platform_admin: "Plattform-Admin (Policy-Verwaltung, keine Freigabe-Rechte)",
        operator:       "Operator (Review & Freigabe, kein Policy-Zugriff)",
        auditor:        "Auditor (Audit-Einsicht, keine Änderungs- oder Freigabe-Rechte)",
        viewer:         "Betrachter (Nur-Lesen, keine Governance-Rechte)",
      };
      parts.push(`Akteurrolle: ${roleLabels[governanceContext.actorRole] || governanceContext.actorRole}`);
    }
    if (governanceContext.governanceRole) {
      parts.push(`Governance-Rolle: ${governanceContext.governanceRole}`);
    }
    if (governanceContext.separationOfDutiesFlag) {
      parts.push("Separation-of-Duties: aktiv");
    }
    if (governanceContext.requiresApproval) {
      parts.push(`Freigabe erforderlich: ${governanceContext.actorCanApprove ? "Akteur darf freigeben" : "Akteur darf nicht freigeben"}`);
    }
    if (governanceContext.isBlocked) {
      parts.push("⚠ Governance-Sperre: Aktion blockiert");
    }
    if (governanceContext.sodConflict) {
      parts.push("⚠ SoD-Konflikt: Gleichzeitige Policy- und Freigabe-Rechte erkannt");
    }
    return parts.length ? `Governance-Kontext (Step 8 Block 1): ${parts.join(" · ")}` : "";
  }
  const governanceContextBlock = buildGovernanceContextBlock();

  // Step 8 Block 2: Operating Console / Exception Hub block – exception type and priority.
  function buildExceptionHubBlock() {
    if (!exceptionFields || exceptionFields.exceptionType === "normal") return "";
    const parts = [];
    const exceptionLabels = {
      guardrail_blocked:   "🛑 Guardrail-Sperre: Aktion blockiert",
      risk_review_pending: "🔴 Risiko-Review ausstehend",
      review_required:     "🔴 Freigabe-Review offen",
      needs_more_data:     "🟡 Mehr Daten erforderlich",
      deferred:            "🟡 Zurückgestellt",
      pending_approval:    "🟡 Freigabe ausstehend",
    };
    const label = exceptionLabels[exceptionFields.exceptionType] || exceptionFields.exceptionType;
    parts.push(`Ausnahme-Typ: ${label}`);
    if (exceptionFields.exceptionPriority) {
      parts.push(`Ausnahme-Priorität: ${exceptionFields.exceptionPriority}`);
    }
    return parts.length ? `Operating-Console-Ausnahme (Step 8 Block 2): ${parts.join(" · ")}` : "";
  }
  const exceptionHubBlock = buildExceptionHubBlock();

  // Step 8 Block 3: Policy Plane block – policy version/status/mode, shadow, four-eyes.
  function buildPolicyPlaneBlock() {
    if (!policyPlane) return "";
    const parts = [];
    if (policyPlane.policyVersion) {
      parts.push(`Policy-Version: ${policyPlane.policyVersion}`);
    }
    if (policyPlane.policyStatus && policyPlane.policyStatus !== "active") {
      const statusLabels = {
        pending_approval: "⏳ Freigabe ausstehend",
        shadow:           "👁 Shadow-Modus (Beobachtung)",
        draft:            "📝 Entwurf (nicht aktiv)",
      };
      parts.push(`Policy-Status: ${statusLabels[policyPlane.policyStatus] || policyPlane.policyStatus}`);
    }
    if (policyPlane.policyMode && policyPlane.policyMode !== "live") {
      const modeLabels = {
        shadow: "Shadow-Modus – keine reale Aktion",
        draft:  "Entwurfsmodus – noch nicht aktiv",
      };
      parts.push(`Policy-Modus: ${modeLabels[policyPlane.policyMode] || policyPlane.policyMode}`);
    }
    if (policyPlane.requiresSecondApproval) {
      parts.push(`Vier-Augen-Freigabe erforderlich: ${policyPlane.secondApprovalReady ? "Zweiter Genehmiger verfügbar" : "Zweiter Genehmiger ausstehend"}`);
    }
    if (policyPlane.shadowModeEligible && policyPlane.policyMode === "live") {
      parts.push("Shadow-Test möglich: Policy kann im Shadow-Modus evaluiert werden");
    }
    if (policyPlane.shadowReason) {
      parts.push(`Shadow-Grund: ${policyPlane.shadowReason}`);
    }
    return parts.length ? `Policy-Plane (Step 8 Block 3): ${parts.join(" · ")}` : "";
  }
  const policyPlaneBlock = buildPolicyPlaneBlock();

  // Step 8 Block 4: Evidence Package block – policy validity, fingerprint, approval history, operator trace.
  function buildEvidencePackageBlock() {
    if (!evidencePackage && !policyValidity) return "";
    const parts = [];
    if (policyValidity && policyValidity !== "valid") {
      const validityLabels = {
        pending:   "⏳ Policy ausstehend (Freigabe/Shadow)",
        suspended: "🚫 Policy ausgesetzt (Guardrail/Entwurf)",
      };
      parts.push(`Policy-Gültigkeit: ${validityLabels[policyValidity] || policyValidity}`);
    }
    if (evidencePackage?.policyFingerprint) {
      parts.push(`Policy-Fingerabdruck: ${evidencePackage.policyFingerprint}`);
    }
    if (evidencePackage?.governanceStatus && evidencePackage.governanceStatus !== "observation") {
      parts.push(`Governance-Status: ${evidencePackage.governanceStatus}`);
    }
    if (evidencePackage?.approvalSummary?.requiresSecondApproval === true) {
      const secondReady = evidencePackage?.approvalSummary?.approvalState === "awaiting_second";
      parts.push(`Vier-Augen-Freigabe in Evidence-Paket: ${secondReady ? "ausstehend" : "bereit"}`);
    }
    const history = evidencePackage?.policyApprovalHistory;
    if (Array.isArray(history) && history.length > 0) {
      const histSummary = history.map((h) => `${h.event}:${h.state}`).join(", ");
      parts.push(`Freigabe-Historie: ${histSummary}`);
    }
    return parts.length ? `Evidence-Paket (Step 8 Block 4): ${parts.join(" · ")}` : "";
  }
  const evidencePackageBlock = buildEvidencePackageBlock();

  // Step 8 Block 5: Tenant/resource governance block – load band, quota, guardrail.
  function buildTenantResourceGovernanceBlock() {
    if (!tenantResourceGovernance) return "";
    const parts = [];
    const { tenantLoadBand, resourceGovernanceStatus, resourceGuardrail, quotaWarning, rateLimitRisk, backlogPressure, tenantMaxAutonomyLevel } = tenantResourceGovernance;

    if (resourceGovernanceStatus === "hard_gated") {
      parts.push("🔒 Ressource gesperrt (hard-gated) – manuelle Freigabe erforderlich");
    } else if (resourceGovernanceStatus === "controlled") {
      parts.push("⚙️ Ressource kontrolliert – aktive Governance-Überwachung");
    }
    if (quotaWarning) {
      parts.push(`⚠️ Quota-Warnung: Tenant-Last hoch (Band: ${tenantLoadBand})`);
    }
    if (rateLimitRisk === "high") {
      parts.push("🚦 Rate-Limit-Risiko: hoch");
    } else if (rateLimitRisk === "medium") {
      parts.push("🚦 Rate-Limit-Risiko: mittel");
    }
    if (backlogPressure === "elevated") {
      parts.push("📋 Backlog-Druck erhöht – offene Nachverfolgung und ausstehende Entscheidung");
    }
    if (tenantMaxAutonomyLevel === "restricted") {
      parts.push("🛡 Maximale Autonomie eingeschränkt (restricted) – erhöhte Governance-Kontrolle");
    }
    if (resourceGuardrail === "active") {
      parts.push("Ressource-Guardrail: aktiv");
    } else if (resourceGuardrail === "standby") {
      parts.push("Ressource-Guardrail: Bereitschaft");
    }
    return parts.length ? `Tenant/Ressource-Governance (Step 8 Block 5): ${parts.join(" · ")}` : "";
  }
  const tenantResourceGovernanceBlock = buildTenantResourceGovernanceBlock();

  // Step 8 Block 6: Operational resilience block – degradation mode, fallback tier, recovery state.
  function buildOperationalResilienceBlock() {
    if (!operationalResilience) return "";
    const parts = [];
    const { degradationMode, operationalHealth, fallbackTier, recoveryState, resumeReady, resilienceFlags, systemPressureSummary } = operationalResilience;

    if (degradationMode === "critical_guarded") {
      parts.push("🚨 System kritisch abgesichert – nur essentielle Signale, kein automatischer Fortschritt");
    } else if (degradationMode === "constrained") {
      parts.push("⚠️ System eingeschränkt – reduzierter Kontext, manuelle Prüfung erforderlich");
    } else if (degradationMode === "elevated_load") {
      parts.push("🔶 Erhöhte Last – defensiver Betrieb empfohlen");
    }
    if (operationalHealth === "critical") {
      parts.push("Betriebszustand: kritisch");
    } else if (operationalHealth === "degraded") {
      parts.push("Betriebszustand: degradiert");
    }
    if (fallbackTier === "essential_only") {
      parts.push("Fallback: nur essentielle Signale aktiv");
    } else if (fallbackTier === "reduced_context") {
      parts.push("Fallback: reduzierter Kontext");
    }
    if (recoveryState === "at_risk") {
      parts.push("Recovery: gefährdet – Eingriff erforderlich");
    } else if (recoveryState === "recovering") {
      parts.push("Recovery: in Genesung");
    }
    if (resumeReady === false) {
      parts.push("⏸ Normalbetrieb noch nicht wiederhergestellt");
    }
    if (Array.isArray(resilienceFlags) && resilienceFlags.length > 0) {
      parts.push(`Aktive Flags: ${resilienceFlags.join(", ")}`);
    }
    if (systemPressureSummary && degradationMode !== "normal") {
      parts.push(systemPressureSummary);
    }
    return parts.length ? `Betriebsresilienz (Step 8 Block 6): ${parts.join(" · ")}` : "";
  }
  const operationalResilienceBlock = buildOperationalResilienceBlock();

  // Step 9 Block 1: Autonomy level block – effective level, cap, escalation.
  function buildAutonomyLevelBlock() {
    if (!autonomyLevel) return "";
    const parts = [];
    const { effectiveLevel, levelLabel, levelCap, escalationRequired, levelBasis } = autonomyLevel;

    if (effectiveLevel === "manual") {
      parts.push("🔒 Autonomie-Level: Manuell – vollständige menschliche Kontrolle erforderlich");
    } else if (effectiveLevel === "assisted") {
      parts.push("🤝 Autonomie-Level: Assistiert – System schlägt vor, Mensch entscheidet");
    } else if (effectiveLevel === "supervised") {
      parts.push("👁 Autonomie-Level: Überwacht – System führt nach Freigabe aus");
    }
    if (escalationRequired) {
      parts.push("⬆️ Eskalation erforderlich");
    }
    if (levelBasis) {
      parts.push(`Grund: ${levelBasis}`);
    }
    if (levelCap) {
      parts.push(`Autonomie-Cap: ${levelCap}`);
    }
    return parts.length ? `Autonomie-Level (Step 9 Block 1): ${parts.join(" · ")}` : "";
  }
  const autonomyLevelBlock = buildAutonomyLevelBlock();

  // Step 9 Block 1: Drift detection block – drift signals, level, baseline state.
  function buildDriftDetectionBlock() {
    if (!driftDetection) return "";
    const parts = [];
    const { driftLevel, driftSignalCount, metronomDeviation, baselineState, driftSignals } = driftDetection;

    if (driftLevel === "high") {
      parts.push("🔴 Drift-Level: Hoch – kritische Abweichungen erkannt");
    } else if (driftLevel === "medium") {
      parts.push("🟡 Drift-Level: Mittel – moderate Abweichungen erkannt");
    } else if (driftLevel === "low") {
      parts.push("🟢 Drift-Level: Niedrig – geringfügige Abweichungen");
    }
    if (metronomDeviation) {
      parts.push("Metronom-Abweichung erkannt");
    }
    if (baselineState === "critical") {
      parts.push("Baseline: Kritisch");
    } else if (baselineState === "drifting") {
      parts.push("Baseline: Driftend");
    }
    if (driftSignalCount > 0) {
      parts.push(`${driftSignalCount} Drift-Signal(e)`);
    }
    if (Array.isArray(driftSignals) && driftSignals.length > 0) {
      const top = driftSignals.slice(0, 3).map((s) => s.detail || s.signal).join(", ");
      parts.push(`Top-Signale: ${top}`);
    }
    return parts.length ? `Drift-Erkennung (Step 9 Block 1): ${parts.join(" · ")}` : "";
  }
  const driftDetectionBlock = buildDriftDetectionBlock();

  const contextLines = [convictionBlock, regimeBlock, componentsBlock, whyBlock, portfolioBlock, deltaBlock, nextActionBlock, actionOrchestrationBlock, feedbackBlock, userStateBlock, followUpBlock, adaptiveSignalBlock, userPreferenceBlock, adaptivePriorityBlock, actionReadinessBlock, approvalQueueBlock, decisionLayerBlock, controlledApprovalFlowBlock, auditTraceBlock, governanceContextBlock, exceptionHubBlock, policyPlaneBlock, evidencePackageBlock, tenantResourceGovernanceBlock, operationalResilienceBlock, autonomyLevelBlock, driftDetectionBlock]
    .filter(Boolean)
    .join("\n");

  const prompt = `
Du bist Guardian AI – ein professionelles Finanz-Analyse-System, das auf dem HQS-Framework aufbaut.

Erkläre die folgenden finalen Marktdaten:

Symbol: ${symbol}

${contextLines}

Vollständige Rohdaten:
${JSON.stringify(marketData, null, 2)}

Erstelle eine strukturierte Erklärung mit:

1. Bewertung: Bullish / Neutral / Bearish (konsistent mit Regime und HQS-Score)
2. Risiko-Level: Niedrig / Mittel / Hoch
3. Kurze Begründung (3-5 Sätze, mit Bezug auf HQS-Score, Regime und Trend)
4. Handlungsempfehlung (konsistent mit dem finalen Conviction-Score falls vorhanden)
5. Portfolio-Einordnung: Beantworte konkret, was der Portfolio-Kontext bedeutet –
   - portfolioRole="additive": bewertet ob die Aufstockung das Konzentrationsrisiko erhöht
   - portfolioRole="redundant": erklärt warum der Sektor bereits vertreten ist und ob das Risiko steigt
   - portfolioRole="diversifier": erläutert den Diversifikationsmehrwert und welchen neuen Sektor das Symbol bringt
   - portfolioRole="complement": diskutiert den optimalen Einstiegszeitpunkt für die Beobachtungsliste
   - concentrationRisk="high": explizit warnen, dass das Sektorgewicht bereits kritisch ist
   - diversificationBenefit=ja: explizit positiv auf Diversifikationsmehrwert hinweisen
   Wenn kein Portfolio-Kontext verfügbar, diesen Punkt weglassen.
6. Veränderungs-Einschätzung: Falls ein Delta-Signal vorhanden ist, erkläre präzise was sich verändert hat –
   - changeType="new_signal": Symbol ist neu im Scanner – erste Einschätzung empfehlen
   - changeType="gaining_relevance": Conviction/Relevanz ist gestiegen – Chance betonen
   - changeType="risk_increased": Risiko ist gestiegen – explizit warnen
   - changeType="losing_conviction": Überzeugung gesunken – kritisch bewerten, Vorsicht empfehlen
   - changeType="portfolio_impact_changed": Portfolio-Relevanz hat sich verändert – Konsequenz erläutern
   Wenn kein Delta-Signal vorhanden (changeType="stable"), diesen Punkt weglassen.
7. Nächster sinnvoller Schritt: Falls eine Next-Action-Empfehlung vorhanden ist, erläutere kurz warum dieser Schritt sinnvoll ist –
   - actionType="starter_position": erkläre konkret, warum jetzt ein Einstieg geprüft werden sollte
   - actionType="watchlist_upgrade": erkläre, warum das Symbol prioritär beobachtet werden sollte
   - actionType="reduce_risk": erkläre das Risiko und empfehle klar Positionsreduktion
   - actionType="avoid_adding": erkläre, warum keine weitere Aufstockung empfohlen wird
   - actionType="rebalance_review": erkläre, warum eine Rebalancing-Prüfung sinnvoll ist
   - actionType="hold": bestätige, dass keine Aktion nötig ist
   - actionType="observe": erkläre, warum nur Beobachtung empfohlen wird
   Wenn kein Next-Action-Hint vorhanden, diesen Punkt weglassen.
8. System-Einordnung: Falls Action-Orchestration vorhanden ist, erkläre kurz, warum das System diesen Behandlungsmodus gewählt hat –
   - deliveryMode="briefing_and_notification": erkläre, warum akuter Handlungsbedarf besteht und warum sowohl Briefing als auch Sofortmeldung nötig sind
   - deliveryMode="notification": erkläre, warum ein zeitkritisches Signal vorliegt, das sofort mitgeteilt werden sollte
   - deliveryMode="briefing": erkläre, warum das Signal im regulären Tages-Briefing ausreicht und keine Sofortmeldung nötig ist
   - deliveryMode="passive_briefing" oder "none": erkläre, warum kein aktiver Hinweis nötig ist und nur Beobachtung empfohlen wird
   - followUpNeeded=true: nenne konkret den empfohlenen Nachfolgeschritt und den Zeithorizont
   Wenn keine Action-Orchestration vorhanden, diesen Punkt weglassen.
9. Nutzer-Reaktion: Falls ein Feedback-Kontext vorhanden ist, erkläre kurz was die Nutzerreaktion bedeutet –
   - feedbackSignal="positive": Der Nutzer hat auf das Signal reagiert – bewerte ob die Reaktion zum aktuellen Marktbild passt
   - feedbackSignal="negative": Der Nutzer hat das Signal abgelehnt – prüfe ob die Ablehnung berechtigt war oder ob das Signal trotzdem relevant bleibt
   - responseType="dismissed": Hinweis wurde verworfen – erkläre, ob das Signal weiterhin beachtet werden sollte
   - responseType="acted": Nutzer hat Maßnahme ergriffen – bestätige oder korrigiere den Schritt auf Basis aktueller Daten
   Wenn kein Feedback-Kontext vorhanden, diesen Punkt weglassen.
10. Nutzer-Gesamtzustand: Falls ein konsolidierter Nutzer-Zustand vorhanden ist, ordne diesen kurz ein –
   - briefingUrgency="critical": Der Nutzer hat kritische offene Signale – priorisiere sofortigen Handlungsbedarf
   - briefingUrgency="high": Der Nutzer hat mehrere offene Aufmerksamkeitssignale – betone Dringlichkeit im Briefing
   - briefingUrgency="medium": Moderater Rückstand – reguläre Bearbeitung reicht aus
   - briefingUrgency="low": Kein akuter Bedarf – normales Monitoring
   Wenn kein Nutzer-Zustand vorhanden, diesen Punkt weglassen.
11. Wiedervorlage / Follow-up: Falls ein Follow-up-Kontext vorhanden ist, erkläre kurz die Einordnung –
   - followUpStatus="overdue": Das Signal ist überfällig – der Nutzer hat noch nicht reagiert. Erkläre, warum dieses Thema erneut aufgegriffen werden muss und was die empfohlene Maßnahme ist.
   - followUpStatus="pending": Eine Wiedervorlage ist geplant. Erkläre, warum das Thema noch nicht abgeschlossen ist und wann die nächste Prüfung sinnvoll ist.
   - followUpStatus="closed": Das Follow-up wurde bearbeitet. Bestätige, dass das Thema abgeschlossen werden kann oder ob es weiterhin beobachtet werden sollte.
   - reviewDue=true: Die Prüffrist ist erreicht – erkläre, welcher konkrete nächste Schritt jetzt erforderlich ist.
   - needsClosure=true: Das Follow-up wurde vom Nutzer bearbeitet und kann formal abgeschlossen werden.
   - reminderEligible=true: Erkläre kurz, warum eine Erinnerung sinnvoll ist (z.B. ungesehenes Signal, offener Outcome-Link).
   Wenn kein Follow-up-Kontext vorhanden, diesen Punkt weglassen.
12. Nutzer-Verhaltensprofil: Falls ein Nutzer-Verhaltensprofil vorhanden ist, ordne kurz ein, wie die Analyse auf diesen Nutzer abgestimmt werden sollte –
   - riskSensitivity="risk_averse": Betone Risiko-Aspekte stärker, da der Nutzer auf Risiko-Signale besonders anspricht
   - riskSensitivity="opportunity_seeker": Betone Chancen und Kaufsignale, da der Nutzer auf positive Szenarien reagiert
   - notificationFatigue="high": Halte die Analyse besonders prägnant und priorisiert – der Nutzer wird von zu vielen Hinweisen überwältigt
   - actionResponsiveness="low": Weise explizit auf Dringlichkeit hin, wenn das Signal zeitkritisch ist
   - explorationAffinity="high": Betone neue oder unbekannte Signale, da der Nutzer Discovery-Hinweise schätzt
   Wenn kein Nutzer-Verhaltensprofil vorhanden, diesen Punkt weglassen.
13. Adaptive Priorisierung: Falls ein adaptives Priorisierungs-Signal vorhanden ist, erkläre kurz, warum das System dieses Thema für diesen Nutzer höher oder niedriger eingestuft hat –
   - Priorität erhöht: nenne den Grund (z.B. Risikoaversion, Entdeckungsaffinität, hohe Signal-Trefferquote) und bestätige, ob die Höherstufung zum aktuellen Marktbild passt
   - Priorität reduziert: nenne den Grund (z.B. Benachrichtigungs-Sättigung, niedrige Signal-Trefferquote) und weise hin, falls das Thema trotzdem relevant bleibt
   - Wichtig: Risiko-Signale, Guardian-Warnungen und kritische Follow-up-Pflichten bleiben immer dominant – Nutzerpräferenzen können diese nicht außer Kraft setzen. Falls ein adaptives Signal eine Risiko- oder kritische Warnung betrifft, weise explizit darauf hin, dass die Risikobewertung unverändert bleibt.
   - Halte die Erklärung kurz (1–2 Sätze) und nachvollziehbar – keine neue Analyse, nur Einordnung der Systementscheidung
   Wenn kein adaptives Priorisierungs-Signal vorhanden, diesen Punkt weglassen.
14. Aktionsbereitschaft (Step 7): Falls eine Aktionsbereitschafts-Klassifizierung vorhanden ist, erkläre kurz, warum das Signal in diese Stufe eingeordnet wurde –
   - actionReadiness="review_required": erkläre, warum eine manuelle Freigabe nötig ist (z.B. Risikoreduktion, Konzentrationsrisiko, kritischer Aufmerksamkeitslevel) und was der Nutzer jetzt prüfen sollte
   - actionReadiness="proposal_ready": erkläre, dass ein strukturierter Vorschlag vorliegt, aber keine automatische Ausführung stattfindet – was sollte der Nutzer als nächsten Schritt prüfen?
   - actionReadiness="monitor_only": erkläre, warum nur Beobachtung empfohlen wird – kein Handlungsbedarf, aber weiter im Auge behalten
   - actionReadiness="insufficient_confidence": erkläre, warum die Datenbasis noch nicht ausreicht – was fehlt, damit das Signal aktionsreif wird?
   - approvalRequired=true: weise explizit darauf hin, dass keine Aktion ohne Nutzer-Freigabe stattfindet – das System handelt nicht eigenständig
   Wenn keine Aktionsbereitschafts-Klassifizierung vorhanden, diesen Punkt weglassen.
15. Freigabe-Queue (Step 7 Block 2): Falls ein Freigabe-Queue-Eintrag vorhanden ist, erkläre kurz und verständlich den Review-Status –
   - pendingApproval=true + approvalQueueBucket="risk_review": erkläre, warum das Signal einer Risiko-Prüfung unterzogen wird (z.B. Reduce-Risk-Aktion, hohes Konzentrationsrisiko, Rebalancing) und was der Nutzer konkret prüfen sollte, bevor er handelt
   - pendingApproval=true + approvalQueueBucket="proposal_bucket": erkläre, dass ein Vorschlag zur manuellen Freigabe bereit liegt – was macht diesen Vorschlag freigabewürdig und was fehlt noch für eine sichere Entscheidung?
   - pendingApproval=false + approvalQueueBucket="proposal_bucket": erkläre, dass ein strukturierter Vorschlag vorliegt, aber keine formale Freigabe erforderlich ist – der Nutzer kann selbst entscheiden
   - pendingApproval=false + approvalQueueBucket="insufficient_data": erkläre klar, warum das Signal noch nicht freigabereif ist und was beobachtet werden muss, damit es in die Queue aufsteigen kann
   - reviewPriority="high": weise explizit auf die hohe Dringlichkeit der Prüfung hin
   - reviewSummary vorhanden: verwende es als kurze Zusammenfassung des Review-Status
   - Halte die Erklärung kurz (1–3 Sätze) – keine neue Analyse, nur Einordnung des Freigabe-Status
   Wenn kein Freigabe-Queue-Eintrag vorhanden, diesen Punkt weglassen.
16. Entscheidungsstatus (Step 7 Block 3): Falls ein Entscheidungs-Layer vorhanden ist, erkläre kurz und verständlich den aktuellen Entscheidungszustand –
    - decisionStatus="approved_candidate": erkläre, warum dieser Fall als Freigabe-Kandidat eingestuft wurde – starke Datenbasis, konsistente Signale, aber weiterhin manuelle Bestätigung erforderlich. Keine automatische Genehmigung.
    - decisionStatus="pending_review": erkläre, warum der Fall noch geprüft werden muss – welche offenen Fragen oder Risiken bestehen, und was der Nutzer als nächstes bewerten sollte.
    - decisionStatus="rejected_candidate": erkläre, warum die Datenlage gegen eine Freigabe spricht – welche Risikosignale überwiegen und warum Vorsicht geboten ist.
    - decisionStatus="deferred_review": erkläre, warum der Fall zurückgestellt wurde – widersprüchliche Signale, und wann eine erneute Prüfung sinnvoll wäre.
    - decisionStatus="needs_more_data": erkläre, warum noch nicht genug Daten für eine Entscheidung vorliegen – was fehlt konkret, und was beobachtet werden muss.
    - decisionReason vorhanden: verwende es als Kontext für die Erklärung
    - Wichtig: Kein Entscheidungsstatus bedeutet keine automatische Genehmigung. Auch approved_candidate erfordert manuelle Bestätigung.
    - Halte die Erklärung kurz (1–3 Sätze) – verständlich und nachvollziehbar
    Wenn kein Entscheidungs-Layer vorhanden, diesen Punkt weglassen.
17. Kontrollierter Folgefluss (Step 7 Block 4): Falls ein kontrollierter Approval-Folgefluss vorhanden ist, erkläre kurz und verständlich, was jetzt als Nächstes passiert –
    - approvalFlowStatus="approved_pending_action": erkläre, dass der Fall als Freigabe-Kandidat bereitsteht und auf manuelle Bestätigung wartet – keine automatische Ausführung, der Nutzer entscheidet
    - approvalFlowStatus="awaiting_review": erkläre, dass der Fall noch geprüft werden muss – was steht aus und was sollte der Nutzer als nächstes tun
    - approvalFlowStatus="deferred": erkläre, warum der Fall zurückgestellt wurde – widersprüchliche Signale, Datenupdate abwarten, und wann eine erneute Prüfung geplant ist
    - approvalFlowStatus="waiting_for_more_data": erkläre, warum noch mehr Daten benötigt werden – was fehlt und wie lange typischerweise gewartet wird
    - approvalFlowStatus="closed": erkläre, warum der Fall abgeschlossen ist – Risikokonstellation, keine Aktion mehr nötig
    - approvalFlowStatus="proposal_available": erkläre, dass ein strukturierter Vorschlag vorliegt, den der Nutzer eigenständig prüfen kann – keine formale Freigabe erforderlich
    - postDecisionAction vorhanden: verwende es als Kontext für den nächsten konkreten Schritt
    - deferUntil vorhanden: nenne das geplante Datum der erneuten Prüfung
    - Wichtig: Der Folgefluss ist kontrolliert und nicht automatisch. Kein Schritt wird ohne manuelle Bestätigung ausgeführt.
    - Halte die Erklärung kurz (1–3 Sätze) – klar, nachvollziehbar und handlungsorientiert
    Wenn kein kontrollierter Folgefluss vorhanden, diesen Punkt weglassen.
18. Audit-, Safety- & Traceability-Status (Step 7 Block 5): Falls ein Audit-Trace vorhanden ist, erkläre kurz und nachvollziehbar, warum das System diesen Fall so eingestuft, begrenzt oder freigegeben hat –
    - governanceStatus="review_controlled": erkläre, warum eine manuelle Freigabe erforderlich ist und welche Governance-Regel gegriffen hat – kein automatischer Fortschritt ohne Nutzer-Bestätigung
    - governanceStatus="proposal_available": erkläre, dass ein Vorschlag zur eigenständigen Nutzerentscheidung bereitsteht – keine formale Freigabepflicht, aber Verantwortung liegt beim Nutzer
    - governanceStatus="data_limited": erkläre klar, warum die Datenbasis oder Signalqualität noch keine Entscheidung erlaubt – was fehlt und was beobachtet werden sollte
    - governanceStatus="observation": erkläre, warum kein Handlungsbedarf besteht – das Signal wird regulär beobachtet, aber es gibt keinen Grund für eine Aktion
    - governanceStatus="closed": erkläre, warum der Fall abgeschlossen ist – welche Entscheidung getroffen wurde und warum keine weitere Aktion mehr nötig ist
    - blockedByGuardrail=true: erkläre klar, warum das System automatisch eine Grenze gesetzt hat – welche Sicherheits- oder Governance-Regel gegriffen hat, und warum das System in diesem Fall nicht eigenständig weitergehen darf
    - traceReason vorhanden: nutze es als direkte Erklärung, warum das System diese Einstufung vorgenommen hat
    - safetyFlags vorhanden: erkläre, was diese Flags bedeuten und wie sie die Klassifizierung beeinflusst haben
    - Wichtig: Kein Hinweis in diesem Block bedeutet eine automatische Genehmigung oder Ausführung. Das System handelt nie selbstständig – jeder Schritt erfordert menschliche Einschätzung.
    - Halte die Erklärung kurz (1–3 Sätze) – klar, nachvollziehbar und governance-kompatibel
    Wenn kein Audit-Trace vorhanden, diesen Punkt weglassen.
19. Governance-Kontext (Step 8 Block 1): Falls ein Governance-Kontext vorhanden ist, erkläre kurz und nachvollziehbar die Rollen- und Verantwortungsstruktur –
    - actorRole="platform_admin": erkläre, dass dieser Akteur Plattform-Policies verwalten kann, aber keine operativen Freigaben erteilen darf (Separation of Duties)
    - actorRole="operator": erkläre, dass dieser Akteur operative Reviews und Freigaben durchführen kann, aber keine Policies ändern darf
    - actorRole="auditor": erkläre, dass dieser Akteur Audit- und Governance-Daten einsehen kann, aber weder Änderungen noch Freigaben vornehmen darf
    - actorRole="viewer": erkläre, dass dieser Akteur nur Lese-Zugriff auf Signale und Portfolio-Daten hat – keine Governance-Rechte
    - separationOfDutiesFlag=true: weise darauf hin, dass Trennung von Verantwortlichkeiten aktiv ist – kein Akteur kann gleichzeitig Policies ändern UND Freigaben erteilen
    - sodConflict=true: erkläre, warum ein Separation-of-Duties-Konflikt erkannt wurde und dass in diesem Fall keine Aktion möglich ist, bis die Rollen geklärt sind
    - Halte die Erklärung kurz (1–2 Sätze) – nur Governance-Einordnung, keine neue Analyse
    Wenn kein Governance-Kontext vorhanden, diesen Punkt weglassen.
20. Operating-Console-Ausnahme (Step 8 Block 2): Falls eine Exception-Hub-Klassifizierung vorhanden ist, erkläre kurz den operativen Ausnahme-Zustand –
     - exceptionType="guardrail_blocked": erkläre, dass das System eine operative Sperre gesetzt hat und keine Zustellung oder Aktion möglich ist, bis die Sperre manuell aufgehoben wird
     - exceptionType="risk_review_pending": erkläre, dass ein Risiko-Review aussteht – der Operator muss den Fall prüfen und freigeben, bevor eine Aktion möglich ist
     - exceptionType="review_required": erkläre, dass eine manuelle Prüfung erforderlich ist – kein automatischer Fortschritt ohne Nutzer-Bestätigung
     - exceptionType="needs_more_data": erkläre, dass die Datenbasis noch nicht ausreicht – das System wartet auf weitere Signale oder Nutzeraktionen
     - exceptionType="deferred": erkläre, warum der Fall zurückgestellt wurde – wann eine erneute Prüfung sinnvoll ist
     - exceptionType="pending_approval": erkläre, dass eine Freigabe aussteht – der Nutzer muss aktiv werden
     - exceptionPriority="critical": weise explizit auf die höchste Dringlichkeit hin – sofortiger Handlungsbedarf
     - exceptionPriority="high": weise auf erhöhten Handlungsbedarf hin – baldige Prüfung empfohlen
     - Halte die Erklärung kurz (1–2 Sätze) – nur Leitstands-Einordnung, keine neue Analyse
     Wenn kein Exception-Hub vorhanden oder exceptionType="normal", diesen Punkt weglassen.
21. Policy-Plane (Step 8 Block 3): Falls ein Policy-Plane-Kontext vorhanden ist, erkläre kurz die Policy-Ebene –
     - policyStatus="pending_approval": erkläre, dass eine Policy-Mutation oder -Aktivierung noch eine Freigabe benötigt – kein automatischer Fortschritt
     - policyStatus="shadow": erkläre, dass diese Policy im Shadow-Modus evaluiert wird – nur Beobachtung, keine reale Aktion
     - policyStatus="draft": erkläre, dass diese Policy noch im Entwurfsstadium ist – noch nicht aktiv, noch nicht freigegeben
     - policyMode="shadow": weise darauf hin, dass die aktuelle Bewertung im Shadow-Modus stattfindet – was-wäre-wenn-Basis, keine Auswirkung auf echte Aktionen
     - policyMode="draft": weise darauf hin, dass die Policy im Entwurfsmodus ist – aktive Sperrung verhindert Weitergang
     - requiresSecondApproval=true: erkläre, dass eine Vier-Augen-Freigabe erforderlich ist – eine zweite unabhängige Bestätigung muss vorliegen, bevor die Policy-Mutation vollzogen werden kann
     - secondApprovalReady=true: bestätige, dass ein geeigneter zweiter Genehmiger verfügbar ist
     - secondApprovalReady=false (bei requiresSecondApproval=true): weise darauf hin, dass noch kein zweiter Genehmiger vorhanden ist
     - shadowModeEligible=true (bei policyMode="live"): nenne kurz, dass ein Shadow-Test für diese Policy möglich wäre, bevor sie live geht
     - Halte die Erklärung kurz (1–2 Sätze) – nur Policy-Ebenen-Einordnung, keine neue Analyse
     Wenn kein Policy-Plane-Kontext vorhanden oder policyMode="live" und policyStatus="active", diesen Punkt weglassen.
22. Evidence-Paket (Step 8 Block 4): Falls ein Evidence-Paket vorhanden ist, erkläre kurz den Policy-Nachweis-Status –
     - policyValidity="suspended": erkläre, dass die Policy durch einen Guardrail oder Entwurfsstatus ausgesetzt ist – keine Aktion ohne manuelle Freigabe
     - policyValidity="pending": erkläre, dass die Policy noch aussteht (Freigabe ausstehend oder Shadow-Evaluierung läuft) – Aktivierung erfordert Bestätigung
     - policyFingerprint vorhanden: weise kurz darauf hin, dass der Policy-Zustand versioniert und nachvollziehbar ist (kein Kryptographie-Nachweis – strukturierter interner Nachweis)
     - policyApprovalHistory vorhanden: erkläre kurz die Freigabe-Kette (z.B. governance_status → decision_recorded → approval_flow) als nachvollziehbare Entscheidungsspur
     - requiresSecondApproval=true in approvalSummary: bestätige, dass die Vier-Augen-Anforderung im Evidence-Paket verankert ist
     - Halte die Erklärung kurz (1–2 Sätze) – nur Evidence-Einordnung, keine neue Analyse
     Wenn kein Evidence-Paket vorhanden oder policyValidity="valid", diesen Punkt weglassen.
23. Tenant/Ressource-Governance (Step 8 Block 5): Falls ein Tenant/Ressource-Governance-Kontext vorhanden ist, erkläre kurz den Ressourcen- und Plattform-Schutzstatus –
     - resourceGovernanceStatus="hard_gated": erkläre, dass die Ressource durch einen aktiven Guardrail gesperrt ist – keine automatische Verarbeitung oder Zustellung möglich, bis die Sperre manuell aufgehoben wird
     - resourceGovernanceStatus="controlled": erkläre, dass die Ressource unter aktiver Governance-Kontrolle steht – Reviews und Freigaben sind erforderlich
     - quotaWarning=true: weise kurz darauf hin, dass der Tenant-Lastpegel erhöht ist und eine Quota-Warnung aktiv ist – das System arbeitet defensiv
     - rateLimitRisk="high": erkläre, dass ein hohes Rate-Limit-Risiko besteht – das System kann Zustellungen oder Verarbeitungsschritte defensiv drosseln
     - backlogPressure="elevated": erkläre, dass ein erhöhter Backlog-Druck vorliegt – offene Nachverfolgung und ausstehende Entscheidungen belasten die Plattform
     - tenantMaxAutonomyLevel="restricted": weise darauf hin, dass die maximale Autonomie eingeschränkt ist – erhöhte menschliche Kontrolle ist in diesem Kontext erforderlich
     - resourceGuardrail="active": bestätige, dass der Ressource-Guardrail aktiv ist und Schutzmaßnahmen greifen
     - Halte die Erklärung kurz (1–2 Sätze) – nur Ressourcen-/Tenant-Einordnung, keine neue Analyse
     Wenn kein Tenant/Ressource-Governance-Kontext vorhanden oder resourceGovernanceStatus="open" und keine Quota-Warnung, diesen Punkt weglassen.
24. Betriebsresilienz (Step 8 Block 6): Falls ein Betriebsresilienz-Kontext vorhanden ist, erkläre kurz, ob das System aktuell defensiver oder reduzierter arbeitet –
     - degradationMode="critical_guarded": erkläre, dass das System im kritisch abgesicherten Modus arbeitet – nur essentielle Signale werden priorisiert, kein automatischer Fortschritt möglich, manueller Eingriff erforderlich
     - degradationMode="constrained": erkläre, dass das System eingeschränkt arbeitet – reduzierter Kontext, wichtige Entscheidungen erfordern manuelle Prüfung
     - degradationMode="elevated_load": weise darauf hin, dass das System unter erhöhter Last steht – defensiver Betrieb ist empfohlen, alle kritischen Signale bleiben aktiv
     - operationalHealth="critical": erkläre, dass der Betriebszustand kritisch ist – sofortiger Eingriff empfohlen
     - operationalHealth="degraded": erkläre, dass der Betriebszustand degradiert ist – Genesung läuft, Überwachung erforderlich
     - fallbackTier="essential_only": weise darauf hin, dass nur essentielle Signale aktiv sind – nicht-kritische Kontextfelder werden zurückgehalten
     - fallbackTier="reduced_context": erkläre, dass ein reduzierter Kontext aktiv ist – einige Governance-Felder sind eingeschränkt verfügbar
     - recoveryState="at_risk": erkläre, dass die Genesung gefährdet ist – das System kann ohne Eingriff nicht in den Normalbetrieb zurückkehren
     - recoveryState="recovering": weise darauf hin, dass die Genesung läuft – kein sofortiger Eingriff nötig, aber weiter beobachten
     - resumeReady=false: erkläre, dass der Normalbetrieb noch nicht wiederhergestellt ist – offene Sperren oder Backlog-Druck verhindern den Übergang
     - Halte die Erklärung kurz (1–2 Sätze) – nur Resilienz-Einordnung, keine neue Analyse
     Wenn kein Betriebsresilienz-Kontext vorhanden oder degradationMode="normal", diesen Punkt weglassen.
25. Autonomie-Level (Step 9 Block 1): Falls ein Autonomie-Level-Kontext vorhanden ist, erkläre kurz, in welchem Autonomie-Modus die Opportunity aktuell verarbeitet wird –
     - effectiveLevel="manual": erkläre, dass vollständige menschliche Kontrolle erforderlich ist – kein automatisierter Schritt ohne Eingriff
     - effectiveLevel="assisted": erkläre, dass das System Vorschläge macht, aber der Mensch entscheidet und ausführt
     - effectiveLevel="supervised": erkläre, dass das System nach menschlicher Freigabe ausführt – überwachte Automatisierung
     - escalationRequired=true: weise darauf hin, dass eine Eskalation erforderlich ist – der Autonomie-Level erfordert erweiterte menschliche Kontrolle
     - Halte die Erklärung kurz (1–2 Sätze) – nur Autonomie-Einordnung, keine neue Analyse
     Wenn kein Autonomie-Level-Kontext vorhanden oder effectiveLevel="assisted" (Standard), diesen Punkt weglassen.
26. Drift-Erkennung (Step 9 Block 1): Falls ein Drift-Erkennungs-Kontext vorhanden ist, erkläre kurz, ob Abweichungen vom normalen Betriebszustand erkannt wurden –
     - driftLevel="high": erkläre, dass kritische Abweichungen erkannt wurden – Governance-, Policy- oder Resilienzsignale weichen erheblich ab
     - driftLevel="medium": erkläre, dass moderate Abweichungen vorliegen – einige Signale weichen vom Normalzustand ab
     - driftLevel="low": weise darauf hin, dass geringfügige Abweichungen erkannt wurden – Beobachtung empfohlen
     - metronomDeviation=true: erkläre, dass mindestens ein Signal vom erwarteten Normalbetrieb abweicht
     - baselineState="critical": weise darauf hin, dass die Baseline kritisch abweicht
     - baselineState="drifting": weise darauf hin, dass die Baseline driftet – Normalisierung erwartet, aber Überwachung erforderlich
     - Halte die Erklärung kurz (1–2 Sätze) – nur Drift-Einordnung, keine neue Analyse
     Wenn kein Drift-Kontext vorhanden oder driftLevel="none", diesen Punkt weglassen.
`;

  const response = await getClient().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.4,
  });

  return response.choices[0].message.content;
}

module.exports = { analyzeStockWithGuardian, detectMissingCanonicalFields };
