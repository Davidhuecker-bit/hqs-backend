"use strict";

require("dotenv").config();

const logger = require("../utils/logger");
const { runJob } = require("../utils/jobRunner");
const { acquireLock, releaseLock } = require("../services/jobLock.repository");
const { savePipelineStage } = require("../services/pipelineStatus.repository");

const { discoverStocks } = require("../services/discoveryEngine.service");
const {
  createDiscoveryNotification,
  linkFollowUpOutcome,
  computeUserState,
  getReminderEligibleNotifications,
  computeUserPreferenceHints,
} = require("../services/notifications.repository");
const { sendPushToUser } = require("../services/pushDelivery.service");

/**
 * Derive a minimal Action-Orchestration for a discovery pick.
 * Discovery picks don't go through getTopOpportunities(), so we derive
 * deliveryMode and escalationLevel directly from pick confidence/score.
 *
 * Also attaches actionReadiness (Step 7 Block 1) so the notification gate
 * can suppress monitor_only picks and prioritise review_required / proposal_ready.
 *
 * Step 7 Block 2: attaches reviewBucket so the delivery loop can log and
 * observe which queue tier each pick falls into. No execution change.
 *
 * Step 7 Block 3: attaches decisionStatus so the delivery loop can apply
 * cleaner gating: pending_review / needs_more_data are not pushed aggressively;
 * approved_candidate picks receive priority delivery with guardrails.
 *
 * Rules (first match wins):
 *   high confidence (≥75) or high score (≥75) → notification + high escalation + review_required → risk_review
 *   on watchlist or decent confidence (≥55) or decent score (≥55) → notification + medium + proposal_ready → proposal_bucket
 *   else → none (skip push – low-signal pick not worth notifying) + monitor_only
 */
function _derivePickOrchestration(pick, onWatchlist) {
  const confidence = Number(pick?.confidence ?? 0);
  const score = Number(pick?.discoveryScore ?? pick?.opportunityScore ?? pick?.hqsScore ?? 0);

  if (confidence >= 75 || score >= 75) {
    // Step 7 Block 3: high-signal review cases – derive decision status from data quality
    const hasStrongData = confidence >= 75 && score >= 70;
    const decisionStatus = hasStrongData ? "approved_candidate" : "pending_review";
    // Step 7 Block 4: derive controlled approval flow status from decision state
    const approvalFlowStatus = hasStrongData ? "approved_pending_action" : "awaiting_review";
    const postDecisionAction = hasStrongData ? "ready_for_manual_action" : "pending_human_review";
    // Step 7 Block 5: derive audit/safety signals
    const governanceStatus = "review_controlled";
    const traceReason = hasStrongData
      ? "Starke Datenbasis und konsistente Signale – manuelle Bestätigung empfohlen"
      : "Freigabepflichtig – manuelle Prüfung erforderlich";
    const safetyFlags = ["approval:required", "bucket:risk_review"];
    return {
      deliveryMode: "notification",
      escalationLevel: "high",
      followUpNeeded: true,
      actionReadiness: "review_required",
      reviewBucket: "risk_review",
      decisionStatus,
      approvalFlowStatus,
      postDecisionAction,
      governanceStatus,
      traceReason,
      safetyFlags,
      blockedByGuardrail: false,
      // Step 8 Block 2: exception classification for operating console
      exceptionType: hasStrongData ? "risk_review_pending" : "review_required",
      exceptionPriority: "high",
      // Step 8 Block 1: governance classification for high-signal picks
      governanceContext: {
        requiredRole: "operator",
        separationOfDutiesFlag: true,
        approvalActionAllowed: true,
        policyMutationAllowed: false,
        governanceBasis: "step8_block1",
      },
      // Step 8 Block 3: policy-plane context for high-signal picks
      policyPlane: {
        policyVersion: "v1",
        policyStatus: "pending_approval",
        policyMode: "live",
        requiresSecondApproval: hasStrongData,
        approvalState: hasStrongData ? "awaiting_second" : "none",
        secondApprovalReady: false,
        shadowModeEligible: !hasStrongData,
        shadowReason: null,
        policyScope: "per_opportunity",
        policyMutationAllowed: false,
        policyPlaneBasis: "step8_block3",
      },
      // Step 8 Block 4: evidence package for high-signal picks
      policyValidity:     "pending",
      policyFingerprint:  `v1:pending_approval:live:${decisionStatus}`,
      evidencePackage: {
        policyVersion:    "v1",
        policyFingerprint: `v1:pending_approval:live:${decisionStatus}`,
        policyValidity:   "pending",
        governanceStatus: "review_controlled",
        traceReason,
        tracePath:        null,
        reviewSummary:    { actionReadiness: "review_required", approvalQueueBucket: "risk_review", pendingApproval: true },
        decisionSummary:  { decisionStatus, decisionReason: null },
        approvalSummary:  { approvalFlowStatus, requiresSecondApproval: hasStrongData, approvalState: hasStrongData ? "awaiting_second" : "none" },
        actorContext:     { actorRole: "operator", governanceRole: "operator", tenantScope: "platform", separationOfDutiesFlag: true },
        policyApprovalHistory: [
          { event: "governance_status", state: "review_controlled", source: "discoveryNotify" },
          { event: "decision_recorded", state: decisionStatus, source: "discoveryNotify" },
          { event: "approval_flow", state: approvalFlowStatus, source: "discoveryNotify" },
          ...(hasStrongData ? [{ event: "four_eyes_required", state: "awaiting_second", source: "policyPlane" }] : []),
        ],
        operatorActionTrace: [
          { trace: "audit_reason",     value: traceReason },
          { trace: "action_readiness", value: "review_required" },
          ...(hasStrongData ? [{ trace: "second_approval", value: "awaiting" }] : []),
        ],
        evidenceBasis: "step8_block4",
      },
      // Step 8 Block 5: tenant/resource governance for high-signal picks
      tenantResourceGovernance: {
        tenantId:                 "tenant_default",
        tenantPolicyScope:        "per_opportunity",
        tenantMaxAutonomyLevel:   "restricted",
        tenantQuotaProfile:       "elevated",
        resourceGovernanceStatus: "controlled",
        rateLimitRisk:            "medium",
        noisyNeighborRisk:        "low",
        quotaUsage:               hasStrongData ? 0.75 : 0.4,
        backlogPressure:          hasStrongData ? "elevated" : "moderate",
        tenantLoadBand:           hasStrongData ? "high" : "medium",
        quotaWarning:             hasStrongData,
        resourceGuardrail:        "standby",
        tenantResourceBasis:      "step8_block5",
      },
      // Step 8 Block 6: operational resilience for high-signal picks.
      // Discovery picks bypass getTopOpportunities(), so computeOperationalResilienceContext()
      // cannot be called directly here (no full opp object available).  The values below are
      // structurally consistent approximations based on the same signal thresholds used by
      // the canonical function: hasStrongData correlates to elevated backlog and rate-limit
      // signals that would produce elevated_load in the live pipeline.
      operationalResilience: {
        degradationMode:       hasStrongData ? "elevated_load" : "normal",
        operationalHealth:     hasStrongData ? "degraded" : "healthy",
        fallbackTier:          hasStrongData ? "reduced_context" : "full_context",
        resilienceFlags:       hasStrongData ? ["backlog_elevated", "rate_limit_risk"] : [],
        recoveryState:         hasStrongData ? "recovering" : "stable",
        resumeReady:           !hasStrongData,
        systemPressureSummary: hasStrongData ? "Erhöhte Last – defensiver Betrieb empfohlen" : "Normalbetrieb – kein erhöhter Systemdruck",
        resilienceBasis:       "step8_block6",
      },
      // Step 9 Block 1: autonomy level for high-signal picks.
      // High-signal picks with strong data require human review (assisted).
      // Picks with strong data and elevated governance are capped at assisted.
      autonomyLevel: {
        effectiveLevel:     hasStrongData ? "assisted" : "assisted",
        levelRank:          1,
        levelLabel:         "Assistiert",
        levelCap:           "supervised",
        capReason:          "step9_block1_basis_only",
        escalationRequired: hasStrongData,
        levelBasis:         hasStrongData ? "Starke Signale – erhöhte menschliche Kontrolle" : "Standard-Fallback – assistierter Modus",
        autonomyBasis:      "step9_block1",
      },
      // Step 9 Block 1: drift detection for high-signal picks.
      driftDetection: {
        driftSignals:     hasStrongData ? [{ type: "resilience_drift", signal: "degradation_elevated_load", severity: "low", detail: "Degradation: elevated_load" }] : [],
        driftSignalCount: hasStrongData ? 1 : 0,
        driftLevel:       hasStrongData ? "low" : "none",
        metronomDeviation: hasStrongData,
        baselineState:    hasStrongData ? "drifting" : "stable",
        driftBasis:       "step9_block1",
      },
      // Step 9 Block 2: action chain state for high-signal picks.
      actionChainState: {
        actionChainState:  hasStrongData ? "preparing" : "observing",
        actionChainStage:  hasStrongData ? "proposal_consolidation" : "monitoring",
        actionChainLabel:  hasStrongData ? "Vorbereitend" : "Beobachtend",
        actionChainRank:   hasStrongData ? 2 : 1,
        nextChainStep:     hasStrongData ? "Vorschlag konsolidieren – Review einleiten" : "Signale beobachten",
        chainBlocked:      false,
        chainBlockReason:  null,
        escalationPath:    null,
        chainConflictRisk: false,
        chainSafetyMode:   hasStrongData,
        chainBasis:        "step9_block2",
      },
      // Step 9 Block 3: controlled auto-preparation for high-signal picks.
      // Strong-data picks prepare a review_packet (review required); weaker picks prepare a proposal_card.
      controlledAutoPreparation: {
        autoPreparationEligible:   true,
        preparationType:           hasStrongData ? "review_packet" : "proposal_card_ready",
        preparationReason:         hasStrongData
          ? "Starke Signale – Review-Paket wird vorbereitet"
          : "Strukturierter Vorschlag verfügbar – Vorschlags-Karte vorbereitet",
        preparationPriority:       hasStrongData ? "high" : "medium",
        preparationGuarded:        false,
        preparationWindow:         hasStrongData ? "immediate" : "short_term",
        manualConfirmationRequired: hasStrongData,
        preparationSummary:        hasStrongData
          ? "Review-Paket: Starke Signale – Review-Paket wird vorbereitet [Manuelle Bestätigung erforderlich]"
          : "Vorschlags-Karte bereit: Strukturierter Vorschlag verfügbar",
        preparationBasis:          "step9_block3",
      },
      // Step 9 Block 4: partial auto-execution for high-signal picks.
      // Strong-data (manualConfirmationRequired): queue card only – no silent execution.
      // Weaker high-signal: update delivery mode internally.
      partialAutoExecution: {
        autoExecutionEligible: !hasStrongData,
        autoExecutionType:     hasStrongData ? "queue_manual_action_card" : "update_delivery_mode",
        autoExecutionReason:   hasStrongData
          ? "Starke Signale – Aktionskarte eingereiht, Nutzerbestätigung erforderlich"
          : "Hohes Signal – Zustellmodus intern angepasst",
        autoExecutionGuarded:  hasStrongData,
        autoExecutionSafety:   hasStrongData ? "guarded" : "safe",
        executionIntent:       hasStrongData ? "queue_card" : "update_mode",
        executionScope:        "internal_only",
        executionSummary:      hasStrongData
          ? "Aktionskarte eingereiht: Starke Signale – Nutzerbestätigung ausstehend [Ausführung gesichert – kein Marktschritt]"
          : "Zustellmodus aktualisiert: Hohes Signal – Intern angepasst [Intern ausführbar]",
        executionBasis:        "step9_block4",
      },
      // Step 9 Block 5: recovery/stop/override/promotion-safety for high-signal picks.
      // High-signal tier: manualConfirmationRequired picks are stop-eligible and promotion-blocked;
      // weaker high-signal picks allow resume and override.
      recoverySafetyLayer: {
        stopEligible:                 hasStrongData,
        overrideAllowed:              !hasStrongData,
        killSwitchScope:              hasStrongData ? "case" : "none",
        recoveryAction:               hasStrongData ? "Starke Signale – manuelle Bestätigung ausstehend, kein automatischer Fortschritt" : null,
        rollbackSuggested:            false,
        promotionBlocked:             hasStrongData,
        degradeRequired:              false,
        resumeAllowed:                !hasStrongData,
        operatorInterventionRequired: hasStrongData,
        safetyControlSummary:         hasStrongData
          ? "🛑 Stop möglich · 🚫 Promotion blockiert · 👷 Operator-Eingriff nötig · ⚡ Kill-Switch-Scope: case"
          : "✅ Resume erlaubt · 🔓 Override strukturell erlaubt (Governance-Aussage)",
        safetyBasis:                  "step9_block5",
      },
      // Step 10 Block 1: companion output for high-signal picks – plain-language translation.
      companionOutput: {
        companionStatus:     hasStrongData ? "braucht Prüfung" : "Vorschlag liegt bereit",
        companionTone:       hasStrongData ? "watchful" : "active",
        userClarityLevel:    "standard",
        isItGoodOrBad:       "eher gut – starkes Signal",
        doINeedToAct:        hasStrongData ? "Ja – eine Prüfung ist sinnvoll" : "Nein, aber ein Vorschlag liegt bereit",
        plainLanguageReason: hasStrongData ? "Signal auf hohem Niveau" : "Vorschlag verfügbar",
        companionNextStep:   hasStrongData ? "Signal prüfen – Freigabe oder Ablehnung" : "Vorschlag ansehen – keine Pflicht zur Freigabe",
        companionBasis:      "step10_block1",
      },
      // Step 10 Block 2: attention/delivery output for high-signal picks.
      // Strong-data picks with operator intervention → interrupt_now.
      // Other high-signal picks → include_in_briefing.
      attentionDeliveryOutput: {
        deliveryMode:         hasStrongData ? "interrupt_now" : "include_in_briefing",
        attentionStatus:      hasStrongData ? "Sofortiger Handlungsbedarf" : "Für das Tages-Briefing",
        deliveryUrgency:      hasStrongData ? "critical" : "high",
        shouldInterrupt:      hasStrongData,
        bundleCandidate:      false,
        quietModeRecommended: false,
        deliveryReason:       hasStrongData
          ? "Kritische Signalstärke und Operator-Eingriff nötig – sofortiger Interrupt empfohlen"
          : "Hohes Signal – gehört ins nächste Briefing, kein sofortiger Interrupt",
        attentionSummary:     hasStrongData
          ? "Sofortiger Handlungsbedarf · critical · Kritische Signalstärke und Operator-Eingriff nötig"
          : "Für das Tages-Briefing · high · Hohes Signal – Briefing-Priorität",
        attentionBasis:       "step10_block2",
      },
      // Step 10 Block 3: autonomy-preview output for high-signal picks.
      // Strong-data picks require operator confirmation → awaiting_confirmation.
      // Other high-signal picks are guarded (promotionBlocked via hasStrongData logic).
      autonomyPreview: {
        autonomyState:         hasStrongData ? "awaiting_confirmation" : "guarded",
        autonomyPreview:       hasStrongData ? "Bestätigung nötig" : "Gebremst",
        autonomyConfidence:    hasStrongData ? 40 : 55,
        confidenceBand:        hasStrongData ? "medium" : "medium",
        trustReason:           hasStrongData
          ? "Operator-Eingriff ausstehend – kein automatischer Fortschritt"
          : "Vorsichtsmodus aktiv – eingeschränkte Ausführung",
        stopAvailable:         hasStrongData,
        needsUserConfirmation: hasStrongData,
        previewSummary:        hasStrongData
          ? `Bestätigung nötig · Vertrauen: medium · Operator-Eingriff ausstehend`
          : `Gebremst · Vertrauen: medium · Vorsichtsmodus aktiv`,
        autonomyBasis:         "step10_block3",
      },
      // Step 10 Block 4: adaptive UX / feedback output for high-signal picks.
      // Strong-data picks need confirmation → coach style with high density.
      // Other high-signal picks are guarded → coach style with calm tone.
      adaptiveUXOutput: {
        styleProfile:        "coach",
        communicationDensity: hasStrongData ? "high" : "medium",
        feedbackSignal:      null,
        feedbackSummary:     { acted: 0, dismissed: 0, positive: 0, negative: 0, followUpOverdue: 0, followUpPending: 0 },
        adaptiveTone:        hasStrongData ? "alert" : "calm",
        outputFit:           hasStrongData ? "high_signal_alert" : "guarded_calm",
        adaptationReason:    hasStrongData
          ? "Bestätigung ausstehend – strukturierte Entscheidungshilfe empfohlen"
          : "Gebremster Modus – einfache Sprache, keine Alarmierung",
        userPreferenceHint:  "eher ruhige, erklärende Einordnung bevorzugt",
        adaptiveUXSummary:   hasStrongData
          ? "Hochsignal · coach · high · alert · high_signal_alert"
          : "Hochsignal · coach · medium · calm · guarded_calm",
        adaptiveUXBasis:     "step10_block4",
      },
    };
  }
  if (onWatchlist || confidence >= 55 || score >= 55) {
    return {
      deliveryMode: "notification",
      escalationLevel: "medium",
      followUpNeeded: false,
      actionReadiness: "proposal_ready",
      reviewBucket: "proposal_bucket",
      decisionStatus: null,
      approvalFlowStatus: "proposal_available",
      postDecisionAction: "user_may_review_proposal",
      governanceStatus: "proposal_available",
      traceReason: "Strukturierter Vorschlag verfügbar – Nutzer entscheidet eigenständig",
      safetyFlags: [],
      blockedByGuardrail: false,
      // Step 8 Block 2: exception classification for operating console
      exceptionType: "normal",
      exceptionPriority: "low",
      // Step 8 Block 1: governance classification for proposal-level picks
      governanceContext: {
        requiredRole: "viewer",
        separationOfDutiesFlag: false,
        approvalActionAllowed: false,
        policyMutationAllowed: false,
        governanceBasis: "step8_block1",
      },
      // Step 8 Block 3: policy-plane context for proposal-level picks
      policyPlane: {
        policyVersion: "v1",
        policyStatus: "active",
        policyMode: "live",
        requiresSecondApproval: false,
        approvalState: "none",
        secondApprovalReady: false,
        shadowModeEligible: true,
        shadowReason: null,
        policyScope: "per_opportunity",
        policyMutationAllowed: false,
        policyPlaneBasis: "step8_block3",
      },
      // Step 8 Block 4: evidence package for proposal-level picks
      policyValidity:     "valid",
      policyFingerprint:  "v1:active:live:none",
      evidencePackage: {
        policyVersion:    "v1",
        policyFingerprint: "v1:active:live:none",
        policyValidity:   "valid",
        governanceStatus: "proposal_available",
        traceReason:      "Strukturierter Vorschlag verfügbar – Nutzer entscheidet eigenständig",
        tracePath:        null,
        reviewSummary:    { actionReadiness: "proposal_ready", approvalQueueBucket: "proposal_bucket", pendingApproval: false },
        decisionSummary:  { decisionStatus: null, decisionReason: null },
        approvalSummary:  { approvalFlowStatus: "proposal_available", requiresSecondApproval: false, approvalState: "none" },
        actorContext:     { actorRole: "viewer", governanceRole: "viewer", tenantScope: "platform", separationOfDutiesFlag: false },
        policyApprovalHistory: [
          { event: "governance_status", state: "proposal_available", source: "discoveryNotify" },
          { event: "approval_flow", state: "proposal_available", source: "discoveryNotify" },
        ],
        operatorActionTrace: [
          { trace: "audit_reason",     value: "Strukturierter Vorschlag verfügbar – Nutzer entscheidet eigenständig" },
          { trace: "action_readiness", value: "proposal_ready" },
        ],
        evidenceBasis: "step8_block4",
      },
      // Step 8 Block 5: tenant/resource governance for proposal-level picks
      tenantResourceGovernance: {
        tenantId:                 "tenant_default",
        tenantPolicyScope:        "per_opportunity",
        tenantMaxAutonomyLevel:   "standard",
        tenantQuotaProfile:       "standard",
        resourceGovernanceStatus: "monitored",
        rateLimitRisk:            "low",
        noisyNeighborRisk:        "low",
        quotaUsage:               0.4,
        backlogPressure:          "none",
        tenantLoadBand:           "medium",
        quotaWarning:             false,
        resourceGuardrail:        "inactive",
        tenantResourceBasis:      "step8_block5",
      },
      // Step 8 Block 6: operational resilience for proposal-level picks
      operationalResilience: {
        degradationMode:       "normal",
        operationalHealth:     "healthy",
        fallbackTier:          "full_context",
        resilienceFlags:       [],
        recoveryState:         "stable",
        resumeReady:           true,
        systemPressureSummary: "Normalbetrieb – kein erhöhter Systemdruck",
        resilienceBasis:       "step8_block6",
      },
      // Step 9 Block 1: autonomy level for proposal-level picks – standard assisted mode
      autonomyLevel: {
        effectiveLevel:     "assisted",
        levelRank:          1,
        levelLabel:         "Assistiert",
        levelCap:           "supervised",
        capReason:          "step9_block1_basis_only",
        escalationRequired: false,
        levelBasis:         "Standard-Fallback – assistierter Modus",
        autonomyBasis:      "step9_block1",
      },
      // Step 9 Block 1: drift detection for proposal-level picks – no drift
      driftDetection: {
        driftSignals:      [],
        driftSignalCount:  0,
        driftLevel:        "none",
        metronomDeviation: false,
        baselineState:     "stable",
        driftBasis:        "step9_block1",
      },
      // Step 9 Block 2: action chain state for proposal-level picks – observing
      actionChainState: {
        actionChainState:  "observing",
        actionChainStage:  "monitoring",
        actionChainLabel:  "Beobachtend",
        actionChainRank:   1,
        nextChainStep:     "Signale beobachten – keine Aktion geplant",
        chainBlocked:      false,
        chainBlockReason:  null,
        escalationPath:    null,
        chainConflictRisk: false,
        chainSafetyMode:   false,
        chainBasis:        "step9_block2",
      },
      // Step 9 Block 3: controlled auto-preparation for proposal-level picks – proposal card ready.
      controlledAutoPreparation: {
        autoPreparationEligible:    true,
        preparationType:            "proposal_card_ready",
        preparationReason:          "Strukturierter Vorschlag verfügbar – Vorschlags-Karte vorbereitet",
        preparationPriority:        "medium",
        preparationGuarded:         false,
        preparationWindow:          "short_term",
        manualConfirmationRequired: false,
        preparationSummary:         "Vorschlags-Karte bereit: Strukturierter Vorschlag verfügbar",
        preparationBasis:           "step9_block3",
      },
      // Step 9 Block 4: partial auto-execution for proposal-level picks – update delivery mode.
      partialAutoExecution: {
        autoExecutionEligible: true,
        autoExecutionType:     "update_delivery_mode",
        autoExecutionReason:   "Vorschlags-Kandidat – Zustellmodus intern angepasst",
        autoExecutionGuarded:  false,
        autoExecutionSafety:   "safe",
        executionIntent:       "update_mode",
        executionScope:        "internal_only",
        executionSummary:      "Zustellmodus aktualisiert: Vorschlags-Kandidat – Intern angepasst [Intern ausführbar]",
        executionBasis:        "step9_block4",
      },
      // Step 9 Block 5: recovery/stop/override/promotion-safety for proposal-level picks.
      // Proposal tier: stable conditions – resume and override allowed, no stop/degrade.
      recoverySafetyLayer: {
        stopEligible:                 false,
        overrideAllowed:              true,
        killSwitchScope:              "none",
        recoveryAction:               null,
        rollbackSuggested:            false,
        promotionBlocked:             false,
        degradeRequired:              false,
        resumeAllowed:                true,
        operatorInterventionRequired: false,
        safetyControlSummary:         "✅ Resume erlaubt · 🔓 Override strukturell erlaubt (Governance-Aussage)",
        safetyBasis:                  "step9_block5",
      },
      // Step 10 Block 1: companion output for proposal-level picks – plain-language translation.
      companionOutput: {
        companionStatus:     "Vorschlag liegt bereit",
        companionTone:       "active",
        userClarityLevel:    "standard",
        isItGoodOrBad:       "neutral – solides Signal",
        doINeedToAct:        "Nein, aber ein Vorschlag liegt bereit",
        plainLanguageReason: "Signal im mittleren Bereich – Vorschlag verfügbar",
        companionNextStep:   "Vorschlag ansehen – keine Pflicht zur Freigabe",
        companionBasis:      "step10_block1",
      },
      // Step 10 Block 2: attention/delivery output for proposal-level picks.
      // Proposal picks → bundle_for_digest (no interrupt, no solo alarm).
      attentionDeliveryOutput: {
        deliveryMode:         "bundle_for_digest",
        attentionStatus:      "Bündeln",
        deliveryUrgency:      "low",
        shouldInterrupt:      false,
        bundleCandidate:      true,
        quietModeRecommended: false,
        deliveryReason:       "Mittleres Signal – kann mit anderen Vorschlägen gebündelt werden",
        attentionSummary:     "Bündeln · low · Mittleres Signal – Bündelung empfohlen",
        attentionBasis:       "step10_block2",
      },
      // Step 10 Block 3: autonomy-preview output for proposal-level picks.
      // Proposal tier: prepared state – no blocking, no confirmation required.
      autonomyPreview: {
        autonomyState:         "prepared",
        autonomyPreview:       "Vorbereitet",
        autonomyConfidence:    65,
        confidenceBand:        "medium",
        trustReason:           "Vorbereitung liegt bereit – Nutzer kann prüfen und eigenständig entscheiden",
        stopAvailable:         false,
        needsUserConfirmation: false,
        previewSummary:        "Vorbereitet · Vertrauen: medium · Vorbereitung liegt bereit",
        autonomyBasis:         "step10_block3",
      },
      // Step 10 Block 4: adaptive UX / feedback output for proposal-level picks.
      // Proposal tier: analyst style, medium density, neutral tone – balanced output.
      adaptiveUXOutput: {
        styleProfile:        "analyst",
        communicationDensity: "medium",
        feedbackSignal:      null,
        feedbackSummary:     { acted: 0, dismissed: 0, positive: 0, negative: 0, followUpOverdue: 0, followUpPending: 0 },
        adaptiveTone:        "neutral",
        outputFit:           "standard_analysis",
        adaptationReason:    "Standardmäßige Ausgabe – keine besonderen Anpassungshinweise",
        userPreferenceHint:  "eher sachliche Analyse mit etwas Begründung bevorzugt",
        adaptiveUXSummary:   "Vorschlag · analyst · medium · neutral · standard_analysis",
        adaptiveUXBasis:     "step10_block4",
      },
    };
  }
  return {
    deliveryMode: "none",
    escalationLevel: "none",
    followUpNeeded: false,
    actionReadiness: "monitor_only",
    reviewBucket: null,
    decisionStatus: null,
    approvalFlowStatus: null,
    postDecisionAction: null,
    governanceStatus: "observation",
    traceReason: "Signal zu schwach für aktive Zustellung – nur Beobachtung",
    safetyFlags: [],
    blockedByGuardrail: false,
    // Step 8 Block 2: exception classification for operating console
    exceptionType: "normal",
    exceptionPriority: "low",
    // Step 8 Block 1: governance classification for monitor-only picks
    governanceContext: {
      requiredRole: "viewer",
      separationOfDutiesFlag: false,
      approvalActionAllowed: false,
      policyMutationAllowed: false,
      governanceBasis: "step8_block1",
    },
    // Step 8 Block 3: policy-plane context for monitor-only picks
    policyPlane: {
      policyVersion: "v1",
      policyStatus: "active",
      policyMode: "live",
      requiresSecondApproval: false,
      approvalState: "none",
      secondApprovalReady: false,
      shadowModeEligible: false,
      shadowReason: null,
      policyScope: "per_opportunity",
      policyMutationAllowed: false,
      policyPlaneBasis: "step8_block3",
    },
    // Step 8 Block 4: evidence package for monitor-only picks
    policyValidity:     "valid",
    policyFingerprint:  "v1:active:live:none",
    evidencePackage: {
      policyVersion:    "v1",
      policyFingerprint: "v1:active:live:none",
      policyValidity:   "valid",
      governanceStatus: "observation",
      traceReason:      "Signal zu schwach für aktive Zustellung – nur Beobachtung",
      tracePath:        null,
      reviewSummary:    { actionReadiness: "monitor_only", approvalQueueBucket: null, pendingApproval: false },
      decisionSummary:  { decisionStatus: null, decisionReason: null },
      approvalSummary:  { approvalFlowStatus: null, requiresSecondApproval: false, approvalState: "none" },
      actorContext:     { actorRole: "viewer", governanceRole: "viewer", tenantScope: "platform", separationOfDutiesFlag: false },
      policyApprovalHistory: [
        { event: "governance_status", state: "observation", source: "discoveryNotify" },
      ],
      operatorActionTrace: [
        { trace: "audit_reason",     value: "Signal zu schwach für aktive Zustellung – nur Beobachtung" },
        { trace: "action_readiness", value: "monitor_only" },
      ],
      evidenceBasis: "step8_block4",
    },
    // Step 8 Block 5: tenant/resource governance for monitor-only picks
    tenantResourceGovernance: {
      tenantId:                 "tenant_default",
      tenantPolicyScope:        "per_opportunity",
      tenantMaxAutonomyLevel:   "permissive",
      tenantQuotaProfile:       "relaxed",
      resourceGovernanceStatus: "open",
      rateLimitRisk:            "low",
      noisyNeighborRisk:        "low",
      quotaUsage:               0.1,
      backlogPressure:          "none",
      tenantLoadBand:           "low",
      quotaWarning:             false,
      resourceGuardrail:        "inactive",
      tenantResourceBasis:      "step8_block5",
    },
    // Step 8 Block 6: operational resilience for monitor-only picks
    operationalResilience: {
      degradationMode:       "normal",
      operationalHealth:     "healthy",
      fallbackTier:          "full_context",
      resilienceFlags:       [],
      recoveryState:         "stable",
      resumeReady:           true,
      systemPressureSummary: "Normalbetrieb – kein erhöhter Systemdruck",
      resilienceBasis:       "step8_block6",
    },
    // Step 9 Block 1: autonomy level for monitor-only picks – standard assisted mode
    autonomyLevel: {
      effectiveLevel:     "assisted",
      levelRank:          1,
      levelLabel:         "Assistiert",
      levelCap:           "supervised",
      capReason:          "step9_block1_basis_only",
      escalationRequired: false,
      levelBasis:         "Standard-Fallback – assistierter Modus",
      autonomyBasis:      "step9_block1",
    },
    // Step 9 Block 1: drift detection for monitor-only picks – no drift
    driftDetection: {
      driftSignals:      [],
      driftSignalCount:  0,
      driftLevel:        "none",
      metronomDeviation: false,
      baselineState:     "stable",
      driftBasis:        "step9_block1",
    },
    // Step 9 Block 2: action chain state for monitor-only picks – observing
    actionChainState: {
      actionChainState:  "observing",
      actionChainStage:  "monitoring",
      actionChainLabel:  "Beobachtend",
      actionChainRank:   1,
      nextChainStep:     "Signale beobachten – keine Aktion geplant",
      chainBlocked:      false,
      chainBlockReason:  null,
      escalationPath:    null,
      chainConflictRisk: false,
      chainSafetyMode:   false,
      chainBasis:        "step9_block2",
    },
    // Step 9 Block 3: controlled auto-preparation for monitor-only picks – no preparation eligible.
    controlledAutoPreparation: {
      autoPreparationEligible:    false,
      preparationType:            "no_auto_prep",
      preparationReason:          "Signal zu schwach – keine kontrollierte Vorbereitung möglich",
      preparationPriority:        "none",
      preparationGuarded:         false,
      preparationWindow:          null,
      manualConfirmationRequired: false,
      preparationSummary:         "Keine Vorbereitung: Signal zu schwach – keine kontrollierte Vorbereitung möglich",
      preparationBasis:           "step9_block3",
    },
    // Step 9 Block 4: partial auto-execution for monitor-only picks – suppress non-critical delivery.
    partialAutoExecution: {
      autoExecutionEligible: true,
      autoExecutionType:     "suppress_noncritical_delivery",
      autoExecutionReason:   "Monitor-only – nicht-kritische Zustellung intern unterdrückt",
      autoExecutionGuarded:  false,
      autoExecutionSafety:   "safe",
      executionIntent:       "suppress_delivery",
      executionScope:        "internal_only",
      executionSummary:      "Nicht-kritische Zustellung unterdrückt: Monitor-only – Intern unterdrückt [Intern ausführbar]",
      executionBasis:        "step9_block4",
    },
    // Step 9 Block 5: recovery/stop/override/promotion-safety for monitor-only picks.
    // Monitor tier: minimal conditions – resume allowed, no stop/degrade, override allowed.
    recoverySafetyLayer: {
      stopEligible:                 false,
      overrideAllowed:              true,
      killSwitchScope:              "none",
      recoveryAction:               null,
      rollbackSuggested:            false,
      promotionBlocked:             false,
      degradeRequired:              false,
      resumeAllowed:                true,
      operatorInterventionRequired: false,
      safetyControlSummary:         "✅ Keine aktiven Sicherheits-/Stoppbedingungen",
      safetyBasis:                  "step9_block5",
    },
    // Step 10 Block 1: companion output for monitor-only picks – plain-language translation.
    companionOutput: {
      companionStatus:     "unter Beobachtung",
      companionTone:       "calm",
      userClarityLevel:    "standard",
      isItGoodOrBad:       "gemischt – mit Vorsicht beobachten",
      doINeedToAct:        "Nein – kein Handlungsbedarf",
      plainLanguageReason: "Signal aktuell schwach – nur Beobachtung",
      companionNextStep:   "Beobachten – kein Schritt nötig",
      companionBasis:      "step10_block1",
    },
    // Step 10 Block 2: attention/delivery output for monitor-only picks.
    // Monitor tier → monitor_silently (no interrupt, no bundle, no alarm).
    attentionDeliveryOutput: {
      deliveryMode:         "monitor_silently",
      attentionStatus:      "Still beobachten",
      deliveryUrgency:      "minimal",
      shouldInterrupt:      false,
      bundleCandidate:      false,
      quietModeRecommended: true,
      deliveryReason:       "Kein akuter Handlungsbedarf – stilles Monitoring",
      attentionSummary:     "Still beobachten · minimal · Kein akuter Handlungsbedarf",
      attentionBasis:       "step10_block2",
    },
    // Step 10 Block 3: autonomy-preview output for monitor-only picks.
    // Monitor tier: suggestion state – no blocking, no confirmation, signal too weak for action.
    autonomyPreview: {
      autonomyState:         "suggestion",
      autonomyPreview:       "Vorschlag",
      autonomyConfidence:    35,
      confidenceBand:        "low",
      trustReason:           "Analytischer Vorschlag – keine automatische Ausführung, Nutzer entscheidet",
      stopAvailable:         false,
      needsUserConfirmation: false,
      previewSummary:        "Vorschlag · Vertrauen: low · Signal zu schwach – nur Beobachtung",
      autonomyBasis:         "step10_block3",
    },
    // Step 10 Block 4: adaptive UX / feedback output for monitor-only picks.
    // Monitor tier: coach style, low density, calm tone – quiet, unobtrusive output.
    adaptiveUXOutput: {
      styleProfile:        "coach",
      communicationDensity: "low",
      feedbackSignal:      null,
      feedbackSummary:     { acted: 0, dismissed: 0, positive: 0, negative: 0, followUpOverdue: 0, followUpPending: 0 },
      adaptiveTone:        "calm",
      outputFit:           "quiet_monitor",
      adaptationReason:    "Kein aktiver Hinweis nötig – kurze Einordnung ausreichend",
      userPreferenceHint:  "eher ruhige, erklärende Einordnung bevorzugt",
      adaptiveUXSummary:   "Monitor · coach · low · calm · quiet_monitor",
      adaptiveUXBasis:     "step10_block4",
    },
  };
}

// Step 5 Follow-up/Reminder: max open reminder-eligible notifications before gating new delivery
const MAX_OPEN_REMINDERS_THRESHOLD = 3;

async function runDiscoveryNotify() {
  return runJob("discoveryNotify", async () => {
    // Lock: verhindert Doppel-Run bei Deploy/Cron
    const won = await acquireLock("discovery_notify_job", 20 * 60);
    if (!won) {
      logger.warn("[job:discoveryNotify] skipped – lock held");
      return { processedCount: 0 };
    }

    try {
    // 1) Hidden Winner Pick berechnen (einmal pro Job)
    const picks = await discoverStocks(1);
    const pick = Array.isArray(picks) && picks[0] ? picks[0] : null;

    if (!pick) {
      logger.warn("No discovery pick found");
      return { processedCount: 0 };
    }

    logger.info("Discovery pick selected", { symbol: pick.symbol, confidence: pick.confidence });

    // briefing_users and briefing_watchlist are decommissioned.
    // Per-user discovery notification requires a user source – return early.
    logger.warn("[discoveryNotify] No user source available (briefing_users decommissioned)");

    await savePipelineStage("discovery_notify", {
      inputCount: 0,
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
    });

    return {
      processedCount: 0,
      skippedCount: 0,
      gatedOutCount: 0,
      users: 0,
      pick: pick.symbol,
    };
    } finally {
      await releaseLock("discovery_notify_job").catch(() => {});
    }
  });
}

if (require.main === module) {
  runDiscoveryNotify()
    .then(() => process.exit(0))
    .catch((e) => {
      logger.error("Discovery notify fatal", { message: e.message });
      process.exit(1);
    });
}

module.exports = { runDiscoveryNotify };
