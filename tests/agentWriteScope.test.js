"use strict";

/**
 * Agent Write-Scope Enforcement Tests
 *
 * Verifies the role-based write policy:
 *  - Both Gemini and DeepSeek may read from frontend AND backend paths.
 *  - Gemini (frontend_agent) may only WRITE to frontend paths.
 *  - DeepSeek (backend_agent) may only WRITE to backend paths.
 *  - Cross-scope write attempts are blocked with a clear error message.
 *  - In-scope write attempts (dryRun + execute) succeed normally.
 *
 * This file tests:
 *  1. agentRegistry  – checkWriteScope(), FRONTEND_WRITE_PATHS, BACKEND_WRITE_PATHS
 *  2. geminiAgent    – _isPathAllowed (read), _isWritePathAllowed (write), _dryRunChanges
 *  3. deepseekAgent  – _isPathAllowed (read), _isWritePathAllowed (write), _dryRunChanges
 */

/* ─────────────────────────────────────────────
   Mock external providers before requiring services
   ───────────────────────────────────────────── */

jest.mock("../services/geminiArchitect.service", () => ({
  isGeminiConfigured: jest.fn(() => true),
  runGeminiChat: jest.fn(async () => ({ success: true, text: "mock gemini" })),
  VALID_MODES: [],
  RESULT_TYPES: { SUCCESS: "success" },
  FALLBACK_LABELS: {},
}));

jest.mock("../services/deepseek.service", () => ({
  isDeepSeekConfigured: jest.fn(() => true),
  createDeepSeekChatCompletion: jest.fn(async () => ({
    choices: [{ message: { content: "mock deepseek" } }],
  })),
  extractDeepSeekText: jest.fn((c) => c?.choices?.[0]?.message?.content || ""),
  resolveModel: jest.fn(() => "deepseek-chat"),
  DEEPSEEK_FAST_MODEL: "deepseek-chat",
  DEEPSEEK_DEEP_MODEL: "deepseek-reasoner",
  getDeepSeekClient: jest.fn(),
  runDeepSeekJsonAnalysis: jest.fn(),
}));

/* ─────────────────────────────────────────────
   Imports under test
   ───────────────────────────────────────────── */

const {
  checkWriteScope,
  FRONTEND_WRITE_PATHS,
  BACKEND_WRITE_PATHS,
  ALLOWED_PROJECT_PATHS,
} = require("../services/agentRegistry.service");

const {
  _isPathAllowed: geminiIsPathAllowed,
  _isWritePathAllowed: geminiIsWritePathAllowed,
  _dryRunChanges: geminiDryRunChanges,
} = require("../services/geminiAgent.service");

const {
  _isPathAllowed: deepseekIsPathAllowed,
  _isWritePathAllowed: deepseekIsWritePathAllowed,
  _dryRunChanges: deepseekDryRunChanges,
} = require("../services/deepseekAgent.service");

/* ─────────────────────────────────────────────
   1. agentRegistry – write-scope constants
   ───────────────────────────────────────────── */

describe("agentRegistry – FRONTEND_WRITE_PATHS / BACKEND_WRITE_PATHS", () => {
  test("FRONTEND_WRITE_PATHS is a non-empty array of strings ending with /", () => {
    expect(Array.isArray(FRONTEND_WRITE_PATHS)).toBe(true);
    expect(FRONTEND_WRITE_PATHS.length).toBeGreaterThan(0);
    for (const p of FRONTEND_WRITE_PATHS) {
      expect(typeof p).toBe("string");
      expect(p.endsWith("/")).toBe(true);
    }
  });

  test("BACKEND_WRITE_PATHS is a non-empty array of strings ending with /", () => {
    expect(Array.isArray(BACKEND_WRITE_PATHS)).toBe(true);
    expect(BACKEND_WRITE_PATHS.length).toBeGreaterThan(0);
    for (const p of BACKEND_WRITE_PATHS) {
      expect(typeof p).toBe("string");
      expect(p.endsWith("/")).toBe(true);
    }
  });

  test("FRONTEND_WRITE_PATHS and BACKEND_WRITE_PATHS together cover all ALLOWED_PROJECT_PATHS", () => {
    const combined = new Set([...FRONTEND_WRITE_PATHS, ...BACKEND_WRITE_PATHS]);
    for (const allowed of ALLOWED_PROJECT_PATHS) {
      expect(combined.has(allowed)).toBe(true);
    }
  });
});

/* ─────────────────────────────────────────────
   2. agentRegistry – checkWriteScope()
   ───────────────────────────────────────────── */

describe("agentRegistry – checkWriteScope()", () => {
  // Gemini allowed (frontend paths)
  test("gemini may write to src/", () => {
    const r = checkWriteScope("gemini", "src/components/App.jsx");
    expect(r.allowed).toBe(true);
  });

  test("gemini may write to components/", () => {
    const r = checkWriteScope("gemini", "components/Button.jsx");
    expect(r.allowed).toBe(true);
  });

  test("gemini may write to styles/", () => {
    const r = checkWriteScope("gemini", "styles/main.css");
    expect(r.allowed).toBe(true);
  });

  test("gemini may write to pages/", () => {
    const r = checkWriteScope("gemini", "pages/index.js");
    expect(r.allowed).toBe(true);
  });

  test("gemini may write to views/", () => {
    const r = checkWriteScope("gemini", "views/dashboard.jsx");
    expect(r.allowed).toBe(true);
  });

  test("gemini may write to layouts/", () => {
    const r = checkWriteScope("gemini", "layouts/default.jsx");
    expect(r.allowed).toBe(true);
  });

  test("gemini may write to public/", () => {
    const r = checkWriteScope("gemini", "public/favicon.ico");
    expect(r.allowed).toBe(true);
  });

  // Gemini blocked (backend paths)
  test("gemini is BLOCKED from writing services/", () => {
    const r = checkWriteScope("gemini", "services/auth.service.js");
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/Gemini/);
    expect(r.reason).toMatch(/Frontend-Agent/);
    expect(r.reason).toMatch(/DeepSeek/);
  });

  test("gemini is BLOCKED from writing routes/", () => {
    const r = checkWriteScope("gemini", "routes/admin.routes.js");
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/Gemini/);
  });

  test("gemini is BLOCKED from writing middleware/", () => {
    const r = checkWriteScope("gemini", "middleware/auth.js");
    expect(r.allowed).toBe(false);
  });

  test("gemini is BLOCKED from writing engines/", () => {
    const r = checkWriteScope("gemini", "engines/processor.js");
    expect(r.allowed).toBe(false);
  });

  test("gemini is BLOCKED from writing utils/", () => {
    const r = checkWriteScope("gemini", "utils/logger.js");
    expect(r.allowed).toBe(false);
  });

  // DeepSeek allowed (backend paths)
  test("deepseek may write to services/", () => {
    const r = checkWriteScope("deepseek", "services/auth.service.js");
    expect(r.allowed).toBe(true);
  });

  test("deepseek may write to routes/", () => {
    const r = checkWriteScope("deepseek", "routes/admin.routes.js");
    expect(r.allowed).toBe(true);
  });

  test("deepseek may write to middleware/", () => {
    const r = checkWriteScope("deepseek", "middleware/auth.js");
    expect(r.allowed).toBe(true);
  });

  test("deepseek may write to utils/", () => {
    const r = checkWriteScope("deepseek", "utils/logger.js");
    expect(r.allowed).toBe(true);
  });

  test("deepseek may write to engines/", () => {
    const r = checkWriteScope("deepseek", "engines/worker.js");
    expect(r.allowed).toBe(true);
  });

  test("deepseek may write to config/", () => {
    const r = checkWriteScope("deepseek", "config/db.js");
    expect(r.allowed).toBe(true);
  });

  test("deepseek may write to lib/", () => {
    const r = checkWriteScope("deepseek", "lib/helpers.js");
    expect(r.allowed).toBe(true);
  });

  // DeepSeek blocked (frontend paths)
  test("deepseek is BLOCKED from writing src/", () => {
    const r = checkWriteScope("deepseek", "src/App.jsx");
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/DeepSeek/);
    expect(r.reason).toMatch(/Backend-Agent/);
    expect(r.reason).toMatch(/Gemini/);
  });

  test("deepseek is BLOCKED from writing components/", () => {
    const r = checkWriteScope("deepseek", "components/Button.jsx");
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/DeepSeek/);
  });

  test("deepseek is BLOCKED from writing pages/", () => {
    const r = checkWriteScope("deepseek", "pages/home.js");
    expect(r.allowed).toBe(false);
  });

  test("deepseek is BLOCKED from writing styles/", () => {
    const r = checkWriteScope("deepseek", "styles/app.css");
    expect(r.allowed).toBe(false);
  });

  test("deepseek is BLOCKED from writing public/", () => {
    const r = checkWriteScope("deepseek", "public/logo.png");
    expect(r.allowed).toBe(false);
  });

  // Unknown agent
  test("unknown agent is always blocked", () => {
    const r = checkWriteScope("oracle", "services/db.js");
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/Unbekannter Agent/);
  });

  // Invalid input
  test("rejects null/undefined/empty filePath", () => {
    expect(checkWriteScope("gemini", null).allowed).toBe(false);
    expect(checkWriteScope("gemini", undefined).allowed).toBe(false);
    expect(checkWriteScope("gemini", "").allowed).toBe(false);
    expect(checkWriteScope("deepseek", null).allowed).toBe(false);
  });
});

/* ─────────────────────────────────────────────
   3. geminiAgent – read is unrestricted (both scopes)
   ───────────────────────────────────────────── */

describe("geminiAgent – _isPathAllowed (read scope = all allowed paths)", () => {
  test("Gemini can READ frontend paths", () => {
    expect(geminiIsPathAllowed("src/App.jsx")).toBe(true);
    expect(geminiIsPathAllowed("components/Button.jsx")).toBe(true);
    expect(geminiIsPathAllowed("pages/index.js")).toBe(true);
    expect(geminiIsPathAllowed("styles/main.css")).toBe(true);
    expect(geminiIsPathAllowed("public/logo.png")).toBe(true);
  });

  test("Gemini can READ backend paths", () => {
    expect(geminiIsPathAllowed("services/auth.service.js")).toBe(true);
    expect(geminiIsPathAllowed("routes/admin.routes.js")).toBe(true);
    expect(geminiIsPathAllowed("middleware/auth.js")).toBe(true);
    expect(geminiIsPathAllowed("utils/logger.js")).toBe(true);
    expect(geminiIsPathAllowed("engines/worker.js")).toBe(true);
    expect(geminiIsPathAllowed("config/db.js")).toBe(true);
  });

  test("Gemini READ is still blocked for dangerous patterns", () => {
    expect(geminiIsPathAllowed(".env")).toBe(false);
    expect(geminiIsPathAllowed("node_modules/pkg/index.js")).toBe(false);
    expect(geminiIsPathAllowed("secrets/key.pem")).toBe(false);
    expect(geminiIsPathAllowed("../../etc/passwd")).toBe(false);
  });
});

/* ─────────────────────────────────────────────
   4. geminiAgent – _isWritePathAllowed
   ───────────────────────────────────────────── */

describe("geminiAgent – _isWritePathAllowed (write scope = frontend only)", () => {
  test("allows frontend paths", () => {
    expect(geminiIsWritePathAllowed("src/App.jsx").allowed).toBe(true);
    expect(geminiIsWritePathAllowed("components/Header.jsx").allowed).toBe(true);
    expect(geminiIsWritePathAllowed("styles/app.css").allowed).toBe(true);
    expect(geminiIsWritePathAllowed("pages/index.js").allowed).toBe(true);
  });

  test("blocks backend paths", () => {
    expect(geminiIsWritePathAllowed("services/auth.service.js").allowed).toBe(false);
    expect(geminiIsWritePathAllowed("routes/admin.routes.js").allowed).toBe(false);
    expect(geminiIsWritePathAllowed("middleware/validate.js").allowed).toBe(false);
    expect(geminiIsWritePathAllowed("utils/logger.js").allowed).toBe(false);
  });

  test("blocked reason mentions Gemini and DeepSeek", () => {
    const r = geminiIsWritePathAllowed("services/my.service.js");
    expect(r.reason).toMatch(/Gemini/);
    expect(r.reason).toMatch(/DeepSeek/);
  });
});

/* ─────────────────────────────────────────────
   5. deepseekAgent – read is unrestricted (both scopes)
   ───────────────────────────────────────────── */

describe("deepseekAgent – _isPathAllowed (read scope = all allowed paths)", () => {
  test("DeepSeek can READ frontend paths", () => {
    expect(deepseekIsPathAllowed("src/App.jsx")).toBe(true);
    expect(deepseekIsPathAllowed("components/Button.jsx")).toBe(true);
    expect(deepseekIsPathAllowed("pages/index.js")).toBe(true);
    expect(deepseekIsPathAllowed("styles/main.css")).toBe(true);
    expect(deepseekIsPathAllowed("public/logo.png")).toBe(true);
  });

  test("DeepSeek can READ backend paths", () => {
    expect(deepseekIsPathAllowed("services/auth.service.js")).toBe(true);
    expect(deepseekIsPathAllowed("routes/admin.routes.js")).toBe(true);
    expect(deepseekIsPathAllowed("middleware/auth.js")).toBe(true);
    expect(deepseekIsPathAllowed("utils/logger.js")).toBe(true);
    expect(deepseekIsPathAllowed("engines/worker.js")).toBe(true);
    expect(deepseekIsPathAllowed("config/db.js")).toBe(true);
  });

  test("DeepSeek READ is still blocked for dangerous patterns", () => {
    expect(deepseekIsPathAllowed(".env")).toBe(false);
    expect(deepseekIsPathAllowed("node_modules/pkg/index.js")).toBe(false);
    expect(deepseekIsPathAllowed("secrets/key.pem")).toBe(false);
    expect(deepseekIsPathAllowed("../../etc/passwd")).toBe(false);
  });
});

/* ─────────────────────────────────────────────
   6. deepseekAgent – _isWritePathAllowed
   ───────────────────────────────────────────── */

describe("deepseekAgent – _isWritePathAllowed (write scope = backend only)", () => {
  test("allows backend paths", () => {
    expect(deepseekIsWritePathAllowed("services/auth.service.js").allowed).toBe(true);
    expect(deepseekIsWritePathAllowed("routes/admin.routes.js").allowed).toBe(true);
    expect(deepseekIsWritePathAllowed("middleware/validate.js").allowed).toBe(true);
    expect(deepseekIsWritePathAllowed("utils/logger.js").allowed).toBe(true);
    expect(deepseekIsWritePathAllowed("engines/worker.js").allowed).toBe(true);
  });

  test("blocks frontend paths", () => {
    expect(deepseekIsWritePathAllowed("src/App.jsx").allowed).toBe(false);
    expect(deepseekIsWritePathAllowed("components/Header.jsx").allowed).toBe(false);
    expect(deepseekIsWritePathAllowed("styles/app.css").allowed).toBe(false);
    expect(deepseekIsWritePathAllowed("pages/index.js").allowed).toBe(false);
    expect(deepseekIsWritePathAllowed("public/logo.png").allowed).toBe(false);
  });

  test("blocked reason mentions DeepSeek and Gemini", () => {
    const r = deepseekIsWritePathAllowed("src/App.jsx");
    expect(r.reason).toMatch(/DeepSeek/);
    expect(r.reason).toMatch(/Gemini/);
  });
});

/* ─────────────────────────────────────────────
   7. geminiAgent – _dryRunChanges write-scope enforcement
   ───────────────────────────────────────────── */

describe("geminiAgent – _dryRunChanges write-scope enforcement", () => {
  test("allows patch on frontend path (src/)", () => {
    const conv = {
      conversationId: "test-g-dry-ok",
      preparedPatch: {
        editPlan: [
          { file: "src/App.jsx", operation: "insert", content: "// test" },
        ],
      },
    };
    const result = geminiDryRunChanges(conv);
    // No write-scope issues for frontend path
    const writeBlockIssues = result.issues.filter((i) => i.includes("Schreibzugriff verweigert"));
    expect(writeBlockIssues).toHaveLength(0);
  });

  test("blocks patch on backend path (services/)", () => {
    const conv = {
      conversationId: "test-g-dry-block",
      preparedPatch: {
        editPlan: [
          { file: "services/auth.service.js", operation: "replace", oldContent: "x", newContent: "y" },
        ],
      },
    };
    const result = geminiDryRunChanges(conv);
    expect(result.success).toBe(false);
    const blockIssue = result.issues.find((i) => i.includes("Schreibzugriff verweigert"));
    expect(blockIssue).toBeDefined();
    expect(blockIssue).toMatch(/Gemini/);
    const blockLog = result.log.find((l) => l.includes("WRITE-SCOPE BLOCKED"));
    expect(blockLog).toBeDefined();
  });

  test("blocks patch on routes/ path", () => {
    const conv = {
      conversationId: "test-g-dry-routes",
      preparedPatch: {
        editPlan: [
          { file: "routes/admin.routes.js", operation: "insert", content: "// hack" },
        ],
      },
    };
    const result = geminiDryRunChanges(conv);
    expect(result.success).toBe(false);
    expect(result.issues.some((i) => i.includes("Schreibzugriff verweigert"))).toBe(true);
  });

  test("mixed patch: blocks backend edit, passes frontend edit", () => {
    const conv = {
      conversationId: "test-g-dry-mixed",
      preparedPatch: {
        editPlan: [
          { file: "src/App.jsx", operation: "insert", content: "// ok" },
          { file: "services/auth.service.js", operation: "insert", content: "// blocked" },
        ],
      },
    };
    const result = geminiDryRunChanges(conv);
    // Overall fails because one edit is blocked
    expect(result.success).toBe(false);
    // Only one write-scope issue
    const writeBlockIssues = result.issues.filter((i) => i.includes("Schreibzugriff verweigert"));
    expect(writeBlockIssues).toHaveLength(1);
  });
});

/* ─────────────────────────────────────────────
   8. deepseekAgent – _dryRunChanges write-scope enforcement
   ───────────────────────────────────────────── */

describe("deepseekAgent – _dryRunChanges write-scope enforcement", () => {
  test("allows patch on backend path (services/)", () => {
    const conv = {
      conversationId: "test-ds-dry-ok",
      preparedPatch: {
        editPlan: [
          { file: "services/myService.js", operation: "insert", content: "// test" },
        ],
      },
    };
    const result = deepseekDryRunChanges(conv);
    const writeBlockIssues = result.issues.filter((i) => i.includes("Schreibzugriff verweigert"));
    expect(writeBlockIssues).toHaveLength(0);
  });

  test("blocks patch on frontend path (src/)", () => {
    const conv = {
      conversationId: "test-ds-dry-block",
      preparedPatch: {
        editPlan: [
          { file: "src/App.jsx", operation: "insert", content: "// test" },
        ],
      },
    };
    const result = deepseekDryRunChanges(conv);
    expect(result.success).toBe(false);
    const blockIssue = result.issues.find((i) => i.includes("Schreibzugriff verweigert"));
    expect(blockIssue).toBeDefined();
    expect(blockIssue).toMatch(/DeepSeek/);
    const blockLog = result.log.find((l) => l.includes("WRITE-SCOPE BLOCKED"));
    expect(blockLog).toBeDefined();
  });

  test("blocks patch on components/ path", () => {
    const conv = {
      conversationId: "test-ds-dry-components",
      preparedPatch: {
        editPlan: [
          { file: "components/Button.jsx", operation: "insert", content: "// bad" },
        ],
      },
    };
    const result = deepseekDryRunChanges(conv);
    expect(result.success).toBe(false);
    expect(result.issues.some((i) => i.includes("Schreibzugriff verweigert"))).toBe(true);
  });

  test("mixed patch: blocks frontend edit, passes backend edit", () => {
    const conv = {
      conversationId: "test-ds-dry-mixed",
      preparedPatch: {
        editPlan: [
          { file: "services/myService.js", operation: "insert", content: "// ok" },
          { file: "src/App.jsx", operation: "insert", content: "// blocked" },
        ],
      },
    };
    const result = deepseekDryRunChanges(conv);
    expect(result.success).toBe(false);
    const writeBlockIssues = result.issues.filter((i) => i.includes("Schreibzugriff verweigert"));
    expect(writeBlockIssues).toHaveLength(1);
  });
});

/* ─────────────────────────────────────────────
   9. Secret/env protection still in place
   ───────────────────────────────────────────── */

describe("Write-scope does NOT soften secret/env protection", () => {
  test("checkWriteScope on .env path is irrelevant – _isPathAllowed already blocks it", () => {
    // Even if agent is correct (deepseek), _isPathAllowed will block .env
    expect(deepseekIsPathAllowed(".env")).toBe(false);
    expect(geminiIsPathAllowed(".env")).toBe(false);
  });

  test("checkWriteScope returns allowed:false for node_modules regardless of agent", () => {
    // node_modules isn't in any write scope
    expect(checkWriteScope("deepseek", "node_modules/express/index.js").allowed).toBe(false);
    expect(checkWriteScope("gemini", "node_modules/react/index.js").allowed).toBe(false);
  });

  test("deepseek _dryRunChanges blocks .env even in backend scope", () => {
    const conv = {
      conversationId: "test-ds-env",
      preparedPatch: {
        editPlan: [{ file: ".env", operation: "replace", oldContent: "A=1", newContent: "A=2" }],
      },
    };
    const result = deepseekDryRunChanges(conv);
    expect(result.success).toBe(false);
    // Blocked by _isPathAllowed, not write-scope
    const pathRejected = result.issues.find((i) => i.includes("nicht erlaubt"));
    expect(pathRejected).toBeDefined();
  });

  test("gemini _dryRunChanges blocks credentials/ even though frontend agent", () => {
    const conv = {
      conversationId: "test-g-creds",
      preparedPatch: {
        editPlan: [{ file: "credentials/db.json", operation: "insert", content: "{}" }],
      },
    };
    const result = geminiDryRunChanges(conv);
    expect(result.success).toBe(false);
    const pathRejected = result.issues.find((i) => i.includes("nicht erlaubt"));
    expect(pathRejected).toBeDefined();
  });
});
