"use strict";

/**
 * geminiArchitectFallback.test.js
 *
 * Unit tests for the per-request primary/fallback model logic in
 * geminiArchitect.service.js – specifically for the runGeminiChat function.
 *
 * Scenarios covered:
 *  1. Primary model succeeds → no fallback used
 *  2. Primary 503/overloaded → fallback model used
 *  3. Primary 404/model-not-found → direct fallback (no retry on primary)
 *  4. Fallback model also fails → error returned, fallbackModelUsed=true
 *  5. 429 rate-limit → no fallback, rate_limit error returned
 *  6. 401 auth error → no fallback, auth error returned
 *  7. 403 permission error → no fallback, permission error returned
 *  8. process.env.GEMINI_MODEL overrides primary model name
 *  9. Multi-turn history is preserved on both primary and fallback calls
 * 10. GEMINI_NOT_CONFIGURED returns metadata fields
 * 11. NO_INPUT returns metadata fields
 * 12. GEMINI_PRIMARY_MODEL and GEMINI_FALLBACK_MODEL constants are exported
 */

/* ─────────────────────────────────────────────
   Minimal stub for @google/genai
   ───────────────────────────────────────────── */

let mockGenerateContent;

jest.mock("@google/genai", () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: {
      generateContent: jest.fn((...args) => mockGenerateContent(...args)),
    },
  })),
}));

/* ─────────────────────────────────────────────
   Helpers
   ───────────────────────────────────────────── */

function makeOkResponse(text = "hello") {
  return {
    candidates: [
      {
        content: { parts: [{ text }] },
        finishReason: "STOP",
      },
    ],
    promptFeedback: {},
  };
}

function makeApiError(message, status = null) {
  const err = new Error(message);
  if (status) err.status = status;
  return err;
}

/* ─────────────────────────────────────────────
   Load module under test after mocks are set up
   ───────────────────────────────────────────── */

let runGeminiChat;
let GEMINI_PRIMARY_MODEL;
let GEMINI_FALLBACK_MODEL;

beforeAll(() => {
  process.env.GEMINI_API_KEY = "test-key";
  delete process.env.GEMINI_MODEL;

  // Import after env vars and mocks are in place
  ({
    runGeminiChat,
    GEMINI_PRIMARY_MODEL,
    GEMINI_FALLBACK_MODEL,
  } = require("../services/geminiArchitect.service"));
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GEMINI_MODEL;
  mockGenerateContent = jest.fn().mockResolvedValue(makeOkResponse("test-response"));
});

afterAll(() => {
  delete process.env.GEMINI_API_KEY;
});

/* ═══════════════════════════════════════════════════════════
   1. Constants exported correctly
   ═══════════════════════════════════════════════════════════ */

describe("Constants", () => {
  test("GEMINI_PRIMARY_MODEL is gemini-2.5-flash", () => {
    expect(GEMINI_PRIMARY_MODEL).toBe("gemini-2.5-flash");
  });

  test("GEMINI_FALLBACK_MODEL is gemini-1.5-flash", () => {
    expect(GEMINI_FALLBACK_MODEL).toBe("gemini-1.5-flash");
  });
});

/* ═══════════════════════════════════════════════════════════
   2. Happy path – primary succeeds
   ═══════════════════════════════════════════════════════════ */

describe("Primary model success", () => {
  test("returns success with primaryModel, fallbackModelUsed=false, finalModelUsed=primary", async () => {
    mockGenerateContent = jest.fn().mockResolvedValue(makeOkResponse("OK"));

    const result = await runGeminiChat({
      systemPrompt: "sys",
      userMessage: "hello",
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe("OK");
    expect(result.primaryModel).toBe("gemini-2.5-flash");
    expect(result.fallbackModelUsed).toBe(false);
    expect(result.finalModelUsed).toBe("gemini-2.5-flash");
  });

  test("generateContent called with primary model name", async () => {
    mockGenerateContent = jest.fn().mockResolvedValue(makeOkResponse("OK"));

    await runGeminiChat({ systemPrompt: "sys", userMessage: "hi" });

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(mockGenerateContent.mock.calls[0][0].model).toBe("gemini-2.5-flash");
  });
});

/* ═══════════════════════════════════════════════════════════
   3. 503 / overloaded → retry primary, then fallback
   ═══════════════════════════════════════════════════════════ */

describe("503 overloaded → fallback", () => {
  test("falls back to gemini-1.5-flash after primary 503", async () => {
    const overloadErr = makeApiError("service overloaded", 503);
    mockGenerateContent = jest
      .fn()
      // All primary attempts fail (primary + up to GEMINI_MAX_RETRIES retries)
      .mockRejectedValueOnce(overloadErr)
      .mockRejectedValueOnce(overloadErr)
      .mockRejectedValueOnce(overloadErr)
      // Fallback call succeeds
      .mockResolvedValueOnce(makeOkResponse("fallback-ok"));

    const result = await runGeminiChat({
      systemPrompt: "sys",
      userMessage: "hi",
      timeoutMs: 5000,
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe("fallback-ok");
    expect(result.primaryModel).toBe("gemini-2.5-flash");
    expect(result.fallbackModelUsed).toBe(true);
    expect(result.finalModelUsed).toBe("gemini-1.5-flash");

    // Last call must be for the fallback model
    const lastCall = mockGenerateContent.mock.calls.at(-1)[0];
    expect(lastCall.model).toBe("gemini-1.5-flash");
  });

  test("'overloaded' keyword in message triggers fallback", async () => {
    const overloadErr = makeApiError("Model is currently overloaded");
    mockGenerateContent = jest
      .fn()
      .mockRejectedValueOnce(overloadErr)
      .mockRejectedValueOnce(overloadErr)
      .mockRejectedValueOnce(overloadErr)
      .mockResolvedValueOnce(makeOkResponse("ok"));

    const result = await runGeminiChat({ systemPrompt: "s", userMessage: "u", timeoutMs: 5000 });
    expect(result.fallbackModelUsed).toBe(true);
    expect(result.finalModelUsed).toBe("gemini-1.5-flash");
  });
});

/* ═══════════════════════════════════════════════════════════
   4. 404 / model-not-found → direct fallback (no retry on primary)
   ═══════════════════════════════════════════════════════════ */

describe("404 model-not-found → direct fallback", () => {
  test("falls back immediately on 404 without retrying primary", async () => {
    const notFoundErr = makeApiError("model not found", 404);
    mockGenerateContent = jest
      .fn()
      .mockRejectedValueOnce(notFoundErr)       // primary fails immediately
      .mockResolvedValueOnce(makeOkResponse("fb")); // fallback succeeds

    const result = await runGeminiChat({ systemPrompt: "s", userMessage: "u", timeoutMs: 5000 });

    expect(result.success).toBe(true);
    expect(result.fallbackModelUsed).toBe(true);
    expect(result.finalModelUsed).toBe("gemini-1.5-flash");

    // Primary called exactly once, then fallback once
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    expect(mockGenerateContent.mock.calls[0][0].model).toBe("gemini-2.5-flash");
    expect(mockGenerateContent.mock.calls[1][0].model).toBe("gemini-1.5-flash");
  });

  test("'not supported' message triggers fallback", async () => {
    const err = makeApiError("Model not supported for this operation");
    mockGenerateContent = jest
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(makeOkResponse("ok"));

    const result = await runGeminiChat({ systemPrompt: "s", userMessage: "u", timeoutMs: 5000 });
    expect(result.fallbackModelUsed).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════
   5. Both primary and fallback fail
   ═══════════════════════════════════════════════════════════ */

describe("Both models fail", () => {
  test("returns error with fallbackModelUsed=true when fallback also fails", async () => {
    const overloadErr = makeApiError("service overloaded", 503);
    const fallbackErr = makeApiError("fallback also unavailable", 503);
    mockGenerateContent = jest
      .fn()
      .mockRejectedValueOnce(overloadErr)
      .mockRejectedValueOnce(overloadErr)
      .mockRejectedValueOnce(overloadErr)
      .mockRejectedValueOnce(fallbackErr); // fallback also fails

    const result = await runGeminiChat({ systemPrompt: "s", userMessage: "u", timeoutMs: 5000 });

    expect(result.success).toBe(false);
    expect(result.primaryModel).toBe("gemini-2.5-flash");
    expect(result.finalModelUsed).toBe("gemini-1.5-flash");
  });
});

/* ═══════════════════════════════════════════════════════════
   6. 429 rate-limit → retry only, no fallback
   ═══════════════════════════════════════════════════════════ */

describe("429 rate-limit – no fallback", () => {
  test("returns rate_limit error without touching fallback model", async () => {
    const rateLimitErr = makeApiError("too many requests", 429);
    mockGenerateContent = jest.fn().mockRejectedValue(rateLimitErr);

    const result = await runGeminiChat({ systemPrompt: "s", userMessage: "u", timeoutMs: 5000 });

    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe("rate_limit");
    expect(result.fallbackModelUsed).toBe(false);
    expect(result.finalModelUsed).toBe("gemini-2.5-flash");

    // All calls are to the primary model only
    for (const call of mockGenerateContent.mock.calls) {
      expect(call[0].model).toBe("gemini-2.5-flash");
    }
  });

  test("quota exceeded message → rate_limit, no fallback", async () => {
    const quotaErr = makeApiError("quota exceeded");
    mockGenerateContent = jest.fn().mockRejectedValue(quotaErr);

    const result = await runGeminiChat({ systemPrompt: "s", userMessage: "u", timeoutMs: 5000 });
    expect(result.errorCategory).toBe("rate_limit");
    expect(result.fallbackModelUsed).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════
   7. 401 auth error → no fallback
   ═══════════════════════════════════════════════════════════ */

describe("401 auth error – no fallback", () => {
  test("returns auth error without fallback", async () => {
    const authErr = makeApiError("Unauthorized – invalid API key", 401);
    mockGenerateContent = jest.fn().mockRejectedValueOnce(authErr);

    const result = await runGeminiChat({ systemPrompt: "s", userMessage: "u", timeoutMs: 5000 });

    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe("auth");
    expect(result.fallbackModelUsed).toBe(false);
    expect(result.finalModelUsed).toBe("gemini-2.5-flash");
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });
});

/* ═══════════════════════════════════════════════════════════
   8. 403 permission error → no fallback
   ═══════════════════════════════════════════════════════════ */

describe("403 permission error – no fallback", () => {
  test("returns permission error without fallback", async () => {
    const permErr = makeApiError("Permission denied", 403);
    mockGenerateContent = jest.fn().mockRejectedValueOnce(permErr);

    const result = await runGeminiChat({ systemPrompt: "s", userMessage: "u", timeoutMs: 5000 });

    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe("permission");
    expect(result.fallbackModelUsed).toBe(false);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });
});

/* ═══════════════════════════════════════════════════════════
   9. process.env.GEMINI_MODEL overrides primary model name
   ═══════════════════════════════════════════════════════════ */

describe("process.env.GEMINI_MODEL override", () => {
  test("uses env-var model as primary when set", async () => {
    process.env.GEMINI_MODEL = "gemini-custom-preview";
    mockGenerateContent = jest.fn().mockResolvedValue(makeOkResponse("ok"));

    const result = await runGeminiChat({ systemPrompt: "s", userMessage: "u" });

    expect(result.primaryModel).toBe("gemini-custom-preview");
    expect(result.finalModelUsed).toBe("gemini-custom-preview");
    expect(mockGenerateContent.mock.calls[0][0].model).toBe("gemini-custom-preview");

    delete process.env.GEMINI_MODEL;
  });
});

/* ═══════════════════════════════════════════════════════════
   10. Multi-turn history preserved on both primary and fallback
   ═══════════════════════════════════════════════════════════ */

describe("Multi-turn history", () => {
  const history = [
    { role: "user",  parts: [{ text: "first turn" }] },
    { role: "model", parts: [{ text: "first reply" }] },
  ];

  test("history is passed to primary model", async () => {
    mockGenerateContent = jest.fn().mockResolvedValue(makeOkResponse("ok"));

    await runGeminiChat({ systemPrompt: "s", userMessage: "second", history });

    const { contents } = mockGenerateContent.mock.calls[0][0];
    expect(contents.length).toBe(3); // 2 history + 1 user turn
    expect(contents[0]).toEqual(history[0]);
    expect(contents[1]).toEqual(history[1]);
    expect(contents[2]).toEqual({ role: "user", parts: [{ text: "second" }] });
  });

  test("history is preserved when fallback model is used", async () => {
    const notFoundErr = makeApiError("model not found", 404);
    mockGenerateContent = jest
      .fn()
      .mockRejectedValueOnce(notFoundErr)
      .mockResolvedValueOnce(makeOkResponse("fallback"));

    await runGeminiChat({ systemPrompt: "s", userMessage: "second", history, timeoutMs: 5000 });

    // Fallback call (second call) must also receive full history
    const fallbackContents = mockGenerateContent.mock.calls[1][0].contents;
    expect(fallbackContents.length).toBe(3);
    expect(fallbackContents[0]).toEqual(history[0]);
  });
});

/* ═══════════════════════════════════════════════════════════
   11. Config / input guard paths include metadata fields
   ═══════════════════════════════════════════════════════════ */

describe("Guard paths return metadata fields", () => {
  test("GEMINI_NOT_CONFIGURED returns primaryModel / fallbackModelUsed / finalModelUsed", async () => {
    const origKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    // Re-require to pick up missing key
    jest.resetModules();
    const { runGeminiChat: freshRun } = require("../services/geminiArchitect.service");
    const result = await freshRun({ systemPrompt: "s", userMessage: "u" });

    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe("config");
    expect(result).toHaveProperty("primaryModel");
    expect(result).toHaveProperty("fallbackModelUsed");
    expect(result).toHaveProperty("finalModelUsed");

    process.env.GEMINI_API_KEY = origKey;
    jest.resetModules();
  });

  test("NO_INPUT returns primaryModel / fallbackModelUsed / finalModelUsed", async () => {
    const result = await runGeminiChat({ systemPrompt: "s", userMessage: "   " });

    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe("input");
    expect(result).toHaveProperty("primaryModel");
    expect(result).toHaveProperty("fallbackModelUsed");
    expect(result).toHaveProperty("finalModelUsed");
  });
});
