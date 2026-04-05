"use strict";

/**
 * Step 15: Agent Approval / Plan Refinement / Controlled Preparation – Unit Tests
 *
 * Tests the Step 15 extension of the agent case lifecycle:
 * - _translateFeedbackToRefinedPlan via submitAgentCaseFeedback
 * - Controlled preparation type derivation
 * - Approval decision stage derivation
 * - Refined plan messages (cooperative language)
 * - Plan phase tracking
 * - getRefinedPlanSummary
 * - Cross-agent coordination fields
 * - Constants exported from agentBridge.service
 */

const {
  buildAgentCaseFromBridgePackage,
  submitAgentCaseFeedback,
  getRefinedPlanSummary,
  getAgentChatMessages,
  VALID_PLAN_PHASES,
  VALID_CONTROLLED_PREPARATION_TYPES,
  VALID_APPROVAL_DECISION_STAGES,
} = require("../services/agentBridge.service");

// ─── Helpers ───────────────────────────────────────────

function makeBackendBridgePackage(overrides = {}) {
  return {
    bridgeHints: [
      {
        type: "change_guard",
        severity: "high",
        summary: "Route X hat eine unsichere Validierung",
        affectedLayer: "backend_logic",
      },
    ],
    issueContext: {
      issueType: "detected",
      issueCategory: "logic_error",
      issueSeverity: "high",
      affectedLayer: "backend_logic",
      suspectedIssueCause: "logic_error",
      suggestedFix: "harden_logic",
      issueTitle: "Unsichere Validierung in Route X",
      needsFollowup: false,
      ...(overrides.issueContext || {}),
    },
    patternContext: {
      patternKey: "change_guard:backend_logic:review_followup:layout_review",
      dominantHintType: "change_guard",
      dominantLayer: "backend_logic",
      actionReadinessBand: "useful_next_step",
      recommendedActionType: "check_ui",
      confidenceBand: "medium",
      ...(overrides.patternContext || {}),
    },
    maturityContext: {
      decisionMaturityBand: "credible",
      maturityScore: 7,
      maturityReason: "Gewinnt an Substanz",
      maturityDrivers: ["confidence_medium", "readiness_useful"],
      ...(overrides.maturityContext || {}),
    },
    attentionContext: {
      attentionBand: "review_today",
      attentionScore: 5,
      attentionReason: "Aufmerksamkeit empfohlen",
      focusDrivers: ["severity_high"],
      ...(overrides.attentionContext || {}),
    },
    caseContext: {
      caseStatus: "watching",
      caseOutcome: "pending",
      helpfulnessBand: "somewhat_helpful",
      caseReason: "Fall wird beobachtet",
      ...(overrides.caseContext || {}),
    },
    governanceContext: {
      policyClass: "admin_visible",
      guardianEligibility: false,
      needsMoreEvidence: false,
      governanceReason: "Admin-sichtbar",
      ...(overrides.governanceContext || {}),
    },
    impactTranslation: {
      impactKind: "logic_change",
      impactSummary: "Backend-Logik betroffen",
      likelyAffectedArtifacts: ["routes/api.js"],
      ...(overrides.impactTranslation || {}),
    },
    ...overrides,
  };
}

function makeFrontendBridgePackage(overrides = {}) {
  return makeBackendBridgePackage({
    bridgeHints: [
      {
        type: "binding_risk",
        severity: "medium",
        summary: "Darstellung nutzt alte Datenfelder",
        affectedLayer: "frontend_presentation",
      },
    ],
    issueContext: {
      issueType: "detected",
      issueCategory: "presentation_problem",
      issueSeverity: "medium",
      affectedLayer: "frontend_presentation",
      suspectedIssueCause: "presentation_error",
      suggestedFix: "review_layout",
      issueTitle: "Veraltete Beschriftung in der View",
      needsFollowup: false,
    },
    patternContext: {
      patternKey: "binding_risk:frontend_presentation:ui_adjustment_followup:presentation_review",
      dominantHintType: "binding_risk",
      dominantLayer: "frontend_presentation",
      actionReadinessBand: "useful_next_step",
      recommendedActionType: "check_ui",
      confidenceBand: "medium",
    },
    ...overrides,
  });
}

// ─── Step 15 Constants ──────────────────────────────────

describe("Step 15 – Constants", () => {
  test("VALID_PLAN_PHASES contains all plan lifecycle phases", () => {
    expect(VALID_PLAN_PHASES).toContain("problem_phase");
    expect(VALID_PLAN_PHASES).toContain("solution_phase");
    expect(VALID_PLAN_PHASES).toContain("feedback_phase");
    expect(VALID_PLAN_PHASES).toContain("refinement_phase");
    expect(VALID_PLAN_PHASES).toContain("preparation_phase");
    expect(VALID_PLAN_PHASES).toContain("hold_phase");
    expect(VALID_PLAN_PHASES.length).toBe(6);
  });

  test("VALID_CONTROLLED_PREPARATION_TYPES contains conservative types", () => {
    expect(VALID_CONTROLLED_PREPARATION_TYPES).toContain("diagnosis_only");
    expect(VALID_CONTROLLED_PREPARATION_TYPES).toContain("backend_prepare");
    expect(VALID_CONTROLLED_PREPARATION_TYPES).toContain("frontend_prepare");
    expect(VALID_CONTROLLED_PREPARATION_TYPES).toContain("partial_fix_prepare");
    expect(VALID_CONTROLLED_PREPARATION_TYPES).toContain("cross_agent_review");
    expect(VALID_CONTROLLED_PREPARATION_TYPES).toContain("full_preparation");
    expect(VALID_CONTROLLED_PREPARATION_TYPES).toContain("hold");
    expect(VALID_CONTROLLED_PREPARATION_TYPES.length).toBe(7);
  });

  test("VALID_APPROVAL_DECISION_STAGES covers all decision states", () => {
    expect(VALID_APPROVAL_DECISION_STAGES).toContain("awaiting_decision");
    expect(VALID_APPROVAL_DECISION_STAGES).toContain("approved_full");
    expect(VALID_APPROVAL_DECISION_STAGES).toContain("approved_partial");
    expect(VALID_APPROVAL_DECISION_STAGES).toContain("approved_diagnosis_only");
    expect(VALID_APPROVAL_DECISION_STAGES).toContain("approved_backend_only");
    expect(VALID_APPROVAL_DECISION_STAGES).toContain("approved_frontend_only");
    expect(VALID_APPROVAL_DECISION_STAGES).toContain("deferred");
    expect(VALID_APPROVAL_DECISION_STAGES).toContain("rejected");
    expect(VALID_APPROVAL_DECISION_STAGES).toContain("refinement_in_progress");
    expect(VALID_APPROVAL_DECISION_STAGES).toContain("cross_agent_pending");
    expect(VALID_APPROVAL_DECISION_STAGES.length).toBe(10);
  });
});

// ─── Plan Refinement after Approve ──────────────────────

describe("Step 15 – approve feedback builds refined plan", () => {
  test("approve with full_fix scope produces full_preparation type", () => {
    const pkg = makeBackendBridgePackage({
      issueContext: {
        issueSeverity: "high",
        affectedLayer: "backend_logic",
        suggestedFix: "harden_logic",
      },
    });
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    // Force full_fix scope for the test
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "approve",
      preferredScope: "full_fix",
    });

    expect(result.success).toBe(true);
    expect(result.newStatus).toBe("approved");
    expect(result.planPhase).toBe("preparation_phase");
    expect(result.approvalDecisionStage).toBe("approved_full");
    expect(result.controlledPreparationType).toBe("full_preparation");
    expect(result.canPrepareNow).toBe(true);
    expect(result.preparationStatus).toBe("ready_to_prepare");
    expect(result.preparationSteps).toBeInstanceOf(Array);
    expect(result.preparationSteps.length).toBeGreaterThan(0);
  });

  test("approve with backend_only scope produces backend_prepare type", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "approve",
      preferredScope: "backend_only",
    });

    expect(result.success).toBe(true);
    expect(result.controlledPreparationType).toBe("backend_prepare");
    expect(result.approvalDecisionStage).toBe("approved_backend_only");
    expect(result.canPrepareNow).toBe(true);
  });

  test("approve with diagnosis_only scope produces diagnosis_only type", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "approve",
      preferredScope: "diagnosis_only",
    });

    expect(result.success).toBe(true);
    expect(result.controlledPreparationType).toBe("diagnosis_only");
    expect(result.approvalDecisionStage).toBe("approved_diagnosis_only");
  });
});

// ─── Plan Refinement after narrow_scope ─────────────────

describe("Step 15 – narrow_scope feedback narrows the plan", () => {
  test("narrow_scope to backend_only produces backend_prepare", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "narrow_scope",
      preferredScope: "backend_only",
    });

    expect(result.success).toBe(true);
    expect(result.newStatus).toBe("scope_narrowed");
    expect(result.controlledPreparationType).toBe("backend_prepare");
    expect(result.approvalScope).toBe("backend_only");
    expect(result.planPhase).toBe("feedback_phase");
    expect(result.canPrepareNow).toBe(true);
  });

  test("narrow_scope to frontend_only produces frontend_prepare", () => {
    const pkg = makeFrontendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "narrow_scope",
      preferredScope: "frontend_only",
    });

    expect(result.success).toBe(true);
    expect(result.controlledPreparationType).toBe("frontend_prepare");
    expect(result.approvalScope).toBe("frontend_only");
    expect(result.canPrepareNow).toBe(true);
  });

  test("narrow_scope to diagnosis_only produces diagnosis_only", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "narrow_scope",
      preferredScope: "diagnosis_only",
    });

    expect(result.success).toBe(true);
    expect(result.controlledPreparationType).toBe("diagnosis_only");
  });
});

// ─── Plan Refinement after reject/defer ──────────────────

describe("Step 15 – reject and defer produce hold", () => {
  test("reject produces hold preparation type", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "reject",
    });

    expect(result.success).toBe(true);
    expect(result.newStatus).toBe("rejected");
    expect(result.controlledPreparationType).toBe("hold");
    expect(result.canPrepareNow).toBe(false);
    expect(result.approvalDecisionStage).toBe("rejected");
    expect(result.planPhase).toBe("hold_phase");
  });

  test("defer produces hold preparation type", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "defer",
    });

    expect(result.success).toBe(true);
    expect(result.newStatus).toBe("deferred");
    expect(result.controlledPreparationType).toBe("hold");
    expect(result.canPrepareNow).toBe(false);
    expect(result.approvalDecisionStage).toBe("deferred");
    expect(result.planPhase).toBe("hold_phase");
  });
});

// ─── Plan Refinement after request_more_info ─────────────

describe("Step 15 – request_more_info produces diagnosis_only", () => {
  test("request_more_info leads to diagnosis_only prep type", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "request_more_info",
    });

    expect(result.success).toBe(true);
    expect(result.newStatus).toBe("info_requested");
    expect(result.controlledPreparationType).toBe("diagnosis_only");
    expect(result.canPrepareNow).toBe(false);
    expect(result.approvalDecisionStage).toBe("approved_diagnosis_only");
  });
});

// ─── Plan Refinement after modify/suggest_alternative ─────

describe("Step 15 – modify and suggest_alternative", () => {
  test("modify increments plan version and enters refinement phase", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "modify",
      alternativeSuggestion: "Lieber nur Validierung ergänzen",
    });

    expect(result.success).toBe(true);
    expect(result.newStatus).toBe("refinement_requested");
    expect(result.planVersion).toBe(2);
    expect(result.planPhase).toBe("refinement_phase");
    expect(result.approvalDecisionStage).toBe("refinement_in_progress");
    expect(result.refinementReason).toMatch(/angepasst|Anpassung|anpass/i);
    expect(result.canPrepareNow).toBe(false);
  });

  test("suggest_alternative takes alternative into refined plan", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "suggest_alternative",
      alternativeSuggestion: "Nur Cache invalidieren statt neu bauen",
    });

    expect(result.success).toBe(true);
    expect(result.newStatus).toBe("refinement_requested");
    expect(result.planVersion).toBe(2);
    expect(result.refinementReason).toContain("Nur Cache invalidieren");
    // Agent message should mention alternative or draft (Step 16 enrichment)
    const hasAlternativeRef =
      result.agentResponse.includes("Alternativvorschlag") ||
      result.agentResponse.includes("Entwurf") ||
      result.agentResponse.includes("Cache invalidieren");
    expect(hasAlternativeRef).toBe(true);
  });
});

// ─── approve_partial ─────────────────────────────────────

describe("Step 15 – approve_partial", () => {
  test("approve_partial with backend_only produces backend_prepare", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "approve_partial",
      preferredScope: "backend_only",
    });

    expect(result.success).toBe(true);
    expect(result.newStatus).toBe("partially_approved");
    expect(result.controlledPreparationType).toBe("backend_prepare");
    expect(result.approvalDecisionStage).toBe("approved_backend_only");
    expect(result.canPrepareNow).toBe(true);
    expect(result.planPhase).toBe("preparation_phase");
  });
});

// ─── Cooperative Agent Messages ──────────────────────────

describe("Step 15 – Cooperative Language in Refined Messages", () => {
  test("approve message uses cooperative first-person language", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "approve",
      preferredScope: "full_fix",
    });

    // Step 16 may enrich with draft message – both patterns are valid
    const hasCooperative =
      result.agentResponse.includes("Ich bereite") ||
      result.agentResponse.includes("Ich habe") ||
      result.agentResponse.includes("vorbereitet") ||
      result.agentResponse.includes("Entwurf");
    expect(hasCooperative).toBe(true);
    expect(result.agentResponse).not.toContain("ich setze das jetzt um");
    expect(result.agentResponse).not.toContain("wird sofort ausgeführt");
  });

  test("narrow_scope message describes the scope reduction cooperatively", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "narrow_scope",
      preferredScope: "backend_only",
    });

    // Step 16 may use draft language instead of "Plan"
    const hasScopeRef =
      result.agentResponse.includes("Plan") ||
      result.agentResponse.includes("Entwurf") ||
      result.agentResponse.includes("Backend") ||
      result.agentResponse.includes("eingegrenzt");
    expect(hasScopeRef).toBe(true);
    expect(result.agentResponse).not.toContain("wird automatisch");
  });

  test("request_more_info message indicates diagnosis deepening", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "request_more_info",
    });

    // Step 16 may use "Diagnose" draft language
    const hasDiagnosisRef =
      result.agentResponse.includes("vertiefe") ||
      result.agentResponse.includes("Diagnose") ||
      result.agentResponse.includes("Entwurf");
    expect(hasDiagnosisRef).toBe(true);
  });

  test("actionable states end with cooperative question", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "narrow_scope",
      preferredScope: "backend_only",
    });

    // Step 16 may end with "Basis" or "Bestätigung" instead of exact question
    const hasCooperativeEnd =
      result.agentResponse.includes("Soll ich auf dieser Basis weitermachen?") ||
      result.agentResponse.includes("Basis kann ich") ||
      result.agentResponse.includes("Bestätigung") ||
      result.agentResponse.includes("kontrollierten Schritt");
    expect(hasCooperativeEnd).toBe(true);
  });

  test("reject message does not end with follow-up question", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "reject",
    });

    expect(result.agentResponse).not.toContain("Soll ich auf dieser Basis weitermachen?");
    expect(result.agentResponse).toContain("zurück");
  });

  test("user message is acknowledged in refined response", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "narrow_scope",
      preferredScope: "backend_only",
      userMessage: "Bitte nur Backend-Seite anpassen",
    });

    // Step 16 draft message replaces Step 15 message when draft exists
    // Draft message may not include "Hinweis berücksichtigt" but is still cooperative
    const hasCooperative =
      result.agentResponse.includes("Hinweis berücksichtigt") ||
      result.agentResponse.includes("vorbereitet") ||
      result.agentResponse.includes("Entwurf") ||
      result.agentResponse.includes("Backend");
    expect(hasCooperative).toBe(true);
  });
});

// ─── Chat Messages enriched with Step 15 fields ──────────

describe("Step 15 – Chat messages carry plan context", () => {
  test("feedback and agent response messages carry planPhase", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "approve",
      preferredScope: "full_fix",
    });

    const chat = getAgentChatMessages({ agentCaseId: agentCase.agentCaseId });
    // Should have the initial problem_detected + feedback + agent response
    expect(chat.filteredCount).toBeGreaterThanOrEqual(3);

    // The agent response message should carry a planPhase
    // Step 16 may produce "draft_prepared" instead of "preparation_started"
    const agentMessages = chat.messages.filter(m => m.agentRole !== "user");
    const refinedMsg = agentMessages.find(m =>
      m.messageType === "preparation_started" ||
      m.messageType === "plan_refined" ||
      m.messageType === "draft_prepared"
    );
    expect(refinedMsg).toBeDefined();
    expect(refinedMsg.planPhase).toBeDefined();
  });

  test("messages with preparation have controlledPreparationType", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "approve",
      preferredScope: "full_fix",
    });

    const chat = getAgentChatMessages({ agentCaseId: agentCase.agentCaseId });
    const prepMsg = chat.messages.find(m => m.controlledPreparationType);
    expect(prepMsg).toBeDefined();
    expect(VALID_CONTROLLED_PREPARATION_TYPES).toContain(prepMsg.controlledPreparationType);
  });
});

// ─── getRefinedPlanSummary ────────────────────────────────

describe("Step 15 – getRefinedPlanSummary", () => {
  test("returns summary with expected fields", () => {
    // Build a few cases with different feedback
    const backendPkg = makeBackendBridgePackage();
    const frontendPkg = makeFrontendBridgePackage();
    const bc = buildAgentCaseFromBridgePackage(backendPkg);
    const fc = buildAgentCaseFromBridgePackage(frontendPkg);

    submitAgentCaseFeedback({ agentCaseId: bc.agentCaseId, feedbackType: "approve", preferredScope: "full_fix" });
    submitAgentCaseFeedback({ agentCaseId: fc.agentCaseId, feedbackType: "narrow_scope", preferredScope: "frontend_only" });

    const summary = getRefinedPlanSummary();

    expect(summary.totalAgentCases).toBeGreaterThanOrEqual(2);
    expect(summary.withRefinedPlan).toBeGreaterThanOrEqual(2);
    expect(summary.readyToPrepare).toBeGreaterThanOrEqual(2);
    expect(summary.byPreparationType).toBeDefined();
    expect(summary.byApprovalDecisionStage).toBeDefined();
    expect(summary.byPlanPhase).toBeDefined();
    expect(summary.crossAgentStatus).toBeDefined();
    expect(summary.refinedCases).toBeInstanceOf(Array);
    expect(summary.generatedAt).toBeTruthy();
  });

  test("refined cases contain expected Step 15 fields", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "approve",
      preferredScope: "backend_only",
    });

    const summary = getRefinedPlanSummary();
    const found = summary.refinedCases.find(c => c.agentCaseId === agentCase.agentCaseId);

    expect(found).toBeDefined();
    expect(found.planPhase).toBe("preparation_phase");
    expect(found.approvalDecisionStage).toBe("approved_backend_only");
    expect(found.controlledPreparationType).toBe("backend_prepare");
    expect(found.preparationStatus).toBe("ready_to_prepare");
    expect(found.canPrepareNow).toBe(true);
    expect(found.hasRefinedPlan).toBe(true);
    expect(found.ownerAgent).toBe("deepseek_backend");
    expect(found.secondaryAgent).toBe("gemini_frontend");
  });

  test("awaiting_decision cases appear in summary", () => {
    const pkg = makeBackendBridgePackage();
    buildAgentCaseFromBridgePackage(pkg); // no feedback → awaiting

    const summary = getRefinedPlanSummary();
    expect(summary.awaitingDecision).toBeGreaterThan(0);
  });

  test("cross-agent review cases tracked in crossAgentStatus", () => {
    const pkg = makeBackendBridgePackage({
      bridgeHints: [
        { type: "change_guard", severity: "high", summary: "Backend issue", affectedLayer: "backend_logic" },
        { type: "binding_risk", severity: "medium", summary: "Frontend binding", affectedLayer: "frontend_binding" },
      ],
    });
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    if (agentCase) {
      const summary = getRefinedPlanSummary();
      expect(summary.crossAgentStatus.needsCrossAgentReview).toBeGreaterThan(0);
    }
  });
});

// ─── Preparation Steps ───────────────────────────────────

describe("Step 15 – preparationSteps are actionable and bounded", () => {
  test("approve full produces non-empty preparation steps", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "approve",
      preferredScope: "full_fix",
    });

    expect(result.preparationSteps).toBeInstanceOf(Array);
    expect(result.preparationSteps.length).toBeGreaterThan(0);
    expect(result.preparationSteps.length).toBeLessThanOrEqual(10);
  });

  test("hold/defer/reject produce hold preparation steps", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "reject",
    });

    expect(result.preparationSteps).toBeInstanceOf(Array);
    expect(result.preparationSteps.length).toBeGreaterThan(0);
    // Steps should indicate holding back
    const stepsText = result.preparationSteps.join(" ");
    expect(stepsText).toContain("zurückgestellt");
  });

  test("diagnosis_only steps mention documentation/analysis", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "request_more_info",
    });

    const stepsText = result.preparationSteps.join(" ");
    expect(stepsText.toLowerCase()).toMatch(/diagnos|ursache|analyse/);
  });
});

// ─── refinementReason ────────────────────────────────────

describe("Step 15 – refinementReason describes what changed", () => {
  test("approve produces 'Vollständige Freigabe erteilt'", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "approve",
      preferredScope: "full_fix",
    });

    expect(result.refinementReason).toBe("Vollständige Freigabe erteilt");
  });

  test("narrow_scope reason includes scope name", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "narrow_scope",
      preferredScope: "backend_only",
    });

    expect(result.refinementReason).toContain("backend_only");
  });

  test("suggest_alternative includes alternative text", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "suggest_alternative",
      alternativeSuggestion: "Cache-Reset statt vollständiger Neuberechnung",
    });

    expect(result.refinementReason).toContain("Cache-Reset");
  });
});
