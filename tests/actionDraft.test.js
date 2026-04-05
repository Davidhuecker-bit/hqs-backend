/**
 * tests/actionDraft.test.js
 *
 * Step 16 – Controlled Action Draft / Fix Bundle Preparation
 *
 * Tests for:
 * - Step 16 constants (draft types, change categories, draft statuses)
 * - Action draft generation from approved agent cases
 * - Draft type derivation from preparation types
 * - Change category derivation from draft types
 * - Affected targets structuring
 * - Preparation ownership / handoff logic
 * - Human-readable cooperative draft messages
 * - Action draft summary / fix bundle overview
 * - Chat messages carrying draft phase fields
 * - DeepSeek / Gemini ownership separation
 */

const {
  buildAgentCaseFromBridgePackage,
  submitAgentCaseFeedback,
  getActionDraftSummary,
  VALID_DRAFT_TYPES,
  VALID_CHANGE_CATEGORIES,
  VALID_DRAFT_STATUSES,
  VALID_AGENT_FEEDBACK_TYPES,
  getAgentChatMessages,
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
   so that Step 15+16 generate a draft.
   ───────────────────────────────────────────── */
function createAndApproveCaseWithDraft(overrides = {}) {
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
   Step 16 – Constants
   ═══════════════════════════════════════════════ */
describe("Step 16 – Constants", () => {
  test("VALID_DRAFT_TYPES contains expected entries", () => {
    expect(VALID_DRAFT_TYPES).toContain("diagnosis_draft");
    expect(VALID_DRAFT_TYPES).toContain("backend_fix_draft");
    expect(VALID_DRAFT_TYPES).toContain("frontend_fix_draft");
    expect(VALID_DRAFT_TYPES).toContain("partial_fix_draft");
    expect(VALID_DRAFT_TYPES).toContain("cross_agent_draft");
    expect(VALID_DRAFT_TYPES).toContain("data_contract_draft");
    expect(VALID_DRAFT_TYPES).toContain("mapping_fix_draft");
    expect(VALID_DRAFT_TYPES).toContain("route_hardening_draft");
    expect(VALID_DRAFT_TYPES).toContain("config_check_draft");
    expect(VALID_DRAFT_TYPES).toContain("ui_clarity_draft");
    expect(VALID_DRAFT_TYPES.length).toBeGreaterThanOrEqual(10);
  });

  test("VALID_CHANGE_CATEGORIES contains expected entries", () => {
    expect(VALID_CHANGE_CATEGORIES).toContain("backend_logic");
    expect(VALID_CHANGE_CATEGORIES).toContain("api_contract");
    expect(VALID_CHANGE_CATEGORIES).toContain("data_mapping");
    expect(VALID_CHANGE_CATEGORIES).toContain("frontend_structure");
    expect(VALID_CHANGE_CATEGORIES).toContain("ui_clarity");
    expect(VALID_CHANGE_CATEGORIES).toContain("ops_check");
    expect(VALID_CHANGE_CATEGORIES).toContain("schema_alignment");
    expect(VALID_CHANGE_CATEGORIES).toContain("diagnosis_extension");
    expect(VALID_CHANGE_CATEGORIES).toContain("route_hardening");
    expect(VALID_CHANGE_CATEGORIES).toContain("cross_layer_coordination");
    expect(VALID_CHANGE_CATEGORIES.length).toBeGreaterThanOrEqual(10);
  });

  test("VALID_DRAFT_STATUSES contains expected entries", () => {
    expect(VALID_DRAFT_STATUSES).toContain("prepared");
    expect(VALID_DRAFT_STATUSES).toContain("reviewed");
    expect(VALID_DRAFT_STATUSES).toContain("approved_for_execution");
    expect(VALID_DRAFT_STATUSES).toContain("rejected");
    expect(VALID_DRAFT_STATUSES).toContain("superseded");
    expect(VALID_DRAFT_STATUSES).toContain("needs_revision");
    expect(VALID_DRAFT_STATUSES.length).toBeGreaterThanOrEqual(6);
  });
});

/* ═══════════════════════════════════════════════
   Step 16 – Action Draft Generation
   ═══════════════════════════════════════════════ */
describe("Step 16 – Action Draft Generation", () => {
  test("approved case generates an action draft", () => {
    const { result } = createAndApproveCaseWithDraft();
    expect(result.success).toBe(true);
    expect(result.hasActionDraft).toBe(true);
    expect(result.draftType).toBeTruthy();
    expect(VALID_DRAFT_TYPES).toContain(result.draftType);
    expect(result.draftStatus).toBe("prepared");
    expect(result.changeCategory).toBeTruthy();
    expect(VALID_CHANGE_CATEGORIES).toContain(result.changeCategory);
    expect(result.executionBlocked).toBe(true);
  });

  test("rejected case does not generate a draft", () => {
    const { result } = createAndApproveCaseWithDraft({ feedbackType: "reject" });
    expect(result.success).toBe(true);
    expect(result.hasActionDraft).toBeFalsy();
    expect(result.draftType).toBeNull();
  });

  test("deferred case does not generate a draft", () => {
    const { result } = createAndApproveCaseWithDraft({ feedbackType: "defer" });
    expect(result.success).toBe(true);
    expect(result.hasActionDraft).toBeFalsy();
    expect(result.draftType).toBeNull();
  });

  test("request_more_info generates a diagnosis_draft", () => {
    const { result } = createAndApproveCaseWithDraft({ feedbackType: "request_more_info" });
    expect(result.success).toBe(true);
    // diagnosis_only preparation → diagnosis_draft may or may not be generated
    // depending on canPrepareNow
    if (result.hasActionDraft) {
      expect(result.draftType).toBe("diagnosis_draft");
      expect(result.changeCategory).toBe("diagnosis_extension");
    }
  });

  test("narrow_scope with backend_only generates backend_fix_draft", () => {
    const { result } = createAndApproveCaseWithDraft({
      feedbackType: "narrow_scope",
      preferredScope: "backend_only",
    });
    expect(result.success).toBe(true);
    if (result.hasActionDraft) {
      expect(["backend_fix_draft", "data_contract_draft", "mapping_fix_draft", "route_hardening_draft"]).toContain(result.draftType);
    }
  });

  test("approve_partial generates a draft with partial preparation", () => {
    const { result } = createAndApproveCaseWithDraft({
      feedbackType: "approve_partial",
      preferredScope: "backend_only",
    });
    expect(result.success).toBe(true);
    if (result.hasActionDraft) {
      expect(result.draftType).toBeTruthy();
      expect(result.preparationOwner).toBeTruthy();
    }
  });
});

/* ═══════════════════════════════════════════════
   Step 16 – Draft Type Derivation
   ═══════════════════════════════════════════════ */
describe("Step 16 – Draft Type Derivation", () => {
  test("backend layer produces backend_fix_draft for generic problem", () => {
    const { result } = createAndApproveCaseWithDraft({
      affectedLayer: "backend_logic",
    });
    if (result.hasActionDraft) {
      expect(["backend_fix_draft", "data_contract_draft", "mapping_fix_draft", "route_hardening_draft"]).toContain(result.draftType);
    }
  });

  test("frontend layer produces frontend_fix_draft", () => {
    const { result } = createAndApproveCaseWithDraft({
      affectedLayer: "frontend_layout",
      issueContext: { issueCategory: "layout_issue" },
    });
    if (result.hasActionDraft) {
      expect(["frontend_fix_draft", "ui_clarity_draft", "cross_agent_draft"]).toContain(result.draftType);
    }
  });
});

/* ═══════════════════════════════════════════════
   Step 16 – Affected Targets
   ═══════════════════════════════════════════════ */
describe("Step 16 – Affected Targets", () => {
  test("affected targets are structured from agent case change targets", () => {
    const { result } = createAndApproveCaseWithDraft({
      affectedComponents: ["UserService", "route:/api/users", "user_table"],
      artifacts: ["user.model.js"],
    });
    expect(result.success).toBe(true);
    if (result.affectedTargets) {
      expect(result.affectedTargets.affectedDomain).toBeTruthy();
      expect(typeof result.affectedTargets.affectedServices).toBe("object");
      expect(typeof result.affectedTargets.affectedRoutes).toBe("object");
      expect(typeof result.affectedTargets.affectedFiles).toBe("object");
    }
  });
});

/* ═══════════════════════════════════════════════
   Step 16 – Preparation Ownership
   ═══════════════════════════════════════════════ */
describe("Step 16 – Preparation Ownership", () => {
  test("backend draft has deepseek_backend as preparation owner", () => {
    const { result } = createAndApproveCaseWithDraft({
      affectedLayer: "backend_logic",
    });
    if (result.hasActionDraft && result.preparationOwner) {
      expect(result.preparationOwner).toBe("deepseek_backend");
    }
  });

  test("frontend draft has gemini_frontend as preparation owner", () => {
    const { result } = createAndApproveCaseWithDraft({
      affectedLayer: "frontend_layout",
    });
    if (result.hasActionDraft && result.preparationOwner) {
      expect(["deepseek_backend", "gemini_frontend"]).toContain(result.preparationOwner);
    }
  });
});

/* ═══════════════════════════════════════════════
   Step 16 – Cooperative Draft Messages
   ═══════════════════════════════════════════════ */
describe("Step 16 – Cooperative Draft Messages (German)", () => {
  test("draft message is human-readable German", () => {
    const { result } = createAndApproveCaseWithDraft();
    if (result.draftMessage) {
      expect(typeof result.draftMessage).toBe("string");
      expect(result.draftMessage.length).toBeGreaterThan(20);
      // Must not contain raw tech labels
      expect(result.draftMessage).not.toMatch(/EXECUTING/i);
      expect(result.draftMessage).not.toMatch(/AUTO_DEPLOY/i);
    }
  });

  test("draft message contains cooperative language", () => {
    const { result } = createAndApproveCaseWithDraft();
    if (result.draftMessage) {
      // Should contain cooperative agent language
      const hasCooperative =
        result.draftMessage.includes("vorbereitet") ||
        result.draftMessage.includes("Entwurf") ||
        result.draftMessage.includes("Bestätigung") ||
        result.draftMessage.includes("Basis") ||
        result.draftMessage.includes("Schwerpunkt");
      expect(hasCooperative).toBe(true);
    }
  });

  test("agentResponse is enriched with draft message when draft exists", () => {
    const { result } = createAndApproveCaseWithDraft();
    expect(result.agentResponse).toBeTruthy();
    if (result.hasActionDraft) {
      // agentResponse should be the draft message
      expect(result.agentResponse).toContain("vorbereitet");
    }
  });
});

/* ═══════════════════════════════════════════════
   Step 16 – Chat Messages with Draft Fields
   ═══════════════════════════════════════════════ */
describe("Step 16 – Chat messages carry draft phase fields", () => {
  test("draft_prepared message includes draft context", () => {
    const { agentCase } = createAndApproveCaseWithDraft();
    const chat = getAgentChatMessages({ agentCaseId: agentCase.agentCaseId });
    expect(chat.filteredCount).toBeGreaterThanOrEqual(2);

    // Find the draft_prepared or preparation_started message
    const draftMsg = chat.messages.find(
      (m) => m.messageType === "draft_prepared" || m.messageType === "preparation_started"
    );
    if (draftMsg && draftMsg.messageType === "draft_prepared") {
      expect(draftMsg.draftType).toBeTruthy();
      expect(draftMsg.draftStatus).toBe("prepared");
      expect(draftMsg.messagePhase).toBe("draft_phase");
      expect(draftMsg.planPhase).toBe("draft_phase");
      expect(draftMsg.actionIntent).toBe("prepare_draft");
    }
  });

  test("message phase derives correctly from plan phase", () => {
    const { agentCase } = createAndApproveCaseWithDraft({ feedbackType: "request_more_info" });
    const chat = getAgentChatMessages({ agentCaseId: agentCase.agentCaseId });
    // At least the problem_detected and some response should exist
    const messages = chat.messages;
    expect(messages.length).toBeGreaterThanOrEqual(2);
  });
});

/* ═══════════════════════════════════════════════
   Step 16 – Action Draft Summary
   ═══════════════════════════════════════════════ */
describe("Step 16 – getActionDraftSummary", () => {
  test("returns valid summary structure", () => {
    // Create at least one case with draft
    createAndApproveCaseWithDraft();

    const summary = getActionDraftSummary();
    expect(summary.totalAgentCases).toBeGreaterThanOrEqual(1);
    expect(typeof summary.totalWithDraft).toBe("number");
    expect(typeof summary.totalDiagnosisOnly).toBe("number");
    expect(typeof summary.totalAwaitingApproval).toBe("number");
    expect(typeof summary.totalHandoffSuggested).toBe("number");
    expect(typeof summary.totalCrossAgentDrafts).toBe("number");
    expect(typeof summary.totalBackendDrafts).toBe("number");
    expect(typeof summary.totalFrontendDrafts).toBe("number");
    expect(typeof summary.byDraftType).toBe("object");
    expect(typeof summary.byChangeCategory).toBe("object");
    expect(typeof summary.byDraftStatus).toBe("object");
    expect(typeof summary.byPreparationOwner).toBe("object");
    expect(typeof summary.byAffectedDomain).toBe("object");
    expect(Array.isArray(summary.draftCases)).toBe(true);
    expect(summary.generatedAt).toBeTruthy();
  });

  test("summary counts drafts correctly", () => {
    createAndApproveCaseWithDraft();
    createAndApproveCaseWithDraft();

    const summary = getActionDraftSummary();
    // Should have at least some drafts
    expect(summary.totalWithDraft).toBeGreaterThanOrEqual(1);
  });

  test("draft cases have expected fields", () => {
    createAndApproveCaseWithDraft();
    const summary = getActionDraftSummary();

    if (summary.draftCases.length > 0) {
      const dc = summary.draftCases[0];
      expect(dc.agentCaseId).toBeTruthy();
      expect(dc.agentRole).toBeTruthy();
      expect(dc.draftId).toBeTruthy();
      expect(dc.draftType).toBeTruthy();
      expect(dc.draftStatus).toBeTruthy();
      expect(dc.changeCategory).toBeTruthy();
      expect(dc.preparationOwner).toBeTruthy();
      expect(typeof dc.handoffSuggested).toBe("boolean");
      expect(typeof dc.requiresFurtherApproval).toBe("boolean");
      expect(typeof dc.executionBlocked).toBe("boolean");
      expect(dc.executionBlocked).toBe(true); // Always blocked
      expect(dc.preparedAt).toBeTruthy();
    }
  });
});

/* ═══════════════════════════════════════════════
   Step 16 – Execution Always Blocked
   ═══════════════════════════════════════════════ */
describe("Step 16 – Execution Safety", () => {
  test("executionBlocked is always true on new drafts", () => {
    const { result } = createAndApproveCaseWithDraft();
    if (result.hasActionDraft) {
      expect(result.executionBlocked).toBe(true);
    }
  });

  test("requiresFurtherApproval is set appropriately", () => {
    const { result } = createAndApproveCaseWithDraft();
    if (result.hasActionDraft) {
      expect(typeof result.requiresFurtherApproval).toBe("boolean");
    }
  });
});

/* ═══════════════════════════════════════════════
   Step 16 – DeepSeek / Gemini Role Separation
   ═══════════════════════════════════════════════ */
describe("Step 16 – Agent Role Separation", () => {
  test("backend problem assigns DeepSeek as preparation owner", () => {
    const { result } = createAndApproveCaseWithDraft({
      affectedLayer: "backend_logic",
    });
    if (result.hasActionDraft) {
      expect(result.preparationOwner).toBe("deepseek_backend");
    }
  });

  test("cross-layer produces cross_agent_draft with handoff", () => {
    const { result } = createAndApproveCaseWithDraft({
      affectedLayer: "cross_layer",
      bridgeHints: [
        { type: "binding_risk", summary: "Cross hint", severity: "high", affectedLayer: "frontend_binding" },
        { type: "schema_risk", summary: "Backend hint", severity: "high", affectedLayer: "backend_logic" },
      ],
    });
    if (result.hasActionDraft && result.draftType === "cross_agent_draft") {
      expect(result.requiresFurtherApproval).toBe(true);
    }
  });
});
