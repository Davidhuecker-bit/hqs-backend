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
HQS system architecture context – keep in mind when analyzing changes:

- Stack: Node.js backend, PostgreSQL, Express routes, service layer, repository layer, engine layer, mapper/view layer.
- Key paths: routes/ → services/ → repositories/ → engines/ → mappers/ → views.
- When a backend route is changed, api.js, associated mapper and view files are often affected.
- When hqs_assessment is changed, mappers, filters, summary builders and UI cards are often affected.
- When a symbol source (universe_symbols, entity_map, admin_reference_portfolio) is changed, demo-portfolio, reference basket, universe jobs and snapshot pipeline are often affected.
- When read models (ui_summaries, symbol_summary) are stale, the UI shows contradictions even though raw data jobs are running fine.
- When a label string is passed instead of a symbol array, typical errors like "custom symbols count: 1" appear.
- Mapper/route/job/summary breaks are common follow-up failures when a single upstream service changes its return shape.
- Admin models and read models can drift when the write-side schema changes but the read-side rebuild is not triggered.
- Snapshot jobs, news jobs, score jobs and advanced-metrics jobs form a pipeline; a break early in the chain cascades.
`.trim();

/* ─────────────────────────────────────────────
   System prompt template
   ───────────────────────────────────────────── */
const SYSTEM_PROMPT = `
You are an internal HQS Change Intelligence Analyst.
Your job is to analyse code changes, logs and error reports for the HQS backend system and return a structured JSON diagnosis.

${HQS_CONTEXT_RULES}

Rules:
1. Reply ONLY with a single valid JSON object – no markdown, no prose, no explanations outside the JSON.
2. Do NOT wrap the JSON in code fences.
3. Use the following exact top-level keys:
   - "riskLevel" (string, one of: "low", "medium", "high")
   - "rootCauseHypotheses" (array of short strings)
   - "likelyAffectedFiles" (array of file paths or file names)
   - "missingFollowupChanges" (array of short strings)
   - "recommendedActions" (array of short strings)
   - "patchPlan" (array of short strings describing concrete fix steps)
   - "notes" (array of short strings with additional observations)
4. Every value that is an array MUST be an array, never a single string.
5. Keep each array item concise (one sentence max).
6. Focus on root cause, follow-up files, missing changes, and a concrete fix plan.
7. Do NOT use marketing language, filler phrases or disclaimers.
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
      `Automated parsing did not produce clean JSON – ${reason || "unknown reason"}.`,
      "Please review the raw model output or re-run the analysis.",
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
    sections.push(`Changed files:\n${changedFiles.map((f) => `- ${f}`).join("\n")}`);
  }

  if (logs.length) {
    sections.push(`Logs:\n${logs.map((l) => `- ${l}`).join("\n")}`);
  }

  if (errorMessage) {
    sections.push(`Error message:\n${errorMessage}`);
  }

  if (affectedArea) {
    sections.push(`Affected area: ${affectedArea}`);
  }

  if (suspectedFiles.length) {
    sections.push(`Suspected files:\n${suspectedFiles.map((f) => `- ${f}`).join("\n")}`);
  }

  if (context) {
    sections.push(`Additional context:\n${context}`);
  }

  if (notes) {
    sections.push(`Notes:\n${notes}`);
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
        depParts.push(`Known related files:\n${dependencyHints.relatedFiles.map((f) => `- ${f}`).join("\n")}`);
      }
      if (dependencyHints.relatedAreas.length) {
        depParts.push(`Known related areas:\n${dependencyHints.relatedAreas.map((a) => `- ${a}`).join("\n")}`);
      }
      if (dependencyHints.followupChecks.length) {
        depParts.push(`Suggested follow-up checks:\n${dependencyHints.followupChecks.map((c) => `- ${c}`).join("\n")}`);
      }
      sections.push(`HQS Dependency Mapping hints (auto-enriched):\n${depParts.join("\n")}`);
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
