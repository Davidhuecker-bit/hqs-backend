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
    expect(result.fallbackModelUsed).toBe(true);
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

/* ═══════════════════════════════════════════════════════════
   12. GEMINI_AUTH_MODE explicit switch
   ═══════════════════════════════════════════════════════════ */

describe("GEMINI_AUTH_MODE explicit switch", () => {
  let getAuthMode;

  beforeAll(() => {
    jest.resetModules();
    ({ getAuthMode } = require("../services/geminiArchitect.service"));
  });

  afterEach(() => {
    delete process.env.GEMINI_AUTH_MODE;
  });

  test("GEMINI_AUTH_MODE=vertex_ai forces vertex_ai mode regardless of env", () => {
    process.env.GEMINI_AUTH_MODE   = "vertex_ai";
    process.env.GOOGLE_CLOUD_PROJECT = "test-project";
    const mode = getAuthMode();
    expect(mode).toBe("vertex_ai");
    delete process.env.GOOGLE_CLOUD_PROJECT;
  });

  test("GEMINI_AUTH_MODE=gemini_api forces gemini_api mode", () => {
    process.env.GEMINI_AUTH_MODE = "gemini_api";
    process.env.GEMINI_API_KEY   = "test-key";
    const mode = getAuthMode();
    expect(mode).toBe("gemini_api");
  });

  test("GEMINI_AUTH_MODE=vertex_ai takes priority over GEMINI_API_KEY", () => {
    process.env.GEMINI_AUTH_MODE = "vertex_ai";
    process.env.GOOGLE_CLOUD_PROJECT = "my-project";
    process.env.GEMINI_API_KEY   = "some-key";
    const mode = getAuthMode();
    expect(mode).toBe("vertex_ai");
    delete process.env.GOOGLE_CLOUD_PROJECT;
  });

  test("auto-detect falls back to vertex_ai when GOOGLE_CLOUD_PROJECT is set", () => {
    delete process.env.GEMINI_AUTH_MODE;
    process.env.GOOGLE_CLOUD_PROJECT = "auto-project";
    const mode = getAuthMode();
    expect(mode).toBe("vertex_ai");
    delete process.env.GOOGLE_CLOUD_PROJECT;
  });
});

/* ═══════════════════════════════════════════════════════════
   13. vertexFlagEnabled and fallbackUsed fields in responses
   ═══════════════════════════════════════════════════════════ */

describe("vertexFlagEnabled and fallbackUsed fields", () => {
  test("gemini_api mode: vertexFlagEnabled=false, fallbackUsed=false on success", async () => {
    mockGenerateContent = jest.fn().mockResolvedValue(makeOkResponse("OK"));

    const result = await runGeminiChat({ systemPrompt: "s", userMessage: "u" });

    expect(result.success).toBe(true);
    expect(result.vertexFlagEnabled).toBe(false);
    expect(result.fallbackUsed).toBe(false);
    expect(result.authModeUsed).toBe("gemini_api");
  });

  test("response always contains fallbackUsed field", async () => {
    mockGenerateContent = jest.fn().mockResolvedValue(makeOkResponse("OK"));
    const result = await runGeminiChat({ systemPrompt: "s", userMessage: "u" });
    expect(result).toHaveProperty("fallbackUsed");
  });

  test("error response contains fallbackUsed=false when no provider fallback", async () => {
    const authErr = makeApiError("Unauthorized", 401);
    mockGenerateContent = jest.fn().mockRejectedValue(authErr);

    const result = await runGeminiChat({ systemPrompt: "s", userMessage: "u", timeoutMs: 5000 });
    expect(result.success).toBe(false);
    expect(result.fallbackUsed).toBe(false);
    expect(result).toHaveProperty("vertexFlagEnabled");
  });
});

/* ═══════════════════════════════════════════════════════════
   14. Provider-level fallback: vertex_ai → gemini_api
   ═══════════════════════════════════════════════════════════ */

describe("Provider-level fallback (vertex_ai → gemini_api)", () => {
  let runGeminiChatFresh;

  // Each test in this group sets up vertex_ai mode with ENABLE_GEMINI_FALLBACK=true
  beforeEach(() => {
    jest.resetModules();
    process.env.GEMINI_AUTH_MODE      = "vertex_ai";
    process.env.GOOGLE_CLOUD_PROJECT  = "my-project";
    process.env.ENABLE_GEMINI_FALLBACK = "true";
    process.env.GEMINI_API_KEY        = "fallback-key";
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({
      type: "service_account",
      project_id: "my-project",
      client_email: "test@my-project.iam.gserviceaccount.com",
    });

    // Re-mock after resetModules
    jest.mock("@google/genai", () => ({
      GoogleGenAI: jest.fn().mockImplementation(() => ({
        models: {
          generateContent: jest.fn((...args) => mockGenerateContent(...args)),
        },
      })),
    }));

    ({ runGeminiChat: runGeminiChatFresh } = require("../services/geminiArchitect.service"));
  });

  afterEach(() => {
    delete process.env.GEMINI_AUTH_MODE;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.ENABLE_GEMINI_FALLBACK;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    jest.resetModules();
    // Restore original mock
    ({ GEMINI_PRIMARY_MODEL, GEMINI_FALLBACK_MODEL, runGeminiChat } =
      require("../services/geminiArchitect.service"));
  });

  test("vertex 503 → provider fallback → gemini_api success: fallbackUsed=true, authModeUsed=gemini_api", async () => {
    const vertexErr = makeApiError("service overloaded", 503);
    mockGenerateContent = jest
      .fn()
      // All vertex calls fail (primary + retries)
      .mockRejectedValueOnce(vertexErr)
      .mockRejectedValueOnce(vertexErr)
      .mockRejectedValueOnce(vertexErr)
      // vertex fallback model also fails
      .mockRejectedValueOnce(vertexErr)
      // gemini_api provider fallback succeeds
      .mockResolvedValueOnce(makeOkResponse("gemini-api-ok"));

    const result = await runGeminiChatFresh({ systemPrompt: "s", userMessage: "u", timeoutMs: 5000 });

    expect(result.success).toBe(true);
    expect(result.text).toBe("gemini-api-ok");
    expect(result.fallbackUsed).toBe(true);
    expect(result.authModeUsed).toBe("gemini_api");
    expect(result.authModeRequested).toBe("vertex_ai");
    expect(result.vertexFlagEnabled).toBe(false); // gemini_api was actually used
  });

  test("vertex 404 → provider fallback → gemini_api success: fallbackUsed=true", async () => {
    const notFoundErr = makeApiError("model not found", 404);
    mockGenerateContent = jest
      .fn()
      .mockRejectedValueOnce(notFoundErr) // primary vertex fails
      // model fallback (gemini-1.5-flash via vertex) also fails with 404
      .mockRejectedValueOnce(notFoundErr)
      // gemini_api provider fallback succeeds
      .mockResolvedValueOnce(makeOkResponse("ok-from-gemini-api"));

    const result = await runGeminiChatFresh({ systemPrompt: "s", userMessage: "u", timeoutMs: 5000 });

    expect(result.success).toBe(true);
    expect(result.fallbackUsed).toBe(true);
    expect(result.authModeUsed).toBe("gemini_api");
  });

  test("vertex 401 auth error: NO provider fallback even with ENABLE_GEMINI_FALLBACK=true", async () => {
    const authErr = makeApiError("unauthorized", 401);
    mockGenerateContent = jest.fn().mockRejectedValue(authErr);

    const result = await runGeminiChatFresh({ systemPrompt: "s", userMessage: "u", timeoutMs: 5000 });

    expect(result.success).toBe(false);
    expect(result.fallbackUsed).toBe(false);
    expect(result.errorCategory).toBe("auth");
  });

  test("vertex 400 bad request: NO provider fallback", async () => {
    const badReqErr = makeApiError("invalid argument: bad request", 400);
    mockGenerateContent = jest.fn().mockRejectedValue(badReqErr);

    const result = await runGeminiChatFresh({ systemPrompt: "s", userMessage: "u", timeoutMs: 5000 });

    expect(result.success).toBe(false);
    expect(result.fallbackUsed).toBe(false);
  });

  test("ENABLE_GEMINI_FALLBACK not set: no provider fallback on 503", async () => {
    process.env.ENABLE_GEMINI_FALLBACK = "false";
    const vertexErr = makeApiError("service overloaded", 503);
    mockGenerateContent = jest
      .fn()
      .mockRejectedValueOnce(vertexErr)
      .mockRejectedValueOnce(vertexErr)
      .mockRejectedValueOnce(vertexErr)
      .mockRejectedValueOnce(vertexErr);

    const result = await runGeminiChatFresh({ systemPrompt: "s", userMessage: "u", timeoutMs: 5000 });

    expect(result.success).toBe(false);
    expect(result.fallbackUsed).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════
   15. Vertex AI credential guard
   ═══════════════════════════════════════════════════════════ */

describe("Vertex AI credential guard (GOOGLE_APPLICATION_CREDENTIALS_JSON)", () => {
  let runGeminiChatFresh;
  let getAuthDiagnosticsFresh;

  beforeEach(() => {
    jest.resetModules();
    process.env.GEMINI_AUTH_MODE     = "vertex_ai";
    process.env.GOOGLE_CLOUD_PROJECT = "my-project";

    jest.mock("@google/genai", () => ({
      GoogleGenAI: jest.fn().mockImplementation(() => ({
        models: {
          generateContent: jest.fn((...args) => mockGenerateContent(...args)),
        },
      })),
    }));

    ({
      runGeminiChat: runGeminiChatFresh,
      getAuthDiagnostics: getAuthDiagnosticsFresh,
    } = require("../services/geminiArchitect.service"));
  });

  afterEach(() => {
    delete process.env.GEMINI_AUTH_MODE;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    jest.resetModules();
    ({ runGeminiChat } = require("../services/geminiArchitect.service"));
  });

  test("missing GOOGLE_APPLICATION_CREDENTIALS_JSON → errorCategory=vertex_credentials_missing", async () => {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

    const result = await runGeminiChatFresh({ systemPrompt: "s", userMessage: "u" });

    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe("vertex_credentials_missing");
    expect(result.vertexCredentialsPresent).toBe(false);
  });

  test("invalid JSON in GOOGLE_APPLICATION_CREDENTIALS_JSON → errorCategory=vertex_credentials_invalid", async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = "not-valid-json{{{";

    const result = await runGeminiChatFresh({ systemPrompt: "s", userMessage: "u" });

    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe("vertex_credentials_invalid");
    expect(result.vertexCredentialsPresent).toBe(false);
  });

  test("valid JSON that is not an object (array) → errorCategory=vertex_credentials_invalid", async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify(["not", "an", "object"]);

    const result = await runGeminiChatFresh({ systemPrompt: "s", userMessage: "u" });

    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe("vertex_credentials_invalid");
  });

  test("valid JSON object missing required service-account fields → errorCategory=vertex_credentials_invalid", async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({ someKey: "someValue" });

    const result = await runGeminiChatFresh({ systemPrompt: "s", userMessage: "u" });

    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe("vertex_credentials_invalid");
  });

  test("valid GOOGLE_APPLICATION_CREDENTIALS_JSON → proceeds to API call", async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({
      type: "service_account",
      project_id: "my-project",
      client_email: "test@my-project.iam.gserviceaccount.com",
    });
    mockGenerateContent = jest.fn().mockResolvedValue(makeOkResponse("vertex-ok"));

    const result = await runGeminiChatFresh({ systemPrompt: "s", userMessage: "u" });

    expect(result.success).toBe(true);
    expect(result.text).toBe("vertex-ok");
    expect(result.vertexCredentialsPresent).toBe(true);
    expect(result.authModeUsed).toBe("vertex_ai");
  });

  test("getAuthDiagnostics: vertexCredentialsPresent=false when var is missing", () => {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

    const diag = getAuthDiagnosticsFresh();

    expect(diag.vertexCredentialsPresent).toBe(false);
  });

  test("getAuthDiagnostics: vertexCredentialsPresent=true when var is valid JSON object", () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({
      type: "service_account",
      client_email: "svc@project.iam.gserviceaccount.com",
    });

    const diag = getAuthDiagnosticsFresh();

    expect(diag.vertexCredentialsPresent).toBe(true);
  });
});
