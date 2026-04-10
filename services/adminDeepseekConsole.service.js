"use strict";

const {
  isDeepSeekConfigured,
  createDeepSeekChatCompletion,
  DEEPSEEK_FAST_MODEL,
  DEEPSEEK_DEEP_MODEL,
} = require("./deepseek.service");

const logger = require("../utils/logger");

/* ─────────────────────────────────────────────
   HQS system context – shared across all modes
   ───────────────────────────────────────────── */
const HQS_SYSTEM_CONTEXT = `
HQS-Systemarchitektur-Kontext:

- Stack: Node.js-Backend, PostgreSQL, Express, Service-/Repository-/Engine-/Mapper-/View-Schichten.
- Schlüsselpfade: routes/ → services/ → repositories/ → engines/ → mappers/ → views.
- Datenpipeline: Snapshot-Jobs → News-Jobs → Score-Jobs → Advanced-Metrics-Jobs (kaskadierend).
- Lesemodelle: ui_summaries, symbol_summary – können veraltet sein, wenn das Schreibschema geändert wurde.
- Symbolquellen: universe_symbols, entity_map, admin_reference_portfolio.
- Portfolio-Pfade: Demo-Portfolio, Referenzkorb, virtuelle Positionen.
- Admin-Modelle: admin_reference_portfolio, change_memory, tech_radar_entries.
- Typische Probleme: veraltete Lesemodelle, Mapper-/Routenfehler, Label-statt-Symbol-Array-Verwechslung,
  fehlende Folgeänderungen nach Schema-Anpassungen, kaskadierte Pipeline-Fehler.
`.trim();

/* ─────────────────────────────────────────────
   Mode-specific system prompt fragments
   ───────────────────────────────────────────── */
const MODE_PROMPTS = {
  chat: `
Du bist ein interner HQS-Admin-Assistent.
Du hilfst dem Admin bei Fragen zum HQS-Backend, Frontend, Datenpipelines und Systemarchitektur.

Regeln:
- Antworte immer auf Deutsch.
- Nutze einfache, klare Sprache. Kurze Sätze bevorzugen. Alltagstaugliche Formulierungen bevorzugen.
- Wenn ein Fachbegriff nötig ist, erkläre ihn kurz.
- Keine Marketing-Sprache, keine Füllwörter, keine Disclaimers.
- Wenn Informationen fehlen, sage das direkt.
- Antworten sollen kurz, aber vollständig sein.
`.trim(),

  diagnose: `
Du bist ein interner HQS-Systemdiagnostiker.
Deine Aufgabe ist es, Fehler, Engpässe und Datenflussprobleme im HQS-System zu diagnostizieren.

Regeln:
- Antworte immer auf Deutsch.
- Nutze einfache, klare Sprache. Kurze Sätze bevorzugen. Alltagstaugliche Formulierungen bevorzugen.
- Wenn ein Fachbegriff nötig ist, erkläre ihn kurz.
- Fokus: Ursachenanalyse, Pipeline-Probleme, Datenflussunterbrechungen, veraltete Lesemodelle.
- Strukturiere deine Antwort mit: Ursachenhypothese, betroffene Komponenten, empfohlene nächste Schritte.
- Antworte mit einem JSON-Objekt mit diesen Schlüsseln:
  "answer" (Text – deine Hauptdiagnose),
  "warnings" (Array von Strings – wichtige Hinweise oder Risiken),
  "suggestedNextSteps" (Array von Strings – konkrete Maßnahmen).
- JSON NICHT in Code-Fences einschließen.
- Keine Marketing-Sprache, keine Füllwörter, keine Disclaimers.
- Wenn Informationen fehlen, benenne das klar in "warnings".
`.trim(),

  change_review: `
Du bist ein interner HQS-Änderungsanalyst.
Deine Aufgabe ist es, Code-Änderungen zu prüfen, fehlende Folgedateien zu finden, Risiken einzuschätzen und einen konkreten Behebungsplan vorzuschlagen.

Regeln:
- Antworte immer auf Deutsch.
- Nutze einfache, klare Sprache. Kurze Sätze bevorzugen. Alltagstaugliche Formulierungen bevorzugen.
- Wenn ein Fachbegriff nötig ist, erkläre ihn kurz.
- Fokus: Folgedateien, Risikoeinschätzung, fehlende Änderungen, konkreter Behebungsplan.
- Strukturiere deine Antwort mit: betroffene Dateien, Risikolevel, fehlende Folgeänderungen, Behebungsschritte.
- Antworte mit einem JSON-Objekt mit diesen Schlüsseln:
  "answer" (Text – deine Hauptanalyse),
  "warnings" (Array von Strings – Risiken und Hinweise),
  "suggestedNextSteps" (Array von Strings – konkrete Behebungsschritte / Folgeaufgaben).
- JSON NICHT in Code-Fences einschließen.
- Keine Marketing-Sprache, keine Füllwörter, keine Disclaimers.
- Wenn Informationen fehlen, benenne das klar in "warnings".
`.trim(),
};

/* ─────────────────────────────────────────────
   Conversation Store (in-memory)
   ─────────────────────────────────────────────
   Each conversation holds a rolling message history that is
   forwarded to DeepSeek on every follow-up request, providing
   genuine multi-turn context.

   Structure per entry:
   {
     conversationId : string,
     mode           : "chat" | "diagnose" | "change_review" | "math_logic_review" | "controller_guard",
     createdAt      : number (epoch ms),
     updatedAt      : number (epoch ms),
     messages       : [{ role, content, timestamp, metadata? }],
     lastMetadata   : object | null   // structured findings from last response
   }
   ───────────────────────────────────────────── */

const MAX_CONVERSATIONS = 200;
const MAX_HISTORY_MESSAGES = 20; // maximum messages included in the context window

const _deepseekConversations = new Map();

function _generateConversationId() {
  return `dsconv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function _pruneConversations() {
  if (_deepseekConversations.size < MAX_CONVERSATIONS) return;
  const sorted = [..._deepseekConversations.entries()].sort(
    (a, b) => a[1].updatedAt - b[1].updatedAt
  );
  const removeCount = Math.max(1, Math.floor(MAX_CONVERSATIONS * 0.1));
  for (let i = 0; i < removeCount; i++) {
    _deepseekConversations.delete(sorted[i][0]);
  }
}

const VALID_CONVERSATION_MODES = [
  "chat",
  "diagnose",
  "change_review",
  "math_logic_review",
  "controller_guard",
];

function _createConversation(mode) {
  _pruneConversations();
  const conversationId = _generateConversationId();
  const now = Date.now();
  _deepseekConversations.set(conversationId, {
    conversationId,
    mode: VALID_CONVERSATION_MODES.includes(mode) ? mode : "chat",
    createdAt: now,
    updatedAt: now,
    messages: [],
    lastMetadata: null,
  });
  return conversationId;
}

function _getConversation(conversationId) {
  return _deepseekConversations.get(String(conversationId || "")) || null;
}

function _addExchange(conversationId, userContent, assistantContent, metadata) {
  const conv = _deepseekConversations.get(conversationId);
  if (!conv) return;
  const now = Date.now();
  conv.messages.push({ role: "user", content: userContent, timestamp: now });
  conv.messages.push({ role: "assistant", content: assistantContent, timestamp: now, metadata: metadata || null });
  conv.updatedAt = now;
  if (metadata && typeof metadata === "object") {
    conv.lastMetadata = metadata;
  }
}

/**
 * Build the messages array for a DeepSeek API call that includes
 * the conversation history followed by the new user message.
 *
 * @param {string} conversationId
 * @param {string} systemPrompt
 * @param {string} newUserContent
 * @returns {{ messages: Array, historyLength: number }}
 */
function _buildMessagesWithHistory(conversationId, systemPrompt, newUserContent) {
  const conv = _deepseekConversations.get(conversationId);
  const historyEntries = conv ? conv.messages.slice(-MAX_HISTORY_MESSAGES) : [];
  const historyMessages = historyEntries.map(({ role, content }) => ({ role, content }));

  return {
    messages: [
      { role: "system", content: systemPrompt },
      ...historyMessages,
      { role: "user", content: newUserContent },
    ],
    historyLength: historyMessages.length,
  };
}

/* ─────────────────────────────────────────────
   Input normalisation helpers
   ───────────────────────────────────────────── */

function toStr(value) {
  if (value == null) return "";
  return String(value).trim();
}

function toStringArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).map((v) => v.trim()).filter(Boolean);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    return trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }
  return [String(value).trim()].filter(Boolean);
}

const VALID_MODES = ["chat", "diagnose", "change_review"];

/**
 * Explicit model assignment per console mode.
 * - chat / diagnose  → fast UI path  → deepseek-chat
 * - change_review    → deep analysis → deepseek-reasoner
 */
const MODE_MODELS = {
  chat: DEEPSEEK_FAST_MODEL,
  diagnose: DEEPSEEK_FAST_MODEL,
  change_review: DEEPSEEK_DEEP_MODEL,
};

function normaliseMode(mode) {
  const m = toStr(mode).toLowerCase().replace(/-/g, "_");
  return VALID_MODES.includes(m) ? m : "chat";
}

/* ─────────────────────────────────────────────
   Response parsing helpers
   ───────────────────────────────────────────── */

function stripCodeFences(raw) {
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

function extractJsonObject(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

function tryParseJson(raw) {
  const cleaned = stripCodeFences(raw);

  try {
    return JSON.parse(cleaned);
  } catch (_) {
    // ignore
  }

  const extracted = extractJsonObject(cleaned) || extractJsonObject(raw);
  if (extracted) {
    try {
      return JSON.parse(extracted);
    } catch (_) {
      // ignore
    }
  }

  return null;
}

function normaliseResponse(rawContent, mode) {
  if (!rawContent || typeof rawContent !== "string" || !rawContent.trim()) {
    return {
      answer: "Es wurde keine Antwort von DeepSeek empfangen.",
      warnings: [],
      suggestedNextSteps: [],
    };
  }

  if (mode === "chat") {
    const parsed = tryParseJson(rawContent);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        answer: toStr(parsed.answer) || toStr(parsed.response) || stripCodeFences(rawContent),
        warnings: toStringArray(parsed.warnings),
        suggestedNextSteps: toStringArray(parsed.suggestedNextSteps || parsed.nextSteps),
      };
    }

    return {
      answer: stripCodeFences(rawContent),
      warnings: [],
      suggestedNextSteps: [],
    };
  }

  const parsed = tryParseJson(rawContent);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return {
      answer:
        toStr(parsed.answer) ||
        toStr(parsed.response) ||
        toStr(parsed.diagnosis) ||
        stripCodeFences(rawContent),
      warnings: toStringArray(parsed.warnings || parsed.risks || parsed.caveats),
      suggestedNextSteps: toStringArray(
        parsed.suggestedNextSteps ||
          parsed.nextSteps ||
          parsed.recommendedActions ||
          parsed.fixSteps
      ),
    };
  }

  return {
    answer: stripCodeFences(rawContent),
    warnings: ["Die Antwort konnte nicht strukturiert verarbeitet werden – Rohtext wird angezeigt."],
    suggestedNextSteps: [],
  };
}

/* ─────────────────────────────────────────────
   User prompt builder
   ───────────────────────────────────────────── */

function buildUserPrompt({ message, context, logs, changedFiles, notes }) {
  const sections = [];

  if (message) {
    sections.push(`Admin-Nachricht:\n${message}`);
  }

  if (context) {
    sections.push(`Kontext:\n${context}`);
  }

  if (logs.length) {
    sections.push(`Protokolle:\n${logs.map((l) => `- ${l}`).join("\n")}`);
  }

  if (changedFiles.length) {
    sections.push(`Geänderte Dateien:\n${changedFiles.map((f) => `- ${f}`).join("\n")}`);
  }

  if (notes) {
    sections.push(`Hinweise:\n${notes}`);
  }

  return sections.join("\n\n");
}

/* ─────────────────────────────────────────────
   Core function
   ───────────────────────────────────────────── */

/**
 * Run an admin chat with DeepSeek.
 *
 * Supports genuine multi-turn conversation context: when a `conversationId`
 * is provided (or returned from a prior call) the full message history is
 * forwarded to DeepSeek so follow-up questions can reference earlier answers.
 *
 * @param {Object}          payload
 * @param {string}          payload.message          – admin message (required)
 * @param {string}          [payload.mode]           – chat | diagnose | change_review
 * @param {string}          [payload.conversationId] – existing conversation to continue
 * @param {string}          [payload.context]        – optional context
 * @param {string|string[]} [payload.logs]           – optional logs
 * @param {string[]}        [payload.changedFiles]   – optional changed files
 * @param {string}          [payload.notes]          – optional notes
 * @returns {Promise<Object>} { success, mode, model, conversationId, followUpPossible, result }
 */
async function runAdminDeepseekChat(payload = {}) {
  if (!isDeepSeekConfigured()) {
    throw new Error("DeepSeek is not configured – cannot run Admin Console chat");
  }

  const mode = normaliseMode(payload.mode);
  const message = toStr(payload.message);
  const context = toStr(payload.context);
  const logs = toStringArray(payload.logs);
  const changedFiles = toStringArray(payload.changedFiles);
  const notes = toStr(payload.notes);

  if (!message) {
    return {
      success: false,
      mode,
      model: null,
      conversationId: null,
      followUpPossible: false,
      error: "Nachricht erforderlich – bitte eine nicht-leere Admin-Nachricht angeben.",
    };
  }

  // ── conversation context ──────────────────────
  let conversationId = toStr(payload.conversationId);
  let isFollowUp = false;

  if (conversationId) {
    const existing = _getConversation(conversationId);
    if (existing) {
      isFollowUp = existing.messages.length > 0;
    } else {
      // Unknown ID – start fresh with the requested mode
      conversationId = _createConversation(mode);
    }
  } else {
    conversationId = _createConversation(mode);
  }

  const modePrompt = MODE_PROMPTS[mode] || MODE_PROMPTS.chat;
  const systemPrompt = `${modePrompt}\n\n${HQS_SYSTEM_CONTEXT}`;
  const userPrompt = buildUserPrompt({ message, context, logs, changedFiles, notes });

  const modelName = MODE_MODELS[mode] || MODE_MODELS.chat;
  // change_review uses the reasoner and may take longer
  const timeoutMs = mode === "change_review" ? 45000 : 15000;

  const { messages, historyLength } = _buildMessagesWithHistory(
    conversationId,
    systemPrompt,
    userPrompt
  );

  logger.info("[adminDeepseekConsole] DeepSeek request", {
    conversationId,
    mode,
    model: modelName,
    historyLength,
    isFollowUp,
  });

  const completion = await createDeepSeekChatCompletion({
    model: modelName,
    timeoutMs,
    messages,
    temperature: mode === "chat" ? 0.3 : 0.1,
  });

  const rawContent = completion?.choices?.[0]?.message?.content || "";

  logger.info("[adminDeepseekConsole] DeepSeek response received", {
    conversationId,
    mode,
    model: modelName,
    historyLength,
    isFollowUp,
    rawLength: String(rawContent || "").length,
  });

  const result = normaliseResponse(rawContent, mode);

  // ── persist exchange in conversation store ────
  _addExchange(conversationId, userPrompt, rawContent, {
    warnings: result.warnings,
    suggestedNextSteps: result.suggestedNextSteps,
  });

  return {
    success: true,
    mode,
    model: modelName,
    conversationId,
    followUpPossible: true,
    result,
  };
}

/* ─────────────────────────────────────────────
   Conversation public API
   ───────────────────────────────────────────── */

/**
 * Continue an existing DeepSeek conversation with a new follow-up message.
 * Loads the full stored history and forwards it to DeepSeek so the model
 * can reference all prior context.
 *
 * @param {string}  conversationId
 * @param {string}  newMessage
 * @param {Object}  [options]            – additional payload fields (context, logs, …)
 * @returns {Promise<Object>}
 */
async function continueDeepSeekConversation(conversationId, newMessage, options = {}) {
  if (!isDeepSeekConfigured()) {
    throw new Error("DeepSeek is not configured – cannot continue conversation");
  }

  const conv = _getConversation(conversationId);
  if (!conv) {
    return {
      success: false,
      conversationId,
      followUpPossible: false,
      error: `Konversation nicht gefunden: ${conversationId}`,
    };
  }

  return runAdminDeepseekChat({
    ...options,
    message: newMessage,
    mode: conv.mode,
    conversationId,
  });
}

/**
 * Retrieve a stored conversation with its message history.
 *
 * Returns null when the conversation does not exist.
 *
 * @param {string} conversationId
 * @returns {Object|null}
 */
function getDeepSeekConversation(conversationId) {
  const conv = _getConversation(conversationId);
  if (!conv) return null;

  return {
    conversationId: conv.conversationId,
    mode: conv.mode,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: conv.messages.length,
    lastMetadata: conv.lastMetadata,
    messages: conv.messages.map(({ role, content, timestamp, metadata }) => ({
      role,
      content,
      timestamp,
      ...(metadata ? { metadata } : {}),
    })),
  };
}

/**
 * Register an exchange from an external mode (math_logic_review / controller_guard)
 * into the conversation store so follow-ups can reference the original analysis.
 *
 * Creates a new conversation when no conversationId is supplied.
 *
 * @param {string}  mode
 * @param {string}  userContent   – the user prompt that was sent
 * @param {string}  assistantContent – the raw response received
 * @param {Object}  metadata
 * @param {string}  [conversationId] – optional existing conversation to extend
 * @returns {string} conversationId
 */
function registerExternalExchange(mode, userContent, assistantContent, metadata, conversationId) {
  let convId = toStr(conversationId);
  if (!convId || !_getConversation(convId)) {
    convId = _createConversation(mode);
  }
  _addExchange(convId, userContent, assistantContent, metadata);
  return convId;
}

/* ─────────────────────────────────────────────
   Exports
   ───────────────────────────────────────────── */
module.exports = {
  runAdminDeepseekChat,
  continueDeepSeekConversation,
  getDeepSeekConversation,
  registerExternalExchange,
};
