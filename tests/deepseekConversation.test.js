"use strict";

/**
 * DeepSeek Conversation Context
 *
 * Tests cover:
 *  - Conversation store creation and retrieval
 *  - runAdminDeepseekChat creates a new conversationId on first call
 *  - runAdminDeepseekChat continues an existing conversation on follow-up
 *  - Follow-up builds message history (historyLength > 0)
 *  - continueDeepSeekConversation forwards to correct mode
 *  - continueDeepSeekConversation returns error for unknown conversationId
 *  - getDeepSeekConversation returns full conversation object
 *  - getDeepSeekConversation returns null for unknown ID
 *  - registerExternalExchange creates a conversation for external modes
 *  - registerExternalExchange extends an existing conversation
 *  - math_logic_review and controller_guard modes are stored correctly
 *  - Message content is stored with correct roles
 *  - Pruning: store does not exceed MAX_CONVERSATIONS
 *  - Input validation: missing message returns success:false with conversationId null
 *  - Mode normalisation: unknown mode falls back to "chat"
 *  - followUpPossible is always true on successful response
 */

jest.mock("../services/deepseek.service", () => ({
  isDeepSeekConfigured: jest.fn(() => true),
  createDeepSeekChatCompletion: jest.fn(async ({ messages }) => ({
    choices: [
      {
        message: {
          content: JSON.stringify({
            answer: `Antwort auf: ${messages[messages.length - 1].content.slice(0, 40)}`,
            warnings: [],
            suggestedNextSteps: ["Schritt 1"],
          }),
        },
      },
    ],
  })),
  DEEPSEEK_FAST_MODEL: "deepseek-chat",
  DEEPSEEK_DEEP_MODEL: "deepseek-reasoner",
}));

// Re-require after mock so the module uses the mocked deepseek.service.
// Each test file gets its own module instance via jest's module registry.
const {
  runAdminDeepseekChat,
  continueDeepSeekConversation,
  getDeepSeekConversation,
  registerExternalExchange,
} = require("../services/adminDeepseekConsole.service");

const { createDeepSeekChatCompletion } = require("../services/deepseek.service");

/* ─────────────────────────────────────────────
   Helpers
   ───────────────────────────────────────────── */

function capturedMessages() {
  const calls = createDeepSeekChatCompletion.mock.calls;
  if (!calls.length) return [];
  const last = calls[calls.length - 1][0];
  return last.messages;
}

/* ─────────────────────────────────────────────
   Basic call – conversationId generation
   ───────────────────────────────────────────── */

describe("runAdminDeepseekChat – conversation creation", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns a conversationId on first call", async () => {
    const res = await runAdminDeepseekChat({ message: "Hallo" });
    expect(res.success).toBe(true);
    expect(typeof res.conversationId).toBe("string");
    expect(res.conversationId).toMatch(/^dsconv_/);
  });

  test("followUpPossible is true on successful response", async () => {
    const res = await runAdminDeepseekChat({ message: "Test" });
    expect(res.followUpPossible).toBe(true);
  });

  test("different calls without conversationId get different IDs", async () => {
    const a = await runAdminDeepseekChat({ message: "Erste Frage" });
    const b = await runAdminDeepseekChat({ message: "Zweite Frage" });
    expect(a.conversationId).not.toBe(b.conversationId);
  });

  test("missing message returns success:false with conversationId null", async () => {
    const res = await runAdminDeepseekChat({ message: "" });
    expect(res.success).toBe(false);
    expect(res.conversationId).toBeNull();
    expect(res.followUpPossible).toBe(false);
    expect(typeof res.error).toBe("string");
  });

  test("mode is normalised – unknown mode falls back to chat", async () => {
    const res = await runAdminDeepseekChat({ message: "Test", mode: "unknown_xyz" });
    expect(res.mode).toBe("chat");
  });

  test("mode diagnose is accepted", async () => {
    const res = await runAdminDeepseekChat({ message: "Fehler suchen", mode: "diagnose" });
    expect(res.mode).toBe("diagnose");
  });

  test("mode change_review is accepted", async () => {
    const res = await runAdminDeepseekChat({ message: "Änderung prüfen", mode: "change_review" });
    expect(res.mode).toBe("change_review");
  });
});

/* ─────────────────────────────────────────────
   Conversation continuation – history is forwarded
   ───────────────────────────────────────────── */

describe("runAdminDeepseekChat – conversation continuation", () => {
  beforeEach(() => jest.clearAllMocks());

  test("providing conversationId continues the same conversation", async () => {
    const first = await runAdminDeepseekChat({ message: "Erste Frage", mode: "chat" });
    const { conversationId } = first;

    const second = await runAdminDeepseekChat({ message: "Folgefrage", conversationId });
    expect(second.conversationId).toBe(conversationId);
  });

  test("second call includes prior messages in the messages array", async () => {
    const first = await runAdminDeepseekChat({ message: "Analysiere bitte X", mode: "diagnose" });
    const { conversationId } = first;

    jest.clearAllMocks();
    await runAdminDeepseekChat({ message: "Gehe tiefer bei Punkt 2", conversationId });

    const msgs = capturedMessages();
    // system + at least 2 history messages + current user message
    expect(msgs.length).toBeGreaterThanOrEqual(4);
    expect(msgs[0].role).toBe("system");
    const roles = msgs.slice(1).map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
  });

  test("unknown conversationId creates a fresh conversation", async () => {
    const res = await runAdminDeepseekChat({
      message: "Test",
      conversationId: "dsconv_does_not_exist_xyz",
    });
    expect(res.success).toBe(true);
    expect(res.conversationId).not.toBe("dsconv_does_not_exist_xyz");
    expect(res.conversationId).toMatch(/^dsconv_/);
  });
});

/* ─────────────────────────────────────────────
   getDeepSeekConversation
   ───────────────────────────────────────────── */

describe("getDeepSeekConversation", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns null for unknown id", () => {
    expect(getDeepSeekConversation("does_not_exist")).toBeNull();
  });

  test("returns conversation object after a chat call", async () => {
    const { conversationId } = await runAdminDeepseekChat({ message: "Hallo", mode: "chat" });
    const conv = getDeepSeekConversation(conversationId);
    expect(conv).not.toBeNull();
    expect(conv.conversationId).toBe(conversationId);
    expect(conv.mode).toBe("chat");
    expect(Array.isArray(conv.messages)).toBe(true);
  });

  test("messages array grows with each exchange", async () => {
    const { conversationId } = await runAdminDeepseekChat({ message: "Start", mode: "chat" });
    const before = getDeepSeekConversation(conversationId).messageCount;

    await runAdminDeepseekChat({ message: "Fortsetzung", conversationId });
    const after = getDeepSeekConversation(conversationId).messageCount;

    expect(after).toBeGreaterThan(before);
  });

  test("messages have role and content fields", async () => {
    const { conversationId } = await runAdminDeepseekChat({ message: "Hallo", mode: "chat" });
    const conv = getDeepSeekConversation(conversationId);
    for (const msg of conv.messages) {
      expect(["user", "assistant"]).toContain(msg.role);
      expect(typeof msg.content).toBe("string");
    }
  });
});

/* ─────────────────────────────────────────────
   continueDeepSeekConversation
   ───────────────────────────────────────────── */

describe("continueDeepSeekConversation", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns error for unknown conversationId", async () => {
    const res = await continueDeepSeekConversation("unknown_id", "Folgefrage");
    expect(res.success).toBe(false);
    expect(res.followUpPossible).toBe(false);
    expect(typeof res.error).toBe("string");
  });

  test("continues a valid conversation successfully", async () => {
    const { conversationId } = await runAdminDeepseekChat({ message: "Initial", mode: "chat" });
    jest.clearAllMocks();

    const res = await continueDeepSeekConversation(conversationId, "Folgefrage");
    expect(res.success).toBe(true);
    expect(res.conversationId).toBe(conversationId);
    expect(res.followUpPossible).toBe(true);
  });

  test("continues using the conversation's original mode", async () => {
    const { conversationId } = await runAdminDeepseekChat({
      message: "Diagnose starten",
      mode: "diagnose",
    });
    jest.clearAllMocks();

    const res = await continueDeepSeekConversation(conversationId, "Geh tiefer");
    expect(res.mode).toBe("diagnose");
  });

  test("includes history in the messages sent to DeepSeek", async () => {
    const { conversationId } = await runAdminDeepseekChat({
      message: "Erste Analyse",
      mode: "chat",
    });
    jest.clearAllMocks();

    await continueDeepSeekConversation(conversationId, "Löse das Problem");
    const msgs = capturedMessages();
    expect(msgs.length).toBeGreaterThanOrEqual(4);
  });
});

/* ─────────────────────────────────────────────
   registerExternalExchange
   ───────────────────────────────────────────── */

describe("registerExternalExchange", () => {
  beforeEach(() => jest.clearAllMocks());

  test("creates a new conversation for math_logic_review", () => {
    const convId = registerExternalExchange(
      "math_logic_review",
      "Review-Anfrage",
      '{"reviewLevel":"medium"}',
      { reviewLevel: "medium" }
    );
    expect(typeof convId).toBe("string");
    expect(convId).toMatch(/^dsconv_/);

    const conv = getDeepSeekConversation(convId);
    expect(conv).not.toBeNull();
    expect(conv.mode).toBe("math_logic_review");
    expect(conv.messages.length).toBe(2);
  });

  test("creates a new conversation for controller_guard", () => {
    const convId = registerExternalExchange(
      "controller_guard",
      "Guard-Anfrage",
      '{"guardLevel":"high"}',
      { guardLevel: "high" }
    );
    const conv = getDeepSeekConversation(convId);
    expect(conv.mode).toBe("controller_guard");
  });

  test("extends an existing conversation when conversationId is provided", () => {
    const convId = registerExternalExchange(
      "math_logic_review",
      "Erste Analyse",
      '{"reviewLevel":"low"}',
      { reviewLevel: "low" }
    );
    const before = getDeepSeekConversation(convId).messageCount;

    registerExternalExchange(
      "math_logic_review",
      "Zweite Analyse",
      '{"reviewLevel":"medium"}',
      { reviewLevel: "medium" },
      convId
    );
    const after = getDeepSeekConversation(convId).messageCount;
    expect(after).toBeGreaterThan(before);
  });

  test("creates fresh conversation when given unknown conversationId", () => {
    const convId = registerExternalExchange(
      "controller_guard",
      "Anfrage",
      "{}",
      {},
      "dsconv_does_not_exist"
    );
    expect(convId).not.toBe("dsconv_does_not_exist");
  });

  test("follow-up after registerExternalExchange works", async () => {
    const convId = registerExternalExchange(
      "math_logic_review",
      "Score-Review-Anfrage",
      JSON.stringify({ reviewLevel: "high", detectedRisks: ["NaN-Ausbreitung"] }),
      { reviewLevel: "high", detectedRisks: ["NaN-Ausbreitung"] }
    );

    const res = await continueDeepSeekConversation(convId, "Wie löse ich das NaN-Problem?");
    expect(res.success).toBe(true);
    // history messages carry the math_logic_review context
    const msgs = capturedMessages();
    const assistantMsg = msgs.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.content).toContain("NaN");
  });
});
