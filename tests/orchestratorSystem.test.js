"use strict";

/**
 * ═══════════════════════════════════════════════════════════════
 *  Tests: Agent Registry, Request Classifier, Audit Trail,
 *         Conversation Store, Agent Orchestrator
 * ═══════════════════════════════════════════════════════════════
 */

/* ─────────────────────────────────────────────
   Agent Registry Tests
   ───────────────────────────────────────────── */

const {
  getAgent,
  getAllAgents,
  getAvailableAgents,
  getAgentIds,
  isAgentAvailable,
  getAgentCapabilities,
  getAgentHealth,
  supportsIntent,
  supportsMode,
  isIntentAllowedForSafetyLevel,
  UNIFIED_ACTION_INTENTS,
  SAFETY_LEVELS,
  ALLOWED_PROJECT_PATHS,
  BLOCKED_PATH_PATTERNS,
} = require("../services/agentRegistry.service");

describe("Agent Registry", () => {
  test("UNIFIED_ACTION_INTENTS has 10 entries", () => {
    expect(UNIFIED_ACTION_INTENTS).toHaveLength(10);
    expect(UNIFIED_ACTION_INTENTS).toContain("explain");
    expect(UNIFIED_ACTION_INTENTS).toContain("analyze");
    expect(UNIFIED_ACTION_INTENTS).toContain("diagnose");
    expect(UNIFIED_ACTION_INTENTS).toContain("inspect_files");
    expect(UNIFIED_ACTION_INTENTS).toContain("propose_change");
    expect(UNIFIED_ACTION_INTENTS).toContain("prepare_patch");
    expect(UNIFIED_ACTION_INTENTS).toContain("dry_run");
    expect(UNIFIED_ACTION_INTENTS).toContain("execute_change");
    expect(UNIFIED_ACTION_INTENTS).toContain("verify_fix");
    expect(UNIFIED_ACTION_INTENTS).toContain("plan_fix");
  });

  test("SAFETY_LEVELS has 4 levels", () => {
    expect(Object.keys(SAFETY_LEVELS)).toHaveLength(4);
    expect(SAFETY_LEVELS).toHaveProperty("read_only");
    expect(SAFETY_LEVELS).toHaveProperty("propose");
    expect(SAFETY_LEVELS).toHaveProperty("dry_run");
    expect(SAFETY_LEVELS).toHaveProperty("execute");
  });

  test("read_only does not allow execute_change", () => {
    expect(isIntentAllowedForSafetyLevel("execute_change", "read_only")).toBe(false);
    expect(isIntentAllowedForSafetyLevel("explain", "read_only")).toBe(true);
    expect(isIntentAllowedForSafetyLevel("analyze", "read_only")).toBe(true);
  });

  test("execute allows all intents", () => {
    for (const intent of UNIFIED_ACTION_INTENTS) {
      expect(isIntentAllowedForSafetyLevel(intent, "execute")).toBe(true);
    }
  });

  test("propose does not allow execute_change or dry_run", () => {
    expect(isIntentAllowedForSafetyLevel("execute_change", "propose")).toBe(false);
    expect(isIntentAllowedForSafetyLevel("dry_run", "propose")).toBe(false);
    expect(isIntentAllowedForSafetyLevel("propose_change", "propose")).toBe(true);
  });

  test("dry_run allows dry_run but not execute_change", () => {
    expect(isIntentAllowedForSafetyLevel("dry_run", "dry_run")).toBe(true);
    expect(isIntentAllowedForSafetyLevel("execute_change", "dry_run")).toBe(false);
  });

  test("getAllAgents returns at least 2 agents", () => {
    const agents = getAllAgents();
    expect(agents.length).toBeGreaterThanOrEqual(2);
  });

  test("getAgentIds returns deepseek and gemini", () => {
    const ids = getAgentIds();
    expect(ids).toContain("deepseek");
    expect(ids).toContain("gemini");
  });

  test("getAgent returns agent definition", () => {
    const ds = getAgent("deepseek");
    expect(ds).not.toBeNull();
    expect(ds.id).toBe("deepseek");
    expect(ds.role).toBe("backend_agent");
    expect(ds.provider).toBe("deepseek");
    expect(ds.supportedIntents).toContain("explain");
    expect(ds.supportedModes).toContain("backend_review");
  });

  test("getAgent returns null for unknown agent", () => {
    expect(getAgent("nonexistent")).toBeNull();
  });

  test("getAgentCapabilities returns structured data", () => {
    const caps = getAgentCapabilities("gemini");
    expect(caps).not.toBeNull();
    expect(caps.id).toBe("gemini");
    expect(caps.label).toBeDefined();
    expect(caps.role).toBe("frontend_agent");
    expect(caps.supportedModes).toContain("layout_review");
    expect(typeof caps.configured).toBe("boolean");
    expect(typeof caps.enabled).toBe("boolean");
  });

  test("getAgentCapabilities returns null for unknown", () => {
    expect(getAgentCapabilities("nope")).toBeNull();
  });

  test("getAgentHealth returns health for all agents", () => {
    const health = getAgentHealth();
    expect(health.deepseek).toBeDefined();
    expect(health.gemini).toBeDefined();
    expect(typeof health.deepseek.healthy).toBe("boolean");
    expect(typeof health.gemini.enabled).toBe("boolean");
  });

  test("supportsIntent works correctly", () => {
    expect(supportsIntent("deepseek", "explain")).toBe(true);
    expect(supportsIntent("deepseek", "invalid_intent")).toBe(false);
    expect(supportsIntent("nonexistent", "explain")).toBe(false);
  });

  test("supportsMode works correctly", () => {
    expect(supportsMode("deepseek", "backend_review")).toBe(true);
    expect(supportsMode("deepseek", "layout_review")).toBe(false);
    expect(supportsMode("gemini", "layout_review")).toBe(true);
    expect(supportsMode("gemini", "backend_review")).toBe(false);
  });

  test("ALLOWED_PROJECT_PATHS contains expected paths", () => {
    expect(ALLOWED_PROJECT_PATHS).toContain("src/");
    expect(ALLOWED_PROJECT_PATHS).toContain("services/");
    expect(ALLOWED_PROJECT_PATHS).toContain("routes/");
  });

  test("BLOCKED_PATH_PATTERNS contains security-critical entries", () => {
    expect(BLOCKED_PATH_PATTERNS).toContain(".env");
    expect(BLOCKED_PATH_PATTERNS).toContain("node_modules");
    expect(BLOCKED_PATH_PATTERNS).toContain(".git");
    expect(BLOCKED_PATH_PATTERNS).toContain("secrets");
  });
});

/* ─────────────────────────────────────────────
   Request Classifier Tests
   ───────────────────────────────────────────── */

const { classifyRequest } = require("../services/requestClassifier.service");

describe("Request Classifier", () => {
  test("classifies backend message to deepseek", () => {
    const result = classifyRequest({ message: "Prüfe die backend API Logik" });
    expect(result.targetAgent).toBe("deepseek");
    expect(result.isConference).toBe(false);
  });

  test("classifies frontend message to gemini", () => {
    const result = classifyRequest({ message: "Analysiere das frontend layout" });
    expect(result.targetAgent).toBe("gemini");
    expect(result.isConference).toBe(false);
  });

  test("classifies conference keywords correctly", () => {
    const result = classifyRequest({ message: "Beide Agenten sollen zusammen arbeiten" });
    expect(result.targetAgent).toBe("conference");
    expect(result.isConference).toBe(true);
  });

  test("explicit agent overrides keyword detection", () => {
    const result = classifyRequest({ message: "Prüfe die API", agent: "gemini" });
    expect(result.targetAgent).toBe("gemini");
  });

  test("explicit agent 'both' maps to conference", () => {
    const result = classifyRequest({ message: "Hilfe", agent: "both" });
    expect(result.targetAgent).toBe("conference");
    expect(result.isConference).toBe(true);
  });

  test("detects follow-up from conversationId", () => {
    const result = classifyRequest({ message: "Weiter", conversationId: "conv-123" });
    expect(result.isFollowUp).toBe(true);
  });

  test("detects conference follow-up from conferenceId", () => {
    const result = classifyRequest({ message: "Weiter", conferenceId: "conf-456" });
    expect(result.isFollowUp).toBe(true);
    expect(result.isConference).toBe(true);
    expect(result.targetAgent).toBe("conference");
  });

  test("maps action intent from keywords", () => {
    const result = classifyRequest({ message: "Erkläre mir bitte den Service" });
    expect(result.actionIntent).toBe("explain");
  });

  test("maps diagnose intent", () => {
    const result = classifyRequest({ message: "Diagnose des Fehlers im Backend" });
    expect(result.actionIntent).toBe("diagnose");
  });

  test("maps plan_fix intent", () => {
    const result = classifyRequest({ message: "Plane die Schritte zur Reparatur" });
    expect(result.actionIntent).toBe("plan_fix");
  });

  test("explicit intent overrides keyword", () => {
    const result = classifyRequest({ message: "Was ist das?", actionIntent: "analyze" });
    expect(result.actionIntent).toBe("analyze");
  });

  test("explicit mode is preserved", () => {
    const result = classifyRequest({ message: "Test", mode: "security_review" });
    expect(result.mode).toBe("security_review");
  });

  test("default mode is free_chat", () => {
    const result = classifyRequest({ message: "Hallo" });
    expect(result.mode).toBe("free_chat");
  });

  test("safety level validation warns on violation", () => {
    const result = classifyRequest({
      message: "Führe Änderung aus",
      actionIntent: "execute_change",
      safetyLevel: "read_only",
    });
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("returns reasoning array", () => {
    const result = classifyRequest({ message: "Analysiere Backend" });
    expect(Array.isArray(result.reasoning)).toBe(true);
    expect(result.reasoning.length).toBeGreaterThan(0);
  });

  test("confidence is high with multiple explicit params", () => {
    const result = classifyRequest({ message: "Test", agent: "deepseek", mode: "free_chat", actionIntent: "explain" });
    expect(result.confidence).toBe("high");
  });

  test("handles empty message gracefully", () => {
    const result = classifyRequest({ message: "" });
    expect(result.targetAgent).toBeDefined();
    expect(result.mode).toBeDefined();
  });

  test("handles undefined options gracefully", () => {
    const result = classifyRequest();
    expect(result.targetAgent).toBe("deepseek");
    expect(result.mode).toBe("free_chat");
  });

  test("defaults agent to deepseek when no keywords match", () => {
    const result = classifyRequest({ message: "xyz123" });
    expect(result.targetAgent).toBe("deepseek");
  });
});

/* ─────────────────────────────────────────────
   Audit Trail Tests
   ───────────────────────────────────────────── */

const {
  recordAuditEvent,
  generateRequestId,
  generateTraceId,
  getRecentAuditEvents,
  getAuditEventsByConversation,
  getAuditEventsByConference,
  getAuditEventsByType,
  getAuditSummary,
  VALID_EVENT_TYPES,
} = require("../services/auditTrail.service");

describe("Audit Trail", () => {
  test("generateRequestId returns unique IDs", () => {
    const id1 = generateRequestId();
    const id2 = generateRequestId();
    expect(id1).toMatch(/^req-/);
    expect(id2).toMatch(/^req-/);
    expect(id1).not.toBe(id2);
  });

  test("generateTraceId returns unique IDs", () => {
    const id1 = generateTraceId();
    const id2 = generateTraceId();
    expect(id1).toMatch(/^trace-/);
    expect(id1).not.toBe(id2);
  });

  test("recordAuditEvent stores event", () => {
    const before = getRecentAuditEvents(1000).length;
    recordAuditEvent({ eventType: "conversation_start", agent: "deepseek" });
    const after = getRecentAuditEvents(1000).length;
    expect(after).toBe(before + 1);
  });

  test("recordAuditEvent returns entry with id and timestamp", () => {
    const entry = recordAuditEvent({ eventType: "classification", agent: "gemini" });
    expect(entry.id).toBeDefined();
    expect(entry.timestamp).toBeDefined();
    expect(entry.eventType).toBe("classification");
    expect(entry.agent).toBe("gemini");
  });

  test("getAuditEventsByConversation filters correctly", () => {
    const convId = `test-conv-${Date.now()}`;
    recordAuditEvent({ eventType: "conversation_start", conversationId: convId });
    recordAuditEvent({ eventType: "conversation_followup", conversationId: convId });
    const events = getAuditEventsByConversation(convId);
    expect(events.length).toBe(2);
    expect(events.every((e) => e.conversationId === convId)).toBe(true);
  });

  test("getAuditEventsByConference filters correctly", () => {
    const confId = `test-conf-${Date.now()}`;
    recordAuditEvent({ eventType: "conference_opened", conferenceId: confId });
    const events = getAuditEventsByConference(confId);
    expect(events.length).toBe(1);
    expect(events[0].conferenceId).toBe(confId);
  });

  test("getAuditEventsByType filters correctly", () => {
    recordAuditEvent({ eventType: "safety_violation" });
    const events = getAuditEventsByType("safety_violation");
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.eventType === "safety_violation")).toBe(true);
  });

  test("getAuditSummary returns structured summary", () => {
    const summary = getAuditSummary();
    expect(typeof summary.totalEvents).toBe("number");
    expect(typeof summary.byType).toBe("object");
    expect(typeof summary.byAgent).toBe("object");
    expect(typeof summary.errorCount).toBe("number");
  });

  test("VALID_EVENT_TYPES has expected events", () => {
    expect(VALID_EVENT_TYPES).toContain("conversation_start");
    expect(VALID_EVENT_TYPES).toContain("execute_completed");
    expect(VALID_EVENT_TYPES).toContain("conference_opened");
    expect(VALID_EVENT_TYPES).toContain("safety_violation");
    expect(VALID_EVENT_TYPES).toContain("agent_timeout");
  });

  test("audit entry stores all fields", () => {
    const entry = recordAuditEvent({
      eventType: "execute_completed",
      requestId: "req-1",
      traceId: "trace-1",
      conversationId: "conv-1",
      agent: "deepseek",
      mode: "change_mode",
      actionIntent: "execute_change",
      safetyLevel: "execute",
      approved: true,
      dryRun: false,
      changedFiles: ["src/test.js"],
      provider: "deepseek",
      model: "deepseek-chat",
      durationMs: 1234,
    });
    expect(entry.requestId).toBe("req-1");
    expect(entry.traceId).toBe("trace-1");
    expect(entry.approved).toBe(true);
    expect(entry.dryRun).toBe(false);
    expect(entry.changedFiles).toEqual(["src/test.js"]);
    expect(entry.durationMs).toBe(1234);
  });
});

/* ─────────────────────────────────────────────
   Conversation Store Tests
   ───────────────────────────────────────────── */

const conversationStore = require("../services/conversationStore.service");

describe("Conversation Store", () => {
  const testConv = {
    conversationId: `store-test-${Date.now()}`,
    agent: "deepseek",
    mode: "free_chat",
    status: "active",
    lastActionIntent: null,
    approved: false,
    messageCount: 0,
    messages: [],
    proposedChanges: null,
    preparedPatch: null,
    executionResult: null,
    dryRunResult: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  test("save and getSync work", async () => {
    await conversationStore.save(testConv);
    const result = conversationStore.getSync(testConv.conversationId);
    expect(result).not.toBeNull();
    expect(result.conversationId).toBe(testConv.conversationId);
    expect(result.agent).toBe("deepseek");
  });

  test("get returns conversation from memory", async () => {
    const result = await conversationStore.get(testConv.conversationId);
    expect(result).not.toBeNull();
    expect(result.conversationId).toBe(testConv.conversationId);
  });

  test("list returns conversations", () => {
    const list = conversationStore.list();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
  });

  test("list filters by agent", () => {
    const list = conversationStore.list({ agent: "deepseek" });
    expect(list.every((c) => c.agent === "deepseek")).toBe(true);
  });

  test("list filters by status", async () => {
    await conversationStore.save({ ...testConv, conversationId: "filter-test-1", status: "completed" });
    const list = conversationStore.list({ status: "completed" });
    expect(list.every((c) => c.status === "completed")).toBe(true);
  });

  test("getStats returns structured data", () => {
    const stats = conversationStore.getStats();
    expect(typeof stats.total).toBe("number");
    expect(typeof stats.byAgent).toBe("object");
    expect(typeof stats.byStatus).toBe("object");
    expect(typeof stats.maxCapacity).toBe("number");
  });

  test("size returns number of conversations", () => {
    expect(typeof conversationStore.size()).toBe("number");
    expect(conversationStore.size()).toBeGreaterThan(0);
  });

  test("remove deletes conversation", async () => {
    const id = `remove-test-${Date.now()}`;
    await conversationStore.save({ ...testConv, conversationId: id });
    expect(conversationStore.getSync(id)).not.toBeNull();
    await conversationStore.remove(id);
    expect(conversationStore.getSync(id)).toBeNull();
  });

  test("get returns null for nonexistent", async () => {
    const result = await conversationStore.get("nonexistent-id-12345");
    expect(result).toBeNull();
  });

  test("save handles null conversationId gracefully", async () => {
    await expect(conversationStore.save(null)).resolves.toBeUndefined();
    await expect(conversationStore.save({})).resolves.toBeUndefined();
  });
});

/* ─────────────────────────────────────────────
   Orchestrator Tests
   ───────────────────────────────────────────── */

const { handleRequest, getSystemStatus, ERROR_CODES } = require("../services/agentOrchestrator.service");

describe("Agent Orchestrator", () => {
  test("ERROR_CODES has expected codes", () => {
    expect(ERROR_CODES.AGENT_NOT_AVAILABLE).toBe("AGENT_NOT_AVAILABLE");
    expect(ERROR_CODES.SAFETY_VIOLATION).toBe("SAFETY_VIOLATION");
    expect(ERROR_CODES.EMPTY_MESSAGE).toBe("EMPTY_MESSAGE");
    expect(ERROR_CODES.APPROVAL_REQUIRED).toBe("APPROVAL_REQUIRED");
    expect(ERROR_CODES.AGENT_TIMEOUT).toBe("AGENT_TIMEOUT");
    expect(ERROR_CODES.CONFERENCE_ERROR).toBe("CONFERENCE_ERROR");
  });

  test("handleRequest rejects empty message", async () => {
    const result = await handleRequest({ message: "" });
    expect(result.status).toBe("error");
    expect(result.errors).toContain(ERROR_CODES.EMPTY_MESSAGE);
    expect(result.requestId).toBeDefined();
    expect(result.traceId).toBeDefined();
  });

  test("handleRequest rejects safety violation", async () => {
    const result = await handleRequest({
      message: "Führe aus",
      actionIntent: "execute_change",
      safetyLevel: "read_only",
    });
    expect(result.status).toBe("error");
    expect(result.errors).toContain(ERROR_CODES.SAFETY_VIOLATION);
  });

  test("handleRequest returns unified response shape", async () => {
    const result = await handleRequest({ message: "Hallo", agent: "deepseek", mode: "free_chat" });
    // Even if agent is not configured, the response should be unified
    expect(result).toHaveProperty("conversationId");
    expect(result).toHaveProperty("conferenceId");
    expect(result).toHaveProperty("agent");
    expect(result).toHaveProperty("mode");
    expect(result).toHaveProperty("actionIntent");
    expect(result).toHaveProperty("status");
    expect(result).toHaveProperty("followUpPossible");
    expect(result).toHaveProperty("reply");
    expect(result).toHaveProperty("errorCategory");
    expect(result).toHaveProperty("metadata");
    expect(result).toHaveProperty("proposedChanges");
    expect(result).toHaveProperty("preparedPatch");
    expect(result).toHaveProperty("executionResult");
    expect(result).toHaveProperty("dryRunResult");
    expect(result).toHaveProperty("requiresApproval");
    expect(result).toHaveProperty("approved");
    expect(result).toHaveProperty("changedFiles");
    expect(result).toHaveProperty("errors");
    expect(result).toHaveProperty("warnings");
    expect(result).toHaveProperty("requestId");
    expect(result).toHaveProperty("traceId");
  });

  test("handleRequest metadata includes classification", async () => {
    const result = await handleRequest({ message: "Test analyse backend" });
    expect(result.metadata).toHaveProperty("timestamp");
  });

  test("getSystemStatus returns structured status", () => {
    const status = getSystemStatus();
    expect(status).toHaveProperty("status");
    expect(status).toHaveProperty("agents");
    expect(status).toHaveProperty("availableAgentCount");
    expect(status).toHaveProperty("conversationStore");
    expect(status).toHaveProperty("timestamp");
    expect(typeof status.availableAgentCount).toBe("number");
  });

  test("handleRequest handles null opts gracefully", async () => {
    const result = await handleRequest();
    expect(result.status).toBe("error");
  });

  test("handleRequest includes requestId and traceId", async () => {
    const result = await handleRequest({ message: "Test" });
    expect(result.requestId).toMatch(/^req-/);
    expect(result.traceId).toMatch(/^trace-/);
  });

  test("handleRequest routes conference via both agent", async () => {
    const result = await handleRequest({ message: "Test", agent: "both" });
    // Conference handling – will fail gracefully if bridge not loaded
    expect(result).toHaveProperty("agent");
    expect(result.requestId).toBeDefined();
  });
});

/* ─────────────────────────────────────────────
   Integration Smoke Tests
   ───────────────────────────────────────────── */

describe("System Integration Smoke Tests", () => {
  test("Agent registry and classifier agree on agent IDs", () => {
    const ids = getAgentIds();
    const dsResult = classifyRequest({ message: "backend api check" });
    const gemResult = classifyRequest({ message: "frontend layout prüfen" });
    expect(ids).toContain(dsResult.targetAgent);
    expect(ids).toContain(gemResult.targetAgent);
  });

  test("Classifier safety levels align with registry safety levels", () => {
    for (const level of Object.keys(SAFETY_LEVELS)) {
      const result = classifyRequest({ message: "Test", safetyLevel: level });
      expect(result.safetyLevel).toBe(level);
    }
  });

  test("Audit trail records orchestrator events", async () => {
    const before = getRecentAuditEvents(1000).length;
    await handleRequest({ message: "Smoke test message", agent: "deepseek", mode: "free_chat" });
    const after = getRecentAuditEvents(1000).length;
    expect(after).toBeGreaterThan(before);
  });

  test("Conversation store stats reflect saves", async () => {
    const id = `smoke-test-${Date.now()}`;
    await conversationStore.save({
      conversationId: id,
      agent: "deepseek",
      mode: "free_chat",
      status: "active",
      messages: [],
      messageCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const stats = conversationStore.getStats();
    expect(stats.total).toBeGreaterThan(0);
    // Cleanup
    await conversationStore.remove(id);
  });

  test("Unified response schema is consistent between error and success shapes", async () => {
    const errorResult = await handleRequest({ message: "" });
    const normalResult = await handleRequest({ message: "Test" });

    const expectedKeys = [
      "conversationId", "conferenceId", "agent", "mode", "actionIntent",
      "status", "followUpPossible", "reply", "errorCategory", "metadata",
      "proposedChanges", "preparedPatch", "executionResult", "dryRunResult",
      "requiresApproval", "approved", "changedFiles", "errors", "warnings",
      "requestId", "traceId",
    ];

    for (const key of expectedKeys) {
      expect(errorResult).toHaveProperty(key);
      expect(normalResult).toHaveProperty(key);
    }
  });

  test("DeepSeek and Gemini agent intents are aligned", () => {
    const dsIntents = require("../services/deepseekAgent.service").VALID_ACTION_INTENTS;
    const gemIntents = require("../services/geminiAgent.service").VALID_ACTION_INTENTS;
    expect(dsIntents).toEqual(gemIntents);
  });

  test("DeepSeek and Gemini share path safety rules", () => {
    const dsPaths = require("../services/deepseekAgent.service").ALLOWED_PROJECT_PATHS;
    const gemPaths = require("../services/geminiAgent.service").ALLOWED_PROJECT_PATHS;
    expect(dsPaths).toEqual(gemPaths);
    expect(dsPaths).toEqual(ALLOWED_PROJECT_PATHS);
  });

  test("Registry ALLOWED_PROJECT_PATHS matches agent services", () => {
    const dsPaths = require("../services/deepseekAgent.service").ALLOWED_PROJECT_PATHS;
    expect(ALLOWED_PROJECT_PATHS).toEqual(dsPaths);
  });
});
