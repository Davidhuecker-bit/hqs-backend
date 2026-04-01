"use strict";

const {
  isDeepSeekConfigured,
  createDeepSeekChatCompletion,
} = require("./deepseek.service");

const logger = require("../utils/logger");

/* ─────────────────────────────────────────────
   Supported source modes
   ───────────────────────────────────────────── */
const VALID_MODES = ["diagnose", "change_review", "math_logic_review", "chat"];

/* ─────────────────────────────────────────────
   System prompt
   ───────────────────────────────────────────── */
const SYSTEM_PROMPT = `
Du bist ein interner HQS-Übersetzer, der technische Analyse-Ergebnisse in eine kurze, alltagstaugliche Menschensicht überträgt.

Deine Aufgabe: Aus einem bereits vorhandenen strukturierten DeepSeek-Analyse- oder Review-Ergebnis eine kompakte, verständliche Zusammenfassung bauen – ohne die technischen Details zu verändern.

Regeln:
1. Antworte immer auf Deutsch. Nutze einfache, klare Sprache. Kurze Sätze bevorzugen.
2. Wenn ein Fachbegriff nötig ist, erkläre ihn in einem Halbsatz.
3. Antworte NUR mit einem einzelnen gültigen JSON-Objekt – kein Markdown, keine Prosa, keine Erklärungen außerhalb des JSON.
4. JSON NICHT in Code-Fences einschließen.
5. Verwende genau diese Schlüssel auf oberster Ebene:
   - "summaryTitle"       (String – ein prägnanter Titel, maximal 10 Wörter)
   - "summaryText"        (String – zwei bis vier Sätze, alltagstauglich erklärt)
   - "severity"           (String, einer von: "low", "medium", "high")
   - "whatMattersNow"     (Array von kurzen Strings – die wichtigsten Punkte, maximal 4)
   - "recommendedAction"  (String – ein konkreter nächster Schritt, ein Satz)
   - "confidenceNote"     (String – kurzer Hinweis auf Datenlage oder Unsicherheiten)
6. Jeder "whatMattersNow"-Eintrag: maximal ein Satz, alltagstauglich.
7. Kein Marketing, keine Füllwörter, keine Disclaimers.
8. "severity" muss den Schweregrad des Gesamtergebnisses widerspiegeln:
   - "low"    → alles überwiegend in Ordnung, kleinere Hinweise
   - "medium" → merkliche Auffälligkeiten, Prüfung empfohlen
   - "high"   → ernste Probleme, sofortige Aufmerksamkeit nötig
`.trim();

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
  return VALID_MODES.includes(s) ? s : "diagnose";
}

/* ─────────────────────────────────────────────
   JSON response parsing
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

function fallbackResult(rawContent, reason) {
  return {
    summaryTitle: "Zusammenfassung nicht verfügbar",
    summaryText: `Die Menschensicht konnte nicht erstellt werden – ${reason || "unbekannte Ursache"}.`,
    severity: "medium",
    whatMattersNow: ["Bitte die Rohantwort prüfen oder die Analyse erneut ausführen."],
    recommendedAction: "Analyse erneut starten oder Rohergebnis direkt prüfen.",
    confidenceNote: "Keine Aussage möglich – Parsing-Fehler.",
    _rawResponse: rawContent || null,
  };
}

const VALID_SEVERITIES = ["low", "medium", "high"];

function normaliseResult(obj) {
  if (!obj || typeof obj !== "object") {
    return fallbackResult(null, "response was not an object");
  }

  const result = {};

  result.summaryTitle = toStr(obj.summaryTitle) || "HQS Review Zusammenfassung";
  result.summaryText  = toStr(obj.summaryText)  || "";

  const rawSeverity = toStr(obj.severity).toLowerCase();
  result.severity = VALID_SEVERITIES.includes(rawSeverity) ? rawSeverity : "medium";

  result.whatMattersNow    = toStringArray(obj.whatMattersNow);
  result.recommendedAction = toStr(obj.recommendedAction);
  result.confidenceNote    = toStr(obj.confidenceNote);

  return result;
}

/* ─────────────────────────────────────────────
   Severity inference fallback (no DeepSeek)
   ───────────────────────────────────────────── */

function inferSeverityFromResult(result) {
  if (!result || typeof result !== "object") return "medium";

  const levelFields = ["riskLevel", "reviewLevel"];
  for (const field of levelFields) {
    const val = toStr(result[field]).toLowerCase();
    if (VALID_SEVERITIES.includes(val)) return val;
  }
  return "medium";
}

/* ─────────────────────────────────────────────
   Static human summary builder (fallback path)
   Used when DeepSeek is unavailable.
   ───────────────────────────────────────────── */

function buildStaticHumanSummary(mode, result) {
  const severity  = inferSeverityFromResult(result);
  const risks     = toStringArray(result.detectedRisks || result.rootCauseHypotheses || []);
  const actions   = toStringArray(
    result.recommendedActions || result.recommendedChecks || result.suggestedNextSteps || []
  );
  const notes     = toStringArray(result.notes || []);

  const modeLabel = {
    diagnose:           "Systemdiagnose",
    change_review:      "Änderungsprüfung",
    math_logic_review:  "Mathematik- & Logikprüfung",
    chat:               "DeepSeek-Analyse",
  }[mode] || "DeepSeek-Analyse";

  const severityLabel = {
    low:    "Keine kritischen Probleme gefunden.",
    medium: "Einige Auffälligkeiten wurden festgestellt.",
    high:   "Ernste Probleme wurden erkannt – Handlungsbedarf.",
  }[severity];

  const whatMattersNow = [
    ...risks.slice(0, 2),
    ...notes.slice(0, 2),
  ].slice(0, 4);

  return {
    summaryTitle:      `${modeLabel} – Ergebnis`,
    summaryText:       `${severityLabel} ${risks.length ? `Erkannte Risiken: ${risks.slice(0, 2).join("; ")}.` : ""}`.trim(),
    severity,
    whatMattersNow:    whatMattersNow.length ? whatMattersNow : ["Kein besonderer Handlungsbedarf."],
    recommendedAction: actions[0] || "Ergebnis sichten und bei Bedarf vertiefen.",
    confidenceNote:    "Statische Zusammenfassung – keine KI-Verdichtung verfügbar.",
  };
}

/* ─────────────────────────────────────────────
   User prompt builder
   ───────────────────────────────────────────── */

function buildUserPrompt({ mode, message, result, dependencyHints, version, notes }) {
  const sections = [];

  const modeLabel = {
    diagnose:           "Systemdiagnose",
    change_review:      "Änderungsprüfung",
    math_logic_review:  "Mathematik- & Logikprüfung",
    chat:               "Allgemeiner Admin-Chat",
  }[mode] || "Analyse";

  sections.push(`Quell-Modus: ${modeLabel}${version ? ` (${version})` : ""}`);

  if (message) {
    sections.push(`Ursprüngliche Anfrage:\n${message}`);
  }

  if (result && typeof result === "object") {
    sections.push(
      `Strukturiertes Analyse-Ergebnis (JSON):\n${JSON.stringify(result, null, 2)}`
    );
  }

  if (dependencyHints && dependencyHints.length) {
    const hints = toStringArray(dependencyHints);
    sections.push(`Abhängigkeitshinweise:\n${hints.map((h) => `- ${h}`).join("\n")}`);
  }

  if (notes) {
    sections.push(`Zusätzliche Hinweise:\n${notes}`);
  }

  return sections.join("\n\n");
}

/* ─────────────────────────────────────────────
   Core export
   ───────────────────────────────────────────── */

/**
 * Build a human-readable summary from an existing structured DeepSeek
 * analysis / review result.
 *
 * @param {Object}            payload
 * @param {string}            [payload.mode]              – "diagnose"|"change_review"|"math_logic_review"|"chat"
 * @param {string}            [payload.message]           – original free-form query
 * @param {Object}            [payload.result]            – structured DeepSeek result object
 * @param {string[]|string}   [payload.dependencyHints]   – dependency hints from dependencyMapping
 * @param {string}            [payload.version]           – optional version label (e.g. "light-v1")
 * @param {string}            [payload.notes]             – optional extra notes
 * @returns {Promise<Object>} human review summary
 */
async function buildHumanReviewSummary(payload = {}) {
  const mode             = normaliseMode(payload.mode);
  const message          = toStr(payload.message);
  const result           = payload.result || null;
  const dependencyHints  = payload.dependencyHints || [];
  const version          = toStr(payload.version);
  const notes            = toStr(payload.notes);

  // If DeepSeek is not available, build a static summary from the result data.
  if (!isDeepSeekConfigured()) {
    logger.warn("[reviewToHuman] DeepSeek not configured – using static summary fallback");
    return buildStaticHumanSummary(mode, result || {});
  }

  // Guard: need either a result object or at least a message to work with.
  if (!result && !message) {
    return fallbackResult(null, "weder 'result' noch 'message' angegeben");
  }

  const userPrompt = buildUserPrompt({
    mode,
    message,
    result,
    dependencyHints,
    version,
    notes,
  });

  let rawContent;
  try {
    const completion = await createDeepSeekChatCompletion({
      tier: "fast",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: userPrompt },
      ],
      temperature: 0.2,
    });

    const firstChoice = completion && completion.choices && completion.choices[0];
    rawContent = (firstChoice && firstChoice.message && firstChoice.message.content) || "";
  } catch (err) {
    logger.error("[reviewToHuman] DeepSeek call failed – falling back to static summary", {
      message: err.message,
    });
    return buildStaticHumanSummary(mode, result || {});
  }

  const cleaned = stripCodeFences(rawContent);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (_) {
    logger.warn("[reviewToHuman] JSON parse failed – returning fallback", {
      rawContent,
    });
    return fallbackResult(rawContent, "JSON-Parsing fehlgeschlagen");
  }

  return normaliseResult(parsed);
}

module.exports = { buildHumanReviewSummary };
