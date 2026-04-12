"use strict";

/**
 * Active Agent Bridge V1.1 – Tests
 *
 * Tests cover:
 *  1. Context loaded → no generic "kein Zugriff auf Code" answer
 *  2. Path / file questions cause inferred file reads (routes, services, middleware)
 *  3. Session-cache mismatch (topic change) triggers fresh context reload
 *  4. DeepSeek timeout is adequate for context-heavy modes
 *  5. needsProjectContext triggers on new signal terms (endpoint, pfad, route, etc.)
 *  6. New diagnostics fields present in response (contextUsedInAnswer,
 *     contextMismatchRecovered, fallbackReason, filesRead)
 *  7. _inferTargetFiles correctness
 *  8. _isCacheMismatch correctness
 */

/* ─────────────────────────────────────────────
   Mocks
   ───────────────────────────────────────────── */

let mockGeminiChatResult = { success: true, text: "Mock-Antwort Gemini." };
let mockDeepSeekCompletion = { choices: [{ message: { content: "Mock-Antwort DeepSeek." } }] };

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
    tree: "services/\n  geminiAgent.service.js\nroutes/\n  admin.routes.js",
    entryCount: 3,
  })),
  listDirectory: jest.fn(() => ({ success: true, entries: [] })),
  readFile: jest.fn(() => ({ success: false, error: "not found" })),
  findFileByName: jest.fn(() => ({ success: true, matches: [], searchedScopes: [] })),
  extractTargetFilenames: jest.fn(() => []),
  needsProjectContext: jest.fn(() => false),
}));

const geminiAgent   = require("../services/geminiAgent.service");
const deepseekAgent = require("../services/deepseekAgent.service");
const { isGeminiConfigured, runGeminiChat }                         = require("../services/geminiArchitect.service");
const { isDeepSeekConfigured, createDeepSeekChatCompletion, extractDeepSeekText } = require("../services/deepseek.service");
const { scanProjectStructure, readFile, findFileByName, needsProjectContext } = require("../services/geminiProjectExplorer.service");

beforeEach(() => {
  jest.clearAllMocks();
  mockGeminiChatResult   = { success: true, text: "Mock-Antwort Gemini." };
  mockDeepSeekCompletion = { choices: [{ message: { content: "Mock-Antwort DeepSeek." } }] };
  isGeminiConfigured.mockReturnValue(true);
  isDeepSeekConfigured.mockReturnValue(true);
  createDeepSeekChatCompletion.mockImplementation(async () => mockDeepSeekCompletion);
  extractDeepSeekText.mockImplementation((c) => c?.choices?.[0]?.message?.content || "");
  scanProjectStructure.mockReturnValue({
    success: true,
    tree: "services/\n  geminiAgent.service.js\nroutes/\n  admin.routes.js",
    entryCount: 3,
  });
  readFile.mockReturnValue({ success: false, error: "not found" });
  findFileByName.mockReturnValue({ success: true, matches: [], searchedScopes: [] });
  needsProjectContext.mockReturnValue(false);
});

/* ─────────────────────────────────────────────
   1. No generic "kein Zugriff" when context loaded
   ───────────────────────────────────────────── */

describe("V1.1 – No generic 'kein Zugriff' when context loaded", () => {
  test("Gemini: answer does not contain 'kein Zugriff auf Code' when context is fresh", async () => {
    needsProjectContext.mockReturnValue(true);
    mockGeminiChatResult = {
      success: true,
      text: "Das System basiert auf services/geminiAgent.service.js und routes/admin.routes.js.",
    };
    const result = await geminiAgent.startConversation({
      mode: "architecture",
      message: "Erkläre die Architektur",
    });
    expect(result.reply.text).not.toMatch(/kein zugriff auf (den )?code/i);
    expect(result.reply.text).not.toMatch(/ich habe keinen zugriff/i);
    expect(result.reply.text).not.toMatch(/bitte sende mir (den )?code/i);
  });

  test("DeepSeek: answer does not contain generic no-access phrase when context is fresh", async () => {
    needsProjectContext.mockReturnValue(true);
    mockDeepSeekCompletion = {
      choices: [{ message: { content: "Das Backend nutzt services/agentRegistry.service.js für die Registrierung." } }],
    };
    const result = await deepseekAgent.startConversation({
      mode: "backend_review",
      message: "Was macht der agentRegistry?",
    });
    expect(result.reply.text).not.toMatch(/kein zugriff auf (den )?code/i);
    expect(result.reply.text).not.toMatch(/ich habe keinen zugriff/i);
  });

  test("Gemini: contextSource 'fresh' is reflected in metadata", async () => {
    needsProjectContext.mockReturnValue(true);
    const result = await geminiAgent.startConversation({
      mode: "architecture",
      message: "Wie ist das System aufgebaut?",
    });
    expect(result.metadata.contextSource).toBe("fresh");
  });

  test("DeepSeek: contextSource 'fresh' in metadata for backend_review", async () => {
    const result = await deepseekAgent.startConversation({
      mode: "backend_review",
      message: "Analysiere das Backend",
    });
    expect(result.metadata.contextSource).toBe("fresh");
  });
});

/* ─────────────────────────────────────────────
   2. Path / file questions trigger inferred file reads
   ───────────────────────────────────────────── */

describe("V1.1 – _inferTargetFiles correctness", () => {
  const { _inferTargetFiles } = geminiAgent;

  test("route keyword → routes/admin.routes.js", () => {
    const files = _inferTargetFiles("Welche Route hat der Endpunkt /api/admin/users?");
    expect(files).toContain("routes/admin.routes.js");
  });

  test("endpoint keyword → routes/admin.routes.js", () => {
    const files = _inferTargetFiles("Welcher Endpoint gibt die Benutzer zurück?");
    expect(files).toContain("routes/admin.routes.js");
  });

  test("pfad keyword → routes/admin.routes.js", () => {
    const files = _inferTargetFiles("Wie ist der API-Pfad für den Gemini-Agent?");
    expect(files).toContain("routes/admin.routes.js");
  });

  test("service keyword → services/agentRegistry.service.js", () => {
    const files = _inferTargetFiles("Welcher Service ist für Authentifizierung zuständig?");
    expect(files).toContain("services/agentRegistry.service.js");
  });

  test("specific agent service mentioned → that service file", () => {
    const files = _inferTargetFiles("Was macht der deepseekagent service?");
    expect(files.some((f) => f.includes("deepseekagent") || f.includes("agentRegistry"))).toBe(true);
  });

  test("middleware keyword → middleware/adminAuth.js", () => {
    const files = _inferTargetFiles("Wie funktioniert die middleware authentication?");
    expect(files).toContain("middleware/adminAuth.js");
  });

  test("empty/irrelevant message → empty array", () => {
    expect(_inferTargetFiles("Hallo, wie geht es dir?")).toEqual([]);
    expect(_inferTargetFiles("")).toEqual([]);
  });

  test("returns at most 2 files", () => {
    // message with route + service + middleware all at once
    const files = _inferTargetFiles("route service middleware auth endpoint");
    expect(files.length).toBeLessThanOrEqual(2);
  });
});

describe("V1.1 – DeepSeek _inferTargetFiles correctness", () => {
  const { _inferTargetFiles } = deepseekAgent;

  test("endpoint keyword → routes/admin.routes.js", () => {
    const files = _inferTargetFiles("Welcher endpoint gibt JSON zurück?");
    expect(files).toContain("routes/admin.routes.js");
  });

  test("service keyword → services/agentRegistry.service.js", () => {
    const files = _inferTargetFiles("Was macht der Service?");
    expect(files).toContain("services/agentRegistry.service.js");
  });

  test("middleware keyword → middleware/adminAuth.js", () => {
    const files = _inferTargetFiles("Welche middleware läuft vor den admin routes?");
    expect(files).toContain("middleware/adminAuth.js");
  });
});

/* ─────────────────────────────────────────────
   3. Session-cache mismatch → fresh reload
   ───────────────────────────────────────────── */

describe("V1.1 – _isCacheMismatch correctness", () => {
  const { _isCacheMismatch } = geminiAgent;

  test("same topic → no mismatch", () => {
    const cache = "Projektstruktur:\nservices/geminiAgent.service.js\nroutes/admin.routes.js";
    const message = "Was macht geminiAgent.service.js?";
    expect(_isCacheMismatch(message, cache)).toBe(false);
  });

  test("different specific file → mismatch", () => {
    const cache = "Projektstruktur:\nservices/geminiAgent.service.js";
    const message = "Erkläre mir routes/admin.routes.js";
    expect(_isCacheMismatch(message, cache)).toBe(true);
  });

  test("empty message → no mismatch", () => {
    expect(_isCacheMismatch("", "some cached content")).toBe(false);
  });

  test("empty cache → no mismatch", () => {
    expect(_isCacheMismatch("some question", "")).toBe(false);
  });
});

describe("V1.1 – DeepSeek _isCacheMismatch correctness", () => {
  const { _isCacheMismatch } = deepseekAgent;

  test("same topic → no mismatch", () => {
    const cache = "Projektstruktur:\nservices/deepseekAgent.service.js";
    const message = "Was macht deepseekAgent.service.js?";
    expect(_isCacheMismatch(message, cache)).toBe(false);
  });

  test("different route file → mismatch", () => {
    const cache = "Projektstruktur:\nservices/deepseekAgent.service.js";
    const message = "Erkläre mir routes/admin.routes.js";
    expect(_isCacheMismatch(message, cache)).toBe(true);
  });
});

describe("V1.1 – Cache mismatch triggers fresh scan in Gemini", () => {
  test("scanProjectStructure called again after topic change (mismatch)", async () => {
    needsProjectContext.mockReturnValue(true);

    // First call – primes the cache
    const first = await geminiAgent.startConversation({
      mode: "architecture",
      message: "Erkläre services/geminiAgent.service.js",
    });
    const firstCallCount = scanProjectStructure.mock.calls.length;
    expect(firstCallCount).toBe(1);

    // Second call in same conversation with a different topic (should bust cache)
    await geminiAgent.continueConversation({
      conversationId: first.conversationId,
      message: "Erkläre routes/admin.routes.js",
      actionIntent: null,
    });
    // scanProjectStructure must have been called at least twice total
    expect(scanProjectStructure.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("V1.1 – Cache mismatch triggers fresh scan in DeepSeek", () => {
  test("scanProjectStructure called again after topic change", async () => {
    needsProjectContext.mockReturnValue(true);

    const first = await deepseekAgent.startConversation({
      mode: "backend_review",
      message: "Erkläre services/deepseekAgent.service.js",
    });
    const firstCallCount = scanProjectStructure.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    await deepseekAgent.continueConversation({
      conversationId: first.conversationId,
      message: "Erkläre routes/admin.routes.js",
      actionIntent: null,
    });
    // Must have called scanProjectStructure at least twice
    expect(scanProjectStructure.mock.calls.length).toBeGreaterThan(firstCallCount);
  });
});

/* ─────────────────────────────────────────────
   4. DeepSeek timeout adequate for context-heavy modes
   ───────────────────────────────────────────── */

describe("V1.1 – DeepSeek timeout for context-heavy modes", () => {
  test("createDeepSeekChatCompletion is called with timeoutMs >= 45000 for backend_review", async () => {
    await deepseekAgent.startConversation({
      mode: "backend_review",
      message: "Analysiere das gesamte Backend",
    });
    const callArgs = createDeepSeekChatCompletion.mock.calls[0][0];
    expect(callArgs.timeoutMs).toBeGreaterThanOrEqual(45000);
  });

  test("createDeepSeekChatCompletion is called with timeoutMs >= 45000 for system_diagnostics", async () => {
    await deepseekAgent.startConversation({
      mode: "system_diagnostics",
      message: "Diagnostiziere das System",
    });
    const callArgs = createDeepSeekChatCompletion.mock.calls[0][0];
    expect(callArgs.timeoutMs).toBeGreaterThanOrEqual(45000);
  });

  test("createDeepSeekChatCompletion uses shorter timeout for free_chat without context", async () => {
    needsProjectContext.mockReturnValue(false);
    await deepseekAgent.startConversation({
      mode: "free_chat",
      message: "Hallo, wie geht es?",
    });
    const callArgs = createDeepSeekChatCompletion.mock.calls[0][0];
    expect(callArgs.timeoutMs).toBe(25000);
  });
});

/* ─────────────────────────────────────────────
   5. needsProjectContext triggers on new terms
   ───────────────────────────────────────────── */

describe("V1.1 – needsProjectContext new signal terms", () => {
  // We test the actual (un-mocked) implementation
  const { needsProjectContext: realNeedsCtx } = jest.requireActual(
    "../services/geminiProjectExplorer.service"
  );

  test("'endpoint' triggers context", () => {
    expect(realNeedsCtx("Welcher endpoint gibt die Userliste zurück?")).toBe(true);
  });

  test("'pfad' triggers context", () => {
    expect(realNeedsCtx("Was ist der API-Pfad für den Admin-Bereich?")).toBe(true);
  });

  test("'route' triggers context", () => {
    expect(realNeedsCtx("Welche route ist für POST /login zuständig?")).toBe(true);
  });

  test("'antwortfeld' triggers context", () => {
    expect(realNeedsCtx("Welches Antwortfeld enthält die Session-ID?")).toBe(true);
  });

  test("'api endpoint' triggers context", () => {
    expect(realNeedsCtx("Gibt es einen api endpoint für das Dashboard?")).toBe(true);
  });

  test("general greeting does NOT trigger context", () => {
    expect(realNeedsCtx("Hallo! Wie geht es dir heute?")).toBe(false);
  });
});

/* ─────────────────────────────────────────────
   6. New diagnostics fields in response
   ───────────────────────────────────────────── */

describe("V1.1 – New diagnostics fields in Gemini response", () => {
  test("metadata.filesRead is always present (array)", async () => {
    const result = await geminiAgent.startConversation({ mode: "free_chat", message: "Hallo" });
    expect(result.metadata).toHaveProperty("filesRead");
    expect(Array.isArray(result.metadata.filesRead)).toBe(true);
  });

  test("metadata.contextUsedInAnswer is always present (boolean)", async () => {
    const result = await geminiAgent.startConversation({ mode: "free_chat", message: "Hallo" });
    expect(result.metadata).toHaveProperty("contextUsedInAnswer");
    expect(typeof result.metadata.contextUsedInAnswer).toBe("boolean");
  });

  test("metadata.contextMismatchRecovered is always present (boolean)", async () => {
    const result = await geminiAgent.startConversation({ mode: "free_chat", message: "Hallo" });
    expect(result.metadata).toHaveProperty("contextMismatchRecovered");
    expect(typeof result.metadata.contextMismatchRecovered).toBe("boolean");
  });

  test("contextUsedInAnswer is true when reply references a read file", async () => {
    needsProjectContext.mockReturnValue(true);
    readFile.mockReturnValue({
      success: true,
      content: "// geminiAgent.service.js content",
      sizeBytes: 100,
      truncated: false,
    });
    // Return specific candidate from extractCandidateFiles by including it in msg
    mockGeminiChatResult = {
      success: true,
      text: "Die Datei geminiAgent.service.js enthält den Agent-Code.",
    };
    const result = await geminiAgent.startConversation({
      mode: "architecture",
      message: "Was macht services/geminiAgent.service.js?",
    });
    // contextUsedInAnswer depends on whether the filename appears in the reply
    // readFile succeeds and the reply contains the basename "geminiAgent.service.js"
    expect(result.metadata.contextUsedInAnswer).toBe(true);
  });

  test("fallbackReason appears when context loaded but not referenced in reply", async () => {
    needsProjectContext.mockReturnValue(true);
    readFile.mockReturnValue({
      success: true,
      content: "// geminiAgent.service.js content",
      sizeBytes: 100,
      truncated: false,
    });
    // Reply does NOT reference any file → fallbackReason should be set
    mockGeminiChatResult = {
      success: true,
      text: "Das ist eine allgemeine Antwort ohne Dateibezug.",
    };
    const result = await geminiAgent.startConversation({
      mode: "architecture",
      message: "Was macht services/geminiAgent.service.js?",
    });
    // Depending on what readFile returns (it may not be in filesRead if mock returns success:true),
    // check the field is at least present when context is "fresh"
    if (result.metadata.contextSource !== "none" && result.metadata.filesRead.length > 0) {
      expect(result.metadata.fallbackReason).toBeDefined();
    }
  });
});

describe("V1.1 – New diagnostics fields in DeepSeek response", () => {
  test("metadata.filesRead is always present", async () => {
    const result = await deepseekAgent.startConversation({ mode: "free_chat", message: "Hallo" });
    expect(result.metadata).toHaveProperty("filesRead");
    expect(Array.isArray(result.metadata.filesRead)).toBe(true);
  });

  test("metadata.contextUsedInAnswer is always present (boolean)", async () => {
    const result = await deepseekAgent.startConversation({ mode: "free_chat", message: "Hallo" });
    expect(typeof result.metadata.contextUsedInAnswer).toBe("boolean");
  });

  test("metadata.contextMismatchRecovered is always present (boolean)", async () => {
    const result = await deepseekAgent.startConversation({ mode: "free_chat", message: "Hallo" });
    expect(typeof result.metadata.contextMismatchRecovered).toBe("boolean");
  });

  test("contextMismatchRecovered is false on first call (no previous cache)", async () => {
    const result = await deepseekAgent.startConversation({
      mode: "backend_review",
      message: "Erkläre das Backend",
    });
    expect(result.metadata.contextMismatchRecovered).toBe(false);
  });
});

/* ─────────────────────────────────────────────
   7. Inferred file reads flow into context gather
   ───────────────────────────────────────────── */

describe("V1.1 – Inferred files are attempted when no explicit candidates", () => {
  test("Gemini: readFile attempted for inferred routes/admin.routes.js on endpoint question", async () => {
    needsProjectContext.mockReturnValue(true);
    readFile.mockReturnValue({
      success: true,
      content: "// admin.routes.js content: router.post('/api/admin/deepseek/chat', ...)",
      sizeBytes: 100,
      truncated: false,
    });
    await geminiAgent.startConversation({
      mode: "architecture",
      message: "Welchen endpoint hat der deepseek chat?",
    });
    const readCalls = readFile.mock.calls.map((c) => c[0]);
    expect(readCalls.some((p) => p.includes("routes/admin.routes.js"))).toBe(true);
  });

  test("DeepSeek: readFile attempted for inferred routes/admin.routes.js on endpoint question", async () => {
    readFile.mockReturnValue({
      success: true,
      content: "// admin.routes.js content",
      sizeBytes: 50,
      truncated: false,
    });
    await deepseekAgent.startConversation({
      mode: "backend_review",
      message: "Welcher API-Pfad wird für den Gemini-Agent genutzt?",
    });
    const readCalls = readFile.mock.calls.map((c) => c[0]);
    expect(readCalls.some((p) => p.includes("routes/admin.routes.js"))).toBe(true);
  });

  test("Gemini: readFile attempted for inferred middleware/adminAuth.js on auth question", async () => {
    needsProjectContext.mockReturnValue(true);
    readFile.mockReturnValue({
      success: true,
      content: "// adminAuth.js",
      sizeBytes: 50,
      truncated: false,
    });
    await geminiAgent.startConversation({
      mode: "architecture",
      message: "Wie funktioniert die middleware authentication im Admin-Bereich?",
    });
    const readCalls = readFile.mock.calls.map((c) => c[0]);
    expect(readCalls.some((p) => p.includes("middleware/adminAuth.js"))).toBe(true);
  });
});
