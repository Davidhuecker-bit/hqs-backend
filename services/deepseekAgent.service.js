"use strict";

const fs = require("fs");
const path = require("path");

const logger = require("../utils/logger");
const {
  isDeepSeekConfigured,
  createDeepSeekChatCompletion,
  extractDeepSeekText,
} = require("./deepseek.service");

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
  "backend_review",
  "api_review",
  "system_diagnostics",
  "code_review",
  "change_mode",
  "free_chat",
  "architecture",
  "security_review",
  "performance",
];

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

const MAX_CONVERSATIONS             = 200;
const MAX_MESSAGES_PER_CONVERSATION = 100;
const MAX_HISTORY_FOR_PROMPT        = 20;

const {
  ALLOWED_PROJECT_PATHS,
  BLOCKED_PATH_PATTERNS,
} = require("./agentRegistry.service");

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
  return `deepseek-conv-${ts}-${hex}`;
}

/* ─────────────────────────────────────────────
   Helper – path safety checks
   ───────────────────────────────────────────── */

/**
 * Returns true when `filePath` is within an allowed project directory
 * and does NOT match any blocked pattern.
 * @param {string} filePath
 * @returns {boolean}
 */
function _isPathAllowed(filePath) {
  if (!filePath || typeof filePath !== "string") return false;

  const normalised = filePath.replace(/\\/g, "/").replace(/^\/+/, "");

  if (normalised.includes("..")) return false;

  for (const blocked of BLOCKED_PATH_PATTERNS) {
    if (normalised.includes(blocked)) return false;
  }

  return ALLOWED_PROJECT_PATHS.some((prefix) => normalised.startsWith(prefix));
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
   Helper – build conversation history
   ───────────────────────────────────────────── */

function _buildConversationHistory(conversation) {
  const msgs = conversation.messages || [];
  const slice = msgs.slice(-MAX_HISTORY_FOR_PROMPT);
  return slice.map((m) => ({ role: m.role, content: m.content }));
}

/* ─────────────────────────────────────────────
   System prompt builder
   ───────────────────────────────────────────── */

function _buildAgentSystemPrompt(mode, actionIntent) {
  const base = `Du bist DeepSeek Agent – ein kooperativer Backend- und System-Analyst für das HQS-System.
Antworte immer auf Deutsch. Nutze klare, präzise Sprache ohne Füllwörter.`;

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
- Benenne betroffene Dateien und Codezeilen wenn möglich.
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

  return `${base}

Aktueller Modus: ${mode}

Anweisungen:
- Sei ein hilfreicher, sachlicher Gesprächspartner.
- Beantworte Fragen zum HQS-Backend, zur Systemarchitektur und zum Code.
- Halte Antworten kompakt und verständlich.
- Wenn du dir unsicher bist, weise darauf hin.`;
}

/* ─────────────────────────────────────────────
   Core – call DeepSeek with conversation history
   ───────────────────────────────────────────── */

async function _callDeepSeekWithHistory(conversation, userMessage, actionIntent) {
  const systemPrompt = _buildAgentSystemPrompt(conversation.mode, actionIntent);
  const history = _buildConversationHistory(conversation);

  const messages = [{ role: "system", content: systemPrompt }];

  if (history.length > 0) {
    for (const msg of history) {
      messages.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content,
      });
    }
  }

  messages.push({ role: "user", content: userMessage });

  logger.info("[deepseekAgent] _callDeepSeekWithHistory – sending prompt", {
    conversationId: conversation.conversationId,
    mode: conversation.mode,
    actionIntent,
    historyLength: history.length,
    messageCount: messages.length,
  });

  const timeoutMs = actionIntent === "prepare_patch" ? 40000 : 25000;

  let completion;
  try {
    completion = await createDeepSeekChatCompletion({
      tier: "fast",
      timeoutMs,
      temperature: 0.4,
      messages,
    });
  } catch (err) {
    logger.warn("[deepseekAgent] _callDeepSeekWithHistory – API call failed", {
      conversationId: conversation.conversationId,
      error: String(err.message).slice(0, 120),
    });
    return { success: false, text: "", parsed: null, error: String(err.message).slice(0, 120) };
  }

  const text = extractDeepSeekText(completion);

  if (!text || !text.trim()) {
    logger.warn("[deepseekAgent] _callDeepSeekWithHistory – empty response", {
      conversationId: conversation.conversationId,
    });
    return { success: false, text: "", parsed: null, error: "DeepSeek returned empty response" };
  }

  // Attempt JSON parse for structured intents
  let parsed = null;
  if (actionIntent === "propose_change" || actionIntent === "prepare_patch") {
    try {
      parsed = JSON.parse(text);
    } catch {
      const braceStart = text.indexOf("{");
      const braceEnd = text.lastIndexOf("}");
      if (braceStart !== -1 && braceEnd > braceStart) {
        try {
          parsed = JSON.parse(text.slice(braceStart, braceEnd + 1));
        } catch {
          logger.warn("[deepseekAgent] _callDeepSeekWithHistory – JSON parse fallback failed", {
            conversationId: conversation.conversationId,
            actionIntent,
            textPreview: text.slice(0, 120),
          });
        }
      }
    }
  }

  logger.info("[deepseekAgent] _callDeepSeekWithHistory – response received", {
    conversationId: conversation.conversationId,
    textLength: text.length,
    hasParsed: parsed !== null,
  });

  return { success: true, text: text.trim(), parsed, error: undefined };
}

/* ─────────────────────────────────────────────
   Core – propose changes (parse output)
   ───────────────────────────────────────────── */

function _proposeChanges(agentResponse) {
  if (agentResponse.parsed && Array.isArray(agentResponse.parsed.proposedChanges)) {
    return agentResponse.parsed.proposedChanges.map((c) => ({
      file:        String(c.file || ""),
      description: String(c.description || ""),
      risk:        String(c.risk || "medium"),
      priority:    Number(c.priority) || 0,
    }));
  }
  return [];
}

/* ─────────────────────────────────────────────
   Core – prepare patch (parse output)
   ───────────────────────────────────────────── */

function _preparePatch(agentResponse) {
  if (!agentResponse.parsed) return null;

  const plan = agentResponse.parsed;
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
 * Returns a report of what would change and any issues found.
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

    // Check file existence for operations that read
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

  logger.info("[deepseekAgent] _dryRunChanges – completed", {
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

    if (!_isPathAllowed(filePath)) {
      const msg = `Pfad abgelehnt (nicht erlaubt): ${filePath}`;
      result.errors.push(msg);
      result.log.push(msg);
      logger.warn("[deepseekAgent] _executeChanges – path rejected", {
        conversationId: conversation.conversationId,
        filePath,
      });
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
    content: result.success
      ? `Änderungen erfolgreich angewendet: ${result.changedFiles.join(", ")}`
      : `Ausführung mit Fehlern: ${result.errors.join("; ")}`,
    timestamp: new Date().toISOString(),
    metadata: { executionResult: result },
  });

  logger.info("[deepseekAgent] _executeChanges – finished", {
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

function _buildResponse(conversation, replyText, actionIntent, isInitial, errorCategory = null) {
  return {
    conversationId:   conversation.conversationId,
    mode:             conversation.mode,
    actionIntent:     actionIntent || null,
    status:           conversation.status,
    followUpPossible: conversation.status !== "completed" && conversation.status !== "error",
    reply:            { text: replyText || "" },
    errorCategory:    errorCategory || null,
    metadata: {
      model:         process.env.DEEPSEEK_FAST_MODEL || "deepseek-chat",
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
}

/* ─────────────────────────────────────────────
   Public – start a new conversation
   ───────────────────────────────────────────── */

async function startConversation(opts = {}) {
  const { mode, message, actionIntent, context } = opts || {};

  if (!VALID_AGENT_MODES.includes(mode)) {
    logger.warn("[deepseekAgent] startConversation – invalid mode", { mode });
    return _buildResponse(
      { conversationId: null, mode: mode || "unknown", status: "error", messageCount: 0, messages: [], approved: false },
      `Ungültiger Modus: ${mode}. Erlaubt: ${VALID_AGENT_MODES.join(", ")}`,
      actionIntent || null,
      true,
      "invalid_request",
    );
  }

  if (!message || typeof message !== "string" || !message.trim()) {
    logger.warn("[deepseekAgent] startConversation – empty message");
    return _buildResponse(
      { conversationId: null, mode, status: "error", messageCount: 0, messages: [], approved: false },
      "Nachricht darf nicht leer sein.",
      actionIntent || null,
      true,
      "invalid_request",
    );
  }

  if (!isDeepSeekConfigured()) {
    logger.warn("[deepseekAgent] startConversation – DeepSeek not configured");
    return _buildResponse(
      { conversationId: null, mode, status: "error", messageCount: 0, messages: [], approved: false },
      "DeepSeek ist nicht konfiguriert (DEEPSEEK_API_KEY fehlt).",
      actionIntent || null,
      true,
      "config",
    );
  }

  const intent = actionIntent && VALID_ACTION_INTENTS.includes(actionIntent)
    ? actionIntent
    : null;

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

  if (context && typeof context === "string" && context.trim()) {
    conversation.messages.push({
      role: "system",
      content: context.trim(),
      timestamp: now,
    });
    conversation.messageCount++;
  }

  conversation.messages.push({
    role: "user",
    content: message.trim(),
    timestamp: now,
    actionIntent: intent,
  });
  conversation.messageCount++;

  logger.info("[deepseekAgent] startConversation – created", {
    conversationId,
    mode,
    actionIntent: intent,
    isInitial: true,
  });

  let agentResult;
  try {
    agentResult = await _callDeepSeekWithHistory(conversation, message.trim(), intent);
  } catch (err) {
    logger.warn("[deepseekAgent] startConversation – unexpected error", {
      conversationId,
      error: String(err.message).slice(0, 120),
    });
    conversation.status = "error";
    _deepseekConversations.set(conversationId, conversation);
    _pruneConversations();
    return _buildResponse(conversation, `Fehler: ${String(err.message).slice(0, 120)}`, intent, true, "unknown");
  }

  if (!agentResult.success) {
    conversation.status = "error";
    _deepseekConversations.set(conversationId, conversation);
    _pruneConversations();
    return _buildResponse(conversation, `DeepSeek-Fehler: ${agentResult.error || "Unbekannt"}`, intent, true, agentResult.errorCategory || "api_error");
  }

  if (intent === "propose_change") {
    conversation.proposedChanges = _proposeChanges(agentResult);
    conversation.status = conversation.proposedChanges.length > 0
      ? "change_proposed"
      : "active";
  } else if (intent === "prepare_patch") {
    conversation.preparedPatch = _preparePatch(agentResult);
    conversation.status = conversation.preparedPatch ? "patch_prepared" : "active";
  } else {
    conversation.status = "waiting_for_user";
  }

  conversation.messages.push({
    role: "assistant",
    content: agentResult.text,
    timestamp: new Date().toISOString(),
    actionIntent: intent,
    metadata: { hasParsed: agentResult.parsed !== null },
  });
  conversation.messageCount++;
  conversation.updatedAt = new Date().toISOString();

  _deepseekConversations.set(conversationId, conversation);
  _pruneConversations();

  logger.info("[deepseekAgent] startConversation – completed", {
    conversationId,
    mode,
    actionIntent: intent,
    status: conversation.status,
    messageCount: conversation.messageCount,
  });

  return _buildResponse(conversation, agentResult.text, intent, true);
}

/* ─────────────────────────────────────────────
   Public – continue an existing conversation
   ───────────────────────────────────────────── */

async function continueConversation(opts = {}) {
  const { conversationId, message, actionIntent, confirmExecution, approved, dryRun } = opts || {};
  const conversation = _deepseekConversations.get(conversationId);

  if (!conversation) {
    logger.warn("[deepseekAgent] continueConversation – conversation not found", { conversationId });
    return _buildResponse(
      { conversationId, mode: "unknown", status: "error", messageCount: 0, messages: [], approved: false },
      `Konversation nicht gefunden: ${conversationId}`,
      actionIntent || null,
      false,
      "not_found",
    );
  }

  if (!message || typeof message !== "string" || !message.trim()) {
    logger.warn("[deepseekAgent] continueConversation – empty message", { conversationId });
    return _buildResponse(conversation, "Nachricht darf nicht leer sein.", actionIntent || null, false, "invalid_request");
  }

  if (conversation.messageCount >= MAX_MESSAGES_PER_CONVERSATION) {
    logger.warn("[deepseekAgent] continueConversation – message limit reached", {
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
    logger.warn("[deepseekAgent] continueConversation – DeepSeek not configured");
    return _buildResponse(conversation, "DeepSeek ist nicht konfiguriert (DEEPSEEK_API_KEY fehlt).", actionIntent || null, false, "config");
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

    logger.info("[deepseekAgent] continueConversation – dry run completed", {
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
      logger.info("[deepseekAgent] continueConversation – approval required", { conversationId });
      return _buildResponse(
        conversation,
        "Änderung erfordert explizite Freigabe. Setze 'approved: true' um fortzufahren.",
        "execute_change",
        false,
        "approval_required",
      );
    }

    conversation.status = "executing";
    conversation.approved = true;
    conversation.lastActionIntent = "execute_change";

    conversation.messages.push({
      role: "user",
      content: message.trim(),
      timestamp: new Date().toISOString(),
      actionIntent: "execute_change",
      metadata: { approved: true, confirmExecution: true },
    });
    conversation.messageCount++;

    logger.info("[deepseekAgent] continueConversation – executing changes", {
      conversationId,
      editPlanLength: conversation.preparedPatch.editPlan?.length || 0,
    });

    let execResult;
    try {
      execResult = await _executeChanges(conversation);
    } catch (err) {
      logger.warn("[deepseekAgent] continueConversation – execution error", {
        conversationId,
        error: String(err.message).slice(0, 120),
      });
      conversation.status = "error";
      conversation.updatedAt = new Date().toISOString();
      return _buildResponse(conversation, `Ausführungsfehler: ${String(err.message).slice(0, 120)}`, "execute_change", false, "unknown");
    }

    conversation.executionResult = execResult;
    conversation.status = execResult.success ? "completed" : "error";
    conversation.updatedAt = new Date().toISOString();

    const summary = execResult.success
      ? `Änderungen erfolgreich angewendet auf: ${execResult.changedFiles.join(", ")}`
      : `Ausführung mit Fehlern: ${execResult.errors.join("; ")}`;

    logger.info("[deepseekAgent] continueConversation – execution finished", {
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

  logger.info("[deepseekAgent] continueConversation – calling DeepSeek", {
    conversationId,
    mode: conversation.mode,
    actionIntent: intent,
    messageCount: conversation.messageCount,
    isFollowUp: true,
  });

  let agentResult;
  try {
    agentResult = await _callDeepSeekWithHistory(conversation, message.trim(), intent);
  } catch (err) {
    logger.warn("[deepseekAgent] continueConversation – unexpected error", {
      conversationId,
      error: String(err.message).slice(0, 120),
    });
    conversation.status = "error";
    conversation.updatedAt = new Date().toISOString();
    return _buildResponse(conversation, `Fehler: ${String(err.message).slice(0, 120)}`, intent, false, "unknown");
  }

  if (!agentResult.success) {
    conversation.status = "error";
    conversation.updatedAt = new Date().toISOString();
    return _buildResponse(conversation, `DeepSeek-Fehler: ${agentResult.error || "Unbekannt"}`, intent, false, agentResult.errorCategory || "api_error");
  }

  if (intent === "propose_change") {
    conversation.proposedChanges = _proposeChanges(agentResult);
    conversation.status = conversation.proposedChanges.length > 0
      ? "change_proposed"
      : "waiting_for_user";
  } else if (intent === "prepare_patch") {
    conversation.preparedPatch = _preparePatch(agentResult);
    conversation.status = conversation.preparedPatch ? "patch_prepared" : "waiting_for_user";
  } else {
    conversation.status = "waiting_for_user";
  }

  conversation.messages.push({
    role: "assistant",
    content: agentResult.text,
    timestamp: new Date().toISOString(),
    actionIntent: intent,
    metadata: { hasParsed: agentResult.parsed !== null },
  });
  conversation.messageCount++;
  conversation.updatedAt = new Date().toISOString();

  logger.info("[deepseekAgent] continueConversation – completed", {
    conversationId,
    mode: conversation.mode,
    actionIntent: intent,
    status: conversation.status,
    messageCount: conversation.messageCount,
  });

  return _buildResponse(conversation, agentResult.text, intent, false);
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
  VALID_CONVERSATION_STATUSES,
  ALLOWED_PROJECT_PATHS,
  // Exposed for testing
  _isPathAllowed,
  _dryRunChanges,
};
