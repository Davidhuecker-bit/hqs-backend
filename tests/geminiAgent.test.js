"use strict";

/**
 * Gemini Agent – Multi-Turn Conversation / Change Mode
 *
 * Tests cover:
 *  - Constants exported correctly
 *  - Conversation creation (startConversation)
 *  - Conversation retrieval (getConversation)
 *  - Follow-up / multi-turn (continueConversation)
 *  - Action intents (explain, analyze, propose_change, prepare_patch)
 *  - Execute change with approval gate
 *  - Path safety checks
 *  - Response schema structure
 *  - Input validation / error handling
 *  - Mode validation
 */

/* ─────────────────────────────────────────────
   Mock runGeminiChat before requiring the service
   ───────────────────────────────────────────── */

let mockGeminiChatResult = { success: true, text: "Mock-Antwort von Gemini." };

jest.mock("../services/geminiArchitect.service", () => ({
  isGeminiConfigured: jest.fn(() => true),
  runGeminiChat: jest.fn(async () => mockGeminiChatResult),
  VALID_MODES: ["layout_review", "presentation_review", "frontend_guard", "priority_review"],
  RESULT_TYPES: { SUCCESS: "success" },
  FALLBACK_LABELS: {},
}));

const {
  startConversation,
  continueConversation,
  getConversation,
  VALID_ACTION_INTENTS,
  VALID_AGENT_MODES,
  MODE_ALIASES,
  VALID_CONVERSATION_STATUSES,
  ALLOWED_PROJECT_PATHS,
} = require("../services/geminiAgent.service");

const { isGeminiConfigured, runGeminiChat } = require("../services/geminiArchitect.service");

/* ─────────────────────────────────────────────
   Reset mocks before each test
   ───────────────────────────────────────────── */

beforeEach(() => {
  jest.clearAllMocks();
  mockGeminiChatResult = { success: true, text: "Mock-Antwort von Gemini." };
  isGeminiConfigured.mockReturnValue(true);
});

/* ─────────────────────────────────────────────
   Constants
   ───────────────────────────────────────────── */

describe("Gemini Agent – Constants", () => {
  test("VALID_ACTION_INTENTS has expected entries", () => {
    expect(Array.isArray(VALID_ACTION_INTENTS)).toBe(true);
    expect(VALID_ACTION_INTENTS.length).toBe(10);
    expect(VALID_ACTION_INTENTS).toContain("explain");
    expect(VALID_ACTION_INTENTS).toContain("analyze");
    expect(VALID_ACTION_INTENTS).toContain("diagnose");
    expect(VALID_ACTION_INTENTS).toContain("inspect_files");
    expect(VALID_ACTION_INTENTS).toContain("propose_change");
    expect(VALID_ACTION_INTENTS).toContain("prepare_patch");
    expect(VALID_ACTION_INTENTS).toContain("dry_run");
    expect(VALID_ACTION_INTENTS).toContain("execute_change");
    expect(VALID_ACTION_INTENTS).toContain("verify_fix");
    expect(VALID_ACTION_INTENTS).toContain("plan_fix");
    expect(VALID_AGENT_MODES).toContain("free_chat");
    expect(VALID_AGENT_MODES).toContain("change_mode");
    expect(VALID_AGENT_MODES).toContain("layout_review");
    expect(VALID_AGENT_MODES).toContain("darstellung");
    expect(VALID_AGENT_MODES).toContain("frontend_guard");
    expect(VALID_AGENT_MODES).toContain("priorisierung");
    expect(VALID_AGENT_MODES).toContain("code_review");
    expect(VALID_AGENT_MODES).toContain("architecture");
  });

  test("VALID_CONVERSATION_STATUSES has expected entries", () => {
    expect(Array.isArray(VALID_CONVERSATION_STATUSES)).toBe(true);
    expect(VALID_CONVERSATION_STATUSES.length).toBe(8);
    expect(VALID_CONVERSATION_STATUSES).toContain("active");
    expect(VALID_CONVERSATION_STATUSES).toContain("waiting_for_user");
    expect(VALID_CONVERSATION_STATUSES).toContain("change_proposed");
    expect(VALID_CONVERSATION_STATUSES).toContain("patch_prepared");
    expect(VALID_CONVERSATION_STATUSES).toContain("dry_run_completed");
    expect(VALID_CONVERSATION_STATUSES).toContain("executing");
    expect(VALID_CONVERSATION_STATUSES).toContain("completed");
    expect(VALID_CONVERSATION_STATUSES).toContain("error");
  });

  test("ALLOWED_PROJECT_PATHS is a non-empty array of strings", () => {
    expect(Array.isArray(ALLOWED_PROJECT_PATHS)).toBe(true);
    expect(ALLOWED_PROJECT_PATHS.length).toBeGreaterThan(0);
    for (const p of ALLOWED_PROJECT_PATHS) {
      expect(typeof p).toBe("string");
      expect(p.endsWith("/")).toBe(true);
    }
  });

  test("MODE_ALIASES maps presentation_review to darstellung", () => {
    expect(MODE_ALIASES).toBeDefined();
    expect(MODE_ALIASES["presentation_review"]).toBe("darstellung");
  });

  test("MODE_ALIASES maps priority_review to priorisierung", () => {
    expect(MODE_ALIASES["priority_review"]).toBe("priorisierung");
  });
});

/* ─────────────────────────────────────────────
   startConversation
   ───────────────────────────────────────────── */

describe("Gemini Agent – startConversation", () => {
  test("creates a conversation with valid inputs", async () => {
    const result = await startConversation({
      mode: "free_chat",
      message: "Hallo, wie funktioniert das Layout?",
    });

    expect(result.conversationId).toBeTruthy();
    expect(result.conversationId).toMatch(/^gemini-conv-/);
    expect(result.mode).toBe("free_chat");
    expect(result.status).toBe("waiting_for_user");
    expect(result.followUpPossible).toBe(true);
    expect(result.assistantReply).toBeTruthy();
    expect(result.metadata).toBeDefined();
    expect(result.metadata.isInitial).toBe(true);
    expect(result.metadata.messageCount).toBeGreaterThanOrEqual(2);
    expect(result.approved).toBe(false);
    expect(result.requiresApproval).toBe(false);
  });

  test("returns error for invalid mode", async () => {
    const result = await startConversation({
      mode: "invalid_mode",
      message: "Test",
    });

    expect(result.status).toBe("error");
    expect(result.assistantReply).toMatch(/Ungültiger Modus/);
    expect(result.errorCode).toBe("INVALID_MODE");
  });

  test("maps presentation_review alias to darstellung mode", async () => {
    const result = await startConversation({
      mode: "presentation_review",
      message: "Prüfe die Darstellung.",
    });

    expect(result.status).toBe("waiting_for_user");
    expect(result.mode).toBe("darstellung");
    expect(result.errorCode).toBeUndefined();
  });

  test("maps priority_review alias to priorisierung mode", async () => {
    const result = await startConversation({
      mode: "priority_review",
      message: "Prüfe die Priorisierung.",
    });

    expect(result.status).toBe("waiting_for_user");
    expect(result.mode).toBe("priorisierung");
    expect(result.errorCode).toBeUndefined();
  });

  test("returns error for empty message", async () => {
    const result = await startConversation({
      mode: "free_chat",
      message: "",
    });

    expect(result.status).toBe("error");
    expect(result.assistantReply).toMatch(/nicht leer/);
  });

  test("returns error when Gemini not configured", async () => {
    isGeminiConfigured.mockReturnValue(false);

    const result = await startConversation({
      mode: "free_chat",
      message: "Test",
    });

    expect(result.status).toBe("error");
    expect(result.assistantReply).toMatch(/nicht konfiguriert/);
  });

  test("passes actionIntent correctly", async () => {
    const result = await startConversation({
      mode: "free_chat",
      message: "Erkläre das Layout.",
      actionIntent: "explain",
    });

    expect(result.actionIntent).toBe("explain");
    expect(result.status).toBe("waiting_for_user");
  });

  test("includes optional context in history", async () => {
    const result = await startConversation({
      mode: "free_chat",
      message: "Test",
      context: "Admin-Dashboard Kontext",
    });

    expect(result.conversationId).toBeTruthy();
    // Context adds a system message, so messageCount >= 3
    expect(result.metadata.messageCount).toBeGreaterThanOrEqual(3);
  });

  test("handles Gemini API failure gracefully", async () => {
    mockGeminiChatResult = { success: false, text: "", error: "API_ERROR" };

    const result = await startConversation({
      mode: "free_chat",
      message: "Test",
    });

    expect(result.status).toBe("error");
    expect(result.assistantReply).toMatch(/Gemini-Fehler/);
  });

  test("propose_change sets conversation status", async () => {
    mockGeminiChatResult = {
      success: true,
      text: JSON.stringify({
        proposedChanges: [
          { file: "src/App.js", description: "Layout fix", risk: "low", priority: 1 },
        ],
        summary: "Test",
        riskAssessment: "Niedrig",
      }),
    };

    const result = await startConversation({
      mode: "change_mode",
      message: "Ändere das Layout.",
      actionIntent: "propose_change",
    });

    expect(result.status).toBe("change_proposed");
    expect(result.proposedChanges).toBeDefined();
    expect(result.proposedChanges.length).toBe(1);
    expect(result.proposedChanges[0].file).toBe("src/App.js");
  });

  test("prepare_patch sets status to patch_prepared", async () => {
    mockGeminiChatResult = {
      success: true,
      text: JSON.stringify({
        editPlan: [
          {
            file: "src/App.js",
            operation: "replace",
            oldContent: "const x = 1;",
            newContent: "const x = 2;",
            description: "Test replace",
          },
        ],
        summary: "Test patch",
        warnings: [],
      }),
    };

    const result = await startConversation({
      mode: "change_mode",
      message: "Bereite den Patch vor.",
      actionIntent: "prepare_patch",
    });

    expect(result.status).toBe("patch_prepared");
    expect(result.preparedPatch).toBeDefined();
    expect(result.preparedPatch.editPlan.length).toBe(1);
    expect(result.requiresApproval).toBe(true);
  });
});

/* ─────────────────────────────────────────────
   getConversation
   ───────────────────────────────────────────── */

describe("Gemini Agent – getConversation", () => {
  test("retrieves an existing conversation", async () => {
    const created = await startConversation({
      mode: "free_chat",
      message: "Test-Nachricht",
    });

    const conv = getConversation(created.conversationId);

    expect(conv).not.toBeNull();
    expect(conv.conversationId).toBe(created.conversationId);
    expect(conv.mode).toBe("free_chat");
    expect(conv.messageCount).toBeGreaterThanOrEqual(2);
    expect(conv.messages.length).toBeGreaterThanOrEqual(2);
  });

  test("returns null for unknown conversation", () => {
    const conv = getConversation("non-existent-id");
    expect(conv).toBeNull();
  });
});

/* ─────────────────────────────────────────────
   continueConversation
   ───────────────────────────────────────────── */

describe("Gemini Agent – continueConversation", () => {
  test("continues an existing conversation", async () => {
    const created = await startConversation({
      mode: "free_chat",
      message: "Erste Nachricht",
    });

    const followUp = await continueConversation({
      conversationId: created.conversationId,
      message: "Folgefrage zum Layout",
    });

    expect(followUp.conversationId).toBe(created.conversationId);
    expect(followUp.status).toBe("waiting_for_user");
    expect(followUp.metadata.isInitial).toBe(false);
    expect(followUp.metadata.messageCount).toBeGreaterThan(created.metadata.messageCount);
  });

  test("returns error for unknown conversation", async () => {
    const result = await continueConversation({
      conversationId: "does-not-exist",
      message: "Hallo",
    });

    expect(result.status).toBe("error");
    expect(result.assistantReply).toMatch(/nicht gefunden/);
  });

  test("returns error for empty message", async () => {
    const created = await startConversation({
      mode: "free_chat",
      message: "Test",
    });

    const result = await continueConversation({
      conversationId: created.conversationId,
      message: "",
    });

    expect(result.assistantReply).toMatch(/nicht leer/);
  });

  test("allows switching actionIntent mid-conversation", async () => {
    const created = await startConversation({
      mode: "free_chat",
      message: "Erster Schritt",
      actionIntent: "explain",
    });

    mockGeminiChatResult = {
      success: true,
      text: JSON.stringify({
        proposedChanges: [
          { file: "src/test.js", description: "Fix", risk: "low", priority: 1 },
        ],
        summary: "Change",
        riskAssessment: "Niedrig",
      }),
    };

    const followUp = await continueConversation({
      conversationId: created.conversationId,
      message: "Jetzt ändere das bitte.",
      actionIntent: "propose_change",
    });

    expect(followUp.actionIntent).toBe("propose_change");
    expect(followUp.status).toBe("change_proposed");
    expect(followUp.proposedChanges.length).toBeGreaterThan(0);
  });

  test("Gemini failure mid-conversation is handled", async () => {
    const created = await startConversation({
      mode: "free_chat",
      message: "Test",
    });

    mockGeminiChatResult = { success: false, text: "", error: "TIMEOUT" };

    const followUp = await continueConversation({
      conversationId: created.conversationId,
      message: "Nächste Frage",
    });

    expect(followUp.status).toBe("error");
    expect(followUp.assistantReply).toMatch(/Gemini-Fehler/);
  });
});

/* ─────────────────────────────────────────────
   Execute change – approval gate
   ───────────────────────────────────────────── */

describe("Gemini Agent – execute_change approval gate", () => {
  let conversationId;

  beforeEach(async () => {
    // Create a conversation with a prepared patch
    mockGeminiChatResult = {
      success: true,
      text: JSON.stringify({
        editPlan: [
          {
            file: "src/test.js",
            operation: "replace",
            oldContent: "old",
            newContent: "new",
            description: "Test",
          },
        ],
        summary: "Patch",
        warnings: [],
      }),
    };

    const created = await startConversation({
      mode: "change_mode",
      message: "Bereite Patch vor.",
      actionIntent: "prepare_patch",
    });

    conversationId = created.conversationId;
    expect(created.status).toBe("patch_prepared");
  });

  test("rejects execution without approved=true", async () => {
    const result = await continueConversation({
      conversationId,
      message: "Führe aus.",
      actionIntent: "execute_change",
      confirmExecution: true,
      approved: false,
    });

    expect(result.assistantReply).toMatch(/Freigabe/);
    expect(result.approved).toBe(false);
  });

  test("rejects execution when approved is missing", async () => {
    const result = await continueConversation({
      conversationId,
      message: "Führe aus.",
      actionIntent: "execute_change",
      confirmExecution: true,
    });

    expect(result.assistantReply).toMatch(/Freigabe/);
  });

  test("attempts execution with approved=true (file not found is expected)", async () => {
    // The test file src/test.js does not exist so execution will fail, but the
    // point is the approval gate is passed and execution is attempted.
    const result = await continueConversation({
      conversationId,
      message: "Jetzt ausführen.",
      actionIntent: "execute_change",
      confirmExecution: true,
      approved: true,
    });

    expect(result.approved).toBe(true);
    // Execution was attempted (status is completed or error depending on fs)
    expect(["completed", "error"]).toContain(result.status);
    expect(result.executionResult).toBeDefined();
  });
});

/* ─────────────────────────────────────────────
   Response schema
   ───────────────────────────────────────────── */

describe("Gemini Agent – Response schema", () => {
  test("startConversation response has all required fields", async () => {
    const result = await startConversation({
      mode: "free_chat",
      message: "Schema test",
    });

    expect(result).toHaveProperty("conversationId");
    expect(result).toHaveProperty("mode");
    expect(result).toHaveProperty("actionIntent");
    expect(result).toHaveProperty("status");
    expect(result).toHaveProperty("followUpPossible");
    expect(result).toHaveProperty("assistantReply");
    expect(result).toHaveProperty("metadata");
    expect(result).toHaveProperty("proposedChanges");
    expect(result).toHaveProperty("preparedPatch");
    expect(result).toHaveProperty("executionResult");
    expect(result).toHaveProperty("requiresApproval");
    expect(result).toHaveProperty("approved");
    expect(result).toHaveProperty("changedFiles");
  });

  test("metadata has expected fields", async () => {
    const result = await startConversation({
      mode: "free_chat",
      message: "Metadata test",
    });

    expect(result.metadata).toHaveProperty("model");
    expect(result.metadata).toHaveProperty("apiVersion");
    expect(result.metadata).toHaveProperty("messageCount");
    expect(result.metadata).toHaveProperty("historyLength");
    expect(result.metadata).toHaveProperty("isInitial");
    expect(result.metadata).toHaveProperty("timestamp");
  });
});

/* ─────────────────────────────────────────────
   Multi-turn context
   ───────────────────────────────────────────── */

describe("Gemini Agent – Multi-turn context", () => {
  test("conversation history accumulates across follow-ups", async () => {
    const created = await startConversation({
      mode: "free_chat",
      message: "Nachricht 1",
    });

    await continueConversation({
      conversationId: created.conversationId,
      message: "Nachricht 2",
    });

    await continueConversation({
      conversationId: created.conversationId,
      message: "Nachricht 3",
    });

    const conv = getConversation(created.conversationId);

    // user msg 1 + assistant reply 1 + user msg 2 + assistant reply 2 + user msg 3 + assistant reply 3
    expect(conv.messages.length).toBeGreaterThanOrEqual(6);
    expect(conv.messageCount).toBeGreaterThanOrEqual(6);
  });

  test("Gemini receives history in follow-up calls", async () => {
    const created = await startConversation({
      mode: "free_chat",
      message: "Erste Frage zum Layout",
    });

    await continueConversation({
      conversationId: created.conversationId,
      message: "Zweite Frage",
    });

    // runGeminiChat should have been called with structured history
    const lastCall = runGeminiChat.mock.calls[runGeminiChat.mock.calls.length - 1];
    expect(lastCall).toBeDefined();
    const callOpts = lastCall[0];
    // History is now passed as a structured array, not flattened into userMessage
    expect(Array.isArray(callOpts.history)).toBe(true);
    expect(callOpts.history.length).toBeGreaterThanOrEqual(1);
    // The latest user message is the current turn
    expect(callOpts.userMessage).toContain("Zweite Frage");
    // History should contain the earlier conversation turns
    const historyTexts = callOpts.history.map((h) => h.parts.map((p) => p.text).join("")).join(" ");
    expect(historyTexts).toContain("Erste Frage zum Layout");
  });
});

/* ─────────────────────────────────────────────
   Edge cases
   ───────────────────────────────────────────── */

describe("Gemini Agent – Edge cases", () => {
  test("handles null/undefined inputs gracefully", async () => {
    const r1 = await startConversation({});
    expect(r1.status).toBe("error");

    const r2 = await startConversation(null);
    expect(r2.status).toBe("error");

    const r3 = await continueConversation({});
    expect(r3.status).toBe("error");
  });

  test("invalid actionIntent is silently ignored", async () => {
    const result = await startConversation({
      mode: "free_chat",
      message: "Test",
      actionIntent: "invalid_intent",
    });

    expect(result.actionIntent).toBeNull();
    expect(result.status).toBe("waiting_for_user");
  });

  test("propose_change with non-JSON Gemini response returns empty proposals", async () => {
    mockGeminiChatResult = {
      success: true,
      text: "Dies ist keine JSON-Antwort, sondern normaler Text.",
    };

    const result = await startConversation({
      mode: "change_mode",
      message: "Ändere etwas.",
      actionIntent: "propose_change",
    });

    // No parsed JSON, so proposedChanges should be empty
    expect(result.proposedChanges).toEqual([]);
    expect(result.status).toBe("active");
  });

  test("continueConversation when Gemini not configured", async () => {
    const created = await startConversation({
      mode: "free_chat",
      message: "Test",
    });

    isGeminiConfigured.mockReturnValue(false);

    const result = await continueConversation({
      conversationId: created.conversationId,
      message: "Folge",
    });

    expect(result.assistantReply).toMatch(/nicht konfiguriert/);
  });
});
