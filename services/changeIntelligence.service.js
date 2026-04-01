"use strict";

const {
  isDeepSeekConfigured,
  createDeepSeekChatCompletion,
} = require("./deepseek.service");

const {
  getDependencyHintsForFiles,
  getDependencyHintsForArea,
} = require("./dependencyMapping.service");

const logger = require("../utils/logger");

/* ─────────────────────────────────────────────
   HQS-specific context rules injected into the
   system prompt so DeepSeek understands our
   typical change-impact patterns.
   ───────────────────────────────────────────── */
const HQS_CONTEXT_RULES = `
HQS-Systemarchitektur-Kontext – bei der Änderungsanalyse beachten:

- Stack: Node.js-Backend, PostgreSQL, Express-Routen, Service-Schicht, Repository-Schicht, Engine-Schicht, Mapper-/View-Schicht.
- Schlüsselpfade: routes/ → services/ → repositories/ → engines/ → mappers/ → views.
- Wenn eine Backend-Route geändert wird, sind api.js, zugehörige Mapper- und View-Dateien oft betroffen.
- Wenn hqs_assessment geändert wird, sind Mapper, Filter, Summary-Builder und UI-Karten oft betroffen.
- Wenn eine Symbolquelle (universe_symbols, entity_map, admin_reference_portfolio) geändert wird, sind Demo-Portfolio, Referenzkorb, Universe-Jobs und Snapshot-Pipeline oft betroffen.
- Wenn Lesemodelle (ui_summaries, symbol_summary) veraltet sind, zeigt die Oberfläche Widersprüche, obwohl die Rohdaten-Jobs korrekt laufen.
- Wenn ein Label-String statt eines Symbol-Arrays übergeben wird, erscheinen typische Fehler wie „custom symbols count: 1".
- Mapper-/Routen-/Job-/Summary-Fehler sind häufige Folgeausfälle, wenn ein vorgelagerter Service seine Rückgabestruktur ändert.
- Admin-Modelle und Lesemodelle können auseinanderdriften, wenn das Schreibschema geändert, aber der Leseseiten-Rebuild nicht ausgelöst wird.
- Snapshot-Jobs, News-Jobs, Score-Jobs und Advanced-Metrics-Jobs bilden eine Pipeline; ein früher Fehler kaskadiert nach unten.
`.trim();

/* ─────────────────────────────────────────────
   System prompt template
   ───────────────────────────────────────────── */
const SYSTEM_PROMPT = `
Du bist ein interner HQS-Änderungs-Intelligenz-Analyst.
Deine Aufgabe ist es, Code-Änderungen, Protokolle und Fehlermeldungen im HQS-Backend-System zu analysieren und eine strukturierte JSON-Diagnose zurückzugeben.

${HQS_CONTEXT_RULES}

Regeln:
1. Antworte immer auf Deutsch. Nutze einfache, klare Sprache. Kurze Sätze bevorzugen.
2. Wenn ein Fachbegriff nötig ist, erkläre ihn kurz.
3. Antworte NUR mit einem einzelnen gültigen JSON-Objekt – kein Markdown, keine Prosa, keine Erklärungen außerhalb des JSON.
4. JSON NICHT in Code-Fences einschließen.
5. Verwende genau diese Schlüssel auf oberster Ebene:
   - "riskLevel" (String, einer von: "low", "medium", "high")
   - "rootCauseHypotheses" (Array von kurzen Strings)
   - "likelyAffectedFiles" (Array von Dateipfaden oder Dateinamen)
   - "missingFollowupChanges" (Array von kurzen Strings)
   - "recommendedActions" (Array von kurzen Strings)
   - "patchPlan" (Array von kurzen Strings mit konkreten Behebungsschritten)
   - "notes" (Array von kurzen Strings mit weiteren Beobachtungen)
6. Jeder Wert, der ein Array ist, MUSS ein Array sein, niemals ein einzelner String.
7. Jeden Array-Eintrag kurz halten (maximal ein Satz).
8. Fokus auf Ursache, Folgedateien, fehlende Änderungen und einen konkreten Behebungsplan.
9. Keine Marketing-Sprache, keine Füllwörter, keine Disclaimers.
`.trim();

/* ─────────────────────────────────────────────
   Input normalisation helpers
   ───────────────────────────────────────────── */

/**
 * Normalise an input that may be a string, an array or undefined
 * into a clean array of strings.
 */
function toStringArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    // split on newlines so multi-line strings become arrays
    return trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
  return [String(value)];
}

/**
 * Normalise a scalar that should be a plain string.
 */
function toStr(value) {
  if (!value) return "";
  return String(value).trim();
}

/* ─────────────────────────────────────────────
   JSON response parsing
   ───────────────────────────────────────────── */

/** Strip markdown code fences that DeepSeek sometimes adds. */
function stripCodeFences(raw) {
  if (typeof raw !== "string") return raw;
  let text = raw.trim();
  // Remove ```json ... ``` or ``` ... ```
  text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  return text.trim();
}

/** Empty/fallback result used when parsing fails completely. */
function fallbackResult(rawContent, reason) {
  return {
    riskLevel: "medium",
    rootCauseHypotheses: [],
    likelyAffectedFiles: [],
    missingFollowupChanges: [],
    recommendedActions: [],
    patchPlan: [],
    notes: [
      `Die Antwort konnte nicht sauber verarbeitet werden – ${reason || "unbekannte Ursache"}.`,
      "Bitte die Rohantwort prüfen oder die Analyse erneut ausführen.",
    ],
    _rawResponse: rawContent || null,
  };
}

const EXPECTED_ARRAY_KEYS = [
  "rootCauseHypotheses",
  "likelyAffectedFiles",
  "missingFollowupChanges",
  "recommendedActions",
  "patchPlan",
  "notes",
];

const VALID_RISK_LEVELS = ["low", "medium", "high"];

/**
 * Ensure the parsed object conforms to the expected schema.
 * Coerces strings to arrays, fills missing keys, validates riskLevel.
 */
function normaliseResult(obj) {
  if (!obj || typeof obj !== "object") return fallbackResult(null, "response was not an object");

  const result = {};

  // riskLevel
  const rawRisk = toStr(obj.riskLevel).toLowerCase();
  result.riskLevel = VALID_RISK_LEVELS.includes(rawRisk) ? rawRisk : "medium";

  // Array fields
  for (const key of EXPECTED_ARRAY_KEYS) {
    result[key] = toStringArray(obj[key]);
  }

  return result;
}

/* ─────────────────────────────────────────────
   Core analysis function
   ───────────────────────────────────────────── */

/**
 * Analyse the impact of a set of changes / an error scenario by
 * sending context to DeepSeek and returning a structured diagnosis.
 *
 * @param {Object} payload
 * @param {string[]|string} [payload.changedFiles]
 * @param {string[]|string} [payload.logs]
 * @param {string}          [payload.errorMessage]
 * @param {string}          [payload.context]
 * @param {string}          [payload.affectedArea]
 * @param {string[]|string} [payload.suspectedFiles]
 * @param {string}          [payload.notes]
 * @returns {Promise<Object>} structured analysis result
 */
async function analyzeChangeImpact(payload = {}) {
  if (!isDeepSeekConfigured()) {
    throw new Error("DeepSeek is not configured – cannot run Change Intelligence analysis");
  }

  // ── normalise inputs ─────────────────────────
  const changedFiles    = toStringArray(payload.changedFiles);
  const logs            = toStringArray(payload.logs);
  const errorMessage    = toStr(payload.errorMessage);
  const context         = toStr(payload.context);
  const affectedArea    = toStr(payload.affectedArea);
  const suspectedFiles  = toStringArray(payload.suspectedFiles);
  const notes           = toStr(payload.notes);

  // ── build user prompt ────────────────────────
  const sections = [];

  if (changedFiles.length) {
    sections.push(`Geänderte Dateien:\n${changedFiles.map((f) => `- ${f}`).join("\n")}`);
  }

  if (logs.length) {
    sections.push(`Protokolle:\n${logs.map((l) => `- ${l}`).join("\n")}`);
  }

  if (errorMessage) {
    sections.push(`Fehlermeldung:\n${errorMessage}`);
  }

  if (affectedArea) {
    sections.push(`Betroffener Bereich: ${affectedArea}`);
  }

  if (suspectedFiles.length) {
    sections.push(`Verdächtige Dateien:\n${suspectedFiles.map((f) => `- ${f}`).join("\n")}`);
  }

  if (context) {
    sections.push(`Zusätzlicher Kontext:\n${context}`);
  }

  if (notes) {
    sections.push(`Hinweise:\n${notes}`);
  }

  // ── dependency mapping hints (Light V1) ──────
  let dependencyHints = null;
  try {
    const fileHints  = getDependencyHintsForFiles(changedFiles);
    const areaHints  = affectedArea ? getDependencyHintsForArea(affectedArea) : null;

    /** Merge items from source into target, skipping duplicates. */
    const mergeUnique = (target, source) => {
      for (const item of source) {
        if (!target.includes(item)) target.push(item);
      }
    };

    // Merge file-based and area-based hints
    const hasFileHints = fileHints.relatedFiles.length || fileHints.relatedAreas.length || fileHints.followupChecks.length;
    const hasAreaHints = areaHints && (areaHints.relatedFiles.length || areaHints.relatedAreas.length || areaHints.followupChecks.length);

    if (hasFileHints || hasAreaHints) {
      dependencyHints = {
        relatedFiles:   [...fileHints.relatedFiles],
        relatedAreas:   [...fileHints.relatedAreas],
        followupChecks: [...fileHints.followupChecks],
      };
      if (areaHints) {
        mergeUnique(dependencyHints.relatedFiles,   areaHints.relatedFiles);
        mergeUnique(dependencyHints.relatedAreas,    areaHints.relatedAreas);
        mergeUnique(dependencyHints.followupChecks,  areaHints.followupChecks);
      }
    }

    // Inject dependency context into the prompt so DeepSeek can use it
    if (dependencyHints && (dependencyHints.relatedFiles.length || dependencyHints.relatedAreas.length)) {
      const depParts = [];
      if (dependencyHints.relatedFiles.length) {
        depParts.push(`Bekannte verwandte Dateien:\n${dependencyHints.relatedFiles.map((f) => `- ${f}`).join("\n")}`);
      }
      if (dependencyHints.relatedAreas.length) {
        depParts.push(`Bekannte verwandte Bereiche:\n${dependencyHints.relatedAreas.map((a) => `- ${a}`).join("\n")}`);
      }
      if (dependencyHints.followupChecks.length) {
        depParts.push(`Empfohlene Folgeprüfungen:\n${dependencyHints.followupChecks.map((c) => `- ${c}`).join("\n")}`);
      }
      sections.push(`HQS-Abhängigkeitshinweise (automatisch angereichert):\n${depParts.join("\n")}`);
    }
  } catch (depErr) {
    // dependency mapping must never break the analysis
    logger.warn("[changeIntelligence] dependency mapping enrichment failed (non-blocking)", {
      message: depErr.message,
    });
  }

  // At least *some* input is needed for a meaningful analysis
  if (sections.length === 0) {
    return fallbackResult(null, "no input data provided");
  }

  const userPrompt = sections.join("\n\n");

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

  // ── parse & normalise ────────────────────────
  const cleaned = stripCodeFences(rawContent);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.warn("[changeIntelligence] JSON parse failed, returning fallback", {
      error: err.message,
      rawLength: rawContent.length,
    });
    return fallbackResult(rawContent, `JSON parse error: ${err.message}`);
  }

  // Handle case where DeepSeek returns { parseError: true }
  if (parsed && parsed.parseError) {
    return fallbackResult(parsed.raw || rawContent, "model returned parse error descriptor");
  }

  const result = normaliseResult(parsed);

  // ── attach dependency hints if available ─────
  if (dependencyHints) {
    result.dependencyHints = dependencyHints;
  }

  return result;
}

/* ─────────────────────────────────────────────
   Exports
   ───────────────────────────────────────────── */
module.exports = {
  analyzeChangeImpact,
};
