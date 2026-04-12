"use strict";

/**
 * Active Agent Bridge V1 – Tests
 *
 * Tests cover:
 *  - agentActivities array in response (structured activity feed)
 *  - contextSource in metadata ("none" / "fresh" / "session_cache")
 *  - workingMemory in response (session-scoped, per-conversation)
 *  - Session cache short-circuit in _gatherArchitectContext / _gatherAgentContext
 *  - lastDiagnosticHypothesis updated on "diagnose" intent
 *  - Intent-driven activities (propose_change, prepare_patch, dry_run, execute_change)
 *  - Gemini and DeepSeek agents separately
 *  - Security: no .env / secrets / paths leaked in agentActivities
 */

/* ─────────────────────────────────────────────
   Mocks
   ───────────────────────────────────────────── */

let mockGeminiChatResult = { success: true, text: "Mock-Antwort." };
let mockDeepSeekCompletion = { choices: [{ message: { content: "Mock-Antwort DS." } }] };

jest.mock("../services/geminiArchitect.service", () => ({
  isGeminiConfigured: jest.fn(() => true),
  runGeminiChat: jest.fn(async () => mockGeminiChatResult),
  VALID_MODES: [],
  RESULT_TYPES: { SUCCESS: "success" },
  FALLBACK_LABELS: {},
}));

jest.mock("../services/deepseek.service", () => ({
  isDeepSeekConfigured: jest.fn(() => true),
  createDeepSeekChatCompletion: jest.fn(async () => mockDeepSeekCompletion),
  extractDeepSeekText: jest.fn((c) => c?.choices?.[0]?.message?.content || ""),
  resolveModel: jest.fn(() => "deepseek-chat"),
  DEEPSEEK_FAST_MODEL: "deepseek-chat",
  DEEPSEEK_DEEP_MODEL: "deepseek-reasoner",
  getDeepSeekClient: jest.fn(),
  runDeepSeekJsonAnalysis: jest.fn(),
}));

/* Mock the explorer service so we can control what tools return */
jest.mock("../services/geminiProjectExplorer.service", () => ({
  scanProjectStructure: jest.fn(() => ({
    success: true,
    tree: "services/\n  foo.js\nroutes/\n  bar.js",
    entryCount: 2,
  })),
  listDirectory: jest.fn(() => ({ success: true, entries: [] })),
  readFile: jest.fn(() => ({ success: false, error: "not found" })),
  needsProjectContext: jest.fn(() => false),
}));

const geminiAgent = require("../services/geminiAgent.service");
const deepseekAgent = require("../services/deepseekAgent.service");
const { isGeminiConfigured, runGeminiChat } = require("../services/geminiArchitect.service");
const { isDeepSeekConfigured, createDeepSeekChatCompletion, extractDeepSeekText } = require("../services/deepseek.service");
const { scanProjectStructure, readFile, needsProjectContext } = require("../services/geminiProjectExplorer.service");

beforeEach(() => {
  jest.clearAllMocks();
  mockGeminiChatResult = { success: true, text: "Mock-Antwort." };
  mockDeepSeekCompletion = { choices: [{ message: { content: "Mock-Antwort DS." } }] };
  isGeminiConfigured.mockReturnValue(true);
  isDeepSeekConfigured.mockReturnValue(true);
  createDeepSeekChatCompletion.mockImplementation(async () => mockDeepSeekCompletion);
  extractDeepSeekText.mockImplementation((c) => c?.choices?.[0]?.message?.content || "");
  scanProjectStructure.mockReturnValue({ success: true, tree: "services/\n  foo.js", entryCount: 1 });
  readFile.mockReturnValue({ success: false, error: "not found" });
  needsProjectContext.mockReturnValue(false);
});

/* ─────────────────────────────────────────────
   GEMINI – agentActivities array
   ───────────────────────────────────────────── */

describe("Gemini Agent Bridge V1 – agentActivities", () => {
  test("response includes agentActivities array (always present)", async () => {
    const result = await geminiAgent.startConversation({ mode: "free_chat", message: "Hallo" });
    expect(result).toHaveProperty("agentActivities");
    expect(Array.isArray(result.agentActivities)).toBe(true);
  });

  test("agentActivities is empty when no context gathered", async () => {
    needsProjectContext.mockReturnValue(false);
    const result = await geminiAgent.startConversation({ mode: "free_chat", message: "Hallo" });
    expect(result.agentActivities).toHaveLength(0);
  });

  test("agentActivities contains scan_project_structure when context gathered", async () => {
    needsProjectContext.mockReturnValue(true);
    const result = await geminiAgent.startConversation({ mode: "free_chat", message: "Wie ist die Architektur?" });
    const types = result.agentActivities.map((a) => a.type);
    expect(types).toContain("scan_project_structure");
  });

  test("agentActivities scan activity has required shape", async () => {
    needsProjectContext.mockReturnValue(true);
    const result = await geminiAgent.startConversation({ mode: "architecture", message: "Erkläre die Struktur" });
    const scanAct = result.agentActivities.find((a) => a.type === "scan_project_structure");
    expect(scanAct).toBeDefined();
    expect(scanAct).toHaveProperty("label");
    expect(scanAct).toHaveProperty("timestamp");
    expect(typeof scanAct.label).toBe("string");
    expect(typeof scanAct.timestamp).toBe("string");
  });

  test("agentActivities does not leak full file-system paths", async () => {
    needsProjectContext.mockReturnValue(true);
    readFile.mockReturnValue({ success: true, content: "// test", sizeBytes: 6, truncated: false });
    const result = await geminiAgent.startConversation({
      mode: "architecture",
      message: "Schau dir services/geminiAgent.service.js an",
    });
    for (const act of result.agentActivities) {
      if (act.path) {
        // Must not start with / (no absolute path)
        expect(act.path).not.toMatch(/^\//);
        // Must not contain deeply nested path traversal
        expect(act.path).not.toContain("..");
        // Max 2 segments (last two segments only)
        const segments = act.path.split("/").filter(Boolean);
        expect(segments.length).toBeLessThanOrEqual(2);
      }
    }
  });

  test("agentActivities includes files_identified when files are read", async () => {
    needsProjectContext.mockReturnValue(true);
    readFile.mockReturnValue({ success: true, content: "// ok", sizeBytes: 5, truncated: false });
    const result = await geminiAgent.startConversation({
      mode: "architecture",
      message: "Schaue dir services/geminiAgent.service.js an",
    });
    const types = result.agentActivities.map((a) => a.type);
    expect(types).toContain("files_identified");
  });

  test("propose_change intent produces propose_change activity", async () => {
    const proposeJson = JSON.stringify({
      proposedChanges: [{ file: "services/foo.js", description: "Fix", risk: "low", priority: 1 }],
      summary: "Test",
      riskAssessment: "low",
    });
    mockGeminiChatResult = { success: true, text: proposeJson };
    const result = await geminiAgent.startConversation({
      mode: "change_mode",
      message: "Schlage Änderungen vor",
      actionIntent: "propose_change",
    });
    const types = result.agentActivities.map((a) => a.type);
    expect(types).toContain("propose_change");
    const propAct = result.agentActivities.find((a) => a.type === "propose_change");
    expect(propAct).toHaveProperty("count", 1);
  });

  test("prepare_patch intent produces patch_prepared activity", async () => {
    const patchJson = JSON.stringify({
      editPlan: [{ file: "services/foo.js", operation: "replace", oldContent: "a", newContent: "b", description: "fix" }],
      summary: "Patch",
      warnings: [],
    });
    mockGeminiChatResult = { success: true, text: patchJson };
    const result = await geminiAgent.startConversation({
      mode: "change_mode",
      message: "Bereite Patch vor",
      actionIntent: "prepare_patch",
    });
    const types = result.agentActivities.map((a) => a.type);
    expect(types).toContain("patch_prepared");
  });
});

/* ─────────────────────────────────────────────
   GEMINI – contextSource in metadata
   ───────────────────────────────────────────── */

describe("Gemini Agent Bridge V1 – contextSource", () => {
  test("metadata.contextSource is 'none' when no context gathered", async () => {
    needsProjectContext.mockReturnValue(false);
    const result = await geminiAgent.startConversation({ mode: "free_chat", message: "Hallo" });
    expect(result.metadata.contextSource).toBe("none");
  });

  test("metadata.contextSource is 'fresh' when context just gathered", async () => {
    needsProjectContext.mockReturnValue(true);
    const result = await geminiAgent.startConversation({ mode: "architecture", message: "Beschreibe die Struktur" });
    expect(result.metadata.contextSource).toBe("fresh");
  });

  test("metadata.contextSource is 'session_cache' on second call within TTL", async () => {
    needsProjectContext.mockReturnValue(true);
    // First call – gathers fresh context
    const first = await geminiAgent.startConversation({
      mode: "architecture",
      message: "Beschreibe die Struktur",
    });
    expect(first.metadata.contextSource).toBe("fresh");

    // Second call (follow-up) – should hit session cache (no new file candidates)
    const second = await geminiAgent.continueConversation({
      conversationId: first.conversationId,
      message: "Und die Services?",
    });
    expect(second.metadata.contextSource).toBe("session_cache");
  });
});

/* ─────────────────────────────────────────────
   GEMINI – workingMemory in response
   ───────────────────────────────────────────── */

describe("Gemini Agent Bridge V1 – workingMemory", () => {
  test("response includes workingMemory object", async () => {
    const result = await geminiAgent.startConversation({ mode: "free_chat", message: "Hallo" });
    expect(result).toHaveProperty("workingMemory");
    expect(result.workingMemory).not.toBeNull();
    expect(result.workingMemory).toHaveProperty("lastReadFiles");
    expect(result.workingMemory).toHaveProperty("lastContextTimestamp");
    expect(result.workingMemory).toHaveProperty("lastDiagnosticHypothesis");
  });

  test("workingMemory.lastReadFiles starts empty when no context gathered", async () => {
    needsProjectContext.mockReturnValue(false);
    const result = await geminiAgent.startConversation({ mode: "free_chat", message: "Hallo" });
    expect(result.workingMemory.lastReadFiles).toEqual([]);
    expect(result.workingMemory.lastContextTimestamp).toBeNull();
  });

  test("workingMemory.lastContextTimestamp is set after context gathered", async () => {
    needsProjectContext.mockReturnValue(true);
    const result = await geminiAgent.startConversation({ mode: "architecture", message: "Was ist das?" });
    expect(result.workingMemory.lastContextTimestamp).not.toBeNull();
    // Should be a valid ISO timestamp
    expect(() => new Date(result.workingMemory.lastContextTimestamp).toISOString()).not.toThrow();
  });

  test("workingMemory.lastDiagnosticHypothesis set after diagnose intent", async () => {
    mockGeminiChatResult = { success: true, text: "Die Ursache ist ein fehlerhafter Import." };
    const result = await geminiAgent.startConversation({
      mode: "architecture",
      message: "Diagnose das Problem",
      actionIntent: "diagnose",
    });
    expect(result.workingMemory.lastDiagnosticHypothesis).toBeTruthy();
    expect(result.workingMemory.lastDiagnosticHypothesis).toContain("Die Ursache");
  });

  test("workingMemory.lastDiagnosticHypothesis capped at 500 chars", async () => {
    const longText = "X".repeat(1000);
    mockGeminiChatResult = { success: true, text: longText };
    const result = await geminiAgent.startConversation({
      mode: "architecture",
      message: "Diagnose",
      actionIntent: "diagnose",
    });
    expect(result.workingMemory.lastDiagnosticHypothesis.length).toBeLessThanOrEqual(500);
  });

  test("workingMemory does not expose cachedContextText in API response", async () => {
    needsProjectContext.mockReturnValue(true);
    const result = await geminiAgent.startConversation({ mode: "architecture", message: "Struktur?" });
    expect(result.workingMemory).not.toHaveProperty("cachedContextText");
  });

  test("getConversation also exposes workingMemory", async () => {
    const start = await geminiAgent.startConversation({ mode: "free_chat", message: "Hallo" });
    const conv = geminiAgent.getConversation(start.conversationId);
    expect(conv).not.toBeNull();
    expect(conv).toHaveProperty("workingMemory");
    expect(conv.workingMemory).toHaveProperty("lastReadFiles");
  });
});

/* ─────────────────────────────────────────────
   GEMINI – session cache behaviour
   ───────────────────────────────────────────── */

describe("Gemini Agent Bridge V1 – session cache", () => {
  test("scanProjectStructure called only once across two calls within TTL (cache hit)", async () => {
    needsProjectContext.mockReturnValue(true);
    scanProjectStructure.mockReturnValue({ success: true, tree: "services/", entryCount: 1 });

    const first = await geminiAgent.startConversation({ mode: "architecture", message: "Struktur?" });
    expect(scanProjectStructure).toHaveBeenCalledTimes(1);

    await geminiAgent.continueConversation({ conversationId: first.conversationId, message: "Mehr Details?" });
    // Should NOT call scanProjectStructure again because cache is fresh
    expect(scanProjectStructure).toHaveBeenCalledTimes(1);
  });

  test("agentActivities contains context_reused on cache hit", async () => {
    needsProjectContext.mockReturnValue(true);
    const first = await geminiAgent.startConversation({ mode: "architecture", message: "Analyse?" });
    const second = await geminiAgent.continueConversation({
      conversationId: first.conversationId,
      message: "Follow-up?",
    });
    const types = second.agentActivities.map((a) => a.type);
    expect(types).toContain("context_reused");
  });
});

/* ─────────────────────────────────────────────
   DEEPSEEK – agentActivities array
   ───────────────────────────────────────────── */

describe("DeepSeek Agent Bridge V1 – agentActivities", () => {
  test("response includes agentActivities array", async () => {
    const result = await deepseekAgent.startConversation({ mode: "free_chat", message: "Hallo" });
    expect(result).toHaveProperty("agentActivities");
    expect(Array.isArray(result.agentActivities)).toBe(true);
  });

  test("agentActivities empty for non-context mode", async () => {
    needsProjectContext.mockReturnValue(false);
    const result = await deepseekAgent.startConversation({ mode: "change_mode", message: "Hallo" });
    expect(result.agentActivities).toHaveLength(0);
  });

  test("agentActivities has scan_project_structure for backend_review mode", async () => {
    const result = await deepseekAgent.startConversation({
      mode: "backend_review",
      message: "Überprüfe das Backend",
    });
    const types = result.agentActivities.map((a) => a.type);
    expect(types).toContain("scan_project_structure");
  });

  test("propose_change produces propose_change activity in DeepSeek", async () => {
    const proposeJson = JSON.stringify({
      proposedChanges: [{ file: "services/foo.js", description: "Fix", risk: "low", priority: 1 }],
      summary: "Test",
    });
    mockDeepSeekCompletion = { choices: [{ message: { content: proposeJson } }] };
    const result = await deepseekAgent.startConversation({
      mode: "change_mode",
      message: "Schlage Änderungen vor",
      actionIntent: "propose_change",
    });
    const types = result.agentActivities.map((a) => a.type);
    expect(types).toContain("propose_change");
  });
});

/* ─────────────────────────────────────────────
   DEEPSEEK – contextSource in metadata
   ───────────────────────────────────────────── */

describe("DeepSeek Agent Bridge V1 – contextSource", () => {
  test("metadata.contextSource is 'none' for change_mode", async () => {
    const result = await deepseekAgent.startConversation({ mode: "change_mode", message: "Hallo" });
    expect(result.metadata.contextSource).toBe("none");
  });

  test("metadata.contextSource is 'fresh' for backend_review", async () => {
    const result = await deepseekAgent.startConversation({ mode: "backend_review", message: "Analyse?" });
    expect(result.metadata.contextSource).toBe("fresh");
  });

  test("metadata.contextSource is 'session_cache' on follow-up in backend_review", async () => {
    const first = await deepseekAgent.startConversation({ mode: "backend_review", message: "Analyse?" });
    expect(first.metadata.contextSource).toBe("fresh");

    const second = await deepseekAgent.continueConversation({
      conversationId: first.conversationId,
      message: "Mehr Details?",
    });
    expect(second.metadata.contextSource).toBe("session_cache");
  });
});

/* ─────────────────────────────────────────────
   DEEPSEEK – workingMemory in response
   ───────────────────────────────────────────── */

describe("DeepSeek Agent Bridge V1 – workingMemory", () => {
  test("response includes workingMemory object", async () => {
    const result = await deepseekAgent.startConversation({ mode: "free_chat", message: "Hallo" });
    expect(result).toHaveProperty("workingMemory");
    expect(result.workingMemory).not.toBeNull();
    expect(result.workingMemory).toHaveProperty("lastReadFiles");
    expect(result.workingMemory).toHaveProperty("lastContextTimestamp");
    expect(result.workingMemory).toHaveProperty("lastDiagnosticHypothesis");
  });

  test("lastDiagnosticHypothesis set after diagnose intent in DeepSeek", async () => {
    mockDeepSeekCompletion = { choices: [{ message: { content: "Ursache: fehlende Konfiguration." } }] };
    const result = await deepseekAgent.startConversation({
      mode: "system_diagnostics",
      message: "Was ist das Problem?",
      actionIntent: "diagnose",
    });
    expect(result.workingMemory.lastDiagnosticHypothesis).toBeTruthy();
  });

  test("workingMemory does not expose cachedContextText in API response", async () => {
    const result = await deepseekAgent.startConversation({ mode: "backend_review", message: "Analyse?" });
    expect(result.workingMemory).not.toHaveProperty("cachedContextText");
  });

  test("getConversation exposes workingMemory in DeepSeek", async () => {
    const start = await deepseekAgent.startConversation({ mode: "free_chat", message: "Hallo" });
    const conv = deepseekAgent.getConversation(start.conversationId);
    expect(conv).not.toBeNull();
    expect(conv).toHaveProperty("workingMemory");
  });
});

/* ─────────────────────────────────────────────
   DEEPSEEK – session cache behaviour
   ───────────────────────────────────────────── */

describe("DeepSeek Agent Bridge V1 – session cache", () => {
  test("scanProjectStructure called only once within TTL", async () => {
    scanProjectStructure.mockReturnValue({ success: true, tree: "services/", entryCount: 1 });
    const first = await deepseekAgent.startConversation({ mode: "backend_review", message: "Analyse?" });
    expect(scanProjectStructure).toHaveBeenCalledTimes(1);

    await deepseekAgent.continueConversation({ conversationId: first.conversationId, message: "Mehr Details?" });
    expect(scanProjectStructure).toHaveBeenCalledTimes(1);
  });

  test("context_reused activity present on second call in same conversation", async () => {
    const first = await deepseekAgent.startConversation({ mode: "system_diagnostics", message: "Status?" });
    const second = await deepseekAgent.continueConversation({
      conversationId: first.conversationId,
      message: "Follow-up?",
    });
    const types = second.agentActivities.map((a) => a.type);
    expect(types).toContain("context_reused");
  });
});

/* ─────────────────────────────────────────────
   Shared schema checks (backwards compat)
   ───────────────────────────────────────────── */

describe("Active Agent Bridge V1 – schema backwards compatibility", () => {
  test("Gemini: existing fields still present alongside new fields", async () => {
    const result = await geminiAgent.startConversation({ mode: "free_chat", message: "Hallo" });
    // Old fields
    expect(result).toHaveProperty("conversationId");
    expect(result).toHaveProperty("reply");
    expect(result).toHaveProperty("reply.text");
    expect(result).toHaveProperty("status");
    expect(result).toHaveProperty("followUpPossible");
    expect(result).toHaveProperty("metadata");
    expect(result).toHaveProperty("metadata.apiVersion", "v1");
    expect(result).toHaveProperty("proposedChanges");
    expect(result).toHaveProperty("preparedPatch");
    expect(result).toHaveProperty("errorCategory");
    // New fields
    expect(result).toHaveProperty("agentActivities");
    expect(result).toHaveProperty("workingMemory");
    expect(result.metadata).toHaveProperty("contextSource");
  });

  test("DeepSeek: existing fields still present alongside new fields", async () => {
    const result = await deepseekAgent.startConversation({ mode: "free_chat", message: "Hallo" });
    // Old fields
    expect(result).toHaveProperty("conversationId");
    expect(result).toHaveProperty("reply");
    expect(result).toHaveProperty("reply.text");
    expect(result).toHaveProperty("status");
    expect(result).toHaveProperty("metadata");
    expect(result).toHaveProperty("proposedChanges");
    expect(result).toHaveProperty("errorCategory");
    // New fields
    expect(result).toHaveProperty("agentActivities");
    expect(result).toHaveProperty("workingMemory");
    expect(result.metadata).toHaveProperty("contextSource");
  });

  test("Gemini: error responses also have agentActivities and workingMemory", async () => {
    const result = await geminiAgent.startConversation({ mode: "invalid_mode", message: "Hallo" });
    expect(result).toHaveProperty("agentActivities");
    expect(result).toHaveProperty("workingMemory");
  });
});
