/**
 * tests/conferenceBothMode.test.js
 *
 * Konferenz Step E – Companion Multi-Agent Both-Mode Backend:
 * Dual Reply Routing / Same-Thread Two-Agent Responses /
 * Explicit Both Opinion Flow
 *
 * Tests:
 *  - Both-Mode explicit targeting (targetAgent="both")
 *  - Two separate agent replies in same thread
 *  - Reply references: replyToMessageId / responseToMessageId / followsAgent / bothModeSequence
 *  - Cooperation type derivation
 *  - Conservative text-based both-mode detection
 *  - Pending state (additional_agent_pending → reply_cycle_complete)
 *  - No summary-instead-of-reply in Both-Mode
 *  - Session tracking fields (bothModeMessageCount, completedBothReplyCycles)
 *  - Admin summary Both-Mode metrics
 *  - Session/thread robustness (both replies in same session)
 *  - Exported constants
 */

"use strict";

const {
  openConferenceSession,
  sendConferenceMessage,
  getConferenceSession,
  getConferenceAdminSummary,
  VALID_CONFERENCE_TARGET_AGENTS,
  VALID_CONFERENCE_DIALOG_STATES,
  VALID_BOTH_MODE_COOPERATION_TYPES,
  VALID_BOTH_MODE_SEQUENCES,
  BOTH_MODE_DETECTION_PHRASES,
} = require("../services/agentBridge.service");

// ─── helpers ─────────────────────────────────────────────────────────────────

function newSession(overrides = {}) {
  return openConferenceSession({ conferenceMode: "work_chat", ...overrides });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("Konferenz Step E – Exported Constants", () => {
  test("VALID_BOTH_MODE_COOPERATION_TYPES contains expected values", () => {
    expect(Array.isArray(VALID_BOTH_MODE_COOPERATION_TYPES)).toBe(true);
    const expected = ["supplements", "aligns", "contrasts", "extends", "dissent_light", "common_line"];
    for (const v of expected) {
      expect(VALID_BOTH_MODE_COOPERATION_TYPES).toContain(v);
    }
  });

  test("VALID_BOTH_MODE_SEQUENCES contains primary and secondary", () => {
    expect(VALID_BOTH_MODE_SEQUENCES).toContain("primary");
    expect(VALID_BOTH_MODE_SEQUENCES).toContain("secondary");
  });

  test("BOTH_MODE_DETECTION_PHRASES is a non-empty array of strings", () => {
    expect(Array.isArray(BOTH_MODE_DETECTION_PHRASES)).toBe(true);
    expect(BOTH_MODE_DETECTION_PHRASES.length).toBeGreaterThan(0);
    for (const p of BOTH_MODE_DETECTION_PHRASES) {
      expect(typeof p).toBe("string");
    }
  });

  test("VALID_CONFERENCE_TARGET_AGENTS includes 'both' as first-class value", () => {
    expect(VALID_CONFERENCE_TARGET_AGENTS).toContain("both");
  });

  test("VALID_CONFERENCE_DIALOG_STATES includes additional_agent_pending", () => {
    expect(VALID_CONFERENCE_DIALOG_STATES).toContain("additional_agent_pending");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Konferenz Step E – Both-Mode Explicit Targeting", () => {
  test("targetAgent='both' routes to both agents", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Was meint ihr?",
      targetAgent: "both",
    });
    expect(result.success).toBe(true);
    expect(result.routing.targetAgent).toBe("both");
    expect(result.bothMode).toBe(true);
  });

  test("Both-mode returns exactly two agent replies", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Bitte beide antworten",
      targetAgent: "both",
    });
    expect(result.agentReplies).toHaveLength(2);
  });

  test("First reply is DeepSeek (primary)", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Beide bitte",
      targetAgent: "both",
    });
    const [first] = result.agentReplies;
    expect(first.speakerAgent).toBe("deepseek");
    expect(first.bothModeSequence).toBe("primary");
  });

  test("Second reply is Gemini (secondary)", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Beide bitte",
      targetAgent: "both",
    });
    const [, second] = result.agentReplies;
    expect(second.speakerAgent).toBe("gemini");
    expect(second.bothModeSequence).toBe("secondary");
  });

  test("Both replies have bothMode=true", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Beide bitte",
      targetAgent: "both",
    });
    for (const reply of result.agentReplies) {
      expect(reply.bothMode).toBe(true);
    }
  });

  test("Single-agent reply has bothMode=false", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Nur Backend bitte",
      targetAgent: "deepseek",
    });
    expect(result.agentReplies[0].bothMode).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Konferenz Step E – Reply References and Cooperation Type", () => {
  test("Both replies reference the same user message (replyToMessageId)", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Was denkt ihr?",
      targetAgent: "both",
    });
    const userMsgId = result.userMessage.messageId;
    const [ds, gm] = result.agentReplies;
    expect(ds.replyToMessageId).toBe(userMsgId);
    expect(gm.replyToMessageId).toBe(userMsgId);
  });

  test("responseToMessageId equals replyToMessageId for both replies", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Eure Meinungen bitte",
      targetAgent: "both",
    });
    const [ds, gm] = result.agentReplies;
    expect(ds.responseToMessageId).toBe(ds.replyToMessageId);
    expect(gm.responseToMessageId).toBe(gm.replyToMessageId);
  });

  test("Gemini's followUpOf references DeepSeek's messageId", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Beide bitte",
      targetAgent: "both",
    });
    const [ds, gm] = result.agentReplies;
    expect(gm.followUpOf).toBe(ds.messageId);
  });

  test("Gemini reply has followsAgent='deepseek'", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Beide bitte",
      targetAgent: "both",
    });
    const [, gm] = result.agentReplies;
    expect(gm.followsAgent).toBe("deepseek");
  });

  test("DeepSeek reply has followsAgent=null (is first)", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Beide bitte",
      targetAgent: "both",
    });
    const [ds] = result.agentReplies;
    expect(ds.followsAgent).toBeNull();
  });

  test("Gemini reply has a valid cooperationType", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Beide bitte",
      targetAgent: "both",
    });
    const [, gm] = result.agentReplies;
    expect(gm.cooperationType).not.toBeNull();
    expect(VALID_BOTH_MODE_COOPERATION_TYPES).toContain(gm.cooperationType);
  });

  test("DeepSeek reply has cooperationType=null (is primary)", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Beide bitte",
      targetAgent: "both",
    });
    const [ds] = result.agentReplies;
    expect(ds.cooperationType).toBeNull();
  });

  test("Primary reply has openSecondReply=true", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Beide bitte",
      targetAgent: "both",
    });
    const [ds] = result.agentReplies;
    expect(ds.openSecondReply).toBe(true);
  });

  test("Secondary reply has openSecondReply=false", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Beide bitte",
      targetAgent: "both",
    });
    const [, gm] = result.agentReplies;
    expect(gm.openSecondReply).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Konferenz Step E – Text-based Both-Mode Detection", () => {
  test("'beide meinungen' triggers both-mode routing without explicit targetAgent", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Ich möchte beide meinungen hören",
    });
    expect(result.routing.targetAgent).toBe("both");
    expect(result.agentReplies).toHaveLength(2);
  });

  test("'deepseek und gemini' triggers both-mode routing", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "DeepSeek und Gemini, was meint ihr dazu?",
    });
    expect(result.routing.targetAgent).toBe("both");
    expect(result.agentReplies).toHaveLength(2);
  });

  test("'beide antworten' triggers both-mode routing", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Ich hätte gern beide antworten",
    });
    expect(result.routing.targetAgent).toBe("both");
  });

  test("'beide perspektiven' triggers both-mode routing", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Zeigt mir beide perspektiven",
    });
    expect(result.routing.targetAgent).toBe("both");
  });

  test("Explicit targetAgent='deepseek' takes priority over text detection", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "DeepSeek und Gemini, was meint ihr?",
      targetAgent: "deepseek",
    });
    // Explicit param wins: only deepseek
    expect(result.routing.targetAgent).toBe("deepseek");
    expect(result.agentReplies).toHaveLength(1);
    expect(result.agentReplies[0].speakerAgent).toBe("deepseek");
  });

  test("Neutral message without both-phrase does not trigger both-mode by default", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Wie läuft die API an?",
      targetAgent: "deepseek",
    });
    expect(result.routing.targetAgent).toBe("deepseek");
    expect(result.agentReplies).toHaveLength(1);
  });

  test("Text-based detection routing reason mentions textuelle Erkennung", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Bitte beide meinungen",
    });
    expect(result.routing.routingReason).toMatch(/textuelle erkennung|Textuelle Erkennung/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Konferenz Step E – Dialog State Lifecycle in Both-Mode", () => {
  test("Dialog state is reply_cycle_complete after both replies", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Beide bitte",
      targetAgent: "both",
    });
    expect(result.dialogState).toBe("reply_cycle_complete");
  });

  test("Both-mode user message has bothMode=true", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Beide bitte",
      targetAgent: "both",
    });
    expect(result.userMessage.bothMode).toBe(true);
  });

  test("Single-agent user message has bothMode=false", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Backend nur",
      targetAgent: "deepseek",
    });
    expect(result.userMessage.bothMode).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Konferenz Step E – No Summary Replacement in Both-Mode", () => {
  test("Both-mode returns two message objects, not a merged single reply", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Beide bitte",
      targetAgent: "both",
    });
    expect(result.agentReplies).toHaveLength(2);
    const [ds, gm] = result.agentReplies;
    // Each must be its own message object with distinct IDs
    expect(ds.messageId).not.toBe(gm.messageId);
    expect(ds.speakerAgent).not.toBe(gm.speakerAgent);
  });

  test("Both replies have individual content strings (not merged)", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Beide bitte",
      targetAgent: "both",
    });
    const [ds, gm] = result.agentReplies;
    expect(typeof ds.content).toBe("string");
    expect(typeof gm.content).toBe("string");
    expect(ds.content.length).toBeGreaterThan(0);
    expect(gm.content.length).toBeGreaterThan(0);
  });

  test("Both replies are stored as separate messages in session", async () => {
    const { conferenceId } = newSession();
    await sendConferenceMessage({
      conferenceId,
      userMessage: "Beide bitte",
      targetAgent: "both",
    });
    const session = getConferenceSession({ conferenceId });
    const agentMessages = session.messages.filter((m) => m.messageRole === "agent");
    expect(agentMessages).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Konferenz Step E – Session Tracking and Metrics", () => {
  test("bothModeMessageCount increments on each both-mode message", async () => {
    const { conferenceId } = newSession();
    await sendConferenceMessage({ conferenceId, userMessage: "Beide", targetAgent: "both" });
    await sendConferenceMessage({ conferenceId, userMessage: "Nochmal beide", targetAgent: "both" });
    const result = await sendConferenceMessage({ conferenceId, userMessage: "Und nochmal", targetAgent: "both" });
    expect(result.bothModeMessageCount).toBe(3);
  });

  test("completedBothReplyCycles increments when both replies are delivered", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Beide bitte",
      targetAgent: "both",
    });
    expect(result.completedBothReplyCycles).toBe(1);
  });

  test("Single-agent message does not increment bothModeMessageCount", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Nur DeepSeek",
      targetAgent: "deepseek",
    });
    expect(result.bothModeMessageCount).toBe(0);
  });

  test("lastReplyAgents contains both agents after both-mode reply", async () => {
    const { conferenceId } = newSession();
    await sendConferenceMessage({ conferenceId, userMessage: "Beide", targetAgent: "both" });
    const session = getConferenceSession({ conferenceId });
    expect(session.lastReplyAgents).toEqual(expect.arrayContaining(["deepseek", "gemini"]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Konferenz Step E – Admin Summary Both-Mode Metrics", () => {
  beforeEach(() => {
    // Ensure at least one session with both-mode activity
  });

  test("getConferenceAdminSummary includes totalBothModeMessages", async () => {
    const { conferenceId } = newSession();
    await sendConferenceMessage({ conferenceId, userMessage: "Beide", targetAgent: "both" });
    const summary = getConferenceAdminSummary();
    expect(typeof summary.totalBothModeMessages).toBe("number");
    expect(summary.totalBothModeMessages).toBeGreaterThanOrEqual(1);
  });

  test("getConferenceAdminSummary includes totalCompletedBothReplyCycles", async () => {
    const { conferenceId } = newSession();
    await sendConferenceMessage({ conferenceId, userMessage: "Beide", targetAgent: "both" });
    const summary = getConferenceAdminSummary();
    expect(typeof summary.totalCompletedBothReplyCycles).toBe("number");
    expect(summary.totalCompletedBothReplyCycles).toBeGreaterThanOrEqual(1);
  });

  test("getConferenceAdminSummary includes totalPartialBothReplyCycles (default 0)", () => {
    const summary = getConferenceAdminSummary();
    expect(typeof summary.totalPartialBothReplyCycles).toBe("number");
  });

  test("getConferenceAdminSummary includes totalDeepseekOnlyMessages", async () => {
    const { conferenceId } = newSession();
    await sendConferenceMessage({ conferenceId, userMessage: "Nur DeepSeek", targetAgent: "deepseek" });
    const summary = getConferenceAdminSummary();
    expect(typeof summary.totalDeepseekOnlyMessages).toBe("number");
    expect(summary.totalDeepseekOnlyMessages).toBeGreaterThanOrEqual(1);
  });

  test("getConferenceAdminSummary includes totalGeminiOnlyMessages", async () => {
    const { conferenceId } = newSession();
    await sendConferenceMessage({ conferenceId, userMessage: "Nur Gemini", targetAgent: "gemini" });
    const summary = getConferenceAdminSummary();
    expect(typeof summary.totalGeminiOnlyMessages).toBe("number");
    expect(summary.totalGeminiOnlyMessages).toBeGreaterThanOrEqual(1);
  });

  test("getConferenceAdminSummary includes byCooperationType object", async () => {
    const { conferenceId } = newSession();
    await sendConferenceMessage({ conferenceId, userMessage: "Beide", targetAgent: "both" });
    const summary = getConferenceAdminSummary();
    expect(typeof summary.byCooperationType).toBe("object");
    // At least one cooperation type should be tracked
    const keys = Object.keys(summary.byCooperationType);
    expect(keys.length).toBeGreaterThan(0);
  });

  test("byCooperationType values are all in VALID_BOTH_MODE_COOPERATION_TYPES", async () => {
    const { conferenceId } = newSession();
    await sendConferenceMessage({ conferenceId, userMessage: "Beide", targetAgent: "both" });
    const summary = getConferenceAdminSummary();
    for (const key of Object.keys(summary.byCooperationType)) {
      expect(VALID_BOTH_MODE_COOPERATION_TYPES).toContain(key);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Konferenz Step E – Session Thread Robustness", () => {
  test("Both replies land in the same session, not a different one", async () => {
    const { conferenceId: cid1 } = newSession();
    const { conferenceId: cid2 } = newSession();
    await sendConferenceMessage({ conferenceId: cid1, userMessage: "Beide bitte", targetAgent: "both" });
    const session1 = getConferenceSession({ conferenceId: cid1 });
    const session2 = getConferenceSession({ conferenceId: cid2 });
    const s1AgentMsgs = session1.messages.filter((m) => m.messageRole === "agent");
    const s2AgentMsgs = session2.messages.filter((m) => m.messageRole === "agent");
    expect(s1AgentMsgs).toHaveLength(2);
    expect(s2AgentMsgs).toHaveLength(0);
  });

  test("Both replies carry the correct conferenceId", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Beide bitte",
      targetAgent: "both",
    });
    for (const reply of result.agentReplies) {
      expect(reply.conferenceId).toBe(conferenceId);
    }
  });

  test("Multiple both-mode messages in sequence all land in the same session", async () => {
    const { conferenceId } = newSession();
    await sendConferenceMessage({ conferenceId, userMessage: "Frage 1", targetAgent: "both" });
    await sendConferenceMessage({ conferenceId, userMessage: "Frage 2", targetAgent: "both" });
    const session = getConferenceSession({ conferenceId });
    // 2 user messages + 4 agent replies = 6 messages
    expect(session.messageCount).toBe(6);
    const agentMessages = session.messages.filter((m) => m.messageRole === "agent");
    expect(agentMessages).toHaveLength(4);
  });

  test("Both-mode messages don't mix with other session messages", async () => {
    const { conferenceId: cidA } = newSession();
    const { conferenceId: cidB } = newSession();
    await sendConferenceMessage({ conferenceId: cidA, userMessage: "Beide A", targetAgent: "both" });
    await sendConferenceMessage({ conferenceId: cidB, userMessage: "Nur B", targetAgent: "gemini" });
    const sessionA = getConferenceSession({ conferenceId: cidA });
    const sessionB = getConferenceSession({ conferenceId: cidB });
    const aMsgs = sessionA.messages.filter((m) => m.messageRole === "agent");
    const bMsgs = sessionB.messages.filter((m) => m.messageRole === "agent");
    expect(aMsgs).toHaveLength(2);
    expect(bMsgs).toHaveLength(1);
    // Verify no cross-contamination: all A agent messages have cidA
    for (const m of aMsgs) {
      expect(m.conferenceId).toBe(cidA);
    }
  });

  test("Both replies' messageIds are unique", async () => {
    const { conferenceId } = newSession();
    const result = await sendConferenceMessage({
      conferenceId,
      userMessage: "Beide bitte",
      targetAgent: "both",
    });
    const [ds, gm] = result.agentReplies;
    expect(ds.messageId).not.toBe(gm.messageId);
  });

  test("Session is still accessible after both-mode exchange", async () => {
    const { conferenceId } = newSession();
    await sendConferenceMessage({ conferenceId, userMessage: "Beide", targetAgent: "both" });
    const session = getConferenceSession({ conferenceId });
    expect(session).not.toBeNull();
    expect(session.conferenceStatus).toBe("session_active");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Konferenz Step E – Cooperation Type Values", () => {
  test("All sent both-mode messages produce valid cooperationType on Gemini reply", async () => {
    const { conferenceId } = newSession();
    for (let i = 0; i < 5; i++) {
      const result = await sendConferenceMessage({
        conferenceId,
        userMessage: `Frage ${i}`,
        targetAgent: "both",
      });
      const [, gm] = result.agentReplies;
      expect(VALID_BOTH_MODE_COOPERATION_TYPES).toContain(gm.cooperationType);
    }
  });
});
