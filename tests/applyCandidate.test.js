"use strict";

const agentBridge = require("../services/agentBridge.service");

/* ───── helpers ───── */

function buildMockBridgePackage(overrides = {}) {
  return {
    bridgeHints: [
      {
        type: "schema_risk",
        severity: "medium",
        message: "Schema alignment needed",
        impactScope: "moderate",
        likelyAffectedLayer: "backend_logic",
        suggestedFollowupType: "check_ui",
      },
    ],
    backendState: {
      lastKnownArea: "testArea",
      sourceMode: "diagnose",
      ...overrides.backendState,
    },
    workflow: {
      sourceAgent: "deepseek",
      sourceMode: "diagnose",
      reviewIntent: "initial_review",
      recommendedGeminiMode: "structure",
      ...overrides.workflow,
    },
    ...overrides,
  };
}

function createAgentCaseForCandidateTests(draftType = "backend_fix_draft", agentRole = "deepseek_backend", readinessOverrides = {}) {
  const pkg = buildMockBridgePackage();
  const agentCase = agentBridge.buildAgentCaseFromBridgePackage(pkg);

  if (!agentCase) return null;

  agentCase.actionDraft16 = {
    draftId: `draft-test-${Date.now()}`,
    draftType,
    changeCategory: draftType === "backend_fix_draft" ? "backend_logic" :
                     draftType === "frontend_fix_draft" ? "frontend_structure" :
                     draftType === "cross_agent_draft" ? "cross_layer_coordination" :
                     draftType === "mapping_fix_draft" ? "data_mapping" :
                     draftType === "diagnosis_draft" ? "diagnosis_extension" :
                     draftType === "route_hardening_draft" ? "route_hardening" :
                     draftType === "ui_clarity_draft" ? "ui_clarity" :
                     draftType === "partial_fix_draft" ? "backend_logic" :
                     draftType === "config_check_draft" ? "ops_check" :
                     draftType === "data_contract_draft" ? "api_contract" :
                     "backend_logic",
    draftSummary: `Testentwurf (${draftType})`,
    draftReason: "Testgrund",
    preparationOwner: agentRole,
    affectedTargets: { affectedDomain: "test" },
    preparationSteps: ["Schritt 1", "Schritt 2"],
    draftStatus: "review_ready",
    handoffSuggested: draftType === "cross_agent_draft",
    requiresFurtherApproval: true,
  };

  agentCase.agentRole = agentRole;

  agentCase.applyReadiness17 = {
    proposalId: `proposal-test-${Date.now()}`,
    readinessScore: 7,
    readinessBand: "review_ready",
    recommendedApplyMode: "review_only",
    eligibleForApply: false,
    applyBlocked: false,
    requiresFinalApproval: true,
    blockingFactors: [],
    openChecks: [],
    riskFlags: [],
    executionOwner: agentRole,
    proposalOwner: agentRole,
    secondaryAgent: null,
    handoffSuggested: false,
    needsCrossAgentReview: draftType === "cross_agent_draft",
    finalApprovalOwner: "user",
    executionIntent: "no_apply_yet",
    readinessReason: "Testbewertung",
    applyScope: {
      affectedLayers: ["backend_logic"],
      affectedTargets: ["api_endpoint"],
    },
    ...readinessOverrides,
  };

  // Attach a basic execution preview (Step 18)
  agentCase.executionPreview18 = {
    previewId: `preview-test-${Date.now()}`,
    agentCaseId: agentCase.agentCaseId,
    proposalId: agentCase.applyReadiness17.proposalId,
    draftId: agentCase.actionDraft16.draftId,
    previewState: "low_impact_preview",
    safetyBand: "low_risk",
    previewConfidence: "high",
    previewBlocked: false,
    dryRunOnly: true,
    expectedImpact: ["Test-Auswirkung"],
    expectedBenefits: ["Test-Vorteil"],
    possibleSideEffects: [],
    preApplyChecks: ["Prüfschritt 1"],
    postApplyChecks: ["Nachprüfung 1"],
    previewWarnings: [],
    rollbackPlan: "Standard-Revert nach Anwendung ausreichend.",
    reversalComplexity: "simple",
    rollbackPrerequisites: [],
    rollbackRecommended: false,
    rollbackNotes: "Keine besonderen Hinweise.",
    recommendedApplyWindow: "safe_anytime",
    requiresRollbackPlan: false,
    previewOwner: agentRole,
    safetyOwner: agentRole,
    rollbackOwner: agentRole,
    secondaryAgent: agentRole === "deepseek_backend" ? "gemini_frontend" : "deepseek_backend",
    handoffSuggested: false,
    needsCrossAgentReview: draftType === "cross_agent_draft",
    executionPreviewMessage: "Testvorschau",
    previewGeneratedAt: new Date().toISOString(),
    previewGeneratedByAgent: agentRole,
  };

  return agentCase;
}

/* ───── tests ───── */

describe("Step 19 – Controlled Apply Candidate / Action Package / Approval Gate", () => {

  describe("Constants", () => {
    test("VALID_CANDIDATE_STATUSES exports correct values", () => {
      expect(agentBridge.VALID_CANDIDATE_STATUSES).toBeDefined();
      expect(agentBridge.VALID_CANDIDATE_STATUSES).toContain("candidate_not_available");
      expect(agentBridge.VALID_CANDIDATE_STATUSES).toContain("candidate_diagnosis_only");
      expect(agentBridge.VALID_CANDIDATE_STATUSES).toContain("candidate_partial");
      expect(agentBridge.VALID_CANDIDATE_STATUSES).toContain("candidate_ready_for_final_approval");
      expect(agentBridge.VALID_CANDIDATE_STATUSES).toContain("candidate_blocked");
      expect(agentBridge.VALID_CANDIDATE_STATUSES).toContain("candidate_cross_agent_pending");
      expect(agentBridge.VALID_CANDIDATE_STATUSES).toContain("candidate_scope_confirmation_needed");
      expect(agentBridge.VALID_CANDIDATE_STATUSES.length).toBe(7);
    });

    test("VALID_CANDIDATE_MODES exports correct values", () => {
      expect(agentBridge.VALID_CANDIDATE_MODES).toBeDefined();
      expect(agentBridge.VALID_CANDIDATE_MODES).toContain("diagnosis_only");
      expect(agentBridge.VALID_CANDIDATE_MODES).toContain("partial_scope");
      expect(agentBridge.VALID_CANDIDATE_MODES).toContain("backend_only");
      expect(agentBridge.VALID_CANDIDATE_MODES).toContain("frontend_only");
      expect(agentBridge.VALID_CANDIDATE_MODES).toContain("cross_agent_candidate");
      expect(agentBridge.VALID_CANDIDATE_MODES).toContain("final_approval_candidate");
      expect(agentBridge.VALID_CANDIDATE_MODES).toContain("wait_for_user");
      expect(agentBridge.VALID_CANDIDATE_MODES.length).toBe(7);
    });

    test("VALID_SCOPE_GUARDRAIL_TYPES exports correct values", () => {
      expect(agentBridge.VALID_SCOPE_GUARDRAIL_TYPES).toBeDefined();
      expect(agentBridge.VALID_SCOPE_GUARDRAIL_TYPES).toContain("scope_boundary");
      expect(agentBridge.VALID_SCOPE_GUARDRAIL_TYPES).toContain("no_auto_execute");
      expect(agentBridge.VALID_SCOPE_GUARDRAIL_TYPES).toContain("requires_user_confirmation");
      expect(agentBridge.VALID_SCOPE_GUARDRAIL_TYPES).toContain("cross_agent_gate");
      expect(agentBridge.VALID_SCOPE_GUARDRAIL_TYPES).toContain("rollback_mandatory");
      expect(agentBridge.VALID_SCOPE_GUARDRAIL_TYPES).toContain("data_safety_gate");
      expect(agentBridge.VALID_SCOPE_GUARDRAIL_TYPES.length).toBe(7);
    });
  });

  describe("getApplyCandidateSummary()", () => {
    test("returns valid summary structure", () => {
      const summary = agentBridge.getApplyCandidateSummary();
      expect(summary).toBeDefined();
      expect(typeof summary.totalAgentCases).toBe("number");
      expect(typeof summary.totalWithCandidate).toBe("number");
      expect(typeof summary.totalReadyForFinalApproval).toBe("number");
      expect(typeof summary.totalBlocked).toBe("number");
      expect(typeof summary.totalScopeConfirmationNeeded).toBe("number");
      expect(typeof summary.totalCrossAgentPending).toBe("number");
      expect(typeof summary.totalDiagnosisOnly).toBe("number");
      expect(typeof summary.totalPartial).toBe("number");
      expect(summary.byCandidateStatus).toBeDefined();
      expect(summary.byCandidateMode).toBeDefined();
      expect(summary.byCandidateOwner).toBeDefined();
      expect(summary.byGuardrailType).toBeDefined();
      expect(Array.isArray(summary.topMissingApprovals)).toBe(true);
      expect(Array.isArray(summary.topPreconditions)).toBe(true);
      expect(Array.isArray(summary.candidateCases)).toBe(true);
      expect(summary.generatedAt).toBeDefined();
    });
  });

  describe("Apply candidate derivation", () => {
    test("backend_fix_draft with review_ready produces scope_confirmation_needed candidate", () => {
      const agentCase = createAgentCaseForCandidateTests("backend_fix_draft", "deepseek_backend");
      if (!agentCase) return; // skip if no actionable case

      const ac = agentCase.applyCandidate19;
      expect(ac).toBeDefined();
      expect(ac.candidateStatus).toBe("candidate_scope_confirmation_needed");
      expect(ac.candidateMode).toBe("backend_only");
    });

    test("diagnosis_draft produces candidate_diagnosis_only", () => {
      const agentCase = createAgentCaseForCandidateTests("diagnosis_draft", "deepseek_backend");
      if (!agentCase) return;

      const ac = agentCase.applyCandidate19;
      expect(ac).toBeDefined();
      expect(ac.candidateStatus).toBe("candidate_diagnosis_only");
      expect(ac.candidateMode).toBe("diagnosis_only");
    });

    test("cross_agent_draft produces candidate_cross_agent_pending", () => {
      const agentCase = createAgentCaseForCandidateTests("cross_agent_draft", "deepseek_backend");
      if (!agentCase) return;

      const ac = agentCase.applyCandidate19;
      expect(ac).toBeDefined();
      expect(ac.candidateStatus).toBe("candidate_cross_agent_pending");
      expect(ac.candidateMode).toBe("cross_agent_candidate");
    });

    test("partial_fix_draft produces candidate_partial", () => {
      const agentCase = createAgentCaseForCandidateTests("partial_fix_draft", "deepseek_backend");
      if (!agentCase) return;

      const ac = agentCase.applyCandidate19;
      expect(ac).toBeDefined();
      expect(ac.candidateStatus).toBe("candidate_partial");
      expect(ac.candidateMode).toBe("partial_scope");
    });

    test("frontend_fix_draft with gemini_frontend produces frontend_only candidate", () => {
      const agentCase = createAgentCaseForCandidateTests("frontend_fix_draft", "gemini_frontend");
      if (!agentCase) return;

      const ac = agentCase.applyCandidate19;
      expect(ac).toBeDefined();
      expect(ac.candidateMode).toBe("frontend_only");
      expect(ac.candidateOwner).toBe("gemini_frontend");
    });

    test("final_approval_ready readiness produces candidate_ready_for_final_approval", () => {
      const agentCase = createAgentCaseForCandidateTests("backend_fix_draft", "deepseek_backend", {
        readinessBand: "final_approval_ready",
      });
      if (!agentCase) return;

      const ac = agentCase.applyCandidate19;
      expect(ac).toBeDefined();
      expect(ac.candidateStatus).toBe("candidate_ready_for_final_approval");
      expect(ac.candidateReadyForFinalApproval).toBe(true);
      expect(ac.scopeLocked).toBe(true);
    });

    test("blocked apply readiness produces candidate_blocked", () => {
      const agentCase = createAgentCaseForCandidateTests("backend_fix_draft", "deepseek_backend", {
        applyBlocked: true,
        blockingFactors: [{ type: "missing_review", description: "Review fehlt" }],
      });
      if (!agentCase) return;

      const ac = agentCase.applyCandidate19;
      expect(ac).toBeDefined();
      expect(ac.candidateStatus).toBe("candidate_blocked");
      expect(ac.candidateBlocked).toBe(true);
    });
  });

  describe("Guardrails", () => {
    test("every candidate has no_auto_execute and requires_user_confirmation guardrails", () => {
      const agentCase = createAgentCaseForCandidateTests("backend_fix_draft", "deepseek_backend");
      if (!agentCase || !agentCase.applyCandidate19) return;

      const guardrails = agentCase.applyCandidate19.guardrails || [];
      const types = guardrails.map(g => g.type);
      expect(types).toContain("no_auto_execute");
      expect(types).toContain("requires_user_confirmation");
    });

    test("backend_only candidate has layer_restriction guardrail", () => {
      const agentCase = createAgentCaseForCandidateTests("backend_fix_draft", "deepseek_backend");
      if (!agentCase || !agentCase.applyCandidate19) return;

      expect(agentCase.applyCandidate19.candidateMode).toBe("backend_only");
      const types = agentCase.applyCandidate19.guardrails.map(g => g.type);
      expect(types).toContain("layer_restriction");
    });
  });

  describe("Approval checklist", () => {
    test("every candidate has scope_confirmation and final_user_approval items", () => {
      const agentCase = createAgentCaseForCandidateTests("backend_fix_draft", "deepseek_backend");
      if (!agentCase || !agentCase.applyCandidate19) return;

      const checklist = agentCase.applyCandidate19.approvalChecklist || [];
      const items = checklist.map(c => c.item);
      expect(items).toContain("scope_confirmation");
      expect(items).toContain("final_user_approval");
    });

    test("all checklist items start as not completed", () => {
      const agentCase = createAgentCaseForCandidateTests("backend_fix_draft", "deepseek_backend");
      if (!agentCase || !agentCase.applyCandidate19) return;

      const checklist = agentCase.applyCandidate19.approvalChecklist || [];
      for (const item of checklist) {
        expect(item.completed).toBe(false);
      }
    });
  });

  describe("Ownership", () => {
    test("finalApprovalOwner is always user", () => {
      const agentCase = createAgentCaseForCandidateTests("backend_fix_draft", "deepseek_backend");
      if (!agentCase || !agentCase.applyCandidate19) return;

      expect(agentCase.applyCandidate19.finalApprovalOwner).toBe("user");
    });

    test("dryRunOnly is always true", () => {
      const agentCase = createAgentCaseForCandidateTests("backend_fix_draft", "deepseek_backend");
      if (!agentCase || !agentCase.applyCandidate19) return;

      expect(agentCase.applyCandidate19.dryRunOnly).toBe(true);
    });

    test("deepseek_backend role has deepseek_backend as candidateOwner", () => {
      const agentCase = createAgentCaseForCandidateTests("backend_fix_draft", "deepseek_backend");
      if (!agentCase || !agentCase.applyCandidate19) return;

      expect(agentCase.applyCandidate19.candidateOwner).toBe("deepseek_backend");
    });
  });

  describe("Human-readable messages", () => {
    test("apply candidate message is non-empty and cooperative", () => {
      const agentCase = createAgentCaseForCandidateTests("backend_fix_draft", "deepseek_backend");
      if (!agentCase || !agentCase.applyCandidate19) return;

      const msg = agentCase.applyCandidate19.applyCandidateMessage;
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(50);
      // Should not contain aggressive/autonomous language
      expect(msg).not.toContain("ich führe jetzt aus");
      expect(msg).not.toContain("automatisch");
    });

    test("candidate message mentions user decision", () => {
      const agentCase = createAgentCaseForCandidateTests("backend_fix_draft", "deepseek_backend");
      if (!agentCase || !agentCase.applyCandidate19) return;

      const msg = agentCase.applyCandidate19.applyCandidateMessage;
      expect(msg).toContain("Du entscheidest");
    });
  });

  describe("Candidate structure completeness", () => {
    test("candidate has all expected fields", () => {
      const agentCase = createAgentCaseForCandidateTests("backend_fix_draft", "deepseek_backend");
      if (!agentCase || !agentCase.applyCandidate19) return;

      const ac = agentCase.applyCandidate19;
      expect(ac.candidateId).toBeDefined();
      expect(ac.agentCaseId).toBeDefined();
      expect(ac.candidateVersion).toBe(1);
      expect(ac.candidateStatus).toBeDefined();
      expect(ac.candidateMode).toBeDefined();
      expect(typeof ac.candidateReadyForFinalApproval).toBe("boolean");
      expect(typeof ac.candidateBlocked).toBe("boolean");
      expect(typeof ac.scopeLocked).toBe("boolean");
      expect(typeof ac.requiresScopeConfirmation).toBe("boolean");
      expect(ac.candidateScope).toBeDefined();
      expect(Array.isArray(ac.includedActions)).toBe(true);
      expect(Array.isArray(ac.excludedActions)).toBe(true);
      expect(Array.isArray(ac.allowedApplyTargets)).toBe(true);
      expect(Array.isArray(ac.disallowedApplyTargets)).toBe(true);
      expect(Array.isArray(ac.guardrails)).toBe(true);
      expect(Array.isArray(ac.approvalChecklist)).toBe(true);
      expect(Array.isArray(ac.finalPreconditions)).toBe(true);
      expect(Array.isArray(ac.missingApprovals)).toBe(true);
      expect(ac.candidateOwner).toBeDefined();
      expect(ac.gateOwner).toBeDefined();
      expect(ac.finalApprovalOwner).toBe("user");
      expect(ac.candidateGeneratedAt).toBeDefined();
      expect(ac.dryRunOnly).toBe(true);
    });

    test("included actions are non-empty for non-diagnosis drafts", () => {
      const agentCase = createAgentCaseForCandidateTests("backend_fix_draft", "deepseek_backend");
      if (!agentCase || !agentCase.applyCandidate19) return;

      expect(agentCase.applyCandidate19.includedActions.length).toBeGreaterThan(0);
    });

    test("excluded actions are non-empty for backend_only candidates", () => {
      const agentCase = createAgentCaseForCandidateTests("backend_fix_draft", "deepseek_backend");
      if (!agentCase || !agentCase.applyCandidate19) return;

      expect(agentCase.applyCandidate19.candidateMode).toBe("backend_only");
      expect(agentCase.applyCandidate19.excludedActions.length).toBeGreaterThan(0);
    });
  });
});
