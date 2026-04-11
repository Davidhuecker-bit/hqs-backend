"use strict";

/**
 * ═══════════════════════════════════════════════════════════════
 *  HQS Unified Agent Registry
 * ═══════════════════════════════════════════════════════════════
 *
 *  Central, authoritative registry of all available AI agents.
 *  Every component that needs to know about agents (orchestrator,
 *  classifier, conference, routes) reads from HERE – not from
 *  hard-coded lists scattered across the codebase.
 *
 *  Responsibilities:
 *    ① agent catalogue (id, label, role, domain, capabilities)
 *    ② supported intents / modes per agent
 *    ③ health / enabled / configured checks
 *    ④ provider / model metadata
 * ═══════════════════════════════════════════════════════════════
 */

const logger = require("../utils/logger");

/* ─────────────────────────────────────────────
   Unified action-intent vocabulary
   (shared by ALL agents – DeepSeek, Gemini, Conference)
   ───────────────────────────────────────────── */

const UNIFIED_ACTION_INTENTS = [
  "explain",
  "analyze",
  "diagnose",
  "inspect_files",
  "propose_change",
  "prepare_patch",
  "dry_run",
  "execute_change",
  "verify_fix",
  "plan_fix",
];

/* ─────────────────────────────────────────────
   Unified safety levels
   ───────────────────────────────────────────── */

const SAFETY_LEVELS = {
  read_only: {
    label: "Nur Lesen",
    allowedIntents: ["explain", "analyze", "diagnose", "inspect_files", "plan_fix"],
    description: "Keine Änderungen, reine Analyse",
  },
  propose: {
    label: "Vorschlag",
    allowedIntents: ["explain", "analyze", "diagnose", "inspect_files", "propose_change", "prepare_patch", "plan_fix", "verify_fix"],
    description: "Änderungen vorschlagen, nicht ausführen",
  },
  dry_run: {
    label: "Trockenübung",
    allowedIntents: ["explain", "analyze", "diagnose", "inspect_files", "propose_change", "prepare_patch", "dry_run", "plan_fix", "verify_fix"],
    description: "Simulierte Ausführung ohne echte Änderungen",
  },
  execute: {
    label: "Ausführen",
    allowedIntents: UNIFIED_ACTION_INTENTS,
    description: "Echte Änderungen mit Freigabe erlaubt",
  },
};

/* ─────────────────────────────────────────────
   Allowed project paths & blocked patterns
   (single source of truth)
   ───────────────────────────────────────────── */

const ALLOWED_PROJECT_PATHS = [
  "src/", "components/", "pages/", "views/", "layouts/",
  "styles/", "config/", "utils/", "lib/", "public/",
  "services/", "routes/", "middleware/", "engines/",
];

const BLOCKED_PATH_PATTERNS = [
  ".env", "node_modules", ".git", "secrets", "credentials", "package-lock",
];

/* ─────────────────────────────────────────────
   Agent definitions (lazy – providers resolved at call time)
   ───────────────────────────────────────────── */

let _deepseekService = null;
let _geminiService = null;

function _lazyLoadServices() {
  if (!_deepseekService) {
    try { _deepseekService = require("./deepseek.service"); } catch { _deepseekService = null; }
  }
  if (!_geminiService) {
    try { _geminiService = require("./geminiArchitect.service"); } catch { _geminiService = null; }
  }
}

/**
 * @typedef {Object} AgentDefinition
 * @property {string}   id
 * @property {string}   label
 * @property {string}   role
 * @property {string}   domain
 * @property {string}   provider
 * @property {string}   model
 * @property {string[]} supportedModes
 * @property {string[]} supportedIntents
 * @property {string}   defaultSafetyLevel
 * @property {number}   defaultTimeoutMs
 * @property {number}   maxRetries
 * @property {boolean}  enabled
 * @property {Function} isConfigured
 */

/** @type {Map<string, AgentDefinition>} */
const _agentDefinitions = new Map();

function _initAgents() {
  if (_agentDefinitions.size > 0) return;
  _lazyLoadServices();

  _agentDefinitions.set("deepseek", {
    id: "deepseek",
    label: "DeepSeek (Backend)",
    role: "backend_agent",
    domain: "Backend-Entwicklung, APIs, Systemlogik, Datenbank, Services",
    provider: "deepseek",
    model: process.env.DEEPSEEK_FAST_MODEL || "deepseek-chat",
    supportedModes: [
      "backend_review", "api_review", "system_diagnostics",
      "code_review", "change_mode", "free_chat",
      "architecture", "security_review", "performance",
    ],
    supportedIntents: [...UNIFIED_ACTION_INTENTS],
    defaultSafetyLevel: "propose",
    defaultTimeoutMs: 25000,
    maxRetries: 1,
    enabled: true,
    isConfigured: () => {
      _lazyLoadServices();
      return _deepseekService?.isDeepSeekConfigured?.() ?? false;
    },
  });

  _agentDefinitions.set("gemini", {
    id: "gemini",
    label: "Gemini (Frontend)",
    role: "frontend_agent",
    domain: "Frontend-Entwicklung, UX, Architektur, UI-Komponenten",
    provider: "google",
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    supportedModes: [
      "layout_review", "darstellung", "frontend_guard",
      "priorisierung", "free_chat", "change_mode",
      "code_review", "architecture",
    ],
    supportedIntents: [...UNIFIED_ACTION_INTENTS],
    defaultSafetyLevel: "propose",
    defaultTimeoutMs: 70000,  // gemini-2.5-flash thinking model needs up to 60 s; add buffer
    maxRetries: 1,
    enabled: true,
    isConfigured: () => {
      _lazyLoadServices();
      return _geminiService?.isGeminiConfigured?.() ?? false;
    },
  });

  logger.info("[agentRegistry] Initialized with agents", {
    agents: [..._agentDefinitions.keys()],
  });
}

/* ─────────────────────────────────────────────
   Public API
   ───────────────────────────────────────────── */

function getAgent(agentId) {
  _initAgents();
  return _agentDefinitions.get(agentId) || null;
}

function getAllAgents() {
  _initAgents();
  return [..._agentDefinitions.values()];
}

function getAvailableAgents() {
  _initAgents();
  return [..._agentDefinitions.values()].filter(
    (a) => a.enabled && a.isConfigured(),
  );
}

function getAgentIds() {
  _initAgents();
  return [..._agentDefinitions.keys()];
}

function isAgentAvailable(agentId) {
  _initAgents();
  const agent = _agentDefinitions.get(agentId);
  return agent ? agent.enabled && agent.isConfigured() : false;
}

function getAgentCapabilities(agentId) {
  _initAgents();
  const agent = _agentDefinitions.get(agentId);
  if (!agent) return null;
  return {
    id: agent.id,
    label: agent.label,
    role: agent.role,
    domain: agent.domain,
    supportedModes: agent.supportedModes,
    supportedIntents: agent.supportedIntents,
    configured: agent.isConfigured(),
    enabled: agent.enabled,
    provider: agent.provider,
    model: agent.model,
  };
}

function getAgentHealth() {
  _initAgents();
  const health = {};
  for (const [id, agent] of _agentDefinitions) {
    const configured = agent.isConfigured();
    health[id] = {
      id,
      label: agent.label,
      enabled: agent.enabled,
      configured,
      healthy: agent.enabled && configured,
      provider: agent.provider,
      model: agent.model,
    };
  }
  return health;
}

function isIntentAllowedForSafetyLevel(intent, safetyLevel) {
  const level = SAFETY_LEVELS[safetyLevel];
  if (!level) return false;
  return level.allowedIntents.includes(intent);
}

function supportsIntent(agentId, intent) {
  _initAgents();
  const agent = _agentDefinitions.get(agentId);
  if (!agent) return false;
  return agent.supportedIntents.includes(intent);
}

function supportsMode(agentId, mode) {
  _initAgents();
  const agent = _agentDefinitions.get(agentId);
  if (!agent) return false;
  return agent.supportedModes.includes(mode);
}

/* ─────────────────────────────────────────────
   Exports
   ───────────────────────────────────────────── */

module.exports = {
  // Agent lookups
  getAgent,
  getAllAgents,
  getAvailableAgents,
  getAgentIds,
  isAgentAvailable,
  getAgentCapabilities,
  getAgentHealth,
  supportsIntent,
  supportsMode,

  // Safety / intent checks
  isIntentAllowedForSafetyLevel,
  UNIFIED_ACTION_INTENTS,
  SAFETY_LEVELS,

  // Path safety (single source of truth)
  ALLOWED_PROJECT_PATHS,
  BLOCKED_PATH_PATTERNS,
};
