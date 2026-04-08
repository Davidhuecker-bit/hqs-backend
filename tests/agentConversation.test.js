"use strict";

/**
 * Step 21 – Agent Conversation Runtime / Persistent Case Chat /
 * Freeform Admin Dialogue
 *
 * Tests cover:
 *  - Conversation thread creation and retrieval
 *  - Free-form user message handling
 *  - Agent routing (DeepSeek vs Gemini)
 *  - Message intent derivation
 *  - Thread state management
 *  - Reply / follow-up linking
 *  - Cross-agent coordination
 *  - Conversation summary
 *  - Input validation
 *  - Constants exported correctly
 */

const {
  sendUserMessage,
  getConversationThread,
  getConversationSummary,
  getOrCreateConversationThread,
  VALID_THREAD_STATUSES,
  VALID_SPEAKER_AGENTS,
  VALID_SPEAKER_ROLES,
  VALID_CONVERSATION_INTENTS,
  VALID_CONVERSATION_PHASES,
} = require("../services/agentBridge.service");

/* ─────────────────────────────────────────────
   Constants
   ───────────────────────────────────────────── */

describe("Step 21 – Constants", () => {
  test("VALID_THREAD_STATUSES has expected entries", () => {
    expect(Array.isArray(VALID_THREAD_STATUSES)).toBe(true);
    expect(VALID_THREAD_STATUSES.length).toBe(8);
    expect(VALID_THREAD_STATUSES).toContain("thread_open");
    expect(VALID_THREAD_STATUSES).toContain("thread_waiting_for_user");
    expect(VALID_THREAD_STATUSES).toContain("thread_waiting_for_agent");
    expect(VALID_THREAD_STATUSES).toContain("thread_blocked");
    expect(VALID_THREAD_STATUSES).toContain("thread_in_refinement");
    expect(VALID_THREAD_STATUSES).toContain("thread_ready_for_decision");
    expect(VALID_THREAD_STATUSES).toContain("thread_runtime_pending");
    expect(VALID_THREAD_STATUSES).toContain("thread_closed");
  });

  test("VALID_SPEAKER_AGENTS includes user/deepseek/gemini/system", () => {
    expect(VALID_SPEAKER_AGENTS).toContain("user");
    expect(VALID_SPEAKER_AGENTS).toContain("deepseek");
    expect(VALID_SPEAKER_AGENTS).toContain("gemini");
    expect(VALID_SPEAKER_AGENTS).toContain("system");
  });

  test("VALID_SPEAKER_ROLES includes expected roles", () => {
    expect(VALID_SPEAKER_ROLES).toContain("admin");
    expect(VALID_SPEAKER_ROLES).toContain("backend_agent");
    expect(VALID_SPEAKER_ROLES).toContain("frontend_agent");
    expect(VALID_SPEAKER_ROLES).toContain("coordinator");
  });

  test("VALID_CONVERSATION_INTENTS has expected entries", () => {
    expect(VALID_CONVERSATION_INTENTS).toContain("question");
    expect(VALID_CONVERSATION_INTENTS).toContain("clarification");
    expect(VALID_CONVERSATION_INTENTS).toContain("scope_change");
    expect(VALID_CONVERSATION_INTENTS).toContain("freeform");
    expect(VALID_CONVERSATION_INTENTS).toContain("handoff");
  });

  test("VALID_CONVERSATION_PHASES includes conversation_phase", () => {
    expect(VALID_CONVERSATION_PHASES).toContain("conversation_phase");
    expect(VALID_CONVERSATION_PHASES).toContain("problem_phase");
    expect(VALID_CONVERSATION_PHASES).toContain("runtime_execution_phase");
  });
});

/* ─────────────────────────────────────────────
   Thread creation
   ───────────────────────────────────────────── */

describe("Step 21 – Thread creation", () => {
  test("getOrCreateConversationThread creates a new thread", () => {
    const thread = getOrCreateConversationThread("test-conv-create-1");
    expect(thread).toBeTruthy();
    expect(thread.threadId).toBe("test-conv-create-1");
    expect(thread.threadStatus).toBe("thread_open");
    expect(thread.conversationOpen).toBe(true);
    expect(thread.conversationMessages).toEqual([]);
    expect(thread.messageCount).toBe(0);
  });

  test("getOrCreateConversationThread returns existing thread", () => {
    const t1 = getOrCreateConversationThread("test-conv-create-2");
    const t2 = getOrCreateConversationThread("test-conv-create-2");
    expect(t1).toBe(t2);
  });

  test("getConversationThread returns null for unknown thread", () => {
    const thread = getConversationThread({ agentCaseId: "nonexistent-thread-xyz" });
    expect(thread).toBeNull();
  });
});

/* ─────────────────────────────────────────────
   User message handling
   ───────────────────────────────────────────── */

describe("Step 21 – sendUserMessage", () => {
  test("accepts a free-form user message and returns agent reply", async () => {
    const result = await sendUserMessage({
      agentCaseId: "test-conv-msg-1",
      userMessage: "Warum ist das noch blockiert?",
    });
    expect(result.success).toBe(true);
    expect(result.threadId).toBe("test-conv-msg-1");
    expect(result.userMessage).toBeTruthy();
    expect(result.userMessage.messageRole).toBe("user");
    expect(result.userMessage.speakerAgent).toBe("user");
    expect(result.userMessage.speakerRole).toBe("admin");
    expect(result.agentReply).toBeTruthy();
    expect(result.agentReply.messageRole).toBe("agent");
    expect(result.agentReply.content).toBeTruthy();
    expect(typeof result.agentReply.content).toBe("string");
    expect(result.messageCount).toBe(2);
  });

  test("rejects missing agentCaseId", async () => {
    const result = await sendUserMessage({ userMessage: "test" });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test("rejects empty userMessage", async () => {
    const result = await sendUserMessage({ agentCaseId: "test-conv-msg-2", userMessage: "" });
    expect(result.success).toBe(false);
  });

  test("rejects missing userMessage", async () => {
    const result = await sendUserMessage({ agentCaseId: "test-conv-msg-3" });
    expect(result.success).toBe(false);
  });

  test("user message has correct message structure", async () => {
    const result = await sendUserMessage({
      agentCaseId: "test-conv-msg-struct",
      userMessage: "Bitte prüfe die Ursache tiefer.",
    });
    const msg = result.userMessage;
    expect(msg.messageId).toBeTruthy();
    expect(msg.threadId).toBe("test-conv-msg-struct");
    expect(msg.caseId).toBe("test-conv-msg-struct");
    expect(msg.messagePhase).toBeTruthy();
    expect(msg.content).toBe("Bitte prüfe die Ursache tiefer.");
    expect(msg.createdAt).toBeTruthy();
  });

  test("agent reply has correct message structure", async () => {
    const result = await sendUserMessage({
      agentCaseId: "test-conv-msg-reply",
      userMessage: "Erkläre mir das genauer.",
    });
    const reply = result.agentReply;
    expect(reply.messageId).toBeTruthy();
    expect(reply.messageRole).toBe("agent");
    expect(reply.speakerAgent).toBeTruthy();
    expect(reply.speakerRole).toBeTruthy();
    expect(reply.replyToMessageId).toBe(result.userMessage.messageId);
    expect(reply.followUpOf).toBe(result.userMessage.messageId);
    expect(reply.content).toBeTruthy();
  });
});

/* ─────────────────────────────────────────────
   Agent routing
   ───────────────────────────────────────────── */

describe("Step 21 – Agent routing", () => {
  test("routes backend-related messages to DeepSeek", async () => {
    const result = await sendUserMessage({
      agentCaseId: "test-conv-route-backend",
      userMessage: "Die API gibt falsche Daten zurück, prüfe den Backend-Datenfluss.",
    });
    expect(result.routing.speakerAgent).toBe("deepseek");
    expect(result.routing.speakerRole).toBe("backend_agent");
  });

  test("routes frontend-related messages to Gemini", async () => {
    const result = await sendUserMessage({
      agentCaseId: "test-conv-route-frontend",
      userMessage: "Das UI-Layout ist kaputt und die Beschriftung fehlt.",
    });
    expect(result.routing.speakerAgent).toBe("gemini");
    expect(result.routing.speakerRole).toBe("frontend_agent");
  });

  test("routes ambiguous messages to DeepSeek by default", async () => {
    const result = await sendUserMessage({
      agentCaseId: "test-conv-route-default",
      userMessage: "Ich habe eine allgemeine Frage zum System.",
    });
    expect(result.routing.speakerAgent).toBe("deepseek");
  });

  test("routing reason is provided", async () => {
    const result = await sendUserMessage({
      agentCaseId: "test-conv-route-reason",
      userMessage: "Das Frontend-Design stimmt nicht.",
    });
    expect(result.routing.routingReason).toBeTruthy();
    expect(typeof result.routing.routingReason).toBe("string");
  });
});

/* ─────────────────────────────────────────────
   Message intent derivation
   ───────────────────────────────────────────── */

describe("Step 21 – Message intent", () => {
  test("derives question intent", async () => {
    const result = await sendUserMessage({
      agentCaseId: "test-conv-intent-q",
      userMessage: "Warum ist der Prozess blockiert?",
    });
    expect(result.userMessage.messageIntent).toBe("question");
  });

  test("derives scope_change intent", async () => {
    const result = await sendUserMessage({
      agentCaseId: "test-conv-intent-scope",
      userMessage: "Nur Backend, Frontend raus.",
    });
    expect(result.userMessage.messageIntent).toBe("scope_change");
  });

  test("derives clarification intent", async () => {
    const result = await sendUserMessage({
      agentCaseId: "test-conv-intent-clar",
      userMessage: "Erkläre mir das bitte genauer.",
    });
    expect(result.userMessage.messageIntent).toBe("clarification");
  });

  test("derives diagnosis_request intent", async () => {
    const result = await sendUserMessage({
      agentCaseId: "test-conv-intent-diag",
      userMessage: "Prüfe die Ursache bitte tiefer.",
    });
    expect(result.userMessage.messageIntent).toBe("diagnosis_request");
  });

  test("derives freeform intent for generic messages", async () => {
    const result = await sendUserMessage({
      agentCaseId: "test-conv-intent-free",
      userMessage: "Alles klar, machen wir so.",
    });
    expect(result.userMessage.messageIntent).toBe("freeform");
  });
});

/* ─────────────────────────────────────────────
   Thread state management
   ───────────────────────────────────────────── */

describe("Step 21 – Thread state", () => {
  test("thread awaits user reply after agent response", async () => {
    const result = await sendUserMessage({
      agentCaseId: "test-conv-state-1",
      userMessage: "Was ist der aktuelle Stand?",
    });
    expect(result.awaitingUserReply).toBe(true);
    expect(result.awaitingAgentReply).toBeFalsy();
    expect(result.threadStatus).toBe("thread_waiting_for_user");
  });

  test("thread tracks last speaker", async () => {
    const result = await sendUserMessage({
      agentCaseId: "test-conv-state-2",
      userMessage: "Wie sieht der API-Status aus?",
    });
    expect(result.lastSpeaker).toBe("deepseek");
  });

  test("thread suggests next speaker", async () => {
    const result = await sendUserMessage({
      agentCaseId: "test-conv-state-3",
      userMessage: "Ich habe noch eine Frage.",
    });
    expect(result.nextSuggestedSpeaker).toBe("user");
  });
});

/* ─────────────────────────────────────────────
   Reply / follow-up linking
   ───────────────────────────────────────────── */

describe("Step 21 – Reply linking", () => {
  test("agent reply references user message via replyToMessageId", async () => {
    const result = await sendUserMessage({
      agentCaseId: "test-conv-link-1",
      userMessage: "Bitte genauer erklären.",
    });
    expect(result.agentReply.replyToMessageId).toBe(result.userMessage.messageId);
  });

  test("follow-up messages reference previous message", async () => {
    await sendUserMessage({ agentCaseId: "test-conv-link-2", userMessage: "Erste Nachricht." });
    const r2 = await sendUserMessage({ agentCaseId: "test-conv-link-2", userMessage: "Zweite Nachricht." });
    // The second user message's followUpOf should reference the previous message (agent reply)
    expect(r2.userMessage.followUpOf).toBeTruthy();
  });

  test("replyToMessageId can be set explicitly", async () => {
    const r1 = await sendUserMessage({ agentCaseId: "test-conv-link-3", userMessage: "Nachricht eins." });
    const r2 = await sendUserMessage({
      agentCaseId: "test-conv-link-3",
      userMessage: "Antwort auf die erste.",
      replyToMessageId: r1.userMessage.messageId,
    });
    expect(r2.userMessage.replyToMessageId).toBe(r1.userMessage.messageId);
  });
});

/* ─────────────────────────────────────────────
   Thread retrieval
   ───────────────────────────────────────────── */

describe("Step 21 – getConversationThread", () => {
  test("returns thread with messages", async () => {
    await sendUserMessage({ agentCaseId: "test-conv-get-1", userMessage: "Hallo." });
    const thread = getConversationThread({ agentCaseId: "test-conv-get-1" });
    expect(thread).toBeTruthy();
    expect(thread.threadId).toBe("test-conv-get-1");
    expect(thread.messages.length).toBeGreaterThanOrEqual(2);
    expect(thread.threadStatus).toBeTruthy();
    expect(thread.conversationState).toBeTruthy();
    expect(thread.conversationSummary).toBeTruthy();
  });

  test("respects limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await sendUserMessage({ agentCaseId: "test-conv-get-limit", userMessage: `Nachricht ${i}` });
    }
    const thread = getConversationThread({ agentCaseId: "test-conv-get-limit", limit: 3 });
    expect(thread.messages.length).toBe(3);
  });

  test("returns null for nonexistent thread", () => {
    expect(getConversationThread({ agentCaseId: "nonexistent-xyz-999" })).toBeNull();
  });
});

/* ─────────────────────────────────────────────
   Conversation summary
   ───────────────────────────────────────────── */

describe("Step 21 – getConversationSummary", () => {
  test("returns summary with expected fields", () => {
    const summary = getConversationSummary();
    expect(summary).toBeTruthy();
    expect(typeof summary.totalThreads).toBe("number");
    expect(typeof summary.totalOpen).toBe("number");
    expect(typeof summary.totalWaitingForUser).toBe("number");
    expect(typeof summary.totalWaitingForAgent).toBe("number");
    expect(typeof summary.totalMessages).toBe("number");
    expect(summary.byThreadStatus).toBeTruthy();
    expect(summary.byDominantAgent).toBeTruthy();
    expect(summary.intentFrequency).toBeTruthy();
    expect(summary.generatedAt).toBeTruthy();
  });

  test("includes thread summaries", () => {
    const summary = getConversationSummary();
    expect(Array.isArray(summary.threadSummaries)).toBe(true);
    if (summary.threadSummaries.length > 0) {
      const ts = summary.threadSummaries[0];
      expect(ts.threadId).toBeTruthy();
      expect(ts.threadStatus).toBeTruthy();
      expect(typeof ts.messageCount).toBe("number");
    }
  });

  test("tracks DeepSeek vs Gemini domination", () => {
    const summary = getConversationSummary();
    expect(typeof summary.totalDeepseekDominated).toBe("number");
    expect(typeof summary.totalGeminiDominated).toBe("number");
    expect(typeof summary.totalCrossAgent).toBe("number");
  });
});

/* ─────────────────────────────────────────────
   Dialog quality
   ───────────────────────────────────────────── */

describe("Step 21 – Dialog quality", () => {
  test("agent replies are cooperative German text, not log-style", async () => {
    const result = await sendUserMessage({
      agentCaseId: "test-conv-quality-1",
      userMessage: "Was ist die Ursache für das Problem im Backend?",
    });
    const reply = result.agentReply.content;
    // Should be natural German text, not JSON or log
    expect(reply).not.toMatch(/^\{/);
    expect(reply).not.toMatch(/^\[/);
    expect(reply.length).toBeGreaterThan(20);
    // Should mention perspective
    expect(reply.toLowerCase()).toMatch(/sicht|fall|bereich|schwerpunkt|prüf|schau/);
  });

  test("agent replies differ based on intent", async () => {
    const r1 = await sendUserMessage({ agentCaseId: "test-conv-quality-q", userMessage: "Warum ist das so?" });
    const r2 = await sendUserMessage({ agentCaseId: "test-conv-quality-s", userMessage: "Nur Backend, Frontend raus." });
    // Different intents should produce different reply styles
    expect(r1.agentReply.content).not.toBe(r2.agentReply.content);
  });
});

/* ─────────────────────────────────────────────
   Conversation phases
   ───────────────────────────────────────────── */

describe("Step 21 – Conversation phase tracking", () => {
  test("messages carry messagePhase", async () => {
    const result = await sendUserMessage({
      agentCaseId: "test-conv-phase-1",
      userMessage: "Wie ist der aktuelle Stand?",
    });
    expect(result.userMessage.messagePhase).toBeTruthy();
    expect(VALID_CONVERSATION_PHASES).toContain(result.userMessage.messagePhase);
  });

  test("conversationState is set on thread", async () => {
    const result = await sendUserMessage({
      agentCaseId: "test-conv-phase-2",
      userMessage: "Prüfe die Diagnose.",
    });
    expect(result.conversationState).toBeTruthy();
  });
});
