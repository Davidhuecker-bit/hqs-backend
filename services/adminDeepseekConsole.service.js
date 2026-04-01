"use strict";

const {
  isDeepSeekConfigured,
  createDeepSeekChatCompletion,
  resolveModel,
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
 * @param {Object}          payload
 * @param {string}          payload.message        – admin message (required)
 * @param {string}          [payload.mode]         – chat | diagnose | change_review
 * @param {string}          [payload.context]      – optional context
 * @param {string|string[]} [payload.logs]         – optional logs
 * @param {string[]}        [payload.changedFiles] – optional changed files
 * @param {string}          [payload.notes]        – optional notes
 * @returns {Promise<Object>} { success, mode, model, result }
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
      error: "Nachricht erforderlich – bitte eine nicht-leere Admin-Nachricht angeben.",
    };
  }

  const modePrompt = MODE_PROMPTS[mode] || MODE_PROMPTS.chat;
  const systemPrompt = `${modePrompt}\n\n${HQS_SYSTEM_CONTEXT}`;
  const userPrompt = buildUserPrompt({ message, context, logs, changedFiles, notes });

  const modelName = resolveModel("fast");

  const completion = await createDeepSeekChatCompletion({
    model: modelName,
    tier: "fast",
    timeoutMs: 15000,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: mode === "chat" ? 0.3 : 0.1,
  });

  const rawContent = completion?.choices?.[0]?.message?.content || "";

  logger.info("[adminDeepseekConsole] DeepSeek response received", {
    mode,
    model: modelName,
    rawLength: String(rawContent || "").length,
  });

  const result = normaliseResponse(rawContent, mode);

  return {
    success: true,
    mode,
    model: modelName,
    result,
  };
}

/* ─────────────────────────────────────────────
   Exports
   ───────────────────────────────────────────── */
module.exports = {
  runAdminDeepseekChat,
};
