"use strict";

/**
 * ═══════════════════════════════════════════════════════════════
 *  Agent System End-to-End Integration Tests
 * ═══════════════════════════════════════════════════════════════
 *
 *  Tests cover:
 *   - DeepSeek full workflow: chat → follow-up → propose → patch → dryRun → execute
 *   - Gemini full workflow: chat → follow-up → propose → patch → dryRun → execute
 *   - Gemini dry_run intent (dedicated)
 *   - Conference: start → both → follow-up → partial error
 *   - Persistence: conversationStore integration
 *   - Approval / Whitelist / Blocklist enforcement
 *   - Unified response schema consistency
 *   - Orchestrator classification → dispatch
 *   - Audit trail completeness
 *   - Centralized path safety constants
 */

/* ─────────────────────────────────────────────
   Mock setup for DeepSeek
   ───────────────────────────────────────────── */

let mockDeepSeekCompletion = {
  choices: [{ message: { content: "Mock-DeepSeek-Antwort." } }],
};

jest.mock("../services/deepseek.service", () => ({
  isDeepSeekConfigured: jest.fn(() => true),
  createDeepSeekChatCompletion: jest.fn(async () => mockDeepSeekCompletion),
  extractDeepSeekText: jest.fn((completion) => {
    if (!completion?.choices?.[0]) return "";
    return completion.choices[0].message?.content || "";
  }),
  resolveModel: jest.fn(() => "deepseek-chat"),
  DEEPSEEK_FAST_MODEL: "deepseek-chat",
  DEEPSEEK_DEEP_MODEL: "deepseek-reasoner",
  getDeepSeekClient: jest.fn(),
  runDeepSeekJsonAnalysis: jest.fn(),
}));

/* ─────────────────────────────────────────────
   Mock setup for Gemini
   ───────────────────────────────────────────── */

let mockGeminiResponse = { success: true, text: "Mock-Gemini-Antwort." };

jest.mock("../services/geminiArchitect.service", () => ({
  isGeminiConfigured: jest.fn(() => true),
  runGeminiChat: jest.fn(async () => mockGeminiResponse),
  VALID_MODES: [],
  RESULT_TYPES: { SUCCESS: "success" },
  FALLBACK_LABELS: {},
}));

/* ─────────────────────────────────────────────
   Imports
   ───────────────────────────────────────────── */

const deepseekAgent = require("../services/deepseekAgent.service");
const geminiAgent = require("../services/geminiAgent.service");
const { isDeepSeekConfigured, createDeepSeekChatCompletion, extractDeepSeekText } = require("../services/deepseek.service");
const { isGeminiConfigured, runGeminiChat } = require("../services/geminiArchitect.service");
const conversationStore = require("../services/conversationStore.service");
const { recordAuditEvent, getRecentAuditEvents, getAuditEventsByConversation } = require("../services/auditTrail.service");
const { handleRequest, getSystemStatus, ERROR_CODES, CONFERENCE_TIMEOUT_MS, TIMEOUT_BUFFER_MS } = require("../services/agentOrchestrator.service");
const { classifyRequest, INTENT_KEYWORDS } = require("../services/requestClassifier.service");
const {
  UNIFIED_ACTION_INTENTS,
  ALLOWED_PROJECT_PATHS,
  BLOCKED_PATH_PATTERNS,
  getAgent,
  isIntentAllowedForSafetyLevel,
  SAFETY_LEVELS,
} = require("../services/agentRegistry.service");

/* ─────────────────────────────────────────────
   Helpers
   ───────────────────────────────────────────── */

function mockPatchResponse() {
  return JSON.stringify({
    editPlan: [
      {
        file: "services/test.service.js",
        operation: "replace",
        oldContent: "const x = 1;",
        newContent: "const x = 2;",
        description: "Test change",
      },
    ],
    summary: "Test patch",
    warnings: [],
  });
}

function mockProposeResponse() {
  return JSON.stringify({
    proposedChanges: [
      { file: "services/test.service.js", description: "Ändere Variable", risk: "low", priority: 1 },
    ],
  });
}

/* ─────────────────────────────────────────────
   Reset mocks
   ───────────────────────────────────────────── */

beforeEach(() => {
  jest.clearAllMocks();
  mockDeepSeekCompletion = {
    choices: [{ message: { content: "Mock-DeepSeek-Antwort." } }],
  };
  mockGeminiResponse = { success: true, text: "Mock-Gemini-Antwort." };
  isDeepSeekConfigured.mockReturnValue(true);
  isGeminiConfigured.mockReturnValue(true);
  createDeepSeekChatCompletion.mockImplementation(async () => mockDeepSeekCompletion);
  extractDeepSeekText.mockImplementation((c) => c?.choices?.[0]?.message?.content || "");
  runGeminiChat.mockImplementation(async () => mockGeminiResponse);
});

/* ═══════════════════════════════════════════════════════════════
   DeepSeek Full Workflow Chain
   ═══════════════════════════════════════════════════════════════ */

describe("DeepSeek – Full Workflow Chain (chat→follow-up→propose→patch→dryRun→execute)", () => {
  test("complete chain from start to execution", async () => {
    // Step 1: Chat
    const chat = await deepseekAgent.startConversation({
      mode: "free_chat",
      message: "Erkläre mir die Backend-Architektur.",
      actionIntent: "explain",
    });
    expect(chat.conversationId).toMatch(/^deepseek-conv-/);
    expect(chat.status).toBe("waiting_for_user");
    expect(chat.followUpPossible).toBe(true);
    expect(chat.actionIntent).toBe("explain");

    const convId = chat.conversationId;

    // Step 2: Follow-up
    const followUp = await deepseekAgent.continueConversation({
      conversationId: convId,
      message: "Zeige mir die Services.",
      actionIntent: "analyze",
    });
    expect(followUp.conversationId).toBe(convId);
    expect(followUp.status).toBe("waiting_for_user");

    // Step 3: Propose
    mockDeepSeekCompletion = {
      choices: [{ message: { content: mockProposeResponse() } }],
    };
    const propose = await deepseekAgent.continueConversation({
      conversationId: convId,
      message: "Schlage Verbesserungen vor.",
      actionIntent: "propose_change",
    });
    expect(propose.status).toBe("change_proposed");
    expect(propose.proposedChanges).toBeDefined();
    expect(propose.proposedChanges.length).toBeGreaterThan(0);

    // Step 4: Prepare Patch
    mockDeepSeekCompletion = {
      choices: [{ message: { content: mockPatchResponse() } }],
    };
    const patch = await deepseekAgent.continueConversation({
      conversationId: convId,
      message: "Erstelle einen Patch.",
      actionIntent: "prepare_patch",
    });
    expect(patch.status).toBe("patch_prepared");
    expect(patch.preparedPatch).toBeDefined();
    expect(patch.preparedPatch.editPlan).toBeDefined();
    expect(patch.requiresApproval).toBe(true);

    // Step 5: Dry Run
    const dryRun = await deepseekAgent.continueConversation({
      conversationId: convId,
      message: "Dry Run.",
      actionIntent: "dry_run",
    });
    expect(dryRun.status).toBe("dry_run_completed");
    expect(dryRun.dryRunResult).toBeDefined();
    expect(dryRun.dryRunResult.success).toBeDefined();
    // No real files changed
    expect(dryRun.changedFiles).toEqual([]);

    // Step 6: Execute without approval – should fail
    const noApproval = await deepseekAgent.continueConversation({
      conversationId: convId,
      message: "Ausführen.",
      actionIntent: "execute_change",
      confirmExecution: true,
      approved: false,
    });
    expect(noApproval.assistantReply).toMatch(/Freigabe/);

    // Step 7: Execute with approval – will fail because test file doesn't exist,
    // but the gate must be passed (approved check passed, execution attempted)
    const execute = await deepseekAgent.continueConversation({
      conversationId: convId,
      message: "Jetzt ausführen.",
      actionIntent: "execute_change",
      confirmExecution: true,
      approved: true,
    });
    // The execution runs but file not found, so it should be in error or completed state
    expect(["completed", "error"]).toContain(execute.status);
    expect(execute.executionResult).toBeDefined();
    expect(execute.approved).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════
   Gemini Full Workflow Chain
   ═══════════════════════════════════════════════════════════════ */

describe("Gemini – Full Workflow Chain (chat→follow-up→propose→patch→dryRun→execute)", () => {
  test("complete chain from start to execution", async () => {
    // Step 1: Chat
    const chat = await geminiAgent.startConversation({
      mode: "free_chat",
      message: "Erkläre mir die UI-Architektur.",
      actionIntent: "explain",
    });
    expect(chat.conversationId).toMatch(/^gemini-conv-/);
    expect(chat.status).toBe("waiting_for_user");
    expect(chat.followUpPossible).toBe(true);

    const convId = chat.conversationId;

    // Step 2: Follow-up
    const followUp = await geminiAgent.continueConversation({
      conversationId: convId,
      message: "Analysiere die Komponenten.",
      actionIntent: "analyze",
    });
    expect(followUp.conversationId).toBe(convId);
    expect(followUp.status).toBe("waiting_for_user");

    // Step 3: Propose
    mockGeminiResponse = { success: true, text: mockProposeResponse() };
    const propose = await geminiAgent.continueConversation({
      conversationId: convId,
      message: "Schlage UI-Verbesserungen vor.",
      actionIntent: "propose_change",
    });
    expect(propose.status).toBe("change_proposed");
    expect(propose.proposedChanges).toBeDefined();

    // Step 4: Prepare Patch
    mockGeminiResponse = { success: true, text: mockPatchResponse() };
    const patch = await geminiAgent.continueConversation({
      conversationId: convId,
      message: "Erstelle einen Patch.",
      actionIntent: "prepare_patch",
    });
    expect(patch.status).toBe("patch_prepared");
    expect(patch.preparedPatch).toBeDefined();
    expect(patch.requiresApproval).toBe(true);

    // Step 5: Dry Run
    const dryRun = await geminiAgent.continueConversation({
      conversationId: convId,
      message: "Dry Run.",
      actionIntent: "dry_run",
    });
    expect(dryRun.status).toBe("dry_run_completed");
    expect(dryRun.dryRunResult).toBeDefined();
    expect(dryRun.changedFiles).toEqual([]);

    // Step 6: Execute without approval
    const noApproval = await geminiAgent.continueConversation({
      conversationId: convId,
      message: "Ausführen.",
      actionIntent: "execute_change",
      confirmExecution: true,
      approved: false,
    });
    expect(noApproval.assistantReply).toMatch(/Freigabe/);

    // Step 7: Execute with approval
    const execute = await geminiAgent.continueConversation({
      conversationId: convId,
      message: "Jetzt ausführen.",
      actionIntent: "execute_change",
      confirmExecution: true,
      approved: true,
    });
    expect(["completed", "error"]).toContain(execute.status);
    expect(execute.executionResult).toBeDefined();
    expect(execute.approved).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════
   Gemini – Dedicated Dry Run Tests
   ═══════════════════════════════════════════════════════════════ */

describe("Gemini – Dry Run", () => {
  test("dry_run intent validates patch without applying", async () => {
    mockGeminiResponse = { success: true, text: mockPatchResponse() };

    const conv = await geminiAgent.startConversation({
      mode: "change_mode",
      message: "Patch vorbereiten.",
      actionIntent: "prepare_patch",
    });
    expect(conv.status).toBe("patch_prepared");

    mockGeminiResponse = { success: true, text: "OK" };

    const dryResult = await geminiAgent.continueConversation({
      conversationId: conv.conversationId,
      message: "Dry Run ausführen.",
      actionIntent: "dry_run",
    });

    expect(dryResult.status).toBe("dry_run_completed");
    expect(dryResult.dryRunResult).toBeDefined();
    expect(dryResult.dryRunResult.success).toBeDefined();
    expect(dryResult.changedFiles).toEqual([]);
  });

  test("dryRun flag on execute_change triggers dry run instead", async () => {
    mockGeminiResponse = { success: true, text: mockPatchResponse() };

    const conv = await geminiAgent.startConversation({
      mode: "change_mode",
      message: "Patch vorbereiten.",
      actionIntent: "prepare_patch",
    });
    expect(conv.status).toBe("patch_prepared");

    const dryResult = await geminiAgent.continueConversation({
      conversationId: conv.conversationId,
      message: "Dry Run bitte.",
      actionIntent: "execute_change",
      confirmExecution: true,
      approved: true,
      dryRun: true,
    });

    expect(dryResult.status).toBe("dry_run_completed");
    expect(dryResult.dryRunResult).toBeDefined();
    expect(dryResult.changedFiles).toEqual([]);
  });

  test("_dryRunChanges rejects blocked paths", () => {
    const conv = {
      conversationId: "test-dry",
      preparedPatch: {
        editPlan: [
          { file: ".env", operation: "replace", oldContent: "x", newContent: "y" },
        ],
      },
    };
    const result = geminiAgent._dryRunChanges(conv);
    expect(result.success).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  test("_dryRunChanges handles missing editPlan", () => {
    const result = geminiAgent._dryRunChanges({ conversationId: "test", preparedPatch: null });
    expect(result.success).toBe(false);
    expect(result.issues).toContain("Kein gültiger editPlan vorhanden.");
  });
});

/* ═══════════════════════════════════════════════════════════════
   Conversation Store – Persistence Tests
   ═══════════════════════════════════════════════════════════════ */

describe("Conversation Store – Persistence", () => {
  test("saves and retrieves conversation with all fields", async () => {
    const id = `persist-test-${Date.now()}`;
    const conv = {
      conversationId: id,
      agent: "deepseek",
      mode: "free_chat",
      status: "active",
      lastActionIntent: "explain",
      approved: false,
      messageCount: 3,
      messages: [
        { role: "user", content: "Test", timestamp: new Date().toISOString() },
      ],
      proposedChanges: [{ file: "test.js", description: "test" }],
      preparedPatch: { editPlan: [], summary: "test", warnings: [] },
      executionResult: null,
      dryRunResult: null,
      conferenceId: "conf-123",
      metadata: { source: "test" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await conversationStore.save(conv);
    const loaded = conversationStore.getSync(id);

    expect(loaded).not.toBeNull();
    expect(loaded.conversationId).toBe(id);
    expect(loaded.agent).toBe("deepseek");
    expect(loaded.mode).toBe("free_chat");
    expect(loaded.status).toBe("active");
    expect(loaded.lastActionIntent).toBe("explain");
    expect(loaded.approved).toBe(false);
    expect(loaded.messageCount).toBe(3);
    expect(loaded.conferenceId).toBe("conf-123");
    expect(loaded.proposedChanges).toBeDefined();
    expect(loaded.preparedPatch).toBeDefined();

    // Cleanup
    await conversationStore.remove(id);
  });

  test("stores conference conversation", async () => {
    const id = `conf-persist-${Date.now()}`;
    await conversationStore.save({
      conversationId: id,
      agent: "conference",
      mode: "work_chat",
      status: "active",
      conferenceId: `conference-${Date.now()}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const loaded = conversationStore.getSync(id);
    expect(loaded).not.toBeNull();
    expect(loaded.agent).toBe("conference");
    expect(loaded.conferenceId).toBeDefined();

    await conversationStore.remove(id);
  });

  test("lists conversations filtered by agent", async () => {
    const id1 = `list-ds-${Date.now()}`;
    const id2 = `list-gem-${Date.now()}`;
    await conversationStore.save({ conversationId: id1, agent: "deepseek", status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await conversationStore.save({ conversationId: id2, agent: "gemini", status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

    const dsConvs = conversationStore.list({ agent: "deepseek" });
    const gemConvs = conversationStore.list({ agent: "gemini" });

    expect(dsConvs.some((c) => c.conversationId === id1)).toBe(true);
    expect(gemConvs.some((c) => c.conversationId === id2)).toBe(true);

    await conversationStore.remove(id1);
    await conversationStore.remove(id2);
  });

  test("getStats reflects current state", async () => {
    const id = `stats-test-${Date.now()}`;
    await conversationStore.save({ conversationId: id, agent: "deepseek", status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const stats = conversationStore.getStats();
    expect(stats.total).toBeGreaterThan(0);
    expect(stats).toHaveProperty("byAgent");
    expect(stats).toHaveProperty("byStatus");
    expect(stats).toHaveProperty("maxCapacity");
    expect(stats).toHaveProperty("dbAvailable");
    await conversationStore.remove(id);
  });
});

/* ═══════════════════════════════════════════════════════════════
   Approval / Whitelist / Blocklist Enforcement
   ═══════════════════════════════════════════════════════════════ */

describe("Approval / Whitelist / Blocklist Enforcement", () => {
  test("BLOCKED_PATH_PATTERNS blocks sensitive paths", () => {
    expect(BLOCKED_PATH_PATTERNS).toContain(".env");
    expect(BLOCKED_PATH_PATTERNS).toContain("node_modules");
    expect(BLOCKED_PATH_PATTERNS).toContain(".git");
    expect(BLOCKED_PATH_PATTERNS).toContain("secrets");
    expect(BLOCKED_PATH_PATTERNS).toContain("credentials");
    expect(BLOCKED_PATH_PATTERNS).toContain("package-lock");
  });

  test("ALLOWED_PROJECT_PATHS permits valid directories", () => {
    expect(ALLOWED_PROJECT_PATHS).toContain("services/");
    expect(ALLOWED_PROJECT_PATHS).toContain("routes/");
    expect(ALLOWED_PROJECT_PATHS).toContain("config/");
    expect(ALLOWED_PROJECT_PATHS).toContain("utils/");
    expect(ALLOWED_PROJECT_PATHS).toContain("src/");
  });

  test("DeepSeek _isPathAllowed rejects .env", () => {
    expect(deepseekAgent._isPathAllowed(".env")).toBe(false);
    expect(deepseekAgent._isPathAllowed("node_modules/express/index.js")).toBe(false);
    expect(deepseekAgent._isPathAllowed(".git/config")).toBe(false);
    expect(deepseekAgent._isPathAllowed("../../../etc/passwd")).toBe(false);
    expect(deepseekAgent._isPathAllowed(null)).toBe(false);
    expect(deepseekAgent._isPathAllowed("")).toBe(false);
  });

  test("DeepSeek _isPathAllowed permits project paths", () => {
    expect(deepseekAgent._isPathAllowed("services/test.service.js")).toBe(true);
    expect(deepseekAgent._isPathAllowed("routes/admin.routes.js")).toBe(true);
    expect(deepseekAgent._isPathAllowed("config/database.js")).toBe(true);
  });

  test("Gemini _isPathAllowed rejects .env", () => {
    expect(geminiAgent._isPathAllowed(".env")).toBe(false);
    expect(geminiAgent._isPathAllowed("node_modules/lodash/index.js")).toBe(false);
    expect(geminiAgent._isPathAllowed("secrets/api-key.txt")).toBe(false);
  });

  test("Gemini _isPathAllowed permits project paths", () => {
    expect(geminiAgent._isPathAllowed("src/App.js")).toBe(true);
    expect(geminiAgent._isPathAllowed("components/Header.vue")).toBe(true);
  });

  test("DeepSeek and Gemini use same path constants from registry", () => {
    expect(deepseekAgent.ALLOWED_PROJECT_PATHS).toEqual(ALLOWED_PROJECT_PATHS);
    expect(geminiAgent.ALLOWED_PROJECT_PATHS).toEqual(ALLOWED_PROJECT_PATHS);
  });

  test("safety levels prevent execute_change at read_only level", () => {
    expect(isIntentAllowedForSafetyLevel("execute_change", "read_only")).toBe(false);
    expect(isIntentAllowedForSafetyLevel("execute_change", "propose")).toBe(false);
    expect(isIntentAllowedForSafetyLevel("execute_change", "dry_run")).toBe(false);
    expect(isIntentAllowedForSafetyLevel("execute_change", "execute")).toBe(true);
  });

  test("safety levels prevent dry_run below dry_run level", () => {
    expect(isIntentAllowedForSafetyLevel("dry_run", "read_only")).toBe(false);
    expect(isIntentAllowedForSafetyLevel("dry_run", "propose")).toBe(false);
    expect(isIntentAllowedForSafetyLevel("dry_run", "dry_run")).toBe(true);
    expect(isIntentAllowedForSafetyLevel("dry_run", "execute")).toBe(true);
  });

  test("all read-only intents allowed at read_only level", () => {
    for (const intent of ["explain", "analyze", "diagnose", "inspect_files", "plan_fix"]) {
      expect(isIntentAllowedForSafetyLevel(intent, "read_only")).toBe(true);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════
   Orchestrator – Classification & Dispatch
   ═══════════════════════════════════════════════════════════════ */

describe("Orchestrator – Classification & Dispatch", () => {
  test("classifies backend message to deepseek", () => {
    const result = classifyRequest({ message: "Prüfe den backend api endpoint" });
    expect(result.targetAgent).toBe("deepseek");
    expect(result.isConference).toBe(false);
  });

  test("classifies frontend message to gemini", () => {
    const result = classifyRequest({ message: "Analysiere das frontend layout design" });
    expect(result.targetAgent).toBe("gemini");
    expect(result.isConference).toBe(false);
  });

  test("classifies conference message correctly", () => {
    const result = classifyRequest({ message: "Beide agents sollen zusammen arbeiten" });
    expect(result.targetAgent).toBe("conference");
    expect(result.isConference).toBe(true);
  });

  test("classifies agent=both as conference", () => {
    const result = classifyRequest({ message: "Test", agent: "both" });
    expect(result.targetAgent).toBe("conference");
    expect(result.isConference).toBe(true);
  });

  test("classifies existing conferenceId as follow-up", () => {
    const result = classifyRequest({ message: "Weiter", conferenceId: "conf-123" });
    expect(result.isFollowUp).toBe(true);
    expect(result.isConference).toBe(true);
  });

  test("classifies existing conversationId as follow-up", () => {
    const result = classifyRequest({ message: "Weiter", conversationId: "conv-123" });
    expect(result.isFollowUp).toBe(true);
  });

  test("resolves action intents from keywords", () => {
    expect(classifyRequest({ message: "Erkläre das" }).actionIntent).toBe("explain");
    expect(classifyRequest({ message: "Analysiere den Code" }).actionIntent).toBe("analyze");
    expect(classifyRequest({ message: "Diagnose des Problems" }).actionIntent).toBe("diagnose");
    expect(classifyRequest({ message: "Zeige mir die Datei" }).actionIntent).toBe("inspect_files");
    expect(classifyRequest({ message: "Schlage einen Vorschlag vor" }).actionIntent).toBe("propose_change");
    expect(classifyRequest({ message: "Simuliere einen dry run" }).actionIntent).toBe("dry_run");
    expect(classifyRequest({ message: "Verifiziere den Fix" }).actionIntent).toBe("verify_fix");
    expect(classifyRequest({ message: "Erstelle einen Plan" }).actionIntent).toBe("plan_fix");
  });

  test("new execute_change keywords work", () => {
    expect(classifyRequest({ message: "perform the changes" }).actionIntent).toBe("execute_change");
    expect(classifyRequest({ message: "commit change now" }).actionIntent).toBe("execute_change");
    expect(classifyRequest({ message: "run change on system" }).actionIntent).toBe("execute_change");
  });

  test("handleRequest returns unified response with all fields", async () => {
    const result = await handleRequest({ message: "Erkläre die Architektur", agent: "deepseek", mode: "free_chat" });
    const expectedKeys = [
      "conversationId", "conferenceId", "agent", "mode", "actionIntent",
      "status", "followUpPossible", "assistantReply", "metadata",
      "proposedChanges", "preparedPatch", "executionResult", "dryRunResult",
      "requiresApproval", "approved", "changedFiles", "errors", "warnings",
      "requestId", "traceId",
    ];
    for (const key of expectedKeys) {
      expect(result).toHaveProperty(key);
    }
    expect(result.requestId).toMatch(/^req-/);
    expect(result.traceId).toMatch(/^trace-/);
  });

  test("handleRequest rejects empty message", async () => {
    const result = await handleRequest({ message: "" });
    expect(result.status).toBe("error");
    expect(result.errors).toContain(ERROR_CODES.EMPTY_MESSAGE);
  });

  test("handleRequest enforces safety level", async () => {
    const result = await handleRequest({
      message: "Execute change now",
      actionIntent: "execute_change",
      safetyLevel: "read_only",
    });
    expect(result.status).toBe("error");
    expect(result.errors).toContain(ERROR_CODES.SAFETY_VIOLATION);
  });
});

/* ═══════════════════════════════════════════════════════════════
   Audit Trail – Completeness
   ═══════════════════════════════════════════════════════════════ */

describe("Audit Trail – Completeness", () => {
  test("records classification event on handleRequest", async () => {
    const before = getRecentAuditEvents(1000).length;
    await handleRequest({ message: "Test audit trail", agent: "deepseek", mode: "free_chat" });
    const after = getRecentAuditEvents(1000);
    expect(after.length).toBeGreaterThan(before);

    const recent = after.slice(-5);
    const classificationEvent = recent.find((e) => e.eventType === "classification");
    expect(classificationEvent).toBeDefined();
    expect(classificationEvent.requestId).toMatch(/^req-/);
    expect(classificationEvent.traceId).toMatch(/^trace-/);
    expect(classificationEvent.agent).toBeDefined();
  });

  test("audit event has all expected fields", () => {
    const event = recordAuditEvent({
      eventType: "conversation_start",
      requestId: "req-test-123",
      traceId: "trace-test-123",
      conversationId: "conv-test-123",
      conferenceId: null,
      agent: "deepseek",
      mode: "free_chat",
      actionIntent: "explain",
      safetyLevel: "propose",
      approved: false,
      dryRun: false,
      historyLength: 5,
      changedFiles: [],
      provider: "deepseek",
      model: "deepseek-chat",
      errorClass: null,
      errorMessage: null,
      durationMs: 1234,
      metadata: { test: true },
    });

    expect(event.id).toBeDefined();
    expect(event.timestamp).toBeDefined();
    expect(event.eventType).toBe("conversation_start");
    expect(event.requestId).toBe("req-test-123");
    expect(event.traceId).toBe("trace-test-123");
    expect(event.conversationId).toBe("conv-test-123");
    expect(event.agent).toBe("deepseek");
    expect(event.mode).toBe("free_chat");
    expect(event.actionIntent).toBe("explain");
    expect(event.safetyLevel).toBe("propose");
    expect(event.approved).toBe(false);
    expect(event.dryRun).toBe(false);
    expect(event.historyLength).toBe(5);
    expect(event.provider).toBe("deepseek");
    expect(event.model).toBe("deepseek-chat");
    expect(event.durationMs).toBe(1234);
  });
});

/* ═══════════════════════════════════════════════════════════════
   Centralized Constants & Magic Numbers
   ═══════════════════════════════════════════════════════════════ */

describe("Centralized Constants", () => {
  test("UNIFIED_ACTION_INTENTS has exactly 10 intents", () => {
    expect(UNIFIED_ACTION_INTENTS).toHaveLength(10);
    const expected = [
      "explain", "analyze", "diagnose", "inspect_files",
      "propose_change", "prepare_patch", "dry_run",
      "execute_change", "verify_fix", "plan_fix",
    ];
    expect(UNIFIED_ACTION_INTENTS).toEqual(expected);
  });

  test("DeepSeek and Gemini agents share same 10 intents", () => {
    expect(deepseekAgent.VALID_ACTION_INTENTS).toEqual(UNIFIED_ACTION_INTENTS);
    expect(geminiAgent.VALID_ACTION_INTENTS).toEqual(UNIFIED_ACTION_INTENTS);
  });

  test("SAFETY_LEVELS has 4 levels", () => {
    expect(Object.keys(SAFETY_LEVELS)).toHaveLength(4);
    expect(SAFETY_LEVELS).toHaveProperty("read_only");
    expect(SAFETY_LEVELS).toHaveProperty("propose");
    expect(SAFETY_LEVELS).toHaveProperty("dry_run");
    expect(SAFETY_LEVELS).toHaveProperty("execute");
  });

  test("CONFERENCE_TIMEOUT_MS is a defined constant", () => {
    expect(CONFERENCE_TIMEOUT_MS).toBe(60000);
  });

  test("TIMEOUT_BUFFER_MS is a defined constant", () => {
    expect(TIMEOUT_BUFFER_MS).toBe(10000);
  });

  test("agentRegistry defaultTimeoutMs matches agent definitions", () => {
    const dsAgent = getAgent("deepseek");
    const gemAgent = getAgent("gemini");
    expect(dsAgent.defaultTimeoutMs).toBe(25000);
    // gemini-1.5-flash – needs up to 60 s; 60 s with buffer
    expect(gemAgent.defaultTimeoutMs).toBe(60000);
  });

  test("INTENT_KEYWORDS covers all 10 intents", () => {
    for (const intent of UNIFIED_ACTION_INTENTS) {
      expect(INTENT_KEYWORDS).toHaveProperty(intent);
      expect(Array.isArray(INTENT_KEYWORDS[intent])).toBe(true);
      expect(INTENT_KEYWORDS[intent].length).toBeGreaterThan(0);
    }
  });

  test("ERROR_CODES has all expected codes", () => {
    const expectedCodes = [
      "AGENT_NOT_AVAILABLE", "AGENT_NOT_CONFIGURED", "INVALID_MODE",
      "INVALID_INTENT", "SAFETY_VIOLATION", "APPROVAL_REQUIRED",
      "CONVERSATION_NOT_FOUND", "EMPTY_MESSAGE", "AGENT_TIMEOUT",
      "AGENT_ERROR", "AGENT_EMPTY_RESPONSE", "CONFERENCE_ERROR",
      "INTERNAL_ERROR",
    ];
    for (const code of expectedCodes) {
      expect(ERROR_CODES).toHaveProperty(code);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════
   Response Schema Consistency
   ═══════════════════════════════════════════════════════════════ */

describe("Response Schema – Cross-Agent Consistency", () => {
  test("DeepSeek and Gemini responses have identical field sets", async () => {
    const dsResult = await deepseekAgent.startConversation({
      mode: "free_chat",
      message: "Test DeepSeek.",
    });
    const gemResult = await geminiAgent.startConversation({
      mode: "free_chat",
      message: "Test Gemini.",
    });

    const dsKeys = Object.keys(dsResult).sort();
    const gemKeys = Object.keys(gemResult).sort();
    expect(dsKeys).toEqual(gemKeys);

    // Both should have these specific fields
    for (const key of ["conversationId", "mode", "actionIntent", "status",
      "followUpPossible", "assistantReply", "metadata", "proposedChanges",
      "preparedPatch", "executionResult", "dryRunResult", "requiresApproval",
      "approved", "changedFiles"]) {
      expect(dsResult).toHaveProperty(key);
      expect(gemResult).toHaveProperty(key);
    }
  });

  test("metadata has consistent sub-fields", async () => {
    const dsResult = await deepseekAgent.startConversation({
      mode: "free_chat",
      message: "Meta test DS.",
    });
    const gemResult = await geminiAgent.startConversation({
      mode: "free_chat",
      message: "Meta test Gem.",
    });

    const metaKeys = ["model", "apiVersion", "messageCount", "historyLength", "isInitial", "timestamp"];
    for (const key of metaKeys) {
      expect(dsResult.metadata).toHaveProperty(key);
      expect(gemResult.metadata).toHaveProperty(key);
    }
  });

  test("VALID_CONVERSATION_STATUSES are identical", () => {
    expect(deepseekAgent.VALID_CONVERSATION_STATUSES).toEqual(geminiAgent.VALID_CONVERSATION_STATUSES);
  });
});

/* ═══════════════════════════════════════════════════════════════
   Orchestrator System Status
   ═══════════════════════════════════════════════════════════════ */

describe("Orchestrator – System Status", () => {
  test("getSystemStatus returns structured response", () => {
    const status = getSystemStatus();
    expect(status).toHaveProperty("status");
    expect(status).toHaveProperty("agents");
    expect(status).toHaveProperty("availableAgentCount");
    expect(status).toHaveProperty("conversationStore");
    expect(status).toHaveProperty("timestamp");
    expect(typeof status.availableAgentCount).toBe("number");
    expect(["operational", "degraded"]).toContain(status.status);
  });

  test("system status includes conversation store stats", () => {
    const status = getSystemStatus();
    expect(status.conversationStore).toHaveProperty("total");
    expect(status.conversationStore).toHaveProperty("byAgent");
    expect(status.conversationStore).toHaveProperty("byStatus");
    expect(status.conversationStore).toHaveProperty("maxCapacity");
  });
});
