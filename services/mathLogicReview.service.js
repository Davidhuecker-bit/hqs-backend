"use strict";

const {
  isDeepSeekConfigured,
  createDeepSeekChatCompletion,
  DEEPSEEK_DEEP_MODEL,
} = require("./deepseek.service");

const logger = require("../utils/logger");

/* ─────────────────────────────────────────────
   HQS-specific context for math & logic review
   ───────────────────────────────────────────── */
const HQS_MATH_CONTEXT = `
HQS-System-Kontext für Mathematik- und Logikprüfungen – bei der Analyse beachten:

- Scores im HQS sind typischerweise auf den Bereich 0–100 (oder 0–1) normiert; Werte außerhalb dieses Bereichs weisen auf einen Clamp- oder Normierungsfehler hin.
- Wichtige Scoring-Engines: hqs_assessment, maturityProfile, techRadar-Strategiebewertung, opportunityScanner, discoveryEngine.
- Gewichtete Aggregationen sind häufig; ein doppelt gezählter Teilscore erzeugt einen aufgeblähten Gesamtscore.
- Ersatzwerte (null, NaN, undefined, 0) verzerren unbemerkt Durchschnitte und gewichtete Mittelwerte, wenn sie nicht abgefangen werden.
- Fehlende Metriken verkleinern den effektiven Nenner; das System sollte dies erkennen und melden, statt still auf unvollständigen Daten zu rechnen.
- Bereichs-/Clamp-Probleme entstehen oft, wenn ein Score multipliziert, verschoben oder über verschiedene Skalen kombiniert wird (z. B. 0–1 × 0–100).
- Konsistenzprüfung: Teilscores sollten auf eine vorhersehbare, dokumentierte Weise in Elternscores einfließen.
- Verdächtige Muster: ein Score, der immer 0, immer Maximum, nie variiert oder extreme Streuung bei ähnlichen Symbolen aufweist.
- NaN-Ausbreitung: ein einzelner NaN-Wert in einer gewichteten Summe macht in JavaScript das gesamte Ergebnis zu NaN.
`.trim();

/* ─────────────────────────────────────────────
   System prompt
   ───────────────────────────────────────────── */
const SYSTEM_PROMPT = `
Du bist ein interner HQS-Mathematik- und Logikprüfer (Light V1).
Deine Aufgabe ist es, den gelieferten Kontext, Code-Ausschnitte, Protokolle oder Metrikdaten auf mathematische und logische Plausibilitätsprobleme im HQS-Scoring- und Bewertungssystem zu prüfen.

${HQS_MATH_CONTEXT}

Regeln:
1. Antworte immer auf Deutsch. Nutze einfache, klare Sprache. Kurze Sätze bevorzugen.
2. Wenn ein Fachbegriff nötig ist, erkläre ihn kurz. Alltagstaugliche Formulierungen bevorzugen.
3. Antworte NUR mit einem einzelnen gültigen JSON-Objekt – kein Markdown, keine Prosa, keine Erklärungen außerhalb des JSON.
4. JSON NICHT in Code-Fences einschließen.
5. Verwende genau diese Schlüssel auf oberster Ebene:
   - "reviewLevel"        (String, einer von: "low", "medium", "high")
   - "detectedRisks"      (Array von kurzen Strings – konkrete gefundene Risiken)
   - "consistencyChecks"  (Array von kurzen Strings – Konsistenzbeobachtungen)
   - "missingSignals"     (Array von kurzen Strings – fehlende Daten oder Prüfungen)
   - "recommendedChecks"  (Array von kurzen Strings – konkrete Prüfungen, die das Team durchführen sollte)
   - "notes"              (Array von kurzen Strings – weitere Beobachtungen)
6. Jeder Wert, der ein Array ist, MUSS ein Array sein, niemals ein einzelner String.
7. Jeden Array-Eintrag kurz halten (maximal ein Satz).
8. Fokus auf Plausibilität, Konsistenz und Risiko – KEINE automatischen Code-Patches vorschlagen oder Scores verändern.
9. Keine Marketing-Sprache, keine Füllwörter, keine Disclaimers.
10. "reviewLevel" muss den Gesamtschweregrad der erkannten Probleme widerspiegeln:
    - "low"    → kleinere Auffälligkeiten, kein dringender Handlungsbedarf
    - "medium" → merkliche Probleme, die untersucht werden sollten
    - "high"   → ernste Plausibilitäts- oder Konsistenzprobleme, die sofortige Aufmerksamkeit erfordern
`.trim();

/* ─────────────────────────────────────────────
   Valid focus areas
   ───────────────────────────────────────────── */
const VALID_FOCUS_AREAS = [
  "score_consistency",
  "missing_metrics",
  "weighting",
  "fallback_logic",
  "range_clamp",
  "null_nan_risk",
];

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

function normaliseFocusAreas(value) {
  const raw = toStringArray(value);
  if (!raw.length) return VALID_FOCUS_AREAS.slice(); // default: all areas
  return raw.filter((a) => VALID_FOCUS_AREAS.includes(a));
}

/* ─────────────────────────────────────────────
   JSON response parsing
   ───────────────────────────────────────────── */

/** Strip markdown code fences that DeepSeek sometimes adds. */
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

/** Empty/fallback result used when parsing fails completely. */
function fallbackResult(rawContent, reason) {
  return {
    reviewLevel: "medium",
    detectedRisks: [],
    consistencyChecks: [],
    missingSignals: [],
    recommendedChecks: [],
    notes: [
      `Die Antwort konnte nicht sauber verarbeitet werden – ${reason || "unbekannte Ursache"}.`,
      "Bitte die Rohantwort prüfen oder die Analyse erneut ausführen.",
    ],
    _rawResponse: rawContent || null,
  };
}

const EXPECTED_ARRAY_KEYS = [
  "detectedRisks",
  "consistencyChecks",
  "missingSignals",
  "recommendedChecks",
  "notes",
];

const VALID_REVIEW_LEVELS = ["low", "medium", "high"];

/**
 * Ensure the parsed object conforms to the expected schema.
 * Coerces strings to arrays, fills missing keys, validates reviewLevel.
 */
function normaliseResult(obj) {
  if (!obj || typeof obj !== "object") {
    return fallbackResult(null, "response was not an object");
  }

  const result = {};

  // reviewLevel
  const rawLevel = toStr(obj.reviewLevel).toLowerCase();
  result.reviewLevel = VALID_REVIEW_LEVELS.includes(rawLevel) ? rawLevel : "medium";

  // Array fields
  for (const key of EXPECTED_ARRAY_KEYS) {
    result[key] = toStringArray(obj[key]);
  }

  return result;
}

/* ─────────────────────────────────────────────
   User prompt builder
   ───────────────────────────────────────────── */

function buildUserPrompt({ message, changedFiles, logs, context, notes, focusAreas }) {
  const sections = [];

  if (focusAreas.length) {
    sections.push(`Prüfschwerpunkte für diese Analyse:\n${focusAreas.map((a) => `- ${a}`).join("\n")}`);
  }

  if (message) {
    sections.push(`Prüfanfrage:\n${message}`);
  }

  if (changedFiles.length) {
    sections.push(`Geänderte / relevante Dateien:\n${changedFiles.map((f) => `- ${f}`).join("\n")}`);
  }

  if (logs.length) {
    sections.push(`Protokolle / Metrikdaten:\n${logs.map((l) => `- ${l}`).join("\n")}`);
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
 * Run a Math & Logic plausibility review via DeepSeek.
 *
 * @param {Object}          payload
 * @param {string}          [payload.message]       – free-form review request
 * @param {string[]|string} [payload.changedFiles]  – files involved
 * @param {string[]|string} [payload.logs]          – logs or metric samples
 * @param {string}          [payload.context]       – additional context
 * @param {string}          [payload.notes]         – extra notes
 * @param {string[]}        [payload.focusAreas]    – subset of VALID_FOCUS_AREAS
 * @returns {Promise<Object>} structured review result
 */
async function runMathLogicReview(payload = {}) {
  if (!isDeepSeekConfigured()) {
    throw new Error("DeepSeek is not configured – cannot run Math & Logic Review");
  }

  // ── normalise inputs ─────────────────────────
  const message      = toStr(payload.message);
  const changedFiles = toStringArray(payload.changedFiles);
  const logs         = toStringArray(payload.logs);
  const context      = toStr(payload.context);
  const notes        = toStr(payload.notes);
  const focusAreas   = normaliseFocusAreas(payload.focusAreas);

  // ── build user prompt ────────────────────────
  const userPrompt = buildUserPrompt({ message, changedFiles, logs, context, notes, focusAreas });

  // Guard: need at least some input
  if (!userPrompt.trim()) {
    return fallbackResult(null, "no input data provided");
  }

  // ── call DeepSeek ────────────────────────────
  // Math & logic plausibility review uses deepseek-reasoner for thorough analysis.
  const completion = await createDeepSeekChatCompletion({
    model: DEEPSEEK_DEEP_MODEL,
    timeoutMs: 45000,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
  });

  const rawContent = completion?.choices?.[0]?.message?.content || "";

  logger.info("[mathLogicReview] DeepSeek response received", {
    model: DEEPSEEK_DEEP_MODEL,
    rawLength: rawContent.length,
    focusAreas,
  });

  // ── parse & normalise ────────────────────────
  const cleaned = stripCodeFences(rawContent);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.warn("[mathLogicReview] JSON parse failed, returning fallback", {
      error: err.message,
      rawLength: rawContent.length,
    });
    return fallbackResult(rawContent, `JSON parse error: ${err.message}`);
  }

  // Handle case where DeepSeek returns a parse-error descriptor
  if (parsed && parsed.parseError) {
    return fallbackResult(parsed.raw || rawContent, "model returned parse error descriptor");
  }

  return normaliseResult(parsed);
}

/* ─────────────────────────────────────────────
   Exports
   ───────────────────────────────────────────── */
module.exports = {
  runMathLogicReview,
};
