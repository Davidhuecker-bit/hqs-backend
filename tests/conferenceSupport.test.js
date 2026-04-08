"use strict";

/**
 * Konferenz Step A – DeepSeek ↔ Gemini Conference Session /
 * Targeting / Mode / Summary
 *
 * Tests cover:
 *  - Conference session lifecycle (open / active / pause / close / archive)
 *  - Clean agent targeting (deepseek / gemini / both / system)
 *  - Conference mode management (work_chat / problem_solving / decision_mode)
 *  - Conference message sending with routing
 *  - Conference summary generation
 *  - Conference workspace loading
 *  - Conference admin summary / analytics
 *  - Input validation
 *  - Constants exported correctly
 */

const {
  openConferenceSession,
  sendConferenceMessage,
  updateConferenceSession,
  closeConferenceSession,
  getConferenceSession,
  getConferenceSummary,
  getConferenceWorkspace,
  getConferenceAdminSummary,
  VALID_CONFERENCE_SESSION_STATUSES,
  VALID_CONFERENCE_MODES,
  VALID_CONFERENCE_TARGET_AGENTS,
} = require("../services/agentBridge.service");

/* ─────────────────────────────────────────────
   Constants
   ───────────────────────────────────────────── */

describe("Konferenz Step A – Constants", () => {
  test("VALID_CONFERENCE_SESSION_STATUSES has expected entries", () => {
    expect(Array.isArray(VALID_CONFERENCE_SESSION_STATUSES)).toBe(true);
    expect(VALID_CONFERENCE_SESSION_STATUSES).toContain("session_open");
    expect(VALID_CONFERENCE_SESSION_STATUSES).toContain("session_active");
    expect(VALID_CONFERENCE_SESSION_STATUSES).toContain("session_paused");
    expect(VALID_CONFERENCE_SESSION_STATUSES).toContain("session_closed");
    expect(VALID_CONFERENCE_SESSION_STATUSES).toContain("session_archived");
    expect(VALID_CONFERENCE_SESSION_STATUSES.length).toBe(5);
  });

  test("VALID_CONFERENCE_MODES has expected entries", () => {
    expect(Array.isArray(VALID_CONFERENCE_MODES)).toBe(true);
    expect(VALID_CONFERENCE_MODES).toContain("work_chat");
    expect(VALID_CONFERENCE_MODES).toContain("problem_solving");
    expect(VALID_CONFERENCE_MODES).toContain("decision_mode");
    expect(VALID_CONFERENCE_MODES.length).toBe(3);
  });

  test("VALID_CONFERENCE_TARGET_AGENTS has expected entries", () => {
    expect(Array.isArray(VALID_CONFERENCE_TARGET_AGENTS)).toBe(true);
    expect(VALID_CONFERENCE_TARGET_AGENTS).toContain("deepseek");
    expect(VALID_CONFERENCE_TARGET_AGENTS).toContain("gemini");
    expect(VALID_CONFERENCE_TARGET_AGENTS).toContain("both");
    expect(VALID_CONFERENCE_TARGET_AGENTS).toContain("system");
    expect(VALID_CONFERENCE_TARGET_AGENTS.length).toBe(4);
  });
});

/* ─────────────────────────────────────────────
   Session Lifecycle
   ───────────────────────────────────────────── */

describe("Konferenz Step A – Session Lifecycle", () => {
  test("openConferenceSession creates a new session with defaults", () => {
    const result = openConferenceSession();
    expect(result.success).toBe(true);
    expect(result.conferenceId).toBeDefined();
    expect(result.resumed).toBe(false);
    expect(result.session.conferenceStatus).toBe("session_active");
    expect(result.session.conferenceMode).toBe("work_chat");
    expect(result.session.activeAgents).toEqual(["deepseek", "gemini"]);
  });

  test("openConferenceSession creates a session with custom mode", () => {
    const result = openConferenceSession({
      conferenceMode: "decision_mode",
      conferenceFocus: "API-Redesign",
    });
    expect(result.success).toBe(true);
    expect(result.session.conferenceMode).toBe("decision_mode");
    expect(result.session.conferenceFocus).toBe("API-Redesign");
  });

  test("openConferenceSession falls back to work_chat for invalid mode", () => {
    const result = openConferenceSession({ conferenceMode: "invalid_mode" });
    expect(result.success).toBe(true);
    expect(result.session.conferenceMode).toBe("work_chat");
  });

  test("openConferenceSession resumes an existing paused session", () => {
    const first = openConferenceSession();
    updateConferenceSession({ conferenceId: first.conferenceId, conferenceStatus: "session_paused" });
    const resumed = openConferenceSession({ conferenceId: first.conferenceId });
    expect(resumed.success).toBe(true);
    expect(resumed.resumed).toBe(true);
  });

  test("openConferenceSession links to a related case", () => {
    const result = openConferenceSession({ relatedCaseId: "ac-test-123" });
    expect(result.success).toBe(true);
    expect(result.session.relatedCaseId).toBe("ac-test-123");
  });

  test("closeConferenceSession closes a session", () => {
    const session = openConferenceSession();
    const closed = closeConferenceSession({ conferenceId: session.conferenceId });
    expect(closed.success).toBe(true);
    expect(closed.conferenceStatus).toBe("session_closed");
    expect(closed.closedAt).toBeDefined();
  });

  test("closeConferenceSession archives a session", () => {
    const session = openConferenceSession();
    const archived = closeConferenceSession({ conferenceId: session.conferenceId, archive: true });
    expect(archived.success).toBe(true);
    expect(archived.conferenceStatus).toBe("session_archived");
  });

  test("closeConferenceSession fails without conferenceId", () => {
    const result = closeConferenceSession({});
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("closeConferenceSession fails for unknown session", () => {
    const result = closeConferenceSession({ conferenceId: "nonexistent" });
    expect(result.success).toBe(false);
  });
});

/* ─────────────────────────────────────────────
   Session Update
   ───────────────────────────────────────────── */

describe("Konferenz Step A – Session Update", () => {
  test("updateConferenceSession changes mode", () => {
    const session = openConferenceSession();
    const updated = updateConferenceSession({
      conferenceId: session.conferenceId,
      conferenceMode: "problem_solving",
    });
    expect(updated.success).toBe(true);
    expect(updated.session.conferenceMode).toBe("problem_solving");
    expect(updated.changes).toContain("Modus: work_chat → problem_solving");
  });

  test("updateConferenceSession changes status", () => {
    const session = openConferenceSession();
    const updated = updateConferenceSession({
      conferenceId: session.conferenceId,
      conferenceStatus: "session_paused",
    });
    expect(updated.success).toBe(true);
    expect(updated.session.conferenceStatus).toBe("session_paused");
  });

  test("updateConferenceSession changes focus", () => {
    const session = openConferenceSession();
    const updated = updateConferenceSession({
      conferenceId: session.conferenceId,
      conferenceFocus: "Neuer Fokus",
    });
    expect(updated.success).toBe(true);
    expect(updated.session.conferenceFocus).toBe("Neuer Fokus");
  });

  test("updateConferenceSession fails without conferenceId", () => {
    const result = updateConferenceSession({});
    expect(result.success).toBe(false);
  });

  test("updateConferenceSession fails for unknown session", () => {
    const result = updateConferenceSession({ conferenceId: "nonexistent" });
    expect(result.success).toBe(false);
  });
});

/* ─────────────────────────────────────────────
   Conference Messaging & Agent Targeting
   ───────────────────────────────────────────── */

describe("Konferenz Step A – Messaging & Targeting", () => {
  test("sendConferenceMessage routes to deepseek explicitly", async () => {
    const session = openConferenceSession();
    const result = await sendConferenceMessage({
      conferenceId: session.conferenceId,
      userMessage: "Was passiert im Backend?",
      targetAgent: "deepseek",
    });
    expect(result.success).toBe(true);
    expect(result.routing.targetAgent).toBe("deepseek");
    expect(result.agentReplies.length).toBe(1);
    expect(result.agentReplies[0].speakerAgent).toBe("deepseek");
  });

  test("sendConferenceMessage routes to gemini explicitly", async () => {
    const session = openConferenceSession();
    const result = await sendConferenceMessage({
      conferenceId: session.conferenceId,
      userMessage: "Wie sieht das UI aus?",
      targetAgent: "gemini",
    });
    expect(result.success).toBe(true);
    expect(result.routing.targetAgent).toBe("gemini");
    expect(result.agentReplies.length).toBe(1);
    expect(result.agentReplies[0].speakerAgent).toBe("gemini");
  });

  test("sendConferenceMessage routes to both agents explicitly", async () => {
    const session = openConferenceSession();
    const result = await sendConferenceMessage({
      conferenceId: session.conferenceId,
      userMessage: "Was denkt ihr beide?",
      targetAgent: "both",
    });
    expect(result.success).toBe(true);
    expect(result.routing.targetAgent).toBe("both");
    expect(result.agentReplies.length).toBe(2);
    const agents = result.agentReplies.map((r) => r.speakerAgent);
    expect(agents).toContain("deepseek");
    expect(agents).toContain("gemini");
  });

  test("sendConferenceMessage routes to system explicitly", async () => {
    const session = openConferenceSession();
    const result = await sendConferenceMessage({
      conferenceId: session.conferenceId,
      userMessage: "Status?",
      targetAgent: "system",
    });
    expect(result.success).toBe(true);
    expect(result.routing.targetAgent).toBe("system");
    expect(result.agentReplies[0].speakerAgent).toBe("system");
  });

  test("sendConferenceMessage uses keyword routing when no target specified", async () => {
    const session = openConferenceSession();
    const result = await sendConferenceMessage({
      conferenceId: session.conferenceId,
      userMessage: "Bitte prüfe den API-Endpunkt",
    });
    expect(result.success).toBe(true);
    expect(result.routing.targetAgent).toBeDefined();
  });

  test("sendConferenceMessage in decision_mode defaults to both when neutral", async () => {
    const session = openConferenceSession({ conferenceMode: "decision_mode" });
    const result = await sendConferenceMessage({
      conferenceId: session.conferenceId,
      userMessage: "Was meint ihr dazu?",
    });
    expect(result.success).toBe(true);
    expect(result.routing.targetAgent).toBe("both");
  });

  test("sendConferenceMessage fails without conferenceId", async () => {
    const result = await sendConferenceMessage({ userMessage: "test" });
    expect(result.success).toBe(false);
  });

  test("sendConferenceMessage fails without userMessage", async () => {
    const session = openConferenceSession();
    const result = await sendConferenceMessage({ conferenceId: session.conferenceId });
    expect(result.success).toBe(false);
  });

  test("sendConferenceMessage fails for nonexistent session", async () => {
    const result = await sendConferenceMessage({ conferenceId: "nonexistent", userMessage: "test" });
    expect(result.success).toBe(false);
  });

  test("sendConferenceMessage fails for closed session", async () => {
    const session = openConferenceSession();
    closeConferenceSession({ conferenceId: session.conferenceId });
    const result = await sendConferenceMessage({
      conferenceId: session.conferenceId,
      userMessage: "Noch eine Frage",
    });
    expect(result.success).toBe(false);
  });

  test("sendConferenceMessage resumes a paused session automatically", async () => {
    const session = openConferenceSession();
    updateConferenceSession({ conferenceId: session.conferenceId, conferenceStatus: "session_paused" });
    const result = await sendConferenceMessage({
      conferenceId: session.conferenceId,
      userMessage: "Weiter geht es",
    });
    expect(result.success).toBe(true);
    expect(result.conferenceStatus).toBe("session_active");
  });

  test("sendConferenceMessage increments message counts", async () => {
    const session = openConferenceSession();
    await sendConferenceMessage({
      conferenceId: session.conferenceId,
      userMessage: "Erste Nachricht",
      targetAgent: "deepseek",
    });
    await sendConferenceMessage({
      conferenceId: session.conferenceId,
      userMessage: "Zweite Nachricht",
      targetAgent: "gemini",
    });
    const loaded = getConferenceSession({ conferenceId: session.conferenceId });
    expect(loaded.messageCount).toBeGreaterThanOrEqual(4); // 2 user + 2 agent
    expect(loaded.userMessageCount).toBe(2);
    expect(loaded.deepseekMessageCount).toBeGreaterThanOrEqual(1);
    expect(loaded.geminiMessageCount).toBeGreaterThanOrEqual(1);
  });
});

/* ─────────────────────────────────────────────
   Session Retrieval
   ───────────────────────────────────────────── */

describe("Konferenz Step A – Session Retrieval", () => {
  test("getConferenceSession returns null for unknown session", () => {
    expect(getConferenceSession({ conferenceId: "nonexistent" })).toBeNull();
  });

  test("getConferenceSession returns null without conferenceId", () => {
    expect(getConferenceSession({})).toBeNull();
  });

  test("getConferenceSession returns session with messages", async () => {
    const session = openConferenceSession();
    await sendConferenceMessage({
      conferenceId: session.conferenceId,
      userMessage: "Hallo",
      targetAgent: "deepseek",
    });
    const loaded = getConferenceSession({ conferenceId: session.conferenceId });
    expect(loaded).toBeDefined();
    expect(loaded.conferenceId).toBe(session.conferenceId);
    expect(loaded.messages.length).toBeGreaterThan(0);
  });

  test("getConferenceSession respects limit parameter", async () => {
    const session = openConferenceSession();
    for (let i = 0; i < 5; i++) {
      await sendConferenceMessage({
        conferenceId: session.conferenceId,
        userMessage: `Nachricht ${i}`,
        targetAgent: "deepseek",
      });
    }
    const loaded = getConferenceSession({ conferenceId: session.conferenceId, limit: 3 });
    expect(loaded.messages.length).toBeLessThanOrEqual(3);
  });
});

/* ─────────────────────────────────────────────
   Conference Summary
   ───────────────────────────────────────────── */

describe("Konferenz Step A – Summary", () => {
  test("getConferenceSummary returns null for unknown session", () => {
    expect(getConferenceSummary({ conferenceId: "nonexistent" })).toBeNull();
  });

  test("getConferenceSummary returns null without conferenceId", () => {
    expect(getConferenceSummary({})).toBeNull();
  });

  test("getConferenceSummary returns structured summary", async () => {
    const session = openConferenceSession({ conferenceFocus: "API-Review" });
    await sendConferenceMessage({
      conferenceId: session.conferenceId,
      userMessage: "Was ist der aktuelle Stand?",
      targetAgent: "deepseek",
    });
    const summary = getConferenceSummary({ conferenceId: session.conferenceId });
    expect(summary).toBeDefined();
    expect(summary.conferenceId).toBe(session.conferenceId);
    expect(summary.status).toBe("Aktiv");
    expect(summary.modus).toBe("Arbeitschat");
    expect(summary.currentFocus).toBe("API-Review");
    expect(summary.understood).toBeDefined();
    expect(summary.direction).toBeDefined();
    expect(summary.leadingAgent).toBeDefined();
    expect(summary.openPoints).toBeDefined();
    expect(Array.isArray(summary.openPoints)).toBe(true);
    expect(summary.nextStep).toBeDefined();
    expect(summary.messageCount).toBeGreaterThan(0);
    expect(summary.generatedAt).toBeDefined();
  });

  test("getConferenceSummary reflects decision mode", () => {
    const session = openConferenceSession({ conferenceMode: "decision_mode" });
    const summary = getConferenceSummary({ conferenceId: session.conferenceId });
    expect(summary.modus).toBe("Entscheidungsmodus");
    expect(summary.direction).toContain("Entscheidung");
  });

  test("getConferenceSummary shows paused status", () => {
    const session = openConferenceSession();
    updateConferenceSession({ conferenceId: session.conferenceId, conferenceStatus: "session_paused" });
    const summary = getConferenceSummary({ conferenceId: session.conferenceId });
    expect(summary.status).toBe("Pausiert");
    expect(summary.nextStep).toContain("pausiert");
  });
});

/* ─────────────────────────────────────────────
   Conference Workspace
   ───────────────────────────────────────────── */

describe("Konferenz Step A – Workspace", () => {
  test("getConferenceWorkspace returns workspace data", () => {
    const workspace = getConferenceWorkspace();
    expect(workspace.success).toBe(true);
    expect(typeof workspace.totalSessions).toBe("number");
    expect(Array.isArray(workspace.activeSessions)).toBe(true);
    expect(Array.isArray(workspace.pausedSessions)).toBe(true);
    expect(Array.isArray(workspace.recentClosed)).toBe(true);
    expect(workspace.generatedAt).toBeDefined();
  });
});

/* ─────────────────────────────────────────────
   Conference Admin Summary
   ───────────────────────────────────────────── */

describe("Konferenz Step A – Admin Summary", () => {
  test("getConferenceAdminSummary returns analytics", () => {
    const summary = getConferenceAdminSummary();
    expect(typeof summary.totalSessions).toBe("number");
    expect(typeof summary.totalActive).toBe("number");
    expect(typeof summary.totalPaused).toBe("number");
    expect(typeof summary.totalClosed).toBe("number");
    expect(typeof summary.totalArchived).toBe("number");
    expect(typeof summary.totalInDecisionMode).toBe("number");
    expect(typeof summary.totalInProblemSolving).toBe("number");
    expect(typeof summary.totalInWorkChat).toBe("number");
    expect(typeof summary.totalDeepseekOnly).toBe("number");
    expect(typeof summary.totalGeminiOnly).toBe("number");
    expect(typeof summary.totalBothTargeted).toBe("number");
    expect(typeof summary.totalMessages).toBe("number");
    expect(typeof summary.totalWithFollowUp).toBe("number");
    expect(typeof summary.totalWithCaseBinding).toBe("number");
    expect(summary.byStatus).toBeDefined();
    expect(summary.byMode).toBeDefined();
    expect(summary.byTarget).toBeDefined();
    expect(summary.generatedAt).toBeDefined();
  });
});
