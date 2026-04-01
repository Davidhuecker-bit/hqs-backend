"use strict";

const logger = require("../utils/logger");

/* ─────────────────────────────────────────────
   Constants
   ───────────────────────────────────────────── */

const BRIDGE_VERSION = "v1";
const ACTIVE_BACKEND_AGENT = "deepseek_backend";

const VALID_HINT_TYPES = [
  "change_guard",
  "review",
  "ui_impact",
  "staleness",
  "contract_warning",
];

const VALID_SEVERITIES = ["low", "medium", "high"];

/* ─────────────────────────────────────────────
   In-memory bridge state (lightweight, no DB)
   Stores the most recently generated bridge
   package and any pending frontend feedback.
   ───────────────────────────────────────────── */

let _currentBridgePackage = null;
let _pendingFrontendFeedback = [];

/* ─────────────────────────────────────────────
   Input normalisation helpers
   ───────────────────────────────────────────── */

function toStr(value) {
  if (value == null) return "";
  return String(value).trim();
}

function toStringArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    return trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
  return [String(value)];
}

function normaliseHintType(raw) {
  const s = toStr(raw).toLowerCase();
  return VALID_HINT_TYPES.includes(s) ? s : "review";
}

function normaliseSeverity(raw) {
  const s = toStr(raw).toLowerCase();
  return VALID_SEVERITIES.includes(s) ? s : "medium";
}

/* ─────────────────────────────────────────────
   Bridge hint builder
   Converts a single raw hint object (coming
   from a DeepSeek analysis result) into a
   normalised, schema-conformant bridge hint.
   ───────────────────────────────────────────── */

function buildBridgeHint(raw = {}) {
  return {
    type:               normaliseHintType(raw.type),
    source:             toStr(raw.source) || ACTIVE_BACKEND_AGENT,
    title:              toStr(raw.title),
    summary:            toStr(raw.summary),
    severity:           normaliseSeverity(raw.severity),
    affectedAreas:      toStringArray(raw.affectedAreas),
    affectedFiles:      toStringArray(raw.affectedFiles),
    frontendImpact:     toStringArray(raw.frontendImpact),
    backendFollowups:   toStringArray(raw.backendFollowups),
    recommendedActions: toStringArray(raw.recommendedActions),
  };
}

/* ─────────────────────────────────────────────
   Derive bridge hints from a structured
   DeepSeek analysis result (change-intelligence,
   controller-guard, math-logic-review, etc.)
   ───────────────────────────────────────────── */

function deriveHintsFromDeepSeekResult(result = {}, sourceMode = "") {
  const hints = [];

  // ── change_guard / contract_warning signals ──
  const contractWarnings = toStringArray(result.contractWarnings);
  if (contractWarnings.length) {
    hints.push(buildBridgeHint({
      type:               "contract_warning",
      source:             ACTIVE_BACKEND_AGENT,
      title:              "Vertragsbrüche erkannt",
      summary:            contractWarnings.slice(0, 3).join("; "),
      severity:           result.guardLevel || result.riskLevel || "medium",
      affectedAreas:      toStringArray(result.affectedArea || result.lastKnownArea),
      affectedFiles:      toStringArray(result.likelyAffectedFiles),
      frontendImpact:     [],
      backendFollowups:   toStringArray(result.followupVerifications),
      recommendedActions: toStringArray(result.recommendedActions),
    }));
  }

  // ── staleness signals ──
  const stalenessRisks = toStringArray(result.stalenessRisks);
  if (stalenessRisks.length) {
    hints.push(buildBridgeHint({
      type:               "staleness",
      source:             ACTIVE_BACKEND_AGENT,
      title:              "Veraltete Read-Models erkannt",
      summary:            stalenessRisks.slice(0, 3).join("; "),
      severity:           result.guardLevel || "medium",
      affectedAreas:      toStringArray(result.affectedArea),
      affectedFiles:      toStringArray(result.likelyAffectedFiles),
      frontendImpact:     [],
      backendFollowups:   toStringArray(result.followupVerifications),
      recommendedActions: [],
    }));
  }

  // ── change_guard / root-cause signals ──
  const rootCauses = toStringArray(result.rootCauseHypotheses);
  if (rootCauses.length) {
    hints.push(buildBridgeHint({
      type:               "change_guard",
      source:             ACTIVE_BACKEND_AGENT,
      title:              "Änderungs-Impact erkannt",
      summary:            rootCauses.slice(0, 3).join("; "),
      severity:           result.riskLevel || "medium",
      affectedAreas:      toStringArray(result.affectedArea),
      affectedFiles:      toStringArray(result.likelyAffectedFiles),
      frontendImpact:     toStringArray(result.missingFollowupChanges),
      backendFollowups:   toStringArray(result.patchPlan),
      recommendedActions: toStringArray(result.recommendedActions),
    }));
  }

  // ── review / math-logic signals ──
  const detectedRisks = toStringArray(result.detectedRisks);
  if (detectedRisks.length) {
    hints.push(buildBridgeHint({
      type:               "review",
      source:             ACTIVE_BACKEND_AGENT,
      title:              "Analyse-Risiken erkannt",
      summary:            detectedRisks.slice(0, 3).join("; "),
      severity:           result.reviewLevel || "medium",
      affectedAreas:      [],
      affectedFiles:      [],
      frontendImpact:     [],
      backendFollowups:   toStringArray(result.recommendedChecks),
      recommendedActions: toStringArray(result.recommendedChecks),
    }));
  }

  // ── explicit bridgeHints passthrough ──
  const explicit = Array.isArray(result.bridgeHints) ? result.bridgeHints : [];
  for (const h of explicit) {
    hints.push(buildBridgeHint(h));
  }

  return hints;
}

/* ─────────────────────────────────────────────
   buildBridgePackage
   ─────────────────────────────────────────────
   Main export for Backend→Frontend direction.
   Accepts a structured DeepSeek result payload
   and returns a normalised bridge package that
   Gemini / the frontend can read.

   @param {Object} payload
   @param {string}  [payload.lastKnownArea]    – e.g. "hqs_assessment"
   @param {string}  [payload.lastKnownMode]    – e.g. "change_review"
   @param {string}  [payload.sourceMode]       – originating DeepSeek service
   @param {Object}  [payload.result]           – the raw DeepSeek result object
   @param {Array}   [payload.hints]            – explicit bridge hints (override)
   @returns {Object} bridge package (also stored in memory)
   ───────────────────────────────────────────── */
function buildBridgePackage(payload = {}) {
  const lastKnownArea = toStr(payload.lastKnownArea);
  const lastKnownMode = toStr(payload.lastKnownMode);
  const sourceMode    = toStr(payload.sourceMode);
  const rawResult     = payload.result && typeof payload.result === "object"
    ? payload.result
    : {};

  // Explicit hints override auto-derived hints when provided
  let bridgeHints;
  if (Array.isArray(payload.hints) && payload.hints.length) {
    bridgeHints = payload.hints.map(buildBridgeHint);
  } else {
    bridgeHints = deriveHintsFromDeepSeekResult(rawResult, sourceMode);
  }

  const pkg = {
    version:     BRIDGE_VERSION,
    generatedAt: new Date().toISOString(),
    backendState: {
      activeAgent:    ACTIVE_BACKEND_AGENT,
      lastKnownArea:  lastKnownArea || null,
      lastKnownMode:  lastKnownMode || sourceMode || null,
    },
    bridgeHints,
  };

  _currentBridgePackage = pkg;

  logger.info("[agentBridge] bridge package built", {
    hintsCount:    bridgeHints.length,
    lastKnownArea,
    lastKnownMode,
  });

  return pkg;
}

/* ─────────────────────────────────────────────
   getCurrentBridgePackage
   Returns the latest in-memory bridge package,
   or an empty shell if none has been generated.
   ───────────────────────────────────────────── */
function getCurrentBridgePackage() {
  if (_currentBridgePackage) {
    return _currentBridgePackage;
  }
  return {
    version:     BRIDGE_VERSION,
    generatedAt: null,
    backendState: {
      activeAgent:   ACTIVE_BACKEND_AGENT,
      lastKnownArea: null,
      lastKnownMode: null,
    },
    bridgeHints: [],
  };
}

/* ─────────────────────────────────────────────
   receiveFrontendFeedback
   ─────────────────────────────────────────────
   Frontend→Backend direction (V1 stub).
   Accepts structured Gemini/frontend hints and
   stores them in memory for later consumption.

   @param {Object} payload
   @param {string}  [payload.source]      – e.g. "gemini_frontend"
   @param {string}  [payload.area]        – frontend area that generated this
   @param {Array}   [payload.hints]       – array of frontend hint objects
   @param {string}  [payload.notes]       – optional plain-text note
   @returns {Object} acknowledgement
   ───────────────────────────────────────────── */
function receiveFrontendFeedback(payload = {}) {
  const source = toStr(payload.source) || "gemini_frontend";
  const area   = toStr(payload.area);
  const notes  = toStr(payload.notes);
  const hints  = Array.isArray(payload.hints) ? payload.hints : [];

  const entry = {
    receivedAt: new Date().toISOString(),
    source,
    area:   area || null,
    notes:  notes || null,
    hints:  hints.map((h) => buildBridgeHint({ ...h, source })),
  };

  _pendingFrontendFeedback.push(entry);

  // Keep at most 50 pending entries (simple guard against unbounded growth)
  if (_pendingFrontendFeedback.length > 50) {
    _pendingFrontendFeedback = _pendingFrontendFeedback.slice(-50);
  }

  logger.info("[agentBridge] frontend feedback received", {
    source,
    area,
    hintsCount: entry.hints.length,
  });

  return {
    accepted:   true,
    hintsCount: entry.hints.length,
    receivedAt: entry.receivedAt,
  };
}

/* ─────────────────────────────────────────────
   getPendingFrontendFeedback
   Returns all stored frontend feedback entries
   (useful for backend inspection / debugging).
   ───────────────────────────────────────────── */
function getPendingFrontendFeedback() {
  return [..._pendingFrontendFeedback];
}

module.exports = {
  buildBridgePackage,
  getCurrentBridgePackage,
  receiveFrontendFeedback,
  getPendingFrontendFeedback,
  BRIDGE_VERSION,
  VALID_HINT_TYPES,
  VALID_SEVERITIES,
};
