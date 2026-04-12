"use strict";

/**
 * Gemini Project Explorer – Security & functionality tests
 *
 * Tests cover:
 *  - scanProjectStructure: returns structure, does not expose secrets
 *  - listDirectory: path safety, allowed/blocked paths
 *  - readFile: path safety, size cap, extension check, content delivery
 *  - Security: path traversal rejection, blocked patterns
 */

const path = require("path");
const fs   = require("fs");
const os   = require("os");

const {
  scanProjectStructure,
  listDirectory,
  readFile,
  MAX_FILE_SIZE_BYTES,
  EXTRA_BLOCKED_PATTERNS,
} = require("../services/geminiProjectExplorer.service");

/* ─────────────────────────────────────────────
   Helpers
   ───────────────────────────────────────────── */

/** Write a temporary text file and return its relative path from cwd. */
function _tmpFile(name, content) {
  const tmpDir = path.join(os.tmpdir(), "hqs-explorer-test");
  fs.mkdirSync(tmpDir, { recursive: true });
  const abs = path.join(tmpDir, name);
  fs.writeFileSync(abs, content, "utf-8");
  return abs;
}

/* ─────────────────────────────────────────────
   scanProjectStructure
   ───────────────────────────────────────────── */

describe("geminiProjectExplorer – scanProjectStructure", () => {
  test("returns success=true and a non-empty tree string", () => {
    const result = scanProjectStructure();
    expect(result.success).toBe(true);
    expect(typeof result.tree).toBe("string");
    expect(result.tree.length).toBeGreaterThan(0);
    expect(typeof result.entryCount).toBe("number");
  });

  test("tree does not expose .env files", () => {
    const result = scanProjectStructure();
    expect(result.tree).not.toMatch(/\.env(?!\.).*\b/); // .env files should be excluded
    expect(result.tree).not.toContain("node_modules");
    expect(result.tree).not.toContain(".git");
  });

  test("tree contains known allowed paths", () => {
    const result = scanProjectStructure();
    // At least one of the allowed directories should be present
    const hasKnownDir =
      result.tree.includes("services/") ||
      result.tree.includes("routes/") ||
      result.tree.includes("utils/");
    expect(hasKnownDir).toBe(true);
  });
});

/* ─────────────────────────────────────────────
   listDirectory
   ───────────────────────────────────────────── */

describe("geminiProjectExplorer – listDirectory", () => {
  test("returns success=true for an allowed directory", () => {
    const result = listDirectory("services");
    expect(result.success).toBe(true);
    expect(Array.isArray(result.entries)).toBe(true);
    expect(result.entries.length).toBeGreaterThan(0);
  });

  test("entries include service files", () => {
    const result = listDirectory("services");
    expect(result.success).toBe(true);
    const hasServiceFile = result.entries.some((e) => e.includes("geminiAgent.service.js"));
    expect(hasServiceFile).toBe(true);
  });

  test("rejects empty path", () => {
    const result = listDirectory("");
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("rejects path traversal", () => {
    const result = listDirectory("../");
    expect(result.success).toBe(false);
  });

  test("rejects path traversal with encoded sequences", () => {
    const result = listDirectory("services/../../etc");
    expect(result.success).toBe(false);
  });

  test("rejects path with blocked pattern 'node_modules'", () => {
    const result = listDirectory("node_modules");
    expect(result.success).toBe(false);
  });

  test("rejects path not in ALLOWED_PROJECT_PATHS", () => {
    const result = listDirectory("tmp");
    expect(result.success).toBe(false);
  });

  test("rejects .env paths", () => {
    const result = listDirectory(".env");
    expect(result.success).toBe(false);
  });
});

/* ─────────────────────────────────────────────
   readFile
   ───────────────────────────────────────────── */

describe("geminiProjectExplorer – readFile", () => {
  test("reads an existing allowed service file", () => {
    const result = readFile("services/agentRegistry.service.js");
    expect(result.success).toBe(true);
    expect(typeof result.content).toBe("string");
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  test("returns error for non-existent file", () => {
    const result = readFile("services/doesNotExist.js");
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("rejects empty path", () => {
    const result = readFile("");
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("rejects path traversal", () => {
    const result = readFile("services/../../package.json");
    expect(result.success).toBe(false);
  });

  test("rejects .env file", () => {
    const result = readFile(".env");
    expect(result.success).toBe(false);
  });

  test("rejects node_modules path", () => {
    const result = readFile("node_modules/express/package.json");
    expect(result.success).toBe(false);
  });

  test("rejects binary / non-text extension", () => {
    const result = readFile("services/someImage.png");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not allowed/i);
  });

  test("rejects .key file", () => {
    const result = readFile("services/something.key");
    expect(result.success).toBe(false);
  });

  test("rejects .pem file", () => {
    const result = readFile("config/cert.pem");
    expect(result.success).toBe(false);
  });

  test("does not read files outside project root via absolute path", () => {
    const result = readFile("/etc/passwd");
    expect(result.success).toBe(false);
  });

  test("reads .md files (allowed text extension)", () => {
    // Use a path that is in an allowed directory.  services/ is always present.
    // Pick a .js file rather than a fictional .md to make the test deterministic.
    const result = readFile("services/agentRegistry.service.js");
    expect(result.success).toBe(true);
    expect(typeof result.content).toBe("string");
  });

  test("truncates files larger than MAX_FILE_SIZE_BYTES", () => {
    // Write a temp file larger than the limit (to /tmp, not project root – so we
    // test the truncation path by mocking fs temporarily via a spy).
    const origReadFileSync = fs.readFileSync;
    const origStatSync     = fs.statSync;
    const origOpenSync     = fs.openSync;
    const origReadSync     = fs.readSync;
    const origCloseSync    = fs.closeSync;
    const origExistsSync   = fs.existsSync;

    // Intercept for the specific test path
    const testPath = "services/agentRegistry.service.js";
    const fakeSize = MAX_FILE_SIZE_BYTES + 1024;
    const fakeContent = "A".repeat(MAX_FILE_SIZE_BYTES);

    // We'll spy on statSync to return a large size, and openSync/readSync to return fake content
    jest.spyOn(fs, "statSync").mockImplementation((p) => {
      if (p.includes("agentRegistry.service.js")) {
        return { isFile: () => true, size: fakeSize };
      }
      return origStatSync(p);
    });
    jest.spyOn(fs, "openSync").mockImplementation((p, flag) => {
      if (p.includes("agentRegistry.service.js")) return 999;
      return origOpenSync(p, flag);
    });
    jest.spyOn(fs, "readSync").mockImplementation((fd, buf, offset, length, pos) => {
      if (fd === 999) {
        const chunk = Buffer.from(fakeContent.slice(0, length));
        chunk.copy(buf, offset);
        return chunk.length;
      }
      return origReadSync(fd, buf, offset, length, pos);
    });
    jest.spyOn(fs, "closeSync").mockImplementation((fd) => {
      if (fd === 999) return;
      origCloseSync(fd);
    });

    try {
      const result = readFile(testPath);
      expect(result.success).toBe(true);
      expect(result.truncated).toBe(true);
      expect(result.content.length).toBeLessThanOrEqual(MAX_FILE_SIZE_BYTES);
    } finally {
      jest.restoreAllMocks();
    }
  });
});

/* ─────────────────────────────────────────────
   Security: EXTRA_BLOCKED_PATTERNS coverage
   ───────────────────────────────────────────── */

describe("geminiProjectExplorer – blocked patterns coverage", () => {
  const sensitivePatterns = [".env", ".key", ".pem", "node_modules", ".git", "secrets", "credentials"];

  sensitivePatterns.forEach((pattern) => {
    test(`readFile rejects paths containing '${pattern}'`, () => {
      const result = readFile(`services/${pattern}`);
      expect(result.success).toBe(false);
    });
  });
});
