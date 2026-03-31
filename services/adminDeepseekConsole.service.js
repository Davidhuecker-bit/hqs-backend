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
HQS system architecture context:

- Stack: Node.js backend, PostgreSQL, Express, service / repository / engine / mapper / view layers.
- Key paths: routes/ → services/ → repositories/ → engines/ → mappers/ → views.
- Data pipeline: Snapshot jobs → News jobs → Score jobs → Advanced-Metrics jobs (cascading).
- Read models: ui_summaries, symbol_summary – can become stale when write-side schema changes.
- Symbol sources: universe_symbols, entity_map, admin_reference_portfolio.
- Portfolio paths: Demo-Portfolio, Reference Basket, Virtual Positions.
- Admin models: admin_reference_portfolio, change_memory, tech_radar_entries.
- Typical problems: Read-model staleness, mapper/route breaks, label vs. symbol-array confusion,
  missing follow-up changes after upstream schema edits, pipeline cascading failures.
`.trim();

/* ─────────────────────────────────────────────
   Mode-specific system prompt fragments
   ───────────────────────────────────────────── */
const MODE_PROMPTS = {
  chat: `
You are an internal HQS Admin Assistant.
You help the admin with questions about the HQS backend, frontend, data pipelines and system architecture.

Rules:
- Answer short, clear, and helpful.
- No marketing language, no filler, no disclaimers.
- If information is missing, say so explicitly.
- You may respond freely in the language the admin uses.
- Keep answers concise but complete.
`.trim(),

  diagnose: `
You are an internal HQS System Diagnostician.
Your job is to diagnose errors, bottlenecks and data-flow problems in the HQS system.

Rules:
- Focus on root cause analysis, pipeline issues, data-flow breaks, read-model staleness.
- Structure your answer with: root cause hypothesis, affected components, and recommended next steps.
- Reply with a JSON object containing these keys:
  "answer" (string – your main diagnosis),
  "warnings" (array of strings – important caveats or risks),
  "suggestedNextSteps" (array of strings – concrete actions to take).
- Do NOT wrap the JSON in code fences.
- No marketing language, no filler, no disclaimers.
- If information is missing, state what is needed in warnings.
`.trim(),

  change_review: `
You are an internal HQS Change Review Analyst.
Your job is to review code changes, find missing follow-up files, assess risk and suggest a fix plan.

Rules:
- Focus on follow-up files, risk assessment, missing changes and a concrete fix plan.
- Structure your answer with: affected files, risk level, missing follow-ups, fix steps.
- Reply with a JSON object containing these keys:
  "answer" (string – your main review),
  "warnings" (array of strings – risks and concerns),
  "suggestedNextSteps" (array of strings – concrete fix steps / follow-ups).
- Do NOT wrap the JSON in code fences.
- No marketing language, no filler, no disclaimers.
- If information is missing, state what is needed in warnings.
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
    return trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }
  return [String(value)];
}

const VALID_MODES = ["chat", "diagnose", "change_review"];

function normaliseMode(mode) {
  const m = toStr(mode).toLowerCase().replace(/-/g, "_");
  return VALID_MODES.includes(m) ? m : "chat";
}

/* ─────────────────────────────────────────────
   Response parsing helpers
   ───────────────────────────────────────────── */

/** Strip markdown code fences that DeepSeek sometimes adds (handles nested fences). */
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

/**
 * Try to extract a JSON object from a raw string.
 * Handles cases where the model wraps JSON inside prose.
 */
function tryParseJson(raw) {
  const cleaned = stripCodeFences(raw);

  // Direct parse
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    // ignore
  }

  // Try to find a JSON object in the string
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (_) {
      // ignore
    }
  }

  return null;
}

/**
 * Normalise model output into the expected response structure.
 * Always returns { answer, warnings, suggestedNextSteps }.
 */
function normaliseResponse(rawContent, mode) {
  if (!rawContent || typeof rawContent !== "string" || !rawContent.trim()) {
    return {
      answer: "No response received from DeepSeek.",
      warnings: [],
      suggestedNextSteps: [],
    };
  }

  // For chat mode, the model may just return plain text
  if (mode === "chat") {
    const parsed = tryParseJson(rawContent);
    if (parsed && typeof parsed === "object") {
      return {
        answer: toStr(parsed.answer) || toStr(parsed.response) || rawContent.trim(),
        warnings: toStringArray(parsed.warnings),
        suggestedNextSteps: toStringArray(parsed.suggestedNextSteps || parsed.nextSteps),
      };
    }
    // Plain text is fine for chat
    return {
      answer: stripCodeFences(rawContent),
      warnings: [],
      suggestedNextSteps: [],
    };
  }

  // For diagnose / change_review, try structured parse
  const parsed = tryParseJson(rawContent);
  if (parsed && typeof parsed === "object") {
    return {
      answer: toStr(parsed.answer) || toStr(parsed.response) || toStr(parsed.diagnosis) || rawContent.trim(),
      warnings: toStringArray(parsed.warnings || parsed.risks || parsed.caveats),
      suggestedNextSteps: toStringArray(
        parsed.suggestedNextSteps || parsed.nextSteps || parsed.recommendedActions || parsed.fixSteps
      ),
    };
  }

  // Fallback: use raw text as answer
  return {
    answer: stripCodeFences(rawContent),
    warnings: ["Response was not structured JSON – showing raw text."],
    suggestedNextSteps: [],
  };
}

/* ─────────────────────────────────────────────
   User prompt builder
   ───────────────────────────────────────────── */

function buildUserPrompt({ message, context, logs, changedFiles, notes }) {
  const sections = [];

  if (message) {
    sections.push(`Admin message:\n${message}`);
  }

  if (context) {
    sections.push(`Context:\n${context}`);
  }

  if (logs.length) {
    sections.push(`Logs:\n${logs.map((l) => `- ${l}`).join("\n")}`);
  }

  if (changedFiles.length) {
    sections.push(`Changed files:\n${changedFiles.map((f) => `- ${f}`).join("\n")}`);
  }

  if (notes) {
    sections.push(`Notes:\n${notes}`);
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
 * @param {string}          payload.message       – admin message (required)
 * @param {string}          [payload.mode]        – chat | diagnose | change_review
 * @param {string}          [payload.context]     – optional context
 * @param {string|string[]} [payload.logs]        – optional logs
 * @param {string[]}        [payload.changedFiles]– optional changed files
 * @param {string}          [payload.notes]       – optional notes
 * @returns {Promise<Object>} { success, mode, model, result }
 */
async function runAdminDeepseekChat(payload = {}) {
  if (!isDeepSeekConfigured()) {
    throw new Error("DeepSeek is not configured – cannot run Admin Console chat");
  }

  // ── normalise inputs ─────────────────────────
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
      error: "message is required – please provide a non-empty admin message.",
    };
  }

  // ── build prompts ────────────────────────────
  const modePrompt = MODE_PROMPTS[mode] || MODE_PROMPTS.chat;
  const systemPrompt = `${modePrompt}\n\n${HQS_SYSTEM_CONTEXT}`;
  const userPrompt = buildUserPrompt({ message, context, logs, changedFiles, notes });

  // ── call DeepSeek ────────────────────────────
  const modelName = resolveModel("fast");

  const completion = await createDeepSeekChatCompletion({
    tier: "fast",
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
    rawLength: rawContent.length,
  });

  // ── parse & normalise ────────────────────────
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
