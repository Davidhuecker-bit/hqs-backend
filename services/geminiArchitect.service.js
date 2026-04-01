"use strict";

const { GoogleGenerativeAI } = require("@google/generative-ai");

const logger = require("../utils/logger");

/* ─────────────────────────────────────────────
   Gemini configuration helpers
   ───────────────────────────────────────────── */

function isGeminiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

let _client = null;

function getGeminiClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY – Gemini Architect is not configured");
  }
  if (!_client) {
    _client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return _client;
}

function getModelName() {
  return process.env.GEMINI_MODEL || "gemini-1.5-flash";
}

/* ─────────────────────────────────────────────
   Valid modes
   ───────────────────────────────────────────── */

const VALID_MODES = [
  "layout_review",
  "presentation_review",
  "frontend_guard",
  "priority_review",
];

const DEFAULT_MODE = "layout_review";

/* ─────────────────────────────────────────────
   HQS frontend context injected into every prompt
   ───────────────────────────────────────────── */

const HQS_FRONTEND_CONTEXT = `
HQS-System-Kontext für Frontend-Architektur-Überprüfungen:

- Das HQS-System ist ein Finanz-Dashboard mit Admin-Bereich, Portfolio-Ansicht, Discovery-Engine, Tech-Radar, Chancen-Scanner und Symbol-Summaries.
- Die Oberfläche soll für alle Nutzergruppen klar, ruhig und verständlich sein – keine Informationsüberlastung.
- Wichtige View-Bereiche: Admin-Konsole, Portfolio-Depot, Symbol-Detail, Markt-Übersicht, Chancen-Liste, Tech-Radar-Board.
- Layout-Prioritäten: Status-Indikatoren und Bewertungen sollen prominent sichtbar sein; sekundäre Metriken können zusammengeklappt oder nachrangig dargestellt werden.
- Darstellungsrisiken: zu viele gleichwertige Elemente auf einer Ebene, fehlende visuelle Hierarchie, widersprüchliche Farb- oder Status-Signale.
- Bindungsrisiken: wenn Komponenten auf veraltete oder nicht-existente Backend-Felder verweisen.
- Prioritätsreihenfolge im UI: Kritische Warnungen → Aktionen → Marktdaten → Historisches.
`.trim();

/* ─────────────────────────────────────────────
   System prompt
   ───────────────────────────────────────────── */

const SYSTEM_PROMPT = `
Du bist Gemini Architect V1 – der dedizierte Frontend-Architekt und Präsentationsassistent für das HQS-System.

${HQS_FRONTEND_CONTEXT}

Deine Aufgabe:
- Frontend-/Layout-/Darstellungsfragen sachlich und strukturiert beantworten.
- Konkrete Empfehlungen für Aufbau, Hierarchie und Darstellungsklarheit geben.
- Risiken in Bindings, Views und Darstellungslogik erkennen und benennen.
- Ruhig, präzise und verständlich formulieren.

Deine Rolle ist NICHT:
- Backend-Diagnose oder Code-Fehlersuche im Backend.
- News-Zusammenfassung oder allgemeiner Chat.
- Duplizierung der DeepSeek-Diagnose- oder Change-Intelligence-Funktionen.

Regeln:
1. Antworte immer auf Deutsch. Nutze einfache, klare Sprache. Kurze Sätze bevorzugen.
2. Antworte NUR mit einem einzelnen gültigen JSON-Objekt – kein Markdown, keine Prosa, keine Erklärungen außerhalb des JSON.
3. JSON NICHT in Code-Fences einschließen.
4. Verwende genau diese Schlüssel auf oberster Ebene:
   - "summaryTitle"              (String – prägnanter Titel der Analyse)
   - "summaryText"               (String – ein bis drei Sätze Zusammenfassung)
   - "severity"                  (String, einer von: "low", "medium", "high")
   - "uiFindings"                (Array von kurzen Strings – konkrete Beobachtungen zur Oberfläche)
   - "layoutRecommendations"     (Array von kurzen Strings – Layout-Empfehlungen)
   - "priorityRecommendations"   (Array von kurzen Strings – Priorisierungshinweise für das UI)
   - "frontendGuardNotes"        (Array von kurzen Strings – Binding- / View-Risiken)
   - "recommendedAction"         (String – die eine wichtigste Maßnahme)
   - "confidenceNote"            (String – kurzer Hinweis zur Verlässlichkeit dieser Einschätzung)
5. Jeder Array-Wert MUSS ein Array sein, niemals ein einzelner String.
6. Jeden Array-Eintrag kurz halten (maximal ein Satz).
7. "severity" muss den Gesamtschweregrad der Frontend-Risiken widerspiegeln:
   - "low"    → kleinere Auffälligkeiten, kein dringender Handlungsbedarf
   - "medium" → merkliche Darstellungs- oder Strukturprobleme, die untersucht werden sollten
   - "high"   → ernste UI-Risiken, die sofortige Aufmerksamkeit erfordern
8. Keine Marketing-Sprache, keine Füllwörter, keine Disclaimers.
`.trim();

/* ─────────────────────────────────────────────
   Mode-specific prompt additions
   ───────────────────────────────────────────── */

const MODE_INSTRUCTIONS = {
  layout_review: `
Prüfschwerpunkt: LAYOUT-REVIEW
Frage: Ist die Oberfläche sinnvoll aufgebaut?
Prüfe: visuelle Hierarchie, Informationsdichte, Gruppierung zusammengehöriger Elemente, Abstand und Klarheit der Struktur.
`.trim(),

  presentation_review: `
Prüfschwerpunkt: DARSTELLUNGS-REVIEW
Frage: Ist die Darstellung verständlich, ruhig und klar?
Prüfe: Lesbarkeit, Farbsignale, Status-Klarheit, Konsistenz der Darstellungsmuster, Nutzerkommunikation.
`.trim(),

  frontend_guard: `
Prüfschwerpunkt: FRONTEND-GUARD
Frage: Gibt es Binding-, View- oder Darstellungsrisiken?
Prüfe: Komponenten-Bindings an Backend-Felder, veraltete Schema-Abhängigkeiten, fehlende Null-/Leer-Zustände, Fehler-Darstellung.
`.trim(),

  priority_review: `
Prüfschwerpunkt: PRIORITÄTS-REVIEW
Frage: Zeigt das UI gerade die richtigen Dinge oben?
Prüfe: ob kritische Warnungen und Handlungsempfehlungen prominent sind, ob sekundäre Informationen die Hauptaussage verdrängen.
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
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    return trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
  return [String(value)];
}

function normaliseMode(value) {
  const s = toStr(value).toLowerCase();
  return VALID_MODES.includes(s) ? s : DEFAULT_MODE;
}

function normaliseBridgeContext(value) {
  if (!value || typeof value !== "object") return null;
  return value;
}

function normaliseLayoutState(value) {
  if (!value) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch (_) {
      return "";
    }
  }
  return toStr(value);
}

/* ─────────────────────────────────────────────
   JSON response parsing & normalisation
   ───────────────────────────────────────────── */

function stripCodeFences(raw) {
  if (typeof raw !== "string") return String(raw || "");
  let text = raw.trim();
  let prev;
  do {
    prev = text;
    text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  } while (text !== prev);
  return text;
}

function fallbackResult(rawContent, reason) {
  return {
    summaryTitle: "Analyse konnte nicht verarbeitet werden",
    summaryText: `Die Antwort konnte nicht sauber verarbeitet werden – ${reason || "unbekannte Ursache"}.`,
    severity: "medium",
    uiFindings: [],
    layoutRecommendations: [],
    priorityRecommendations: [],
    frontendGuardNotes: [],
    recommendedAction: "Bitte die Analyse erneut ausführen oder die Eingabe prüfen.",
    confidenceNote: "Keine Einschätzung möglich – Verarbeitungsfehler.",
    _rawResponse: rawContent || null,
  };
}

const EXPECTED_ARRAY_KEYS = [
  "uiFindings",
  "layoutRecommendations",
  "priorityRecommendations",
  "frontendGuardNotes",
];

const VALID_SEVERITIES = ["low", "medium", "high"];

function normaliseResult(obj) {
  if (!obj || typeof obj !== "object") {
    return fallbackResult(null, "response was not an object");
  }

  const result = {};

  result.summaryTitle = toStr(obj.summaryTitle) || "Gemini Architect Analyse";
  result.summaryText  = toStr(obj.summaryText)  || "";

  const rawSeverity = toStr(obj.severity).toLowerCase();
  result.severity = VALID_SEVERITIES.includes(rawSeverity) ? rawSeverity : "medium";

  for (const key of EXPECTED_ARRAY_KEYS) {
    result[key] = toStringArray(obj[key]);
  }

  result.recommendedAction = toStr(obj.recommendedAction) || "";
  result.confidenceNote    = toStr(obj.confidenceNote)    || "";

  return result;
}

/* ─────────────────────────────────────────────
   User prompt builder
   ───────────────────────────────────────────── */

function buildUserPrompt(normalised) {
  const {
    mode,
    message,
    context,
    notes,
    affectedAreas,
    affectedViews,
    affectedComponents,
    bridgeContext,
    frontendObservations,
    priorityContext,
    layoutState,
  } = normalised;

  const sections = [];

  // Mode instruction
  const modeInstruction = MODE_INSTRUCTIONS[mode];
  if (modeInstruction) {
    sections.push(modeInstruction);
  }

  if (message) {
    sections.push(`Anfrage:\n${message}`);
  }

  if (affectedAreas.length) {
    sections.push(`Betroffene Systembereiche:\n${affectedAreas.map((a) => `- ${a}`).join("\n")}`);
  }

  if (affectedViews.length) {
    sections.push(`Betroffene Views / Seiten:\n${affectedViews.map((v) => `- ${v}`).join("\n")}`);
  }

  if (affectedComponents.length) {
    sections.push(`Betroffene Komponenten:\n${affectedComponents.map((c) => `- ${c}`).join("\n")}`);
  }

  if (frontendObservations.length) {
    sections.push(`Frontend-Beobachtungen:\n${frontendObservations.map((o) => `- ${o}`).join("\n")}`);
  }

  if (layoutState) {
    sections.push(`Aktueller Layout-Zustand:\n${layoutState}`);
  }

  if (priorityContext) {
    sections.push(`Prioritätskontext:\n${priorityContext}`);
  }

  if (bridgeContext) {
    try {
      const bridgeStr = JSON.stringify(bridgeContext, null, 2);
      sections.push(`Agent-Bridge-Kontext:\n${bridgeStr}`);
    } catch (_) {
      // skip malformed bridge context
    }
  }

  if (context) {
    sections.push(`Zusätzlicher Kontext:\n${context}`);
  }

  if (notes) {
    sections.push(`Hinweise:\n${notes}`);
  }

  return sections.join("\n\n");
}

/* ─────────────────────────────────────────────
   Core review function
   ───────────────────────────────────────────── */

/**
 * Run a Gemini Architect frontend/layout/presentation review.
 *
 * @param {Object}          payload
 * @param {string}          [payload.mode]                – one of VALID_MODES
 * @param {string}          [payload.message]             – free-form review request
 * @param {string}          [payload.context]             – additional context
 * @param {string}          [payload.notes]               – extra notes
 * @param {string[]|string} [payload.affectedAreas]       – affected system areas
 * @param {string[]|string} [payload.affectedViews]       – affected views/pages
 * @param {string[]|string} [payload.affectedComponents]  – affected UI components
 * @param {Object}          [payload.bridgeContext]       – agent bridge context object
 * @param {string[]|string} [payload.frontendObservations]– frontend observations
 * @param {string}          [payload.priorityContext]     – UI priority context
 * @param {string|Object}   [payload.layoutState]         – current layout state description
 * @returns {Promise<Object>} structured review result
 */
async function runGeminiArchitectReview(payload = {}) {
  if (!isGeminiConfigured()) {
    throw new Error("GEMINI_API_KEY is not configured – cannot run Gemini Architect Review");
  }

  // ── normalise inputs ─────────────────────────
  const normalised = {
    mode:                 normaliseMode(payload.mode),
    message:              toStr(payload.message),
    context:              toStr(payload.context),
    notes:                toStr(payload.notes),
    affectedAreas:        toStringArray(payload.affectedAreas),
    affectedViews:        toStringArray(payload.affectedViews),
    affectedComponents:   toStringArray(payload.affectedComponents),
    bridgeContext:        normaliseBridgeContext(payload.bridgeContext),
    frontendObservations: toStringArray(payload.frontendObservations),
    priorityContext:      toStr(payload.priorityContext),
    layoutState:          normaliseLayoutState(payload.layoutState),
  };

  // ── build user prompt ────────────────────────
  const userPrompt = buildUserPrompt(normalised);

  // Guard: need at least some input
  if (!userPrompt.trim()) {
    return {
      mode: normalised.mode,
      result: fallbackResult(null, "no input data provided"),
    };
  }

  // ── call Gemini ──────────────────────────────
  const client    = getGeminiClient();
  const modelName = getModelName();

  const model = client.getGenerativeModel({
    model: modelName,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      temperature: 0.15,
      maxOutputTokens: 1024,
    },
  });

  logger.info("[geminiArchitect] sending request", { mode: normalised.mode, model: modelName });

  const response = await model.generateContent(userPrompt);
  const geminiResponse = response?.response;
  const rawContent = geminiResponse ? (geminiResponse.text() ?? "") : "";

  // ── parse & validate response ────────────────
  const cleaned = stripCodeFences(rawContent);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.warn("[geminiArchitect] JSON parse failed – using fallback", {
      reason: err.message,
      rawContent,
    });
    return {
      mode: normalised.mode,
      result: fallbackResult(rawContent, "JSON parse error"),
    };
  }

  const result = normaliseResult(parsed);

  return {
    mode: normalised.mode,
    result,
  };
}

/* ─────────────────────────────────────────────
   Exports
   ───────────────────────────────────────────── */

module.exports = {
  isGeminiConfigured,
  runGeminiArchitectReview,
  VALID_MODES,
};
