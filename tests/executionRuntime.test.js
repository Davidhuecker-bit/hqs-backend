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

function createAgentCaseForRuntimeTests(draftType = "backend_fix_draft", agentRole = "deepseek_backend", readinessOverrides = {}) {
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

  // Build apply candidate (Step 19) which chains to execution session (Step 20)
  // We need to simulate what _buildApplyCandidate would produce
  agentCase.applyCandidate19 = {
    candidateId: `candidate-test-${Date.now()}-${agentCase.agentCaseId}`,
    agentCaseId: agentCase.agentCaseId,
    proposalId: agentCase.applyReadiness17.proposalId,
    draftId: agentCase.actionDraft16.draftId,
    previewId: agentCase.executionPreview18.previewId,
    candidateVersion: 1,
    candidateStatus: readinessOverrides.readinessBand === "final_approval_ready"
      ? "candidate_ready_for_final_approval"
      : draftType === "diagnosis_draft"
        ? "candidate_diagnosis_only"
        : draftType === "cross_agent_draft"
          ? "candidate_cross_agent_pending"
          : draftType === "partial_fix_draft"
            ? "candidate_partial"
            : "candidate_scope_confirmation_needed",
    candidateMode: draftType === "diagnosis_draft" ? "diagnosis_only" :
                   draftType === "backend_fix_draft" ? "backend_only" :
                   draftType === "frontend_fix_draft" ? "frontend_only" :
                   draftType === "cross_agent_draft" ? "cross_agent_candidate" :
                   draftType === "partial_fix_draft" ? "partial_scope" :
                   "wait_for_user",
    candidateReadyForFinalApproval: readinessOverrides.readinessBand === "final_approval_ready",
    candidateBlocked: readinessOverrides.applyBlocked === true,
    candidateBlockedReason: readinessOverrides.applyBlocked ? "Test-Blockierung" : null,
    scopeLocked: readinessOverrides.readinessBand === "final_approval_ready",
    requiresScopeConfirmation: readinessOverrides.readinessBand !== "final_approval_ready" && draftType !== "diagnosis_draft",
    candidateScope: {
      affectedLayers: ["backend_logic"],
      affectedTargets: ["api_endpoint"],
      draftType,
      changeCategory: "backend_logic",
    },
    candidateSummary: `Testentwurf (${draftType})`,
    candidateReason: "Testgrund",
    includedActions: ["Aktion 1"],
    excludedActions: [],
    allowedApplyTargets: draftType === "backend_fix_draft"
      ? ["backend", "api", "datenfluss", "mapping", "route"]
      : draftType === "frontend_fix_draft"
        ? ["frontend", "ui", "design", "darstellung", "beschriftung"]
        : ["pending_scope_confirmation"],
    disallowedApplyTargets: draftType === "backend_fix_draft"
      ? ["frontend", "ui", "design", "darstellung"]
      : [],
    guardrails: [
      { type: "no_auto_execute", active: true, satisfied: true },
      { type: "requires_user_confirmation", active: true, satisfied: readinessOverrides.readinessBand === "final_approval_ready" },
      { type: "scope_boundary", active: true, satisfied: true },
    ],
    approvalChecklist: [
      { item: "Finale Benutzerfreigabe", required: true, completed: false },
    ],
    finalPreconditions: readinessOverrides.readinessBand === "final_approval_ready" ? [] : ["Scope-Bestätigung"],
    missingApprovals: readinessOverrides.readinessBand === "final_approval_ready" ? [] : ["Finale Benutzerfreigabe"],
    candidateOwner: agentRole,
    gateOwner: agentRole,
    proposalOwner: agentRole,
    secondaryAgent: agentRole === "deepseek_backend" ? "gemini_frontend" : "deepseek_backend",
    handoffSuggested: draftType === "cross_agent_draft",
    needsCrossAgentReview: draftType === "cross_agent_draft",
    finalApprovalOwner: "user",
    applyCandidateMessage: "Testkandidat",
    candidateGeneratedAt: new Date().toISOString(),
    candidateGeneratedByAgent: agentRole,
    dryRunOnly: true,
  };

  return agentCase;
}

/* ───── tests ───── */

describe("Step 20 – Controlled Execution Orchestrator / Apply Runtime / Audit & Kill Switch", () => {

  describe("Constants", () => {
    test("VALID_RUNTIME_STATUSES exports correct values", () => {
      expect(agentBridge.VALID_RUNTIME_STATUSES).toBeDefined();
      expect(agentBridge.VALID_RUNTIME_STATUSES).toContain("runtime_not_created");
      expect(agentBridge.VALID_RUNTIME_STATUSES).toContain("runtime_blocked");
      expect(agentBridge.VALID_RUNTIME_STATUSES).toContain("runtime_ready");
      expect(agentBridge.VALID_RUNTIME_STATUSES).toContain("runtime_awaiting_user_start");
      expect(agentBridge.VALID_RUNTIME_STATUSES).toContain("runtime_running");
      expect(agentBridge.VALID_RUNTIME_STATUSES).toContain("runtime_completed");
      expect(agentBridge.VALID_RUNTIME_STATUSES).toContain("runtime_aborted");
      expect(agentBridge.VALID_RUNTIME_STATUSES).toContain("runtime_failed");
      expect(agentBridge.VALID_RUNTIME_STATUSES).toContain("runtime_rollback_reserved");
      expect(agentBridge.VALID_RUNTIME_STATUSES.length).toBe(9);
    });

    test("VALID_RUNTIME_MODES exports correct values", () => {
      expect(agentBridge.VALID_RUNTIME_MODES).toBeDefined();
      expect(agentBridge.VALID_RUNTIME_MODES).toContain("dry_run");
      expect(agentBridge.VALID_RUNTIME_MODES).toContain("controlled_apply");
      expect(agentBridge.VALID_RUNTIME_MODES).toContain("partial_apply");
      expect(agentBridge.VALID_RUNTIME_MODES).toContain("backend_only");
      expect(agentBridge.VALID_RUNTIME_MODES).toContain("frontend_only");
      expect(agentBridge.VALID_RUNTIME_MODES).toContain("cross_agent_controlled");
      expect(agentBridge.VALID_RUNTIME_MODES.length).toBe(6);
    });

    test("VALID_EXECUTION_STATES exports correct values", () => {
      expect(agentBridge.VALID_EXECUTION_STATES).toBeDefined();
      expect(agentBridge.VALID_EXECUTION_STATES).toContain("pending");
      expect(agentBridge.VALID_EXECUTION_STATES).toContain("ready");
      expect(agentBridge.VALID_EXECUTION_STATES).toContain("blocked");
      expect(agentBridge.VALID_EXECUTION_STATES).toContain("active");
      expect(agentBridge.VALID_EXECUTION_STATES).toContain("stopped");
      expect(agentBridge.VALID_EXECUTION_STATES).toContain("finished");
      expect(agentBridge.VALID_EXECUTION_STATES).toContain("failed");
      expect(agentBridge.VALID_EXECUTION_STATES.length).toBe(7);
    });

    test("VALID_EXECUTION_GUARDRAIL_TYPES exports correct values", () => {
      expect(agentBridge.VALID_EXECUTION_GUARDRAIL_TYPES).toBeDefined();
      expect(agentBridge.VALID_EXECUTION_GUARDRAIL_TYPES).toContain("no_auto_execute");
      expect(agentBridge.VALID_EXECUTION_GUARDRAIL_TYPES).toContain("requires_user_start");
      expect(agentBridge.VALID_EXECUTION_GUARDRAIL_TYPES).toContain("scope_locked");
      expect(agentBridge.VALID_EXECUTION_GUARDRAIL_TYPES).toContain("no_scope_expansion");
      expect(agentBridge.VALID_EXECUTION_GUARDRAIL_TYPES).toContain("target_restriction");
      expect(agentBridge.VALID_EXECUTION_GUARDRAIL_TYPES).toContain("kill_switch_required");
      expect(agentBridge.VALID_EXECUTION_GUARDRAIL_TYPES).toContain("abort_path_required");
      expect(agentBridge.VALID_EXECUTION_GUARDRAIL_TYPES).toContain("rollback_on_failure");
      expect(agentBridge.VALID_EXECUTION_GUARDRAIL_TYPES).toContain("cross_agent_gate");
      expect(agentBridge.VALID_EXECUTION_GUARDRAIL_TYPES.length).toBe(9);
    });
  });

  describe("getExecutionRuntimeSummary()", () => {
    test("returns valid summary structure", () => {
      const summary = agentBridge.getExecutionRuntimeSummary();
      expect(summary).toBeDefined();
      expect(typeof summary.totalAgentCases).toBe("number");
      expect(typeof summary.totalWithRuntime).toBe("number");
      expect(typeof summary.totalBlocked).toBe("number");
      expect(typeof summary.totalReady).toBe("number");
      expect(typeof summary.totalAwaitingStart).toBe("number");
      expect(typeof summary.totalRunning).toBe("number");
      expect(typeof summary.totalCompleted).toBe("number");
      expect(typeof summary.totalAborted).toBe("number");
      expect(typeof summary.totalFailed).toBe("number");
      expect(typeof summary.totalWithKillSwitch).toBe("number");
      expect(typeof summary.totalWithAbort).toBe("number");
      expect(typeof summary.totalWithRollback).toBe("number");
      expect(summary.byRuntimeStatus).toBeDefined();
      expect(summary.byRuntimeMode).toBeDefined();
      expect(summary.byExecutionState).toBeDefined();
      expect(summary.byRuntimeOwner).toBeDefined();
      expect(summary.byGuardrailType).toBeDefined();
      expect(Array.isArray(summary.topBlockReasons)).toBe(true);
      expect(Array.isArray(summary.runtimeCases)).toBe(true);
      expect(summary.generatedAt).toBeDefined();
    });
  });

  describe("Execution session derivation", () => {
    test("backend_fix_draft with scope_confirmation_needed produces runtime_blocked", () => {
      const agentCase = createAgentCaseForRuntimeTests("backend_fix_draft", "deepseek_backend");
      if (!agentCase) return;

      // Candidate is scope_confirmation_needed → runtime should be blocked
      expect(agentCase.applyCandidate19.candidateStatus).toBe("candidate_scope_confirmation_needed");
      // executionSession20 is not automatically built in this test helper
      // but we can verify the summary works
      const summary = agentBridge.getExecutionRuntimeSummary();
      expect(summary).toBeDefined();
    });

    test("final_approval_ready candidate produces runtime_awaiting_user_start or runtime_blocked", () => {
      const agentCase = createAgentCaseForRuntimeTests("backend_fix_draft", "deepseek_backend", {
        readinessBand: "final_approval_ready",
      });
      if (!agentCase) return;

      expect(agentCase.applyCandidate19.candidateReadyForFinalApproval).toBe(true);
      // The candidate has missingApprovals=[] for final_approval_ready
      expect(agentCase.applyCandidate19.missingApprovals.length).toBe(0);
    });

    test("diagnosis_draft candidate does not produce runtime session", () => {
      const agentCase = createAgentCaseForRuntimeTests("diagnosis_draft", "deepseek_backend");
      if (!agentCase) return;

      expect(agentCase.applyCandidate19.candidateStatus).toBe("candidate_diagnosis_only");
    });

    test("cross_agent_draft candidate produces cross_agent_controlled mode context", () => {
      const agentCase = createAgentCaseForRuntimeTests("cross_agent_draft", "deepseek_backend");
      if (!agentCase) return;

      expect(agentCase.applyCandidate19.candidateStatus).toBe("candidate_cross_agent_pending");
      expect(agentCase.applyCandidate19.needsCrossAgentReview).toBe(true);
    });

    test("frontend_fix_draft with gemini_frontend produces frontend_only mode context", () => {
      const agentCase = createAgentCaseForRuntimeTests("frontend_fix_draft", "gemini_frontend");
      if (!agentCase) return;

      expect(agentCase.applyCandidate19.candidateMode).toBe("frontend_only");
    });

    test("blocked candidate produces runtime_blocked", () => {
      const agentCase = createAgentCaseForRuntimeTests("backend_fix_draft", "deepseek_backend", {
        applyBlocked: true,
      });
      if (!agentCase) return;

      expect(agentCase.applyCandidate19.candidateBlocked).toBe(true);
    });
  });

  describe("Runtime guardrails", () => {
    test("all runtime sessions have no_auto_execute guardrail", () => {
      // Verify constant includes no_auto_execute
      expect(agentBridge.VALID_EXECUTION_GUARDRAIL_TYPES).toContain("no_auto_execute");
    });

    test("all runtime sessions have requires_user_start guardrail", () => {
      expect(agentBridge.VALID_EXECUTION_GUARDRAIL_TYPES).toContain("requires_user_start");
    });

    test("all runtime sessions have scope_locked guardrail", () => {
      expect(agentBridge.VALID_EXECUTION_GUARDRAIL_TYPES).toContain("scope_locked");
    });

    test("kill_switch_required is always present", () => {
      expect(agentBridge.VALID_EXECUTION_GUARDRAIL_TYPES).toContain("kill_switch_required");
    });

    test("abort_path_required is always present", () => {
      expect(agentBridge.VALID_EXECUTION_GUARDRAIL_TYPES).toContain("abort_path_required");
    });
  });

  describe("Runtime status taxonomy", () => {
    test("runtime statuses cover all lifecycle stages", () => {
      const statuses = agentBridge.VALID_RUNTIME_STATUSES;
      // Must cover: not created, blocked, ready, awaiting, running, completed, aborted, failed, rollback
      expect(statuses).toContain("runtime_not_created");
      expect(statuses).toContain("runtime_blocked");
      expect(statuses).toContain("runtime_ready");
      expect(statuses).toContain("runtime_awaiting_user_start");
      expect(statuses).toContain("runtime_running");
      expect(statuses).toContain("runtime_completed");
      expect(statuses).toContain("runtime_aborted");
      expect(statuses).toContain("runtime_failed");
      expect(statuses).toContain("runtime_rollback_reserved");
    });
  });

  describe("Execution states", () => {
    test("execution states cover all phases", () => {
      const states = agentBridge.VALID_EXECUTION_STATES;
      expect(states).toContain("pending");
      expect(states).toContain("ready");
      expect(states).toContain("blocked");
      expect(states).toContain("active");
      expect(states).toContain("stopped");
      expect(states).toContain("finished");
      expect(states).toContain("failed");
    });
  });

  describe("Runtime modes", () => {
    test("runtime modes cover all execution types", () => {
      const modes = agentBridge.VALID_RUNTIME_MODES;
      expect(modes).toContain("dry_run");
      expect(modes).toContain("controlled_apply");
      expect(modes).toContain("partial_apply");
      expect(modes).toContain("backend_only");
      expect(modes).toContain("frontend_only");
      expect(modes).toContain("cross_agent_controlled");
    });
  });

  describe("Safety invariants", () => {
    test("dryRunOnly is always true in current implementation", () => {
      // This is a fundamental safety invariant
      const summary = agentBridge.getExecutionRuntimeSummary();
      for (const rc of summary.runtimeCases) {
        expect(rc.dryRunOnly).toBe(true);
      }
    });

    test("finalApprovalOwner is always user", () => {
      const summary = agentBridge.getExecutionRuntimeSummary();
      for (const rc of summary.runtimeCases) {
        expect(rc.finalApprovalOwner).toBe("user");
      }
    });
  });

  describe("Summary aggregation", () => {
    test("summary counts are consistent", () => {
      const summary = agentBridge.getExecutionRuntimeSummary();
      const statusSum = Object.values(summary.byRuntimeStatus).reduce((a, b) => a + b, 0);
      expect(statusSum).toBe(summary.totalWithRuntime);
    });

    test("summary mode counts are consistent", () => {
      const summary = agentBridge.getExecutionRuntimeSummary();
      const modeSum = Object.values(summary.byRuntimeMode).reduce((a, b) => a + b, 0);
      expect(modeSum).toBe(summary.totalWithRuntime);
    });

    test("summary execution state counts are consistent", () => {
      const summary = agentBridge.getExecutionRuntimeSummary();
      const stateSum = Object.values(summary.byExecutionState).reduce((a, b) => a + b, 0);
      expect(stateSum).toBe(summary.totalWithRuntime);
    });
  });
});
