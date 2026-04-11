"use strict";

const fs = require("fs");
const path = require("path");

const logger = require("../utils/logger");
const { isGeminiConfigured, runGeminiChat } = require("./geminiArchitect.service");

/* ─────────────────────────────────────────────
   Constants & validation
   ───────────────────────────────────────────── */

const VALID_ACTION_INTENTS = [
  "explain",
  "analyze",
  "diagnose",
  "inspect_files",
  "propose_change",
  "prepare_patch",
  "dry_run",
  "execute_change",
  "verify_fix",
  "plan_fix",
];

const VALID_AGENT_MODES = [
  "layout_review",
  "darstellung",
  "frontend_guard",
  "priorisierung",
  "free_chat",
  "change_mode",
  "code_review",
  "architecture",
];

/* Maps legacy / architect-service mode names to the agent-service canonical name.
   Allows older clients (agentBridge, geminiArchitect) to keep using their own
   mode names without a breaking change. */
const MODE_ALIASES = {
  "presentation_review": "darstellung",
  "priority_review":     "priorisierung",
};

const VALID_CONVERSATION_STATUSES = [
  "active",
  "waiting_for_user",
  "change_proposed",
  "patch_prepared",
  "dry_run_completed",
  "executing",
  "completed",
  "error",
];

const MAX_CONVERSATIONS           = 200;
const MAX_MESSAGES_PER_CONVERSATION = 100;
const MAX_HISTORY_FOR_PROMPT      = 20;

const {
  ALLOWED_PROJECT_PATHS,
  BLOCKED_PATH_PATTERNS,
} = require("./agentRegistry.service");

/* ─────────────────────────────────────────────
   In-memory conversation store
   ───────────────────────────────────────────── */

/** @type {Map<string, object>} conversationId → conversation object */
const _geminiConversations = new Map();

/* ─────────────────────────────────────────────
   Helper – unique conversation ID
   ───────────────────────────────────────────── */

/**
 * Generates a unique conversation ID.
 * Format: gemini-conv-{timestamp}-{random4hex}
 * @returns {string}
 */
function _generateConversationId() {
  const ts = Date.now();
  const hex = Math.random().toString(16).slice(2, 6);
  return `gemini-conv-${ts}-${hex}`;
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

  // Must not contain path traversal sequences
  if (normalised.includes("..")) return false;

  // Check against blocked patterns first (reject fast)
  for (const blocked of BLOCKED_PATH_PATTERNS) {
    if (normalised.includes(blocked)) return false;
  }

  // Must start with at least one allowed prefix
  const allowed = ALLOWED_PROJECT_PATHS.some((prefix) =>
    normalised.startsWith(prefix),
  );
  return allowed;
}

/* ─────────────────────────────────────────────
   Helper – prune oldest conversations
   ───────────────────────────────────────────── */

/**
 * If the conversation map exceeds MAX_CONVERSATIONS, remove the
 * oldest entries (by createdAt) until we are back within limits.
 */
function _pruneConversations() {
  if (_geminiConversations.size <= MAX_CONVERSATIONS) return;

  const sorted = [..._geminiConversations.entries()].sort(
    (a, b) => new Date(a[1].createdAt) - new Date(b[1].createdAt),
  );

  const toRemove = sorted.length - MAX_CONVERSATIONS;
  for (let i = 0; i < toRemove; i++) {
    _geminiConversations.delete(sorted[i][0]);
  }

  logger.info("[geminiAgent] pruned conversations", {
    removed: toRemove,
    remaining: _geminiConversations.size,
  });
}

/* ─────────────────────────────────────────────
   Helper – build conversation history for Gemini
   ───────────────────────────────────────────── */

/**
 * Returns the last MAX_HISTORY_FOR_PROMPT messages as an array of
 * `{ role, content }` pairs suitable for prompt construction.
 * @param {object} conversation
 * @returns {{ role: string, content: string }[]}
 */
function _buildConversationHistory(conversation) {
  const msgs = conversation.messages || [];
  const slice = msgs.slice(-MAX_HISTORY_FOR_PROMPT);
  return slice.map((m) => ({ role: m.role, content: m.content }));
}

/* ─────────────────────────────────────────────
   System prompt builder
   ───────────────────────────────────────────── */

/**
 * Builds a mode- and intent-aware German system prompt for the agent.
 * @param {string} mode   – one of VALID_AGENT_MODES
 * @param {string|null} actionIntent – one of VALID_ACTION_INTENTS or null
 * @returns {string}
 */
function _buildAgentSystemPrompt(mode, actionIntent) {
  // ── Base identity ──
  const base = `Du bist Gemini Agent – ein kooperativer Frontend- und Architektur-Analyst für das HQS-System.
Antworte immer auf Deutsch. Nutze klare, präzise Sprache ohne Füllwörter.`;

  // ── Intent-specific instructions ──
  if (actionIntent === "explain" || actionIntent === "analyze") {
    return `${base}

Aktueller Modus: ${mode}
Aktuelle Aufgabe: ${actionIntent === "explain" ? "Erklärung" : "Analyse"}

Anweisungen:
- Liefere eine strukturierte Analyse mit klaren Befunden.
- Gliedere die Antwort in Abschnitte: Zusammenfassung, Befunde, Empfehlungen.
- Benenne Risiken und Verbesserungspotenzial konkret.
- Halte dich kurz und sachlich.`;
  }

  if (actionIntent === "diagnose") {
    return `${base}

Aktueller Modus: ${mode}
Aktuelle Aufgabe: Diagnose

Anweisungen:
- Identifiziere die Ursache des Problems (Root Cause).
- Gliedere in: Symptome, Ursachenanalyse, Diagnose, Nächste Schritte.
- Benenne betroffene Dateien, Komponenten und UI-Elemente.
- Schlage konkrete Diagnoseschritte vor.`;
  }

  if (actionIntent === "inspect_files") {
    return `${base}

Aktueller Modus: ${mode}
Aktuelle Aufgabe: Dateien inspizieren

Anweisungen:
- Analysiere die genannten Dateien auf Struktur, Abhängigkeiten und Probleme.
- Benenne relevante Codeabschnitte und ihre Funktion.
- Identifiziere Auffälligkeiten oder Verbesserungspotenzial.
- Halte die Antwort strukturiert und prägnant.`;
  }

  if (actionIntent === "verify_fix") {
    return `${base}

Aktueller Modus: ${mode}
Aktuelle Aufgabe: Fix verifizieren

Anweisungen:
- Prüfe ob die vorgeschlagene/durchgeführte Änderung das Problem löst.
- Identifiziere mögliche Nebenwirkungen oder Regressionen.
- Bewerte die Vollständigkeit der Lösung.
- Empfehle ggf. weitere Tests oder Nacharbeiten.`;
  }

  if (actionIntent === "plan_fix") {
    return `${base}

Aktueller Modus: ${mode}
Aktuelle Aufgabe: Fix planen

Anweisungen:
- Erstelle einen schrittweisen Reparaturplan.
- Gliedere in: Zielbeschreibung, Schritte, betroffene Dateien, Risikobewertung.
- Priorisiere die Schritte nach Wichtigkeit und Abhängigkeiten.
- Benenne Voraussetzungen und Abhängigkeiten klar.`;
  }

  if (actionIntent === "propose_change") {
    return `${base}

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
  "riskAssessment": "<Gesamtrisikobewertung>"
}
- Jede Änderung muss Datei, Beschreibung, Risiko und Priorität enthalten.
- Risiko realistisch einschätzen.`;
  }

  if (actionIntent === "prepare_patch") {
    return `${base}

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
      "description": "<Kurzbeschreibung der Bearbeitung>"
    }
  ],
  "summary": "<Zusammenfassung des Patches>",
  "warnings": ["<Hinweis 1>", "<Hinweis 2>"]
}
- Gib zu jeder Datei den genauen Bearbeitungsplan an.
- Operation muss "replace", "insert" oder "delete" sein.`;
  }

  if (actionIntent === "execute_change") {
    return `${base}

Aktueller Modus: ${mode}
Aktuelle Aufgabe: Änderung ausführen (Bestätigung)

Anweisungen:
- Bestätige die Ausführungsbereitschaft.
- Liste alle betroffenen Dateien und Operationen auf.
- Weise auf Risiken und Nebenwirkungen hin.
- Halte die Antwort kurz und strukturiert.`;
  }

  // ── free_chat / generic fallback ──
  return `${base}

Aktueller Modus: ${mode}

Anweisungen:
- Sei ein hilfreicher, sachlicher Gesprächspartner.
- Beantworte Fragen zum HQS-Frontend, zur Architektur und zum Code.
- Halte Antworten kompakt und verständlich.
- Wenn du dir unsicher bist, weise darauf hin.`;
}

/* ─────────────────────────────────────────────
   Core – call Gemini with conversation history
   ───────────────────────────────────────────── */

/**
 * Builds a structured multi-turn history array in Gemini `contents` format
 * from the conversation's message list.
 *
 * @param {object} conversation
 * @returns {Array<{role:string,parts:Array<{text:string}>}>}
 */
function _buildGeminiContentsHistory(conversation) {
  const msgs = conversation.messages || [];
  const slice = msgs.slice(-MAX_HISTORY_FOR_PROMPT);
  const GEMINI_ROLE = { user: "user", assistant: "model", system: "user" };
  return slice.map((m) => ({
    role: GEMINI_ROLE[m.role] || "user",
    parts: [{ text: m.content }],
  }));
}

/**
 * Sends the conversation history + new user message to Gemini using
 * the native multi-turn `contents` array, then returns the parsed result.
 *
 * @param {object}      conversation  – the conversation object
 * @param {string}      userMessage   – latest user message
 * @param {string|null} actionIntent  – current action intent
 * @returns {Promise<{ success: boolean, text: string, parsed: object|null, error?: string, errorCategory?: string }>}
 */
async function _callGeminiWithHistory(conversation, userMessage, actionIntent) {
  const systemPrompt = _buildAgentSystemPrompt(conversation.mode, actionIntent);
  const history = _buildGeminiContentsHistory(conversation);

  logger.info("[geminiAgent] _callGeminiWithHistory – sending prompt", {
    conversationId: conversation.conversationId,
    mode: conversation.mode,
    actionIntent,
    historyTurns: history.length,
    userMessageLength: userMessage.length,
  });

  const maxTokens = actionIntent === "prepare_patch" ? 2048 : 1024;
  // gemini-1.5-flash – allow extra time for longer requests.
  const timeoutMs = actionIntent === "prepare_patch" ? 90000 : 60000;

  const result = await runGeminiChat({
    systemPrompt,
    userMessage,
    history,
    maxTokens,
    timeoutMs,
  });

  if (!result.success) {
    logger.warn("[geminiAgent] _callGeminiWithHistory – Gemini call failed", {
      conversationId: conversation.conversationId,
      error: result.error,
      errorCategory: result.errorCategory || "unknown",
    });
    return { success: false, text: "", parsed: null, error: result.error, errorCategory: result.errorCategory };
  }

  // Attempt JSON parse for structured intents
  let parsed = null;
  if (
    actionIntent === "propose_change" ||
    actionIntent === "prepare_patch"
  ) {
    try {
      // Try direct parse first
      parsed = JSON.parse(result.text);
    } catch {
      // Try to extract JSON from text (brace extraction)
      const braceStart = result.text.indexOf("{");
      const braceEnd = result.text.lastIndexOf("}");
      if (braceStart !== -1 && braceEnd > braceStart) {
        try {
          parsed = JSON.parse(result.text.slice(braceStart, braceEnd + 1));
        } catch {
          logger.warn("[geminiAgent] _callGeminiWithHistory – JSON parse fallback failed", {
            conversationId: conversation.conversationId,
            actionIntent,
            textPreview: result.text.slice(0, 120),
          });
        }
      }
    }
  }

  logger.info("[geminiAgent] _callGeminiWithHistory – response received", {
    conversationId: conversation.conversationId,
    textLength: result.text.length,
    hasParsed: parsed !== null,
  });

  return { success: true, text: result.text, parsed, error: undefined };
}

/* ─────────────────────────────────────────────
   Core – propose changes (parse Gemini output)
   ───────────────────────────────────────────── */

/**
 * Parses a Gemini proposal response into structured proposedChanges[].
 * @param {{ text: string, parsed: object|null }} geminiResponse
 * @returns {{ file: string, description: string, risk: string, priority: number }[]}
 */
function _proposeChanges(geminiResponse) {
  if (geminiResponse.parsed && Array.isArray(geminiResponse.parsed.proposedChanges)) {
    return geminiResponse.parsed.proposedChanges.map((c) => ({
      file:        String(c.file || ""),
      description: String(c.description || ""),
      risk:        String(c.risk || "medium"),
      priority:    Number(c.priority) || 0,
    }));
  }
  return [];
}

/* ─────────────────────────────────────────────
   Core – prepare patch (parse Gemini output)
   ───────────────────────────────────────────── */

/**
 * Parses a Gemini patch response into a structured editPlan.
 * @param {{ text: string, parsed: object|null }} geminiResponse
 * @returns {{ editPlan: object[], summary: string, warnings: string[] }|null}
 */
function _preparePatch(geminiResponse) {
  if (!geminiResponse.parsed) return null;

  const plan = geminiResponse.parsed;
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
   Core – dry run (validate without applying)
   ───────────────────────────────────────────── */

/**
 * Validates the prepared patch without writing any files.
 * @param {object} conversation
 * @returns {{ success: boolean, wouldChange: string[], issues: string[], log: string[] }}
 */
function _dryRunChanges(conversation) {
  const result = { success: true, wouldChange: [], issues: [], log: [] };

  const patch = conversation.preparedPatch;
  if (!patch || !Array.isArray(patch.editPlan) || patch.editPlan.length === 0) {
    result.success = false;
    result.issues.push("Kein gültiger editPlan vorhanden.");
    return result;
  }

  const projectRoot = process.cwd();

  for (const edit of patch.editPlan) {
    const filePath = edit.file;

    if (!_isPathAllowed(filePath)) {
      result.issues.push(`Pfad abgelehnt (nicht erlaubt): ${filePath}`);
      result.log.push(`DRY-RUN REJECTED: ${filePath}`);
      result.success = false;
      continue;
    }

    const absolutePath = path.resolve(projectRoot, filePath);
    if (!absolutePath.startsWith(projectRoot)) {
      result.issues.push(`Pfad abgelehnt (außerhalb Projektverzeichnis): ${filePath}`);
      result.log.push(`DRY-RUN REJECTED: ${filePath} (outside project)`);
      result.success = false;
      continue;
    }

    const op = edit.operation;
    if (!["replace", "insert", "delete"].includes(op)) {
      result.issues.push(`Unbekannte Operation "${op}" für ${filePath}`);
      result.log.push(`DRY-RUN ERROR: unknown operation "${op}" for ${filePath}`);
      result.success = false;
      continue;
    }

    if (op === "replace" || op === "delete") {
      if (!fs.existsSync(absolutePath)) {
        result.issues.push(`Datei existiert nicht: ${filePath}`);
        result.log.push(`DRY-RUN ERROR: file not found: ${filePath}`);
        result.success = false;
        continue;
      }

      if (edit.oldContent != null) {
        try {
          const content = fs.readFileSync(absolutePath, "utf-8");
          if (!content.includes(edit.oldContent)) {
            result.issues.push(`Alter Inhalt nicht gefunden in ${filePath}`);
            result.log.push(`DRY-RUN WARNING: old content not found in ${filePath}`);
            result.success = false;
            continue;
          }
        } catch (err) {
          result.issues.push(`Datei nicht lesbar: ${filePath} – ${String(err.message).slice(0, 80)}`);
          result.success = false;
          continue;
        }
      }

      if (edit.lineRange && Array.isArray(edit.lineRange)) {
        try {
          const content = fs.readFileSync(absolutePath, "utf-8");
          const lineCount = content.split("\n").length;
          const [s, e] = edit.lineRange;
          if (s < 1 || e < s || s > lineCount) {
            result.issues.push(`${filePath}: lineRange [${s}, ${e}] ungültig (Datei hat ${lineCount} Zeilen)`);
            result.success = false;
            continue;
          }
        } catch (err) {
          result.issues.push(`Datei nicht lesbar: ${filePath}`);
          result.success = false;
          continue;
        }
      }
    }

    result.wouldChange.push(filePath);
    result.log.push(`DRY-RUN OK: ${op} on ${filePath}`);
  }

  logger.info("[geminiAgent] _dryRunChanges – completed", {
    conversationId: conversation.conversationId,
    success: result.success,
    wouldChange: result.wouldChange,
    issueCount: result.issues.length,
  });

  return result;
}

/* ─────────────────────────────────────────────
   Core – execute changes (controlled file editor)
   ───────────────────────────────────────────── */

/**
 * Applies the prepared patch from the conversation to the file system.
 * Validates every file path before touching anything.
 *
 * @param {object} conversation – must contain a valid `preparedPatch`
 * @returns {Promise<{ success: boolean, changedFiles: string[], errors: string[], log: string[] }>}
 */
async function _executeChanges(conversation) {
  const result = { success: true, changedFiles: [], errors: [], log: [] };

  const patch = conversation.preparedPatch;
  if (!patch || !Array.isArray(patch.editPlan) || patch.editPlan.length === 0) {
    result.success = false;
    result.errors.push("Kein gültiger editPlan vorhanden.");
    return result;
  }

  const projectRoot = process.cwd();

  for (const edit of patch.editPlan) {
    const filePath = edit.file;

    // ── Path validation ──
    if (!_isPathAllowed(filePath)) {
      const msg = `Pfad abgelehnt (nicht erlaubt): ${filePath}`;
      result.errors.push(msg);
      result.log.push(msg);
      logger.warn("[geminiAgent] _executeChanges – path rejected", {
        conversationId: conversation.conversationId,
        filePath,
      });
      result.success = false;
      continue;
    }

    const absolutePath = path.resolve(projectRoot, filePath);

    // Ensure resolved path is still inside the project root
    if (!absolutePath.startsWith(projectRoot)) {
      const msg = `Pfad abgelehnt (außerhalb Projektverzeichnis): ${filePath}`;
      result.errors.push(msg);
      result.log.push(msg);
      result.success = false;
      continue;
    }

    try {
      const op = edit.operation;

      /**
       * Validates that a lineRange [start, end] is sensible for a
       * file with `lineCount` lines.  Returns an error string or null.
       */
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

      logger.info("[geminiAgent] _executeChanges – applied edit", {
        conversationId: conversation.conversationId,
        filePath,
        operation: op,
      });
    } catch (err) {
      const msg = `Fehler bei ${filePath}: ${String(err.message).slice(0, 120)}`;
      result.errors.push(msg);
      result.log.push(msg);
      result.success = false;
      logger.warn("[geminiAgent] _executeChanges – file operation error", {
        conversationId: conversation.conversationId,
        filePath,
        error: String(err.message).slice(0, 120),
      });
    }
  }

  // Append execution summary to conversation messages
  conversation.messages.push({
    role: "system",
    content: result.success
      ? `Änderungen erfolgreich angewendet: ${result.changedFiles.join(", ")}`
      : `Ausführung mit Fehlern: ${result.errors.join("; ")}`,
    timestamp: new Date().toISOString(),
    metadata: { executionResult: result },
  });

  logger.info("[geminiAgent] _executeChanges – finished", {
    conversationId: conversation.conversationId,
    success: result.success,
    changedFiles: result.changedFiles,
    errorCount: result.errors.length,
  });

  return result;
}

/* ─────────────────────────────────────────────
   Helper – build standard response object
   ───────────────────────────────────────────── */

/**
 * Assembles the public response schema from conversation state.
 * @param {object}      conversation
 * @param {string}      assistantReply
 * @param {string|null} actionIntent
 * @param {boolean}     isInitial
 * @returns {object}
 */
function _buildResponse(conversation, assistantReply, actionIntent, isInitial) {
  const response = {
    conversationId:   conversation.conversationId,
    mode:             conversation.mode,
    actionIntent:     actionIntent || null,
    status:           conversation.status,
    followUpPossible: conversation.status !== "completed" && conversation.status !== "error",
    assistantReply:   assistantReply || "",
    metadata: {
      model:         process.env.GEMINI_MODEL || "gemini-1.5-flash",
      apiVersion:    "v1",
      messageCount:  conversation.messageCount,
      historyLength: conversation.messages.length,
      isInitial,
      timestamp:     new Date().toISOString(),
    },
    proposedChanges:  conversation.proposedChanges || null,
    preparedPatch:    conversation.preparedPatch || null,
    executionResult:  conversation.executionResult || null,
    dryRunResult:     conversation.dryRunResult || null,
    requiresApproval: conversation.status === "patch_prepared" && !conversation.approved,
    approved:         conversation.approved,
    changedFiles:     conversation.executionResult?.changedFiles || [],
  };
  if (conversation.errorCode) {
    response.errorCode = conversation.errorCode;
  }
  return response;
}

/* ─────────────────────────────────────────────
   Public – start a new conversation
   ───────────────────────────────────────────── */

/**
 * Creates a new multi-turn conversation and sends the first message
 * to Gemini.
 *
 * @param {object} opts
 * @param {string} opts.mode          – one of VALID_AGENT_MODES
 * @param {string} opts.message       – initial user message
 * @param {string} [opts.actionIntent]– one of VALID_ACTION_INTENTS
 * @param {string} [opts.context]     – optional extra context
 * @returns {Promise<object>} response schema
 */
async function startConversation(opts = {}) {
  const safeOpts = opts || {};
  const { message, actionIntent, context } = safeOpts;
  // ── Normalise mode: resolve aliases before validation ──
  const rawMode = safeOpts.mode;
  const mode = MODE_ALIASES[rawMode] || rawMode;

  // ── Validate inputs ──
  if (!VALID_AGENT_MODES.includes(mode)) {
    logger.warn("[geminiAgent] startConversation – invalid mode", { mode: rawMode });
    return _buildResponse(
      { conversationId: null, mode: rawMode || "unknown", status: "error", messageCount: 0, messages: [], approved: false, errorCode: "INVALID_MODE" },
      `Ungültiger Modus: ${rawMode}. Erlaubt: ${VALID_AGENT_MODES.join(", ")}`,
      actionIntent || null,
      true,
    );
  }

  if (!message || typeof message !== "string" || !message.trim()) {
    logger.warn("[geminiAgent] startConversation – empty message");
    return _buildResponse(
      { conversationId: null, mode, status: "error", messageCount: 0, messages: [], approved: false },
      "Nachricht darf nicht leer sein.",
      actionIntent || null,
      true,
    );
  }

  if (!isGeminiConfigured()) {
    logger.warn("[geminiAgent] startConversation – Gemini not configured");
    return _buildResponse(
      { conversationId: null, mode, status: "error", messageCount: 0, messages: [], approved: false },
      "Gemini ist nicht konfiguriert (GEMINI_API_KEY fehlt).",
      actionIntent || null,
      true,
    );
  }

  const intent = actionIntent && VALID_ACTION_INTENTS.includes(actionIntent)
    ? actionIntent
    : null;

  // ── Create conversation ──
  const conversationId = _generateConversationId();
  const now = new Date().toISOString();

  const conversation = {
    conversationId,
    createdAt:       now,
    updatedAt:       now,
    status:          "active",
    mode,
    messageCount:    0,
    messages:        [],
    lastActionIntent: intent,
    proposedChanges: null,
    preparedPatch:   null,
    executionResult: null,
    dryRunResult:    null,
    approved:        false,
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

  logger.info("[geminiAgent] startConversation – created", {
    conversationId,
    mode,
    actionIntent: intent,
    isInitial: true,
  });

  // ── Call Gemini ──
  let geminiResult;
  try {
    geminiResult = await _callGeminiWithHistory(conversation, message.trim(), intent);
  } catch (err) {
    logger.warn("[geminiAgent] startConversation – unexpected error", {
      conversationId,
      error: String(err.message).slice(0, 120),
    });
    conversation.status = "error";
    _geminiConversations.set(conversationId, conversation);
    _pruneConversations();
    return _buildResponse(conversation, `Fehler: ${String(err.message).slice(0, 120)}`, intent, true);
  }

  if (!geminiResult.success) {
    conversation.status = "error";
    _geminiConversations.set(conversationId, conversation);
    _pruneConversations();
    return _buildResponse(conversation, `Gemini-Fehler: ${geminiResult.error || "Unbekannt"}`, intent, true);
  }

  // ── Process structured intents ──
  if (intent === "propose_change") {
    conversation.proposedChanges = _proposeChanges(geminiResult);
    conversation.status = conversation.proposedChanges.length > 0
      ? "change_proposed"
      : "active";
  } else if (intent === "prepare_patch") {
    conversation.preparedPatch = _preparePatch(geminiResult);
    conversation.status = conversation.preparedPatch ? "patch_prepared" : "active";
  } else {
    conversation.status = "waiting_for_user";
  }

  // Add assistant reply to history
  conversation.messages.push({
    role: "assistant",
    content: geminiResult.text,
    timestamp: new Date().toISOString(),
    actionIntent: intent,
    metadata: { hasParsed: geminiResult.parsed !== null },
  });
  conversation.messageCount++;
  conversation.updatedAt = new Date().toISOString();

  _geminiConversations.set(conversationId, conversation);
  _pruneConversations();

  logger.info("[geminiAgent] startConversation – completed", {
    conversationId,
    mode,
    actionIntent: intent,
    status: conversation.status,
    messageCount: conversation.messageCount,
  });

  return _buildResponse(conversation, geminiResult.text, intent, true);
}

/* ─────────────────────────────────────────────
   Public – continue an existing conversation
   ───────────────────────────────────────────── */

/**
 * Continues a multi-turn conversation with a follow-up message.
 *
 * @param {object}  opts
 * @param {string}  opts.conversationId    – existing conversation ID
 * @param {string}  opts.message           – user follow-up message
 * @param {string}  [opts.actionIntent]    – new action intent
 * @param {boolean} [opts.confirmExecution]– set true to trigger execution
 * @param {boolean} [opts.approved]        – explicit approval for execution
 * @returns {Promise<object>} response schema
 */
async function continueConversation(opts = {}) {
  const { conversationId, message, actionIntent, confirmExecution, approved, dryRun } = opts || {};
  const conversation = _geminiConversations.get(conversationId);

  if (!conversation) {
    logger.warn("[geminiAgent] continueConversation – conversation not found", { conversationId });
    return _buildResponse(
      { conversationId, mode: "unknown", status: "error", messageCount: 0, messages: [], approved: false },
      `Konversation nicht gefunden: ${conversationId}`,
      actionIntent || null,
      false,
    );
  }

  if (!message || typeof message !== "string" || !message.trim()) {
    logger.warn("[geminiAgent] continueConversation – empty message", { conversationId });
    return _buildResponse(conversation, "Nachricht darf nicht leer sein.", actionIntent || null, false);
  }

  if (conversation.messageCount >= MAX_MESSAGES_PER_CONVERSATION) {
    logger.warn("[geminiAgent] continueConversation – message limit reached", {
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

  if (!isGeminiConfigured()) {
    logger.warn("[geminiAgent] continueConversation – Gemini not configured");
    return _buildResponse(conversation, "Gemini ist nicht konfiguriert (GEMINI_API_KEY fehlt).", actionIntent || null, false);
  }

  const intent = actionIntent && VALID_ACTION_INTENTS.includes(actionIntent)
    ? actionIntent
    : conversation.lastActionIntent;

  // ── Handle dry run request ──
  if (intent === "dry_run" && conversation.preparedPatch) {
    conversation.messages.push({
      role: "user",
      content: message.trim(),
      timestamp: new Date().toISOString(),
      actionIntent: "dry_run",
    });
    conversation.messageCount++;

    const dryResult = _dryRunChanges(conversation);
    conversation.dryRunResult = dryResult;
    conversation.status = "dry_run_completed";
    conversation.updatedAt = new Date().toISOString();

    const summary = dryResult.success
      ? `Dry Run erfolgreich – ${dryResult.wouldChange.length} Dateien würden geändert: ${dryResult.wouldChange.join(", ")}`
      : `Dry Run mit Problemen: ${dryResult.issues.join("; ")}`;

    conversation.messages.push({
      role: "system",
      content: summary,
      timestamp: new Date().toISOString(),
      metadata: { dryRunResult: dryResult },
    });
    conversation.messageCount++;

    logger.info("[geminiAgent] continueConversation – dry run completed", {
      conversationId,
      success: dryResult.success,
      wouldChange: dryResult.wouldChange,
    });

    return _buildResponse(conversation, summary, "dry_run", false);
  }

  // ── Handle execution request ──
  if (
    (intent === "execute_change" || confirmExecution === true) &&
    conversation.preparedPatch
  ) {
    // Dry run gate: If dryRun === true, perform dry run instead of real execution
    if (dryRun === true) {
      conversation.messages.push({
        role: "user",
        content: message.trim(),
        timestamp: new Date().toISOString(),
        actionIntent: "dry_run",
        metadata: { dryRunRequested: true },
      });
      conversation.messageCount++;

      const dryResult = _dryRunChanges(conversation);
      conversation.dryRunResult = dryResult;
      conversation.status = "dry_run_completed";
      conversation.updatedAt = new Date().toISOString();

      const summary = dryResult.success
        ? `Dry Run erfolgreich – ${dryResult.wouldChange.length} Dateien würden geändert: ${dryResult.wouldChange.join(", ")}`
        : `Dry Run mit Problemen: ${dryResult.issues.join("; ")}`;

      conversation.messages.push({
        role: "system",
        content: summary,
        timestamp: new Date().toISOString(),
        metadata: { dryRunResult: dryResult },
      });
      conversation.messageCount++;

      return _buildResponse(conversation, summary, "dry_run", false);
    }

    if (approved !== true) {
      logger.info("[geminiAgent] continueConversation – approval required", { conversationId });
      return _buildResponse(
        conversation,
        "Änderung erfordert explizite Freigabe. Setze 'approved: true' um fortzufahren.",
        "execute_change",
        false,
      );
    }

    // Execute the changes
    conversation.status = "executing";
    conversation.approved = true;
    conversation.lastActionIntent = "execute_change";

    // Add user approval message
    conversation.messages.push({
      role: "user",
      content: message.trim(),
      timestamp: new Date().toISOString(),
      actionIntent: "execute_change",
      metadata: { approved: true, confirmExecution: true },
    });
    conversation.messageCount++;

    logger.info("[geminiAgent] continueConversation – executing changes", {
      conversationId,
      editPlanLength: conversation.preparedPatch.editPlan?.length || 0,
    });

    let execResult;
    try {
      execResult = await _executeChanges(conversation);
    } catch (err) {
      logger.warn("[geminiAgent] continueConversation – execution error", {
        conversationId,
        error: String(err.message).slice(0, 120),
      });
      conversation.status = "error";
      conversation.updatedAt = new Date().toISOString();
      return _buildResponse(conversation, `Ausführungsfehler: ${String(err.message).slice(0, 120)}`, "execute_change", false);
    }

    conversation.executionResult = execResult;
    conversation.status = execResult.success ? "completed" : "error";
    conversation.updatedAt = new Date().toISOString();

    const summary = execResult.success
      ? `Änderungen erfolgreich angewendet auf: ${execResult.changedFiles.join(", ")}`
      : `Ausführung mit Fehlern: ${execResult.errors.join("; ")}`;

    logger.info("[geminiAgent] continueConversation – execution finished", {
      conversationId,
      success: execResult.success,
      changedFiles: execResult.changedFiles,
    });

    return _buildResponse(conversation, summary, "execute_change", false);
  }

  // ── Regular follow-up message ──
  conversation.messages.push({
    role: "user",
    content: message.trim(),
    timestamp: new Date().toISOString(),
    actionIntent: intent,
  });
  conversation.messageCount++;
  conversation.lastActionIntent = intent;

  logger.info("[geminiAgent] continueConversation – calling Gemini", {
    conversationId,
    mode: conversation.mode,
    actionIntent: intent,
    messageCount: conversation.messageCount,
    isFollowUp: true,
  });

  let geminiResult;
  try {
    geminiResult = await _callGeminiWithHistory(conversation, message.trim(), intent);
  } catch (err) {
    logger.warn("[geminiAgent] continueConversation – unexpected error", {
      conversationId,
      error: String(err.message).slice(0, 120),
    });
    conversation.status = "error";
    conversation.updatedAt = new Date().toISOString();
    return _buildResponse(conversation, `Fehler: ${String(err.message).slice(0, 120)}`, intent, false);
  }

  if (!geminiResult.success) {
    conversation.status = "error";
    conversation.updatedAt = new Date().toISOString();
    return _buildResponse(conversation, `Gemini-Fehler: ${geminiResult.error || "Unbekannt"}`, intent, false);
  }

  // ── Process structured intents ──
  if (intent === "propose_change") {
    conversation.proposedChanges = _proposeChanges(geminiResult);
    conversation.status = conversation.proposedChanges.length > 0
      ? "change_proposed"
      : "waiting_for_user";
  } else if (intent === "prepare_patch") {
    conversation.preparedPatch = _preparePatch(geminiResult);
    conversation.status = conversation.preparedPatch ? "patch_prepared" : "waiting_for_user";
  } else {
    conversation.status = "waiting_for_user";
  }

  // Add assistant reply
  conversation.messages.push({
    role: "assistant",
    content: geminiResult.text,
    timestamp: new Date().toISOString(),
    actionIntent: intent,
    metadata: { hasParsed: geminiResult.parsed !== null },
  });
  conversation.messageCount++;
  conversation.updatedAt = new Date().toISOString();

  logger.info("[geminiAgent] continueConversation – completed", {
    conversationId,
    mode: conversation.mode,
    actionIntent: intent,
    status: conversation.status,
    messageCount: conversation.messageCount,
  });

  return _buildResponse(conversation, geminiResult.text, intent, false);
}

/* ─────────────────────────────────────────────
   Public – retrieve a conversation
   ───────────────────────────────────────────── */

/**
 * Returns a conversation by ID, including all messages and metadata.
 * @param {string} conversationId
 * @returns {object|null}
 */
function getConversation(conversationId) {
  const conversation = _geminiConversations.get(conversationId);
  if (!conversation) {
    logger.info("[geminiAgent] getConversation – not found", { conversationId });
    return null;
  }

  logger.info("[geminiAgent] getConversation – retrieved", {
    conversationId,
    mode: conversation.mode,
    status: conversation.status,
    messageCount: conversation.messageCount,
  });

  return {
    conversationId:  conversation.conversationId,
    createdAt:       conversation.createdAt,
    updatedAt:       conversation.updatedAt,
    status:          conversation.status,
    mode:            conversation.mode,
    messageCount:    conversation.messageCount,
    messages:        conversation.messages,
    lastActionIntent: conversation.lastActionIntent,
    proposedChanges: conversation.proposedChanges,
    preparedPatch:   conversation.preparedPatch,
    executionResult: conversation.executionResult,
    dryRunResult:    conversation.dryRunResult,
    approved:        conversation.approved,
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
  MODE_ALIASES,
  VALID_CONVERSATION_STATUSES,
  ALLOWED_PROJECT_PATHS,
  // Exposed for testing
  _isPathAllowed,
  _dryRunChanges,
};
