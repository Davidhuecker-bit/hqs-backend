"use strict";

/**
 * ═══════════════════════════════════════════════════════════════
 *  HQS Request Classifier
 * ═══════════════════════════════════════════════════════════════
 *
 *  Central classification layer that turns an incoming user
 *  request into a structured routing decision before any agent
 *  service is called.
 *
 *  Responsibilities:
 *    ① detect user intention  (what does the user want?)
 *    ② map to agent           (deepseek / gemini / both / conference)
 *    ③ map to mode
 *    ④ map to actionIntent
 *    ⑤ detect follow-up vs. initial request
 *    ⑥ validate safety level
 * ═══════════════════════════════════════════════════════════════
 */

const logger = require("../utils/logger");
const {
  UNIFIED_ACTION_INTENTS,
  SAFETY_LEVELS,
  isIntentAllowedForSafetyLevel,
  isAgentAvailable,
  getAgent,
} = require("./agentRegistry.service");

/* ─────────────────────────────────────────────
   Keyword → Agent mapping
   ───────────────────────────────────────────── */

const BACKEND_KEYWORDS = [
  "backend", "api", "server", "service", "route", "endpoint",
  "datenbank", "database", "sql", "query", "migration",
  "middleware", "cron", "job", "worker", "queue",
  "deepseek", "node", "express", "controller",
  "systemlogik", "system-logik", "system logic",
];

const FRONTEND_KEYWORDS = [
  "frontend", "ui", "ux", "component", "komponente",
  "layout", "css", "style", "design", "darstellung",
  "react", "vue", "angular", "svelte", "html",
  "button", "modal", "dialog", "seite", "page",
  "gemini", "ansicht", "view", "anzeige",
];

const CONFERENCE_KEYWORDS = [
  "konferenz", "conference", "beide", "both",
  "zusammen", "gemeinsam", "koordiniert", "cross-agent",
  "full-stack", "fullstack", "end-to-end",
  "backend und frontend", "frontend und backend",
];

/* ─────────────────────────────────────────────
   Keyword → Action intent mapping
   ───────────────────────────────────────────── */

const INTENT_KEYWORDS = {
  explain:        ["erklär", "explain", "beschreib", "was ist", "what is", "wie funktioniert", "how does"],
  analyze:        ["analysier", "analyze", "prüf", "check", "untersuche", "review"],
  diagnose:       ["diagnos", "fehler", "bug", "problem", "issue", "warum", "why"],
  inspect_files:  ["datei", "file", "code zeig", "show code", "inspect", "anzeig"],
  propose_change: ["vorschlag", "vorschläge", "propose", "suggestion", "empfehl", "recommend", "änderungsvorschlag"],
  prepare_patch:  ["patch", "edit plan", "editplan", "vorbereiten", "prepare"],
  dry_run:        ["dry run", "dry-run", "trocken", "simulier", "simulate", "test run"],
  execute_change: ["ausführ", "execute", "apply", "anwend", "umsetzen", "schreib"],
  verify_fix:     ["verifizier", "verify", "prüfe fix", "check fix", "bestätig"],
  plan_fix:       ["plan", "strategie", "strategy", "roadmap", "schritte", "steps"],
};

/* ─────────────────────────────────────────────
   Keyword → Mode mapping
   ───────────────────────────────────────────── */

const MODE_KEYWORDS = {
  // Backend (DeepSeek)
  backend_review:      ["backend review", "backend-review"],
  api_review:          ["api review", "api-review", "endpoint review"],
  system_diagnostics:  ["system diagnostics", "systemdiagnose", "diagnose"],
  security_review:     ["security", "sicherheit", "vulnerability"],
  performance:         ["performance", "leistung", "optimier"],
  // Frontend (Gemini)
  layout_review:       ["layout review", "layout-review"],
  darstellung:         ["darstellung", "display", "anzeige"],
  frontend_guard:      ["frontend guard", "guard", "binding"],
  priorisierung:       ["priorisierung", "priorität", "priority"],
  // Shared
  code_review:         ["code review", "code-review"],
  architecture:        ["architektur", "architecture"],
  change_mode:         ["change mode", "änderungsmodus"],
  free_chat:           ["chat", "frage", "frei"],
};

/* ─────────────────────────────────────────────
   Core classification function
   ───────────────────────────────────────────── */

/**
 * @typedef {Object} ClassificationResult
 * @property {string}      targetAgent     - "deepseek" | "gemini" | "conference"
 * @property {string}      mode            - agent mode
 * @property {string|null} actionIntent    - resolved action intent
 * @property {string}      safetyLevel     - "read_only" | "propose" | "dry_run" | "execute"
 * @property {boolean}     isFollowUp      - whether this continues an existing conversation
 * @property {boolean}     isConference    - whether multiple agents should participate
 * @property {string}      confidence      - "high" | "medium" | "low"
 * @property {string[]}    reasoning       - classification steps
 * @property {string[]}    warnings        - any classification warnings
 */

/**
 * Classifies a user request into a routing decision.
 *
 * @param {Object} opts
 * @param {string}      opts.message          - user message
 * @param {string}      [opts.agent]          - explicit agent choice ("deepseek"|"gemini"|"conference")
 * @param {string}      [opts.mode]           - explicit mode
 * @param {string}      [opts.actionIntent]   - explicit action intent
 * @param {string}      [opts.safetyLevel]    - explicit safety level
 * @param {string}      [opts.conversationId] - existing conversation => follow-up
 * @param {string}      [opts.conferenceId]   - existing conference => follow-up
 * @returns {ClassificationResult}
 */
function classifyRequest(opts = {}) {
  const {
    message = "",
    agent,
    mode,
    actionIntent,
    safetyLevel,
    conversationId,
    conferenceId,
  } = opts;

  const result = {
    targetAgent:  null,
    mode:         null,
    actionIntent: null,
    safetyLevel:  safetyLevel ?? "propose",
    isFollowUp:   false,
    isConference:  false,
    confidence:   "low",
    reasoning:    [],
    warnings:     [],
  };

  const lowerMsg = (message || "").toLowerCase();

  // ① Follow-up detection
  if (conversationId || conferenceId) {
    result.isFollowUp = true;
    result.reasoning.push("Follow-up erkannt (bestehende ID)");
  }

  // ② Conference detection
  if (conferenceId) {
    result.isConference = true;
    result.targetAgent = "conference";
    result.reasoning.push("Konferenz-Kontext erkannt");
  }

  // ③ Explicit agent
  if (agent && !result.targetAgent) {
    const normalized = String(agent).toLowerCase().trim();
    if (normalized === "deepseek" || normalized === "gemini" || normalized === "conference" || normalized === "both") {
      result.targetAgent = normalized === "both" ? "conference" : normalized;
      result.reasoning.push(`Expliziter Agent: ${result.targetAgent}`);
      if (normalized === "both" || normalized === "conference") {
        result.isConference = true;
      }
    }
  }

  // ④ Keyword-based agent detection
  if (!result.targetAgent && lowerMsg) {
    const confScore = CONFERENCE_KEYWORDS.filter((k) => lowerMsg.includes(k)).length;
    const beScore = BACKEND_KEYWORDS.filter((k) => lowerMsg.includes(k)).length;
    const feScore = FRONTEND_KEYWORDS.filter((k) => lowerMsg.includes(k)).length;

    if (confScore > 0 && confScore >= beScore && confScore >= feScore) {
      result.targetAgent = "conference";
      result.isConference = true;
      result.reasoning.push(`Konferenz-Keywords erkannt (score: ${confScore})`);
    } else if (beScore > feScore) {
      result.targetAgent = "deepseek";
      result.reasoning.push(`Backend-Keywords erkannt (score: ${beScore} > ${feScore})`);
    } else if (feScore > beScore) {
      result.targetAgent = "gemini";
      result.reasoning.push(`Frontend-Keywords erkannt (score: ${feScore} > ${beScore})`);
    } else if (beScore > 0 && feScore > 0 && beScore === feScore) {
      result.targetAgent = "conference";
      result.isConference = true;
      result.reasoning.push("Gleichgewicht Backend/Frontend → Konferenz");
    }
  }

  // ⑤ Default agent fallback
  if (!result.targetAgent) {
    result.targetAgent = "deepseek";
    result.reasoning.push("Fallback: deepseek (kein klarer Agent erkannt)");
  }

  // ⑥ Resolve action intent
  if (actionIntent && UNIFIED_ACTION_INTENTS.includes(actionIntent)) {
    result.actionIntent = actionIntent;
    result.reasoning.push(`Expliziter Intent: ${actionIntent}`);
  } else if (lowerMsg) {
    for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
      if (keywords.some((k) => lowerMsg.includes(k))) {
        result.actionIntent = intent;
        result.reasoning.push(`Intent aus Keywords: ${intent}`);
        break;
      }
    }
  }

  // ⑦ Resolve mode
  if (mode) {
    result.mode = mode;
    result.reasoning.push(`Expliziter Modus: ${mode}`);
  } else if (lowerMsg) {
    for (const [m, keywords] of Object.entries(MODE_KEYWORDS)) {
      if (keywords.some((k) => lowerMsg.includes(k))) {
        result.mode = m;
        result.reasoning.push(`Modus aus Keywords: ${m}`);
        break;
      }
    }
  }

  // ⑧ Default mode based on agent
  if (!result.mode) {
    if (result.targetAgent === "deepseek") {
      result.mode = "free_chat";
    } else if (result.targetAgent === "gemini") {
      result.mode = "free_chat";
    } else {
      result.mode = "free_chat";
    }
    result.reasoning.push(`Default-Modus: ${result.mode}`);
  }

  // ⑨ Safety level validation
  if (result.actionIntent && !isIntentAllowedForSafetyLevel(result.actionIntent, result.safetyLevel)) {
    result.warnings.push(
      `Intent "${result.actionIntent}" ist auf Sicherheitsstufe "${result.safetyLevel}" nicht erlaubt`,
    );
  }

  // ⑩ Agent availability check
  if (result.targetAgent !== "conference" && !isAgentAvailable(result.targetAgent)) {
    result.warnings.push(`Agent "${result.targetAgent}" ist nicht konfiguriert/verfügbar`);
  }

  // ⑪ Confidence calculation
  const explicitCount = [agent, mode, actionIntent].filter(Boolean).length;
  if (explicitCount >= 2) {
    result.confidence = "high";
  } else if (explicitCount === 1 || result.reasoning.length >= 3) {
    result.confidence = "medium";
  }

  logger.info("[requestClassifier] classified request", {
    targetAgent: result.targetAgent,
    mode: result.mode,
    actionIntent: result.actionIntent,
    safetyLevel: result.safetyLevel,
    isFollowUp: result.isFollowUp,
    isConference: result.isConference,
    confidence: result.confidence,
    warningCount: result.warnings.length,
  });

  return result;
}

/* ─────────────────────────────────────────────
   Exports
   ───────────────────────────────────────────── */

module.exports = {
  classifyRequest,
  BACKEND_KEYWORDS,
  FRONTEND_KEYWORDS,
  CONFERENCE_KEYWORDS,
  INTENT_KEYWORDS,
  MODE_KEYWORDS,
};
