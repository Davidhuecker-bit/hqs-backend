"use strict";

const OpenAI = require("openai");

let client = null;

/**
 * Returns a lazily-initialised OpenAI-compatible client configured for the
 * DeepSeek API.  The client is cached for the lifetime of the process.
 *
 * ENV:
 *   DEEPSEEK_API_KEY   – required
 *   DEEPSEEK_BASE_URL  – optional (default https://api.deepseek.com)
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
 *   explicit > env > fallback default
 *
 * @param {"default"|"fast"} [tier] – optional speed tier
 * @param {string}           [explicit] – caller-supplied model override
 */
function resolveModel(tier, explicit) {
  if (explicit) return explicit;
  if (tier === "fast") {
    return process.env.DEEPSEEK_FAST_MODEL || "deepseek-chat";
  }
  return process.env.DEEPSEEK_MODEL || "deepseek-reasoner";
}

/**
 * Create a chat completion via the DeepSeek API.
 *
 * @param {Object}   opts
 * @param {Array}    opts.messages      – OpenAI-style message array
 * @param {string}   [opts.model]       – model override
 * @param {"default"|"fast"} [opts.tier] – speed tier (ignored when model is set)
 * @param {number}   [opts.temperature] – sampling temperature (default 0.2)
 * @param {Object}   [opts.responseFormat] – optional response_format object
 */
async function createDeepSeekChatCompletion({
  messages,
  model,
  tier,
  temperature = 0.2,
  responseFormat = null,
}) {
  const openai = getDeepSeekClient();

  const payload = {
    model: resolveModel(tier, model),
    messages,
    temperature,
  };

  if (responseFormat) {
    payload.response_format = responseFormat;
  }

  const completion = await openai.chat.completions.create(payload);
  return completion;
}

/**
 * Convenience wrapper: send a system + user prompt and parse the response as
 * JSON.  Returns the parsed object on success, or an error descriptor when
 * parsing fails (never throws for parse errors).
 */
async function runDeepSeekJsonAnalysis({ systemPrompt, userPrompt, model, tier }) {
  const completion = await createDeepSeekChatCompletion({
    model,
    tier,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
    responseFormat: { type: "json_object" },
  });

  const content = completion?.choices?.[0]?.message?.content || "{}";

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
  createDeepSeekChatCompletion,
  runDeepSeekJsonAnalysis,
};
