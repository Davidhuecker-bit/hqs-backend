"use strict";

const fs = require("fs");
const path = require("path");

const logger = require("../utils/logger");
const {
  isDeepSeekConfigured,
  createDeepSeekChatCompletion,
  extractDeepSeekText,
  DEEPSEEK_FAST_MODEL,
  DEEPSEEK_DEEP_MODEL,
} = require("./deepseek.service");

/* ─────────────────────────────────────────────
   Constants & validation
   ───────────────────────────────────────────── */

const VALID_ACTION_INTENTS = [
  "explain",
  "analyze",
  "diagnose",
  "propose_change",
  "prepare_patch",
  "execute_change",
  "inspect_files",
  "plan_fix",
  "verify_fix",
];

const VALID_AGENT_MODES = [
  "system_agent",
  "backend_review",
  "pipeline_diagnose",
  "architecture",
  "free_chat",
  "change_mode",
  "code_review",
  "data_flow",
];

const VALID_CONVERSATION_STATUSES = [
  "active",
  "waiting_for_user",
  "change_proposed",
  "patch_prepared",
  "executing",
  "completed",
  "error",
];

const MAX_CONVERSATIONS             = 200;
const MAX_MESSAGES_PER_CONVERSATION = 100;
const MAX_HISTORY_FOR_PROMPT        = 20;
const MAX_FILE_READ_SIZE_BYTES      = 64 * 1024; // 64 KB
const MAX_FILES_PER_INSPECT         = 10;

const ALLOWED_PROJECT_PATHS = [
  "services/",
  "routes/",
  "middleware/",
  "engines/",
  "config/",
  "utils/",
  "jobs/",
  "scripts/",
  "docs/",
  "public/",
  "src/",
  "components/",
  "pages/",
  "views/",
  "layouts/",
  "styles/",
  "lib/",
];

const BLOCKED_PATH_PATTERNS = [
  ".env",
  "node_modules",
  ".git",
  "secrets",
  "credentials",
  "package-lock",
  ".DS_Store",
];

const ALLOWED_FILE_EXTENSIONS = [
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".json",
  ".yml",
  ".yaml",
  ".md",
  ".css",
  ".scss",
  ".html",
  ".sql",
  ".sh",
  ".toml",
  ".txt",
];

/* ─────────────────────────────────────────────
   HQS System Context for Agent
   ───────────────────────────────────────────── */

const HQS_AGENT_SYSTEM_CONTEXT = `
HQS-Systemarchitektur-Kontext (Agent-Level):

- Stack: Node.js-Backend, PostgreSQL, Express, Service-/Repository-/Engine-/Mapper-/View-Schichten.
- Schlüsselpfade: routes/ → services/ → repositories/ → engines/ → mappers/ → views.
- Datenpipeline: Snapshot-Jobs → News-Jobs → Score-Jobs → Advanced-Metrics-Jobs (kaskadierend).
- Lesemodelle: ui_summaries, symbol_summary – können veraltet sein, wenn das Schreibschema geändert wurde.
- Symbolquellen: universe_symbols, entity_map, admin_reference_portfolio.
- Portfolio-Pfade: Demo-Portfolio, Referenzkorb, virtuelle Positionen.
- Admin-Modelle: admin_reference_portfolio, change_memory, tech_radar_entries.
- Typische Probleme: veraltete Lesemodelle, Mapper-/Routenfehler, Label-statt-Symbol-Array-Verwechslung,
  fehlende Folgeänderungen nach Schema-Anpassungen, kaskadierte Pipeline-Fehler.
- Agent Bridge: agentBridge.service.js – zentrale Brücke für DeepSeek/Gemini-Kooperation,
  Case-Management, Handoff, Memory, Decision Framing.
- Konferenz: Konferenz-System für DeepSeek ↔ Gemini Multi-Agent-Dialog.
- Guards: controllerGuard, mathLogicReview, changeIntelligence, reviewToHuman.
`.trim();

/* ─────────────────────────────────────────────
   In-memory conversation store
   ───────────────────────────────────────────── */

/** @type {Map<string, object>} conversationId → conversation object */
const _deepseekConversations = new Map();

/* ─────────────────────────────────────────────
   Helper – unique conversation ID
   ───────────────────────────────────────────── */

function _generateConversationId() {
  const ts = Date.now();
  const hex = Math.random().toString(16).slice(2, 6);
  return `ds-agent-${ts}-${hex}`;
}

/* ─────────────────────────────────────────────
   Helper – path safety checks
   ───────────────────────────────────────────── */

/**
 * Returns true when `filePath` is within an allowed project directory
 * and does NOT match any blocked pattern.
 * @param {string} filePath – relative file path to validate
 * @returns {boolean}
 */
function _isPathAllowed(filePath) {
  if (!filePath || typeof filePath !== "string") return false;

  const normalised = filePath.replace(/\\/g, "/").replace(/^\/+/, "");

  if (normalised.includes("..")) return false;

  for (const blocked of BLOCKED_PATH_PATTERNS) {
    if (normalised.includes(blocked)) return false;
  }

  const allowed = ALLOWED_PROJECT_PATHS.some((prefix) =>
    normalised.startsWith(prefix),
  );
  return allowed;
}

/**
 * Returns true when the file extension is in the allowed list.
 * @param {string} filePath
 * @returns {boolean}
 */
function _isExtensionAllowed(filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  const ext = path.extname(filePath).toLowerCase();
  return ALLOWED_FILE_EXTENSIONS.includes(ext);
}

/* ─────────────────────────────────────────────
   Helper – prune oldest conversations
   ───────────────────────────────────────────── */

function _pruneConversations() {
  if (_deepseekConversations.size <= MAX_CONVERSATIONS) return;

  const sorted = [..._deepseekConversations.entries()].sort(
    (a, b) => new Date(a[1].createdAt) - new Date(b[1].createdAt),
  );

  const toRemove = sorted.length - MAX_CONVERSATIONS;
  for (let i = 0; i < toRemove; i++) {
    _deepseekConversations.delete(sorted[i][0]);
  }

  logger.info("[deepseekAgent] pruned conversations", {
    removed: toRemove,
    remaining: _deepseekConversations.size,
  });
}

/* ─────────────────────────────────────────────
   System Context Builder
   ───────────────────────────────────────────── */

/**
 * Builds structured system context from conversation state and optional
 * file/project context.  Returns a clean string for injection into the
 * DeepSeek system prompt.
 *
 * @param {object} opts
 * @param {string[]} [opts.affectedFiles]   – files relevant to the current task
 * @param {string}   [opts.projectContext]   – free-form project notes
 * @param {object[]} [opts.findings]         – previous findings / analysis results
 * @param {string[]} [opts.fileContents]     – pre-read file snippets
 * @returns {string}
 */
function _buildSystemContext(opts = {}) {
  const sections = [HQS_AGENT_SYSTEM_CONTEXT];

  if (opts.projectContext) {
    sections.push(`Projekt-Kontext:\n${String(opts.projectContext).slice(0, 2000)}`);
  }

  if (Array.isArray(opts.affectedFiles) && opts.affectedFiles.length > 0) {
    const files = opts.affectedFiles.slice(0, 20).map(String);
    sections.push(`Betroffene Dateien:\n${files.map((f) => `- ${f}`).join("\n")}`);
  }

  if (Array.isArray(opts.findings) && opts.findings.length > 0) {
    const findingTexts = opts.findings.slice(0, 10).map((f, i) => {
      if (typeof f === "string") return `${i + 1}. ${f}`;
      return `${i + 1}. ${f.title || f.description || JSON.stringify(f).slice(0, 200)}`;
    });
    sections.push(`Bisherige Befunde:\n${findingTexts.join("\n")}`);
  }

  if (Array.isArray(opts.fileContents) && opts.fileContents.length > 0) {
    const snippets = opts.fileContents.slice(0, 5).map((fc) => {
      if (typeof fc === "string") return fc.slice(0, 4000);
      const file = fc.file || fc.path || "unbekannt";
      const content = String(fc.content || "").slice(0, 4000);
      return `--- ${file} ---\n${content}`;
    });
    sections.push(`Dateiinhalte:\n${snippets.join("\n\n")}`);
  }

  return sections.join("\n\n");
}

/* ─────────────────────────────────────────────
   Controlled file reader
   ───────────────────────────────────────────── */

/**
 * Reads files from the project in a controlled manner.
 * Only allowed paths and extensions are accepted.
 *
 * @param {string[]} filePaths – relative file paths to read
 * @returns {{ files: object[], errors: string[] }}
 */
function _inspectFiles(filePaths) {
  const result = { files: [], errors: [] };

  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    result.errors.push("Keine Dateien angegeben.");
    return result;
  }

  const projectRoot = process.cwd();
  const paths = filePaths.slice(0, MAX_FILES_PER_INSPECT);

  for (const filePath of paths) {
    const normalised = String(filePath).replace(/\\/g, "/").replace(/^\/+/, "");

    if (!_isPathAllowed(normalised)) {
      result.errors.push(`Pfad nicht erlaubt: ${normalised}`);
      continue;
    }

    if (!_isExtensionAllowed(normalised)) {
      result.errors.push(`Dateityp nicht erlaubt: ${normalised}`);
      continue;
    }

    const absolutePath = path.resolve(projectRoot, normalised);

    if (!absolutePath.startsWith(projectRoot)) {
      result.errors.push(`Pfad außerhalb Projektverzeichnis: ${normalised}`);
      continue;
    }

    try {
      const stat = fs.statSync(absolutePath);

      if (!stat.isFile()) {
        result.errors.push(`Kein reguläres File: ${normalised}`);
        continue;
      }

      if (stat.size > MAX_FILE_READ_SIZE_BYTES) {
        result.errors.push(`Datei zu groß (${stat.size} bytes, max ${MAX_FILE_READ_SIZE_BYTES}): ${normalised}`);
        continue;
      }

      const content = fs.readFileSync(absolutePath, "utf-8");
      result.files.push({
        file: normalised,
        size: stat.size,
        lines: content.split("\n").length,
        content,
      });
    } catch (err) {
      result.errors.push(`Fehler beim Lesen: ${normalised} – ${String(err.message).slice(0, 100)}`);
    }
  }

  logger.info("[deepseekAgent] _inspectFiles", {
    requested: filePaths.length,
    read: result.files.length,
    errors: result.errors.length,
  });

  return result;
}

/* ─────────────────────────────────────────────
   Conversation history builder
   ───────────────────────────────────────────── */

function _buildConversationHistory(conversation) {
  const msgs = conversation.messages || [];
  const slice = msgs.slice(-MAX_HISTORY_FOR_PROMPT);
  return slice.map((m) => ({ role: m.role, content: m.content }));
}

/* ─────────────────────────────────────────────
   Agent System Prompt Builder
   ───────────────────────────────────────────── */

/**
 * Builds a mode- and intent-aware German system prompt for DeepSeek Agent.
 * @param {string} mode
 * @param {string|null} actionIntent
 * @param {string} systemContext
 * @returns {string}
 */
function _buildAgentSystemPrompt(mode, actionIntent, systemContext) {
  const base = `Du bist DeepSeek Agent – ein interner System-Agent für das HQS-Backend.
Du hast vollen lesenden Zugriff auf den relevanten Projektkontext.
Antworte immer auf Deutsch. Nutze klare, präzise Sprache ohne Füllwörter.
Du arbeitest kontrolliert und protokolliert – keine autonomen Änderungen ohne explizite Freigabe.`;

  const contextBlock = systemContext
    ? `\n\nSystemkontext:\n${systemContext}`
    : "";

  if (actionIntent === "explain") {
    return `${base}${contextBlock}

Aktueller Modus: ${mode}
Aktuelle Aufgabe: Erklärung

Anweisungen:
- Liefere eine klare, strukturierte Erklärung.
- Benenne betroffene Dateien, Zusammenhänge und Abhängigkeiten.
- Halte dich kurz und sachlich.`;
  }

  if (actionIntent === "analyze") {
    return `${base}${contextBlock}

Aktueller Modus: ${mode}
Aktuelle Aufgabe: Analyse

Anweisungen:
- Liefere eine strukturierte Analyse mit klaren Befunden.
- Gliedere: Zusammenfassung, Befunde, betroffene Dateien, Empfehlungen.
- Benenne Risiken und Verbesserungspotenzial konkret.`;
  }

  if (actionIntent === "diagnose") {
    return `${base}${contextBlock}

Aktueller Modus: ${mode}
Aktuelle Aufgabe: Diagnose

Anweisungen:
- Diagnostiziere das Problem systematisch.
- Ursachenanalyse, betroffene Komponenten, Datenflussunterbrechungen.
- Strukturiere: Ursachenhypothese, betroffene Dateien, empfohlene nächste Schritte.
- Antworte mit einem JSON-Objekt: { "answer": "...", "findings": [...], "affectedFiles": [...], "suggestedNextSteps": [...] }
- JSON NICHT in Code-Fences einschließen.`;
  }

  if (actionIntent === "propose_change") {
    return `${base}${contextBlock}

Aktueller Modus: ${mode}
Aktuelle Aufgabe: Änderungsvorschlag erstellen

Anweisungen:
- Antworte ausschließlich mit einem gültigen JSON-Objekt (kein Markdown, keine Prosa).
- Verwende exakt diese Struktur:
{
  "proposedChanges": [
    { "file": "<Dateipfad>", "description": "<Beschreibung>", "risk": "low|medium|high", "priority": 1 }
  ],
  "summary": "<Kurzzusammenfassung des Vorschlags>",
  "riskAssessment": "<Gesamtrisikobewertung>",
  "affectedFiles": ["<Datei1>", "<Datei2>"]
}
- Jede Änderung muss Datei, Beschreibung, Risiko und Priorität enthalten.
- Risiko realistisch einschätzen.`;
  }

  if (actionIntent === "prepare_patch") {
    return `${base}${contextBlock}

Aktueller Modus: ${mode}
Aktuelle Aufgabe: Patch vorbereiten

Anweisungen:
- Antworte ausschließlich mit einem gültigen JSON-Objekt (kein Markdown, keine Prosa).
- Verwende exakt diese Struktur:
{
  "editPlan": [
    {
      "file": "<Dateipfad>",
      "operation": "replace|insert|delete",
      "lineRange": [startZeile, endZeile],
      "oldContent": "<Alter Inhalt (bei replace/delete)>",
      "newContent": "<Neuer Inhalt (bei replace/insert)>",
      "description": "<Kurzbeschreibung>"
    }
  ],
  "summary": "<Zusammenfassung des Patches>",
  "warnings": ["<Hinweis 1>"]
}
- Gib zu jeder Datei den genauen Bearbeitungsplan an.
- Operation muss "replace", "insert" oder "delete" sein.`;
  }

  if (actionIntent === "execute_change") {
    return `${base}${contextBlock}

Aktueller Modus: ${mode}
Aktuelle Aufgabe: Änderung ausführen (Bestätigung)

Anweisungen:
- Bestätige die Ausführungsbereitschaft.
- Liste alle betroffenen Dateien und Operationen auf.
- Weise auf Risiken und Nebenwirkungen hin.
- Halte die Antwort kurz und strukturiert.`;
  }

  if (actionIntent === "inspect_files") {
    return `${base}${contextBlock}

Aktueller Modus: ${mode}
Aktuelle Aufgabe: Dateien inspizieren

Anweisungen:
- Analysiere die bereitgestellten Dateiinhalte.
- Identifiziere relevante Muster, Probleme, Abhängigkeiten.
- Benenne betroffene Bereiche und Zusammenhänge.
- Schlage konkrete nächste Schritte vor.`;
  }

  if (actionIntent === "plan_fix") {
    return `${base}${contextBlock}

Aktueller Modus: ${mode}
Aktuelle Aufgabe: Fix planen

Anweisungen:
- Erstelle einen konkreten Behebungsplan basierend auf der bisherigen Analyse.
- Gliedere: Problem, Ursache, Lösung, betroffene Dateien, Reihenfolge der Schritte.
- Benenne Risiken und Voraussetzungen.
- Halte den Plan ausführbar und verständlich.`;
  }

  if (actionIntent === "verify_fix") {
    return `${base}${contextBlock}

Aktueller Modus: ${mode}
Aktuelle Aufgabe: Fix verifizieren

Anweisungen:
- Prüfe ob die durchgeführten Änderungen das Problem beheben.
- Analysiere mögliche Seiteneffekte und offene Punkte.
- Bestätige oder widerlege die Wirksamkeit der Änderung.
- Empfehle ggf. weitere Schritte.`;
  }

  // free_chat / generic fallback
  return `${base}${contextBlock}

Aktueller Modus: ${mode}

Anweisungen:
- Sei ein interner System-Agent mit vollem Systemeinblick.
- Beantworte Fragen zum HQS-Backend, zu Services, Pipelines, Architektur und Code.
- Identifiziere Zusammenhänge, Probleme und Lösungen.
- Halte Antworten kompakt, präzise und ausführbar.
- Wenn du dir unsicher bist, weise darauf hin.`;
}

/* ─────────────────────────────────────────────
   JSON parse helpers
   ───────────────────────────────────────────── */

function _stripCodeFences(raw) {
  if (typeof raw !== "string") return String(raw || "");
  let text = raw.trim();
  let prev;
  do {
    prev = text;
    text = text
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .trim();
  } while (text !== prev);
  return text;
}

function _extractJsonObject(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function _tryParseJson(raw) {
  const cleaned = _stripCodeFences(raw);
  try { return JSON.parse(cleaned); } catch { /* ignore */ }

  const extracted = _extractJsonObject(cleaned) || _extractJsonObject(raw);
  if (extracted) {
    try { return JSON.parse(extracted); } catch { /* ignore */ }
  }
  return null;
}

/* ─────────────────────────────────────────────
   Core – call DeepSeek with conversation history + system context
   ───────────────────────────────────────────── */

/**
 * @param {object}      conversation
 * @param {string}      userMessage
 * @param {string|null} actionIntent
 * @param {string}      systemContext – pre-built system context string
 * @returns {Promise<{ success: boolean, text: string, parsed: object|null, error?: string }>}
 */
async function _callDeepSeekWithHistory(conversation, userMessage, actionIntent, systemContext) {
  const systemPrompt = _buildAgentSystemPrompt(conversation.mode, actionIntent, systemContext);
  const history = _buildConversationHistory(conversation);

  let combinedMessage = "";
  if (history.length > 0) {
    combinedMessage += "Bisheriger Gesprächsverlauf:\n───\n";
    const ROLE_LABELS = { user: "Nutzer", assistant: "Agent", system: "System" };
    for (const msg of history) {
      const label = ROLE_LABELS[msg.role] || "System";
      combinedMessage += `${label}: ${msg.content}\n`;
    }
    combinedMessage += "───\n\n";
  }
  combinedMessage += `Nutzer (aktuelle Nachricht): ${userMessage}`;

  const useDeepModel =
    actionIntent === "prepare_patch" ||
    actionIntent === "diagnose" ||
    actionIntent === "propose_change";

  const model = useDeepModel ? DEEPSEEK_DEEP_MODEL : DEEPSEEK_FAST_MODEL;
  const timeoutMs = useDeepModel ? 45000 : 20000;
  const temperature = useDeepModel ? 0.1 : 0.3;

  logger.info("[deepseekAgent] _callDeepSeekWithHistory – sending", {
    conversationId: conversation.conversationId,
    mode: conversation.mode,
    actionIntent,
    historyLength: history.length,
    model,
    systemContextLength: systemContext.length,
  });

  try {
    const completion = await createDeepSeekChatCompletion({
      model,
      timeoutMs,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: combinedMessage },
      ],
      temperature,
    });

    const text = extractDeepSeekText(completion);

    if (!text) {
      return { success: false, text: "", parsed: null, error: "DeepSeek returned empty response" };
    }

    // Attempt JSON parse for structured intents
    let parsed = null;
    if (
      actionIntent === "propose_change" ||
      actionIntent === "prepare_patch" ||
      actionIntent === "diagnose"
    ) {
      parsed = _tryParseJson(text);
    }

    logger.info("[deepseekAgent] _callDeepSeekWithHistory – response", {
      conversationId: conversation.conversationId,
      textLength: text.length,
      hasParsed: parsed !== null,
      model,
    });

    return { success: true, text, parsed, error: undefined };
  } catch (err) {
    logger.warn("[deepseekAgent] _callDeepSeekWithHistory – error", {
      conversationId: conversation.conversationId,
      error: String(err.message).slice(0, 200),
    });
    return { success: false, text: "", parsed: null, error: String(err.message).slice(0, 200) };
  }
}

/* ─────────────────────────────────────────────
   Core – propose changes (parse DeepSeek output)
   ───────────────────────────────────────────── */

function _proposeChanges(deepseekResponse) {
  if (deepseekResponse.parsed && Array.isArray(deepseekResponse.parsed.proposedChanges)) {
    return deepseekResponse.parsed.proposedChanges.map((c) => ({
      file:        String(c.file || ""),
      description: String(c.description || ""),
      risk:        String(c.risk || "medium"),
      priority:    Number(c.priority) || 0,
    }));
  }
  return [];
}

/* ─────────────────────────────────────────────
   Core – prepare patch (parse DeepSeek output)
   ───────────────────────────────────────────── */

function _preparePatch(deepseekResponse) {
  if (!deepseekResponse.parsed) return null;

  const plan = deepseekResponse.parsed;
  const editPlan = Array.isArray(plan.editPlan)
    ? plan.editPlan.map((e) => ({
        file:        String(e.file || ""),
        operation:   String(e.operation || "replace"),
        lineRange:   Array.isArray(e.lineRange) ? e.lineRange : null,
        oldContent:  e.oldContent != null ? String(e.oldContent) : null,
        newContent:  e.newContent != null ? String(e.newContent) : null,
        description: String(e.description || ""),
      }))
    : [];

  return {
    editPlan,
    summary:  String(plan.summary || ""),
    warnings: Array.isArray(plan.warnings) ? plan.warnings.map(String) : [],
  };
}

/* ─────────────────────────────────────────────
   Core – execute changes (controlled file editor)
   ───────────────────────────────────────────── */

/**
 * Applies the prepared patch from the conversation to the file system.
 * @param {object} conversation
 * @param {boolean} [dryRun=false] – when true, validate but do not write
 * @returns {Promise<{ success: boolean, changedFiles: string[], errors: string[], log: string[], dryRun: boolean }>}
 */
async function _executeChanges(conversation, dryRun) {
  const isDry = dryRun === true;
  const result = { success: true, changedFiles: [], errors: [], log: [], dryRun: isDry };

  const patch = conversation.preparedPatch;
  if (!patch || !Array.isArray(patch.editPlan) || patch.editPlan.length === 0) {
    result.success = false;
    result.errors.push("Kein gültiger editPlan vorhanden.");
    return result;
  }

  const projectRoot = process.cwd();

  for (const edit of patch.editPlan) {
    const filePath = edit.file;

    if (!_isPathAllowed(filePath)) {
      const msg = `Pfad abgelehnt (nicht erlaubt): ${filePath}`;
      result.errors.push(msg);
      result.log.push(msg);
      result.success = false;
      logger.warn("[deepseekAgent] _executeChanges – path rejected", {
        conversationId: conversation.conversationId,
        filePath,
      });
      continue;
    }

    if (!_isExtensionAllowed(filePath)) {
      const msg = `Dateityp abgelehnt: ${filePath}`;
      result.errors.push(msg);
      result.log.push(msg);
      result.success = false;
      continue;
    }

    const absolutePath = path.resolve(projectRoot, filePath);

    if (!absolutePath.startsWith(projectRoot)) {
      const msg = `Pfad abgelehnt (außerhalb Projektverzeichnis): ${filePath}`;
      result.errors.push(msg);
      result.log.push(msg);
      result.success = false;
      continue;
    }

    if (isDry) {
      result.log.push(`[dryRun] würde bearbeiten: ${filePath} (${edit.operation})`);
      result.changedFiles.push(filePath);
      continue;
    }

    try {
      const op = edit.operation;

      const validateLineRange = (range, lineCount) => {
        if (!Array.isArray(range) || range.length < 2) return "lineRange muss ein Array mit [start, end] sein.";
        const [s, e] = range;
        if (!Number.isFinite(s) || !Number.isFinite(e)) return "lineRange-Werte müssen Zahlen sein.";
        if (s < 1 || e < s) return `Ungültige lineRange [${s}, ${e}] – start >= 1 und end >= start erforderlich.`;
        if (s > lineCount) return `lineRange start (${s}) überschreitet Zeilenanzahl (${lineCount}).`;
        return null;
      };

      if (op === "replace") {
        let content = fs.readFileSync(absolutePath, "utf-8");

        if (edit.oldContent != null) {
          if (!content.includes(edit.oldContent)) {
            const msg = `Alter Inhalt nicht gefunden in ${filePath} – replace übersprungen.`;
            result.errors.push(msg);
            result.log.push(msg);
            result.success = false;
            continue;
          }
          content = content.replace(edit.oldContent, edit.newContent || "");
        } else if (edit.lineRange && Array.isArray(edit.lineRange)) {
          const lines = content.split("\n");
          const rangeErr = validateLineRange(edit.lineRange, lines.length);
          if (rangeErr) {
            result.errors.push(`${filePath}: ${rangeErr}`);
            result.log.push(`${filePath}: ${rangeErr}`);
            result.success = false;
            continue;
          }
          const [start, end] = edit.lineRange;
          const newLines = (edit.newContent || "").split("\n");
          lines.splice(start - 1, end - start + 1, ...newLines);
          content = lines.join("\n");
        }

        fs.writeFileSync(absolutePath, content, "utf-8");
        result.changedFiles.push(filePath);
        result.log.push(`replace: ${filePath}`);

      } else if (op === "insert") {
        let content = fs.readFileSync(absolutePath, "utf-8");
        const lines = content.split("\n");
        let insertAt = lines.length;
        if (edit.lineRange && Array.isArray(edit.lineRange)) {
          const pos = edit.lineRange[0];
          if (!Number.isFinite(pos) || pos < 1 || pos > lines.length + 1) {
            const msg = `${filePath}: Ungültige Einfügeposition ${pos} (1–${lines.length + 1} erlaubt).`;
            result.errors.push(msg);
            result.log.push(msg);
            result.success = false;
            continue;
          }
          insertAt = pos - 1;
        }
        const newLines = (edit.newContent || "").split("\n");
        lines.splice(insertAt, 0, ...newLines);
        fs.writeFileSync(absolutePath, lines.join("\n"), "utf-8");
        result.changedFiles.push(filePath);
        result.log.push(`insert: ${filePath} at line ${insertAt + 1}`);

      } else if (op === "delete") {
        let content = fs.readFileSync(absolutePath, "utf-8");

        if (edit.oldContent != null) {
          content = content.replaceAll(edit.oldContent, "");
        } else if (edit.lineRange && Array.isArray(edit.lineRange)) {
          const lines = content.split("\n");
          const rangeErr = validateLineRange(edit.lineRange, lines.length);
          if (rangeErr) {
            result.errors.push(`${filePath}: ${rangeErr}`);
            result.log.push(`${filePath}: ${rangeErr}`);
            result.success = false;
            continue;
          }
          const [start, end] = edit.lineRange;
          lines.splice(start - 1, end - start + 1);
          content = lines.join("\n");
        }

        fs.writeFileSync(absolutePath, content, "utf-8");
        result.changedFiles.push(filePath);
        result.log.push(`delete: ${filePath}`);

      } else {
        const msg = `Unbekannte Operation "${op}" für ${filePath}`;
        result.errors.push(msg);
        result.log.push(msg);
        result.success = false;
      }

      logger.info("[deepseekAgent] _executeChanges – applied edit", {
        conversationId: conversation.conversationId,
        filePath,
        operation: op,
        dryRun: isDry,
      });
    } catch (err) {
      const msg = `Fehler bei ${filePath}: ${String(err.message).slice(0, 120)}`;
      result.errors.push(msg);
      result.log.push(msg);
      result.success = false;
      logger.warn("[deepseekAgent] _executeChanges – file operation error", {
        conversationId: conversation.conversationId,
        filePath,
        error: String(err.message).slice(0, 120),
      });
    }
  }

  conversation.messages.push({
    role: "system",
    content: isDry
      ? `[dryRun] Vorschau: ${result.changedFiles.join(", ") || "keine Dateien"}`
      : result.success
        ? `Änderungen erfolgreich angewendet: ${result.changedFiles.join(", ")}`
        : `Ausführung mit Fehlern: ${result.errors.join("; ")}`,
    timestamp: new Date().toISOString(),
    metadata: { executionResult: result },
  });

  logger.info("[deepseekAgent] _executeChanges – finished", {
    conversationId: conversation.conversationId,
    success: result.success,
    dryRun: isDry,
    changedFiles: result.changedFiles,
    errorCount: result.errors.length,
  });

  return result;
}

/* ─────────────────────────────────────────────
   Audit logger
   ───────────────────────────────────────────── */

/**
 * Logs a detailed audit entry for every agent step.
 */
function _auditLog(event, details) {
  logger.info(`[deepseekAgent:audit] ${event}`, {
    ...details,
    timestamp: new Date().toISOString(),
  });
}

/* ─────────────────────────────────────────────
   Helper – build standard response object
   ───────────────────────────────────────────── */

function _buildResponse(conversation, assistantReply, actionIntent, isInitial, extra) {
  const resp = {
    conversationId:   conversation.conversationId,
    mode:             conversation.mode,
    actionIntent:     actionIntent || null,
    status:           conversation.status,
    followUpPossible: conversation.status !== "completed" && conversation.status !== "error",
    assistantReply:   assistantReply || "",
    metadata: {
      model:           DEEPSEEK_FAST_MODEL,
      apiVersion:      "agent-v1",
      messageCount:    conversation.messageCount,
      historyLength:   (conversation.messages || []).length,
      isInitial,
      timestamp:       new Date().toISOString(),
    },
    findings:         conversation.findings || [],
    affectedFiles:    conversation.affectedFiles || [],
    proposedChanges:  conversation.proposedChanges || null,
    preparedPatch:    conversation.preparedPatch || null,
    executionResult:  conversation.executionResult || null,
    requiresApproval: conversation.status === "patch_prepared" && !conversation.approved,
    approved:         conversation.approved,
    changedFiles:     conversation.executionResult?.changedFiles || [],
  };

  if (extra && typeof extra === "object") {
    Object.assign(resp, extra);
  }

  return resp;
}

/* ─────────────────────────────────────────────
   Public – start a new conversation
   ───────────────────────────────────────────── */

/**
 * Creates a new multi-turn DeepSeek Agent conversation.
 *
 * @param {object} opts
 * @param {string} opts.mode
 * @param {string} opts.message
 * @param {string} [opts.actionIntent]
 * @param {string} [opts.context]
 * @param {string[]} [opts.affectedFiles]
 * @param {object[]} [opts.findings]
 * @param {string[]} [opts.inspectFiles]
 * @returns {Promise<object>}
 */
async function startConversation(opts = {}) {
  const {
    mode, message, actionIntent, context,
    affectedFiles, findings, inspectFiles: inspectFilePaths,
  } = opts || {};

  // Validate mode
  if (!VALID_AGENT_MODES.includes(mode)) {
    logger.warn("[deepseekAgent] startConversation – invalid mode", { mode });
    return _buildResponse(
      { conversationId: null, mode: mode || "unknown", status: "error", messageCount: 0, messages: [], approved: false },
      `Ungültiger Modus: ${mode}. Erlaubt: ${VALID_AGENT_MODES.join(", ")}`,
      actionIntent || null,
      true,
    );
  }

  if (!message || typeof message !== "string" || !message.trim()) {
    logger.warn("[deepseekAgent] startConversation – empty message");
    return _buildResponse(
      { conversationId: null, mode, status: "error", messageCount: 0, messages: [], approved: false },
      "Nachricht darf nicht leer sein.",
      actionIntent || null,
      true,
    );
  }

  if (!isDeepSeekConfigured()) {
    logger.warn("[deepseekAgent] startConversation – DeepSeek not configured");
    return _buildResponse(
      { conversationId: null, mode, status: "error", messageCount: 0, messages: [], approved: false },
      "DeepSeek ist nicht konfiguriert (DEEPSEEK_API_KEY fehlt).",
      actionIntent || null,
      true,
    );
  }

  const intent = actionIntent && VALID_ACTION_INTENTS.includes(actionIntent)
    ? actionIntent
    : null;

  // Create conversation
  const conversationId = _generateConversationId();
  const now = new Date().toISOString();

  const conversation = {
    conversationId,
    createdAt:        now,
    updatedAt:        now,
    status:           "active",
    mode,
    messageCount:     0,
    messages:         [],
    lastActionIntent: intent,
    proposedChanges:  null,
    preparedPatch:    null,
    executionResult:  null,
    approved:         false,
    findings:         Array.isArray(findings) ? findings : [],
    affectedFiles:    Array.isArray(affectedFiles) ? affectedFiles.map(String) : [],
    systemContext:    {},
  };

  // Build system context
  let fileContents = [];
  if (intent === "inspect_files" && Array.isArray(inspectFilePaths)) {
    const inspectResult = _inspectFiles(inspectFilePaths);
    fileContents = inspectResult.files;
    conversation.affectedFiles = [
      ...conversation.affectedFiles,
      ...inspectResult.files.map((f) => f.file),
    ];
    if (inspectResult.errors.length > 0) {
      conversation.findings.push(...inspectResult.errors.map((e) => ({ type: "inspect_error", description: e })));
    }
  }

  const systemContext = _buildSystemContext({
    projectContext: context,
    affectedFiles: conversation.affectedFiles,
    findings: conversation.findings,
    fileContents,
  });

  conversation.systemContext = {
    projectContext: context || null,
    affectedFilesCount: conversation.affectedFiles.length,
    findingsCount: conversation.findings.length,
    fileContentsCount: fileContents.length,
    contextLength: systemContext.length,
  };

  // Add optional context as system message
  if (context && typeof context === "string" && context.trim()) {
    conversation.messages.push({
      role: "system",
      content: context.trim(),
      timestamp: now,
    });
    conversation.messageCount++;
  }

  // Add user message
  conversation.messages.push({
    role: "user",
    content: message.trim(),
    timestamp: now,
    actionIntent: intent,
  });
  conversation.messageCount++;

  _auditLog("startConversation", {
    conversationId,
    mode,
    actionIntent: intent,
    affectedFiles: conversation.affectedFiles,
    findingsCount: conversation.findings.length,
    systemContextLength: systemContext.length,
  });

  // Call DeepSeek
  let deepseekResult;
  try {
    deepseekResult = await _callDeepSeekWithHistory(conversation, message.trim(), intent, systemContext);
  } catch (err) {
    logger.warn("[deepseekAgent] startConversation – unexpected error", {
      conversationId,
      error: String(err.message).slice(0, 120),
    });
    conversation.status = "error";
    _deepseekConversations.set(conversationId, conversation);
    _pruneConversations();
    return _buildResponse(conversation, `Fehler: ${String(err.message).slice(0, 120)}`, intent, true);
  }

  if (!deepseekResult.success) {
    conversation.status = "error";
    _deepseekConversations.set(conversationId, conversation);
    _pruneConversations();
    return _buildResponse(conversation, `DeepSeek-Fehler: ${deepseekResult.error || "Unbekannt"}`, intent, true);
  }

  // Process structured intents
  if (intent === "propose_change") {
    conversation.proposedChanges = _proposeChanges(deepseekResult);
    if (deepseekResult.parsed && Array.isArray(deepseekResult.parsed.affectedFiles)) {
      conversation.affectedFiles = [
        ...new Set([...conversation.affectedFiles, ...deepseekResult.parsed.affectedFiles.map(String)]),
      ];
    }
    conversation.status = conversation.proposedChanges.length > 0
      ? "change_proposed"
      : "active";
  } else if (intent === "prepare_patch") {
    conversation.preparedPatch = _preparePatch(deepseekResult);
    conversation.status = conversation.preparedPatch ? "patch_prepared" : "active";
  } else if (intent === "diagnose" && deepseekResult.parsed) {
    if (Array.isArray(deepseekResult.parsed.findings)) {
      conversation.findings = [...conversation.findings, ...deepseekResult.parsed.findings];
    }
    if (Array.isArray(deepseekResult.parsed.affectedFiles)) {
      conversation.affectedFiles = [
        ...new Set([...conversation.affectedFiles, ...deepseekResult.parsed.affectedFiles.map(String)]),
      ];
    }
    conversation.status = "waiting_for_user";
  } else {
    conversation.status = "waiting_for_user";
  }

  // Add assistant reply
  conversation.messages.push({
    role: "assistant",
    content: deepseekResult.text,
    timestamp: new Date().toISOString(),
    actionIntent: intent,
    metadata: { hasParsed: deepseekResult.parsed !== null },
  });
  conversation.messageCount++;
  conversation.updatedAt = new Date().toISOString();

  _deepseekConversations.set(conversationId, conversation);
  _pruneConversations();

  _auditLog("startConversation:complete", {
    conversationId,
    mode,
    actionIntent: intent,
    status: conversation.status,
    messageCount: conversation.messageCount,
    affectedFiles: conversation.affectedFiles,
  });

  return _buildResponse(conversation, deepseekResult.text, intent, true);
}

/* ─────────────────────────────────────────────
   Public – continue an existing conversation
   ───────────────────────────────────────────── */

/**
 * Continues a multi-turn DeepSeek Agent conversation.
 *
 * @param {object}  opts
 * @param {string}  opts.conversationId
 * @param {string}  opts.message
 * @param {string}  [opts.actionIntent]
 * @param {boolean} [opts.confirmExecution]
 * @param {boolean} [opts.approved]
 * @param {boolean} [opts.dryRun]
 * @param {string[]} [opts.inspectFiles]
 * @param {string[]} [opts.affectedFiles]
 * @param {object[]} [opts.findings]
 * @returns {Promise<object>}
 */
async function continueConversation(opts = {}) {
  const {
    conversationId, message, actionIntent,
    confirmExecution, approved, dryRun,
    inspectFiles: inspectFilePaths,
    affectedFiles: newAffectedFiles,
    findings: newFindings,
  } = opts || {};

  const conversation = _deepseekConversations.get(conversationId);

  if (!conversation) {
    logger.warn("[deepseekAgent] continueConversation – not found", { conversationId });
    return _buildResponse(
      { conversationId, mode: "unknown", status: "error", messageCount: 0, messages: [], approved: false },
      `Konversation nicht gefunden: ${conversationId}`,
      actionIntent || null,
      false,
    );
  }

  if (!message || typeof message !== "string" || !message.trim()) {
    logger.warn("[deepseekAgent] continueConversation – empty message", { conversationId });
    return _buildResponse(conversation, "Nachricht darf nicht leer sein.", actionIntent || null, false);
  }

  if (conversation.messageCount >= MAX_MESSAGES_PER_CONVERSATION) {
    logger.warn("[deepseekAgent] continueConversation – limit reached", {
      conversationId,
      messageCount: conversation.messageCount,
    });
    conversation.status = "completed";
    return _buildResponse(
      conversation,
      `Maximale Nachrichtenanzahl (${MAX_MESSAGES_PER_CONVERSATION}) erreicht. Bitte starte eine neue Konversation.`,
      actionIntent || null,
      false,
    );
  }

  if (!isDeepSeekConfigured()) {
    logger.warn("[deepseekAgent] continueConversation – not configured");
    return _buildResponse(conversation, "DeepSeek ist nicht konfiguriert (DEEPSEEK_API_KEY fehlt).", actionIntent || null, false);
  }

  // Merge new context into conversation
  if (Array.isArray(newAffectedFiles)) {
    conversation.affectedFiles = [
      ...new Set([...conversation.affectedFiles, ...newAffectedFiles.map(String)]),
    ];
  }
  if (Array.isArray(newFindings)) {
    conversation.findings = [...conversation.findings, ...newFindings];
  }

  const intent = actionIntent && VALID_ACTION_INTENTS.includes(actionIntent)
    ? actionIntent
    : conversation.lastActionIntent;

  // Handle file inspection
  let fileContents = [];
  if (intent === "inspect_files" && Array.isArray(inspectFilePaths)) {
    const inspectResult = _inspectFiles(inspectFilePaths);
    fileContents = inspectResult.files;
    conversation.affectedFiles = [
      ...new Set([...conversation.affectedFiles, ...inspectResult.files.map((f) => f.file)]),
    ];
    if (inspectResult.errors.length > 0) {
      conversation.findings.push(...inspectResult.errors.map((e) => ({ type: "inspect_error", description: e })));
    }
  }

  // Build updated system context
  const systemContext = _buildSystemContext({
    affectedFiles: conversation.affectedFiles,
    findings: conversation.findings,
    fileContents,
  });

  // Handle execution request
  if (
    (intent === "execute_change" || confirmExecution === true) &&
    conversation.preparedPatch
  ) {
    if (approved !== true) {
      _auditLog("execute_change:approval_required", {
        conversationId,
        approved: false,
        dryRun: dryRun || false,
      });

      return _buildResponse(
        conversation,
        "Änderung erfordert explizite Freigabe. Setze 'approved: true' um fortzufahren.",
        "execute_change",
        false,
      );
    }

    // Execute
    conversation.status = "executing";
    conversation.approved = true;
    conversation.lastActionIntent = "execute_change";

    conversation.messages.push({
      role: "user",
      content: message.trim(),
      timestamp: new Date().toISOString(),
      actionIntent: "execute_change",
      metadata: { approved: true, confirmExecution: true, dryRun: dryRun || false },
    });
    conversation.messageCount++;

    _auditLog("execute_change:start", {
      conversationId,
      approved: true,
      dryRun: dryRun || false,
      editPlanLength: conversation.preparedPatch.editPlan?.length || 0,
      affectedFiles: conversation.affectedFiles,
    });

    let execResult;
    try {
      execResult = await _executeChanges(conversation, dryRun);
    } catch (err) {
      logger.warn("[deepseekAgent] continueConversation – execution error", {
        conversationId,
        error: String(err.message).slice(0, 120),
      });
      conversation.status = "error";
      conversation.updatedAt = new Date().toISOString();
      _auditLog("execute_change:error", { conversationId, error: String(err.message).slice(0, 120) });
      return _buildResponse(conversation, `Ausführungsfehler: ${String(err.message).slice(0, 120)}`, "execute_change", false);
    }

    conversation.executionResult = execResult;
    conversation.status = execResult.success ? "completed" : "error";
    conversation.updatedAt = new Date().toISOString();

    const summary = execResult.success
      ? `Änderungen ${dryRun ? "[dryRun] vorgeschaut" : "erfolgreich angewendet"} auf: ${execResult.changedFiles.join(", ")}`
      : `Ausführung mit Fehlern: ${execResult.errors.join("; ")}`;

    _auditLog("execute_change:complete", {
      conversationId,
      success: execResult.success,
      dryRun: dryRun || false,
      changedFiles: execResult.changedFiles,
      errors: execResult.errors,
    });

    return _buildResponse(conversation, summary, "execute_change", false);
  }

  // Regular follow-up
  conversation.messages.push({
    role: "user",
    content: message.trim(),
    timestamp: new Date().toISOString(),
    actionIntent: intent,
  });
  conversation.messageCount++;
  conversation.lastActionIntent = intent;

  _auditLog("continueConversation", {
    conversationId,
    mode: conversation.mode,
    actionIntent: intent,
    messageCount: conversation.messageCount,
    systemContextLength: systemContext.length,
    affectedFiles: conversation.affectedFiles,
    findingsCount: conversation.findings.length,
  });

  let deepseekResult;
  try {
    deepseekResult = await _callDeepSeekWithHistory(conversation, message.trim(), intent, systemContext);
  } catch (err) {
    logger.warn("[deepseekAgent] continueConversation – unexpected error", {
      conversationId,
      error: String(err.message).slice(0, 120),
    });
    conversation.status = "error";
    conversation.updatedAt = new Date().toISOString();
    return _buildResponse(conversation, `Fehler: ${String(err.message).slice(0, 120)}`, intent, false);
  }

  if (!deepseekResult.success) {
    conversation.status = "error";
    conversation.updatedAt = new Date().toISOString();
    return _buildResponse(conversation, `DeepSeek-Fehler: ${deepseekResult.error || "Unbekannt"}`, intent, false);
  }

  // Process structured intents
  if (intent === "propose_change") {
    conversation.proposedChanges = _proposeChanges(deepseekResult);
    if (deepseekResult.parsed && Array.isArray(deepseekResult.parsed.affectedFiles)) {
      conversation.affectedFiles = [
        ...new Set([...conversation.affectedFiles, ...deepseekResult.parsed.affectedFiles.map(String)]),
      ];
    }
    conversation.status = conversation.proposedChanges.length > 0
      ? "change_proposed"
      : "waiting_for_user";
  } else if (intent === "prepare_patch") {
    conversation.preparedPatch = _preparePatch(deepseekResult);
    conversation.status = conversation.preparedPatch ? "patch_prepared" : "waiting_for_user";
  } else if (intent === "diagnose" && deepseekResult.parsed) {
    if (Array.isArray(deepseekResult.parsed.findings)) {
      conversation.findings = [...conversation.findings, ...deepseekResult.parsed.findings];
    }
    if (Array.isArray(deepseekResult.parsed.affectedFiles)) {
      conversation.affectedFiles = [
        ...new Set([...conversation.affectedFiles, ...deepseekResult.parsed.affectedFiles.map(String)]),
      ];
    }
    conversation.status = "waiting_for_user";
  } else {
    conversation.status = "waiting_for_user";
  }

  // Add assistant reply
  conversation.messages.push({
    role: "assistant",
    content: deepseekResult.text,
    timestamp: new Date().toISOString(),
    actionIntent: intent,
    metadata: { hasParsed: deepseekResult.parsed !== null },
  });
  conversation.messageCount++;
  conversation.updatedAt = new Date().toISOString();

  _auditLog("continueConversation:complete", {
    conversationId,
    mode: conversation.mode,
    actionIntent: intent,
    status: conversation.status,
    messageCount: conversation.messageCount,
    affectedFiles: conversation.affectedFiles,
    findingsCount: conversation.findings.length,
  });

  return _buildResponse(conversation, deepseekResult.text, intent, false);
}

/* ─────────────────────────────────────────────
   Public – retrieve a conversation
   ───────────────────────────────────────────── */

function getConversation(conversationId) {
  const conversation = _deepseekConversations.get(conversationId);
  if (!conversation) {
    logger.info("[deepseekAgent] getConversation – not found", { conversationId });
    return null;
  }

  logger.info("[deepseekAgent] getConversation – retrieved", {
    conversationId,
    mode: conversation.mode,
    status: conversation.status,
    messageCount: conversation.messageCount,
  });

  return {
    conversationId:   conversation.conversationId,
    createdAt:        conversation.createdAt,
    updatedAt:        conversation.updatedAt,
    status:           conversation.status,
    mode:             conversation.mode,
    messageCount:     conversation.messageCount,
    messages:         conversation.messages,
    lastActionIntent: conversation.lastActionIntent,
    proposedChanges:  conversation.proposedChanges,
    preparedPatch:    conversation.preparedPatch,
    executionResult:  conversation.executionResult,
    approved:         conversation.approved,
    findings:         conversation.findings || [],
    affectedFiles:    conversation.affectedFiles || [],
    systemContext:    conversation.systemContext || {},
  };
}

/* ─────────────────────────────────────────────
   Exports
   ───────────────────────────────────────────── */

module.exports = {
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
  // exposed for testing
  _isPathAllowed,
  _isExtensionAllowed,
  _inspectFiles,
  _buildSystemContext,
};
