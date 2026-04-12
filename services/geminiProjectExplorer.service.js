"use strict";

/**
 * ═══════════════════════════════════════════════════════════════
 *  Agent Project Explorer – Secure Minimal Tool Set (shared: Gemini + DeepSeek)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Provides four tightly controlled server-side exploration tools
 *  shared by all internal agent paths (Gemini, DeepSeek):
 *
 *    scanProjectStructure()          – top-level overview of allowed dirs
 *    listDirectory(relPath)          – list files in one allowed directory
 *    readFile(relPath)               – read a single text file (size-capped)
 *    findFileByName(basename)        – search all allowed dirs for a named file
 *
 *  Security rules (non-negotiable):
 *    • Only paths under ALLOWED_EXPLORER_PATHS are accessible
 *    • BLOCKED_PATH_PATTERNS from agentRegistry are always enforced
 *    • Additional hard-blocks: .env*, *.key, *.pem, *.p12, *.pfx,
 *      *.cert, *.crt, secrets, credentials, node_modules, .git,
 *      build artefacts (dist/, .next/, .nuxt/)
 *    • Max file size: MAX_FILE_SIZE_BYTES (50 KB)
 *    • Only known text file extensions are readable
 *    • No path traversal sequences allowed
 *    • All tool calls are logged for diagnostics
 *
 *  This module is ONLY for internal agent paths (Gemini, DeepSeek).
 *  It must NOT be exposed as a public API endpoint.
 * ═══════════════════════════════════════════════════════════════
 */

const fs   = require("fs");
const path = require("path");

const logger = require("../utils/logger");
const { ALLOWED_PROJECT_PATHS, BLOCKED_PATH_PATTERNS } = require("./agentRegistry.service");

/* ─────────────────────────────────────────────
   Security constants
   ───────────────────────────────────────────── */

/** Maximum file size that readFile will return (bytes). */
const MAX_FILE_SIZE_BYTES = 50 * 1024; // 50 KB

/** Maximum number of entries returned by listDirectory. */
const MAX_DIR_ENTRIES = 100;

/** Maximum depth for scanProjectStructure. */
const MAX_SCAN_DEPTH = 2;

/** Maximum total entries in a full project scan. */
const MAX_SCAN_ENTRIES = 300;

/** Maximum number of files returned by findFileByName. */
const MAX_FILE_SEARCH_RESULTS = 5;

/** Maximum directory depth for findFileByName recursive walk. */
const MAX_FILE_SEARCH_DEPTH = 5;

/**
 * Extra path segments / patterns that are always blocked on top of
 * the shared BLOCKED_PATH_PATTERNS from agentRegistry.
 * These patterns are checked against the normalised relative path
 * via _isExtraBlocked() which handles the .env vs .env.example
 * distinction specially.
 */
const EXTRA_BLOCKED_PATTERNS = [
  // NOTE: ".env" is NOT in this list because raw string matching would also
  // block ".env.example".  The _isExtraBlocked() function handles .env files
  // explicitly using filename-level checks.
  ".key",
  ".pem",
  ".p12",
  ".pfx",
  ".cert",
  ".crt",
  "secrets",
  "credentials",
  "node_modules",
  ".git",
  "dist/",
  ".next/",
  ".nuxt/",
  "build/",
  "__pycache__",
  ".DS_Store",
  "package-lock",
  "yarn.lock",
];

/**
 * Allowed file extensions for readFile.
 * Only plain-text formats that are safe to transmit to the model.
 * Note: ".env.example" is allowed by base-name match in _isTextFile(),
 * while ".env" (and variants) are blocked by _isExtraBlocked().
 */
const ALLOWED_TEXT_EXTENSIONS = new Set([
  ".js", ".cjs", ".mjs",
  ".ts", ".tsx",
  ".jsx",
  ".json",
  ".md", ".markdown",
  ".txt",
  ".yaml", ".yml",
  ".html", ".htm",
  ".css", ".scss", ".sass", ".less",
  ".sh",
  ".gitignore",
  ".dockerignore",
  ".sql",
  ".graphql", ".gql",
  ".toml",
  ".ini",
  ".cfg",
]);

/**
 * Allowed base filenames (for dotfiles without a usable extension).
 * These are checked separately by _isTextFile().
 */
const ALLOWED_BASENAMES = new Set([
  ".env.example",
  ".gitignore",
  ".dockerignore",
  ".editorconfig",
  ".nvmrc",
]);

/* ─────────────────────────────────────────────
   Internal helpers
   ───────────────────────────────────────────── */

const _projectRoot = process.cwd();

/**
 * Normalise a relative path: forward slashes, strip leading slash.
 * @param {string} relPath
 * @returns {string}
 */
function _normalise(relPath) {
  if (typeof relPath !== "string") return "";
  return relPath.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

/**
 * Returns true if any segment of relPath is a .env file (but NOT .env.example).
 * Blocks: .env, .env.local, .env.production, .env.development, etc.
 * Allows: .env.example
 *
 * @param {string} lowerPath – lower-case normalised relative path
 * @returns {boolean}
 */
function _isEnvBlocked(lowerPath) {
  // Split on "/" and check each segment
  const segments = lowerPath.split("/");
  for (const seg of segments) {
    if (seg === ".env") return true;                          // exact .env
    if (seg.startsWith(".env.") && seg !== ".env.example") return true; // .env.local etc.
  }
  return false;
}

/**
 * Returns true if the path is blocked by EXTRA_BLOCKED_PATTERNS or .env logic.
 * @param {string} lowerPath – lower-case normalised relative path
 * @returns {boolean}
 */
function _isExtraBlocked(lowerPath) {
  if (_isEnvBlocked(lowerPath)) return true;
  for (const extra of EXTRA_BLOCKED_PATTERNS) {
    if (lowerPath.includes(extra.toLowerCase())) return true;
  }
  return false;
}

/**
 * Returns true if relPath passes all security checks:
 *   - not empty
 *   - no path traversal
 *   - not blocked by BLOCKED_PATH_PATTERNS or EXTRA_BLOCKED_PATTERNS
 *   - starts with at least one ALLOWED_PROJECT_PATHS prefix
 *
 * @param {string} relPath – normalised relative path
 * @returns {boolean}
 */
function _isPathSafe(relPath) {
  if (!relPath) return false;

  // Reject path traversal
  if (relPath.includes("..") || relPath.includes("~")) return false;

  const lower = relPath.toLowerCase();

  // Shared blocked patterns from agentRegistry
  for (const blocked of BLOCKED_PATH_PATTERNS) {
    if (lower.includes(blocked.toLowerCase())) return false;
  }

  // Extra hard-block patterns (including .env logic)
  if (_isExtraBlocked(lower)) return false;

  // Must start with an allowed prefix
  return ALLOWED_PROJECT_PATHS.some((prefix) => relPath.startsWith(prefix));
}

/**
 * Resolve a relative path to an absolute path and verify it stays
 * inside the project root (double-check after any symlink resolution).
 *
 * @param {string} relPath – relative path (already normalised)
 * @returns {string|null} absolute path, or null if outside project root
 */
function _safeAbsolute(relPath) {
  const abs = path.resolve(_projectRoot, relPath);
  if (!abs.startsWith(_projectRoot + path.sep) && abs !== _projectRoot) {
    return null;
  }
  return abs;
}

/**
 * Returns true if the file extension is in ALLOWED_TEXT_EXTENSIONS
 * or if the base filename itself is in ALLOWED_BASENAMES (e.g. `.env.example`).
 *
 * @param {string} filename
 * @returns {boolean}
 */
function _isTextFile(filename) {
  const ext  = path.extname(filename).toLowerCase();
  if (ALLOWED_TEXT_EXTENSIONS.has(ext)) return true;
  const base = path.basename(filename).toLowerCase();
  return ALLOWED_BASENAMES.has(base);
}

/**
 * Build a compact one-line descriptor for a directory entry.
 * @param {fs.Dirent} entry
 * @param {string}    relBase – relative path of the parent dir
 * @returns {string}
 */
function _formatEntry(entry, relBase) {
  const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
  if (entry.isDirectory()) return `${rel}/`;
  try {
    const abs = path.resolve(_projectRoot, rel);
    const stat = fs.statSync(abs);
    const kb = (stat.size / 1024).toFixed(1);
    return `${rel} (${kb} KB)`;
  } catch {
    return rel;
  }
}

/* ─────────────────────────────────────────────
   Public tool: scanProjectStructure
   ───────────────────────────────────────────── */

/**
 * Scans all allowed top-level directories up to MAX_SCAN_DEPTH levels deep.
 * Returns a compact text representation of the project structure.
 *
 * @returns {{ success: boolean, tree: string, entryCount: number, error?: string }}
 */
function scanProjectStructure() {
  logger.info("[agentExplorer] tool:scanProjectStructure – called");

  const lines = [];
  let entryCount = 0;
  let truncated = false;

  function _walk(absDir, relDir, depth) {
    if (depth > MAX_SCAN_DEPTH) return;
    if (entryCount >= MAX_SCAN_ENTRIES) { truncated = true; return; }

    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entryCount >= MAX_SCAN_ENTRIES) { truncated = true; break; }

      const entryRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const normRel  = _normalise(entryRel);

      // Skip anything that fails safety check
      if (normRel.includes("..")) continue;
      const lower = normRel.toLowerCase();
      const blocked =
        _isExtraBlocked(lower) ||
        BLOCKED_PATH_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
      if (blocked) continue;

      const indent = "  ".repeat(depth);
      if (entry.isDirectory()) {
        lines.push(`${indent}${entry.name}/`);
        entryCount++;
        _walk(path.join(absDir, entry.name), entryRel, depth + 1);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        let sizeSuffix = "";
        try {
          const st = fs.statSync(path.join(absDir, entry.name));
          sizeSuffix = ` (${(st.size / 1024).toFixed(1)} KB)`;
        } catch { /* ignore */ }
        lines.push(`${indent}${entry.name}${sizeSuffix}`);
        entryCount++;
      }
    }
  }

  for (const allowedPrefix of ALLOWED_PROJECT_PATHS) {
    const absAllowed = path.resolve(_projectRoot, allowedPrefix.replace(/\/$/, ""));
    if (!fs.existsSync(absAllowed)) continue;

    lines.push(`${allowedPrefix}`);
    _walk(absAllowed, allowedPrefix.replace(/\/$/, ""), 1);
  }

  if (truncated) {
    lines.push(`... (truncated at ${MAX_SCAN_ENTRIES} entries)`);
  }

  const tree = lines.join("\n");

  logger.info("[agentExplorer] tool:scanProjectStructure – done", {
    entryCount,
    truncated,
    lineCount: lines.length,
  });

  return { success: true, tree, entryCount };
}

/* ─────────────────────────────────────────────
   Public tool: listDirectory
   ───────────────────────────────────────────── */

/**
 * Lists files and directories in one allowed directory (one level deep).
 *
 * @param {string} relPath – relative path of the directory (e.g. "services/")
 * @returns {{ success: boolean, entries: string[], error?: string }}
 */
function listDirectory(relPath) {
  const norm = _normalise(relPath);

  logger.info("[agentExplorer] tool:listDirectory – called", { relPath: norm });

  if (!norm) {
    return { success: false, entries: [], error: "Empty path" };
  }

  // Ensure the given path (as a directory prefix) passes safety checks
  const checkPath = norm.endsWith("/") ? norm : `${norm}/`;
  // Minimal check: path traversal and extra blocked patterns
  if (checkPath.includes("..") || checkPath.includes("~")) {
    logger.warn("[agentExplorer] tool:listDirectory – path rejected (traversal)", { relPath: norm });
    return { success: false, entries: [], error: `Path rejected: ${norm}` };
  }
  if (_isExtraBlocked(checkPath.toLowerCase())) {
    logger.warn("[agentExplorer] tool:listDirectory – path rejected (blocked pattern)", { relPath: norm });
    return { success: false, entries: [], error: `Path rejected: ${norm}` };
  }
  // Must start with an allowed prefix
  const allowed = ALLOWED_PROJECT_PATHS.some((p) => norm.startsWith(p) || norm === p.replace(/\/$/, ""));
  if (!allowed) {
    logger.warn("[agentExplorer] tool:listDirectory – path not in allowed prefixes", { relPath: norm });
    return { success: false, entries: [], error: `Path not allowed: ${norm}` };
  }

  const absPath = _safeAbsolute(norm);
  if (!absPath) {
    return { success: false, entries: [], error: `Path outside project root: ${norm}` };
  }

  if (!fs.existsSync(absPath)) {
    return { success: false, entries: [], error: `Directory not found: ${norm}` };
  }

  let entries;
  try {
    const dirents = fs.readdirSync(absPath, { withFileTypes: true });
    entries = dirents
      .slice(0, MAX_DIR_ENTRIES)
      .map((e) => _formatEntry(e, norm))
      .filter(Boolean);
  } catch (err) {
    logger.warn("[agentExplorer] tool:listDirectory – read error", { relPath: norm, error: String(err.message) });
    return { success: false, entries: [], error: String(err.message).slice(0, 80) };
  }

  logger.info("[agentExplorer] tool:listDirectory – done", {
    relPath: norm,
    entryCount: entries.length,
  });

  return { success: true, entries };
}

/* ─────────────────────────────────────────────
   Public tool: readFile
   ───────────────────────────────────────────── */

/**
 * Reads the content of a single allowed text file.
 * Hard-capped at MAX_FILE_SIZE_BYTES; only text extensions are readable.
 *
 * @param {string} relPath – relative path of the file (e.g. "services/geminiAgent.service.js")
 * @returns {{ success: boolean, content: string, sizeBytes: number, truncated: boolean, error?: string }}
 */
function readFile(relPath) {
  const norm = _normalise(relPath);

  logger.info("[agentExplorer] tool:readFile – called", { relPath: norm });

  if (!norm) {
    return { success: false, content: "", sizeBytes: 0, truncated: false, error: "Empty path" };
  }

  // Safety checks
  if (!_isPathSafe(norm)) {
    logger.warn("[agentExplorer] tool:readFile – path rejected by safety check", { relPath: norm });
    return { success: false, content: "", sizeBytes: 0, truncated: false, error: `Path rejected: ${norm}` };
  }

  // Extension check
  const filename = path.basename(norm);
  if (!_isTextFile(filename)) {
    logger.warn("[agentExplorer] tool:readFile – file type not allowed", {
      relPath: norm, ext: path.extname(filename),
    });
    return {
      success: false, content: "", sizeBytes: 0, truncated: false,
      error: `File type not allowed: ${path.extname(filename) || filename}`,
    };
  }

  const absPath = _safeAbsolute(norm);
  if (!absPath) {
    return { success: false, content: "", sizeBytes: 0, truncated: false, error: `Path outside project root: ${norm}` };
  }

  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return { success: false, content: "", sizeBytes: 0, truncated: false, error: `File not found: ${norm}` };
  }

  if (!stat.isFile()) {
    return { success: false, content: "", sizeBytes: 0, truncated: false, error: `Not a file: ${norm}` };
  }

  let content;
  let truncated = false;
  const sizeBytes = stat.size;

  try {
    if (sizeBytes > MAX_FILE_SIZE_BYTES) {
      // Read only up to MAX_FILE_SIZE_BYTES
      const fd = fs.openSync(absPath, "r");
      const buf = Buffer.alloc(MAX_FILE_SIZE_BYTES);
      const bytesRead = fs.readSync(fd, buf, 0, MAX_FILE_SIZE_BYTES, 0);
      fs.closeSync(fd);
      content = buf.slice(0, bytesRead).toString("utf-8");
      truncated = true;
      logger.info("[agentExplorer] tool:readFile – file truncated", {
        relPath: norm, sizeBytes, maxBytes: MAX_FILE_SIZE_BYTES,
      });
    } else {
      content = fs.readFileSync(absPath, "utf-8");
    }
  } catch (err) {
    logger.warn("[agentExplorer] tool:readFile – read error", {
      relPath: norm, error: String(err.message).slice(0, 80),
    });
    return { success: false, content: "", sizeBytes, truncated: false, error: String(err.message).slice(0, 80) };
  }

  logger.info("[agentExplorer] tool:readFile – done", {
    relPath: norm,
    sizeBytes,
    contentLength: content.length,
    truncated,
  });

  return { success: true, content, sizeBytes, truncated };
}

/* ─────────────────────────────────────────────
   Internal helper: recursive walk for findFileByName
   ───────────────────────────────────────────── */

/**
 * Recursively walks absDir looking for files whose lowercased name matches
 * baseLower.  Appends matching relative paths to results up to maxResults.
 *
 * @param {string}   absDir     – absolute path of the directory to walk
 * @param {string}   relDir     – corresponding relative path (for result entries)
 * @param {string}   baseLower  – lower-cased target basename
 * @param {number}   depth      – current recursion depth (0-based)
 * @param {number}   maxDepth   – recursion depth cap
 * @param {string[]} results    – accumulator (mutated in-place)
 * @param {number}   maxResults – stop when results.length reaches this
 */
function _walkForFile(absDir, relDir, baseLower, depth, maxDepth, results, maxResults) {
  if (depth > maxDepth) return;
  if (results.length >= maxResults) return;

  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= maxResults) return;

    const entryRel = relDir ? `${relDir}/${entry.name}` : entry.name;
    const normRel  = _normalise(entryRel);

    if (normRel.includes("..")) continue;

    // Skip blocked paths
    const lower   = normRel.toLowerCase();
    const blocked =
      _isExtraBlocked(lower) ||
      BLOCKED_PATH_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
    if (blocked) continue;

    if (entry.isDirectory()) {
      _walkForFile(path.join(absDir, entry.name), entryRel, baseLower, depth + 1, maxDepth, results, maxResults);
    } else if (entry.name.toLowerCase() === baseLower) {
      if (_isTextFile(entry.name)) {
        results.push(normRel);
      }
    }
  }
}

/* ─────────────────────────────────────────────
   Public tool: findFileByName
   ───────────────────────────────────────────── */

/**
 * Searches all allowed project paths for a file matching the given basename.
 * Returns all matching relative paths (up to MAX_FILE_SEARCH_RESULTS) together
 * with the list of scopes that were searched.
 *
 * Security rules enforced:
 *   • basename must not contain path separators or traversal sequences
 *   • must pass EXTRA_BLOCKED_PATTERNS and BLOCKED_PATH_PATTERNS checks
 *   • must be a recognised text file (ALLOWED_TEXT_EXTENSIONS / ALLOWED_BASENAMES)
 *   • result paths are verified against the same security fence as readFile
 *
 * @param {string} basename – e.g. "DashboardIntegrated.jsx" or "admin.routes.js"
 * @returns {{
 *   success: boolean,
 *   matches: string[],
 *   searchedScopes: string[],
 *   error?: string
 * }}
 */
function findFileByName(basename) {
  logger.info("[agentExplorer] tool:findFileByName – called", { basename });

  if (!basename || typeof basename !== "string") {
    return { success: false, matches: [], searchedScopes: [], error: "Empty basename" };
  }

  const norm = _normalise(basename);

  // Only allow simple basenames (no directory components)
  if (!norm || norm.includes("/") || norm.includes("\\") || norm.includes("..") || norm.includes("~")) {
    logger.warn("[agentExplorer] tool:findFileByName – basename rejected (traversal/path)", { basename });
    return { success: false, matches: [], searchedScopes: [], error: `Invalid basename: ${basename}` };
  }

  // Blocked pattern check on the basename itself
  if (_isExtraBlocked(norm.toLowerCase())) {
    logger.warn("[agentExplorer] tool:findFileByName – basename rejected (blocked pattern)", { basename });
    return { success: false, matches: [], searchedScopes: [], error: `Blocked: ${basename}` };
  }

  // Extension check – only search for files we can actually read
  if (!_isTextFile(norm)) {
    logger.warn("[agentExplorer] tool:findFileByName – file type not searchable", {
      basename, ext: path.extname(norm),
    });
    return {
      success: false,
      matches: [],
      searchedScopes: [],
      error: `File type not searchable: ${path.extname(norm) || basename}`,
    };
  }

  const baseLower      = norm.toLowerCase();
  const matches        = [];
  const searchedScopes = [];

  for (const allowedPrefix of ALLOWED_PROJECT_PATHS) {
    const absAllowed = path.resolve(_projectRoot, allowedPrefix.replace(/\/$/, ""));
    if (!fs.existsSync(absAllowed)) continue;

    searchedScopes.push(allowedPrefix);
    _walkForFile(
      absAllowed,
      allowedPrefix.replace(/\/$/, ""),
      baseLower,
      0,
      MAX_FILE_SEARCH_DEPTH,
      matches,
      MAX_FILE_SEARCH_RESULTS,
    );

    if (matches.length >= MAX_FILE_SEARCH_RESULTS) break;
  }

  logger.info("[agentExplorer] tool:findFileByName – done", {
    basename,
    matchCount: matches.length,
    searchedScopeCount: searchedScopes.length,
    matches,
  });

  return { success: true, matches, searchedScopes };
}

/* ─────────────────────────────────────────────
   ───────────────────────────────────────────── */

/**
 * Heuristically decides whether a free-chat message requires real project
 * context (code, architecture, specific files, service details, etc.).
 *
 * Used by both geminiAgent and deepseekAgent to auto-detect context need in
 * free_chat mode without requiring the user to choose a special mode.
 *
 * Triggers context gathering when the message:
 *   • References a known directory prefix or a file with a code extension
 *   • Mentions a recognised HQS service / module name
 *   • Contains architecture / code-review signal phrases (German or English)
 *
 * Deliberately narrow to avoid loading context for general-knowledge questions.
 *
 * @param {string} message
 * @returns {boolean}
 */
function needsProjectContext(message) {
  if (!message || typeof message !== "string") return false;
  const lower = message.toLowerCase();

  // 1. Explicit file-path patterns  (services/, routes/, *.js, *.ts …)
  if (/\b(?:services|routes|tests|middleware|config|utils|jobs|scripts)\//i.test(message)) return true;
  if (/\b\w[\w.-]+\.(?:js|ts|tsx|jsx|json|yaml|yml)\b/i.test(message)) return true;

  // 2. Known HQS module / service names
  const hqsModules = [
    "geminiagent", "deepseekagent", "geminiarchitect", "agentbridge",
    "agentregistry", "agentorchestrator", "requestclassifier",
    "conversationstore", "audittrail", "agentdebate",
    "geminiprojectexplorer",
  ];
  if (hqsModules.some((m) => lower.includes(m))) return true;

  // 3. Architecture / code-review signal phrases
  const signalPhrases = [
    "architektur", "architecture",
    "projektstruktur", "dateistruktur", "code-struktur",
    "code review", "code-review",
    "wie ist.*aufgebaut", "wie.*implementiert", "wie.*strukturiert",
    "erkläre.*service", "erkläre.*route", "erkläre.*api",
    "zeige.*datei", "zeige.*code", "lies.*datei",
    "welche.*service", "welche.*route", "welche.*datei", "welche.*endpunkt",
    "wie funktioniert.*api", "wie funktioniert.*service",
    "was macht.*service", "was macht.*route",
    "backend.*struktur", "frontend.*struktur",
    // Path / endpoint / field queries
    "pfad", "endpoint", "antwortfeld", "response.?field", "field.?name",
    "welcher.*pfad", "welcher.*endpoint", "welche.*url",
    "welches.*feld", "welches.*antwortfeld",
    "api.?url", "api.?pfad", "api.?endpoint", "api.?path",
    "route", "welche.*route", "welchen.*route",
    "welchen.*endpunkt", "which.*endpoint", "which.*route", "which.*path",
    "antwort.*feld", "response.*field", "rückgabe.*feld",
  ];
  return signalPhrases.some((phrase) => {
    if (/[.*+?]/.test(phrase)) {
      try { return new RegExp(phrase).test(lower); } catch { return false; }
    }
    return lower.includes(phrase);
  });
}

/* ─────────────────────────────────────────────
   Exports
   ───────────────────────────────────────────── */

module.exports = {
  scanProjectStructure,
  listDirectory,
  readFile,
  findFileByName,
  needsProjectContext,
  // Exported for testing / documentation
  MAX_FILE_SIZE_BYTES,
  MAX_DIR_ENTRIES,
  MAX_SCAN_DEPTH,
  MAX_FILE_SEARCH_RESULTS,
  MAX_FILE_SEARCH_DEPTH,
  ALLOWED_TEXT_EXTENSIONS,
  EXTRA_BLOCKED_PATTERNS,
};
