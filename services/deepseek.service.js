"use strict";

const OpenAI = require("openai");

let client = null;

function getDeepSeekClient() {
  if (client) return client;

  const apiKey = process.env.DEEPSEEK_API_KEY;
  const baseURL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is missing");
  }

  client = new OpenAI({
    apiKey,
    baseURL,
  });

  return client;
}

async function createDeepSeekChatCompletion({
  messages,
  model,
  temperature = 0.2,
  responseFormat = null,
}) {
  const openai = getDeepSeekClient();

  const payload = {
    model: model || process.env.DEEPSEEK_MODEL || "deepseek-reasoner",
    messages,
    temperature,
  };

  if (responseFormat) {
    payload.response_format = responseFormat;
  }

  const completion = await openai.chat.completions.create(payload);
  return completion;
}

async function runDeepSeekJsonAnalysis({ systemPrompt, userPrompt, model }) {
  const completion = await createDeepSeekChatCompletion({
    model,
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
  createDeepSeekChatCompletion,
  runDeepSeekJsonAnalysis,
};
