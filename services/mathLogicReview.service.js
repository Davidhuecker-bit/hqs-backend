"use strict";

const {
  isDeepSeekConfigured,
  createDeepSeekChatCompletion,
} = require("./deepseek.service");

const logger = require("../utils/logger");

/* ─────────────────────────────────────────────
   HQS-specific context for math & logic review
   ───────────────────────────────────────────── */
const HQS_MATH_CONTEXT = `
HQS system math & logic context – keep in mind when reviewing:

- Scores in HQS are typically normalised to 0–100 (or 0–1) ranges; values outside this range signal a clamping or normalisation bug.
- Key scoring engines: hqs_assessment, maturityProfile, techRadar strategic assessment, opportunityScanner, discoveryEngine.
- Weighted aggregations are common; double-counting a sub-score produces an inflated composite.
- Fallback values (null, NaN, undefined, 0) silently distort averages and weighted means when not guarded.
- Missing metrics reduce the meaningful denominator; the system should detect and flag this rather than compute silently on partial data.
- Range/clamp problems often appear when a score is multiplied, shifted or combined across different scales (e.g., 0–1 × 0–100).
- Consistency check: sub-scores should sum/aggregate into parent scores in a predictable, documented way.
- Suspicious patterns: a score that is always 0, always max, never changes, or has extreme variance across similar symbols.
- NaN propagation: a single NaN in a weighted sum silently makes the whole result NaN in JavaScript.
`.trim();

/* ─────────────────────────────────────────────
   System prompt
   ───────────────────────────────────────────── */
const SYSTEM_PROMPT = `
You are an internal HQS Math & Logic Review Analyst (Light V1).
Your job is to review the supplied context, code snippets, logs or metric data for mathematical and logical plausibility problems in the HQS scoring and assessment system.

${HQS_MATH_CONTEXT}

Rules:
1. Reply ONLY with a single valid JSON object – no markdown, no prose, no explanations outside the JSON.
2. Do NOT wrap the JSON in code fences.
3. Use the following exact top-level keys:
   - "reviewLevel"        (string, one of: "low", "medium", "high")
   - "detectedRisks"      (array of short strings – concrete risks found)
   - "consistencyChecks"  (array of short strings – consistency observations)
   - "missingSignals"     (array of short strings – data or checks that appear absent)
   - "recommendedChecks"  (array of short strings – concrete checks the team should run)
   - "notes"              (array of short strings – additional observations)
4. Every value that is an array MUST be an array, never a single string.
5. Keep each array item concise (one sentence max).
6. Focus on plausibility, consistency and risk – do NOT suggest automatic code patches or alter scores.
7. Do NOT use marketing language, filler phrases or disclaimers.
8. "reviewLevel" must reflect the overall severity of detected issues:
   - "low"    → minor concerns, no urgent action needed
   - "medium" → notable issues that should be investigated
   - "high"   → serious plausibility or consistency problems requiring immediate attention
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
      `Automated parsing did not produce clean JSON – ${reason || "unknown reason"}.`,
      "Please review the raw model output or re-run the analysis.",
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
    sections.push(`Focus areas for this review:\n${focusAreas.map((a) => `- ${a}`).join("\n")}`);
  }

  if (message) {
    sections.push(`Review request:\n${message}`);
  }

  if (changedFiles.length) {
    sections.push(`Changed / relevant files:\n${changedFiles.map((f) => `- ${f}`).join("\n")}`);
  }

  if (logs.length) {
    sections.push(`Logs / metric data:\n${logs.map((l) => `- ${l}`).join("\n")}`);
  }

  if (context) {
    sections.push(`Additional context:\n${context}`);
  }

  if (notes) {
    sections.push(`Notes:\n${notes}`);
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
  const completion = await createDeepSeekChatCompletion({
    tier: "fast",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
  });

  const rawContent = completion?.choices?.[0]?.message?.content || "";

  logger.info("[mathLogicReview] DeepSeek response received", {
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
