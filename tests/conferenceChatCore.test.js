"use strict";

/**
 * Konferenz Step D – Live Dialog / User Message Handling /
 * Agent Reply Routing / Dialogue Reliability
 *
 * Tests cover:
 *  - New constants (VALID_CONFERENCE_RESPONSE_TYPES, VALID_CONFERENCE_DIALOG_STATES)
 *  - Free user messages per session stored with correct fields
 *  - Follow-up detection (isFollowUp, followUpOf)
 *  - Agent targeting: deepseek / gemini / both / system
 *  - Agent reply fields: responseType, responseToRole, followUpOf
 *  - Dialog state transitions per reply cycle
 *  - Reply cycle counting / follow-up counting
 *  - openClarification flag when agent returns Rückfrage
 *  - getConferenceDialogState() returns correct live state
 *  - Enhanced getConferenceAdminSummary() dialog metrics
 *  - Session model contains all Step D fields
 *  - _formatConferenceSession reflects Step D fields
 *  - No regressions in sendConferenceMessage existing behaviour
 */

const {
  openConferenceSession,
  sendConferenceMessage,
  getConferenceSession,
  getConferenceDialogState,
  getConferenceAdminSummary,
  closeConferenceSession,
  VALID_CONFERENCE_RESPONSE_TYPES,
  VALID_CONFERENCE_DIALOG_STATES,
  VALID_CONFERENCE_TARGET_AGENTS,
} = require("../services/agentBridge.service");

/* ─────────────────────────────────────────────
   Constants
   ───────────────────────────────────────────── */

describe("Konferenz Step D – Constants", () => {
  test("VALID_CONFERENCE_RESPONSE_TYPES has expected entries", () => {
    expect(Array.isArray(VALID_CONFERENCE_RESPONSE_TYPES)).toBe(true);
    expect(VALID_CONFERENCE_RESPONSE_TYPES).toContain("direct_answer");
    expect(VALID_CONFERENCE_RESPONSE_TYPES).toContain("clarification");
    expect(VALID_CONFERENCE_RESPONSE_TYPES).toContain("rückfrage");
    expect(VALID_CONFERENCE_RESPONSE_TYPES).toContain("follow_up");
    expect(VALID_CONFERENCE_RESPONSE_TYPES).toContain("coordinated");
    expect(VALID_CONFERENCE_RESPONSE_TYPES).toContain("summary");
    expect(VALID_CONFERENCE_RESPONSE_TYPES.length).toBe(6);
  });

  test("VALID_CONFERENCE_DIALOG_STATES has expected entries", () => {
    expect(Array.isArray(VALID_CONFERENCE_DIALOG_STATES)).toBe(true);
    expect(VALID_CONFERENCE_DIALOG_STATES).toContain("dialog_idle");
    expect(VALID_CONFERENCE_DIALOG_STATES).toContain("message_received");
    expect(VALID_CONFERENCE_DIALOG_STATES).toContain("agent_reply_pending");
    expect(VALID_CONFERENCE_DIALOG_STATES).toContain("reply_delivered");
    expect(VALID_CONFERENCE_DIALOG_STATES).toContain("additional_agent_pending");
    expect(VALID_CONFERENCE_DIALOG_STATES).toContain("reply_cycle_complete");
    expect(VALID_CONFERENCE_DIALOG_STATES).toContain("clarification_open");
    expect(VALID_CONFERENCE_DIALOG_STATES).toContain("follow_up_pending");
    expect(VALID_CONFERENCE_DIALOG_STATES.length).toBe(8);
  });
});

/* ─────────────────────────────────────────────
   Session Model – Step D fields present
   ───────────────────────────────────────────── */

describe("Konferenz Step D – Session model fields", () => {
  test("openConferenceSession creates session with Step D dialog fields", () => {
    const result = openConferenceSession({ conferenceFocus: "API-Redesign" });
    expect(result.success).toBe(true);
    const s = result.session;
    expect(s.dialogState).toBe("dialog_idle");
    expect(s.followUpCount).toBe(0);
    expect(s.replyCycleCount).toBe(0);
    expect(s.openClarification).toBe(false);
    expect(s.lastUserMessageId).toBeNull();
    expect(s.lastUserMessage).toBeNull();
    expect(Array.isArray(s.lastReplyAgents)).toBe(true);
    expect(s.lastReplyAgents.length).toBe(0);
  });
});

/* ─────────────────────────────────────────────
   Free User Message – stored correctly
   ───────────────────────────────────────────── */

describe("Konferenz Step D – Free user message stored correctly", () => {
  test("User message lands in session with correct fields", () => {
    const session = openConferenceSession({ conferenceFocus: "Backend-Analyse" });
    const cid = session.conferenceId;
    const result = sendConferenceMessage({ conferenceId: cid, userMessage: "Wo liegt das Problem?" });
    expect(result.success).toBe(true);
    expect(result.userMessage.messageRole).toBe("user");
    expect(result.userMessage.speakerAgent).toBe("user");
    expect(result.userMessage.content).toBe("Wo liegt das Problem?");
    expect(result.userMessage.conferenceId).toBe(cid);
    expect(result.userMessage.messageId).toBeDefined();
    expect(result.userMessage.createdAt).toBeDefined();
  });

  test("User message is part of the session message list", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    sendConferenceMessage({ conferenceId: cid, userMessage: "Was ist der Status?" });
    const retrieved = getConferenceSession({ conferenceId: cid });
    const userMsgs = retrieved.messages.filter((m) => m.messageRole === "user");
    expect(userMsgs.length).toBe(1);
    expect(userMsgs[0].content).toBe("Was ist der Status?");
  });

  test("Multiple user messages accumulate correctly", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    sendConferenceMessage({ conferenceId: cid, userMessage: "Erste Frage" });
    sendConferenceMessage({ conferenceId: cid, userMessage: "Zweite Frage" });
    sendConferenceMessage({ conferenceId: cid, userMessage: "Dritte Frage" });
    const retrieved = getConferenceSession({ conferenceId: cid });
    const userMsgs = retrieved.messages.filter((m) => m.messageRole === "user");
    expect(userMsgs.length).toBe(3);
  });

  test("session.lastUserMessage is set after sendConferenceMessage", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    sendConferenceMessage({ conferenceId: cid, userMessage: "Was passiert hier?" });
    const dialogState = getConferenceDialogState({ conferenceId: cid });
    expect(dialogState.lastUserMessage).toBe("Was passiert hier?");
    expect(dialogState.lastUserMessageId).toBeDefined();
  });
});

/* ─────────────────────────────────────────────
   Agent Targeting – clean routing
   ───────────────────────────────────────────── */

describe("Konferenz Step D – Agent targeting", () => {
  test("Explicit targetAgent 'deepseek' routes only to deepseek", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    const result = sendConferenceMessage({
      conferenceId: cid,
      userMessage: "Bitte analysiere das Backend",
      targetAgent: "deepseek",
    });
    expect(result.success).toBe(true);
    expect(result.routing.targetAgent).toBe("deepseek");
    expect(result.agentReplies.length).toBe(1);
    expect(result.agentReplies[0].speakerAgent).toBe("deepseek");
  });

  test("Explicit targetAgent 'gemini' routes only to gemini", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    const result = sendConferenceMessage({
      conferenceId: cid,
      userMessage: "Wie sieht das UI aus?",
      targetAgent: "gemini",
    });
    expect(result.success).toBe(true);
    expect(result.routing.targetAgent).toBe("gemini");
    expect(result.agentReplies.length).toBe(1);
    expect(result.agentReplies[0].speakerAgent).toBe("gemini");
  });

  test("Explicit targetAgent 'both' routes to both agents", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    const result = sendConferenceMessage({
      conferenceId: cid,
      userMessage: "Bitte beide Perspektiven",
      targetAgent: "both",
    });
    expect(result.success).toBe(true);
    expect(result.routing.targetAgent).toBe("both");
    expect(result.agentReplies.length).toBe(2);
    const agents = result.agentReplies.map((r) => r.speakerAgent);
    expect(agents).toContain("deepseek");
    expect(agents).toContain("gemini");
  });

  test("Explicit targetAgent 'system' routes to system", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    const result = sendConferenceMessage({
      conferenceId: cid,
      userMessage: "Was ist der Status?",
      targetAgent: "system",
    });
    expect(result.success).toBe(true);
    expect(result.routing.targetAgent).toBe("system");
    expect(result.agentReplies.length).toBe(1);
    expect(result.agentReplies[0].speakerAgent).toBe("system");
  });

  test("Invalid targetAgent falls back to keyword routing", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    const result = sendConferenceMessage({
      conferenceId: cid,
      userMessage: "Allgemeine Frage",
      targetAgent: "invalid_agent",
    });
    expect(result.success).toBe(true);
    expect(VALID_CONFERENCE_TARGET_AGENTS).toContain(result.routing.targetAgent);
  });
});

/* ─────────────────────────────────────────────
   Agent Reply Fields – responseType, responseToRole, followUpOf
   ───────────────────────────────────────────── */

describe("Konferenz Step D – Agent reply fields", () => {
  test("Agent reply contains responseType from VALID_CONFERENCE_RESPONSE_TYPES", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    const result = sendConferenceMessage({ conferenceId: cid, userMessage: "Was ist das Problem?" });
    for (const reply of result.agentReplies) {
      expect(VALID_CONFERENCE_RESPONSE_TYPES).toContain(reply.responseType);
    }
  });

  test("Agent reply contains responseToRole = 'user'", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    const result = sendConferenceMessage({ conferenceId: cid, userMessage: "Erkläre mir den Fehler." });
    for (const reply of result.agentReplies) {
      expect(reply.responseToRole).toBe("user");
    }
  });

  test("Agent reply contains replyToMessageId referencing the user message", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    const result = sendConferenceMessage({ conferenceId: cid, userMessage: "Frage an den Agenten." });
    const userMsgId = result.userMessage.messageId;
    for (const reply of result.agentReplies) {
      expect(reply.replyToMessageId).toBe(userMsgId);
    }
  });

  test("Second agent reply (both mode) has followUpOf referencing first agent reply", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    const result = sendConferenceMessage({
      conferenceId: cid,
      userMessage: "Bitte beide antworten",
      targetAgent: "both",
    });
    expect(result.agentReplies.length).toBe(2);
    const first = result.agentReplies[0];
    const second = result.agentReplies[1];
    expect(first.followUpOf).toBeNull();
    expect(second.followUpOf).toBe(first.messageId);
  });

  test("Second agent reply (both mode) has responseType 'follow_up'", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    const result = sendConferenceMessage({
      conferenceId: cid,
      userMessage: "Bitte beide Agenten",
      targetAgent: "both",
    });
    expect(result.agentReplies[1].responseType).toBe("follow_up");
  });

  test("System agent reply has responseType 'summary'", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    const result = sendConferenceMessage({
      conferenceId: cid,
      userMessage: "Status bitte",
      targetAgent: "system",
    });
    expect(result.agentReplies[0].responseType).toBe("summary");
  });
});

/* ─────────────────────────────────────────────
   Dialog State Tracking
   ───────────────────────────────────────────── */

describe("Konferenz Step D – Dialog state tracking", () => {
  test("Fresh session has dialogState 'dialog_idle'", () => {
    const session = openConferenceSession();
    expect(session.session.dialogState).toBe("dialog_idle");
  });

  test("After sendConferenceMessage, dialogState transitions to reply_cycle_complete (normal flow)", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    const result = sendConferenceMessage({ conferenceId: cid, userMessage: "Analysiere das Problem." });
    expect(result.dialogState).toBe("reply_cycle_complete");
  });

  test("replyCycleCount increments on each completed cycle", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    sendConferenceMessage({ conferenceId: cid, userMessage: "Erste Runde" });
    const r2 = sendConferenceMessage({ conferenceId: cid, userMessage: "Zweite Runde" });
    const r3 = sendConferenceMessage({ conferenceId: cid, userMessage: "Dritte Runde" });
    expect(r3.replyCycleCount).toBe(3);
  });

  test("dialogState and replyCycleCount available on sendConferenceMessage result", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    const result = sendConferenceMessage({ conferenceId: cid, userMessage: "Wie weiter?" });
    expect(result.dialogState).toBeDefined();
    expect(typeof result.replyCycleCount).toBe("number");
    expect(typeof result.followUpCount).toBe("number");
    expect(typeof result.openClarification).toBe("boolean");
  });

  test("lastReplyAgents is set correctly after single-agent reply", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    sendConferenceMessage({ conferenceId: cid, userMessage: "Backend fragen", targetAgent: "deepseek" });
    const dialogState = getConferenceDialogState({ conferenceId: cid });
    expect(dialogState.lastReplyAgents).toEqual(["deepseek"]);
  });

  test("lastReplyAgents contains both agents after both-mode reply", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    sendConferenceMessage({ conferenceId: cid, userMessage: "Beide bitte", targetAgent: "both" });
    const dialogState = getConferenceDialogState({ conferenceId: cid });
    expect(dialogState.lastReplyAgents).toContain("deepseek");
    expect(dialogState.lastReplyAgents).toContain("gemini");
  });
});

/* ─────────────────────────────────────────────
   Follow-up Detection
   ───────────────────────────────────────────── */

describe("Konferenz Step D – Follow-up detection", () => {
  test("First message in a session is not a follow-up", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    const result = sendConferenceMessage({ conferenceId: cid, userMessage: "Was ist das Problem?" });
    expect(result.userMessage.isFollowUp).toBe(false);
    expect(result.userMessage.followUpOf).toBeNull();
  });

  test("First message in a new session is not a follow-up even when other sessions have messages", () => {
    // Populate one session first
    const s1 = openConferenceSession();
    sendConferenceMessage({ conferenceId: s1.conferenceId, userMessage: "Erste Frage." });

    // New session: first message should NOT be a follow-up regardless of other sessions
    const s2 = openConferenceSession();
    const result = sendConferenceMessage({ conferenceId: s2.conferenceId, userMessage: "Nochmal – was ist das?" });
    expect(result.userMessage.isFollowUp).toBe(false);
    expect(result.userMessage.followUpOf).toBeNull();
  });

  test("Message with follow-up keyword detected as follow-up", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    sendConferenceMessage({ conferenceId: cid, userMessage: "Erste Frage." });
    const r2 = sendConferenceMessage({ conferenceId: cid, userMessage: "Und was ist noch relevant?" });
    expect(r2.userMessage.isFollowUp).toBe(true);
    expect(r2.userMessage.followUpOf).toBeDefined();
  });

  test("Follow-up message has followUpOf set to previous user message ID", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    const r1 = sendConferenceMessage({ conferenceId: cid, userMessage: "Erste Frage hier." });
    const firstMsgId = r1.userMessage.messageId;
    const r2 = sendConferenceMessage({ conferenceId: cid, userMessage: "Nochmal bitte genauer." });
    expect(r2.userMessage.isFollowUp).toBe(true);
    expect(r2.userMessage.followUpOf).toBe(firstMsgId);
  });

  test("followUpCount increments on follow-up messages", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    sendConferenceMessage({ conferenceId: cid, userMessage: "Was passiert da?" });
    const r2 = sendConferenceMessage({ conferenceId: cid, userMessage: "Nochmal genauer." });
    const r3 = sendConferenceMessage({ conferenceId: cid, userMessage: "Außerdem noch etwas." });
    expect(r2.followUpCount).toBeGreaterThanOrEqual(1);
    expect(r3.followUpCount).toBeGreaterThanOrEqual(2);
  });
});

/* ─────────────────────────────────────────────
   getConferenceDialogState
   ───────────────────────────────────────────── */

describe("Konferenz Step D – getConferenceDialogState", () => {
  test("returns null without conferenceId", () => {
    expect(getConferenceDialogState()).toBeNull();
    expect(getConferenceDialogState({})).toBeNull();
  });

  test("returns null for unknown conferenceId", () => {
    expect(getConferenceDialogState({ conferenceId: "unknown-xyz" })).toBeNull();
  });

  test("returns correct structure for fresh session", () => {
    const session = openConferenceSession({ conferenceFocus: "UX-Review" });
    const cid = session.conferenceId;
    const state = getConferenceDialogState({ conferenceId: cid });
    expect(state).not.toBeNull();
    expect(state.conferenceId).toBe(cid);
    expect(state.dialogState).toBe("dialog_idle");
    expect(state.dialogStateLabel).toBeDefined();
    expect(state.openClarification).toBe(false);
    expect(state.followUpCount).toBe(0);
    expect(state.replyCycleCount).toBe(0);
    expect(state.lastUserMessageId).toBeNull();
    expect(state.lastUserMessage).toBeNull();
    expect(Array.isArray(state.lastReplyAgents)).toBe(true);
    expect(Array.isArray(state.recentMessages)).toBe(true);
    expect(state.generatedAt).toBeDefined();
  });

  test("returns updated state after message exchange", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    sendConferenceMessage({ conferenceId: cid, userMessage: "Bitte analysiere." });
    const state = getConferenceDialogState({ conferenceId: cid });
    expect(state.dialogState).toBe("reply_cycle_complete");
    expect(state.replyCycleCount).toBe(1);
    expect(state.lastUserMessage).toBe("Bitte analysiere.");
    expect(state.lastUserMessageId).toBeDefined();
    expect(state.recentMessages.length).toBeGreaterThan(0);
  });

  test("recentMessages contain contentExcerpt field", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    sendConferenceMessage({ conferenceId: cid, userMessage: "Was ist das Problem?" });
    const state = getConferenceDialogState({ conferenceId: cid });
    for (const msg of state.recentMessages) {
      expect(msg.contentExcerpt).toBeDefined();
      expect(msg.messageId).toBeDefined();
      expect(msg.speakerAgent).toBeDefined();
    }
  });

  test("dialogStateLabel is provided as human-readable string", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    const state = getConferenceDialogState({ conferenceId: cid });
    expect(typeof state.dialogStateLabel).toBe("string");
    expect(state.dialogStateLabel.length).toBeGreaterThan(0);
  });
});

/* ─────────────────────────────────────────────
   Enhanced getConferenceAdminSummary – dialog quality metrics
   ───────────────────────────────────────────── */

describe("Konferenz Step D – Enhanced getConferenceAdminSummary", () => {
  test("admin summary includes Step D dialog quality metrics", () => {
    const summary = getConferenceAdminSummary();
    expect(typeof summary.totalFollowUpMessages).toBe("number");
    expect(typeof summary.totalCompletedCycles).toBe("number");
    expect(typeof summary.totalWithOpenClarification).toBe("number");
    expect(typeof summary.totalWithActiveDialog).toBe("number");
    expect(typeof summary.totalUserMessages).toBe("number");
    expect(summary.byDialogState).toBeDefined();
    expect(typeof summary.byDialogState).toBe("object");
  });

  test("totalCompletedCycles reflects actual completed reply cycles", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    sendConferenceMessage({ conferenceId: cid, userMessage: "Erste Runde" });
    sendConferenceMessage({ conferenceId: cid, userMessage: "Zweite Runde" });
    const summary = getConferenceAdminSummary();
    expect(summary.totalCompletedCycles).toBeGreaterThanOrEqual(2);
  });

  test("byDialogState contains valid dialog state keys", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    sendConferenceMessage({ conferenceId: cid, userMessage: "Frage an alle" });
    const summary = getConferenceAdminSummary();
    const knownStates = Object.keys(summary.byDialogState);
    for (const s of knownStates) {
      expect(VALID_CONFERENCE_DIALOG_STATES).toContain(s);
    }
  });

  test("totalUserMessages counts user-sent messages", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    sendConferenceMessage({ conferenceId: cid, userMessage: "Msg 1" });
    sendConferenceMessage({ conferenceId: cid, userMessage: "Msg 2" });
    const summary = getConferenceAdminSummary();
    expect(summary.totalUserMessages).toBeGreaterThanOrEqual(2);
  });
});

/* ─────────────────────────────────────────────
   Session / Thread Robustness
   ───────────────────────────────────────────── */

describe("Konferenz Step D – Session / Thread Robustness", () => {
  test("Messages from different sessions stay in correct session", () => {
    const s1 = openConferenceSession({ conferenceFocus: "Backend" });
    const s2 = openConferenceSession({ conferenceFocus: "Frontend" });
    const cid1 = s1.conferenceId;
    const cid2 = s2.conferenceId;
    sendConferenceMessage({ conferenceId: cid1, userMessage: "Backend Frage" });
    sendConferenceMessage({ conferenceId: cid2, userMessage: "Frontend Frage" });
    const sess1 = getConferenceSession({ conferenceId: cid1 });
    const sess2 = getConferenceSession({ conferenceId: cid2 });
    const s1UserMsgs = sess1.messages.filter((m) => m.messageRole === "user");
    const s2UserMsgs = sess2.messages.filter((m) => m.messageRole === "user");
    expect(s1UserMsgs.length).toBe(1);
    expect(s1UserMsgs[0].content).toBe("Backend Frage");
    expect(s2UserMsgs.length).toBe(1);
    expect(s2UserMsgs[0].content).toBe("Frontend Frage");
  });

  test("sendConferenceMessage rejects unknown conferenceId", () => {
    const result = sendConferenceMessage({ conferenceId: "non-existent-id", userMessage: "Test" });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("sendConferenceMessage rejects closed sessions", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    closeConferenceSession({ conferenceId: cid });
    const result = sendConferenceMessage({ conferenceId: cid, userMessage: "Zu spät?" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("closed");
  });

  test("Agent replies in both-mode are assigned to correct session", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    const result = sendConferenceMessage({ conferenceId: cid, userMessage: "Beide bitte", targetAgent: "both" });
    for (const reply of result.agentReplies) {
      expect(reply.conferenceId).toBe(cid);
    }
  });

  test("lastUserMessage is truncated to max 200 chars", () => {
    const session = openConferenceSession();
    const cid = session.conferenceId;
    const longMsg = "X".repeat(300);
    sendConferenceMessage({ conferenceId: cid, userMessage: longMsg });
    const state = getConferenceDialogState({ conferenceId: cid });
    expect(state.lastUserMessage.length).toBeLessThanOrEqual(200);
  });
});

/* ─────────────────────────────────────────────
   Input Validation
   ───────────────────────────────────────────── */

describe("Konferenz Step D – Input validation", () => {
  test("sendConferenceMessage fails without conferenceId", () => {
    const result = sendConferenceMessage({ userMessage: "Test" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("conferenceId");
  });

  test("sendConferenceMessage fails without userMessage", () => {
    const session = openConferenceSession();
    const result = sendConferenceMessage({ conferenceId: session.conferenceId });
    expect(result.success).toBe(false);
    expect(result.error).toContain("userMessage");
  });

  test("sendConferenceMessage fails with empty userMessage", () => {
    const session = openConferenceSession();
    const result = sendConferenceMessage({ conferenceId: session.conferenceId, userMessage: "   " });
    expect(result.success).toBe(false);
  });

  test("getConferenceDialogState without params returns null", () => {
    expect(getConferenceDialogState()).toBeNull();
  });
});
