"use strict";

const OpenAI = require("openai");

let client = null;

const logger = require("../utils/logger");

/**
 * Returns a lazily-initialised OpenAI-compatible client configured for the
 * DeepSeek API. The client is cached for the lifetime of the process.
 *
 * ENV:
 *   DEEPSEEK_API_KEY     – required
 *   DEEPSEEK_BASE_URL    – optional (default https://api.deepseek.com)
 *   DEEPSEEK_TIMEOUT_MS  – optional per-request timeout override
 */
function getDeepSeekClient() {
  if (client) return client;

  const apiKey = process.env.DEEPSEEK_API_KEY;
  const baseURL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

  if (!apiKey) {
    throw new Error(
      "DEEPSEEK_API_KEY is not set – DeepSeek integration unavailable"
    );
  }

  client = new OpenAI({ apiKey, baseURL });
  return client;
}

/**
 * Returns true when the DeepSeek service can be used (API key present).
 */
function isDeepSeekConfigured() {
  return Boolean(process.env.DEEPSEEK_API_KEY);
}

/**
 * Resolve the model identifier.
 * explicit > env > fallback default
 *
 * Tier semantics:
 * - "fast"    → DEEPSEEK_FAST_MODEL   (default: deepseek-chat)     – quick UI/console flows
 * - "default" → DEEPSEEK_MODEL        (default: deepseek-reasoner) – deep review/logic/guard flows
 *
 * @param {"default"|"fast"} [tier]
 * @param {string} [explicit]
 * @returns {string}
 */
function resolveModel(tier, explicit) {
  if (explicit) return explicit;

  if (tier === "fast") {
    return process.env.DEEPSEEK_FAST_MODEL || "deepseek-chat";
  }

  return process.env.DEEPSEEK_MODEL || "deepseek-reasoner";
}

/**
 * Pre-resolved model names for use across services.
 * Evaluated once at module load from environment variables.
 *
 * DEEPSEEK_FAST_MODEL  – quick UI/console paths   (default: deepseek-chat)
 * DEEPSEEK_DEEP_MODEL  – deep review/logic/guard  (default: deepseek-reasoner)
 */
const DEEPSEEK_FAST_MODEL = process.env.DEEPSEEK_FAST_MODEL || "deepseek-chat";
const DEEPSEEK_DEEP_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-reasoner";

/**
 * Parse timeout from env or fallback.
 *
 * @param {number|undefined|null} timeoutMs
 * @returns {number}
 */
function resolveTimeoutMs(timeoutMs) {
  const raw = timeoutMs ?? process.env.DEEPSEEK_TIMEOUT_MS;
  const num = Number(raw);
  if (Number.isFinite(num) && num >= 1000) return Math.floor(num);
  return 20000;
}

/**
 * Returns a promise that rejects after timeoutMs.
 *
 * @param {number} timeoutMs
 * @param {string} modelName
 * @returns {Promise<never>}
 */
function createTimeoutPromise(timeoutMs, modelName) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `DeepSeek request timed out after ${timeoutMs}ms (model: ${modelName})`
        )
      );
    }, timeoutMs);

    // Do not keep the event loop alive just for the timeout
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });
}

/**
 * Basic validation for message array.
 *
 * @param {Array} messages
 */
function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("DeepSeek messages must be a non-empty array");
  }

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      throw new Error("DeepSeek message entries must be objects");
    }
    if (!msg.role || typeof msg.role !== "string") {
      throw new Error("DeepSeek message is missing a valid role");
    }
    if (msg.content == null || typeof msg.content !== "string") {
      throw new Error("DeepSeek message is missing valid string content");
    }
  }
}

/**
 * Create a chat completion via the DeepSeek API.
 *
 * @param {Object} opts
 * @param {Array} opts.messages
 * @param {string} [opts.model]
 * @param {"default"|"fast"} [opts.tier]
 * @param {number} [opts.temperature]
 * @param {Object|null} [opts.responseFormat]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<Object>}
 */
async function createDeepSeekChatCompletion({
  messages,
  model,
  tier,
  temperature = 0.2,
  responseFormat = null,
  timeoutMs,
}) {
  const openai = getDeepSeekClient();
  validateMessages(messages);

  const resolvedModel = resolveModel(tier, model);
  const resolvedTimeoutMs = resolveTimeoutMs(timeoutMs);

  const payload = {
    model: resolvedModel,
    messages,
    temperature,
  };

  if (responseFormat) {
    payload.response_format = responseFormat;
  }

  try {
    const completion = await Promise.race([
      openai.chat.completions.create(payload),
      createTimeoutPromise(resolvedTimeoutMs, resolvedModel),
    ]);

    return completion;
  } catch (error) {
    const wrapped = new Error(
      `DeepSeek completion failed (${resolvedModel}): ${error.message}`
    );
    wrapped.cause = error;
    throw wrapped;
  }
}

/**
 * Extract the text content from a DeepSeek API completion.
 *
 * DeepSeek "reasoner" models (R1 / V3) return two fields:
 *   - `reasoning_content` – the internal chain-of-thought (may be present)
 *   - `content`           – the actual answer intended for the user
 *
 * Standard `deepseek-chat` only populates `content`.
 *
 * This helper always returns the final `content` field, falling back to
 * `reasoning_content` when `content` is empty (edge case where the model
 * finished reasoning but produced no final answer).
 *
 * @param {Object|null|undefined} completion – raw API response
 * @returns {string} extracted text (may be empty string)
 */
function extractDeepSeekText(completion) {
  const firstChoice = completion?.choices?.[0];
  if (!firstChoice) {
    logger.warn("[deepseek] extractDeepSeekText – no choices in completion", {
      hasCompletion: Boolean(completion),
      choicesLength: completion?.choices?.length ?? 0,
    });
    return "";
  }

  const message = firstChoice.message;
  if (!message) {
    logger.warn("[deepseek] extractDeepSeekText – no message in first choice");
    return "";
  }

  // Primary: the actual answer
  const content = (message.content || "").trim();
  // Fallback: reasoning_content (DeepSeek reasoner models)
  const reasoning = (message.reasoning_content || "").trim();

  if (content) return content;

  if (reasoning) {
    logger.info("[deepseek] extractDeepSeekText – content empty, using reasoning_content as fallback", {
      reasoningLength: reasoning.length,
      finishReason: firstChoice.finish_reason ?? null,
    });
    return reasoning;
  }

  logger.warn("[deepseek] extractDeepSeekText – both content and reasoning_content empty", {
    finishReason: firstChoice.finish_reason ?? null,
    messageKeys: Object.keys(message).join(","),
  });
  return "";
}

/**
 * Convenience wrapper: send a system + user prompt and parse the response as
 * JSON. Returns the parsed object on success, or an error descriptor when
 * parsing fails. API/timeout errors still throw so callers can distinguish
 * transport failures from parse failures.
 *
 * @param {Object} params
 * @param {string} params.systemPrompt
 * @param {string} params.userPrompt
 * @param {string} [params.model]
 * @param {"default"|"fast"} [params.tier]
 * @param {number} [params.timeoutMs]
 * @returns {Promise<Object>}
 */
async function runDeepSeekJsonAnalysis({
  systemPrompt,
  userPrompt,
  model,
  tier = "fast",
  timeoutMs,
}) {
  const completion = await createDeepSeekChatCompletion({
    model,
    tier,
    timeoutMs,
    messages: [
      { role: "system", content: String(systemPrompt || "") },
      { role: "user", content: String(userPrompt || "") },
    ],
    temperature: 0.1,
    responseFormat: { type: "json_object" },
  });

  const content = extractDeepSeekText(completion);

  if (!content) {
    logger.warn("[deepseek] runDeepSeekJsonAnalysis – empty response from API", {
      tier,
      model: model || resolveModel(tier),
    });
    return {
      parseError: true,
      raw: "",
      message: "DeepSeek returned an empty response",
    };
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    return {
      parseError: true,
      raw: content,
      message: error.message,
    };
  }
}

module.exports = {
  getDeepSeekClient,
  isDeepSeekConfigured,
  resolveModel,
  DEEPSEEK_FAST_MODEL,
  DEEPSEEK_DEEP_MODEL,
  createDeepSeekChatCompletion,
  runDeepSeekJsonAnalysis,
  extractDeepSeekText,
};
