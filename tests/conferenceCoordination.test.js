"use strict";

/**
 * Konferenz Step B: Coordination / Moderation / Coordinated Reply Flow – Tests
 *
 * Tests cover:
 * 1. Step B constants validation
 * 2. Coordinated reply flow (solo, supporting, coordinated, bundled, clarification, phase_closed)
 * 3. Lead / support agent derivation
 * 4. Coordination state management
 * 5. Phase closure logic
 * 6. Open points / clarification derivation
 * 7. Phase digest (Ergebnisverdichtung)
 * 8. Coordinator messages
 * 9. Coordination summary (admin view)
 * 10. Logging-relevant fields
 */

const {
  openConferenceSession,
  sendConferenceMessage,
  sendCoordinatedConferenceMessage,
  getConferenceCoordinationSummary,
  getConferencePhaseDigest,
  getConferenceSession,
  updateConferenceSession,
  closeConferenceSession,
  VALID_CONFERENCE_REPLY_PATTERNS,
  VALID_CONFERENCE_COORDINATION_STATES,
  VALID_CONFERENCE_PHASE_STATUSES,
  VALID_COORDINATOR_MESSAGE_TYPES,
  VALID_CONFERENCE_SESSION_STATUSES,
  VALID_CONFERENCE_MODES,
} = require("../services/agentBridge.service");

/* ─────────────────────────────────────────────
   Helper: create a session and return conferenceId
   ───────────────────────────────────────────── */
function createTestSession(overrides = {}) {
  const result = openConferenceSession({
    conferenceFocus: overrides.conferenceFocus || "Testthema für Step B",
    conferenceMode: overrides.conferenceMode || "problem_solving",
    conferenceOwner: overrides.conferenceOwner || "test-admin",
    ...overrides,
  });
  expect(result.success).toBe(true);
  return result.conferenceId;
}

/* ─────────────────────────────────────────────
   1. Constants Validation
   ───────────────────────────────────────────── */
describe("Konferenz Step B – Constants", () => {
  test("VALID_CONFERENCE_REPLY_PATTERNS is a non-empty array", () => {
    expect(Array.isArray(VALID_CONFERENCE_REPLY_PATTERNS)).toBe(true);
    expect(VALID_CONFERENCE_REPLY_PATTERNS.length).toBeGreaterThanOrEqual(7);
    expect(VALID_CONFERENCE_REPLY_PATTERNS).toContain("solo_reply");
    expect(VALID_CONFERENCE_REPLY_PATTERNS).toContain("supporting_reply");
    expect(VALID_CONFERENCE_REPLY_PATTERNS).toContain("coordinated_reply");
    expect(VALID_CONFERENCE_REPLY_PATTERNS).toContain("bundled_reply");
    expect(VALID_CONFERENCE_REPLY_PATTERNS).toContain("needs_user_clarification");
    expect(VALID_CONFERENCE_REPLY_PATTERNS).toContain("phase_closed");
    expect(VALID_CONFERENCE_REPLY_PATTERNS).toContain("cross_agent_followup");
  });

  test("VALID_CONFERENCE_COORDINATION_STATES is a non-empty array", () => {
    expect(Array.isArray(VALID_CONFERENCE_COORDINATION_STATES)).toBe(true);
    expect(VALID_CONFERENCE_COORDINATION_STATES.length).toBeGreaterThanOrEqual(8);
    expect(VALID_CONFERENCE_COORDINATION_STATES).toContain("uncoordinated");
    expect(VALID_CONFERENCE_COORDINATION_STATES).toContain("lead_assigned");
    expect(VALID_CONFERENCE_COORDINATION_STATES).toContain("support_active");
    expect(VALID_CONFERENCE_COORDINATION_STATES).toContain("coordinated_active");
    expect(VALID_CONFERENCE_COORDINATION_STATES).toContain("bundling_needed");
    expect(VALID_CONFERENCE_COORDINATION_STATES).toContain("clarification_pending");
  });

  test("VALID_CONFERENCE_PHASE_STATUSES is a non-empty array", () => {
    expect(Array.isArray(VALID_CONFERENCE_PHASE_STATUSES)).toBe(true);
    expect(VALID_CONFERENCE_PHASE_STATUSES.length).toBeGreaterThanOrEqual(7);
    expect(VALID_CONFERENCE_PHASE_STATUSES).toContain("phase_open");
    expect(VALID_CONFERENCE_PHASE_STATUSES).toContain("problem_scoped");
    expect(VALID_CONFERENCE_PHASE_STATUSES).toContain("cause_identified");
    expect(VALID_CONFERENCE_PHASE_STATUSES).toContain("recommendation_ready");
    expect(VALID_CONFERENCE_PHASE_STATUSES).toContain("decision_pending");
    expect(VALID_CONFERENCE_PHASE_STATUSES).toContain("clarification_open");
    expect(VALID_CONFERENCE_PHASE_STATUSES).toContain("phase_concluded");
  });

  test("VALID_COORDINATOR_MESSAGE_TYPES is a non-empty array", () => {
    expect(Array.isArray(VALID_COORDINATOR_MESSAGE_TYPES)).toBe(true);
    expect(VALID_COORDINATOR_MESSAGE_TYPES.length).toBeGreaterThanOrEqual(8);
    expect(VALID_COORDINATOR_MESSAGE_TYPES).toContain("lead_assigned");
    expect(VALID_COORDINATOR_MESSAGE_TYPES).toContain("supplement_added");
    expect(VALID_COORDINATOR_MESSAGE_TYPES).toContain("reply_bundled");
    expect(VALID_COORDINATOR_MESSAGE_TYPES).toContain("clarification_needed");
    expect(VALID_COORDINATOR_MESSAGE_TYPES).toContain("point_concluded");
    expect(VALID_COORDINATOR_MESSAGE_TYPES).toContain("phase_summary");
    expect(VALID_COORDINATOR_MESSAGE_TYPES).toContain("leadership_changed");
  });
});

/* ─────────────────────────────────────────────
   2. Coordinated Reply Flow – Basic
   ───────────────────────────────────────────── */
describe("Konferenz Step B – Coordinated Reply Flow", () => {
  test("sendCoordinatedConferenceMessage requires conferenceId", () => {
    const result = sendCoordinatedConferenceMessage({ userMessage: "Test" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("conferenceId");
  });

  test("sendCoordinatedConferenceMessage requires userMessage", () => {
    const cid = createTestSession();
    const result = sendCoordinatedConferenceMessage({ conferenceId: cid });
    expect(result.success).toBe(false);
    expect(result.error).toContain("userMessage");
  });

  test("sendCoordinatedConferenceMessage rejects closed session", () => {
    const cid = createTestSession();
    closeConferenceSession({ conferenceId: cid });
    const result = sendCoordinatedConferenceMessage({ conferenceId: cid, userMessage: "Test" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("closed");
  });

  test("sendCoordinatedConferenceMessage rejects non-existent session", () => {
    const result = sendCoordinatedConferenceMessage({ conferenceId: "nonexistent", userMessage: "Test" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("solo reply pattern – single agent targeted", () => {
    const cid = createTestSession();
    const result = sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Wie funktioniert die API?",
      targetAgent: "deepseek",
    });
    expect(result.success).toBe(true);
    expect(result.agentReplies.length).toBe(1);
    expect(result.agentReplies[0].speakerAgent).toBe("deepseek");
    expect(result.coordination).toBeDefined();
    expect(result.coordination.replyPattern).toBe("solo_reply");
  });

  test("supporting reply pattern – problem_solving with both agents", () => {
    const cid = createTestSession({ conferenceMode: "problem_solving" });
    // First set a lead agent by sending a backend message
    sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Backend API Problem",
      targetAgent: "deepseek",
    });
    // Now send with both target
    const result = sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Wie wirkt sich das auf Frontend und Backend aus?",
      targetAgent: "both",
    });
    expect(result.success).toBe(true);
    expect(result.coordination.replyPattern).toBe("supporting_reply");
    expect(result.agentReplies.length).toBe(2);
    expect(result.coordinatorMessages.length).toBeGreaterThanOrEqual(1);
  });

  test("bundled reply pattern – decision_mode with both agents", () => {
    const cid = createTestSession({ conferenceMode: "decision_mode" });
    const result = sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Welche Option ist besser?",
      targetAgent: "both",
    });
    expect(result.success).toBe(true);
    expect(result.coordination.replyPattern).toBe("bundled_reply");
    expect(result.agentReplies.length).toBe(1);
    expect(result.agentReplies[0].speakerAgent).toBe("system");
    expect(result.coordinatorMessages.length).toBeGreaterThanOrEqual(1);
  });

  test("coordinated reply pattern – work_chat with both agents", () => {
    const cid = createTestSession({ conferenceMode: "work_chat" });
    const result = sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Allgemeiner Überblick bitte",
      targetAgent: "both",
    });
    expect(result.success).toBe(true);
    expect(result.coordination.replyPattern).toBe("coordinated_reply");
    expect(result.agentReplies.length).toBe(2);
  });

  test("requestedReplyPattern override", () => {
    const cid = createTestSession();
    const result = sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Bitte gebündelt antworten",
      targetAgent: "both",
      requestedReplyPattern: "bundled_reply",
    });
    expect(result.success).toBe(true);
    expect(result.coordination.replyPattern).toBe("bundled_reply");
  });

  test("resumes paused session on message", () => {
    const cid = createTestSession();
    updateConferenceSession({ conferenceId: cid, conferenceStatus: "session_paused" });
    const result = sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Weiter geht es",
    });
    expect(result.success).toBe(true);
    expect(result.conferenceStatus).toBe("session_active");
  });
});

/* ─────────────────────────────────────────────
   3. Lead / Support Agent Derivation
   ───────────────────────────────────────────── */
describe("Konferenz Step B – Lead / Support Agent", () => {
  test("backend message assigns deepseek as lead", () => {
    const cid = createTestSession();
    const result = sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Ich brauche Hilfe mit der Backend API und dem Server",
      targetAgent: "deepseek",
    });
    expect(result.coordination.leadAgent).toBe("deepseek");
    expect(result.coordination.supportAgent).toBe("gemini");
  });

  test("frontend message assigns gemini as lead", () => {
    const cid = createTestSession();
    const result = sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Das Frontend UI Design und Layout muss angepasst werden",
      targetAgent: "gemini",
    });
    expect(result.coordination.leadAgent).toBe("gemini");
    expect(result.coordination.supportAgent).toBe("deepseek");
  });

  test("coordination response includes lead and support agent", () => {
    const cid = createTestSession();
    const result = sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Allgemeine Frage",
    });
    expect(result.coordination).toBeDefined();
    expect(result.coordination.leadAgent).toBeDefined();
    expect(result.coordination.supportAgent).toBeDefined();
    expect(result.coordination.leadAgent).not.toBe(result.coordination.supportAgent);
  });
});

/* ─────────────────────────────────────────────
   4. Coordination State Management
   ───────────────────────────────────────────── */
describe("Konferenz Step B – Coordination State", () => {
  test("solo reply → lead_assigned or uncoordinated", () => {
    const cid = createTestSession();
    const result = sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Backend API prüfen",
      targetAgent: "deepseek",
    });
    expect(["lead_assigned", "uncoordinated"]).toContain(result.coordination.coordinationState);
  });

  test("bundled reply → bundling_needed", () => {
    const cid = createTestSession({ conferenceMode: "decision_mode" });
    const result = sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Beide Optionen bewerten",
      targetAgent: "both",
    });
    expect(result.coordination.coordinationState).toBe("bundling_needed");
  });

  test("coordinated reply → coordinated_active", () => {
    const cid = createTestSession({ conferenceMode: "work_chat" });
    const result = sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Überblick",
      targetAgent: "both",
    });
    expect(result.coordination.coordinationState).toBe("coordinated_active");
  });

  test("supporting reply → support_active", () => {
    const cid = createTestSession({ conferenceMode: "problem_solving" });
    // Set lead agent
    sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Backend prüfen",
      targetAgent: "deepseek",
    });
    const result = sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Beide Perspektiven",
      targetAgent: "both",
    });
    expect(result.coordination.coordinationState).toBe("support_active");
  });
});

/* ─────────────────────────────────────────────
   5. Phase Status Derivation
   ───────────────────────────────────────────── */
describe("Konferenz Step B – Phase Status", () => {
  test("initial phase is phase_open", () => {
    const cid = createTestSession();
    const result = sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Hallo",
    });
    expect(VALID_CONFERENCE_PHASE_STATUSES).toContain(result.coordination.phaseStatus);
  });

  test("recommendation keyword drives recommendation_ready", () => {
    const cid = createTestSession();
    // Build enough context
    sendCoordinatedConferenceMessage({ conferenceId: cid, userMessage: "Was ist das Problem?" });
    sendCoordinatedConferenceMessage({ conferenceId: cid, userMessage: "Ich empfehle die Lösung" });
    const result = sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Die Empfehlung ist klar",
    });
    expect(result.coordination.phaseStatus).toBe("recommendation_ready");
  });

  test("cause keyword drives cause_identified", () => {
    const cid = createTestSession();
    sendCoordinatedConferenceMessage({ conferenceId: cid, userMessage: "Was ist die Ursache?" });
    const result = sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Die Ursache liegt im Backend",
    });
    expect(result.coordination.phaseStatus).toBe("cause_identified");
  });
});

/* ─────────────────────────────────────────────
   6. Clarification / Open Points
   ───────────────────────────────────────────── */
describe("Konferenz Step B – Clarification & Open Points", () => {
  test("short message in long conference triggers clarification", () => {
    const cid = createTestSession();
    // Build up message count
    for (let i = 0; i < 6; i++) {
      sendCoordinatedConferenceMessage({
        conferenceId: cid,
        userMessage: `Nachricht Nummer ${i + 1} zur Diskussion`,
      });
    }
    // Very short message should trigger clarification
    const result = sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Hmm ok",
    });
    expect(result.coordination.replyPattern).toBe("needs_user_clarification");
    expect(result.coordination.coordinationState).toBe("clarification_pending");
  });

  test("open points are tracked in coordination", () => {
    const cid = createTestSession();
    const result = sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Was ist das Problem genau?",
    });
    expect(result.coordination.openPointCount).toBeDefined();
    expect(typeof result.coordination.openPointCount).toBe("number");
  });
});

/* ─────────────────────────────────────────────
   7. Phase Digest (Ergebnisverdichtung)
   ───────────────────────────────────────────── */
describe("Konferenz Step B – Phase Digest", () => {
  test("returns null for non-existent session", () => {
    const digest = getConferencePhaseDigest({ conferenceId: "nonexistent" });
    expect(digest).toBeNull();
  });

  test("returns null without conferenceId", () => {
    const digest = getConferencePhaseDigest({});
    expect(digest).toBeNull();
  });

  test("returns structured digest after messages", () => {
    const cid = createTestSession();
    sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Bitte Backend prüfen",
      targetAgent: "deepseek",
    });
    sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Frontend auch prüfen",
      targetAgent: "gemini",
    });

    const digest = getConferencePhaseDigest({ conferenceId: cid });
    expect(digest).toBeDefined();
    expect(digest.conferenceId).toBe(cid);
    expect(digest.phaseStatus).toBeDefined();
    expect(digest.understood).toBeDefined();
    expect(digest.direction).toBeDefined();
    expect(digest.differences).toBeDefined();
    expect(typeof digest.decisionPending).toBe("boolean");
    expect(Array.isArray(digest.openPoints)).toBe(true);
    expect(digest.nextStep).toBeDefined();
    expect(digest.leadAgent).toBeDefined();
    expect(digest.generatedAt).toBeDefined();
  });

  test("digest reflects both-agent contributions", () => {
    const cid = createTestSession();
    sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Backend und Frontend zusammen prüfen",
      targetAgent: "both",
    });

    const digest = getConferencePhaseDigest({ conferenceId: cid });
    expect(digest.understood).toContain("Beide Agenten");
  });
});

/* ─────────────────────────────────────────────
   8. Coordinator Messages
   ───────────────────────────────────────────── */
describe("Konferenz Step B – Coordinator Messages", () => {
  test("supporting reply generates coordinator message", () => {
    const cid = createTestSession({ conferenceMode: "problem_solving" });
    sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Backend prüfen",
      targetAgent: "deepseek",
    });
    const result = sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Beide Perspektiven bitte",
      targetAgent: "both",
    });
    expect(result.coordinatorMessages.length).toBeGreaterThanOrEqual(1);
    const coordMsgs = result.coordinatorMessages;
    expect(coordMsgs.some(m => m.messageRole === "coordinator")).toBe(true);
    expect(coordMsgs.some(m => m.content && m.content.includes("Koordination:"))).toBe(true);
  });

  test("bundled reply generates reply_bundled coordinator message", () => {
    const cid = createTestSession({ conferenceMode: "decision_mode" });
    const result = sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Gebündelte Bewertung bitte",
      targetAgent: "both",
    });
    const bundledMsg = result.coordinatorMessages.find(m => m.coordinatorMessageType === "reply_bundled");
    expect(bundledMsg).toBeDefined();
    expect(bundledMsg.content).toContain("gebündelt");
  });

  test("coordinator messages have proper structure", () => {
    const cid = createTestSession({ conferenceMode: "problem_solving" });
    sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Backend prüfen",
      targetAgent: "deepseek",
    });
    const result = sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Beide Perspektiven",
      targetAgent: "both",
    });

    for (const cm of result.coordinatorMessages) {
      expect(cm.messageId).toBeDefined();
      expect(cm.conferenceId).toBeDefined();
      expect(cm.messageRole).toBe("coordinator");
      expect(cm.speakerAgent).toBe("system");
      expect(cm.speakerRole).toBe("coordinator");
      expect(cm.coordinatorMessageType).toBeDefined();
      expect(VALID_COORDINATOR_MESSAGE_TYPES).toContain(cm.coordinatorMessageType);
      expect(cm.content).toBeDefined();
      expect(cm.createdAt).toBeDefined();
    }
  });
});

/* ─────────────────────────────────────────────
   9. Coordination Summary (Admin View)
   ───────────────────────────────────────────── */
describe("Konferenz Step B – Coordination Summary", () => {
  test("returns structured summary", () => {
    // Create sessions with different patterns
    const cid1 = createTestSession({ conferenceMode: "work_chat" });
    sendCoordinatedConferenceMessage({
      conferenceId: cid1,
      userMessage: "Test work chat",
      targetAgent: "both",
    });

    const cid2 = createTestSession({ conferenceMode: "decision_mode" });
    sendCoordinatedConferenceMessage({
      conferenceId: cid2,
      userMessage: "Test decision mode",
      targetAgent: "both",
    });

    const summary = getConferenceCoordinationSummary();
    expect(summary).toBeDefined();
    expect(summary.totalSessions).toBeGreaterThanOrEqual(2);
    expect(summary.byCoordinationState).toBeDefined();
    expect(summary.byReplyPattern).toBeDefined();
    expect(summary.byPhaseStatus).toBeDefined();
    expect(summary.replyStats).toBeDefined();
    expect(summary.replyStats.totalCoordinatedReplies).toBeDefined();
    expect(summary.replyStats.totalSoloReplies).toBeDefined();
    expect(summary.replyStats.totalSupportingReplies).toBeDefined();
    expect(summary.replyStats.totalBundledReplies).toBeDefined();
    expect(summary.replyStats.totalClarificationRequests).toBeDefined();
    expect(summary.coordinationStats).toBeDefined();
    expect(summary.coordinationStats.totalLeadershipChanges).toBeDefined();
    expect(summary.coordinationStats.totalPhasesClosed).toBeDefined();
    expect(summary.coordinationStats.sessionsWithOpenPoints).toBeDefined();
    expect(summary.generatedAt).toBeDefined();
  });

  test("summary counts match actual session data", () => {
    const cid = createTestSession({ conferenceMode: "decision_mode" });
    sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Bundled test",
      targetAgent: "both",
    });
    sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Noch eine bundled Frage",
      targetAgent: "both",
    });

    const summary = getConferenceCoordinationSummary();
    expect(summary.replyStats.totalBundledReplies).toBeGreaterThanOrEqual(2);
  });
});

/* ─────────────────────────────────────────────
   10. Session Model Extension
   ───────────────────────────────────────────── */
describe("Konferenz Step B – Session Model Extension", () => {
  test("new session has Step B fields", () => {
    const cid = createTestSession();
    const session = getConferenceSession({ conferenceId: cid });
    expect(session).toBeDefined();
    expect(session.coordinationState).toBeDefined();
    expect(session.currentReplyPattern).toBeDefined();
    expect(session.currentPhaseStatus).toBeDefined();
    expect(session.phaseCount).toBeDefined();
    expect(session.coordinatedReplyCount).toBeDefined();
    expect(session.soloReplyCount).toBeDefined();
    expect(session.supportingReplyCount).toBeDefined();
    expect(session.bundledReplyCount).toBeDefined();
    expect(session.clarificationRequestCount).toBeDefined();
    expect(session.leadershipChangeCount).toBeDefined();
    expect(session.phasesClosedCount).toBeDefined();
    expect(session.openPointCount).toBeDefined();
  });

  test("reply counts increment correctly", () => {
    const cid = createTestSession({ conferenceMode: "decision_mode" });
    sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Bundled test",
      targetAgent: "both",
    });
    sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Solo test",
      targetAgent: "deepseek",
    });

    const session = getConferenceSession({ conferenceId: cid });
    expect(session.bundledReplyCount).toBeGreaterThanOrEqual(1);
    expect(session.soloReplyCount).toBeGreaterThanOrEqual(1);
  });
});

/* ─────────────────────────────────────────────
   11. Cross Agent Follow-up
   ───────────────────────────────────────────── */
describe("Konferenz Step B – Cross Agent Follow-up", () => {
  test("single agent target in problem_solving with recent other-agent reply → cross_agent_followup", () => {
    const cid = createTestSession({ conferenceMode: "problem_solving" });
    // Gemini replies first
    sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Frontend prüfen",
      targetAgent: "gemini",
    });
    // Now deepseek follows up
    const result = sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Backend prüfen",
      targetAgent: "deepseek",
    });
    expect(result.coordination.replyPattern).toBe("cross_agent_followup");
  });
});

/* ─────────────────────────────────────────────
   12. Backward Compatibility
   ───────────────────────────────────────────── */
describe("Konferenz Step B – Backward Compatibility", () => {
  test("Step A sendConferenceMessage still works", () => {
    const cid = createTestSession();
    const result = sendConferenceMessage({
      conferenceId: cid,
      userMessage: "Step A kompatibilität",
      targetAgent: "deepseek",
    });
    expect(result.success).toBe(true);
    expect(result.agentReplies.length).toBe(1);
  });

  test("Step A and Step B can be used on the same session", () => {
    const cid = createTestSession();
    // Step A message
    const r1 = sendConferenceMessage({
      conferenceId: cid,
      userMessage: "Step A Nachricht",
      targetAgent: "deepseek",
    });
    expect(r1.success).toBe(true);

    // Step B coordinated message
    const r2 = sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Step B koordinierte Nachricht",
      targetAgent: "both",
    });
    expect(r2.success).toBe(true);
    expect(r2.coordination).toBeDefined();
  });
});

/* ─────────────────────────────────────────────
   13. Response Structure Completeness
   ───────────────────────────────────────────── */
describe("Konferenz Step B – Response Structure", () => {
  test("coordinated message response has all expected fields", () => {
    const cid = createTestSession();
    const result = sendCoordinatedConferenceMessage({
      conferenceId: cid,
      userMessage: "Vollständige Antwort bitte",
      targetAgent: "deepseek",
    });
    expect(result.success).toBe(true);
    expect(result.conferenceId).toBe(cid);
    expect(result.conferenceStatus).toBeDefined();
    expect(result.conferenceMode).toBeDefined();
    expect(result.userMessage).toBeDefined();
    expect(result.userMessage.messageId).toBeDefined();
    expect(result.userMessage.replyPattern).toBeDefined();
    expect(Array.isArray(result.agentReplies)).toBe(true);
    expect(Array.isArray(result.coordinatorMessages)).toBe(true);
    expect(result.coordination).toBeDefined();
    expect(result.coordination.replyPattern).toBeDefined();
    expect(result.coordination.coordinationState).toBeDefined();
    expect(result.coordination.leadAgent).toBeDefined();
    expect(result.coordination.supportAgent).toBeDefined();
    expect(result.coordination.phaseStatus).toBeDefined();
    expect(result.coordination.openPointCount).toBeDefined();
    expect(result.routing).toBeDefined();
    expect(result.routing.targetAgent).toBeDefined();
    expect(result.routing.routingReason).toBeDefined();
    expect(result.messageCount).toBeDefined();
  });
});
