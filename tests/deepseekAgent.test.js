"use strict";

/**
 * DeepSeek Agent – Multi-Turn System Agent / Change Mode
 *
 * Tests cover:
 *  - Constants exported correctly
 *  - Conversation creation (startConversation)
 *  - Conversation retrieval (getConversation)
 *  - Follow-up / multi-turn (continueConversation)
 *  - Action intents (explain, analyze, diagnose, propose_change, prepare_patch, inspect_files, plan_fix, verify_fix)
 *  - Execute change with approval gate + dryRun
 *  - Path safety checks + extension checks
 *  - File inspection
 *  - System context builder
 *  - Response schema structure
 *  - Input validation / error handling
 *  - Mode validation
 */

/* ─────────────────────────────────────────────
   Mock DeepSeek before requiring the service
   ───────────────────────────────────────────── */

let mockDeepSeekResult = "Mock-Antwort vom DeepSeek Agent.";

jest.mock("../services/deepseek.service", () => ({
  isDeepSeekConfigured: jest.fn(() => true),
  createDeepSeekChatCompletion: jest.fn(async () => ({
    choices: [{ message: { content: mockDeepSeekResult } }],
  })),
  extractDeepSeekText: jest.fn((completion) => {
    const msg = completion?.choices?.[0]?.message;
    return (msg?.content || "").trim();
  }),
  DEEPSEEK_FAST_MODEL: "deepseek-chat",
  DEEPSEEK_DEEP_MODEL: "deepseek-reasoner",
}));

jest.mock("../utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const {
  startConversation,
  continueConversation,
  getConversation,
  VALID_ACTION_INTENTS,
  VALID_AGENT_MODES,
  VALID_CONVERSATION_STATUSES,
  ALLOWED_PROJECT_PATHS,
  ALLOWED_FILE_EXTENSIONS,
  BLOCKED_PATH_PATTERNS,
  MAX_FILES_PER_INSPECT,
  MAX_FILE_READ_SIZE_BYTES,
  _isPathAllowed,
  _isExtensionAllowed,
  _inspectFiles,
  _buildSystemContext,
} = require("../services/deepseekAgent.service");

const {
  isDeepSeekConfigured,
  createDeepSeekChatCompletion,
} = require("../services/deepseek.service");

/* ─────────────────────────────────────────────
   Reset before each test
   ───────────────────────────────────────────── */

beforeEach(() => {
  jest.clearAllMocks();
  mockDeepSeekResult = "Mock-Antwort vom DeepSeek Agent.";
  isDeepSeekConfigured.mockReturnValue(true);
});

/* ─────────────────────────────────────────────
   Constants
   ───────────────────────────────────────────── */

describe("DeepSeek Agent – Constants", () => {
  test("VALID_ACTION_INTENTS has 9 entries", () => {
    expect(Array.isArray(VALID_ACTION_INTENTS)).toBe(true);
    expect(VALID_ACTION_INTENTS.length).toBe(9);
    expect(VALID_ACTION_INTENTS).toContain("explain");
    expect(VALID_ACTION_INTENTS).toContain("analyze");
    expect(VALID_ACTION_INTENTS).toContain("diagnose");
    expect(VALID_ACTION_INTENTS).toContain("propose_change");
    expect(VALID_ACTION_INTENTS).toContain("prepare_patch");
    expect(VALID_ACTION_INTENTS).toContain("execute_change");
    expect(VALID_ACTION_INTENTS).toContain("inspect_files");
    expect(VALID_ACTION_INTENTS).toContain("plan_fix");
    expect(VALID_ACTION_INTENTS).toContain("verify_fix");
  });

  test("VALID_AGENT_MODES has 8 entries", () => {
    expect(Array.isArray(VALID_AGENT_MODES)).toBe(true);
    expect(VALID_AGENT_MODES.length).toBe(8);
    expect(VALID_AGENT_MODES).toContain("system_agent");
    expect(VALID_AGENT_MODES).toContain("backend_review");
    expect(VALID_AGENT_MODES).toContain("pipeline_diagnose");
    expect(VALID_AGENT_MODES).toContain("architecture");
    expect(VALID_AGENT_MODES).toContain("free_chat");
    expect(VALID_AGENT_MODES).toContain("change_mode");
    expect(VALID_AGENT_MODES).toContain("code_review");
    expect(VALID_AGENT_MODES).toContain("data_flow");
  });

  test("VALID_CONVERSATION_STATUSES has 7 entries", () => {
    expect(Array.isArray(VALID_CONVERSATION_STATUSES)).toBe(true);
    expect(VALID_CONVERSATION_STATUSES.length).toBe(7);
    expect(VALID_CONVERSATION_STATUSES).toContain("active");
    expect(VALID_CONVERSATION_STATUSES).toContain("waiting_for_user");
    expect(VALID_CONVERSATION_STATUSES).toContain("change_proposed");
    expect(VALID_CONVERSATION_STATUSES).toContain("patch_prepared");
    expect(VALID_CONVERSATION_STATUSES).toContain("executing");
    expect(VALID_CONVERSATION_STATUSES).toContain("completed");
    expect(VALID_CONVERSATION_STATUSES).toContain("error");
  });

  test("ALLOWED_PROJECT_PATHS is a non-empty array of strings ending with /", () => {
    expect(Array.isArray(ALLOWED_PROJECT_PATHS)).toBe(true);
    expect(ALLOWED_PROJECT_PATHS.length).toBeGreaterThan(0);
    for (const p of ALLOWED_PROJECT_PATHS) {
      expect(typeof p).toBe("string");
      expect(p.endsWith("/")).toBe(true);
    }
  });

  test("ALLOWED_FILE_EXTENSIONS is a non-empty array", () => {
    expect(Array.isArray(ALLOWED_FILE_EXTENSIONS)).toBe(true);
    expect(ALLOWED_FILE_EXTENSIONS.length).toBeGreaterThan(0);
    expect(ALLOWED_FILE_EXTENSIONS).toContain(".js");
    expect(ALLOWED_FILE_EXTENSIONS).toContain(".json");
    expect(ALLOWED_FILE_EXTENSIONS).toContain(".ts");
  });

  test("BLOCKED_PATH_PATTERNS contains critical patterns", () => {
    expect(BLOCKED_PATH_PATTERNS).toContain(".env");
    expect(BLOCKED_PATH_PATTERNS).toContain("node_modules");
    expect(BLOCKED_PATH_PATTERNS).toContain(".git");
    expect(BLOCKED_PATH_PATTERNS).toContain("secrets");
    expect(BLOCKED_PATH_PATTERNS).toContain("credentials");
  });

  test("MAX_FILES_PER_INSPECT and MAX_FILE_READ_SIZE_BYTES are positive numbers", () => {
    expect(MAX_FILES_PER_INSPECT).toBeGreaterThan(0);
    expect(MAX_FILE_READ_SIZE_BYTES).toBeGreaterThan(0);
  });
});

/* ─────────────────────────────────────────────
   Path safety
   ───────────────────────────────────────────── */

describe("DeepSeek Agent – Path Safety", () => {
  test("_isPathAllowed accepts valid paths", () => {
    expect(_isPathAllowed("services/deepseek.service.js")).toBe(true);
    expect(_isPathAllowed("routes/admin.routes.js")).toBe(true);
    expect(_isPathAllowed("config/settings.json")).toBe(true);
    expect(_isPathAllowed("utils/logger.js")).toBe(true);
  });

  test("_isPathAllowed rejects blocked paths", () => {
    expect(_isPathAllowed(".env")).toBe(false);
    expect(_isPathAllowed("node_modules/express/index.js")).toBe(false);
    expect(_isPathAllowed(".git/config")).toBe(false);
    expect(_isPathAllowed("secrets/api.key")).toBe(false);
    expect(_isPathAllowed("services/../.env")).toBe(false);
  });

  test("_isPathAllowed rejects traversal", () => {
    expect(_isPathAllowed("../../../etc/passwd")).toBe(false);
    expect(_isPathAllowed("services/../../.env")).toBe(false);
  });

  test("_isPathAllowed rejects null/empty/invalid", () => {
    expect(_isPathAllowed(null)).toBe(false);
    expect(_isPathAllowed("")).toBe(false);
    expect(_isPathAllowed(123)).toBe(false);
    expect(_isPathAllowed("random/file.js")).toBe(false);
  });

  test("_isExtensionAllowed accepts valid extensions", () => {
    expect(_isExtensionAllowed("services/test.js")).toBe(true);
    expect(_isExtensionAllowed("config/test.json")).toBe(true);
    expect(_isExtensionAllowed("docs/README.md")).toBe(true);
    expect(_isExtensionAllowed("services/test.ts")).toBe(true);
  });

  test("_isExtensionAllowed rejects invalid extensions", () => {
    expect(_isExtensionAllowed("services/test.exe")).toBe(false);
    expect(_isExtensionAllowed("services/test.so")).toBe(false);
    expect(_isExtensionAllowed("services/test.dll")).toBe(false);
    expect(_isExtensionAllowed("services/test")).toBe(false);
    expect(_isExtensionAllowed(null)).toBe(false);
    expect(_isExtensionAllowed("")).toBe(false);
  });
});

/* ─────────────────────────────────────────────
   System context builder
   ───────────────────────────────────────────── */

describe("DeepSeek Agent – System Context Builder", () => {
  test("returns base context when no opts", () => {
    const ctx = _buildSystemContext();
    expect(typeof ctx).toBe("string");
    expect(ctx).toContain("HQS-Systemarchitektur");
  });

  test("includes project context", () => {
    const ctx = _buildSystemContext({ projectContext: "Testprojekt-Info" });
    expect(ctx).toContain("Testprojekt-Info");
    expect(ctx).toContain("Projekt-Kontext");
  });

  test("includes affected files", () => {
    const ctx = _buildSystemContext({ affectedFiles: ["services/test.js", "routes/api.js"] });
    expect(ctx).toContain("services/test.js");
    expect(ctx).toContain("routes/api.js");
    expect(ctx).toContain("Betroffene Dateien");
  });

  test("includes findings", () => {
    const ctx = _buildSystemContext({ findings: ["Fehler in Route", "Veraltetes Schema"] });
    expect(ctx).toContain("Fehler in Route");
    expect(ctx).toContain("Bisherige Befunde");
  });

  test("includes file contents", () => {
    const ctx = _buildSystemContext({
      fileContents: [{ file: "services/test.js", content: "const x = 1;" }],
    });
    expect(ctx).toContain("services/test.js");
    expect(ctx).toContain("const x = 1;");
    expect(ctx).toContain("Dateiinhalte");
  });
});

/* ─────────────────────────────────────────────
   startConversation
   ───────────────────────────────────────────── */

describe("DeepSeek Agent – startConversation", () => {
  test("creates a conversation with valid inputs", async () => {
    const result = await startConversation({
      mode: "free_chat",
      message: "Hallo, wie funktioniert die Pipeline?",
    });

    expect(result.conversationId).toBeTruthy();
    expect(result.conversationId).toMatch(/^ds-agent-/);
    expect(result.mode).toBe("free_chat");
    expect(result.status).toBe("waiting_for_user");
    expect(result.followUpPossible).toBe(true);
    expect(result.assistantReply).toBeTruthy();
    expect(result.metadata).toBeDefined();
    expect(result.metadata.isInitial).toBe(true);
    expect(result.metadata.messageCount).toBeGreaterThanOrEqual(2);
    expect(result.metadata.apiVersion).toBe("agent-v1");
    expect(result.approved).toBe(false);
    expect(result.requiresApproval).toBe(false);
    expect(Array.isArray(result.findings)).toBe(true);
    expect(Array.isArray(result.affectedFiles)).toBe(true);
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
      mode: "system_agent",
      message: "Erkläre die Pipeline.",
      actionIntent: "explain",
    });

    expect(result.actionIntent).toBe("explain");
    expect(result.status).toBe("waiting_for_user");
  });

  test("supports diagnose actionIntent", async () => {
    const result = await startConversation({
      mode: "pipeline_diagnose",
      message: "Diagnose des Snapshot-Jobs",
      actionIntent: "diagnose",
    });

    expect(result.actionIntent).toBe("diagnose");
  });

  test("supports inspect_files actionIntent", async () => {
    const result = await startConversation({
      mode: "system_agent",
      message: "Zeige mir die Datei",
      actionIntent: "inspect_files",
      inspectFiles: ["services/nonexistent.js"],
    });

    expect(result.actionIntent).toBe("inspect_files");
  });

  test("supports plan_fix actionIntent", async () => {
    const result = await startConversation({
      mode: "system_agent",
      message: "Plane den Fix",
      actionIntent: "plan_fix",
    });

    expect(result.actionIntent).toBe("plan_fix");
    expect(result.status).toBe("waiting_for_user");
  });

  test("supports verify_fix actionIntent", async () => {
    const result = await startConversation({
      mode: "system_agent",
      message: "Verifiziere den Fix",
      actionIntent: "verify_fix",
    });

    expect(result.actionIntent).toBe("verify_fix");
    expect(result.status).toBe("waiting_for_user");
  });

  test("includes optional context in history", async () => {
    const result = await startConversation({
      mode: "free_chat",
      message: "Test",
      context: "Admin-Dashboard Kontext",
    });

    expect(result.conversationId).toBeTruthy();
    expect(result.metadata.messageCount).toBeGreaterThanOrEqual(3);
  });

  test("includes affectedFiles and findings", async () => {
    const result = await startConversation({
      mode: "system_agent",
      message: "Analysiere den Fehler",
      affectedFiles: ["services/test.js"],
      findings: [{ description: "Fehler gefunden" }],
    });

    expect(result.affectedFiles).toContain("services/test.js");
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
  });

  test("handles DeepSeek API failure gracefully", async () => {
    createDeepSeekChatCompletion.mockRejectedValueOnce(new Error("API_TIMEOUT"));

    const result = await startConversation({
      mode: "free_chat",
      message: "Test",
    });

    expect(result.status).toBe("error");
    expect(result.assistantReply).toMatch(/Fehler/);
  });

  test("handles empty DeepSeek response", async () => {
    createDeepSeekChatCompletion.mockResolvedValueOnce({
      choices: [{ message: { content: "" } }],
    });

    const result = await startConversation({
      mode: "free_chat",
      message: "Test",
    });

    expect(result.status).toBe("error");
    expect(result.assistantReply).toMatch(/DeepSeek-Fehler/);
  });

  test("propose_change sets conversation status", async () => {
    mockDeepSeekResult = JSON.stringify({
      proposedChanges: [
        { file: "services/test.js", description: "Fix bug", risk: "low", priority: 1 },
      ],
      summary: "Fix a bug",
      riskAssessment: "Low risk",
      affectedFiles: ["services/test.js"],
    });

    const result = await startConversation({
      mode: "change_mode",
      message: "Schlage eine Änderung vor",
      actionIntent: "propose_change",
    });

    expect(result.actionIntent).toBe("propose_change");
    expect(result.status).toBe("change_proposed");
    expect(result.proposedChanges).toBeTruthy();
    expect(result.proposedChanges.length).toBe(1);
    expect(result.proposedChanges[0].file).toBe("services/test.js");
    expect(result.affectedFiles).toContain("services/test.js");
  });

  test("prepare_patch returns patch structure", async () => {
    mockDeepSeekResult = JSON.stringify({
      editPlan: [
        {
          file: "services/test.js",
          operation: "replace",
          lineRange: [1, 3],
          oldContent: "old",
          newContent: "new",
          description: "Replace content",
        },
      ],
      summary: "Patch summary",
      warnings: ["Warnung 1"],
    });

    const result = await startConversation({
      mode: "change_mode",
      message: "Bereite den Patch vor",
      actionIntent: "prepare_patch",
    });

    expect(result.status).toBe("patch_prepared");
    expect(result.preparedPatch).toBeTruthy();
    expect(result.preparedPatch.editPlan.length).toBe(1);
    expect(result.preparedPatch.editPlan[0].operation).toBe("replace");
    expect(result.requiresApproval).toBe(true);
    expect(result.approved).toBe(false);
  });
});

/* ─────────────────────────────────────────────
   continueConversation
   ───────────────────────────────────────────── */

describe("DeepSeek Agent – continueConversation", () => {
  let testConversationId;

  beforeEach(async () => {
    mockDeepSeekResult = "Erste Antwort.";
    const initial = await startConversation({
      mode: "free_chat",
      message: "Hallo",
    });
    testConversationId = initial.conversationId;
  });

  test("continues a conversation with follow-up", async () => {
    mockDeepSeekResult = "Follow-up Antwort.";

    const result = await continueConversation({
      conversationId: testConversationId,
      message: "Erzähl mir mehr",
    });

    expect(result.conversationId).toBe(testConversationId);
    expect(result.status).toBe("waiting_for_user");
    expect(result.assistantReply).toBe("Follow-up Antwort.");
    expect(result.metadata.isInitial).toBe(false);
    expect(result.metadata.messageCount).toBeGreaterThanOrEqual(4);
    expect(result.followUpPossible).toBe(true);
  });

  test("returns error for unknown conversationId", async () => {
    const result = await continueConversation({
      conversationId: "nonexistent",
      message: "Test",
    });

    expect(result.status).toBe("error");
    expect(result.assistantReply).toMatch(/nicht gefunden/);
  });

  test("returns error for empty message", async () => {
    const result = await continueConversation({
      conversationId: testConversationId,
      message: "",
    });

    expect(result.assistantReply).toMatch(/nicht leer/);
  });

  test("returns error when DeepSeek not configured", async () => {
    isDeepSeekConfigured.mockReturnValue(false);

    const result = await continueConversation({
      conversationId: testConversationId,
      message: "Test",
    });

    expect(result.assistantReply).toMatch(/nicht konfiguriert/);
  });

  test("merges new affected files and findings", async () => {
    mockDeepSeekResult = "Analyse Antwort.";

    const result = await continueConversation({
      conversationId: testConversationId,
      message: "Analyse",
      affectedFiles: ["routes/new.routes.js"],
      findings: [{ description: "Neuer Befund" }],
    });

    expect(result.affectedFiles).toContain("routes/new.routes.js");
    expect(result.status).toBe("waiting_for_user");
  });

  test("propose_change in follow-up works", async () => {
    mockDeepSeekResult = JSON.stringify({
      proposedChanges: [
        { file: "services/test.js", description: "Fix", risk: "medium", priority: 1 },
      ],
      summary: "Change",
      riskAssessment: "Medium",
    });

    const result = await continueConversation({
      conversationId: testConversationId,
      message: "Schlage eine Änderung vor",
      actionIntent: "propose_change",
    });

    expect(result.status).toBe("change_proposed");
    expect(result.proposedChanges.length).toBe(1);
  });
});

/* ─────────────────────────────────────────────
   Execute change / Approval gate
   ───────────────────────────────────────────── */

describe("DeepSeek Agent – Execute Change / Approval", () => {
  let patchConversationId;

  beforeEach(async () => {
    mockDeepSeekResult = JSON.stringify({
      editPlan: [
        {
          file: "services/test.js",
          operation: "replace",
          oldContent: "old",
          newContent: "new",
          description: "Fix",
        },
      ],
      summary: "Patch",
      warnings: [],
    });

    const initial = await startConversation({
      mode: "change_mode",
      message: "Bereite Patch vor",
      actionIntent: "prepare_patch",
    });
    patchConversationId = initial.conversationId;
    expect(initial.status).toBe("patch_prepared");
    expect(initial.requiresApproval).toBe(true);
  });

  test("execute_change requires approval", async () => {
    const result = await continueConversation({
      conversationId: patchConversationId,
      message: "Führe aus",
      actionIntent: "execute_change",
      confirmExecution: true,
      approved: false,
    });

    expect(result.assistantReply).toMatch(/Freigabe/);
    expect(result.approved).toBe(false);
  });

  test("execute_change without approved flag is rejected", async () => {
    const result = await continueConversation({
      conversationId: patchConversationId,
      message: "Führe aus",
      actionIntent: "execute_change",
      confirmExecution: true,
    });

    expect(result.assistantReply).toMatch(/Freigabe/);
  });

  test("execute_change with approved=true attempts execution", async () => {
    // This will fail because the file doesn't exist, but it tests the flow
    const result = await continueConversation({
      conversationId: patchConversationId,
      message: "Führe aus",
      actionIntent: "execute_change",
      confirmExecution: true,
      approved: true,
    });

    // Either completed or error (file doesn't exist), but approval was processed
    expect(result.approved).toBe(true);
    expect(result.executionResult).toBeTruthy();
  });

  test("dryRun previews without applying", async () => {
    const result = await continueConversation({
      conversationId: patchConversationId,
      message: "Vorschau",
      actionIntent: "execute_change",
      confirmExecution: true,
      approved: true,
      dryRun: true,
    });

    expect(result.approved).toBe(true);
    expect(result.executionResult).toBeTruthy();
    expect(result.executionResult.dryRun).toBe(true);
  });
});

/* ─────────────────────────────────────────────
   getConversation
   ───────────────────────────────────────────── */

describe("DeepSeek Agent – getConversation", () => {
  test("returns null for unknown conversation", () => {
    const result = getConversation("nonexistent");
    expect(result).toBeNull();
  });

  test("returns conversation after creation", async () => {
    const initial = await startConversation({
      mode: "system_agent",
      message: "Test",
    });

    const conv = getConversation(initial.conversationId);
    expect(conv).toBeTruthy();
    expect(conv.conversationId).toBe(initial.conversationId);
    expect(conv.mode).toBe("system_agent");
    expect(conv.messages.length).toBeGreaterThan(0);
    expect(conv.messageCount).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(conv.findings)).toBe(true);
    expect(Array.isArray(conv.affectedFiles)).toBe(true);
    expect(conv.systemContext).toBeDefined();
  });
});

/* ─────────────────────────────────────────────
   Response schema
   ───────────────────────────────────────────── */

describe("DeepSeek Agent – Response Schema", () => {
  test("response contains all required fields", async () => {
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
    expect(result).toHaveProperty("findings");
    expect(result).toHaveProperty("affectedFiles");
    expect(result).toHaveProperty("proposedChanges");
    expect(result).toHaveProperty("preparedPatch");
    expect(result).toHaveProperty("executionResult");
    expect(result).toHaveProperty("requiresApproval");
    expect(result).toHaveProperty("approved");
    expect(result).toHaveProperty("changedFiles");
  });

  test("metadata contains expected fields", async () => {
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
    expect(result.metadata.apiVersion).toBe("agent-v1");
  });
});

/* ─────────────────────────────────────────────
   File inspection
   ───────────────────────────────────────────── */

describe("DeepSeek Agent – File Inspection", () => {
  test("_inspectFiles returns errors for empty array", () => {
    const result = _inspectFiles([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("_inspectFiles rejects disallowed paths", () => {
    const result = _inspectFiles([".env", "node_modules/express/index.js"]);
    expect(result.files.length).toBe(0);
    expect(result.errors.length).toBe(2);
  });

  test("_inspectFiles rejects disallowed extensions", () => {
    const result = _inspectFiles(["services/test.exe"]);
    expect(result.files.length).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("_inspectFiles handles missing files gracefully", () => {
    const result = _inspectFiles(["services/nonexistent_file_xyz.js"]);
    expect(result.files.length).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

/* ─────────────────────────────────────────────
   Multi-turn dialog continuity
   ───────────────────────────────────────────── */

describe("DeepSeek Agent – Multi-Turn Dialog", () => {
  test("conversation tracks message history across turns", async () => {
    mockDeepSeekResult = "Antwort 1";
    const r1 = await startConversation({ mode: "free_chat", message: "Frage 1" });
    const id = r1.conversationId;

    mockDeepSeekResult = "Antwort 2";
    const r2 = await continueConversation({ conversationId: id, message: "Frage 2" });

    mockDeepSeekResult = "Antwort 3";
    const r3 = await continueConversation({ conversationId: id, message: "Frage 3" });

    expect(r3.metadata.messageCount).toBeGreaterThanOrEqual(6);

    const conv = getConversation(id);
    expect(conv.messages.length).toBeGreaterThanOrEqual(6);

    const userMsgs = conv.messages.filter((m) => m.role === "user");
    expect(userMsgs.length).toBe(3);

    const assistantMsgs = conv.messages.filter((m) => m.role === "assistant");
    expect(assistantMsgs.length).toBe(3);
  });

  test("intent changes across turns", async () => {
    mockDeepSeekResult = "Erklärung";
    const r1 = await startConversation({
      mode: "system_agent",
      message: "Erkläre",
      actionIntent: "explain",
    });
    const id = r1.conversationId;
    expect(r1.actionIntent).toBe("explain");

    mockDeepSeekResult = "Analyse";
    const r2 = await continueConversation({
      conversationId: id,
      message: "Analysiere jetzt",
      actionIntent: "analyze",
    });
    expect(r2.actionIntent).toBe("analyze");
  });

  test("all 8 agent modes can start conversations", async () => {
    for (const mode of VALID_AGENT_MODES) {
      mockDeepSeekResult = `Antwort für ${mode}`;
      const result = await startConversation({ mode, message: `Test ${mode}` });
      expect(result.mode).toBe(mode);
      expect(result.status).not.toBe("error");
    }
  });
});
