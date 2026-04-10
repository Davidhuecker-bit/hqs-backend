"use strict";

/**
 * DeepSeek Agent – Multi-Turn Conversation / Change Mode
 *
 * Tests cover:
 *  - Constants exported correctly
 *  - Conversation creation (startConversation)
 *  - Conversation retrieval (getConversation)
 *  - Follow-up / multi-turn (continueConversation)
 *  - Action intents (explain, analyze, propose_change, prepare_patch, dry_run)
 *  - Execute change with approval gate
 *  - Dry run validation
 *  - Path safety checks
 *  - Response schema structure
 *  - Input validation / error handling
 *  - Mode validation
 *  - dryRun flag on execute-change gate
 */

/* ─────────────────────────────────────────────
   Mock DeepSeek service before requiring the agent
   ───────────────────────────────────────────── */

let mockDeepSeekCompletion = {
  choices: [{ message: { content: "Mock-Antwort von DeepSeek." } }],
};

jest.mock("../services/deepseek.service", () => ({
  isDeepSeekConfigured: jest.fn(() => true),
  createDeepSeekChatCompletion: jest.fn(async () => mockDeepSeekCompletion),
  extractDeepSeekText: jest.fn((completion) => {
    if (!completion || !completion.choices || !completion.choices[0]) return "";
    return completion.choices[0].message?.content || completion.choices[0].message?.reasoning_content || "";
  }),
  resolveModel: jest.fn(() => "deepseek-chat"),
  DEEPSEEK_FAST_MODEL: "deepseek-chat",
  DEEPSEEK_DEEP_MODEL: "deepseek-reasoner",
  getDeepSeekClient: jest.fn(),
  runDeepSeekJsonAnalysis: jest.fn(),
}));

const {
  startConversation,
  continueConversation,
  getConversation,
  VALID_ACTION_INTENTS,
  VALID_AGENT_MODES,
  VALID_CONVERSATION_STATUSES,
  ALLOWED_PROJECT_PATHS,
  _isPathAllowed,
  _dryRunChanges,
} = require("../services/deepseekAgent.service");

const { isDeepSeekConfigured, createDeepSeekChatCompletion, extractDeepSeekText } = require("../services/deepseek.service");

/* ─────────────────────────────────────────────
   Reset mocks before each test
   ───────────────────────────────────────────── */

beforeEach(() => {
  jest.clearAllMocks();
  mockDeepSeekCompletion = {
    choices: [{ message: { content: "Mock-Antwort von DeepSeek." } }],
  };
  isDeepSeekConfigured.mockReturnValue(true);
  createDeepSeekChatCompletion.mockImplementation(async () => mockDeepSeekCompletion);
  extractDeepSeekText.mockImplementation((completion) => {
    if (!completion || !completion.choices || !completion.choices[0]) return "";
    return completion.choices[0].message?.content || completion.choices[0].message?.reasoning_content || "";
  });
});

/* ─────────────────────────────────────────────
   Constants
   ───────────────────────────────────────────── */

describe("DeepSeek Agent – Constants", () => {
  test("VALID_ACTION_INTENTS has expected entries", () => {
    expect(Array.isArray(VALID_ACTION_INTENTS)).toBe(true);
    expect(VALID_ACTION_INTENTS.length).toBe(6);
    expect(VALID_ACTION_INTENTS).toContain("explain");
    expect(VALID_ACTION_INTENTS).toContain("analyze");
    expect(VALID_ACTION_INTENTS).toContain("propose_change");
    expect(VALID_ACTION_INTENTS).toContain("prepare_patch");
    expect(VALID_ACTION_INTENTS).toContain("dry_run");
    expect(VALID_ACTION_INTENTS).toContain("execute_change");
  });

  test("VALID_AGENT_MODES has expected entries", () => {
    expect(Array.isArray(VALID_AGENT_MODES)).toBe(true);
    expect(VALID_AGENT_MODES.length).toBe(9);
    expect(VALID_AGENT_MODES).toContain("free_chat");
    expect(VALID_AGENT_MODES).toContain("change_mode");
    expect(VALID_AGENT_MODES).toContain("backend_review");
    expect(VALID_AGENT_MODES).toContain("api_review");
    expect(VALID_AGENT_MODES).toContain("system_diagnostics");
    expect(VALID_AGENT_MODES).toContain("code_review");
    expect(VALID_AGENT_MODES).toContain("architecture");
    expect(VALID_AGENT_MODES).toContain("security_review");
    expect(VALID_AGENT_MODES).toContain("performance");
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
});

/* ─────────────────────────────────────────────
   Path safety
   ───────────────────────────────────────────── */

describe("DeepSeek Agent – Path safety", () => {
  test("allows valid project paths", () => {
    expect(_isPathAllowed("src/App.js")).toBe(true);
    expect(_isPathAllowed("services/test.service.js")).toBe(true);
    expect(_isPathAllowed("routes/admin.routes.js")).toBe(true);
    expect(_isPathAllowed("utils/logger.js")).toBe(true);
  });

  test("blocks paths outside project", () => {
    expect(_isPathAllowed("../../etc/passwd")).toBe(false);
    expect(_isPathAllowed("../secret.txt")).toBe(false);
  });

  test("blocks dangerous patterns", () => {
    expect(_isPathAllowed(".env")).toBe(false);
    expect(_isPathAllowed("node_modules/something")).toBe(false);
    expect(_isPathAllowed(".git/config")).toBe(false);
    expect(_isPathAllowed("secrets/api.key")).toBe(false);
    expect(_isPathAllowed("credentials/db.json")).toBe(false);
  });

  test("rejects null/undefined/empty", () => {
    expect(_isPathAllowed(null)).toBe(false);
    expect(_isPathAllowed(undefined)).toBe(false);
    expect(_isPathAllowed("")).toBe(false);
    expect(_isPathAllowed(123)).toBe(false);
  });
});

/* ─────────────────────────────────────────────
   startConversation
   ───────────────────────────────────────────── */

describe("DeepSeek Agent – startConversation", () => {
  test("creates a conversation with valid inputs", async () => {
    const result = await startConversation({
      mode: "free_chat",
      message: "Hallo, wie funktioniert die API?",
    });

    expect(result.conversationId).toBeTruthy();
    expect(result.conversationId).toMatch(/^deepseek-conv-/);
    expect(result.mode).toBe("free_chat");
    expect(result.status).toBe("waiting_for_user");
    expect(result.followUpPossible).toBe(true);
    expect(result.assistantReply).toBeTruthy();
    expect(result.metadata).toBeDefined();
    expect(result.metadata.isInitial).toBe(true);
    expect(result.metadata.messageCount).toBeGreaterThanOrEqual(2);
    expect(result.approved).toBe(false);
    expect(result.requiresApproval).toBe(false);
    expect(result.dryRunResult).toBeNull();
  });

  test("returns error for invalid mode", async () => {
    const result = await startConversation({
      mode: "invalid_mode",
      message: "Test",
    });

    expect(result.status).toBe("error");
    expect(result.assistantReply).toMatch(/Ungültiger Modus/);
  });

  test("returns error for empty message", async () => {
    const result = await startConversation({
      mode: "free_chat",
      message: "",
    });

    expect(result.status).toBe("error");
    expect(result.assistantReply).toMatch(/nicht leer/);
  });

  test("returns error when DeepSeek not configured", async () => {
    isDeepSeekConfigured.mockReturnValue(false);

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
      message: "Erkläre die API.",
      actionIntent: "explain",
    });

    expect(result.actionIntent).toBe("explain");
    expect(result.status).toBe("waiting_for_user");
  });

  test("includes optional context in history", async () => {
    const result = await startConversation({
      mode: "free_chat",
      message: "Test",
      context: "Backend-Service Kontext",
    });

    expect(result.conversationId).toBeTruthy();
    expect(result.metadata.messageCount).toBeGreaterThanOrEqual(3);
  });

  test("handles DeepSeek API failure gracefully", async () => {
    createDeepSeekChatCompletion.mockRejectedValue(new Error("API_ERROR"));

    const result = await startConversation({
      mode: "free_chat",
      message: "Test",
    });

    expect(result.status).toBe("error");
    expect(result.assistantReply).toMatch(/Fehler|DeepSeek/);
  });

  test("propose_change sets conversation status", async () => {
    mockDeepSeekCompletion = {
      choices: [{
        message: {
          content: JSON.stringify({
            proposedChanges: [
              { file: "services/test.service.js", description: "API fix", risk: "low", priority: 1 },
            ],
            summary: "Test",
            riskAssessment: "Niedrig",
          }),
        },
      }],
    };

    const result = await startConversation({
      mode: "change_mode",
      message: "Ändere den Service.",
      actionIntent: "propose_change",
    });

    expect(result.status).toBe("change_proposed");
    expect(result.proposedChanges).toBeDefined();
    expect(result.proposedChanges.length).toBe(1);
    expect(result.proposedChanges[0].file).toBe("services/test.service.js");
  });

  test("prepare_patch sets status to patch_prepared", async () => {
    mockDeepSeekCompletion = {
      choices: [{
        message: {
          content: JSON.stringify({
            editPlan: [
              {
                file: "services/test.service.js",
                operation: "replace",
                oldContent: "const x = 1;",
                newContent: "const x = 2;",
                description: "Test replace",
              },
            ],
            summary: "Test patch",
            warnings: [],
          }),
        },
      }],
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

describe("DeepSeek Agent – getConversation", () => {
  test("retrieves an existing conversation", async () => {
    const created = await startConversation({
      mode: "free_chat",
      message: "Test-Nachricht",
    });

    const retrieved = getConversation(created.conversationId);

    expect(retrieved).not.toBeNull();
    expect(retrieved.conversationId).toBe(created.conversationId);
    expect(retrieved.mode).toBe("free_chat");
    expect(retrieved.messages.length).toBeGreaterThan(0);
    expect(retrieved.dryRunResult).toBeNull();
  });

  test("returns null for unknown ID", () => {
    const result = getConversation("deepseek-conv-nonexistent");
    expect(result).toBeNull();
  });
});

/* ─────────────────────────────────────────────
   continueConversation
   ───────────────────────────────────────────── */

describe("DeepSeek Agent – continueConversation", () => {
  test("continues an existing conversation", async () => {
    const created = await startConversation({
      mode: "free_chat",
      message: "Erste Frage.",
    });

    const followUp = await continueConversation({
      conversationId: created.conversationId,
      message: "Zweite Frage.",
    });

    expect(followUp.conversationId).toBe(created.conversationId);
    expect(followUp.status).toBe("waiting_for_user");
    expect(followUp.metadata.messageCount).toBeGreaterThan(created.metadata.messageCount);
    expect(followUp.followUpPossible).toBe(true);
  });

  test("returns error for unknown conversationId", async () => {
    const result = await continueConversation({
      conversationId: "deepseek-conv-unknown",
      message: "Test",
    });

    expect(result.status).toBe("error");
    expect(result.assistantReply).toMatch(/nicht gefunden/);
  });

  test("returns error for empty message", async () => {
    const created = await startConversation({
      mode: "free_chat",
      message: "Erste Frage.",
    });

    const result = await continueConversation({
      conversationId: created.conversationId,
      message: "",
    });

    expect(result.assistantReply).toMatch(/nicht leer/);
  });

  test("switches actionIntent mid-conversation", async () => {
    const created = await startConversation({
      mode: "free_chat",
      message: "Erste Frage.",
    });

    const result = await continueConversation({
      conversationId: created.conversationId,
      message: "Jetzt analysiere.",
      actionIntent: "analyze",
    });

    expect(result.actionIntent).toBe("analyze");
  });
});

/* ─────────────────────────────────────────────
   execute_change approval gate
   ───────────────────────────────────────────── */

describe("DeepSeek Agent – execute_change approval gate", () => {
  async function createConversationWithPatch() {
    mockDeepSeekCompletion = {
      choices: [{
        message: {
          content: JSON.stringify({
            editPlan: [
              {
                file: "services/test.service.js",
                operation: "replace",
                oldContent: "const x = 1;",
                newContent: "const x = 2;",
                description: "Test",
              },
            ],
            summary: "Patch",
            warnings: [],
          }),
        },
      }],
    };

    const conv = await startConversation({
      mode: "change_mode",
      message: "Patch vorbereiten.",
      actionIntent: "prepare_patch",
    });

    expect(conv.status).toBe("patch_prepared");
    return conv;
  }

  test("rejects execution without approved=true", async () => {
    const conv = await createConversationWithPatch();

    mockDeepSeekCompletion = {
      choices: [{ message: { content: "OK" } }],
    };

    const result = await continueConversation({
      conversationId: conv.conversationId,
      message: "Ausführen.",
      actionIntent: "execute_change",
      confirmExecution: true,
      approved: false,
    });

    expect(result.assistantReply).toMatch(/Freigabe/);
    expect(result.status).not.toBe("completed");
  });

  test("rejects execution when approved is missing", async () => {
    const conv = await createConversationWithPatch();

    mockDeepSeekCompletion = {
      choices: [{ message: { content: "OK" } }],
    };

    const result = await continueConversation({
      conversationId: conv.conversationId,
      message: "Ausführen.",
      actionIntent: "execute_change",
      confirmExecution: true,
    });

    expect(result.assistantReply).toMatch(/Freigabe/);
  });

  test("dryRun flag on execute triggers dry run instead of real execution", async () => {
    const conv = await createConversationWithPatch();

    mockDeepSeekCompletion = {
      choices: [{ message: { content: "OK" } }],
    };

    const result = await continueConversation({
      conversationId: conv.conversationId,
      message: "Dry Run bitte.",
      actionIntent: "execute_change",
      confirmExecution: true,
      approved: true,
      dryRun: true,
    });

    expect(result.status).toBe("dry_run_completed");
    expect(result.dryRunResult).toBeDefined();
    expect(result.dryRunResult.success).toBeDefined();
    // No real files are changed
    expect(result.changedFiles).toEqual([]);
  });
});

/* ─────────────────────────────────────────────
   Dry run
   ───────────────────────────────────────────── */

describe("DeepSeek Agent – Dry run", () => {
  test("dry_run intent validates patch without applying", async () => {
    mockDeepSeekCompletion = {
      choices: [{
        message: {
          content: JSON.stringify({
            editPlan: [
              {
                file: "services/test.service.js",
                operation: "replace",
                oldContent: "const x = 1;",
                newContent: "const x = 2;",
                description: "Test",
              },
            ],
            summary: "Patch",
            warnings: [],
          }),
        },
      }],
    };

    const conv = await startConversation({
      mode: "change_mode",
      message: "Patch vorbereiten.",
      actionIntent: "prepare_patch",
    });

    expect(conv.status).toBe("patch_prepared");

    mockDeepSeekCompletion = {
      choices: [{ message: { content: "OK" } }],
    };

    const dryResult = await continueConversation({
      conversationId: conv.conversationId,
      message: "Dry Run durchführen.",
      actionIntent: "dry_run",
    });

    expect(dryResult.status).toBe("dry_run_completed");
    expect(dryResult.dryRunResult).toBeDefined();
    expect(dryResult.dryRunResult.log.length).toBeGreaterThan(0);
  });

  test("_dryRunChanges validates paths", () => {
    const conversation = {
      conversationId: "test-1",
      preparedPatch: {
        editPlan: [
          { file: ".env", operation: "replace", oldContent: "a", newContent: "b" },
          { file: "services/ok.js", operation: "insert", newContent: "test" },
        ],
      },
    };

    const result = _dryRunChanges(conversation);
    expect(result.success).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]).toMatch(/nicht erlaubt/);
  });

  test("_dryRunChanges succeeds for valid plan", () => {
    const conversation = {
      conversationId: "test-2",
      preparedPatch: {
        editPlan: [
          { file: "services/ok.js", operation: "insert", newContent: "test" },
        ],
      },
    };

    const result = _dryRunChanges(conversation);
    expect(result.wouldChange).toContain("services/ok.js");
    expect(result.log.length).toBeGreaterThan(0);
  });

  test("_dryRunChanges returns error with empty editPlan", () => {
    const conversation = {
      conversationId: "test-3",
      preparedPatch: { editPlan: [] },
    };

    const result = _dryRunChanges(conversation);
    expect(result.success).toBe(false);
    expect(result.issues[0]).toMatch(/Kein gültiger editPlan/);
  });
});

/* ─────────────────────────────────────────────
   Response schema
   ───────────────────────────────────────────── */

describe("DeepSeek Agent – Response schema", () => {
  test("response includes required fields", async () => {
    const result = await startConversation({
      mode: "free_chat",
      message: "Test-Nachricht",
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
    expect(result).toHaveProperty("dryRunResult");
    expect(result).toHaveProperty("requiresApproval");
    expect(result).toHaveProperty("approved");
    expect(result).toHaveProperty("changedFiles");
  });

  test("metadata has correct structure", async () => {
    const result = await startConversation({
      mode: "free_chat",
      message: "Test",
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

describe("DeepSeek Agent – Multi-turn context", () => {
  test("history accumulates across turns", async () => {
    const conv = await startConversation({
      mode: "free_chat",
      message: "Erste Frage.",
    });

    const follow1 = await continueConversation({
      conversationId: conv.conversationId,
      message: "Zweite Frage.",
    });

    const follow2 = await continueConversation({
      conversationId: conv.conversationId,
      message: "Dritte Frage.",
    });

    expect(follow2.metadata.messageCount).toBeGreaterThan(follow1.metadata.messageCount);
  });

  test("DeepSeek receives conversation history", async () => {
    const conv = await startConversation({
      mode: "free_chat",
      message: "Erste Frage.",
    });

    await continueConversation({
      conversationId: conv.conversationId,
      message: "Zweite Frage.",
    });

    // Verify createDeepSeekChatCompletion was called with messages array including history
    const calls = createDeepSeekChatCompletion.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const lastCall = calls[calls.length - 1][0];
    expect(lastCall.messages.length).toBeGreaterThan(2); // system + at least user history + new message
  });
});

/* ─────────────────────────────────────────────
   Edge cases
   ───────────────────────────────────────────── */

describe("DeepSeek Agent – Edge cases", () => {
  test("handles null/undefined opts gracefully", async () => {
    const result = await startConversation(null);
    expect(result.status).toBe("error");
  });

  test("handles invalid actionIntent gracefully", async () => {
    const result = await startConversation({
      mode: "free_chat",
      message: "Test",
      actionIntent: "nonexistent_intent",
    });

    // Should fallback to null (no specific intent)
    expect(result.actionIntent).toBeNull();
    // Status depends on API response – should be waiting_for_user on success
    expect(["waiting_for_user", "error"]).toContain(result.status);
  });

  test("handles non-JSON response from DeepSeek for propose_change", async () => {
    mockDeepSeekCompletion = {
      choices: [{ message: { content: "This is not JSON at all." } }],
    };

    const result = await startConversation({
      mode: "change_mode",
      message: "Ändere etwas.",
      actionIntent: "propose_change",
    });

    // Should not crash, proposedChanges should be empty or null
    expect(result.proposedChanges === null || (Array.isArray(result.proposedChanges) && result.proposedChanges.length === 0)).toBe(true);
  });

  test("handles DeepSeek not configured", async () => {
    isDeepSeekConfigured.mockReturnValue(false);

    const created = await startConversation({
      mode: "free_chat",
      message: "Test",
    });

    expect(created.status).toBe("error");
    expect(created.assistantReply).toMatch(/nicht konfiguriert/);
  });
});
