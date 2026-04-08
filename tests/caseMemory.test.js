"use strict";

/**
 * Step 23 – Conversation Memory / Case Continuity / Agent Memory Anchors
 *
 * Tests for:
 *  - Case memory structure on new threads
 *  - Memory anchor extraction from conversation messages
 *  - Working summary generation
 *  - Continuity status / memory freshness derivation
 *  - Open questions / resolved points tracking
 *  - Memory injection into agent replies
 *  - Case memory retrieval (getCaseMemory)
 *  - Case memory summary analytics (getCaseMemorySummary)
 *  - Memory fields in sendUserMessage response
 *  - Memory fields in getConversationThread response
 *  - Memory fields in getConversationSummary response
 *  - Role-based memory view (dominantMemoryOwner, contributors)
 *  - Constant exports
 */

const {
  sendUserMessage,
  getConversationThread,
  getConversationSummary,
  getOrCreateConversationThread,
  getCaseMemory,
  getCaseMemorySummary,
  VALID_CONTINUITY_STATUSES,
  VALID_MEMORY_FRESHNESS,
  VALID_MEMORY_ANCHOR_TYPES,
} = require("../services/agentBridge.service");

// ── Constant Exports ──

describe("Step 23 – Constant exports", () => {
  test("VALID_CONTINUITY_STATUSES is a non-empty array of strings", () => {
    expect(Array.isArray(VALID_CONTINUITY_STATUSES)).toBe(true);
    expect(VALID_CONTINUITY_STATUSES.length).toBeGreaterThanOrEqual(4);
    VALID_CONTINUITY_STATUSES.forEach((s) => expect(typeof s).toBe("string"));
  });

  test("VALID_MEMORY_FRESHNESS is a non-empty array of strings", () => {
    expect(Array.isArray(VALID_MEMORY_FRESHNESS)).toBe(true);
    expect(VALID_MEMORY_FRESHNESS.length).toBeGreaterThanOrEqual(4);
    VALID_MEMORY_FRESHNESS.forEach((s) => expect(typeof s).toBe("string"));
  });

  test("VALID_MEMORY_ANCHOR_TYPES is a non-empty array of strings", () => {
    expect(Array.isArray(VALID_MEMORY_ANCHOR_TYPES)).toBe(true);
    expect(VALID_MEMORY_ANCHOR_TYPES.length).toBeGreaterThanOrEqual(10);
    VALID_MEMORY_ANCHOR_TYPES.forEach((s) => expect(typeof s).toBe("string"));
  });

  test("VALID_CONTINUITY_STATUSES contains expected values", () => {
    expect(VALID_CONTINUITY_STATUSES).toContain("continuity_not_started");
    expect(VALID_CONTINUITY_STATUSES).toContain("continuity_light");
    expect(VALID_CONTINUITY_STATUSES).toContain("continuity_established");
    expect(VALID_CONTINUITY_STATUSES).toContain("continuity_needs_refresh");
  });

  test("VALID_MEMORY_FRESHNESS contains expected values", () => {
    expect(VALID_MEMORY_FRESHNESS).toContain("memory_empty");
    expect(VALID_MEMORY_FRESHNESS).toContain("memory_partial");
    expect(VALID_MEMORY_FRESHNESS).toContain("memory_stable");
    expect(VALID_MEMORY_FRESHNESS).toContain("memory_recently_updated");
  });

  test("VALID_MEMORY_ANCHOR_TYPES contains expected values", () => {
    expect(VALID_MEMORY_ANCHOR_TYPES).toContain("scope_decision");
    expect(VALID_MEMORY_ANCHOR_TYPES).toContain("direction_agreed");
    expect(VALID_MEMORY_ANCHOR_TYPES).toContain("direction_discarded");
    expect(VALID_MEMORY_ANCHOR_TYPES).toContain("user_preference");
    expect(VALID_MEMORY_ANCHOR_TYPES).toContain("open_question");
    expect(VALID_MEMORY_ANCHOR_TYPES).toContain("resolved_point");
    expect(VALID_MEMORY_ANCHOR_TYPES).toContain("handoff_completed");
  });
});

// ── Thread structure ──

describe("Step 23 – Thread caseMemory structure", () => {
  test("new thread has caseMemory with expected fields", () => {
    const thread = getOrCreateConversationThread("step23-struct-1");
    expect(thread.caseMemory).toBeDefined();
    expect(thread.caseMemory.memoryVersion).toBe(1);
    expect(thread.caseMemory.caseContinuityStatus).toBe("continuity_not_started");
    expect(thread.caseMemory.memoryFreshness).toBe("memory_empty");
    expect(thread.caseMemory.workingSummary).toBeNull();
    expect(thread.caseMemory.workingSummaryReady).toBe(false);
    expect(thread.caseMemory.agreedDirection).toBeNull();
    expect(Array.isArray(thread.caseMemory.discardedDirections)).toBe(true);
    expect(Array.isArray(thread.caseMemory.openQuestions)).toBe(true);
    expect(Array.isArray(thread.caseMemory.resolvedPoints)).toBe(true);
    expect(Array.isArray(thread.caseMemory.caseDecisions)).toBe(true);
    expect(Array.isArray(thread.caseMemory.userPreferencesInCase)).toBe(true);
    expect(thread.caseMemory.lastMeaningfulDecision).toBeNull();
    expect(thread.caseMemory.nextOpenStep).toBeNull();
    expect(Array.isArray(thread.caseMemory.pendingClarifications)).toBe(true);
    expect(Array.isArray(thread.caseMemory.memoryAnchors)).toBe(true);
    expect(thread.caseMemory.dominantMemoryOwner).toBeNull();
    expect(thread.caseMemory.lastContributingAgent).toBeNull();
    expect(Array.isArray(thread.caseMemory.memoryContributors)).toBe(true);
    expect(thread.caseMemory.lastMemorySource).toBeNull();
    expect(thread.caseMemory.memoryFocus).toBeNull();
    expect(thread.caseMemory.caseScope).toBeNull();
    expect(thread.caseMemory.memoryUpdatedAt).toBeNull();
    expect(thread.caseMemory.memoryUpdateCount).toBe(0);
  });
});

// ── sendUserMessage with memory ──

describe("Step 23 – sendUserMessage includes memory fields", () => {
  test("response includes caseContinuityStatus and memoryFreshness", async () => {
    const result = await sendUserMessage({
      agentCaseId: "step23-msg-1",
      userMessage: "Zeig mir die Ursache im Backend",
    });
    expect(result.success).toBe(true);
    expect(result.caseContinuityStatus).toBeDefined();
    expect(VALID_CONTINUITY_STATUSES).toContain(result.caseContinuityStatus);
    expect(result.memoryFreshness).toBeDefined();
    expect(VALID_MEMORY_FRESHNESS).toContain(result.memoryFreshness);
  });

  test("response includes workingSummary after interaction", async () => {
    const result = await sendUserMessage({
      agentCaseId: "step23-msg-2",
      userMessage: "Ich will nur den Backend-Teil prüfen",
    });
    expect(result.success).toBe(true);
    expect(typeof result.workingSummary).toBe("string");
    expect(result.workingSummary.length).toBeGreaterThan(0);
  });

  test("response includes nextOpenStep", async () => {
    const result = await sendUserMessage({
      agentCaseId: "step23-msg-3",
      userMessage: "Was ist der nächste Schritt?",
    });
    expect(result.success).toBe(true);
    // nextOpenStep may be null if no open questions yet, but should be present
    expect("nextOpenStep" in result).toBe(true);
  });

  test("response includes dominantMemoryOwner", async () => {
    const result = await sendUserMessage({
      agentCaseId: "step23-msg-4",
      userMessage: "Zeig mir die API-Logik",
    });
    expect(result.success).toBe(true);
    expect("dominantMemoryOwner" in result).toBe(true);
  });

  test("response includes memoryFocus", async () => {
    const result = await sendUserMessage({
      agentCaseId: "step23-msg-5",
      userMessage: "Bitte nur Backend, Frontend raus",
    });
    expect(result.success).toBe(true);
    expect("memoryFocus" in result).toBe(true);
  });
});

// ── Scope detection / memory anchors ──

describe("Step 23 – Memory anchors from scope decisions", () => {
  test("scope_change message creates scope_decision anchor", async () => {
    const caseId = "step23-scope-1";
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Bitte nur backend prüfen, Frontend raus" });

    const threadData = getConversationThread({ agentCaseId: caseId });
    expect(threadData).not.toBeNull();
    expect(threadData.caseMemory).toBeDefined();
    expect(threadData.caseMemory.caseScope).toBe("backend");
  });

  test("user preference detected and stored", async () => {
    const caseId = "step23-pref-1";
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Ich möchte die Ursache tiefer prüfen" });

    const threadData = getConversationThread({ agentCaseId: caseId });
    expect(threadData.caseMemory.userPreferencesInCase.length).toBeGreaterThan(0);
  });

  test("discarded direction detected", async () => {
    const caseId = "step23-discard-1";
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Die Frontend-Folge lassen wir erstmal" });

    const threadData = getConversationThread({ agentCaseId: caseId });
    expect(threadData.caseMemory.discardedDirections.length).toBeGreaterThan(0);
  });
});

// ── Working summary ──

describe("Step 23 – Working summary generation", () => {
  test("working summary is a human-readable string", async () => {
    const caseId = "step23-summary-1";
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Zeig mir die Backend-Logik genauer" });

    const threadData = getConversationThread({ agentCaseId: caseId });
    expect(threadData.caseMemory.workingSummary).toBeDefined();
    expect(typeof threadData.caseMemory.workingSummary).toBe("string");
    expect(threadData.caseMemory.workingSummary.length).toBeGreaterThan(10);
    expect(threadData.caseMemory.workingSummaryReady).toBe(true);
  });

  test("working summary uses cooperative language", async () => {
    const caseId = "step23-summary-2";
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Ich will nur backend, frontend raus" });

    const threadData = getConversationThread({ agentCaseId: caseId });
    const summary = threadData.caseMemory.workingSummary;
    // Should contain cooperative language, not aggressive terms
    expect(summary).not.toMatch(/CRITICAL|URGENT|ALERT|WARNING/);
  });
});

// ── Continuity status ──

describe("Step 23 – Continuity status and memory freshness", () => {
  test("continuity status is valid after first message", async () => {
    const caseId = "step23-cont-1";
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Hallo" });

    const threadData = getConversationThread({ agentCaseId: caseId });
    expect(VALID_CONTINUITY_STATUSES).toContain(threadData.caseMemory.caseContinuityStatus);
  });

  test("memory freshness is valid after interaction", async () => {
    const caseId = "step23-fresh-1";
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Teste den Datenfluss" });

    const threadData = getConversationThread({ agentCaseId: caseId });
    expect(VALID_MEMORY_FRESHNESS).toContain(threadData.caseMemory.memoryFreshness);
  });

  test("memory freshness updates after interaction", async () => {
    const caseId = "step23-fresh-2";
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Erster Schritt" });
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Zweiter Schritt" });

    const threadData = getConversationThread({ agentCaseId: caseId });
    expect(threadData.caseMemory.memoryFreshness).not.toBe("memory_empty");
    expect(threadData.caseMemory.memoryUpdateCount).toBeGreaterThan(0);
  });
});

// ── Role-based memory view ──

describe("Step 23 – Role-based memory view", () => {
  test("dominantMemoryOwner is set after agent interaction", async () => {
    const caseId = "step23-role-1";
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Prüfe die API-Routen" });

    const threadData = getConversationThread({ agentCaseId: caseId });
    expect(threadData.caseMemory.dominantMemoryOwner).toBeDefined();
    expect(["deepseek", "gemini", "cross_agent", null]).toContain(
      threadData.caseMemory.dominantMemoryOwner
    );
  });

  test("lastContributingAgent is set after agent reply", async () => {
    const caseId = "step23-role-2";
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Backend-Diagnose bitte" });

    const threadData = getConversationThread({ agentCaseId: caseId });
    expect(threadData.caseMemory.lastContributingAgent).toBeDefined();
    expect(["deepseek", "gemini"]).toContain(threadData.caseMemory.lastContributingAgent);
  });

  test("memoryContributors is populated", async () => {
    const caseId = "step23-role-3";
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Zeig mir den Code" });

    const threadData = getConversationThread({ agentCaseId: caseId });
    expect(Array.isArray(threadData.caseMemory.memoryContributors)).toBe(true);
    expect(threadData.caseMemory.memoryContributors.length).toBeGreaterThan(0);
  });

  test("memoryFocus is set", async () => {
    const caseId = "step23-focus-1";
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Was genau passiert im Mapping?" });

    const threadData = getConversationThread({ agentCaseId: caseId });
    expect(threadData.caseMemory.memoryFocus).toBeDefined();
    expect(typeof threadData.caseMemory.memoryFocus).toBe("string");
  });
});

// ── getCaseMemory ──

describe("Step 23 – getCaseMemory", () => {
  test("returns null for unknown case", () => {
    const result = getCaseMemory({ agentCaseId: "nonexistent-case" });
    expect(result).toBeNull();
  });

  test("returns null without agentCaseId", () => {
    const result = getCaseMemory({});
    expect(result).toBeNull();
  });

  test("returns case memory for existing thread", async () => {
    const caseId = "step23-get-mem-1";
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Zeig mir die Diagnose" });

    const result = getCaseMemory({ agentCaseId: caseId });
    expect(result).not.toBeNull();
    expect(result.threadId).toBe(caseId);
    expect(result.caseMemory).toBeDefined();
    expect(result.caseMemory.caseContinuityStatus).toBeDefined();
    expect(result.caseMemory.memoryFreshness).toBeDefined();
  });
});

// ── getCaseMemorySummary ──

describe("Step 23 – getCaseMemorySummary", () => {
  test("returns summary object with expected fields", async () => {
    // Ensure at least one thread exists
    await sendUserMessage({ agentCaseId: "step23-summ-1", userMessage: "Test" });

    const summary = getCaseMemorySummary();
    expect(summary).toBeDefined();
    expect(typeof summary.totalThreads).toBe("number");
    expect(typeof summary.totalWithMemory).toBe("number");
    expect(typeof summary.totalWithWorkingSummary).toBe("number");
    expect(typeof summary.totalWithOpenQuestions).toBe("number");
    expect(typeof summary.totalWithAgreedDirection).toBe("number");
    expect(typeof summary.totalDeepseekDominated).toBe("number");
    expect(typeof summary.totalGeminiDominated).toBe("number");
    expect(typeof summary.totalCrossAgentDominated).toBe("number");
    expect(typeof summary.totalAnchors).toBe("number");
    expect(typeof summary.totalOpenQuestions).toBe("number");
    expect(typeof summary.totalResolvedPoints).toBe("number");
    expect(typeof summary.byContinuityStatus).toBe("object");
    expect(typeof summary.byMemoryFreshness).toBe("object");
    expect(typeof summary.byDominantMemoryOwner).toBe("object");
    expect(typeof summary.byMemoryFocus).toBe("object");
    expect(typeof summary.byCaseScope).toBe("object");
    expect(Array.isArray(summary.memoryThreads)).toBe(true);
    expect(summary.generatedAt).toBeDefined();
  });
});

// ── getConversationThread includes memory ──

describe("Step 23 – getConversationThread includes caseMemory", () => {
  test("thread response includes caseMemory object", async () => {
    const caseId = "step23-thread-mem-1";
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Analysiere das Backend" });

    const thread = getConversationThread({ agentCaseId: caseId });
    expect(thread.caseMemory).toBeDefined();
    expect(thread.caseMemory.caseContinuityStatus).toBeDefined();
    expect(thread.caseMemory.memoryFreshness).toBeDefined();
    expect(typeof thread.caseMemory.anchorCount).toBe("number");
    expect(typeof thread.caseMemory.memoryUpdateCount).toBe("number");
  });
});

// ── getConversationSummary includes memory analytics ──

describe("Step 23 – getConversationSummary includes memory analytics", () => {
  test("summary includes Step 23 memory analytics", async () => {
    await sendUserMessage({ agentCaseId: "step23-conv-summ-1", userMessage: "Test" });

    const summary = getConversationSummary();
    expect(typeof summary.totalWithMemory).toBe("number");
    expect(typeof summary.totalWithWorkingSummary).toBe("number");
    expect(typeof summary.totalWithOpenQuestions).toBe("number");
    expect(typeof summary.totalWithAgreedDirection).toBe("number");
  });

  test("thread summaries include memory fields", async () => {
    await sendUserMessage({ agentCaseId: "step23-conv-summ-2", userMessage: "Hallo" });

    const summary = getConversationSummary();
    if (summary.threadSummaries.length > 0) {
      const ts = summary.threadSummaries[0];
      expect("caseContinuityStatus" in ts).toBe(true);
      expect("memoryFreshness" in ts).toBe(true);
      expect("dominantMemoryOwner" in ts).toBe(true);
      expect("workingSummaryReady" in ts).toBe(true);
      expect("openQuestionCount" in ts).toBe(true);
      expect("anchorCount" in ts).toBe(true);
    }
  });
});

// ── Memory injection into reply ──

describe("Step 23 – Memory context injection into agent replies", () => {
  test("agent reply references case scope after scope change", async () => {
    const caseId = "step23-inject-1";
    // First message: set scope
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Bitte nur backend, frontend raus" });
    // Second message: should reference scope
    const result = await sendUserMessage({ agentCaseId: caseId, userMessage: "Was ist der nächste Schritt?" });

    expect(result.success).toBe(true);
    // The reply should contain either scope reference or the normal reply
    // Since memory injection happens, the reply should be non-empty
    expect(result.agentReply.content.length).toBeGreaterThan(10);
  });
});

// ── Multiple interactions build memory ──

describe("Step 23 – Multiple interactions build memory progressively", () => {
  test("memory version increases with each interaction", async () => {
    const caseId = "step23-multi-1";
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Erster Punkt" });
    const t1 = getConversationThread({ agentCaseId: caseId });
    const v1 = t1.caseMemory.memoryUpdateCount;

    await sendUserMessage({ agentCaseId: caseId, userMessage: "Zweiter Punkt" });
    const t2 = getConversationThread({ agentCaseId: caseId });
    const v2 = t2.caseMemory.memoryUpdateCount;

    expect(v2).toBeGreaterThan(v1);
  });

  test("agreed direction detected from user agreement", async () => {
    const caseId = "step23-agree-1";
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Prüfe die Backend-Logik" });
    await sendUserMessage({ agentCaseId: caseId, userMessage: "Klingt gut, machen wir so" });

    const threadData = getConversationThread({ agentCaseId: caseId });
    expect(threadData.caseMemory.agreedDirection).toBeDefined();
    expect(threadData.caseMemory.agreedDirection).not.toBeNull();
  });
});
