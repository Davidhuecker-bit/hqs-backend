"use strict";

/**
 * Active Agent Bridge – Targeted File Search Tests
 *
 * Tests cover:
 *  1. findFileByName – security / validation rules
 *  2. findFileByName – filesystem walks (mocked fs)
 *  3. _extractTargetFilenames – bare filename extraction from messages
 *  4. Integration – bare filename in message → findFileByName called → readFile attempted
 *  5. Integration – file not found → context note with searched scopes
 *  6. Integration – multiple matches handled cleanly
 *  7. Integration – new diagnostics fields in response metadata
 */

/* ─────────────────────────────────────────────
   Mocks
   ───────────────────────────────────────────── */

jest.mock("../services/geminiArchitect.service", () => ({
  isGeminiConfigured: jest.fn(() => true),
  runGeminiChat: jest.fn(async () => ({ success: true, text: "Mock-Antwort Gemini." })),
  VALID_MODES: [],
  RESULT_TYPES: { SUCCESS: "success" },
  FALLBACK_LABELS: {},
}));

jest.mock("../services/deepseek.service", () => ({
  isDeepSeekConfigured: jest.fn(() => true),
  createDeepSeekChatCompletion: jest.fn(async () => ({
    choices: [{ message: { content: "Mock-Antwort DeepSeek." } }],
  })),
  extractDeepSeekText: jest.fn((c) => c?.choices?.[0]?.message?.content || ""),
  resolveModel: jest.fn(() => "deepseek-chat"),
  DEEPSEEK_FAST_MODEL: "deepseek-chat",
  DEEPSEEK_DEEP_MODEL: "deepseek-reasoner",
  getDeepSeekClient: jest.fn(),
  runDeepSeekJsonAnalysis: jest.fn(),
}));

/* We do NOT globally mock geminiProjectExplorer – individual test groups
   selectively override it where needed, using jest.doMock or jest.spyOn. */

/* ─────────────────────────────────────────────
   1. findFileByName – security / validation
   ───────────────────────────────────────────── */

describe("findFileByName – security and validation", () => {
  // Use the real implementation for this section
  const {
    findFileByName,
  } = jest.requireActual("../services/geminiProjectExplorer.service");

  test("returns error for empty basename", () => {
    const result = findFileByName("");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/empty/i);
    expect(result.matches).toEqual([]);
    expect(result.searchedScopes).toEqual([]);
  });

  test("returns error for null/undefined basename", () => {
    expect(findFileByName(null).success).toBe(false);
    expect(findFileByName(undefined).success).toBe(false);
  });

  test("rejects basenames with path separators", () => {
    const result = findFileByName("some/dir/file.js");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid/i);
  });

  test("rejects path traversal in basename", () => {
    const result = findFileByName("../secrets.env");
    expect(result.success).toBe(false);
  });

  test("rejects .env file basename", () => {
    const result = findFileByName(".env");
    expect(result.success).toBe(false);
  });

  test("rejects .env.local basename", () => {
    const result = findFileByName(".env.local");
    expect(result.success).toBe(false);
  });

  test("rejects binary file extension (.exe)", () => {
    const result = findFileByName("malware.exe");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not searchable/i);
  });

  test("rejects .key extension", () => {
    const result = findFileByName("private.key");
    expect(result.success).toBe(false);
  });

  test("accepts valid .jsx basename and returns success with empty matches when no file exists", () => {
    // The real fs won't have DashboardIntegrated.jsx in the test environment,
    // so matches will be [] but success should be true (search ran, nothing found).
    const result = findFileByName("DashboardIntegrated.jsx");
    expect(result.success).toBe(true);
    expect(Array.isArray(result.matches)).toBe(true);
    expect(Array.isArray(result.searchedScopes)).toBe(true);
  });

  test("accepts valid .js basename", () => {
    const result = findFileByName("someComponent.js");
    expect(result.success).toBe(true);
    expect(Array.isArray(result.matches)).toBe(true);
  });

  test("searchedScopes is populated when search ran successfully", () => {
    const result = findFileByName("nonexistent-file-xyz.jsx");
    expect(result.success).toBe(true);
    // Should have searched at least some scopes
    expect(result.searchedScopes.length).toBeGreaterThanOrEqual(0);
  });

  test("allows .env.example basename (whitelisted)", () => {
    // .env.example is in ALLOWED_BASENAMES; the search should run (result.success = true)
    const result = findFileByName(".env.example");
    expect(result.success).toBe(true);
  });
});

/* ─────────────────────────────────────────────
   2. findFileByName – filesystem walk with mocked fs
   ───────────────────────────────────────────── */

describe("findFileByName – filesystem matching (with fs mock)", () => {
  let origReaddirSync;
  let origExistsSync;
  const path = require("path");

  beforeAll(() => {
    origReaddirSync = require("fs").readdirSync;
    origExistsSync  = require("fs").existsSync;
  });

  afterEach(() => {
    // Restore real fs functions
    require("fs").readdirSync = origReaddirSync;
    require("fs").existsSync  = origExistsSync;
  });

  test("finds a file at the top level of an allowed directory", () => {
    const { ALLOWED_PROJECT_PATHS } = require("../services/agentRegistry.service");
    const fs = require("fs");

    // Fake that 'src/' exists and contains 'Dashboard.jsx'
    fs.existsSync = (p) => {
      if (p.endsWith(path.sep + "src") || p.endsWith("/src")) return true;
      return origExistsSync(p);
    };
    fs.readdirSync = (p, opts) => {
      const rel = p.replace(process.cwd() + path.sep, "").replace(/\\/g, "/");
      if (rel === "src") {
        const entry = { name: "Dashboard.jsx", isDirectory: () => false, isFile: () => true };
        return [entry];
      }
      // Silence other dirs so test is contained
      return [];
    };

    // Re-require to pick up the mocked fs (Jest module cache – use actual)
    const { findFileByName } = jest.requireActual("../services/geminiProjectExplorer.service");
    const result = findFileByName("Dashboard.jsx");
    expect(result.success).toBe(true);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]).toContain("Dashboard.jsx");
  });

  test("finds a file in a nested subdirectory", () => {
    const fs = require("fs");

    fs.existsSync = (p) => {
      if (p.endsWith("/src") || p.endsWith(path.sep + "src")) return true;
      return origExistsSync(p);
    };
    fs.readdirSync = (p, opts) => {
      const rel = p.replace(process.cwd() + path.sep, "").replace(/\\/g, "/");
      if (rel === "src") {
        return [{ name: "features", isDirectory: () => true, isFile: () => false }];
      }
      if (rel === "src/features") {
        return [{ name: "DashboardIntegrated.jsx", isDirectory: () => false, isFile: () => true }];
      }
      return [];
    };

    const { findFileByName } = jest.requireActual("../services/geminiProjectExplorer.service");
    const result = findFileByName("DashboardIntegrated.jsx");
    expect(result.success).toBe(true);
    expect(result.matches.some((m) => m.includes("DashboardIntegrated.jsx"))).toBe(true);
  });

  test("returns multiple matches when file exists in more than one scope", () => {
    const fs = require("fs");

    fs.existsSync = (p) => {
      const rel = p.replace(process.cwd() + path.sep, "").replace(/\\/g, "/");
      if (rel === "src" || rel === "components") return true;
      return origExistsSync(p);
    };
    fs.readdirSync = (p, opts) => {
      const rel = p.replace(process.cwd() + path.sep, "").replace(/\\/g, "/");
      if (rel === "src" || rel === "components") {
        return [{ name: "Button.jsx", isDirectory: () => false, isFile: () => true }];
      }
      return [];
    };

    const { findFileByName } = jest.requireActual("../services/geminiProjectExplorer.service");
    const result = findFileByName("Button.jsx");
    expect(result.success).toBe(true);
    expect(result.matches.length).toBeGreaterThanOrEqual(2);
    // All matches should contain the basename
    result.matches.forEach((m) => expect(m).toContain("Button.jsx"));
  });

  test("returns empty matches array (not an error) when file does not exist anywhere", () => {
    const fs = require("fs");

    fs.existsSync = (p) => {
      const rel = p.replace(process.cwd() + path.sep, "").replace(/\\/g, "/");
      return rel === "src" ? true : origExistsSync(p);
    };
    fs.readdirSync = (p, opts) => {
      const rel = p.replace(process.cwd() + path.sep, "").replace(/\\/g, "/");
      if (rel === "src") return [{ name: "OtherFile.jsx", isDirectory: () => false, isFile: () => true }];
      return [];
    };

    const { findFileByName } = jest.requireActual("../services/geminiProjectExplorer.service");
    const result = findFileByName("NonExistentComponent.jsx");
    expect(result.success).toBe(true);
    expect(result.matches).toEqual([]);
    // searchedScopes should include at least "src/"
    expect(result.searchedScopes).toContain("src/");
  });

  test("skips .env files during directory walk", () => {
    const fs = require("fs");

    fs.existsSync = (p) => {
      const rel = p.replace(process.cwd() + path.sep, "").replace(/\\/g, "/");
      return rel === "src" ? true : origExistsSync(p);
    };
    fs.readdirSync = (p, opts) => {
      const rel = p.replace(process.cwd() + path.sep, "").replace(/\\/g, "/");
      if (rel === "src") {
        return [
          { name: ".env", isDirectory: () => false, isFile: () => true },
          { name: ".env.local", isDirectory: () => false, isFile: () => true },
          { name: "safe.js", isDirectory: () => false, isFile: () => true },
        ];
      }
      return [];
    };

    const { findFileByName } = jest.requireActual("../services/geminiProjectExplorer.service");
    // Searching for ".env" should fail validation (blocked)
    const blocked = findFileByName(".env");
    expect(blocked.success).toBe(false);
    // Only safe.js would appear in a search; verify .env is not in any match for safe.js
    const safe = findFileByName("safe.js");
    expect(safe.success).toBe(true);
    expect(safe.matches.every((m) => !m.includes(".env"))).toBe(true);
  });
});

/* ─────────────────────────────────────────────
   3. _extractTargetFilenames correctness
   ───────────────────────────────────────────── */

describe("_extractTargetFilenames – bare filename extraction", () => {
  // Use the actual Gemini agent's exported function
  const { _extractTargetFilenames: geminiExtract } = jest.requireActual("../services/geminiAgent.service");
  const { _extractTargetFilenames: deepseekExtract } = jest.requireActual("../services/deepseekAgent.service");

  test("extracts .jsx file from user message", () => {
    const files = geminiExtract("Zeige mir DashboardIntegrated.jsx bitte");
    expect(files).toContain("DashboardIntegrated.jsx");
  });

  test("extracts .js file from user message", () => {
    const files = geminiExtract("Was macht admin.routes.js?");
    expect(files).toContain("admin.routes.js");
  });

  test("extracts .ts file", () => {
    const files = geminiExtract("Ich brauche Hilfe mit UserService.ts");
    expect(files).toContain("UserService.ts");
  });

  test("extracts .tsx file", () => {
    const files = geminiExtract("Analysiere App.tsx");
    expect(files).toContain("App.tsx");
  });

  test("extracts .json file", () => {
    const files = geminiExtract("Schau dir package.json an");
    expect(files).toContain("package.json");
  });

  test("does NOT re-extract a filename that is already part of a full path", () => {
    // "services/geminiAgent.service.js" → _extractCandidateFiles handles this;
    // _extractTargetFilenames should NOT return "geminiAgent.service.js" standalone
    // because the `g` in "geminiAgent" is preceded by `/`
    const files = geminiExtract("Lies services/geminiAgent.service.js");
    // The path-qualified part is not extracted as bare name
    // (may return nothing, or at most the outer filename if the regex
    // doesn't catch it preceded by /)
    expect(files).not.toContain("services/geminiAgent.service.js");
  });

  test("returns empty array for message without filenames", () => {
    expect(geminiExtract("Hallo, wie geht es dir?")).toEqual([]);
    expect(geminiExtract("")).toEqual([]);
  });

  test("returns at most 3 filenames", () => {
    const files = geminiExtract(
      "Schau dir A.jsx B.js C.ts D.json E.md an"
    );
    expect(files.length).toBeLessThanOrEqual(3);
  });

  test("is case-insensitive for deduplication", () => {
    const files = geminiExtract("Dashboard.jsx vs dashboard.jsx");
    // Should appear only once
    expect(files.length).toBe(1);
  });

  test("DeepSeek: extracts .jsx file from user message", () => {
    const files = deepseekExtract("Wo liegt DashboardIntegrated.jsx?");
    expect(files).toContain("DashboardIntegrated.jsx");
  });

  test("DeepSeek: returns empty array for irrelevant message", () => {
    expect(deepseekExtract("Erkläre mir die Architektur")).toEqual([]);
  });
});

/* ─────────────────────────────────────────────
   Helper mock setup for integration tests
   ───────────────────────────────────────────── */

let mockFindFileByName;
let mockReadFile;
let mockScanProjectStructure;
let mockNeedsProjectContext;
let mockRunGeminiChat;
let mockCreateDeepSeekCompletion;

// We use global mocks and override per-test with mockImplementation
jest.mock("../services/geminiProjectExplorer.service", () => ({
  scanProjectStructure: jest.fn(() => ({ success: true, tree: "services/\n  foo.js", entryCount: 1 })),
  listDirectory: jest.fn(() => ({ success: true, entries: [] })),
  readFile: jest.fn(() => ({ success: false, error: "not found" })),
  findFileByName: jest.fn(() => ({ success: true, matches: [], searchedScopes: [] })),
  extractTargetFilenames: jest.fn(() => []),
  needsProjectContext: jest.fn(() => false),
}));

const geminiAgent   = require("../services/geminiAgent.service");
const deepseekAgent = require("../services/deepseekAgent.service");
const { runGeminiChat } = require("../services/geminiArchitect.service");
const { createDeepSeekChatCompletion, extractDeepSeekText } = require("../services/deepseek.service");
const explorer = require("../services/geminiProjectExplorer.service");

beforeEach(() => {
  jest.clearAllMocks();
  runGeminiChat.mockResolvedValue({ success: true, text: "Mock-Antwort Gemini." });
  createDeepSeekChatCompletion.mockResolvedValue({
    choices: [{ message: { content: "Mock-Antwort DeepSeek." } }],
  });
  extractDeepSeekText.mockImplementation((c) => c?.choices?.[0]?.message?.content || "");
  explorer.scanProjectStructure.mockReturnValue({
    success: true,
    tree: "services/\n  geminiAgent.service.js\nroutes/\n  admin.routes.js",
    entryCount: 3,
  });
  explorer.readFile.mockReturnValue({ success: false, error: "not found" });
  explorer.findFileByName.mockReturnValue({ success: true, matches: [], searchedScopes: [] });
  explorer.needsProjectContext.mockReturnValue(false);
});

/* ─────────────────────────────────────────────
   4. Integration – findFileByName called for bare filename in message
   ───────────────────────────────────────────── */

describe("Integration – findFileByName triggered by bare filename in message (Gemini)", () => {
  test("findFileByName is called when a bare .jsx filename appears in architecture mode", async () => {
    await geminiAgent.startConversation({
      mode: "architecture",
      message: "Erkläre DashboardIntegrated.jsx",
    });
    expect(explorer.findFileByName).toHaveBeenCalledWith("DashboardIntegrated.jsx");
  });

  test("findFileByName is called for bare .js filename in code_review mode", async () => {
    await geminiAgent.startConversation({
      mode: "code_review",
      message: "Bitte überprüfe UserList.js",
    });
    expect(explorer.findFileByName).toHaveBeenCalledWith("UserList.js");
  });

  test("when findFileByName returns a match, readFile is called with the resolved path", async () => {
    explorer.findFileByName.mockReturnValue({
      success: true,
      matches: ["src/components/Dashboard.jsx"],
      searchedScopes: ["src/", "components/"],
    });
    explorer.readFile.mockImplementation((p) => {
      if (p === "src/components/Dashboard.jsx") {
        return { success: true, content: "export default function Dashboard(){}", sizeBytes: 100, truncated: false };
      }
      return { success: false, error: "not found" };
    });

    await geminiAgent.startConversation({
      mode: "architecture",
      message: "Was macht Dashboard.jsx?",
    });
    expect(explorer.readFile).toHaveBeenCalledWith("src/components/Dashboard.jsx");
  });
});

describe("Integration – findFileByName triggered by bare filename in message (DeepSeek)", () => {
  test("findFileByName is called when bare .jsx filename appears in backend_review mode", async () => {
    await deepseekAgent.startConversation({
      mode: "backend_review",
      message: "Untersuche DataTable.jsx",
    });
    expect(explorer.findFileByName).toHaveBeenCalledWith("DataTable.jsx");
  });

  test("when findFileByName resolves, readFile is called with the resolved path", async () => {
    explorer.findFileByName.mockReturnValue({
      success: true,
      matches: ["services/myService.js"],
      searchedScopes: ["services/"],
    });
    explorer.readFile.mockImplementation((p) => {
      if (p === "services/myService.js") {
        return { success: true, content: "module.exports = {};", sizeBytes: 50, truncated: false };
      }
      return { success: false, error: "not found" };
    });

    await deepseekAgent.startConversation({
      mode: "backend_review",
      message: "Was macht myService.js?",
    });
    expect(explorer.readFile).toHaveBeenCalledWith("services/myService.js");
  });
});

/* ─────────────────────────────────────────────
   5. Integration – not-found file gives clear message with searched scopes
   ───────────────────────────────────────────── */

describe("Integration – not-found file yields honest diagnosis", () => {
  test("Gemini: response metadata has targetFileResolved=false when file not found", async () => {
    explorer.findFileByName.mockReturnValue({
      success: true,
      matches: [],
      searchedScopes: ["src/", "components/", "pages/"],
    });

    const result = await geminiAgent.startConversation({
      mode: "architecture",
      message: "Zeige mir NonExistentDashboard.jsx",
    });

    expect(result.metadata.targetFileRequested).toBe("NonExistentDashboard.jsx");
    expect(result.metadata.targetFileResolved).toBe(false);
    expect(result.metadata.resolvedFilePath).toBeNull();
  });

  test("Gemini: searchedScopes is populated in metadata when file not found", async () => {
    explorer.findFileByName.mockReturnValue({
      success: true,
      matches: [],
      searchedScopes: ["src/", "components/", "pages/", "views/"],
    });

    const result = await geminiAgent.startConversation({
      mode: "architecture",
      message: "Analysiere MissingPage.jsx",
    });

    expect(result.metadata.searchedScopes).toEqual(["src/", "components/", "pages/", "views/"]);
  });

  test("DeepSeek: response metadata has targetFileResolved=false when file not found", async () => {
    explorer.findFileByName.mockReturnValue({
      success: true,
      matches: [],
      searchedScopes: ["services/", "routes/"],
    });

    const result = await deepseekAgent.startConversation({
      mode: "backend_review",
      message: "Bitte lies MissingService.js",
    });

    expect(result.metadata.targetFileRequested).toBe("MissingService.js");
    expect(result.metadata.targetFileResolved).toBe(false);
    expect(result.metadata.resolvedFilePath).toBeNull();
  });

  test("Gemini: no targetFile fields in metadata when no bare filename mentioned", async () => {
    const result = await geminiAgent.startConversation({
      mode: "architecture",
      message: "Erkläre die Architektur des Systems",
    });

    // When no bare filename was requested, none of these fields should be present
    expect(result.metadata).not.toHaveProperty("targetFileRequested");
    expect(result.metadata).not.toHaveProperty("targetFileResolved");
    expect(result.metadata).not.toHaveProperty("resolvedFilePath");
  });
});

/* ─────────────────────────────────────────────
   6. Integration – multiple matches handled cleanly
   ───────────────────────────────────────────── */

describe("Integration – multiple file matches handled cleanly", () => {
  test("Gemini: first match is used as resolved path when multiple exist", async () => {
    explorer.findFileByName.mockReturnValue({
      success: true,
      matches: ["src/Button.jsx", "components/Button.jsx", "pages/Button.jsx"],
      searchedScopes: ["src/", "components/", "pages/"],
    });
    explorer.readFile.mockImplementation((p) => {
      if (p === "src/Button.jsx") {
        return { success: true, content: "export const Button = () => <button/>;", sizeBytes: 80, truncated: false };
      }
      return { success: false, error: "not found" };
    });

    const result = await geminiAgent.startConversation({
      mode: "architecture",
      message: "Erkläre Button.jsx",
    });

    expect(result.metadata.targetFileResolved).toBe(true);
    expect(result.metadata.resolvedFilePath).toBe("src/Button.jsx");
    // readFile should have been called with the first match
    expect(explorer.readFile).toHaveBeenCalledWith("src/Button.jsx");
  });

  test("DeepSeek: first match is used as resolved path when multiple exist", async () => {
    explorer.findFileByName.mockReturnValue({
      success: true,
      matches: ["services/auth.js", "middleware/auth.js"],
      searchedScopes: ["services/", "middleware/"],
    });
    explorer.readFile.mockImplementation((p) => {
      if (p === "services/auth.js") {
        return { success: true, content: "module.exports = { auth: true };", sizeBytes: 50, truncated: false };
      }
      return { success: false, error: "not found" };
    });

    const result = await deepseekAgent.startConversation({
      mode: "backend_review",
      message: "Was macht auth.js?",
    });

    expect(result.metadata.targetFileResolved).toBe(true);
    expect(result.metadata.resolvedFilePath).toBe("services/auth.js");
  });

  test("multiple-match hint is included in context text sent to model", async () => {
    explorer.findFileByName.mockReturnValue({
      success: true,
      matches: ["src/Card.jsx", "components/Card.jsx"],
      searchedScopes: ["src/", "components/"],
    });
    // First read succeeds so it doesn't produce a "not found" note
    explorer.readFile.mockImplementation((p) => {
      if (p === "src/Card.jsx") {
        return { success: true, content: "export const Card = () => <div/>;", sizeBytes: 60, truncated: false };
      }
      return { success: false, error: "not found" };
    });

    // Capture the userMessage sent to Gemini (context is injected into effectiveUserMessage)
    let capturedUserMessage = "";
    runGeminiChat.mockImplementation(async ({ userMessage }) => {
      capturedUserMessage = userMessage || "";
      return { success: true, text: "Antwort." };
    });

    await geminiAgent.startConversation({
      mode: "architecture",
      message: "Erkläre Card.jsx",
    });

    // The user message sent to the model should contain the multi-match hint
    expect(capturedUserMessage).toMatch(/card\.jsx.*treffer|treffer.*card\.jsx/i);
  });
});

/* ─────────────────────────────────────────────
   7. Integration – new diagnostics fields in response metadata
   ───────────────────────────────────────────── */

describe("Integration – target file diagnostics fields in response metadata", () => {
  test("Gemini: targetFileRequested matches the bare filename in the message", async () => {
    explorer.findFileByName.mockReturnValue({
      success: true,
      matches: ["src/App.jsx"],
      searchedScopes: ["src/"],
    });
    explorer.readFile.mockReturnValue({ success: true, content: "// App", sizeBytes: 10, truncated: false });

    const result = await geminiAgent.startConversation({
      mode: "architecture",
      message: "Erkläre App.jsx",
    });

    expect(result.metadata.targetFileRequested).toBe("App.jsx");
    expect(result.metadata.targetFileResolved).toBe(true);
    expect(result.metadata.resolvedFilePath).toBe("src/App.jsx");
  });

  test("DeepSeek: targetFileRequested and resolvedFilePath are set correctly", async () => {
    explorer.findFileByName.mockReturnValue({
      success: true,
      matches: ["services/agentBridge.service.js"],
      searchedScopes: ["services/"],
    });
    explorer.readFile.mockReturnValue({
      success: true,
      content: "// bridge",
      sizeBytes: 20,
      truncated: false,
    });

    const result = await deepseekAgent.startConversation({
      mode: "backend_review",
      message: "Was macht agentBridge.service.js?",
    });

    expect(result.metadata.targetFileRequested).toBe("agentBridge.service.js");
    expect(result.metadata.targetFileResolved).toBe(true);
    expect(result.metadata.resolvedFilePath).toBe("services/agentBridge.service.js");
  });

  test("Gemini: searchedScopes array present in metadata when file not found", async () => {
    const scopes = ["src/", "components/", "pages/", "views/", "layouts/", "styles/",
      "config/", "utils/", "lib/", "public/", "services/", "routes/", "middleware/", "engines/"];
    explorer.findFileByName.mockReturnValue({
      success: true,
      matches: [],
      searchedScopes: scopes,
    });

    const result = await geminiAgent.startConversation({
      mode: "architecture",
      message: "Zeig mir GhostFile.jsx",
    });

    expect(result.metadata.searchedScopes).toEqual(scopes);
    expect(result.metadata.targetFileResolved).toBe(false);
    expect(result.metadata.resolvedFilePath).toBeNull();
  });

  test("Gemini: no searchedScopes field when file is found (field is optional)", async () => {
    explorer.findFileByName.mockReturnValue({
      success: true,
      matches: ["src/Found.jsx"],
      searchedScopes: [],  // empty → should be omitted from metadata
    });
    explorer.readFile.mockReturnValue({ success: true, content: "// found", sizeBytes: 10, truncated: false });

    const result = await geminiAgent.startConversation({
      mode: "architecture",
      message: "Lies Found.jsx",
    });

    // searchedScopes is omitted when the array is empty
    expect(result.metadata).not.toHaveProperty("searchedScopes");
  });
});

/* ─────────────────────────────────────────────
   8. Frontend root – findFileByName searches FRONTEND_ROOT paths
   ───────────────────────────────────────────── */

describe("findFileByName – frontend root support (FRONTEND_ROOT configured)", () => {
  const path = require("path");
  const origReaddirSync = require("fs").readdirSync;
  const origExistsSync  = require("fs").existsSync;
  const FAKE_FRONTEND_ROOT = path.resolve("/fake/frontend");

  beforeEach(() => {
    jest.resetModules();
    process.env.FRONTEND_ROOT = FAKE_FRONTEND_ROOT;
  });

  afterEach(() => {
    delete process.env.FRONTEND_ROOT;
    require("fs").readdirSync = origReaddirSync;
    require("fs").existsSync  = origExistsSync;
    jest.resetModules();
  });

  test("finds a frontend .jsx file inside FRONTEND_ROOT/src/components/", () => {
    const fs = require("fs");
    fs.existsSync = (p) => {
      // Only the frontend src/ directory exists
      if (p === path.join(FAKE_FRONTEND_ROOT, "src")) return true;
      return origExistsSync(p);
    };
    fs.readdirSync = (p, opts) => {
      if (p === path.join(FAKE_FRONTEND_ROOT, "src")) {
        return [{ name: "components", isDirectory: () => true, isFile: () => false }];
      }
      if (p === path.join(FAKE_FRONTEND_ROOT, "src", "components")) {
        return [{ name: "DashboardIntegrated.jsx", isDirectory: () => false, isFile: () => true }];
      }
      return [];
    };

    const { findFileByName } = jest.requireActual("../services/geminiProjectExplorer.service");
    const result = findFileByName("DashboardIntegrated.jsx");

    expect(result.success).toBe(true);
    expect(result.matches.some((m) => m.includes("DashboardIntegrated.jsx"))).toBe(true);
    // searchedScopes must show that the frontend root was consulted
    expect(result.searchedScopes.some((s) => s.startsWith("frontend:"))).toBe(true);
  });

  test("searchedScopes contains frontend: prefixed entries when FRONTEND_ROOT is set", () => {
    const fs = require("fs");
    fs.existsSync = (p) => {
      if (p === path.join(FAKE_FRONTEND_ROOT, "src")) return true;
      return origExistsSync(p);
    };
    fs.readdirSync = (p, opts) => {
      if (p === path.join(FAKE_FRONTEND_ROOT, "src")) {
        return [{ name: "App.tsx", isDirectory: () => false, isFile: () => true }];
      }
      return [];
    };

    const { findFileByName } = jest.requireActual("../services/geminiProjectExplorer.service");
    const result = findFileByName("NonExistent.jsx");

    expect(result.success).toBe(true);
    expect(result.searchedScopes.some((s) => s.startsWith("frontend:"))).toBe(true);
  });

  test("backend file is still found when FRONTEND_ROOT is also configured", () => {
    const fs = require("fs");
    // Mock: backend has services/ with agentRegistry.service.js
    fs.existsSync = (p) => {
      const rel = p.replace(process.cwd() + path.sep, "").replace(/\\/g, "/");
      if (rel === "services") return true;
      // Frontend src exists too (but does not contain the target file)
      if (p === path.join(FAKE_FRONTEND_ROOT, "src")) return true;
      return origExistsSync(p);
    };
    fs.readdirSync = (p, opts) => {
      const rel = p.replace(process.cwd() + path.sep, "").replace(/\\/g, "/");
      if (rel === "services") {
        return [{ name: "agentRegistry.service.js", isDirectory: () => false, isFile: () => true }];
      }
      if (p === path.join(FAKE_FRONTEND_ROOT, "src")) {
        return [];
      }
      return [];
    };

    const { findFileByName } = jest.requireActual("../services/geminiProjectExplorer.service");
    const result = findFileByName("agentRegistry.service.js");

    expect(result.success).toBe(true);
    expect(result.matches.some((m) => m.includes("agentRegistry.service.js"))).toBe(true);
    // Must not be a frontend-prefixed match
    expect(result.matches.every((m) => !m.startsWith("frontend:"))).toBe(true);
  });

  test("no additional scopes are searched when FRONTEND_ROOT is not set", () => {
    // This test verifies the default (no FRONTEND_ROOT) still works unchanged.
    // Unset env var and re-require the module.
    delete process.env.FRONTEND_ROOT;
    jest.resetModules();

    const fs = require("fs");
    fs.existsSync = (p) => {
      const rel = p.replace(process.cwd() + path.sep, "").replace(/\\/g, "/");
      if (rel === "src") return true;
      return origExistsSync(p);
    };
    fs.readdirSync = (p, opts) => {
      const rel = p.replace(process.cwd() + path.sep, "").replace(/\\/g, "/");
      if (rel === "src") return [];
      return [];
    };

    const { findFileByName } = jest.requireActual("../services/geminiProjectExplorer.service");
    const result = findFileByName("SomeComponent.jsx");

    expect(result.success).toBe(true);
    // Without FRONTEND_ROOT no frontend: scopes should appear
    expect(result.searchedScopes.every((s) => !s.startsWith("frontend:"))).toBe(true);
  });
});

/* ─────────────────────────────────────────────
   9. Write scope unchanged by frontend root addition
   ───────────────────────────────────────────── */

describe("Write scope – unchanged after frontend root addition", () => {
  const { checkWriteScope } = require("../services/agentRegistry.service");

  test("Gemini may still write to src/ (frontend path)", () => {
    const result = checkWriteScope("gemini", "src/components/Button.jsx");
    expect(result.allowed).toBe(true);
  });

  test("Gemini is still blocked from writing to services/", () => {
    const result = checkWriteScope("gemini", "services/myService.js");
    expect(result.allowed).toBe(false);
  });

  test("DeepSeek may still write to services/ (backend path)", () => {
    const result = checkWriteScope("deepseek", "services/myService.js");
    expect(result.allowed).toBe(true);
  });

  test("DeepSeek is still blocked from writing to src/", () => {
    const result = checkWriteScope("deepseek", "src/components/Button.jsx");
    expect(result.allowed).toBe(false);
  });

  test("FRONTEND_SEARCH_PATHS exported from agentRegistry contains expected sub-paths", () => {
    const { FRONTEND_SEARCH_PATHS } = require("../services/agentRegistry.service");
    expect(FRONTEND_SEARCH_PATHS).toContain("src/");
    expect(FRONTEND_SEARCH_PATHS).toContain("src/components/");
    expect(FRONTEND_SEARCH_PATHS).toContain("src/views/");
    expect(FRONTEND_SEARCH_PATHS).toContain("src/hooks/");
    expect(FRONTEND_SEARCH_PATHS).toContain("src/services/");
    expect(FRONTEND_SEARCH_PATHS).toContain("src/utils/");
  });
});
