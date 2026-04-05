"use strict";

/**
 * Step 14: Agent Problem Detection / Solution Proposal /
 * Approval Chat Foundation – Unit Tests
 *
 * Tests the agent case lifecycle:
 * - Agent case creation from bridge packages
 * - Chat message generation
 * - User feedback processing
 * - Summary/overview generation
 * - Role separation (DeepSeek vs Gemini)
 */

const {
  buildAgentCaseFromBridgePackage,
  submitAgentCaseFeedback,
  getAgentCaseSummary,
  getAgentChatMessages,
  VALID_AGENT_ROLES,
  VALID_AGENT_PROBLEM_TYPES,
  VALID_AGENT_MESSAGE_TYPES,
  VALID_AGENT_MESSAGE_INTENTS,
  VALID_APPROVAL_SCOPES,
  VALID_PREPARATION_TYPES,
  VALID_AGENT_FEEDBACK_TYPES,
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

// ─── Constants ─────────────────────────────────────────

describe("Step 14 – Constants", () => {
  test("VALID_AGENT_ROLES contains expected roles", () => {
    expect(VALID_AGENT_ROLES).toContain("deepseek_backend");
    expect(VALID_AGENT_ROLES).toContain("gemini_frontend");
    expect(VALID_AGENT_ROLES.length).toBe(2);
  });

  test("VALID_AGENT_PROBLEM_TYPES is non-empty and contains core types", () => {
    expect(VALID_AGENT_PROBLEM_TYPES.length).toBeGreaterThan(5);
    expect(VALID_AGENT_PROBLEM_TYPES).toContain("backend_logic_issue");
    expect(VALID_AGENT_PROBLEM_TYPES).toContain("frontend_binding_issue");
    expect(VALID_AGENT_PROBLEM_TYPES).toContain("cross_layer_issue");
    expect(VALID_AGENT_PROBLEM_TYPES).toContain("unknown");
  });

  test("VALID_AGENT_MESSAGE_TYPES covers the chat lifecycle", () => {
    expect(VALID_AGENT_MESSAGE_TYPES).toContain("problem_detected");
    expect(VALID_AGENT_MESSAGE_TYPES).toContain("solution_proposed");
    expect(VALID_AGENT_MESSAGE_TYPES).toContain("approval_requested");
    expect(VALID_AGENT_MESSAGE_TYPES).toContain("feedback_received");
  });

  test("VALID_AGENT_FEEDBACK_TYPES includes approve, reject, modify", () => {
    expect(VALID_AGENT_FEEDBACK_TYPES).toContain("approve");
    expect(VALID_AGENT_FEEDBACK_TYPES).toContain("reject");
    expect(VALID_AGENT_FEEDBACK_TYPES).toContain("modify");
    expect(VALID_AGENT_FEEDBACK_TYPES).toContain("narrow_scope");
    expect(VALID_AGENT_FEEDBACK_TYPES).toContain("suggest_alternative");
  });

  test("VALID_APPROVAL_SCOPES includes core scopes", () => {
    expect(VALID_APPROVAL_SCOPES).toContain("full_fix");
    expect(VALID_APPROVAL_SCOPES).toContain("backend_only");
    expect(VALID_APPROVAL_SCOPES).toContain("frontend_only");
    expect(VALID_APPROVAL_SCOPES).toContain("diagnosis_only");
  });

  test("VALID_PREPARATION_TYPES includes key preparation types", () => {
    expect(VALID_PREPARATION_TYPES).toContain("harden_logic");
    expect(VALID_PREPARATION_TYPES).toContain("fix_mapping");
    expect(VALID_PREPARATION_TYPES).toContain("fix_binding");
    expect(VALID_PREPARATION_TYPES).toContain("adjust_layout");
    expect(VALID_PREPARATION_TYPES).toContain("deepen_diagnosis");
  });
});

// ─── Agent Case Creation ───────────────────────────────

describe("Step 14 – buildAgentCaseFromBridgePackage", () => {
  test("returns null for null input", () => {
    expect(buildAgentCaseFromBridgePackage(null)).toBeNull();
  });

  test("returns null for non-actionable bridge package", () => {
    const pkg = makeBackendBridgePackage({
      issueContext: {
        issueSeverity: "low",
        affectedLayer: "backend_logic",
      },
      attentionContext: {
        attentionBand: "background",
        attentionScore: 1,
      },
      patternContext: {
        actionReadinessBand: "observation",
        dominantLayer: "backend_logic",
      },
      maturityContext: {
        decisionMaturityBand: "early_signal",
        maturityScore: 1,
      },
    });
    expect(buildAgentCaseFromBridgePackage(pkg)).toBeNull();
  });

  test("creates a backend agent case for high-severity backend issue", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);

    expect(agentCase).not.toBeNull();
    expect(agentCase.agentCaseId).toMatch(/^ac-/);
    expect(agentCase.agentRole).toBe("deepseek_backend");
    expect(agentCase.ownerAgent).toBe("deepseek_backend");
    expect(agentCase.affectedDomain).toBe("backend");
    expect(agentCase.solutionDomain).toBe("backend");
    expect(agentCase.problemType).toBe("backend_logic_issue");
    expect(agentCase.problemTitle).toBeTruthy();
    expect(agentCase.problemSummary).toContain("Backend-Problem");
    expect(agentCase.suspectedRootCause).toBeTruthy();
    expect(agentCase.recommendedFixes).toBeInstanceOf(Array);
    expect(agentCase.recommendedFixes.length).toBeGreaterThan(0);
    expect(agentCase.recommendedFixes.length).toBeLessThanOrEqual(3);
    expect(agentCase.needsApproval).toBe(true);
    expect(agentCase.approvalQuestion).toContain("Soll ich");
    expect(agentCase.approvalQuestion).toContain("andere Idee");
    expect(agentCase.agentConfidence).toBeGreaterThan(0);
    expect(agentCase.agentConfidence).toBeLessThanOrEqual(1);
    expect(agentCase.status).toBe("proposed");
    expect(agentCase.nextSuggestedStep).toBeTruthy();
    expect(agentCase.chatMessage).toBeTruthy();
    expect(agentCase.feedbackOptions).toBeInstanceOf(Array);
    expect(agentCase.planVersion).toBe(1);
    expect(agentCase.agentCanRefinePlan).toBe(true);
    expect(agentCase.alternateSuggestionSupported).toBe(true);
    expect(agentCase.userFeedbackSupported).toBe(true);
  });

  test("creates a frontend agent case for frontend issue", () => {
    const pkg = makeFrontendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);

    expect(agentCase).not.toBeNull();
    expect(agentCase.agentRole).toBe("gemini_frontend");
    expect(agentCase.ownerAgent).toBe("gemini_frontend");
    expect(agentCase.affectedDomain).toBe("frontend");
    expect(agentCase.solutionDomain).toBe("frontend");
    expect(agentCase.problemSummary).toContain("Frontend-Problem");
  });

  test("chat message is cooperative and in German", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);

    expect(agentCase.chatMessage).toContain("Ich habe ein");
    expect(agentCase.chatMessage).toContain("Problem erkannt");
    // Should contain approval question
    expect(agentCase.chatMessage).toContain("Soll ich");
  });

  test("detects cross-agent review need for cross-layer hints", () => {
    const pkg = makeBackendBridgePackage({
      bridgeHints: [
        { type: "change_guard", severity: "high", summary: "Backend issue", affectedLayer: "backend_logic" },
        { type: "binding_risk", severity: "medium", summary: "Frontend binding", affectedLayer: "frontend_binding" },
      ],
    });
    const agentCase = buildAgentCaseFromBridgePackage(pkg);

    expect(agentCase).not.toBeNull();
    expect(agentCase.needsCrossAgentReview).toBe(true);
  });

  test("approval scope is diagnosis_only for low-confidence cases", () => {
    const pkg = makeBackendBridgePackage({
      patternContext: {
        dominantHintType: "change_guard",
        dominantLayer: "backend_logic",
        actionReadinessBand: "observation",
        confidenceBand: "low",
      },
      maturityContext: {
        decisionMaturityBand: "early_signal",
        maturityScore: 2,
      },
      attentionContext: {
        attentionBand: "review_today",
        attentionScore: 4,
      },
    });
    const agentCase = buildAgentCaseFromBridgePackage(pkg);

    expect(agentCase).not.toBeNull();
    expect(agentCase.approvalScope).toBe("diagnosis_only");
  });

  test("changeTargets are populated from issue and impact data", () => {
    const pkg = makeBackendBridgePackage({
      issueContext: {
        issueSeverity: "high",
        affectedLayer: "backend_logic",
        affectedComponents: ["UserController", "AuthService"],
      },
    });
    const agentCase = buildAgentCaseFromBridgePackage(pkg);

    expect(agentCase).not.toBeNull();
    expect(agentCase.changeTargets.length).toBeGreaterThan(0);
  });
});

// ─── Agent Case Feedback ───────────────────────────────

describe("Step 14 – submitAgentCaseFeedback", () => {
  test("returns error for unknown case", () => {
    const result = submitAgentCaseFeedback({
      agentCaseId: "nonexistent-case",
      feedbackType: "approve",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("returns error for invalid feedback type", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "invalid_type",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid feedback type");
  });

  test("approve transitions case to approved", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "approve",
    });

    expect(result.success).toBe(true);
    expect(result.newStatus).toBe("approved");
    expect(result.agentResponse).toContain("Verstanden");
    expect(result.nextSuggestedStep).toContain("Lösungsvorbereitung");
  });

  test("reject transitions case to rejected", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "reject",
    });

    expect(result.success).toBe(true);
    expect(result.newStatus).toBe("rejected");
    expect(result.agentResponse).toContain("halte den Vorschlag zurück");
  });

  test("modify increments plan version", () => {
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
    expect(result.agentResponse).toContain("passe den Vorschlag");
  });

  test("narrow_scope updates approval scope", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "narrow_scope",
      preferredScope: "backend_only",
    });

    expect(result.success).toBe(true);
    expect(result.newStatus).toBe("scope_narrowed");
    expect(result.approvalScope).toBe("backend_only");
  });

  test("defer transitions case to deferred", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "defer",
    });

    expect(result.success).toBe(true);
    expect(result.newStatus).toBe("deferred");
  });

  test("request_more_info transitions to info_requested", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = submitAgentCaseFeedback({
      agentCaseId: agentCase.agentCaseId,
      feedbackType: "request_more_info",
    });

    expect(result.success).toBe(true);
    expect(result.newStatus).toBe("info_requested");
    expect(result.agentResponse).toContain("vertiefe die Diagnose");
  });
});

// ─── Agent Case Summary ────────────────────────────────

describe("Step 14 – getAgentCaseSummary", () => {
  test("returns summary with expected fields", () => {
    // Create a few cases first
    buildAgentCaseFromBridgePackage(makeBackendBridgePackage());
    buildAgentCaseFromBridgePackage(makeFrontendBridgePackage());

    const summary = getAgentCaseSummary();
    expect(summary.totalAgentCases).toBeGreaterThanOrEqual(2);
    expect(summary.casesByRole).toBeDefined();
    expect(summary.casesByRole.deepseek_backend).toBeGreaterThanOrEqual(1);
    expect(summary.casesByRole.gemini_frontend).toBeGreaterThanOrEqual(1);
    expect(summary.casesByStatus).toBeDefined();
    expect(summary.casesByProblemType).toBeDefined();
    expect(summary.withClearFixes).toBeGreaterThanOrEqual(1);
    expect(summary.recentCases).toBeInstanceOf(Array);
    expect(summary.recentCases.length).toBeGreaterThanOrEqual(2);
    expect(summary.generatedAt).toBeTruthy();
    expect(summary.averageConfidence).toBeGreaterThan(0);
    expect(summary.totalChatMessages).toBeGreaterThan(0);
  });

  test("recent cases contain expected fields", () => {
    const summary = getAgentCaseSummary();
    const recent = summary.recentCases[0];
    expect(recent.agentCaseId).toBeTruthy();
    expect(recent.agentRole).toBeTruthy();
    expect(recent.problemType).toBeTruthy();
    expect(recent.problemTitle).toBeTruthy();
    expect(recent.status).toBeTruthy();
    expect(recent.agentConfidence).toBeDefined();
    expect(recent.fixCount).toBeGreaterThanOrEqual(0);
    expect(recent.nextSuggestedStep).toBeTruthy();
  });
});

// ─── Agent Chat Messages ───────────────────────────────

describe("Step 14 – getAgentChatMessages", () => {
  test("returns messages with expected structure", () => {
    const result = getAgentChatMessages();
    expect(result.totalMessages).toBeGreaterThan(0);
    expect(result.messages).toBeInstanceOf(Array);
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.generatedAt).toBeTruthy();

    const msg = result.messages[0];
    expect(msg.messageId).toMatch(/^msg-/);
    expect(msg.threadId).toMatch(/^ac-/);
    expect(msg.caseId).toMatch(/^ac-/);
    expect(msg.agentRole).toBeTruthy();
    expect(msg.messageType).toBeTruthy();
    expect(msg.messageIntent).toBeTruthy();
    expect(msg.agentMessage).toBeTruthy();
    expect(msg.createdAt).toBeTruthy();
  });

  test("filters by agentCaseId", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const result = getAgentChatMessages({ agentCaseId: agentCase.agentCaseId });

    expect(result.filteredCount).toBeGreaterThan(0);
    for (const msg of result.messages) {
      expect(msg.caseId).toBe(agentCase.agentCaseId);
    }
  });

  test("filters by agentRole", () => {
    const result = getAgentChatMessages({ agentRole: "deepseek_backend" });
    for (const msg of result.messages) {
      expect(msg.agentRole).toBe("deepseek_backend");
    }
  });

  test("respects limit parameter", () => {
    const result = getAgentChatMessages({ limit: 2 });
    expect(result.messages.length).toBeLessThanOrEqual(2);
  });
});

// ─── Agent Role Separation ─────────────────────────────

describe("Step 14 – Role Separation", () => {
  test("backend layers resolve to deepseek_backend", () => {
    const backendPkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(backendPkg);
    expect(agentCase.agentRole).toBe("deepseek_backend");
    expect(agentCase.affectedDomain).toBe("backend");
  });

  test("frontend layers resolve to gemini_frontend", () => {
    const frontendPkg = makeFrontendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(frontendPkg);
    expect(agentCase.agentRole).toBe("gemini_frontend");
    expect(agentCase.affectedDomain).toBe("frontend");
  });
});

// ─── Chat Message Language ─────────────────────────────

describe("Step 14 – Cooperative Language", () => {
  test("backend case uses cooperative language", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const msg = agentCase.chatMessage;

    // Should use cooperative first-person language
    expect(msg).toContain("Ich habe");
    expect(msg).toContain("Soll ich");
    // Should not use aggressive autonomous language
    expect(msg).not.toContain("ich ändere das jetzt");
    expect(msg).not.toContain("wird sofort");
  });

  test("frontend case uses cooperative language", () => {
    const pkg = makeFrontendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);
    const msg = agentCase.chatMessage;

    expect(msg).toContain("Frontend-Problem");
    expect(msg).toContain("Soll ich");
    expect(msg).toContain("andere Idee");
  });

  test("approval question is specific to preparation type", () => {
    const pkg = makeBackendBridgePackage();
    const agentCase = buildAgentCaseFromBridgePackage(pkg);

    // Should contain a specific action, not just generic
    expect(agentCase.approvalQuestion).toMatch(/Soll ich .+\?/);
  });
});
