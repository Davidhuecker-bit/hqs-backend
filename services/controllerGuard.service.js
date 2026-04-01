"use strict";

const {
  isDeepSeekConfigured,
  createDeepSeekChatCompletion,
} = require("./deepseek.service");

const logger = require("../utils/logger");

/* ─────────────────────────────────────────────
   HQS-specific context for Controller Guard
   ───────────────────────────────────────────── */
const HQS_GUARD_CONTEXT = `
HQS-System-Kontext für Controller-Guard-Analyse – bei der Auswertung beachten:

- Das HQS-Backend besteht aus Route-Layern (admin.routes, portfolio.routes), Service-Layern, Repository-Layern und Engine-Layern.
- Kritische Datenflüsse: symbol_summary-Pipeline, hqs_assessment, snapshot-Pipeline, change_memory, tech_radar, adminReferencePortfolio.
- Mapper- und View-Model-Brüche entstehen, wenn ein Service ein Feld umbenennt oder entfernt, aber der Controller oder das Frontend noch das alte Schema erwartet.
- Folgefehler: Änderungen an einer Route oder einem Response-Vertrag können stille Regressionen in abhängigen Clients (UI, Admin-Konsole) verursachen.
- Read-Model-Staleness: gecachte oder vorberechnete Summaries (symbol_summary, ui_summaries) können nach Schema-Änderungen veraltet sein.
- Pflichtfelder: Alle Endpunkte mit strukturierten JSON-Responses sollten ihre Pflichtfelder-Invarianten beibehalten.
- Symbol- und ID-Verwechslung: Symbole wie Ticker, interne IDs und Datenbank-Primärschlüssel sollten nicht vermischt werden.
- Schema-Änderungen ohne Nachziehungen: Feld-Umbenennungen oder Typ-Änderungen in Datenbank oder Service-Schicht müssen bis in alle Consumer weitergezogen werden.
`.trim();

/* ─────────────────────────────────────────────
   System prompt
   ───────────────────────────────────────────── */
const SYSTEM_PROMPT = `
Du bist ein interner HQS-Controller-Guard (V1).
Deine Aufgabe ist es, den gelieferten Kontext auf typische Systembrüche, Vertragsbrüche und Folgefehler im HQS-Backend zu prüfen.

${HQS_GUARD_CONTEXT}

Regeln:
1. Antworte immer auf Deutsch. Nutze einfache, klare Sprache. Kurze Sätze bevorzugen.
2. Wenn ein Fachbegriff nötig ist, erkläre ihn kurz. Alltagstaugliche Formulierungen bevorzugen.
3. Antworte NUR mit einem einzelnen gültigen JSON-Objekt – kein Markdown, keine Prosa, keine Erklärungen außerhalb des JSON.
4. JSON NICHT in Code-Fences einschließen.
5. Verwende genau diese Schlüssel auf oberster Ebene:
   - "guardLevel"             (String, einer von: "low", "medium", "high")
   - "contractWarnings"       (Array von kurzen Strings – Vertrags- oder Schema-Brüche)
   - "missingRequiredChecks"  (Array von kurzen Strings – fehlende Pflichtfeld-Prüfungen oder Invarianten)
   - "likelyBreakpoints"      (Array von kurzen Strings – wahrscheinliche Stellen, an denen das System bricht)
   - "followupVerifications"  (Array von kurzen Strings – empfohlene Folgeprüfungen)
   - "stalenessRisks"         (Array von kurzen Strings – Risiken durch veraltete Read-Models oder Caches)
   - "notes"                  (Array von kurzen Strings – weitere Beobachtungen)
6. Jeder Wert, der ein Array ist, MUSS ein Array sein, niemals ein einzelner String.
7. Jeden Array-Eintrag kurz halten (maximal ein Satz).
8. Fokus auf Guard-Hinweise, Risiken und empfohlene Prüfungen – KEINE automatischen Code-Patches vorschlagen oder Daten verändern.
9. Keine Marketing-Sprache, keine Füllwörter, keine Disclaimers.
10. "guardLevel" muss den Gesamtschweregrad der erkannten Guard-Risiken widerspiegeln:
    - "low"    → kleinere Auffälligkeiten, kein dringender Handlungsbedarf
    - "medium" → merkliche Guard-Risiken, die untersucht werden sollten
    - "high"   → ernste Vertrags- oder Folgefehlersrisiken, die sofortige Aufmerksamkeit erfordern
`.trim();

/* ─────────────────────────────────────────────
   Valid focus areas
   ───────────────────────────────────────────── */
const VALID_FOCUS_AREAS = [
  "missing_required_fields",
  "response_contract",
  "mapper_viewmodel",
  "route_service_followup",
  "read_model_staleness",
  "symbol_label_id",
  "schema_change_propagation",
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
    guardLevel: "medium",
    contractWarnings: [],
    missingRequiredChecks: [],
    likelyBreakpoints: [],
    followupVerifications: [],
    stalenessRisks: [],
    notes: [
      `Die Antwort konnte nicht sauber verarbeitet werden – ${reason || "unbekannte Ursache"}.`,
      "Bitte die Rohantwort prüfen oder die Analyse erneut ausführen.",
    ],
    _rawResponse: rawContent || null,
  };
}

const EXPECTED_ARRAY_KEYS = [
  "contractWarnings",
  "missingRequiredChecks",
  "likelyBreakpoints",
  "followupVerifications",
  "stalenessRisks",
  "notes",
];

const VALID_GUARD_LEVELS = ["low", "medium", "high"];

/**
 * Ensure the parsed object conforms to the expected schema.
 * Coerces strings to arrays, fills missing keys, validates guardLevel.
 */
function normaliseResult(obj) {
  if (!obj || typeof obj !== "object") {
    return fallbackResult(null, "response was not an object");
  }

  const result = {};

  // guardLevel
  const rawLevel = toStr(obj.guardLevel).toLowerCase();
  result.guardLevel = VALID_GUARD_LEVELS.includes(rawLevel) ? rawLevel : "medium";

  // Array fields
  for (const key of EXPECTED_ARRAY_KEYS) {
    result[key] = toStringArray(obj[key]);
  }

  return result;
}

/* ─────────────────────────────────────────────
   User prompt builder
   ───────────────────────────────────────────── */

function buildUserPrompt({
  mode,
  message,
  changedFiles,
  logs,
  context,
  notes,
  focusAreas,
  result,
  dependencyHints,
  affectedArea,
}) {
  const sections = [];

  if (mode) {
    sections.push(`Modus: ${mode}`);
  }

  if (affectedArea) {
    sections.push(`Betroffener Bereich: ${affectedArea}`);
  }

  if (focusAreas.length) {
    sections.push(`Guard-Schwerpunkte für diese Analyse:\n${focusAreas.map((a) => `- ${a}`).join("\n")}`);
  }

  if (message) {
    sections.push(`Guard-Anfrage:\n${message}`);
  }

  if (changedFiles.length) {
    sections.push(`Geänderte / relevante Dateien:\n${changedFiles.map((f) => `- ${f}`).join("\n")}`);
  }

  if (logs.length) {
    sections.push(`Protokolle / Fehlermeldungen:\n${logs.map((l) => `- ${l}`).join("\n")}`);
  }

  if (context) {
    sections.push(`Zusätzlicher Kontext:\n${context}`);
  }

  if (dependencyHints != null) {
    const hints = Array.isArray(dependencyHints)
      ? dependencyHints.map(String).filter(Boolean).join("\n")
      : toStr(dependencyHints);
    if (hints) {
      sections.push(`Abhängigkeits-Hinweise:\n${hints}`);
    }
  }

  if (result && typeof result === "object") {
    try {
      sections.push(`Bestehendes Analyse-Ergebnis (zur Guard-Prüfung):\n${JSON.stringify(result, null, 2)}`);
    } catch (_) {
      // ignore serialisation errors
    }
  }

  if (notes) {
    sections.push(`Hinweise:\n${notes}`);
  }

  return sections.join("\n\n");
}

/* ─────────────────────────────────────────────
   Core guard function
   ───────────────────────────────────────────── */

/**
 * Run a Controller-Guard analysis via DeepSeek.
 *
 * @param {Object}             payload
 * @param {string}             [payload.mode]            – optional mode label
 * @param {string}             [payload.message]         – free-form guard request
 * @param {string[]|string}    [payload.changedFiles]    – files involved
 * @param {string[]|string}    [payload.logs]            – logs or error messages
 * @param {string}             [payload.context]         – additional context
 * @param {string}             [payload.notes]           – extra notes
 * @param {Object}             [payload.result]          – existing analysis result
 * @param {string[]|string}    [payload.dependencyHints] – dependency hints
 * @param {string[]}           [payload.focusAreas]      – subset of VALID_FOCUS_AREAS
 * @param {string}             [payload.affectedArea]    – affected system area
 * @returns {Promise<Object>} structured guard result
 */
async function runControllerGuard(payload = {}) {
  if (!isDeepSeekConfigured()) {
    throw new Error("DeepSeek is not configured – cannot run Controller Guard");
  }

  // ── normalise inputs ─────────────────────────
  const mode            = toStr(payload.mode);
  const message         = toStr(payload.message);
  const changedFiles    = toStringArray(payload.changedFiles);
  const logs            = toStringArray(payload.logs);
  const context         = toStr(payload.context);
  const notes           = toStr(payload.notes);
  const result          = payload.result && typeof payload.result === "object" ? payload.result : null;
  const dependencyHints = payload.dependencyHints ?? null;
  const focusAreas      = normaliseFocusAreas(payload.focusAreas);
  const affectedArea    = toStr(payload.affectedArea);

  // ── build user prompt ────────────────────────
  const userPrompt = buildUserPrompt({
    mode,
    message,
    changedFiles,
    logs,
    context,
    notes,
    focusAreas,
    result,
    dependencyHints,
    affectedArea,
  });

  // Guard: need at least some input
  if (!userPrompt.trim()) {
    return {
      guardLevel: "low",
      contractWarnings: [],
      missingRequiredChecks: [],
      likelyBreakpoints: [],
      followupVerifications: [],
      stalenessRisks: [],
      notes: ["Kein Eingabe-Material übergeben – Guard-Analyse nicht möglich."],
    };
  }

  // ── call DeepSeek ────────────────────────────
  const completion = await createDeepSeekChatCompletion({
    tier: "fast",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
  });

  const rawContent = completion?.choices?.[0]?.message?.content || "";

  logger.info("[controllerGuard] DeepSeek response received", {
    rawLength: rawContent.length,
    focusAreas,
    affectedArea: affectedArea || null,
  });

  // ── parse & normalise ────────────────────────
  const cleaned = stripCodeFences(rawContent);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.warn("[controllerGuard] JSON parse failed, returning fallback", {
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
  runControllerGuard,
};
