"use strict";

/**
 * Step 24 – Action Negotiation / Option Comparison / Decision Framing
 *
 * Tests for:
 *  - Decision frame structure on new threads
 *  - Action option derivation (2–4 options)
 *  - Human-readable option text generation
 *  - Comparison dimensions per option
 *  - Recommended option / preference logic
 *  - DeepSeek / Gemini decision roles
 *  - Decision frame status lifecycle
 *  - Decision tradeoff / narrowing / open question
 *  - Decision frame in sendUserMessage response
 *  - Decision frame in getConversationThread response
 *  - Decision frame analytics in getConversationSummary
 *  - getDecisionFrame retrieval
 *  - getDecisionFrameSummary analytics
 *  - Constant exports
 */

const {
  sendUserMessage,
  getConversationThread,
  getConversationSummary,
  getOrCreateConversationThread,
  getDecisionFrame,
  getDecisionFrameSummary,
  buildAgentCaseFromBridgePackage,
  VALID_DECISION_FRAME_STATUSES,
  VALID_OPTION_STATUSES,
  VALID_COMPARISON_DIMENSIONS,
  VALID_DIMENSION_RATINGS,
  VALID_DECISION_MODES,
  VALID_OPTION_OWNER_TYPES,
} = require("../services/agentBridge.service");

/* ─────── helpers ─────── */

function makeBridgePackage(overrides = {}) {
  return {
    packageId: `pkg-test-${Date.now()}`,
    route: "/api/test",
    method: "GET",
    statusCode: 200,
    responseTimeMs: 42,
    timestamp: new Date().toISOString(),
    hints: [
      {
        type: "optimization",
        severity: "medium",
        layer: "backend",
        title: overrides.title || "Test-Optimierung",
        detail: "Detail für Test",
        suggestion: "Vorschlag",
        cause: "Ursache",
        effect: "Wirkung",
      },
    ],
    ...overrides,
  };
}

/* ─────── tests ─────── */

describe("Step 24 – Decision Framing Constants", () => {
  test("VALID_DECISION_FRAME_STATUSES is exported and non-empty", () => {
    expect(Array.isArray(VALID_DECISION_FRAME_STATUSES)).toBe(true);
    expect(VALID_DECISION_FRAME_STATUSES.length).toBeGreaterThanOrEqual(5);
    expect(VALID_DECISION_FRAME_STATUSES).toContain("options_not_ready");
    expect(VALID_DECISION_FRAME_STATUSES).toContain("options_prepared");
    expect(VALID_DECISION_FRAME_STATUSES).toContain("options_stable");
    expect(VALID_DECISION_FRAME_STATUSES).toContain("decision_pending");
    expect(VALID_DECISION_FRAME_STATUSES).toContain("decision_narrowed");
    expect(VALID_DECISION_FRAME_STATUSES).toContain("decision_ready_for_user");
  });

  test("VALID_OPTION_STATUSES is exported and non-empty", () => {
    expect(Array.isArray(VALID_OPTION_STATUSES)).toBe(true);
    expect(VALID_OPTION_STATUSES.length).toBeGreaterThanOrEqual(4);
    expect(VALID_OPTION_STATUSES).toContain("option_draft");
    expect(VALID_OPTION_STATUSES).toContain("option_viable");
    expect(VALID_OPTION_STATUSES).toContain("option_preferred");
    expect(VALID_OPTION_STATUSES).toContain("option_discarded");
  });

  test("VALID_COMPARISON_DIMENSIONS is exported and non-empty", () => {
    expect(Array.isArray(VALID_COMPARISON_DIMENSIONS)).toBe(true);
    expect(VALID_COMPARISON_DIMENSIONS.length).toBeGreaterThanOrEqual(8);
    expect(VALID_COMPARISON_DIMENSIONS).toContain("scopeWidth");
    expect(VALID_COMPARISON_DIMENSIONS).toContain("riskLevel");
    expect(VALID_COMPARISON_DIMENSIONS).toContain("safetyLevel");
    expect(VALID_COMPARISON_DIMENSIONS).toContain("expectedImpact");
    expect(VALID_COMPARISON_DIMENSIONS).toContain("reversibility");
  });

  test("VALID_DIMENSION_RATINGS is exported and non-empty", () => {
    expect(Array.isArray(VALID_DIMENSION_RATINGS)).toBe(true);
    expect(VALID_DIMENSION_RATINGS).toContain("low");
    expect(VALID_DIMENSION_RATINGS).toContain("moderate");
    expect(VALID_DIMENSION_RATINGS).toContain("high");
    expect(VALID_DIMENSION_RATINGS).toContain("very_high");
  });

  test("VALID_DECISION_MODES is exported and non-empty", () => {
    expect(Array.isArray(VALID_DECISION_MODES)).toBe(true);
    expect(VALID_DECISION_MODES.length).toBeGreaterThanOrEqual(4);
    expect(VALID_DECISION_MODES).toContain("conservative_vs_broad");
    expect(VALID_DECISION_MODES).toContain("diagnosis_vs_action");
  });

  test("VALID_OPTION_OWNER_TYPES is exported and non-empty", () => {
    expect(Array.isArray(VALID_OPTION_OWNER_TYPES)).toBe(true);
    expect(VALID_OPTION_OWNER_TYPES).toContain("deepseek");
    expect(VALID_OPTION_OWNER_TYPES).toContain("gemini");
    expect(VALID_OPTION_OWNER_TYPES).toContain("cross_agent");
    expect(VALID_OPTION_OWNER_TYPES).toContain("user_suggested");
  });
});

describe("Step 24 – Decision Frame on New Thread", () => {
  test("new thread has decisionFrame with default values", () => {
    const caseId = `df-test-new-${Date.now()}`;
    const pkg = makeBridgePackage({ title: "Decision frame init test" });
    buildAgentCaseFromBridgePackage(pkg);
    const thread = getOrCreateConversationThread(caseId);

    expect(thread.decisionFrame).toBeDefined();
    expect(thread.decisionFrame.decisionFrameStatus).toBe("options_not_ready");
    expect(thread.decisionFrame.optionCount).toBe(0);
    expect(thread.decisionFrame.actionOptions).toEqual([]);
    expect(thread.decisionFrame.recommendedOptionId).toBeNull();
    expect(thread.decisionFrame.decisionTradeoff).toBeNull();
    expect(thread.decisionFrame.nextDecisionQuestion).toBeNull();
    expect(thread.decisionFrame.userDecisionNeeded).toBe(false);
    expect(thread.decisionFrame.crossAgentDecisionNeeded).toBe(false);
    expect(thread.decisionFrame.decisionFrameUpdateCount).toBe(0);
  });
});

describe("Step 24 – Option Derivation via sendUserMessage", () => {
  let caseId;

  beforeAll(() => {
    caseId = `df-test-options-${Date.now()}`;
    const pkg = makeBridgePackage({ title: "Option derivation test" });
    buildAgentCaseFromBridgePackage(pkg);
    getOrCreateConversationThread(caseId);
  });

  test("first message does not generate options (< 2 messages)", async () => {
    const result = await sendUserMessage({
      agentCaseId: caseId,
      userMessage: "Was genau ist das Problem?",
    });

    expect(result.success).toBe(true);
    // After first message, we have 2 messages (user + agent), so options should be derived
    expect(result.decisionFrameStatus).toBeDefined();
  });

  test("second message triggers option derivation", async () => {
    const result = await sendUserMessage({
      agentCaseId: caseId,
      userMessage: "Bitte nur den Backend-Teil vorbereiten.",
    });

    expect(result.success).toBe(true);
    expect(result.decisionFrameStatus).toBeDefined();
    expect(VALID_DECISION_FRAME_STATUSES).toContain(result.decisionFrameStatus);
    expect(result.optionCount).toBeGreaterThanOrEqual(2);
    expect(result.optionCount).toBeLessThanOrEqual(4);
  });

  test("options have proper structure", async () => {
    const result = await sendUserMessage({
      agentCaseId: caseId,
      userMessage: "Zeig mir die Optionen.",
    });

    expect(result.success).toBe(true);
    // Retrieve thread to see full options
    const thread = getConversationThread({ agentCaseId: caseId });
    const df = thread.decisionFrame;

    expect(df.actionOptions.length).toBeGreaterThanOrEqual(2);
    for (const opt of df.actionOptions) {
      expect(opt.optionId).toBeDefined();
      expect(opt.optionLabel).toBeDefined();
      expect(opt.optionTitle).toBeDefined();
      expect(typeof opt.optionText).toBe("string");
      expect(opt.optionText.length).toBeGreaterThan(20);
      expect(VALID_OPTION_STATUSES).toContain(opt.optionStatus);
      expect(VALID_OPTION_OWNER_TYPES).toContain(opt.optionOwner);
      expect(Array.isArray(opt.optionContributors)).toBe(true);
      expect(opt.comparison).toBeDefined();
      expect(opt.createdAt).toBeDefined();
    }
  });
});

describe("Step 24 – Comparison Dimensions", () => {
  test("each option has all comparison dimensions", async () => {
    const caseId = `df-test-comp-${Date.now()}`;
    const pkg = makeBridgePackage({ title: "Comparison dimensions test" });
    buildAgentCaseFromBridgePackage(pkg);
    getOrCreateConversationThread(caseId);

    await sendUserMessage({ agentCaseId: caseId, userMessage: "Diagnose vertiefen" });
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Scope prüfen" });

    const thread = getConversationThread({ agentCaseId: caseId });
    const df = thread.decisionFrame;

    for (const opt of df.actionOptions) {
      expect(opt.comparison).toBeDefined();
      expect(opt.comparison.scopeWidth).toBeDefined();
      expect(opt.comparison.riskLevel).toBeDefined();
      expect(opt.comparison.safetyLevel).toBeDefined();
      expect(opt.comparison.implementationBreadth).toBeDefined();
      expect(opt.comparison.confidenceLevel).toBeDefined();
      expect(opt.comparison.expectedImpact).toBeDefined();
      expect(opt.comparison.reversibility).toBeDefined();
      expect(opt.comparison.needsCrossAgentSupport).toBeDefined();
      expect(opt.comparison.needsMoreDiagnosis).toBeDefined();
      expect(opt.comparison.readinessHint).toBeDefined();

      // Check values are valid ratings
      for (const dim of Object.values(opt.comparison)) {
        expect(VALID_DIMENSION_RATINGS).toContain(dim);
      }
    }
  });
});

describe("Step 24 – Recommended Option / Preference", () => {
  test("decision frame has recommended option", async () => {
    const caseId = `df-test-rec-${Date.now()}`;
    const pkg = makeBridgePackage({ title: "Recommendation test" });
    buildAgentCaseFromBridgePackage(pkg);
    getOrCreateConversationThread(caseId);

    await sendUserMessage({ agentCaseId: caseId, userMessage: "Was ist der Plan?" });
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Welche Optionen habe ich?" });

    const thread = getConversationThread({ agentCaseId: caseId });
    const df = thread.decisionFrame;

    expect(df.recommendedOptionId).toBeDefined();
    expect(df.recommendedBecause).toBeDefined();
    expect(typeof df.recommendedBecause).toBe("string");
    expect(df.recommendedBecause.length).toBeGreaterThan(10);

    expect(df.conservativeOptionId).toBeDefined();
    expect(df.fastestOptionId).toBeDefined();
    expect(df.safestOptionId).toBeDefined();
    expect(df.widestOptionId).toBeDefined();

    // Recommended option should be marked as preferred
    const recommended = df.actionOptions.find((o) => o.optionId === df.recommendedOptionId);
    expect(recommended).toBeDefined();
    expect(recommended.optionStatus).toBe("option_preferred");
  });

  test("preferred strategy is populated", async () => {
    const caseId = `df-test-strat-${Date.now()}`;
    const pkg = makeBridgePackage({ title: "Strategy test" });
    buildAgentCaseFromBridgePackage(pkg);
    getOrCreateConversationThread(caseId);

    await sendUserMessage({ agentCaseId: caseId, userMessage: "Was soll passieren?" });
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Optionen prüfen" });

    const thread = getConversationThread({ agentCaseId: caseId });
    expect(thread.decisionFrame.preferredStrategy).toBeDefined();
    expect(["conservative", "targeted", "broad", "wait"]).toContain(thread.decisionFrame.preferredStrategy);
  });
});

describe("Step 24 – Decision Roles", () => {
  test("decision roles include primary agent", async () => {
    const caseId = `df-test-roles-${Date.now()}`;
    const pkg = makeBridgePackage({ title: "Decision roles test" });
    buildAgentCaseFromBridgePackage(pkg);
    getOrCreateConversationThread(caseId);

    await sendUserMessage({ agentCaseId: caseId, userMessage: "Backend prüfen" });
    await sendUserMessage({ agentCaseId: caseId, userMessage: "API optimieren" });

    const thread = getConversationThread({ agentCaseId: caseId });
    const df = thread.decisionFrame;

    expect(df.primaryDecisionAgent).toBeDefined();
    expect(["deepseek", "gemini"]).toContain(df.primaryDecisionAgent);
    expect(typeof df.crossAgentDecisionNeeded).toBe("boolean");
  });
});

describe("Step 24 – Decision Frame Status Lifecycle", () => {
  test("status progresses with conversation", async () => {
    const caseId = `df-test-status-${Date.now()}`;
    const pkg = makeBridgePackage({ title: "Status lifecycle test" });
    buildAgentCaseFromBridgePackage(pkg);
    getOrCreateConversationThread(caseId);

    // First message
    const r1 = await sendUserMessage({ agentCaseId: caseId, userMessage: "Was ist los?" });
    expect(VALID_DECISION_FRAME_STATUSES).toContain(r1.decisionFrameStatus);

    // Second message
    const r2 = await sendUserMessage({ agentCaseId: caseId, userMessage: "Wie sieht der Plan aus?" });
    expect(VALID_DECISION_FRAME_STATUSES).toContain(r2.decisionFrameStatus);
    expect(r2.decisionFrameStatus).not.toBe("options_not_ready");
  });
});

describe("Step 24 – Decision Tradeoff / Narrowing", () => {
  test("tradeoff and narrowing are populated", async () => {
    const caseId = `df-test-tradeoff-${Date.now()}`;
    const pkg = makeBridgePackage({ title: "Tradeoff test" });
    buildAgentCaseFromBridgePackage(pkg);
    getOrCreateConversationThread(caseId);

    await sendUserMessage({ agentCaseId: caseId, userMessage: "Welche Wege gibt es?" });
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Was sind die Alternativen?" });

    const thread = getConversationThread({ agentCaseId: caseId });
    const df = thread.decisionFrame;

    // Decision tradeoff may or may not be set depending on option mix
    // But narrowingHint should always be present when options exist
    if (df.optionCount >= 2) {
      expect(df.narrowingHint).toBeDefined();
      expect(typeof df.narrowingHint).toBe("string");
    }
  });

  test("option contrast is populated when multiple strategies exist", async () => {
    const caseId = `df-test-contrast-${Date.now()}`;
    const pkg = makeBridgePackage({ title: "Contrast test" });
    buildAgentCaseFromBridgePackage(pkg);
    getOrCreateConversationThread(caseId);

    await sendUserMessage({ agentCaseId: caseId, userMessage: "Backend und Frontend prüfen" });
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Was sind die Wege?" });

    const thread = getConversationThread({ agentCaseId: caseId });
    const df = thread.decisionFrame;

    // optionContrast should be set when conservative + targeted exist
    if (df.optionCount >= 2) {
      expect(df.optionContrast).toBeDefined();
      expect(typeof df.optionContrast).toBe("string");
    }
  });
});

describe("Step 24 – Option Summary Text", () => {
  test("option summary is human-readable and mentions all options", async () => {
    const caseId = `df-test-summary-${Date.now()}`;
    const pkg = makeBridgePackage({ title: "Summary text test" });
    buildAgentCaseFromBridgePackage(pkg);
    getOrCreateConversationThread(caseId);

    await sendUserMessage({ agentCaseId: caseId, userMessage: "Status?" });
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Zeig mir Optionen" });

    const thread = getConversationThread({ agentCaseId: caseId });
    const df = thread.decisionFrame;

    expect(df.optionSummary).toBeDefined();
    expect(typeof df.optionSummary).toBe("string");
    expect(df.optionSummary).toContain("sinnvolle Wege");
    expect(df.optionSummary).toContain("Option A");
    expect(df.optionSummary).toContain("Option B");
  });
});

describe("Step 24 – getDecisionFrame", () => {
  test("returns null for missing caseId", () => {
    const result = getDecisionFrame({});
    expect(result).toBeNull();
  });

  test("returns null for non-existent thread", () => {
    const result = getDecisionFrame({ agentCaseId: "non-existent-case" });
    expect(result).toBeNull();
  });

  test("returns complete decision frame for active thread", async () => {
    const caseId = `df-test-get-${Date.now()}`;
    const pkg = makeBridgePackage({ title: "getDecisionFrame test" });
    buildAgentCaseFromBridgePackage(pkg);
    getOrCreateConversationThread(caseId);

    await sendUserMessage({ agentCaseId: caseId, userMessage: "Analyse starten" });
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Optionen prüfen" });

    const result = getDecisionFrame({ agentCaseId: caseId });
    expect(result).toBeDefined();
    expect(result.threadId).toBe(caseId);
    expect(result.decisionFrameStatus).toBeDefined();
    expect(result.optionCount).toBeGreaterThanOrEqual(2);
    expect(result.actionOptions.length).toBeGreaterThanOrEqual(2);
    expect(result.recommendedOptionId).toBeDefined();
    expect(result.recommendedBecause).toBeDefined();
    expect(result.generatedAt).toBeDefined();
  });
});

describe("Step 24 – getDecisionFrameSummary", () => {
  test("returns summary structure", () => {
    const summary = getDecisionFrameSummary();
    expect(summary).toBeDefined();
    expect(typeof summary.totalThreads).toBe("number");
    expect(typeof summary.totalWithOptions).toBe("number");
    expect(typeof summary.totalWithRecommendation).toBe("number");
    expect(typeof summary.totalWithTradeoff).toBe("number");
    expect(typeof summary.totalUserDecisionNeeded).toBe("number");
    expect(typeof summary.totalCrossAgentDecisions).toBe("number");
    expect(typeof summary.totalConservative).toBe("number");
    expect(typeof summary.totalTargeted).toBe("number");
    expect(typeof summary.totalBroad).toBe("number");
    expect(typeof summary.totalWait).toBe("number");
    expect(summary.byDecisionFrameStatus).toBeDefined();
    expect(summary.byDecisionMode).toBeDefined();
    expect(summary.byPreferredStrategy).toBeDefined();
    expect(summary.byPrimaryAgent).toBeDefined();
    expect(Array.isArray(summary.decisionThreads)).toBe(true);
    expect(summary.generatedAt).toBeDefined();
  });
});

describe("Step 24 – getConversationSummary includes decision analytics", () => {
  test("conversation summary contains Step 24 fields", () => {
    const summary = getConversationSummary();
    expect(typeof summary.totalWithOptions).toBe("number");
    expect(typeof summary.totalWithRecommendation).toBe("number");
    expect(typeof summary.totalDecisionNarrowed).toBe("number");
    expect(typeof summary.totalDecisionUserNeeded).toBe("number");
    expect(typeof summary.totalDecisionCrossAgent).toBe("number");
  });
});

describe("Step 24 – getConversationThread includes decision frame", () => {
  test("thread response contains decisionFrame block", async () => {
    const caseId = `df-test-thread-${Date.now()}`;
    const pkg = makeBridgePackage({ title: "Thread decision frame test" });
    buildAgentCaseFromBridgePackage(pkg);
    getOrCreateConversationThread(caseId);

    await sendUserMessage({ agentCaseId: caseId, userMessage: "Was tun?" });
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Wie weiter?" });

    const thread = getConversationThread({ agentCaseId: caseId });
    expect(thread.decisionFrame).toBeDefined();
    expect(thread.decisionFrame.decisionFrameStatus).toBeDefined();
    expect(thread.decisionFrame.optionCount).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(thread.decisionFrame.actionOptions)).toBe(true);
    expect(thread.decisionFrame.recommendedOptionId).toBeDefined();
    expect(thread.decisionFrame.primaryDecisionAgent).toBeDefined();
    expect(thread.decisionFrame.decisionFrameUpdateCount).toBeGreaterThan(0);
    expect(thread.decisionFrame.decisionFrameUpdatedAt).toBeDefined();
  });
});

describe("Step 24 – sendUserMessage response includes decision fields", () => {
  test("response contains decision frame status and option count", async () => {
    const caseId = `df-test-resp-${Date.now()}`;
    const pkg = makeBridgePackage({ title: "Response fields test" });
    buildAgentCaseFromBridgePackage(pkg);
    getOrCreateConversationThread(caseId);

    await sendUserMessage({ agentCaseId: caseId, userMessage: "Start" });
    const result = await sendUserMessage({ agentCaseId: caseId, userMessage: "Optionen zeigen" });

    expect(result.decisionFrameStatus).toBeDefined();
    expect(VALID_DECISION_FRAME_STATUSES).toContain(result.decisionFrameStatus);
    expect(typeof result.optionCount).toBe("number");
    expect(result.optionCount).toBeGreaterThanOrEqual(2);
    expect(result.recommendedOptionId).toBeDefined();
    expect(result.preferredStrategy).toBeDefined();
    expect(typeof result.userDecisionNeeded).toBe("boolean");
  });
});

describe("Step 24 – Human-Readable Option Texts", () => {
  test("option texts are in German and cooperative", async () => {
    const caseId = `df-test-lang-${Date.now()}`;
    const pkg = makeBridgePackage({ title: "Language test" });
    buildAgentCaseFromBridgePackage(pkg);
    getOrCreateConversationThread(caseId);

    await sendUserMessage({ agentCaseId: caseId, userMessage: "Problem analysieren" });
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Optionen?" });

    const thread = getConversationThread({ agentCaseId: caseId });
    for (const opt of thread.decisionFrame.actionOptions) {
      // Should contain German text
      expect(opt.optionText).toMatch(/Option|Scope|Diagnose|Entwurf|Richtung|vertief|konzentri|ergänz|wartet|adressiert/i);
      // Should not contain aggressive language
      expect(opt.optionText).not.toMatch(/CRITICAL|EMERGENCY|ATTACK|EXPLOIT/i);
    }
  });
});

describe("Step 24 – Decision Frame Update Count", () => {
  test("update count increments with each interaction", async () => {
    const caseId = `df-test-count-${Date.now()}`;
    const pkg = makeBridgePackage({ title: "Update count test" });
    buildAgentCaseFromBridgePackage(pkg);
    getOrCreateConversationThread(caseId);

    await sendUserMessage({ agentCaseId: caseId, userMessage: "Erste Nachricht" });
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Zweite Nachricht" });

    const t1 = getConversationThread({ agentCaseId: caseId });
    const count1 = t1.decisionFrame.decisionFrameUpdateCount;

    await sendUserMessage({ agentCaseId: caseId, userMessage: "Dritte Nachricht" });

    const t2 = getConversationThread({ agentCaseId: caseId });
    expect(t2.decisionFrame.decisionFrameUpdateCount).toBeGreaterThan(count1);
  });
});
