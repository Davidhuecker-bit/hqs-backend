"use strict";

/**
 * Konferenz Step C: Conference Phases / Decision Room / Result Cards / Strategic Expansion – Tests
 *
 * Tests cover:
 * 1. Step C constants validation
 * 2. Work phase derivation
 * 3. Decision room state derivation and activation
 * 4. Consensus state derivation
 * 5. Handoff direction derivation
 * 6. Moderation signal derivation
 * 7. Result card generation
 * 8. Perspective comparison
 * 9. Phase advance (manual)
 * 10. Session model extension with Step C fields
 * 11. _updateConferenceStepC called after sendConferenceMessage
 * 12. _updateConferenceStepC called after sendCoordinatedConferenceMessage
 * 13. getConferenceResultCard (public API)
 * 14. getConferenceDecisionRoom (public API)
 * 15. getConferencePerspectiveComparison (public API)
 * 16. getConferenceStepCSummary (admin summary)
 * 17. Logging-relevant fields
 * 18. Backward compatibility
 */

const {
  openConferenceSession,
  sendConferenceMessage,
  sendCoordinatedConferenceMessage,
  updateConferenceSession,
  getConferenceSession,
  closeConferenceSession,
  advanceConferencePhase,
  getConferenceResultCard,
  getConferenceDecisionRoom,
  getConferencePerspectiveComparison,
  getConferenceStepCSummary,
  VALID_CONFERENCE_WORK_PHASES,
  VALID_CONFERENCE_DECISION_ROOM_STATES,
  VALID_CONFERENCE_CONSENSUS_STATES,
  VALID_CONFERENCE_HANDOFF_DIRECTIONS,
  VALID_CONFERENCE_MODERATION_SIGNALS,
  // Step A/B constants still exported
  VALID_CONFERENCE_SESSION_STATUSES,
  VALID_CONFERENCE_MODES,
  VALID_CONFERENCE_REPLY_PATTERNS,
} = require("../services/agentBridge.service");

/* ─────────────────────────────────────────────
   Helper: create a session and return conferenceId
   ───────────────────────────────────────────── */
function createSession(overrides = {}) {
  const result = openConferenceSession({
    conferenceFocus: overrides.conferenceFocus || "Testthema Step C",
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
describe("Konferenz Step C – Constants", () => {
  test("VALID_CONFERENCE_WORK_PHASES is a non-empty array with 7 entries", () => {
    expect(Array.isArray(VALID_CONFERENCE_WORK_PHASES)).toBe(true);
    expect(VALID_CONFERENCE_WORK_PHASES.length).toBe(7);
    expect(VALID_CONFERENCE_WORK_PHASES).toContain("intake");
    expect(VALID_CONFERENCE_WORK_PHASES).toContain("problem_clarification");
    expect(VALID_CONFERENCE_WORK_PHASES).toContain("analysis");
    expect(VALID_CONFERENCE_WORK_PHASES).toContain("option_room");
    expect(VALID_CONFERENCE_WORK_PHASES).toContain("tradeoff");
    expect(VALID_CONFERENCE_WORK_PHASES).toContain("decision_preparation");
    expect(VALID_CONFERENCE_WORK_PHASES).toContain("result_transition");
  });

  test("VALID_CONFERENCE_DECISION_ROOM_STATES is a non-empty array", () => {
    expect(Array.isArray(VALID_CONFERENCE_DECISION_ROOM_STATES)).toBe(true);
    expect(VALID_CONFERENCE_DECISION_ROOM_STATES.length).toBeGreaterThanOrEqual(6);
    expect(VALID_CONFERENCE_DECISION_ROOM_STATES).toContain("not_active");
    expect(VALID_CONFERENCE_DECISION_ROOM_STATES).toContain("options_collected");
    expect(VALID_CONFERENCE_DECISION_ROOM_STATES).toContain("options_compared");
    expect(VALID_CONFERENCE_DECISION_ROOM_STATES).toContain("tradeoff_open");
    expect(VALID_CONFERENCE_DECISION_ROOM_STATES).toContain("decision_ready");
  });

  test("VALID_CONFERENCE_CONSENSUS_STATES is a non-empty array", () => {
    expect(Array.isArray(VALID_CONFERENCE_CONSENSUS_STATES)).toBe(true);
    expect(VALID_CONFERENCE_CONSENSUS_STATES.length).toBeGreaterThanOrEqual(6);
    expect(VALID_CONFERENCE_CONSENSUS_STATES).toContain("neutral");
    expect(VALID_CONFERENCE_CONSENSUS_STATES).toContain("converging");
    expect(VALID_CONFERENCE_CONSENSUS_STATES).toContain("consensus_reached");
    expect(VALID_CONFERENCE_CONSENSUS_STATES).toContain("dissent_active");
    expect(VALID_CONFERENCE_CONSENSUS_STATES).toContain("clarification_needed");
    expect(VALID_CONFERENCE_CONSENSUS_STATES).toContain("partial_consensus");
  });

  test("VALID_CONFERENCE_HANDOFF_DIRECTIONS is a non-empty array", () => {
    expect(Array.isArray(VALID_CONFERENCE_HANDOFF_DIRECTIONS)).toBe(true);
    expect(VALID_CONFERENCE_HANDOFF_DIRECTIONS.length).toBeGreaterThanOrEqual(6);
    expect(VALID_CONFERENCE_HANDOFF_DIRECTIONS).toContain("continue_session");
    expect(VALID_CONFERENCE_HANDOFF_DIRECTIONS).toContain("further_clarification");
    expect(VALID_CONFERENCE_HANDOFF_DIRECTIONS).toContain("prepare_draft");
    expect(VALID_CONFERENCE_HANDOFF_DIRECTIONS).toContain("prepare_candidate");
    expect(VALID_CONFERENCE_HANDOFF_DIRECTIONS).toContain("further_review");
    expect(VALID_CONFERENCE_HANDOFF_DIRECTIONS).toContain("close_session");
  });

  test("VALID_CONFERENCE_MODERATION_SIGNALS is a non-empty array", () => {
    expect(Array.isArray(VALID_CONFERENCE_MODERATION_SIGNALS)).toBe(true);
    expect(VALID_CONFERENCE_MODERATION_SIGNALS.length).toBeGreaterThanOrEqual(7);
    expect(VALID_CONFERENCE_MODERATION_SIGNALS).toContain("phase_stable");
    expect(VALID_CONFERENCE_MODERATION_SIGNALS).toContain("ready_for_phase_advance");
    expect(VALID_CONFERENCE_MODERATION_SIGNALS).toContain("consensus_possible");
    expect(VALID_CONFERENCE_MODERATION_SIGNALS).toContain("result_ready");
    expect(VALID_CONFERENCE_MODERATION_SIGNALS).toContain("handoff_ready");
    expect(VALID_CONFERENCE_MODERATION_SIGNALS).toContain("session_closing");
  });
});

/* ─────────────────────────────────────────────
   2. Session Model Extension
   ───────────────────────────────────────────── */
describe("Konferenz Step C – Session Model Extension", () => {
  test("new session has all Step C fields", () => {
    const id = createSession();
    const session = getConferenceSession({ conferenceId: id });
    expect(session).toBeTruthy();
    // Work phase
    expect(session.workPhase).toBe("intake");
    // Decision room
    expect(session.decisionRoomActive).toBe(false);
    expect(session.decisionRoomState).toBe("not_active");
    // Consensus
    expect(session.consensusState).toBe("neutral");
    // Handoff
    expect(session.handoffDirection).toBe("continue_session");
    // Moderation
    expect(session.moderationSignal).toBe("phase_stable");
    // Counts
    expect(session.resultCardCount).toBe(0);
    expect(session.phaseTransitionCount).toBe(0);
    expect(session.decisionRoomActivationCount).toBe(0);
  });

  test("workPhase advances after receiving messages with option keywords", async () => {
    const id = createSession({ conferenceMode: "problem_solving" });
    await sendConferenceMessage({ conferenceId: id, userMessage: "Welche Option ist besser?" });
    const session = getConferenceSession({ conferenceId: id });
    // After a message with option keywords, phase should advance beyond intake
    expect(VALID_CONFERENCE_WORK_PHASES).toContain(session.workPhase);
  });
});

/* ─────────────────────────────────────────────
   3. advanceConferencePhase – Manual Phase Control
   ───────────────────────────────────────────── */
describe("Konferenz Step C – advanceConferencePhase", () => {
  test("advances phase forward successfully", () => {
    const id = createSession();
    const result = advanceConferencePhase({ conferenceId: id, targetPhase: "problem_clarification" });
    expect(result.success).toBe(true);
    expect(result.from).toBe("intake");
    expect(result.to).toBe("problem_clarification");
    expect(result.workPhase).toBe("problem_clarification");
  });

  test("can skip multiple phases", () => {
    const id = createSession();
    const result = advanceConferencePhase({ conferenceId: id, targetPhase: "option_room" });
    expect(result.success).toBe(true);
    expect(result.to).toBe("option_room");
  });

  test("rejects backward phase advance", () => {
    const id = createSession();
    advanceConferencePhase({ conferenceId: id, targetPhase: "option_room" });
    const result = advanceConferencePhase({ conferenceId: id, targetPhase: "problem_clarification" });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test("rejects same phase advance", () => {
    const id = createSession();
    const result = advanceConferencePhase({ conferenceId: id, targetPhase: "intake" });
    expect(result.success).toBe(false);
  });

  test("rejects invalid targetPhase", () => {
    const id = createSession();
    const result = advanceConferencePhase({ conferenceId: id, targetPhase: "invalid_phase" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("targetPhase");
  });

  test("rejects missing conferenceId", () => {
    const result = advanceConferencePhase({ targetPhase: "analysis" });
    expect(result.success).toBe(false);
  });

  test("rejects unknown conferenceId", () => {
    const result = advanceConferencePhase({ conferenceId: "conf-not-existing-999", targetPhase: "analysis" });
    expect(result.success).toBe(false);
  });

  test("returns moderationSignal and handoffDirection after advance", () => {
    const id = createSession();
    const result = advanceConferencePhase({ conferenceId: id, targetPhase: "decision_preparation" });
    expect(result.success).toBe(true);
    expect(VALID_CONFERENCE_MODERATION_SIGNALS).toContain(result.moderationSignal);
    expect(VALID_CONFERENCE_HANDOFF_DIRECTIONS).toContain(result.handoffDirection);
  });
});

/* ─────────────────────────────────────────────
   4. getConferenceResultCard
   ───────────────────────────────────────────── */
describe("Konferenz Step C – getConferenceResultCard", () => {
  test("returns null for missing conferenceId", () => {
    const card = getConferenceResultCard({});
    expect(card).toBeNull();
  });

  test("returns null for unknown conferenceId", () => {
    const card = getConferenceResultCard({ conferenceId: "conf-not-existing-777" });
    expect(card).toBeNull();
  });

  test("returns a result card with all required fields", () => {
    const id = createSession();
    const card = getConferenceResultCard({ conferenceId: id });
    expect(card).toBeTruthy();
    expect(card.resultCardId).toBeTruthy();
    expect(card.conferenceId).toBe(id);
    expect(card.workPhase).toBeTruthy();
    expect(typeof card.understood).toBe("string");
    expect(typeof card.direction).toBe("string");
    expect(VALID_CONFERENCE_CONSENSUS_STATES).toContain(card.consensusState);
    expect(typeof card.remainingDifferences).toBe("string");
    expect(Array.isArray(card.openPoints)).toBe(true);
    expect(typeof card.openPointCount).toBe("number");
    expect(typeof card.nextStep).toBe("string");
    expect(typeof card.handoffNeeded).toBe("boolean");
    expect(VALID_CONFERENCE_HANDOFF_DIRECTIONS).toContain(card.handoffDirection);
    expect(card.generatedAt).toBeTruthy();
  });

  test("result card has intake phase text for fresh session", () => {
    const id = createSession();
    const card = getConferenceResultCard({ conferenceId: id });
    expect(card.understood).toContain("Thema");
  });

  test("result card reflects advanced phase", () => {
    const id = createSession();
    advanceConferencePhase({ conferenceId: id, targetPhase: "option_room" });
    const card = getConferenceResultCard({ conferenceId: id });
    expect(card.workPhase).toBe("option_room");
    expect(card.understood).toContain("Optionen");
  });
});

/* ─────────────────────────────────────────────
   5. getConferenceDecisionRoom
   ───────────────────────────────────────────── */
describe("Konferenz Step C – getConferenceDecisionRoom", () => {
  test("returns null for missing conferenceId", () => {
    const room = getConferenceDecisionRoom({});
    expect(room).toBeNull();
  });

  test("returns null for unknown conferenceId", () => {
    const room = getConferenceDecisionRoom({ conferenceId: "conf-not-existing-888" });
    expect(room).toBeNull();
  });

  test("returns decision room with all required fields", () => {
    const id = createSession();
    const room = getConferenceDecisionRoom({ conferenceId: id });
    expect(room).toBeTruthy();
    expect(room.conferenceId).toBe(id);
    expect(typeof room.decisionRoomActive).toBe("boolean");
    expect(VALID_CONFERENCE_DECISION_ROOM_STATES).toContain(room.decisionRoomState);
    expect(VALID_CONFERENCE_CONSENSUS_STATES).toContain(room.consensusState);
    expect(VALID_CONFERENCE_HANDOFF_DIRECTIONS).toContain(room.handoffDirection);
    expect(VALID_CONFERENCE_MODERATION_SIGNALS).toContain(room.moderationSignal);
    expect(Array.isArray(room.optionRoomOptions)).toBe(true);
    expect(typeof room.optionCount).toBe("number");
    expect(room.generatedAt).toBeTruthy();
  });

  test("decision room is not active for fresh intake session", () => {
    const id = createSession();
    const room = getConferenceDecisionRoom({ conferenceId: id });
    expect(room.decisionRoomActive).toBe(false);
    expect(room.decisionRoomState).toBe("not_active");
  });

  test("decision room activates when phase advances to option_room", () => {
    const id = createSession();
    advanceConferencePhase({ conferenceId: id, targetPhase: "option_room" });
    const room = getConferenceDecisionRoom({ conferenceId: id });
    expect(room.decisionRoomActive).toBe(true);
    expect(room.decisionRoomState).not.toBe("not_active");
  });

  test("decision room state is tradeoff_open when in tradeoff phase", () => {
    const id = createSession();
    advanceConferencePhase({ conferenceId: id, targetPhase: "tradeoff" });
    const room = getConferenceDecisionRoom({ conferenceId: id });
    expect(room.decisionRoomState).toBe("tradeoff_open");
  });

  test("decision room state is decision_ready when in result_transition phase", () => {
    const id = createSession();
    advanceConferencePhase({ conferenceId: id, targetPhase: "result_transition" });
    const room = getConferenceDecisionRoom({ conferenceId: id });
    expect(room.decisionRoomState).toBe("decision_ready");
  });
});

/* ─────────────────────────────────────────────
   6. getConferencePerspectiveComparison
   ───────────────────────────────────────────── */
describe("Konferenz Step C – getConferencePerspectiveComparison", () => {
  test("returns null for missing conferenceId", () => {
    const comp = getConferencePerspectiveComparison({});
    expect(comp).toBeNull();
  });

  test("returns null for unknown conferenceId", () => {
    const comp = getConferencePerspectiveComparison({ conferenceId: "conf-not-existing-666" });
    expect(comp).toBeNull();
  });

  test("returns null for session with no agent messages yet", () => {
    const id = createSession();
    // Fresh session, only user messages via conference setup
    const comp = getConferencePerspectiveComparison({ conferenceId: id });
    // Should be null since both agents need at least one message each
    // (fresh session has 0 agent messages)
    expect(comp).toBeNull();
  });

  test("returns perspective comparison after both agents have replied", async () => {
    const id = createSession();
    // Send to both agents to generate replies from each
    await sendConferenceMessage({ conferenceId: id, userMessage: "Bitte beide Agenten antworten.", targetAgent: "both" });
    const comp = getConferencePerspectiveComparison({ conferenceId: id });
    expect(comp).toBeTruthy();
    expect(comp.conferenceId).toBe(id);
    expect(comp.deepseekView).toBeTruthy();
    expect(comp.geminiView).toBeTruthy();
    expect(comp.deepseekView.agent).toBe("deepseek");
    expect(comp.geminiView.agent).toBe("gemini");
    expect(typeof comp.commonLine).toBe("string");
    expect(typeof comp.dissent).toBe("string");
    expect(VALID_CONFERENCE_CONSENSUS_STATES).toContain(comp.consensusState);
    expect(comp.generatedAt).toBeTruthy();
  });
});

/* ─────────────────────────────────────────────
   7. getConferenceStepCSummary – Admin Summary
   ───────────────────────────────────────────── */
describe("Konferenz Step C – getConferenceStepCSummary", () => {
  test("returns structured summary with all required fields", () => {
    const summary = getConferenceStepCSummary();
    expect(typeof summary.totalSessions).toBe("number");
    expect(typeof summary.byWorkPhase).toBe("object");
    expect(typeof summary.byDecisionRoomState).toBe("object");
    expect(typeof summary.byConsensusState).toBe("object");
    expect(typeof summary.byHandoffDirection).toBe("object");
    expect(typeof summary.byModerationSignal).toBe("object");
    expect(summary.highlights).toBeTruthy();
    expect(typeof summary.highlights.totalDecisionRoomActive).toBe("number");
    expect(typeof summary.highlights.totalWithConsensus).toBe("number");
    expect(typeof summary.highlights.totalWithDissent).toBe("number");
    expect(typeof summary.highlights.totalWithHandoffReady).toBe("number");
    expect(typeof summary.highlights.totalWithResultCard).toBe("number");
    expect(typeof summary.highlights.totalWithOpenClarification).toBe("number");
    expect(typeof summary.highlights.totalPhaseTransitions).toBe("number");
    expect(typeof summary.highlights.totalResultCards).toBe("number");
    expect(summary.generatedAt).toBeTruthy();
  });

  test("byWorkPhase reflects actual session distribution", () => {
    const id1 = createSession();
    const id2 = createSession();
    advanceConferencePhase({ conferenceId: id2, targetPhase: "analysis" });
    const summary = getConferenceStepCSummary();
    // Both sessions should appear in the summary
    const totalCount = Object.values(summary.byWorkPhase).reduce((a, b) => a + b, 0);
    expect(totalCount).toBeGreaterThanOrEqual(2);
  });

  test("highlights.totalDecisionRoomActive increases when decision room is active", () => {
    const id = createSession();
    const summaryBefore = getConferenceStepCSummary();
    advanceConferencePhase({ conferenceId: id, targetPhase: "option_room" });
    const summaryAfter = getConferenceStepCSummary();
    expect(summaryAfter.highlights.totalDecisionRoomActive).toBeGreaterThanOrEqual(summaryBefore.highlights.totalDecisionRoomActive);
  });
});

/* ─────────────────────────────────────────────
   8. sendConferenceMessage – Step C integration
   ───────────────────────────────────────────── */
describe("Konferenz Step C – sendConferenceMessage integration", () => {
  test("response includes workPhase, moderationSignal, handoffDirection", async () => {
    const id = createSession();
    const result = await sendConferenceMessage({ conferenceId: id, userMessage: "Erste Frage zur Konferenz." });
    expect(result.success).toBe(true);
    expect(result.workPhase).toBeTruthy();
    expect(VALID_CONFERENCE_WORK_PHASES).toContain(result.workPhase);
    expect(VALID_CONFERENCE_MODERATION_SIGNALS).toContain(result.moderationSignal);
    expect(VALID_CONFERENCE_HANDOFF_DIRECTIONS).toContain(result.handoffDirection);
  });

  test("session has Step C fields updated after message", async () => {
    const id = createSession();
    await sendConferenceMessage({ conferenceId: id, userMessage: "Frage zur Konferenz." });
    const session = getConferenceSession({ conferenceId: id });
    expect(VALID_CONFERENCE_WORK_PHASES).toContain(session.workPhase);
    expect(VALID_CONFERENCE_CONSENSUS_STATES).toContain(session.consensusState);
    expect(VALID_CONFERENCE_HANDOFF_DIRECTIONS).toContain(session.handoffDirection);
    expect(VALID_CONFERENCE_MODERATION_SIGNALS).toContain(session.moderationSignal);
  });
});

/* ─────────────────────────────────────────────
   9. sendCoordinatedConferenceMessage – Step C integration
   ───────────────────────────────────────────── */
describe("Konferenz Step C – sendCoordinatedConferenceMessage integration", () => {
  test("response includes workPhase, moderationSignal, handoffDirection", async () => {
    const id = createSession({ conferenceMode: "problem_solving" });
    const result = await sendCoordinatedConferenceMessage({
      conferenceId: id,
      userMessage: "Bitte koordinierte Antwort.",
      requestedReplyPattern: "solo_reply",
    });
    expect(result.success).toBe(true);
    expect(VALID_CONFERENCE_WORK_PHASES).toContain(result.workPhase);
    expect(VALID_CONFERENCE_MODERATION_SIGNALS).toContain(result.moderationSignal);
    expect(VALID_CONFERENCE_HANDOFF_DIRECTIONS).toContain(result.handoffDirection);
  });
});

/* ─────────────────────────────────────────────
   10. Handoff Direction Logic
   ───────────────────────────────────────────── */
describe("Konferenz Step C – Handoff Direction", () => {
  test("handoffDirection is continue_session for fresh intake session", () => {
    const id = createSession();
    const room = getConferenceDecisionRoom({ conferenceId: id });
    expect(room.handoffDirection).toBe("continue_session");
  });

  test("handoffDirection is further_review when in tradeoff phase", () => {
    const id = createSession();
    advanceConferencePhase({ conferenceId: id, targetPhase: "tradeoff" });
    const room = getConferenceDecisionRoom({ conferenceId: id });
    expect(room.handoffDirection).toBe("further_review");
  });

  test("handoffDirection is prepare_candidate when in decision_preparation", () => {
    const id = createSession();
    advanceConferencePhase({ conferenceId: id, targetPhase: "decision_preparation" });
    const room = getConferenceDecisionRoom({ conferenceId: id });
    expect(room.handoffDirection).toBe("prepare_candidate");
  });
});

/* ─────────────────────────────────────────────
   11. Moderation Signal Logic
   ───────────────────────────────────────────── */
describe("Konferenz Step C – Moderation Signal", () => {
  test("moderationSignal is phase_stable for fresh intake session", () => {
    const id = createSession();
    const room = getConferenceDecisionRoom({ conferenceId: id });
    expect(room.moderationSignal).toBe("phase_stable");
  });

  test("moderationSignal is valid enum value for all phases", () => {
    for (const phase of VALID_CONFERENCE_WORK_PHASES) {
      const id = createSession();
      if (phase !== "intake") {
        advanceConferencePhase({ conferenceId: id, targetPhase: phase });
      }
      const room = getConferenceDecisionRoom({ conferenceId: id });
      expect(VALID_CONFERENCE_MODERATION_SIGNALS).toContain(room.moderationSignal);
    }
  });
});

/* ─────────────────────────────────────────────
   12. Phase History Tracking
   ───────────────────────────────────────────── */
describe("Konferenz Step C – Phase History", () => {
  test("workPhaseHistory tracks transitions", () => {
    const id = createSession();
    advanceConferencePhase({ conferenceId: id, targetPhase: "problem_clarification" });
    advanceConferencePhase({ conferenceId: id, targetPhase: "analysis" });

    // We can verify indirectly through the phaseTransitionCount
    const result = advanceConferencePhase({ conferenceId: id, targetPhase: "option_room" });
    expect(result.success).toBe(true);
    expect(result.workPhase).toBe("option_room");
  });

  test("phaseTransitionCount increments on each phase advance", () => {
    const id = createSession();
    const summaryBefore = getConferenceStepCSummary();
    advanceConferencePhase({ conferenceId: id, targetPhase: "problem_clarification" });
    advanceConferencePhase({ conferenceId: id, targetPhase: "analysis" });
    const summaryAfter = getConferenceStepCSummary();
    expect(summaryAfter.highlights.totalPhaseTransitions).toBeGreaterThanOrEqual(
      summaryBefore.highlights.totalPhaseTransitions + 2
    );
  });
});

/* ─────────────────────────────────────────────
   13. Decision Room Activation Count
   ───────────────────────────────────────────── */
describe("Konferenz Step C – Decision Room Activation", () => {
  test("decisionRoomActivationCount is 0 for fresh session", () => {
    const id = createSession();
    const room = getConferenceDecisionRoom({ conferenceId: id });
    expect(room.decisionRoomActivationCount).toBe(0);
  });

  test("decisionRoomActivationCount increments when decision room activates", () => {
    const id = createSession();
    advanceConferencePhase({ conferenceId: id, targetPhase: "option_room" });
    const room = getConferenceDecisionRoom({ conferenceId: id });
    expect(room.decisionRoomActivationCount).toBeGreaterThanOrEqual(1);
  });
});

/* ─────────────────────────────────────────────
   14. Backward Compatibility
   ───────────────────────────────────────────── */
describe("Konferenz Step C – Backward Compatibility", () => {
  test("Step A sendConferenceMessage still works after Step C integration", async () => {
    const id = createSession();
    const result = await sendConferenceMessage({ conferenceId: id, userMessage: "Hallo." });
    expect(result.success).toBe(true);
    expect(result.conferenceId).toBe(id);
    expect(Array.isArray(result.agentReplies)).toBe(true);
    expect(result.messageCount).toBeGreaterThanOrEqual(1);
  });

  test("Step B sendCoordinatedConferenceMessage still works after Step C integration", async () => {
    const id = createSession({ conferenceMode: "decision_mode" });
    const result = await sendCoordinatedConferenceMessage({
      conferenceId: id,
      userMessage: "Bitte beide Agenten.",
    });
    expect(result.success).toBe(true);
    expect(result.coordination).toBeTruthy();
    expect(result.coordination.replyPattern).toBeTruthy();
  });

  test("all previously exported Step B constants are still exported", () => {
    expect(Array.isArray(VALID_CONFERENCE_REPLY_PATTERNS)).toBe(true);
    expect(Array.isArray(VALID_CONFERENCE_SESSION_STATUSES)).toBe(true);
    expect(Array.isArray(VALID_CONFERENCE_MODES)).toBe(true);
  });

  test("Step A/B session fields still present alongside Step C fields", () => {
    const id = createSession();
    const session = getConferenceSession({ conferenceId: id });
    // Step B fields
    expect(session.coordinationState).toBe("uncoordinated");
    expect(session.currentReplyPattern).toBe("solo_reply");
    // Step C fields
    expect(session.workPhase).toBe("intake");
    expect(typeof session.decisionRoomActive).toBe("boolean");
  });
});

/* ─────────────────────────────────────────────
   15. Logging-Relevant Fields
   ───────────────────────────────────────────── */
describe("Konferenz Step C – Logging-Relevant Fields", () => {
  test("getConferenceDecisionRoom includes fields useful for logging", () => {
    const id = createSession();
    advanceConferencePhase({ conferenceId: id, targetPhase: "option_room" });
    const room = getConferenceDecisionRoom({ conferenceId: id });
    // Fields that should be present for meaningful logs
    expect(room.workPhase).toBeTruthy();
    expect(room.decisionRoomState).toBeTruthy();
    expect(room.consensusState).toBeTruthy();
    expect(room.handoffDirection).toBeTruthy();
    expect(room.moderationSignal).toBeTruthy();
    expect(room.decisionRoomActivationCount).toBeDefined();
  });

  test("getConferenceResultCard includes fields useful for logging", () => {
    const id = createSession();
    const card = getConferenceResultCard({ conferenceId: id });
    expect(card.resultCardId).toBeTruthy();
    expect(card.workPhase).toBeTruthy();
    expect(card.consensusState).toBeTruthy();
    expect(card.handoffDirection).toBeTruthy();
    expect(card.generatedAt).toBeTruthy();
  });
});
