"use strict";

/**
 * Step 22: Multi-Agent Handoff / Cross-Agent Dialogue /
 * Coordinated Case Exchange Light – Tests
 *
 * Tests the controlled handoff between DeepSeek and Gemini
 * within the same case/thread.
 */

const {
  sendUserMessage,
  getConversationThread,
  getConversationSummary,
  getOrCreateConversationThread,
  triggerHandoff,
  getHandoffSummary,
  VALID_HANDOFF_STATUSES,
  VALID_CROSS_AGENT_STATES,
  VALID_HANDOFF_REASONS,
  VALID_HANDOFF_MESSAGE_TYPES,
  VALID_CONVERSATION_PHASES,
} = require("../services/agentBridge.service");

/* ────────────────────────────────────────────
   Helper: generate unique test IDs
   ──────────────────────────────────────────── */
let _testIdCounter = 0;
function testId(prefix = "step22") {
  _testIdCounter += 1;
  return `${prefix}-${Date.now()}-${_testIdCounter}`;
}

/* ────────────────────────────────────────────
   1. Constants
   ──────────────────────────────────────────── */

describe("Step 22 – Constants", () => {
  test("VALID_HANDOFF_STATUSES has expected values", () => {
    expect(VALID_HANDOFF_STATUSES).toContain("handoff_not_needed");
    expect(VALID_HANDOFF_STATUSES).toContain("handoff_suggested");
    expect(VALID_HANDOFF_STATUSES).toContain("handoff_pending");
    expect(VALID_HANDOFF_STATUSES).toContain("handoff_in_progress");
    expect(VALID_HANDOFF_STATUSES).toContain("handoff_completed");
    expect(VALID_HANDOFF_STATUSES.length).toBe(5);
  });

  test("VALID_CROSS_AGENT_STATES has expected values", () => {
    expect(VALID_CROSS_AGENT_STATES).toContain("single_agent");
    expect(VALID_CROSS_AGENT_STATES).toContain("cross_agent_review_needed");
    expect(VALID_CROSS_AGENT_STATES).toContain("cross_agent_waiting");
    expect(VALID_CROSS_AGENT_STATES).toContain("cross_agent_active");
    expect(VALID_CROSS_AGENT_STATES).toContain("cross_agent_completed");
    expect(VALID_CROSS_AGENT_STATES.length).toBe(5);
  });

  test("VALID_HANDOFF_REASONS has expected values", () => {
    expect(VALID_HANDOFF_REASONS).toContain("cross_layer_issue");
    expect(VALID_HANDOFF_REASONS).toContain("frontend_impact_detected");
    expect(VALID_HANDOFF_REASONS).toContain("backend_cause_detected");
    expect(VALID_HANDOFF_REASONS).toContain("user_requested");
    expect(VALID_HANDOFF_REASONS).toContain("complementary_expertise");
    expect(VALID_HANDOFF_REASONS.length).toBe(8);
  });

  test("VALID_HANDOFF_MESSAGE_TYPES has expected values", () => {
    expect(VALID_HANDOFF_MESSAGE_TYPES).toContain("handoff_initiation");
    expect(VALID_HANDOFF_MESSAGE_TYPES).toContain("supporting_agent_reply");
    expect(VALID_HANDOFF_MESSAGE_TYPES).toContain("handoff_completion");
    expect(VALID_HANDOFF_MESSAGE_TYPES).toContain("cross_agent_note");
    expect(VALID_HANDOFF_MESSAGE_TYPES.length).toBe(6);
  });

  test("VALID_CONVERSATION_PHASES includes cross_agent_handoff_phase", () => {
    expect(VALID_CONVERSATION_PHASES).toContain("cross_agent_handoff_phase");
  });
});

/* ────────────────────────────────────────────
   2. Thread initialization with handoff fields
   ──────────────────────────────────────────── */

describe("Step 22 – Thread Handoff Fields", () => {
  test("new thread has default handoff fields", () => {
    const id = testId("thread-init");
    const thread = getOrCreateConversationThread(id);

    expect(thread.handoffStatus).toBe("handoff_not_needed");
    expect(thread.crossAgentState).toBe("single_agent");
    expect(thread.handoffFrom).toBeNull();
    expect(thread.handoffTo).toBeNull();
    expect(thread.handoffReason).toBeNull();
    expect(thread.supportingAgent).toBeNull();
    expect(thread.handoffCount).toBe(0);
    expect(thread.lastHandoffAt).toBeNull();
    expect(thread.handoffHistory).toEqual([]);
  });

  test("getConversationThread returns handoff fields", () => {
    const id = testId("thread-get");
    getOrCreateConversationThread(id);

    // Send a message to populate the thread
    sendUserMessage({ agentCaseId: id, userMessage: "Hallo" });

    const thread = getConversationThread({ agentCaseId: id });
    expect(thread).toHaveProperty("handoffStatus");
    expect(thread).toHaveProperty("crossAgentState");
    expect(thread).toHaveProperty("handoffFrom");
    expect(thread).toHaveProperty("handoffTo");
    expect(thread).toHaveProperty("handoffReason");
    expect(thread).toHaveProperty("supportingAgent");
    expect(thread).toHaveProperty("handoffCount");
    expect(thread).toHaveProperty("lastHandoffAt");
  });
});

/* ────────────────────────────────────────────
   3. Automatic handoff detection via sendUserMessage
   ──────────────────────────────────────────── */

describe("Step 22 – Automatic Handoff Detection", () => {
  test("cross-layer message triggers handoff", () => {
    const id = testId("auto-cross");

    const result = sendUserMessage({
      agentCaseId: id,
      userMessage: "Das Problem betrifft frontend und backend zusammen, das Zusammenspiel ist gestört",
    });

    expect(result.success).toBe(true);
    expect(result.handoffTriggered).toBe(true);
    expect(result.handoffStatus).toBe("handoff_completed");
    expect(result.crossAgentState).toBe("cross_agent_completed");
    expect(result.handoffReason).toBeTruthy();
    expect(result.supportingAgentReply).toBeTruthy();
    expect(result.supportingAgentReply.messageType).toBe("supporting_agent_reply");
    expect(result.handoffCount).toBeGreaterThan(0);
  });

  test("simple backend question does not trigger handoff", () => {
    const id = testId("auto-simple");

    const result = sendUserMessage({
      agentCaseId: id,
      userMessage: "Wie funktioniert die API?",
    });

    expect(result.success).toBe(true);
    expect(result.handoffTriggered).toBe(false);
    expect(result.supportingAgentReply).toBeNull();
  });

  test("user-requested handoff triggers handoff", () => {
    const id = testId("auto-user-req");

    const result = sendUserMessage({
      agentCaseId: id,
      userMessage: "Bitte hole Gemini dazu, ich brauche eine zweite Meinung",
    });

    expect(result.success).toBe(true);
    expect(result.handoffTriggered).toBe(true);
    expect(result.handoffReason).toBe("user_requested");
    expect(result.supportingAgentReply).toBeTruthy();
  });

  test("message touching both domains triggers handoff", () => {
    const id = testId("auto-dual");

    const result = sendUserMessage({
      agentCaseId: id,
      userMessage: "Das API-Endpoint liefert Daten, aber die Anzeige im Frontend ist fehlerhaft, prüfe den Datenfluss und die Darstellung",
    });

    expect(result.success).toBe(true);
    expect(result.handoffTriggered).toBe(true);
    expect(result.supportingAgentReply).toBeTruthy();
  });

  test("handoff messages are recorded in thread", () => {
    const id = testId("auto-thread");

    sendUserMessage({
      agentCaseId: id,
      userMessage: "Bitte übergib an den anderen Agenten zur Ergänzung",
    });

    const thread = getConversationThread({
      agentCaseId: id,
      limit: 200,
    });

    // Should have: user msg + agent reply + handoff init + supporting reply + completion
    expect(thread.messageCount).toBeGreaterThanOrEqual(5);

    const handoffMsgs = thread.messages.filter(
      (m) => m.messageType === "handoff_initiation"
    );
    expect(handoffMsgs.length).toBeGreaterThanOrEqual(1);

    const supportMsgs = thread.messages.filter(
      (m) => m.messageType === "supporting_agent_reply"
    );
    expect(supportMsgs.length).toBeGreaterThanOrEqual(1);

    const completionMsgs = thread.messages.filter(
      (m) => m.messageType === "handoff_completion"
    );
    expect(completionMsgs.length).toBeGreaterThanOrEqual(1);
  });
});

/* ────────────────────────────────────────────
   4. Admin-triggered handoff via triggerHandoff
   ──────────────────────────────────────────── */

describe("Step 22 – triggerHandoff", () => {
  test("manually triggers a handoff", () => {
    const id = testId("trigger-manual");

    // First create a thread with a message
    sendUserMessage({
      agentCaseId: id,
      userMessage: "Bitte schau dir den Backend-Code an",
    });

    const result = triggerHandoff({
      agentCaseId: id,
      targetAgent: "gemini",
      reason: "cross_layer_issue",
    });

    expect(result.success).toBe(true);
    expect(result.handoffStatus).toBe("handoff_completed");
    expect(result.crossAgentState).toBe("cross_agent_completed");
    expect(result.handoffFrom).toBeTruthy();
    expect(result.handoffTo).toBe("gemini");
    expect(result.handoffReason).toBe("cross_layer_issue");
    expect(result.messagesAdded).toBe(3);
    expect(result.supportingAgentReply).toBeTruthy();
  });

  test("rejects missing agentCaseId", () => {
    const result = triggerHandoff({});
    expect(result.success).toBe(false);
    expect(result.error).toContain("agentCaseId");
  });

  test("rejects non-existent thread", () => {
    const result = triggerHandoff({
      agentCaseId: "non-existent-id-step22",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("No conversation thread");
  });

  test("rejects invalid handoff reason", () => {
    const id = testId("trigger-invalid");
    sendUserMessage({
      agentCaseId: id,
      userMessage: "Test Nachricht",
    });

    const result = triggerHandoff({
      agentCaseId: id,
      reason: "invalid_reason",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid handoff reason");
  });

  test("auto-derives target agent when not specified", () => {
    const id = testId("trigger-auto");
    sendUserMessage({
      agentCaseId: id,
      userMessage: "Einfacher Test",
    });

    const result = triggerHandoff({
      agentCaseId: id,
    });

    expect(result.success).toBe(true);
    expect(result.handoffTo).toBeTruthy();
    expect(["deepseek", "gemini"]).toContain(result.handoffTo);
  });
});

/* ────────────────────────────────────────────
   5. Handoff summary
   ──────────────────────────────────────────── */

describe("Step 22 – getHandoffSummary", () => {
  test("returns handoff analytics structure", () => {
    const summary = getHandoffSummary();

    expect(summary).toHaveProperty("totalThreads");
    expect(summary).toHaveProperty("totalWithHandoffs");
    expect(summary).toHaveProperty("totalHandoffs");
    expect(summary).toHaveProperty("totalDeepseekToGemini");
    expect(summary).toHaveProperty("totalGeminiToDeepseek");
    expect(summary).toHaveProperty("totalCrossAgentActive");
    expect(summary).toHaveProperty("totalSingleAgent");
    expect(summary).toHaveProperty("byHandoffStatus");
    expect(summary).toHaveProperty("byCrossAgentState");
    expect(summary).toHaveProperty("byHandoffDirection");
    expect(summary).toHaveProperty("byHandoffReason");
    expect(summary).toHaveProperty("topHandoffReasons");
    expect(summary).toHaveProperty("handoffThreads");
    expect(summary).toHaveProperty("generatedAt");
  });

  test("reflects triggered handoffs", () => {
    const id = testId("summary-reflect");
    sendUserMessage({
      agentCaseId: id,
      userMessage: "Frontend und Backend zusammen prüfen, das Zusammenspiel ist gestört",
    });

    const summary = getHandoffSummary();
    expect(summary.totalWithHandoffs).toBeGreaterThanOrEqual(1);
    expect(summary.totalHandoffs).toBeGreaterThanOrEqual(1);
    expect(summary.handoffThreads.length).toBeGreaterThanOrEqual(1);
  });
});

/* ────────────────────────────────────────────
   6. Conversation summary includes handoff analytics
   ──────────────────────────────────────────── */

describe("Step 22 – Conversation Summary Handoff Fields", () => {
  test("conversation summary includes handoff totals", () => {
    const summary = getConversationSummary();

    expect(summary).toHaveProperty("totalWithHandoffs");
    expect(summary).toHaveProperty("totalHandoffs");
    expect(typeof summary.totalWithHandoffs).toBe("number");
    expect(typeof summary.totalHandoffs).toBe("number");
  });

  test("thread summaries include handoff fields", () => {
    const id = testId("convsum-handoff");
    sendUserMessage({
      agentCaseId: id,
      userMessage: "Übergib an Gemini dazu, zweite Meinung nötig",
    });

    const summary = getConversationSummary();
    const threadSummary = summary.threadSummaries.find(
      (ts) => ts.threadId === id
    );

    expect(threadSummary).toBeTruthy();
    expect(threadSummary).toHaveProperty("handoffStatus");
    expect(threadSummary).toHaveProperty("crossAgentState");
    expect(threadSummary).toHaveProperty("handoffCount");
    expect(threadSummary).toHaveProperty("supportingAgent");
  });
});

/* ────────────────────────────────────────────
   7. Handoff messages are natural and cooperative
   ──────────────────────────────────────────── */

describe("Step 22 – Message Quality", () => {
  test("handoff messages are human-readable German", () => {
    const id = testId("msg-quality");

    const result = sendUserMessage({
      agentCaseId: id,
      userMessage: "Das Zusammenspiel von frontend und backend ist gestört, bitte schau beides an",
    });

    expect(result.handoffTriggered).toBe(true);
    expect(result.supportingAgentReply).toBeTruthy();

    const content = result.supportingAgentReply.content;
    expect(typeof content).toBe("string");
    expect(content.length).toBeGreaterThan(10);
    // Should not contain raw technical labels
    expect(content).not.toContain("HANDOFF_");
    expect(content).not.toContain("cross_agent_");
    expect(content).not.toContain("handoff_not_needed");
  });

  test("handoff initiation message references the other agent", () => {
    const id = testId("msg-ref");

    sendUserMessage({
      agentCaseId: id,
      userMessage: "Frontend und Backend zusammen prüfen, beide Seiten relevant",
    });

    const thread = getConversationThread({
      agentCaseId: id,
      limit: 200,
    });

    const handoffMsg = thread.messages.find(
      (m) => m.messageType === "handoff_initiation"
    );

    expect(handoffMsg).toBeTruthy();
    // Should reference the other agent by name
    const content = handoffMsg.content;
    const mentionsAgent =
      content.includes("DeepSeek") || content.includes("Gemini");
    expect(mentionsAgent).toBe(true);
  });

  test("completion message indicates return to normal", () => {
    const id = testId("msg-complete");

    sendUserMessage({
      agentCaseId: id,
      userMessage: "Bitte hole die zweite Meinung zur Ergänzung",
    });

    const thread = getConversationThread({
      agentCaseId: id,
      limit: 200,
    });

    const completionMsg = thread.messages.find(
      (m) => m.messageType === "handoff_completion"
    );

    expect(completionMsg).toBeTruthy();
    expect(completionMsg.content).toContain("abgeschlossen");
  });
});

/* ────────────────────────────────────────────
   8. Handoff history tracking
   ──────────────────────────────────────────── */

describe("Step 22 – Handoff History", () => {
  test("handoff history is recorded on the thread", () => {
    const id = testId("history-record");

    sendUserMessage({
      agentCaseId: id,
      userMessage: "Frontend und Backend prüfen, das Zusammenspiel klappt nicht",
    });

    const rawThread = getOrCreateConversationThread(id);
    expect(rawThread.handoffHistory.length).toBeGreaterThanOrEqual(1);

    const entry = rawThread.handoffHistory[0];
    expect(entry).toHaveProperty("handoffId");
    expect(entry).toHaveProperty("from");
    expect(entry).toHaveProperty("to");
    expect(entry).toHaveProperty("reason");
    expect(entry).toHaveProperty("initiatedAt");
    expect(entry).toHaveProperty("completedAt");
    expect(entry).toHaveProperty("handoffMessageId");
    expect(entry).toHaveProperty("supportingMessageId");
    expect(entry).toHaveProperty("completionMessageId");
  });

  test("multiple handoffs accumulate in history", () => {
    const id = testId("history-multi");

    // First handoff via message
    sendUserMessage({
      agentCaseId: id,
      userMessage: "Frontend und Backend Zusammenspiel prüfen, end-to-end",
    });

    // Second handoff via trigger
    triggerHandoff({
      agentCaseId: id,
      reason: "user_requested",
    });

    const rawThread = getOrCreateConversationThread(id);
    expect(rawThread.handoffHistory.length).toBeGreaterThanOrEqual(2);
    expect(rawThread.handoffCount).toBeGreaterThanOrEqual(2);
  });
});

/* ────────────────────────────────────────────
   9. Edge cases / validation
   ──────────────────────────────────────────── */

describe("Step 22 – Edge Cases", () => {
  test("sendUserMessage still works without handoff", () => {
    const id = testId("edge-no-handoff");

    const result = sendUserMessage({
      agentCaseId: id,
      userMessage: "Einfache Backend-Frage zur API",
    });

    expect(result.success).toBe(true);
    expect(result.handoffTriggered).toBe(false);
    expect(result.handoffStatus).toBe("handoff_not_needed");
    expect(result.crossAgentState).toBe("single_agent");
    expect(result.supportingAgentReply).toBeNull();
  });

  test("thread returns to normal after handoff", () => {
    const id = testId("edge-normal");

    // Trigger handoff
    sendUserMessage({
      agentCaseId: id,
      userMessage: "Frontend und Backend Zusammenspiel prüfen, beide Seiten relevant",
    });

    // Follow-up without handoff
    const result = sendUserMessage({
      agentCaseId: id,
      userMessage: "Danke, jetzt eine einfache API-Frage",
    });

    expect(result.success).toBe(true);
    // The thread should still function normally
    expect(result.agentReply).toBeTruthy();
    expect(result.agentReply.content).toBeTruthy();
  });

  test("sendUserMessage returns new handoff response fields", () => {
    const id = testId("edge-fields");

    const result = sendUserMessage({
      agentCaseId: id,
      userMessage: "Test Nachricht",
    });

    expect(result).toHaveProperty("handoffTriggered");
    expect(result).toHaveProperty("handoffStatus");
    expect(result).toHaveProperty("crossAgentState");
    expect(result).toHaveProperty("handoffReason");
    expect(result).toHaveProperty("handoffConfidence");
    expect(result).toHaveProperty("supportingAgent");
    expect(result).toHaveProperty("handoffCount");
    expect(result).toHaveProperty("supportingAgentReply");
  });
});
