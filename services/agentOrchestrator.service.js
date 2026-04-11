"use strict";

/**
 * ═══════════════════════════════════════════════════════════════
 *  HQS Agent Orchestrator
 * ═══════════════════════════════════════════════════════════════
 *
 *  Single entry point for ALL agent interactions.
 *  Routes requests through: Classification → Agent → Response
 *
 *  Responsibilities:
 *    ① Request classification (via requestClassifier)
 *    ② Agent dispatch (DeepSeek / Gemini / Conference)
 *    ③ Approval / DryRun / Execute gate enforcement
 *    ④ Unified response normalization
 *    ⑤ Audit trail
 *    ⑥ Error handling / timeouts / resilience
 *    ⑦ Persistent conversation store integration
 * ═══════════════════════════════════════════════════════════════
 */

const logger = require("../utils/logger");
const { classifyRequest } = require("./requestClassifier.service");
const {
  UNIFIED_ACTION_INTENTS,
  isIntentAllowedForSafetyLevel,
  getAgent,
  isAgentAvailable,
  getAgentHealth,
  getAvailableAgents,
  ALLOWED_PROJECT_PATHS,
  BLOCKED_PATH_PATTERNS,
} = require("./agentRegistry.service");
const {
  recordAuditEvent,
  generateRequestId,
  generateTraceId,
} = require("./auditTrail.service");
const conversationStore = require("./conversationStore.service");

/* ─────────────────────────────────────────────
   Lazy service loaders (avoid circular deps)
   ───────────────────────────────────────────── */

let _deepseekAgentSvc = null;
let _geminiAgentSvc = null;
let _agentBridgeSvc = null;

function _loadDeepseek() {
  if (!_deepseekAgentSvc) {
    try { _deepseekAgentSvc = require("./deepseekAgent.service"); } catch { _deepseekAgentSvc = null; }
  }
  return _deepseekAgentSvc;
}

function _loadGemini() {
  if (!_geminiAgentSvc) {
    try { _geminiAgentSvc = require("./geminiAgent.service"); } catch { _geminiAgentSvc = null; }
  }
  return _geminiAgentSvc;
}

function _loadBridge() {
  if (!_agentBridgeSvc) {
    try { _agentBridgeSvc = require("./agentBridge.service"); } catch { _agentBridgeSvc = null; }
  }
  return _agentBridgeSvc;
}

/* ─────────────────────────────────────────────
   Error codes
   ───────────────────────────────────────────── */

const ERROR_CODES = {
  AGENT_NOT_AVAILABLE:      "AGENT_NOT_AVAILABLE",
  AGENT_NOT_CONFIGURED:     "AGENT_NOT_CONFIGURED",
  INVALID_MODE:             "INVALID_MODE",
  INVALID_INTENT:           "INVALID_INTENT",
  SAFETY_VIOLATION:         "SAFETY_VIOLATION",
  APPROVAL_REQUIRED:        "APPROVAL_REQUIRED",
  CONVERSATION_NOT_FOUND:   "CONVERSATION_NOT_FOUND",
  EMPTY_MESSAGE:            "EMPTY_MESSAGE",
  AGENT_TIMEOUT:            "AGENT_TIMEOUT",
  AGENT_ERROR:              "AGENT_ERROR",
  AGENT_EMPTY_RESPONSE:     "AGENT_EMPTY_RESPONSE",
  CONFERENCE_ERROR:         "CONFERENCE_ERROR",
  INTERNAL_ERROR:           "INTERNAL_ERROR",
};

const TIMEOUT_BUFFER_MS = 10000;
const CONFERENCE_TIMEOUT_MS = 60000;

/* ─────────────────────────────────────────────
   Unified response builder
   ───────────────────────────────────────────── */

/**
 * @typedef {Object} UnifiedResponse
 * @property {string}      conversationId
 * @property {string|null} conferenceId
 * @property {string}      agent
 * @property {string}      mode
 * @property {string|null} actionIntent
 * @property {string}      status
 * @property {boolean}     followUpPossible
 * @property {{ text: string }} reply
 * @property {string|null} errorCategory
 * @property {Object[]}    [replies]
 * @property {Object}      metadata
 * @property {Object|null} proposedChanges
 * @property {Object|null} preparedPatch
 * @property {Object|null} executionResult
 * @property {Object|null} dryRunResult
 * @property {boolean}     requiresApproval
 * @property {boolean}     approved
 * @property {string[]}    changedFiles
 * @property {string[]}    errors
 * @property {string[]}    warnings
 * @property {string}      requestId
 * @property {string}      traceId
 */

function _buildUnifiedResponse(opts = {}) {
  return {
    conversationId:   opts.conversationId || null,
    conferenceId:     opts.conferenceId || null,
    agent:            opts.agent || null,
    mode:             opts.mode || null,
    actionIntent:     opts.actionIntent || null,
    status:           opts.status || "error",
    followUpPossible: opts.followUpPossible ?? false,
    reply:            { text: opts.assistantReply || "" },
    errorCategory:    opts.errorCategory || null,
    replies:          opts.replies || null,
    metadata: {
      model:          opts.model || null,
      provider:       opts.provider || null,
      apiVersion:     opts.apiVersion || "v1",
      messageCount:   opts.messageCount || 0,
      historyLength:  opts.historyLength || 0,
      isInitial:      opts.isInitial ?? true,
      timestamp:      new Date().toISOString(),
      classification: opts.classification || null,
      durationMs:     opts.durationMs || null,
    },
    proposedChanges:  opts.proposedChanges || null,
    preparedPatch:    opts.preparedPatch || null,
    executionResult:  opts.executionResult || null,
    dryRunResult:     opts.dryRunResult || null,
    requiresApproval: opts.requiresApproval ?? false,
    approved:         opts.approved ?? false,
    changedFiles:     opts.changedFiles || [],
    errors:           opts.errors || [],
    warnings:         opts.warnings || [],
    requestId:        opts.requestId || null,
    traceId:          opts.traceId || null,
  };
}

/* ─────────────────────────────────────────────
   Normalize agent-specific response to unified format
   ───────────────────────────────────────────── */

function _normalizeAgentResponse(agentResponse, agentId, requestId, traceId, classification, startTime) {
  const durationMs = Date.now() - startTime;
  const agentDef = getAgent(agentId);

  return _buildUnifiedResponse({
    conversationId:   agentResponse.conversationId,
    agent:            agentId,
    mode:             agentResponse.mode,
    actionIntent:     agentResponse.actionIntent,
    status:           agentResponse.status,
    followUpPossible: agentResponse.followUpPossible,
    assistantReply:   agentResponse.reply?.text || "",
    errorCategory:    agentResponse.errorCategory || null,
    model:            agentResponse.metadata?.model || agentDef?.model,
    provider:         agentDef?.provider,
    apiVersion:       agentResponse.metadata?.apiVersion || "v1",
    messageCount:     agentResponse.metadata?.messageCount || 0,
    historyLength:    agentResponse.metadata?.historyLength || 0,
    isInitial:        agentResponse.metadata?.isInitial ?? true,
    classification:   classification,
    durationMs,
    proposedChanges:  agentResponse.proposedChanges,
    preparedPatch:    agentResponse.preparedPatch,
    executionResult:  agentResponse.executionResult,
    dryRunResult:     agentResponse.dryRunResult,
    requiresApproval: agentResponse.requiresApproval,
    approved:         agentResponse.approved,
    changedFiles:     agentResponse.changedFiles || agentResponse.executionResult?.changedFiles || [],
    errors:           agentResponse.errors || [],
    warnings:         classification?.warnings || [],
    requestId,
    traceId,
  });
}

/* ─────────────────────────────────────────────
   Timeout wrapper
   ───────────────────────────────────────────── */

async function _withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}: Timeout nach ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((result) => { clearTimeout(timer); resolve(result); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

/* ─────────────────────────────────────────────
   Core orchestration – handle request
   ───────────────────────────────────────────── */

/**
 * Main entry point for all agent interactions.
 *
 * @param {Object} opts
 * @param {string}      opts.message          - user message
 * @param {string}      [opts.agent]          - explicit agent
 * @param {string}      [opts.mode]           - explicit mode
 * @param {string}      [opts.actionIntent]   - explicit intent
 * @param {string}      [opts.safetyLevel]    - safety level
 * @param {string}      [opts.conversationId] - for follow-up
 * @param {string}      [opts.conferenceId]   - for conference follow-up
 * @param {boolean}     [opts.approved]        - approval flag
 * @param {boolean}     [opts.dryRun]          - dry-run flag
 * @param {boolean}     [opts.confirmExecution]- confirm execution
 * @param {string}      [opts.context]        - initial context
 * @returns {Promise<UnifiedResponse>}
 */
async function handleRequest(opts = {}) {
  const startTime = Date.now();
  const requestId = generateRequestId();
  const traceId = opts.traceId || generateTraceId();

  try {
    // ① Classify
    const classification = classifyRequest(opts);

    recordAuditEvent({
      eventType: "classification",
      requestId,
      traceId,
      agent: classification.targetAgent,
      mode: classification.mode,
      actionIntent: classification.actionIntent,
      safetyLevel: classification.safetyLevel,
      metadata: { confidence: classification.confidence, reasoning: classification.reasoning },
    });

    // ② Validate message
    if (!opts.message || typeof opts.message !== "string" || !opts.message.trim()) {
      return _buildUnifiedResponse({
        status: "error",
        assistantReply: "Nachricht darf nicht leer sein.",
        errors: [ERROR_CODES.EMPTY_MESSAGE],
        requestId,
        traceId,
        agent: classification.targetAgent,
        mode: classification.mode,
      });
    }

    // ③ Safety check
    const effectiveIntent = classification.actionIntent;
    const effectiveSafety = opts.safetyLevel || classification.safetyLevel;
    if (effectiveIntent && !isIntentAllowedForSafetyLevel(effectiveIntent, effectiveSafety)) {
      recordAuditEvent({
        eventType: "safety_violation",
        requestId,
        traceId,
        actionIntent: effectiveIntent,
        safetyLevel: effectiveSafety,
      });
      return _buildUnifiedResponse({
        status: "error",
        assistantReply: `Intent "${effectiveIntent}" ist auf Sicherheitsstufe "${effectiveSafety}" nicht erlaubt.`,
        errors: [ERROR_CODES.SAFETY_VIOLATION],
        requestId,
        traceId,
        agent: classification.targetAgent,
        mode: classification.mode,
        warnings: [`Erhöhe die Sicherheitsstufe auf mindestens "dry_run" oder "execute".`],
      });
    }

    // ④ Route to agent
    if (classification.isConference) {
      return await _handleConferenceRequest(opts, classification, requestId, traceId, startTime);
    }

    return await _handleSingleAgentRequest(opts, classification, requestId, traceId, startTime);

  } catch (err) {
    logger.error("[orchestrator] handleRequest – unexpected error", {
      requestId,
      traceId,
      error: String(err.message).slice(0, 200),
    });
    recordAuditEvent({
      eventType: "agent_error",
      requestId,
      traceId,
      errorClass: "INTERNAL_ERROR",
      errorMessage: String(err.message).slice(0, 200),
      durationMs: Date.now() - startTime,
    });
    return _buildUnifiedResponse({
      status: "error",
      assistantReply: `Interner Fehler: ${String(err.message).slice(0, 200)}`,
      errors: [ERROR_CODES.INTERNAL_ERROR],
      requestId,
      traceId,
      durationMs: Date.now() - startTime,
    });
  }
}

/* ─────────────────────────────────────────────
   Single agent dispatch
   ───────────────────────────────────────────── */

async function _handleSingleAgentRequest(opts, classification, requestId, traceId, startTime) {
  const agentId = classification.targetAgent;
  const agentDef = getAgent(agentId);

  if (!agentDef) {
    return _buildUnifiedResponse({
      status: "error",
      assistantReply: `Agent "${agentId}" ist nicht registriert.`,
      errors: [ERROR_CODES.AGENT_NOT_AVAILABLE],
      requestId, traceId, agent: agentId,
    });
  }

  // Load appropriate service
  const svc = agentId === "deepseek" ? _loadDeepseek() : _loadGemini();
  if (!svc) {
    return _buildUnifiedResponse({
      status: "error",
      assistantReply: `Agent-Service "${agentId}" konnte nicht geladen werden.`,
      errors: [ERROR_CODES.AGENT_NOT_AVAILABLE],
      requestId, traceId, agent: agentId,
    });
  }

  const timeoutMs = agentDef.defaultTimeoutMs + TIMEOUT_BUFFER_MS; // extra buffer

  let agentResponse;

  if (classification.isFollowUp && opts.conversationId) {
    // ── Follow-up ──
    recordAuditEvent({
      eventType: "conversation_followup",
      requestId, traceId,
      conversationId: opts.conversationId,
      agent: agentId,
      mode: classification.mode,
      actionIntent: classification.actionIntent,
    });

    try {
      agentResponse = await _withTimeout(
        svc.continueConversation({
          conversationId: opts.conversationId,
          message: opts.message,
          actionIntent: classification.actionIntent || opts.actionIntent,
          confirmExecution: opts.confirmExecution,
          approved: opts.approved,
          dryRun: opts.dryRun,
        }),
        timeoutMs,
        `${agentId} follow-up`,
      );
    } catch (err) {
      const isTimeout = err.message.includes("Timeout");
      recordAuditEvent({
        eventType: isTimeout ? "agent_timeout" : "agent_error",
        requestId, traceId,
        conversationId: opts.conversationId,
        agent: agentId,
        errorClass: isTimeout ? "TIMEOUT" : "AGENT_ERROR",
        errorMessage: String(err.message).slice(0, 200),
        durationMs: Date.now() - startTime,
      });
      return _buildUnifiedResponse({
        status: "error",
        conversationId: opts.conversationId,
        agent: agentId,
        assistantReply: `${agentId}-Fehler: ${String(err.message).slice(0, 200)}`,
        errors: [isTimeout ? ERROR_CODES.AGENT_TIMEOUT : ERROR_CODES.AGENT_ERROR],
        requestId, traceId,
        durationMs: Date.now() - startTime,
      });
    }
  } else {
    // ── New conversation ──
    recordAuditEvent({
      eventType: "conversation_start",
      requestId, traceId,
      agent: agentId,
      mode: classification.mode || opts.mode,
      actionIntent: classification.actionIntent || opts.actionIntent,
    });

    try {
      agentResponse = await _withTimeout(
        svc.startConversation({
          mode: opts.mode || classification.mode,
          message: opts.message,
          actionIntent: classification.actionIntent || opts.actionIntent,
          context: opts.context,
        }),
        timeoutMs,
        `${agentId} start`,
      );
    } catch (err) {
      const isTimeout = err.message.includes("Timeout");
      recordAuditEvent({
        eventType: isTimeout ? "agent_timeout" : "agent_error",
        requestId, traceId,
        agent: agentId,
        errorClass: isTimeout ? "TIMEOUT" : "AGENT_ERROR",
        errorMessage: String(err.message).slice(0, 200),
        durationMs: Date.now() - startTime,
      });
      return _buildUnifiedResponse({
        status: "error",
        agent: agentId,
        assistantReply: `${agentId}-Fehler: ${String(err.message).slice(0, 200)}`,
        errors: [isTimeout ? ERROR_CODES.AGENT_TIMEOUT : ERROR_CODES.AGENT_ERROR],
        requestId, traceId,
        durationMs: Date.now() - startTime,
      });
    }
  }

  // Validate agent response
  if (!agentResponse || (!agentResponse.reply?.text && agentResponse.status !== "error")) {
    recordAuditEvent({
      eventType: "agent_empty_response",
      requestId, traceId,
      agent: agentId,
      conversationId: agentResponse?.conversationId,
    });
    if (agentResponse) {
      agentResponse.reply = agentResponse.reply || {};
      agentResponse.reply.text = agentResponse.reply.text || "[Leere Antwort vom Agent – bitte erneut versuchen]";
    }
  }

  // Persist conversation
  if (agentResponse?.conversationId) {
    conversationStore.save({
      conversationId: agentResponse.conversationId,
      agent: agentId,
      mode: agentResponse.mode,
      status: agentResponse.status,
      lastActionIntent: agentResponse.actionIntent,
      approved: agentResponse.approved,
      messageCount: agentResponse.metadata?.messageCount || 0,
      proposedChanges: agentResponse.proposedChanges,
      preparedPatch: agentResponse.preparedPatch,
      executionResult: agentResponse.executionResult,
      dryRunResult: agentResponse.dryRunResult,
      conferenceId: agentResponse.conferenceId || opts.conferenceId || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).catch(() => {});
  }

  // Audit execution events
  if (agentResponse?.executionResult) {
    recordAuditEvent({
      eventType: agentResponse.executionResult.success ? "execute_completed" : "execute_failed",
      requestId, traceId,
      conversationId: agentResponse.conversationId,
      agent: agentId,
      changedFiles: agentResponse.executionResult.changedFiles,
      approved: agentResponse.approved,
      historyLength: agentResponse.metadata?.historyLength || 0,
    });
  }

  if (agentResponse?.dryRunResult) {
    recordAuditEvent({
      eventType: "dry_run_executed",
      requestId, traceId,
      conversationId: agentResponse.conversationId,
      agent: agentId,
      historyLength: agentResponse.metadata?.historyLength || 0,
      metadata: { wouldChange: agentResponse.dryRunResult.wouldChange },
    });
  }

  const result = _normalizeAgentResponse(agentResponse, agentId, requestId, traceId, classification, startTime);
  return result;
}

/* ─────────────────────────────────────────────
   Conference dispatch
   ───────────────────────────────────────────── */

async function _handleConferenceRequest(opts, classification, requestId, traceId, startTime) {
  const bridge = _loadBridge();
  if (!bridge) {
    return _buildUnifiedResponse({
      status: "error",
      assistantReply: "Konferenz-Service konnte nicht geladen werden.",
      errors: [ERROR_CODES.CONFERENCE_ERROR],
      requestId, traceId,
    });
  }

  try {
    if (classification.isFollowUp && opts.conferenceId) {
      // Follow-up in existing conference
      recordAuditEvent({
        eventType: "conference_message",
        requestId, traceId,
        conferenceId: opts.conferenceId,
        agent: "conference",
        actionIntent: classification.actionIntent,
      });

      const result = await _withTimeout(
        bridge.sendConferenceMessage({
          conferenceId: opts.conferenceId,
          message: opts.message,
          targetAgent: opts.agent || "both",
        }),
        CONFERENCE_TIMEOUT_MS,
        "conference message",
      );

      const durationMs = Date.now() - startTime;

      // Persist conference follow-up
      conversationStore.save({
        conversationId: `conf-${opts.conferenceId}`,
        agent: "conference",
        mode: classification.mode,
        status: result?.conferenceStatus || "active",
        lastActionIntent: classification.actionIntent,
        conferenceId: opts.conferenceId,
        messageCount: result?.replies?.length || 0,
        updatedAt: new Date().toISOString(),
      }).catch(() => {});

      return _buildUnifiedResponse({
        conferenceId: opts.conferenceId,
        agent: "conference",
        mode: classification.mode,
        actionIntent: classification.actionIntent,
        status: result?.conferenceStatus || "active",
        followUpPossible: true,
        assistantReply: result?.replies?.map((r) => `[${r.agent}]: ${r.text}`).join("\n\n") || "",
        replies: result?.replies || [],
        requestId, traceId,
        durationMs,
        classification,
      });
    } else {
      // New conference
      recordAuditEvent({
        eventType: "conference_opened",
        requestId, traceId,
        agent: "conference",
      });

      const session = await bridge.openConferenceSession({
        topic: opts.message,
        mode: classification.mode || "work_chat",
        targetAgent: "both",
      });

      if (!session?.conferenceId) {
        return _buildUnifiedResponse({
          status: "error",
          assistantReply: "Konferenz konnte nicht eröffnet werden.",
          errors: [ERROR_CODES.CONFERENCE_ERROR],
          requestId, traceId,
          agent: "conference",
        });
      }

      // Send initial message
      const result = await _withTimeout(
        bridge.sendConferenceMessage({
          conferenceId: session.conferenceId,
          message: opts.message,
          targetAgent: "both",
        }),
        CONFERENCE_TIMEOUT_MS,
        "conference initial message",
      );

      const durationMs = Date.now() - startTime;

      // Persist new conference session
      conversationStore.save({
        conversationId: `conf-${session.conferenceId}`,
        agent: "conference",
        mode: classification.mode,
        status: "active",
        lastActionIntent: classification.actionIntent,
        conferenceId: session.conferenceId,
        messageCount: result?.replies?.length || 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).catch(() => {});

      return _buildUnifiedResponse({
        conferenceId: session.conferenceId,
        agent: "conference",
        mode: classification.mode,
        actionIntent: classification.actionIntent,
        status: "active",
        followUpPossible: true,
        assistantReply: result?.replies?.map((r) => `[${r.agent}]: ${r.text}`).join("\n\n") || "",
        replies: result?.replies || [],
        requestId, traceId,
        durationMs,
        classification,
      });
    }
  } catch (err) {
    const isTimeout = err.message.includes("Timeout");
    recordAuditEvent({
      eventType: isTimeout ? "agent_timeout" : "agent_error",
      requestId, traceId,
      agent: "conference",
      errorClass: isTimeout ? "TIMEOUT" : "CONFERENCE_ERROR",
      errorMessage: String(err.message).slice(0, 200),
      durationMs: Date.now() - startTime,
    });

    return _buildUnifiedResponse({
      status: "error",
      conferenceId: opts.conferenceId,
      agent: "conference",
      assistantReply: `Konferenz-Fehler: ${String(err.message).slice(0, 200)}`,
      errors: [isTimeout ? ERROR_CODES.AGENT_TIMEOUT : ERROR_CODES.CONFERENCE_ERROR],
      requestId, traceId,
      durationMs: Date.now() - startTime,
    });
  }
}

/* ─────────────────────────────────────────────
   System status
   ───────────────────────────────────────────── */

function getSystemStatus() {
  const health = getAgentHealth();
  const storeStats = conversationStore.getStats();
  const available = getAvailableAgents();

  return {
    status: available.length > 0 ? "operational" : "degraded",
    agents: health,
    availableAgentCount: available.length,
    conversationStore: storeStats,
    timestamp: new Date().toISOString(),
  };
}

/* ─────────────────────────────────────────────
   Exports
   ───────────────────────────────────────────── */

module.exports = {
  handleRequest,
  getSystemStatus,
  ERROR_CODES,
  TIMEOUT_BUFFER_MS,
  CONFERENCE_TIMEOUT_MS,
  // Re-exports for convenience
  generateRequestId,
  generateTraceId,
};
