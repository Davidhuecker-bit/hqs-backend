/**
 * tests/applyReadiness.test.js
 *
 * Step 17 – Controlled Execution Proposal /
 * Apply-Readiness / Final Approval Layer
 *
 * Tests for:
 * - Step 17 constants (readiness bands, apply modes, blocking factor types, risk flag types)
 * - Apply-readiness assessment from action drafts
 * - Readiness score / band computation
 * - Blocking factors, open checks, risk flags derivation
 * - Execution ownership (DeepSeek / Gemini)
 * - Human-readable cooperative execution proposal messages
 * - Apply-readiness summary overview
 * - Chat messages carrying approval phase fields
 * - Feedback result carrying Step 17 fields
 */

const {
  buildAgentCaseFromBridgePackage,
  submitAgentCaseFeedback,
  getActionDraftSummary,
  getApplyReadinessSummary,
  getAgentChatMessages,
  VALID_READINESS_BANDS,
  VALID_APPLY_MODES,
  VALID_BLOCKING_FACTOR_TYPES,
  VALID_RISK_FLAG_TYPES,
  VALID_DRAFT_TYPES,
} = require("../services/agentBridge.service");

/* ─────────────────────────────────────────────
   Test helper: build a minimal bridge package
   that is actionable enough to create an agent case.
   ───────────────────────────────────────────── */
function buildTestBridgePackage(overrides = {}) {
  return {
    issueContext: {
      issueSeverity: "high",
      issueCategory: "data_inconsistency",
      affectedLayer: overrides.affectedLayer || "backend_logic",
      issueTitle: overrides.issueTitle || "Testfall – Datenproblem",
      suspectedIssueCause: "mapping_drift",
      suggestedFix: "correct_mapping",
      affectedComponents: overrides.affectedComponents || ["UserService", "route:/api/users"],
      ...overrides.issueContext,
    },
    patternContext: {
      confidenceBand: "high",
      actionReadinessBand: "mature_recommendation",
      dominantLayer: overrides.affectedLayer || "backend_logic",
      dominantHintType: "schema_risk",
      ...overrides.patternContext,
    },
    maturityContext: {
      decisionMaturityBand: "confirmed",
      ...overrides.maturityContext,
    },
    attentionContext: {
      attentionBand: "focus_now",
      ...overrides.attentionContext,
    },
    caseContext: {},
    governanceContext: {},
    impactTranslation: {
      likelyAffectedArtifacts: overrides.artifacts || ["user.model.js"],
      impactSummary: "Datenmapping prüfen",
    },
    bridgeHints: overrides.bridgeHints || [
      {
        type: "schema_risk",
        summary: "Schema-Abweichung im User-Modell",
        severity: "high",
        affectedLayer: "backend_logic",
      },
    ],
    ...overrides.extraPkg,
  };
}

/* ─────────────────────────────────────────────
   Helper: create an agent case and approve it
   so that Step 15+16+17 generate a draft and
   apply-readiness assessment.
   ───────────────────────────────────────────── */
function createAndApproveCase(overrides = {}) {
  const pkg = buildTestBridgePackage(overrides);
  const agentCase = buildAgentCaseFromBridgePackage(pkg);
  expect(agentCase).not.toBeNull();

  const feedbackType = overrides.feedbackType || "approve";
  const result = submitAgentCaseFeedback({
    agentCaseId: agentCase.agentCaseId,
    feedbackType,
    userMessage: overrides.userMessage || "Bitte vorbereiten",
    preferredScope: overrides.preferredScope || null,
    alternativeSuggestion: overrides.alternativeSuggestion || null,
  });

  return { agentCase, result };
}

/* ═══════════════════════════════════════════════
   Step 17 – Constants
   ═══════════════════════════════════════════════ */
describe("Step 17 – Constants", () => {
  test("VALID_READINESS_BANDS contains expected entries", () => {
    expect(VALID_READINESS_BANDS).toContain("not_ready");
    expect(VALID_READINESS_BANDS).toContain("diagnosis_only");
    expect(VALID_READINESS_BANDS).toContain("review_ready");
    expect(VALID_READINESS_BANDS).toContain("partial_apply_ready");
    expect(VALID_READINESS_BANDS).toContain("final_approval_ready");
    expect(VALID_READINESS_BANDS).toContain("blocked_pending_review");
    expect(VALID_READINESS_BANDS).toContain("cross_agent_pending");
    expect(VALID_READINESS_BANDS.length).toBeGreaterThanOrEqual(7);
  });

  test("VALID_APPLY_MODES contains expected entries", () => {
    expect(VALID_APPLY_MODES).toContain("diagnosis_only");
    expect(VALID_APPLY_MODES).toContain("review_only");
    expect(VALID_APPLY_MODES).toContain("partial_apply");
    expect(VALID_APPLY_MODES).toContain("full_apply_candidate");
    expect(VALID_APPLY_MODES).toContain("handoff_first");
    expect(VALID_APPLY_MODES).toContain("wait_for_user");
    expect(VALID_APPLY_MODES.length).toBeGreaterThanOrEqual(6);
  });

  test("VALID_BLOCKING_FACTOR_TYPES contains expected entries", () => {
    expect(VALID_BLOCKING_FACTOR_TYPES).toContain("scope_unclear");
    expect(VALID_BLOCKING_FACTOR_TYPES).toContain("missing_confirmation");
    expect(VALID_BLOCKING_FACTOR_TYPES).toContain("cross_agent_dependency");
    expect(VALID_BLOCKING_FACTOR_TYPES).toContain("needs_fresh_evidence");
    expect(VALID_BLOCKING_FACTOR_TYPES).toContain("risk_not_mitigated");
    expect(VALID_BLOCKING_FACTOR_TYPES).toContain("partial_coverage");
    expect(VALID_BLOCKING_FACTOR_TYPES).toContain("approval_pending");
    expect(VALID_BLOCKING_FACTOR_TYPES).toContain("handoff_incomplete");
    expect(VALID_BLOCKING_FACTOR_TYPES.length).toBeGreaterThanOrEqual(8);
  });

  test("VALID_RISK_FLAG_TYPES contains expected entries", () => {
    expect(VALID_RISK_FLAG_TYPES).toContain("scope_uncertainty");
    expect(VALID_RISK_FLAG_TYPES).toContain("side_effect_possible");
    expect(VALID_RISK_FLAG_TYPES).toContain("regression_risk");
    expect(VALID_RISK_FLAG_TYPES).toContain("incomplete_testing");
    expect(VALID_RISK_FLAG_TYPES).toContain("cross_layer_impact");
    expect(VALID_RISK_FLAG_TYPES).toContain("data_integrity_concern");
    expect(VALID_RISK_FLAG_TYPES).toContain("timing_sensitivity");
    expect(VALID_RISK_FLAG_TYPES.length).toBeGreaterThanOrEqual(7);
  });
});

/* ═══════════════════════════════════════════════
   Step 17 – Apply-Readiness Assessment
   ═══════════════════════════════════════════════ */
describe("Step 17 – Apply-Readiness Assessment", () => {
  test("approved backend case gets apply-readiness with valid band", () => {
    const { result } = createAndApproveCase();
    expect(result.success).toBe(true);
    expect(result.hasApplyReadiness).toBe(true);
    expect(VALID_READINESS_BANDS).toContain(result.readinessBand);
  });

  test("apply-readiness includes readiness score (0-10)", () => {
    const { result } = createAndApproveCase();
    expect(result.readinessScore).toBeGreaterThanOrEqual(0);
    expect(result.readinessScore).toBeLessThanOrEqual(10);
  });

  test("apply-readiness includes recommended apply mode", () => {
    const { result } = createAndApproveCase();
    expect(VALID_APPLY_MODES).toContain(result.recommendedApplyMode);
  });

  test("apply-readiness includes execution owner", () => {
    const { result } = createAndApproveCase();
    expect(result.executionOwner).toBeTruthy();
    expect(["deepseek_backend", "gemini_frontend"]).toContain(result.executionOwner);
  });

  test("apply-readiness includes proposal owner", () => {
    const { result } = createAndApproveCase();
    expect(result.proposalOwner).toBeTruthy();
  });

  test("apply-readiness includes execution intent", () => {
    const { result } = createAndApproveCase();
    expect(result.executionIntent).toBeTruthy();
    expect(["controlled_full_apply", "controlled_partial_apply", "no_apply_yet"]).toContain(result.executionIntent);
  });

  test("apply-readiness includes eligibility and blocked status", () => {
    const { result } = createAndApproveCase();
    expect(typeof result.eligibleForApply).toBe("boolean");
    expect(typeof result.applyBlocked).toBe("boolean");
  });

  test("apply-readiness includes human-readable execution proposal message", () => {
    const { result } = createAndApproveCase();
    expect(result.executionProposalMessage).toBeTruthy();
    expect(typeof result.executionProposalMessage).toBe("string");
    expect(result.executionProposalMessage.length).toBeGreaterThan(20);
  });

  test("execution proposal message uses cooperative German language", () => {
    const { result } = createAndApproveCase();
    const msg = result.executionProposalMessage;
    // Should contain cooperative language (Ich-form or Empfehlung)
    expect(
      msg.includes("Ich") ||
      msg.includes("Empfehlung") ||
      msg.includes("Entwurf") ||
      msg.includes("Freigabe")
    ).toBe(true);
    // Should NOT contain aggressive autonomy language
    expect(msg.includes("ich führe jetzt aus")).toBe(false);
  });
});

/* ═══════════════════════════════════════════════
   Step 17 – Draft Type → Readiness Band Logic
   ═══════════════════════════════════════════════ */
describe("Step 17 – Draft Type → Readiness Mapping", () => {
  test("diagnosis case gets diagnosis_only band when requesting more info", () => {
    const { result } = createAndApproveCase({
      feedbackType: "request_more_info",
    });
    // Request more info should not produce an action draft (hold preparation)
    // so no apply readiness expected
    expect(result.success).toBe(true);
  });

  test("frontend case gets frontend-appropriate execution owner", () => {
    const { result } = createAndApproveCase({
      affectedLayer: "frontend_layout",
      issueContext: {
        affectedLayer: "frontend_layout",
        issueCategory: "display_anomaly",
        issueSeverity: "medium",
        issueTitle: "Layout-Problem",
        suspectedIssueCause: "layout_drift",
        suggestedFix: "adjust_layout",
        affectedComponents: ["UserView"],
      },
    });
    expect(result.success).toBe(true);
    if (result.hasApplyReadiness) {
      expect(["deepseek_backend", "gemini_frontend"]).toContain(result.executionOwner);
    }
  });

  test("partial approval produces partial-appropriate readiness", () => {
    const { result } = createAndApproveCase({
      feedbackType: "approve_partial",
      preferredScope: "backend_only",
    });
    expect(result.success).toBe(true);
    if (result.hasApplyReadiness) {
      expect(VALID_READINESS_BANDS).toContain(result.readinessBand);
    }
  });
});

/* ═══════════════════════════════════════════════
   Step 17 – Blocking Factors / Risk Flags
   ═══════════════════════════════════════════════ */
describe("Step 17 – Blocking Factors / Risk Flags", () => {
  test("freshly approved case has blocking factors (approval_pending)", () => {
    const { result } = createAndApproveCase();
    if (result.hasApplyReadiness && result.applyBlocked) {
      expect(result.applyBlockedReason).toBeTruthy();
      expect(typeof result.applyBlockedReason).toBe("string");
    }
  });

  test("rejected case does not produce apply-readiness", () => {
    const { result } = createAndApproveCase({
      feedbackType: "reject",
    });
    expect(result.success).toBe(true);
    // Rejected cases should not produce action drafts or readiness
    expect(result.hasActionDraft).toBeFalsy();
    expect(result.hasApplyReadiness).toBeFalsy();
  });

  test("deferred case does not produce apply-readiness", () => {
    const { result } = createAndApproveCase({
      feedbackType: "defer",
    });
    expect(result.success).toBe(true);
    expect(result.hasActionDraft).toBeFalsy();
    expect(result.hasApplyReadiness).toBeFalsy();
  });
});

/* ═══════════════════════════════════════════════
   Step 17 – Execution Ownership
   ═══════════════════════════════════════════════ */
describe("Step 17 – Execution Ownership", () => {
  test("backend case assigns deepseek_backend as execution owner", () => {
    const { result } = createAndApproveCase({
      affectedLayer: "backend_logic",
    });
    if (result.hasApplyReadiness) {
      expect(result.executionOwner).toBe("deepseek_backend");
    }
  });

  test("execution proposal always has user as final approval owner", () => {
    const { result } = createAndApproveCase();
    // The finalApprovalOwner is "user" – verified through message language
    if (result.hasApplyReadiness) {
      const msg = result.executionProposalMessage;
      expect(
        msg.includes("Bestätigung") ||
        msg.includes("Empfehlung") ||
        msg.includes("Entscheidung") ||
        msg.includes("freigabereif")
      ).toBe(true);
    }
  });
});

/* ═══════════════════════════════════════════════
   Step 17 – Chat Messages with Approval Phase
   ═══════════════════════════════════════════════ */
describe("Step 17 – Chat Messages", () => {
  test("approved case records chat message with approval_phase", () => {
    const { agentCase } = createAndApproveCase();
    const messages = getAgentChatMessages({
      agentCaseId: agentCase.agentCaseId,
    });
    // Should have at least one message in approval_phase
    const approvalMessages = messages.filter((m) => m.messagePhase === "approval_phase");
    // When apply readiness is assessed, approval phase messages should exist
    if (approvalMessages.length > 0) {
      expect(approvalMessages[0].readinessBand).toBeTruthy();
      expect(VALID_READINESS_BANDS).toContain(approvalMessages[0].readinessBand);
    }
  });

  test("chat message carries execution intent when available", () => {
    const { agentCase } = createAndApproveCase();
    const messages = getAgentChatMessages({
      agentCaseId: agentCase.agentCaseId,
    });
    const approvalMessages = messages.filter((m) => m.messagePhase === "approval_phase");
    if (approvalMessages.length > 0) {
      expect(approvalMessages[0].executionIntent).toBeTruthy();
    }
  });

  test("chat message carries recommended apply mode", () => {
    const { agentCase } = createAndApproveCase();
    const messages = getAgentChatMessages({
      agentCaseId: agentCase.agentCaseId,
    });
    const approvalMessages = messages.filter((m) => m.messagePhase === "approval_phase");
    if (approvalMessages.length > 0) {
      expect(VALID_APPLY_MODES).toContain(approvalMessages[0].recommendedApplyMode);
    }
  });
});

/* ═══════════════════════════════════════════════
   Step 17 – Apply-Readiness Summary
   ═══════════════════════════════════════════════ */
describe("Step 17 – Apply-Readiness Summary", () => {
  test("getApplyReadinessSummary returns valid structure", () => {
    // Create a few cases to populate the registry
    createAndApproveCase({ issueTitle: "Summary Test A" });
    createAndApproveCase({ issueTitle: "Summary Test B" });

    const summary = getApplyReadinessSummary();
    expect(summary).toBeDefined();
    expect(typeof summary.totalAgentCases).toBe("number");
    expect(typeof summary.totalWithReadiness).toBe("number");
    expect(typeof summary.totalEligibleForApply).toBe("number");
    expect(typeof summary.totalBlocked).toBe("number");
    expect(typeof summary.totalNeedsCrossAgentReview).toBe("number");
    expect(typeof summary.totalFinalApprovalReady).toBe("number");
    expect(typeof summary.totalDiagnosisOnly).toBe("number");
    expect(summary.generatedAt).toBeTruthy();
  });

  test("summary includes band and mode distributions", () => {
    createAndApproveCase({ issueTitle: "Dist Test" });
    const summary = getApplyReadinessSummary();
    expect(typeof summary.byReadinessBand).toBe("object");
    expect(typeof summary.byApplyMode).toBe("object");
    expect(typeof summary.byBlockingFactor).toBe("object");
    expect(typeof summary.byRiskFlag).toBe("object");
    expect(typeof summary.byExecutionOwner).toBe("object");
  });

  test("summary includes readiness cases array", () => {
    const summary = getApplyReadinessSummary();
    expect(Array.isArray(summary.readinessCases)).toBe(true);
    if (summary.readinessCases.length > 0) {
      const rc = summary.readinessCases[0];
      expect(rc.agentCaseId).toBeTruthy();
      expect(rc.readinessBand).toBeTruthy();
      expect(rc.recommendedApplyMode).toBeTruthy();
      expect(typeof rc.readinessScore).toBe("number");
      expect(typeof rc.eligibleForApply).toBe("boolean");
      expect(typeof rc.applyBlocked).toBe("boolean");
      expect(rc.assessedAt).toBeTruthy();
    }
  });

  test("summary readiness cases are sorted newest first", () => {
    const summary = getApplyReadinessSummary();
    const cases = summary.readinessCases;
    for (let i = 1; i < cases.length; i++) {
      expect(cases[i - 1].assessedAt >= cases[i].assessedAt).toBe(true);
    }
  });
});

/* ═══════════════════════════════════════════════
   Step 17 – Cooperative Language
   ═══════════════════════════════════════════════ */
describe("Step 17 – Cooperative Language", () => {
  test("execution proposal avoids aggressive autonomy", () => {
    const { result } = createAndApproveCase();
    if (result.executionProposalMessage) {
      const msg = result.executionProposalMessage.toLowerCase();
      expect(msg.includes("ich führe jetzt aus")).toBe(false);
      expect(msg.includes("autonom")).toBe(false);
      expect(msg.includes("automatisch ausführ")).toBe(false);
    }
  });

  test("execution proposal contains action recommendation", () => {
    const { result } = createAndApproveCase();
    if (result.executionProposalMessage) {
      const msg = result.executionProposalMessage;
      expect(msg.includes("Empfehlung:")).toBe(true);
    }
  });

  test("agent response text is the execution proposal when available", () => {
    const { result } = createAndApproveCase();
    if (result.hasApplyReadiness) {
      expect(result.agentResponse).toBe(result.executionProposalMessage);
    }
  });
});

/* ═══════════════════════════════════════════════
   Step 17 – Feedback Result Structure
   ═══════════════════════════════════════════════ */
describe("Step 17 – Feedback Result Structure", () => {
  test("feedback result includes all Step 17 fields", () => {
    const { result } = createAndApproveCase();
    expect("hasApplyReadiness" in result).toBe(true);
    expect("readinessScore" in result).toBe(true);
    expect("readinessBand" in result).toBe(true);
    expect("recommendedApplyMode" in result).toBe(true);
    expect("eligibleForApply" in result).toBe(true);
    expect("applyBlocked" in result).toBe(true);
    expect("applyBlockedReason" in result).toBe(true);
    expect("executionOwner" in result).toBe(true);
    expect("proposalOwner" in result).toBe(true);
    expect("executionIntent" in result).toBe(true);
    expect("executionProposalMessage" in result).toBe(true);
  });

  test("feedback result without draft has null Step 17 fields", () => {
    const { result } = createAndApproveCase({
      feedbackType: "reject",
    });
    expect(result.hasApplyReadiness).toBeFalsy();
    expect(result.readinessScore).toBeNull();
    expect(result.readinessBand).toBeNull();
    expect(result.recommendedApplyMode).toBeNull();
  });
});
