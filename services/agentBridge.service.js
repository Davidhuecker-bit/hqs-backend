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
  "schema_risk",
  "binding_risk",
  "field_risk",
];

const VALID_SEVERITIES = ["low", "medium", "high"];

/* ─────────────────────────────────────────────
   Workflow orchestration constants
   ─────────────────────────────────────────────
   Maps DeepSeek hint types and patterns to
   recommended Gemini review modes, review
   intents and inspection focus categories.
   ───────────────────────────────────────────── */

const VALID_GEMINI_MODES = [
  "layout_review",
  "presentation_review",
  "frontend_guard",
  "priority_review",
];

const VALID_REVIEW_INTENTS = [
  "structure_check",       // layout / structural issues
  "display_check",         // presentation / readability
  "binding_guard",         // schema / field / binding risks
  "priority_check",        // priority / weighting issues
  "general_review",        // no specific focus detected
];

const VALID_FEEDBACK_CATEGORIES = [
  "guard",
  "layout",
  "priority",
  "presentation",
  "general",
];

/* ─────────────────────────────────────────────
   Step 3 – Cooperative change / workflow /
   learning layer constants
   ─────────────────────────────────────────────
   These extend the bridge with impact-context,
   follow-up categories and learning-signal
   structure so that DeepSeek and Gemini can
   cooperate more effectively.
   ───────────────────────────────────────────── */

/** Suggested follow-up action types (cooperative, not prescriptive) */
const VALID_FOLLOWUP_TYPES = [
  "review_followup",
  "ui_adjustment_followup",
  "binding_followup",
  "schema_followup",
  "priority_followup",
  "presentation_followup",
  "none",
];

/** Layer labels for impact scope */
const VALID_IMPACT_LAYERS = [
  "backend_logic",
  "backend_schema",
  "api_contract",
  "frontend_binding",
  "frontend_layout",
  "frontend_presentation",
  "frontend_priority",
  "cross_layer",
];

/** Maps hint types → most likely affected frontend layer */
const HINT_TYPE_TO_AFFECTED_LAYER = {
  schema_risk:       "frontend_binding",
  binding_risk:      "frontend_binding",
  field_risk:        "frontend_binding",
  contract_warning:  "api_contract",
  ui_impact:         "frontend_presentation",
  staleness:         "frontend_layout",
  change_guard:      "backend_logic",
  review:            "cross_layer",
};

/** Maps hint types → suggested follow-up type */
const HINT_TYPE_TO_FOLLOWUP = {
  schema_risk:       "schema_followup",
  binding_risk:      "binding_followup",
  field_risk:        "binding_followup",
  contract_warning:  "schema_followup",
  ui_impact:         "presentation_followup",
  staleness:         "ui_adjustment_followup",
  change_guard:      "review_followup",
  review:            "review_followup",
};

/** Maps feedback categories → likely backend cause area */
const FEEDBACK_TO_LIKELY_CAUSE = {
  guard:         "backend_schema",
  layout:        "backend_logic",
  priority:      "backend_logic",
  presentation:  "frontend_presentation",
  general:       "cross_layer",
};

/**
 * Maps hint types → recommended Gemini mode.
 * Used as primary signal; severity and keyword analysis refine the choice.
 */
const HINT_TYPE_TO_GEMINI_MODE = {
  schema_risk:       "frontend_guard",
  binding_risk:      "frontend_guard",
  field_risk:        "frontend_guard",
  contract_warning:  "frontend_guard",
  ui_impact:         "presentation_review",
  staleness:         "layout_review",
  change_guard:      "layout_review",
  review:            "priority_review",
};

/**
 * Maps hint types → review intent label.
 */
const HINT_TYPE_TO_REVIEW_INTENT = {
  schema_risk:       "binding_guard",
  binding_risk:      "binding_guard",
  field_risk:        "binding_guard",
  contract_warning:  "binding_guard",
  ui_impact:         "display_check",
  staleness:         "structure_check",
  change_guard:      "structure_check",
  review:            "priority_check",
};

/**
 * Keyword patterns that override the type-based mode selection.
 * Checked against combined title+summary text (lowercase).
 */
const MODE_OVERRIDE_KEYWORDS = {
  frontend_guard:      ["binding", "schema", "feld", "field", "veraltetes feld", "contract", "vertrag"],
  presentation_review: ["darstellung", "anzeige", "lesbar", "farb", "status-signal", "inkonsistent"],
  layout_review:       ["layout", "hierarchie", "struktur", "gruppierung", "abstand", "dichte"],
  priority_review:     ["priorit", "gewicht", "reihenfolge", "dringlich", "prominenz", "rangfolge"],
};

/** Severity ordering for sorting (higher = more critical) */
const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 };

/** Maximum string length for any single text field */
const MAX_TEXT_LENGTH = 1500;

/** Maximum items per array field */
const MAX_ARRAY_ITEMS = 10;

/** Minimum characters for an array entry to be considered meaningful */
const MIN_ENTRY_LENGTH = 4;

/** Maximum hints per bridge package */
const MAX_BRIDGE_HINTS = 15;

/** Maximum pending frontend feedback entries kept in memory */
const MAX_PENDING_FEEDBACK = 50;

/** Maximum follow-up / layer items per focus object */
const MAX_FOCUS_ITEMS = 6;

/** Maximum entries tracked in the in-memory pattern memory */
const MAX_PATTERN_MEMORY_ENTRIES = 200;

/** Max characters of title used for dedup key */
const DEDUP_TITLE_MAX_LENGTH = 80;

/** Max affected files compared for dedup */
const DEDUP_MAX_FILES = 3;

/** Keyword signals that should upgrade severity to 'high' */
const HIGH_SEVERITY_KEYWORDS = [
  "breaking", "bruch", "absturz", "crash", "critical",
  "datenverlust", "data loss", "sicherheit", "security",
  "vertragsbruch", "contract violation",
];

/** Keyword signals that should upgrade severity from 'low' to 'medium' */
const MEDIUM_SEVERITY_KEYWORDS = [
  "risiko", "risk", "warnung", "warning", "veraltet",
  "stale", "inkonsistent", "inconsistent", "fehlend", "missing",
];

/* ─────────────────────────────────────────────
   Step 6 – Action Readiness / Recommendation
   Quality Light
   ─────────────────────────────────────────────
   A lightweight maturity layer that helps the
   HQS system distinguish:
   - early signals (observation only)
   - useful follow-up checks
   - actionable next-step recommendations
   - more mature, higher-quality recommendations

   This is NOT auto-execution or autonomous
   decision logic.  It only provides a transparent,
   deterministic readiness classification so the
   system can later formulate better next steps.
   ───────────────────────────────────────────── */

/**
 * Action readiness bands – how mature / actionable
 * a recommendation appears based on available evidence.
 *
 * Deliberately kept separate from confidence / trust:
 *   high trust ≠ high readiness
 *   (a well-observed pattern may still only warrant monitoring)
 */
const VALID_ACTION_READINESS_BANDS = [
  "observation",                // early signal – only watch
  "further_check_recommended",  // warrants a follow-up inspection
  "useful_next_step",           // actionable recommendation
  "mature_recommendation",      // strong evidence, clear next step
];

/**
 * Recommended action types – cooperative language for
 * what kind of next step might be appropriate.
 *
 * The system never executes these automatically.
 * They help later UI/admin surfaces show richer context.
 */
const VALID_RECOMMENDED_ACTION_TYPES = [
  "observe",                // nur beobachten
  "check_ui",               // UI prüfen
  "check_binding",          // Binding prüfen
  "check_layout",           // Layout prüfen
  "re_evaluate_priority",   // Priorität neu bewerten
  "run_followup",           // Folgeprüfung erneut ausführen
  "prepare_change",         // Änderung vorbereiten
];

/**
 * Maps follow-up types → most fitting recommended action type.
 * Used as fallback when no explicit action type can be inferred.
 */
const FOLLOWUP_TO_ACTION_TYPE = {
  review_followup:          "observe",
  ui_adjustment_followup:   "check_ui",
  binding_followup:         "check_binding",
  schema_followup:          "check_binding",
  priority_followup:        "re_evaluate_priority",
  presentation_followup:    "check_layout",
  none:                     "observe",
};

/* ─────────────────────────────────────────────
   In-memory bridge state (lightweight, no DB)
   Stores the most recently generated bridge
   package and any pending frontend feedback.
   ───────────────────────────────────────────── */

let _currentBridgePackage = null;
let _pendingFrontendFeedback = [];

/* ─────────────────────────────────────────────
   Step 4: In-memory pattern memory (lightweight)
   ─────────────────────────────────────────────
   Tracks recurring pattern keys and their
   associated metadata so the system can learn
   which cause→effect→follow-up combinations
   occur frequently.  No database – purely
   in-memory, intentionally ephemeral.
   ───────────────────────────────────────────── */

/** @type {Map<string, PatternMemoryEntry>} */
const _patternMemory = new Map();

/* ─────────────────────────────────────────────
   Input normalisation helpers
   ───────────────────────────────────────────── */

function toStr(value) {
  if (value == null) return "";
  return String(value).trim();
}

/** Truncate a string to MAX_TEXT_LENGTH, appending … if truncated */
function capText(value, maxLen = MAX_TEXT_LENGTH) {
  const s = toStr(value);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

function toStringArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((v) => (v == null ? "" : String(v).trim()))
      .filter((s) => s.length >= MIN_ENTRY_LENGTH);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    return trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((s) => s.length >= MIN_ENTRY_LENGTH);
  }
  const s = String(value).trim();
  return s.length >= MIN_ENTRY_LENGTH ? [s] : [];
}

/** Deduplicate + cap array length */
function normaliseArrayField(value, max = MAX_ARRAY_ITEMS) {
  const arr = toStringArray(value);
  const seen = new Set();
  const deduped = [];
  for (const item of arr) {
    const lower = item.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      deduped.push(item);
    }
  }
  return deduped.slice(0, max);
}

function normaliseHintType(raw) {
  const s = toStr(raw).toLowerCase().replace(/[\s-]+/g, "_");
  return VALID_HINT_TYPES.includes(s) ? s : "review";
}

function normaliseSeverity(raw) {
  const s = toStr(raw).toLowerCase();
  if (VALID_SEVERITIES.includes(s)) return s;
  // Map common aliases
  if (s === "critical" || s === "severe" || s === "error") return "high";
  if (s === "warning" || s === "moderate" || s === "warn") return "medium";
  if (s === "info" || s === "minor" || s === "trivial" || s === "note") return "low";
  return "medium";
}

/** Upgrade severity based on keyword signals in title/summary */
function applySeverityGuard(hint) {
  const text = `${hint.title} ${hint.summary}`.toLowerCase();

  if (hint.severity !== "high" && HIGH_SEVERITY_KEYWORDS.some((kw) => text.includes(kw))) {
    hint.severity = "high";
  } else if (hint.severity === "low" && MEDIUM_SEVERITY_KEYWORDS.some((kw) => text.includes(kw))) {
    hint.severity = "medium";
  }
  return hint;
}

/* ─────────────────────────────────────────────
   Workflow orchestration helpers
   ─────────────────────────────────────────────
   Derive reviewIntent, recommendedGeminiMode
   and inspectionFocus from the hint set produced
   by a bridge package build.  These keep the
   DeepSeek→Bridge→Gemini chain coordinated
   without introducing new persistence or a
   heavyweight rule engine.
   ───────────────────────────────────────────── */

/**
 * Derive the best-fitting Gemini review mode from the hint set.
 *
 * Strategy:
 *  1. Count votes by hint type → mode mapping.
 *  2. Apply keyword overrides from combined hint text.
 *  3. High-severity binding/schema hints always win → frontend_guard.
 *  4. Default: layout_review.
 */
function deriveRecommendedGeminiMode(hints) {
  if (!hints || !hints.length) return "layout_review";

  // Tally votes per mode from hint types
  const votes = {};
  for (const h of hints) {
    const mode = HINT_TYPE_TO_GEMINI_MODE[h.type] || "layout_review";
    votes[mode] = (votes[mode] || 0) + (SEVERITY_WEIGHT[h.severity] || 1);
  }

  // Keyword override pass – check combined text of all hints
  const combinedText = hints
    .map((h) => `${h.title} ${h.summary}`)
    .join(" ")
    .toLowerCase();

  for (const [mode, keywords] of Object.entries(MODE_OVERRIDE_KEYWORDS)) {
    if (keywords.some((kw) => combinedText.includes(kw))) {
      votes[mode] = (votes[mode] || 0) + 2;
    }
  }

  // High-severity binding/schema hints force frontend_guard
  const hasHighBindingRisk = hints.some(
    (h) =>
      h.severity === "high" &&
      ["schema_risk", "binding_risk", "field_risk", "contract_warning"].includes(h.type)
  );
  if (hasHighBindingRisk) {
    return "frontend_guard";
  }

  // Pick mode with highest weighted vote
  let best = "layout_review";
  let bestScore = 0;
  for (const [mode, score] of Object.entries(votes)) {
    if (score > bestScore && VALID_GEMINI_MODES.includes(mode)) {
      best = mode;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Derive a concise review intent label from the hint set.
 */
function deriveReviewIntent(hints) {
  if (!hints || !hints.length) return "general_review";

  // Use highest-severity hint's type for intent
  const sorted = [...hints].sort(
    (a, b) => (SEVERITY_WEIGHT[b.severity] || 0) - (SEVERITY_WEIGHT[a.severity] || 0)
  );
  const topHint = sorted[0];
  return HINT_TYPE_TO_REVIEW_INTENT[topHint.type] || "general_review";
}

/**
 * Classify a category from hint types alone (shared by
 * deriveInspectionFocus and classifyFeedbackCategory).
 */
function classifyCategoryByHintTypes(hints) {
  const typeCounts = {};
  for (const h of hints) {
    typeCounts[h.type] = (typeCounts[h.type] || 0) + 1;
  }
  if ((typeCounts.schema_risk || 0) + (typeCounts.binding_risk || 0) +
      (typeCounts.field_risk || 0) + (typeCounts.contract_warning || 0) > 0) {
    return "guard";
  }
  if ((typeCounts.ui_impact || 0) > 0) return "presentation";
  if ((typeCounts.change_guard || 0) + (typeCounts.staleness || 0) > 0) return "layout";
  if ((typeCounts.review || 0) > 0) return "priority";
  return "general";
}

/**
 * Derive a structured inspection focus object from the hint set.
 * Summarises which areas/views/components are affected and what
 * kind of inspection the Gemini side should prioritise.
 *
 * Step 3: Adds suggestedFollowupTypes and likelyAffectedLayers
 * so Gemini gets cooperative guidance on what kind of follow-up
 * and which layers are probably involved.
 */
function deriveInspectionFocus(hints) {
  if (!hints || !hints.length) {
    return {
      category:                "general",
      affectedViews:           [],
      affectedComponents:      [],
      affectedFields:          [],
      needsFollowup:           false,
      suggestedFollowupTypes:  [],
      likelyAffectedLayers:    [],
    };
  }

  // Collect unique affected areas / files as proxy for views/components
  const views      = new Set();
  const components = new Set();
  const fields     = new Set();
  const followupTypes = new Set();
  const layers        = new Set();
  let needsFollowup = false;

  for (const h of hints) {
    for (const area of h.affectedAreas || [])  views.add(area);
    for (const file of h.affectedFiles || [])  components.add(file);
    for (const imp of h.frontendImpact || [])  fields.add(imp);
    if ((h.backendFollowups || []).length > 0)  needsFollowup = true;
    if (h.severity === "high")                  needsFollowup = true;
    // Step 3: collect follow-up types and layers from hints
    if (h.suggestedFollowupType && h.suggestedFollowupType !== "none") {
      followupTypes.add(h.suggestedFollowupType);
    }
    if (h.likelyAffectedLayer) {
      layers.add(h.likelyAffectedLayer);
    }
  }

  const category = classifyCategoryByHintTypes(hints);

  return {
    category,
    affectedViews:          [...views].slice(0, MAX_ARRAY_ITEMS),
    affectedComponents:     [...components].slice(0, MAX_ARRAY_ITEMS),
    affectedFields:         [...fields].slice(0, MAX_ARRAY_ITEMS),
    needsFollowup,
    suggestedFollowupTypes: [...followupTypes].slice(0, MAX_FOCUS_ITEMS),
    likelyAffectedLayers:   [...layers].slice(0, MAX_FOCUS_ITEMS),
  };
}

/**
 * Classify a frontend feedback payload into a category.
 * Used so the backend can later understand what kind of
 * Gemini response came back.
 */
function classifyFeedbackCategory(hints, notes) {
  if (!hints || !hints.length) {
    return "general";
  }

  const text = hints
    .map((h) => `${h.title || ""} ${h.summary || ""}`)
    .join(" ")
    .toLowerCase();

  // Guard signals
  if (["binding", "schema", "feld", "field", "contract", "vertrag"].some((kw) => text.includes(kw))) {
    return "guard";
  }
  // Layout signals
  if (["layout", "hierarchie", "struktur", "gruppierung"].some((kw) => text.includes(kw))) {
    return "layout";
  }
  // Priority signals
  if (["priorit", "gewicht", "reihenfolge", "dringlich"].some((kw) => text.includes(kw))) {
    return "priority";
  }
  // Presentation signals
  if (["darstellung", "anzeige", "lesbar", "farb", "inkonsistent"].some((kw) => text.includes(kw))) {
    return "presentation";
  }

  // Fall back to hint-type-based classification
  return classifyCategoryByHintTypes(hints);
}

/* ─────────────────────────────────────────────
   Bridge hint builder
   Converts a single raw hint object (coming
   from a DeepSeek analysis result) into a
   normalised, schema-conformant bridge hint.
   ───────────────────────────────────────────── */

function buildBridgeHint(raw = {}) {
  const type = normaliseHintType(raw.type);
  const hint = {
    type,
    source:             toStr(raw.source) || ACTIVE_BACKEND_AGENT,
    title:              capText(raw.title, 200),
    summary:            capText(raw.summary, 600),
    severity:           normaliseSeverity(raw.severity),
    affectedAreas:      normaliseArrayField(raw.affectedAreas),
    affectedFiles:      normaliseArrayField(raw.affectedFiles),
    frontendImpact:     normaliseArrayField(raw.frontendImpact),
    backendFollowups:   normaliseArrayField(raw.backendFollowups),
    recommendedActions: normaliseArrayField(raw.recommendedActions),
    // ── Step 3: Impact context (cooperative, not prescriptive) ──
    impactScope:              capText(raw.impactScope, 200) || null,
    likelyAffectedLayer:      normaliseLikelyLayer(raw.likelyAffectedLayer, type),
    suggestedFollowupType:    normaliseSuggestedFollowup(raw.suggestedFollowupType, type),
    likelyAffectedArtifacts:  normaliseArrayField(raw.likelyAffectedArtifacts),
    changeImpactSummary:      capText(raw.changeImpactSummary, 400) || null,
  };
  return applySeverityGuard(hint);
}

/** Normalise likelyAffectedLayer – fall back to type-based mapping */
function normaliseLikelyLayer(raw, hintType) {
  const s = toStr(raw).toLowerCase().replace(/[\s-]+/g, "_");
  if (VALID_IMPACT_LAYERS.includes(s)) return s;
  return HINT_TYPE_TO_AFFECTED_LAYER[hintType] || "cross_layer";
}

/** Normalise suggestedFollowupType – fall back to type-based mapping */
function normaliseSuggestedFollowup(raw, hintType) {
  const s = toStr(raw).toLowerCase().replace(/[\s-]+/g, "_");
  if (VALID_FOLLOWUP_TYPES.includes(s)) return s;
  return HINT_TYPE_TO_FOLLOWUP[hintType] || "review_followup";
}

/* ─────────────────────────────────────────────
   Hint quality checks
   ───────────────────────────────────────────── */

/** Returns true if a hint has enough substance to be useful */
function isHintMeaningful(hint) {
  // Must have at least a title or summary with real content
  if (!hint.title && !hint.summary) return false;
  // Very short title + no summary → too weak
  if ((hint.title.length + hint.summary.length) < 10) return false;
  return true;
}

/** Generate a stable dedup key for a hint to detect near-duplicates */
function hintDedupKey(hint) {
  const normTitle = hint.title.toLowerCase().replace(/\s+/g, " ").slice(0, DEDUP_TITLE_MAX_LENGTH);
  const normType  = hint.type;
  const normFiles = hint.affectedFiles.slice(0, DEDUP_MAX_FILES).sort().join(",").toLowerCase();
  return `${normType}::${normTitle}::${normFiles}`;
}

/** Deduplicate hints, filter weak ones, sort by severity */
function filterAndPrioritiseHints(hints) {
  const seen = new Set();
  const kept = [];
  const dropped = { weak: 0, duplicate: 0 };

  for (const hint of hints) {
    if (!isHintMeaningful(hint)) {
      dropped.weak++;
      continue;
    }
    const key = hintDedupKey(hint);
    if (seen.has(key)) {
      dropped.duplicate++;
      continue;
    }
    seen.add(key);
    kept.push(hint);
  }

  // Sort: high → medium → low
  kept.sort((a, b) => (SEVERITY_WEIGHT[b.severity] || 0) - (SEVERITY_WEIGHT[a.severity] || 0));

  // Cap total hints
  const capped = kept.slice(0, MAX_BRIDGE_HINTS);
  if (kept.length > MAX_BRIDGE_HINTS) {
    dropped.weak += kept.length - MAX_BRIDGE_HINTS;
  }

  return { hints: capped, dropped };
}

/* ─────────────────────────────────────────────
   Derive bridge hints from a structured
   DeepSeek analysis result (change-intelligence,
   controller-guard, math-logic-review, etc.)

   Step 2: Clearer hint derivation with better
   type mapping, richer context, and source mode
   tracking for Gemini handoff clarity.
   ───────────────────────────────────────────── */

function deriveHintsFromDeepSeekResult(result = {}, sourceMode = "") {
  const hints = [];
  const src = sourceMode || ACTIVE_BACKEND_AGENT;

  // ── contract_warning signals ──
  const contractWarnings = toStringArray(result.contractWarnings);
  if (contractWarnings.length) {
    hints.push(buildBridgeHint({
      type:               "contract_warning",
      source:             src,
      title:              `Vertragsbrüche erkannt (${src})`,
      summary:            contractWarnings.slice(0, 5).join("; "),
      severity:           result.guardLevel || result.riskLevel || "high",
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
      source:             src,
      title:              `Veraltete Read-Models / Stale-Risiko (${src})`,
      summary:            stalenessRisks.slice(0, 5).join("; "),
      severity:           result.guardLevel || "medium",
      affectedAreas:      toStringArray(result.affectedArea),
      affectedFiles:      toStringArray(result.likelyAffectedFiles),
      frontendImpact:     [],
      backendFollowups:   toStringArray(result.followupVerifications),
      recommendedActions: toStringArray(result.recommendedActions),
    }));
  }

  // ── change_guard / root-cause signals ──
  const rootCauses = toStringArray(result.rootCauseHypotheses);
  if (rootCauses.length) {
    hints.push(buildBridgeHint({
      type:               "change_guard",
      source:             src,
      title:              `Änderungs-Impact: Root-Cause-Analyse (${src})`,
      summary:            rootCauses.slice(0, 5).join("; "),
      severity:           result.riskLevel || "medium",
      affectedAreas:      toStringArray(result.affectedArea),
      affectedFiles:      toStringArray(result.likelyAffectedFiles),
      frontendImpact:     toStringArray(result.missingFollowupChanges),
      backendFollowups:   toStringArray(result.patchPlan),
      recommendedActions: toStringArray(result.recommendedActions),
    }));
  }

  // ── review / math-logic / risk signals ──
  const detectedRisks = toStringArray(result.detectedRisks);
  if (detectedRisks.length) {
    hints.push(buildBridgeHint({
      type:               "review",
      source:             src,
      title:              `Analyse-Risiken: Prüfbedarf (${src})`,
      summary:            detectedRisks.slice(0, 5).join("; "),
      severity:           result.reviewLevel || "medium",
      affectedAreas:      toStringArray(result.affectedArea),
      affectedFiles:      toStringArray(result.likelyAffectedFiles),
      frontendImpact:     [],
      backendFollowups:   toStringArray(result.recommendedChecks),
      recommendedActions: toStringArray(result.recommendedChecks),
    }));
  }

  // ── UI impact signals (new in Step 2) ──
  const uiImpact = toStringArray(result.frontendImpact || result.uiImpact);
  if (uiImpact.length) {
    hints.push(buildBridgeHint({
      type:               "ui_impact",
      source:             src,
      title:              `Frontend-Auswirkung erkannt (${src})`,
      summary:            uiImpact.slice(0, 5).join("; "),
      severity:           result.riskLevel || "medium",
      affectedAreas:      toStringArray(result.affectedArea),
      affectedFiles:      toStringArray(result.likelyAffectedFiles),
      frontendImpact:     uiImpact,
      backendFollowups:   [],
      recommendedActions: toStringArray(result.recommendedActions),
    }));
  }

  // ── schema / field / binding risk signals (new in Step 2) ──
  const schemaRisks = toStringArray(result.schemaRisks || result.bindingRisks || result.fieldRisks);
  if (schemaRisks.length) {
    hints.push(buildBridgeHint({
      type:               "schema_risk",
      source:             src,
      title:              `Schema-/Binding-Risiko (${src})`,
      summary:            schemaRisks.slice(0, 5).join("; "),
      severity:           result.riskLevel || "high",
      affectedAreas:      toStringArray(result.affectedArea),
      affectedFiles:      toStringArray(result.likelyAffectedFiles),
      frontendImpact:     toStringArray(result.frontendImpact),
      backendFollowups:   toStringArray(result.followupVerifications),
      recommendedActions: toStringArray(result.recommendedActions),
    }));
  }

  // ── missing follow-up changes (standalone, if not covered above) ──
  const missingFollowups = toStringArray(result.missingFollowupChanges);
  if (missingFollowups.length && !rootCauses.length) {
    hints.push(buildBridgeHint({
      type:               "change_guard",
      source:             src,
      title:              `Fehlende Folgeänderungen (${src})`,
      summary:            missingFollowups.slice(0, 5).join("; "),
      severity:           result.riskLevel || "medium",
      affectedAreas:      toStringArray(result.affectedArea),
      affectedFiles:      toStringArray(result.likelyAffectedFiles),
      frontendImpact:     missingFollowups,
      backendFollowups:   [],
      recommendedActions: toStringArray(result.recommendedActions),
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
   Normalise backendState for consistent shape
   ───────────────────────────────────────────── */

function normaliseBackendState(payload = {}) {
  const lastKnownArea = capText(payload.lastKnownArea, 100);
  const lastKnownMode = capText(payload.lastKnownMode, 100);
  const sourceMode    = capText(payload.sourceMode, 100);

  return {
    activeAgent:    ACTIVE_BACKEND_AGENT,
    lastKnownArea:  lastKnownArea || null,
    lastKnownMode:  lastKnownMode || sourceMode || null,
    sourceMode:     sourceMode || null,
  };
}

/* ─────────────────────────────────────────────
   Step 3: Impact translation helper
   ─────────────────────────────────────────────
   Translates the hint set into a cooperative
   Backend→Frontend impact summary so that
   Gemini / the frontend understands not just
   "there is a problem" but rather "this kind
   of problem probably affects this frontend
   layer and this kind of follow-up check".
   ───────────────────────────────────────────── */

function deriveImpactTranslation(hints) {
  if (!hints || !hints.length) {
    return {
      impactSummary:           "Keine Auffälligkeiten erkannt.",
      likelyAffectedLayers:    [],
      suggestedFollowupTypes:  [],
      affectedArtifactHints:   [],
      impactKind:              "none",
    };
  }

  const layers    = new Set();
  const followups = new Set();
  const artifacts = new Set();
  const kindVotes = {};

  for (const h of hints) {
    if (h.likelyAffectedLayer) layers.add(h.likelyAffectedLayer);
    if (h.suggestedFollowupType && h.suggestedFollowupType !== "none") {
      followups.add(h.suggestedFollowupType);
    }
    for (const a of h.likelyAffectedArtifacts || []) artifacts.add(a);

    // Determine what kind of impact this is
    const kind = h.likelyAffectedLayer && h.likelyAffectedLayer.startsWith("frontend_")
      ? h.likelyAffectedLayer.replace("frontend_", "")
      : h.likelyAffectedLayer || "general";
    kindVotes[kind] = (kindVotes[kind] || 0) + (SEVERITY_WEIGHT[h.severity] || 1);
  }

  // Pick the dominant impact kind
  let bestKind = "general";
  let bestKindScore = 0;
  for (const [kind, score] of Object.entries(kindVotes)) {
    if (score > bestKindScore) {
      bestKind = kind;
      bestKindScore = score;
    }
  }

  // Build a cooperative summary sentence
  const layerList = [...layers];
  const followupList = [...followups];
  const summaryParts = [];

  if (layerList.length) {
    summaryParts.push(
      `Wahrscheinlich betroffene Schichten: ${layerList.join(", ")}.`
    );
  }
  if (followupList.length) {
    summaryParts.push(
      `Empfohlene Folgeprüfungen: ${followupList.map(f => f.replace(/_/g, " ")).join(", ")}.`
    );
  }

  return {
    impactSummary:           summaryParts.join(" ") || "Mögliche Auswirkungen erkannt – Folgeprüfung empfohlen.",
    likelyAffectedLayers:    layerList.slice(0, MAX_FOCUS_ITEMS),
    suggestedFollowupTypes:  followupList.slice(0, MAX_FOCUS_ITEMS),
    affectedArtifactHints:   [...artifacts].slice(0, MAX_ARRAY_ITEMS),
    impactKind:              bestKind,
  };
}

/* ─────────────────────────────────────────────
   Step 6: Package-level action readiness
   ─────────────────────────────────────────────
   Assesses the overall action readiness of a
   bridge package based on its hints.  This is
   a lightweight, transparent check – NOT a
   learning-signal assessment (that happens
   in receiveFrontendFeedback).

   Keeps trust and readiness deliberately
   separate:  many hints ≠ mature recommendation.
   ───────────────────────────────────────────── */

/**
 * Assess action readiness for a bridge package.
 *
 * @param {Array}  hints       – filtered bridge hints
 * @param {string} patternKey  – the bridge-level pattern key
 * @returns {{ band: string, actionType: string, reason: string }}
 */
function _assessPackageReadiness(hints, patternKey) {
  if (!hints || hints.length === 0) {
    return {
      band:       "observation",
      actionType: "observe",
      reason:     "Keine Hinweise vorhanden – nur Beobachtung.",
    };
  }

  let score = 0;
  const reasons = [];

  // Hint richness
  if (hints.length >= 5) { score += 2; reasons.push(`${hints.length} Hinweise vorhanden`); }
  else if (hints.length >= 2) { score += 1; reasons.push(`${hints.length} Hinweise vorhanden`); }

  // Severity presence
  const highCount = hints.filter((h) => h.severity === "high").length;
  const medCount  = hints.filter((h) => h.severity === "medium").length;
  if (highCount >= 2) { score += 3; reasons.push(`${highCount} dringliche Hinweise`); }
  else if (highCount >= 1) { score += 2; reasons.push("1 dringlicher Hinweis"); }
  if (medCount >= 2) { score += 1; reasons.push(`${medCount} mittlere Hinweise`); }

  // Follow-up types present (indicates clearer next steps)
  const followups = new Set();
  for (const h of hints) {
    if (h.suggestedFollowupType && h.suggestedFollowupType !== "none") {
      followups.add(h.suggestedFollowupType);
    }
  }
  if (followups.size >= 2) { score += 2; reasons.push("Mehrere Folgeprüfungstypen erkannt"); }
  else if (followups.size >= 1) { score += 1; reasons.push("Folgeprüfungstyp erkannt"); }

  // Pattern confirmation from memory
  const patternEntry = patternKey ? _patternMemory.get(patternKey) : null;
  if (patternEntry && patternEntry.count >= 3) {
    score += 2;
    reasons.push(`Muster ${patternEntry.count}x bestätigt`);
  }

  // Classify band
  let band;
  if (score >= 8) band = "mature_recommendation";
  else if (score >= 5) band = "useful_next_step";
  else if (score >= 2) band = "further_check_recommended";
  else band = "observation";

  // Derive action type from dominant follow-up
  const dominantFollowup = followups.size > 0 ? [...followups][0] : "none";
  let actionType = FOLLOWUP_TO_ACTION_TYPE[dominantFollowup] || "observe";

  // Override: observation band always → observe
  if (band === "observation") actionType = "observe";
  // Override: high binding risk → check_binding
  if (highCount > 0 && hints.some((h) =>
    ["schema_risk", "binding_risk", "field_risk"].includes(h.type))) {
    actionType = "check_binding";
  }

  return {
    band,
    actionType,
    reason: reasons.join("; ") || "Nur wenig Evidenz vorhanden.",
  };
}

/* ─────────────────────────────────────────────
   buildBridgePackage
   ─────────────────────────────────────────────
   Main export for Backend→Frontend direction.
   Accepts a structured DeepSeek result payload
   and returns a normalised bridge package that
   Gemini / the frontend can read.

   Workflow Step 1: Adds orchestration metadata
   (reviewIntent, recommendedGeminiMode,
   inspectionFocus, workflowStage) so the
   DeepSeek→Bridge→Gemini chain is coordinated.

   Step 3: Adds impactTranslation for cooperative
   Backend→Frontend effect translation so Gemini
   understands probable effects and follow-ups.

   @param {Object} payload
   @param {string}  [payload.lastKnownArea]    – e.g. "hqs_assessment"
   @param {string}  [payload.lastKnownMode]    – e.g. "change_review"
   @param {string}  [payload.sourceMode]       – originating DeepSeek service
   @param {Object}  [payload.result]           – the raw DeepSeek result object
   @param {Array}   [payload.hints]            – explicit bridge hints (override)
   @returns {Object} bridge package (also stored in memory)
   ───────────────────────────────────────────── */
function buildBridgePackage(payload = {}) {
  const backendState = normaliseBackendState(payload);
  const sourceMode   = capText(payload.sourceMode, 100);
  const rawResult    = payload.result && typeof payload.result === "object"
    ? payload.result
    : {};

  // Explicit hints override auto-derived hints when provided
  let rawHints;
  if (Array.isArray(payload.hints) && payload.hints.length) {
    rawHints = payload.hints.map(buildBridgeHint);
  } else {
    rawHints = deriveHintsFromDeepSeekResult(rawResult, sourceMode);
  }

  // Quality gate: deduplicate, filter weak, prioritise
  const { hints: bridgeHints, dropped } = filterAndPrioritiseHints(rawHints);

  // ── Workflow orchestration metadata ──
  const recommendedGeminiMode = deriveRecommendedGeminiMode(bridgeHints);
  const reviewIntent          = deriveReviewIntent(bridgeHints);
  const inspectionFocus       = deriveInspectionFocus(bridgeHints);

  // ── Step 3: Cooperative impact translation ──
  const impactTranslation = deriveImpactTranslation(bridgeHints);

  // ── Step 4: Bridge-level pattern key for the package ──
  const dominantHintType = deriveDominantHintType(bridgeHints);
  const bridgePatternKey = derivePatternKey(
    inspectionFocus.category,
    HINT_TYPE_TO_AFFECTED_LAYER[dominantHintType] || "cross_layer",
    inspectionFocus.suggestedFollowupTypes[0] || "none",
    recommendedGeminiMode
  );

  // ── Step 6: Derive package-level action readiness ──
  const packageReadiness = _assessPackageReadiness(bridgeHints, bridgePatternKey);

  const pkg = {
    version:     BRIDGE_VERSION,
    generatedAt: new Date().toISOString(),
    backendState,
    bridgeHints,
    workflow: {
      sourceAgent:          ACTIVE_BACKEND_AGENT,
      sourceMode:           sourceMode || null,
      reviewIntent,
      recommendedGeminiMode,
      inspectionFocus,
      workflowStage:        "bridge_ready",
    },
    // Step 3: impact translation (cooperative Backend→Frontend effect summary)
    impactTranslation,
    // Step 4 + 6: pattern context with action readiness
    patternContext: {
      patternKey:       bridgePatternKey,
      dominantHintType,
      dominantLayer:    HINT_TYPE_TO_AFFECTED_LAYER[dominantHintType] || "cross_layer",
      dominantFollowup: inspectionFocus.suggestedFollowupTypes[0] || "none",
      impactKind:       impactTranslation.impactKind,
      // Step 6: action readiness for this bridge package
      actionReadinessBand:    packageReadiness.band,
      recommendedActionType:  packageReadiness.actionType,
      readinessReason:        packageReadiness.reason,
    },
    meta: {
      hintsTotal:     rawHints.length,
      hintsKept:      bridgeHints.length,
      hintsDropped:   dropped,
      sourceMode:     sourceMode || null,
    },
  };

  _currentBridgePackage = pkg;

  // ── Step 3 + 4: Cause → Effect → Follow-up logging ──
  const hintTypes = {};
  const severityCounts = { high: 0, medium: 0, low: 0 };
  const layerCounts = {};
  const followupCounts = {};
  for (const h of bridgeHints) {
    hintTypes[h.type] = (hintTypes[h.type] || 0) + 1;
    severityCounts[h.severity] = (severityCounts[h.severity] || 0) + 1;
    if (h.likelyAffectedLayer) {
      layerCounts[h.likelyAffectedLayer] = (layerCounts[h.likelyAffectedLayer] || 0) + 1;
    }
    if (h.suggestedFollowupType && h.suggestedFollowupType !== "none") {
      followupCounts[h.suggestedFollowupType] = (followupCounts[h.suggestedFollowupType] || 0) + 1;
    }
  }

  logger.info("[agentBridge] bridge package built (cause)", {
    hintsTotal:     rawHints.length,
    hintsKept:      bridgeHints.length,
    hintsDroppedWeak:      dropped.weak,
    hintsDroppedDuplicate: dropped.duplicate,
    hintTypes,
    severityCounts,
    lastKnownArea:  backendState.lastKnownArea,
    sourceMode,
    isEmpty:        bridgeHints.length === 0,
    // Step 4: pattern context
    patternKey:     bridgePatternKey,
    dominantHintType,
  });

  logger.info("[agentBridge] workflow orchestration (effect)", {
    reviewIntent,
    recommendedGeminiMode,
    inspectionCategory:   inspectionFocus.category,
    needsFollowup:        inspectionFocus.needsFollowup,
    affectedViewsCount:   inspectionFocus.affectedViews.length,
    affectedFieldsCount:  inspectionFocus.affectedFields.length,
    likelyAffectedLayers: layerCounts,
    impactKind:           impactTranslation.impactKind,
    workflowStage:        "bridge_ready",
    // Step 4: pattern context
    patternKey:           bridgePatternKey,
    // Step 6: action readiness
    actionReadinessBand:    packageReadiness.band,
    recommendedActionType:  packageReadiness.actionType,
  });

  // Step 6: Explicit readiness log for bridge package
  if (packageReadiness.band !== "observation") {
    logger.info("[agentBridge] package action readiness (Step 6)", {
      readinessBand:   packageReadiness.band,
      actionType:      packageReadiness.actionType,
      reason:          packageReadiness.reason,
      patternKey:      bridgePatternKey,
    });
  }

  if (Object.keys(followupCounts).length > 0) {
    logger.info("[agentBridge] suggested follow-ups (next steps)", {
      followupTypes:          followupCounts,
      suggestedFollowupTypes: impactTranslation.suggestedFollowupTypes,
      impactSummary:          impactTranslation.impactSummary,
    });
  }

  if (bridgeHints.length === 0 && rawHints.length > 0) {
    logger.warn("[agentBridge] all hints were filtered – bridge package is empty", {
      rawHintsCount: rawHints.length,
      dropped,
    });
  }

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
      sourceMode:    null,
    },
    bridgeHints: [],
    workflow: {
      sourceAgent:          ACTIVE_BACKEND_AGENT,
      sourceMode:           null,
      reviewIntent:         "general_review",
      recommendedGeminiMode: "layout_review",
      inspectionFocus: {
        category:                "general",
        affectedViews:           [],
        affectedComponents:      [],
        affectedFields:          [],
        needsFollowup:           false,
        suggestedFollowupTypes:  [],
        likelyAffectedLayers:    [],
      },
      workflowStage:        "idle",
    },
    impactTranslation: {
      impactSummary:           "Keine Auffälligkeiten erkannt.",
      likelyAffectedLayers:    [],
      suggestedFollowupTypes:  [],
      affectedArtifactHints:   [],
      impactKind:              "none",
    },
    // Step 6: empty pattern context with readiness defaults
    patternContext: {
      patternKey:             null,
      dominantHintType:       "none",
      dominantLayer:          "cross_layer",
      dominantFollowup:       "none",
      impactKind:             "none",
      actionReadinessBand:    "observation",
      recommendedActionType:  "observe",
      readinessReason:        "Keine Hinweise vorhanden – nur Beobachtung.",
    },
    meta: {
      hintsTotal:   0,
      hintsKept:    0,
      hintsDropped: { weak: 0, duplicate: 0 },
      sourceMode:   null,
    },
  };
}

/* ─────────────────────────────────────────────
   Frontend feedback normalisation helpers
   (Step 2: quality-aware filtering)
   ───────────────────────────────────────────── */

/** Check whether a frontend hint carries enough value */
function isFeedbackHintUsable(hint) {
  if (!hint) return false;
  const hasTitle   = hint.title && hint.title.length >= 5;
  const hasSummary = hint.summary && hint.summary.length >= 10;
  return hasTitle || hasSummary;
}

/* ─────────────────────────────────────────────
   receiveFrontendFeedback
   ─────────────────────────────────────────────
   Frontend→Backend direction.
   Accepts structured Gemini/frontend hints and
   stores them in memory for later consumption.

   Step 2: Defensive normalisation, quality
   filtering, and better logging.

   Step 3: Adds learningSignal structure so that
   incoming feedback is prepared as a cooperative
   learning signal (suspected cause, observed
   effect, suggested follow-up) rather than just
   "feedback stored".

   @param {Object} payload
   @param {string}  [payload.source]      – e.g. "gemini_frontend"
   @param {string}  [payload.area]        – frontend area that generated this
   @param {Array}   [payload.hints]       – array of frontend hint objects
   @param {string}  [payload.notes]       – optional plain-text note
   @param {string}  [payload.observedEffect]     – Step 3: what was observed
   @param {string}  [payload.suspectedCause]     – Step 3: suspected backend cause
   @param {string}  [payload.suggestedFollowup]  – Step 3: proposed next action
   @param {string}  [payload.layerReference]     – Step 3: which layer (frontend/backend/cross)
   @returns {Object} acknowledgement
   ───────────────────────────────────────────── */
function receiveFrontendFeedback(payload = {}) {
  const source = capText(payload.source, 100) || "gemini_frontend";
  const area   = capText(payload.area, 100);
  const notes  = capText(payload.notes, 500);

  // Defensively handle non-array hints
  let rawHints;
  if (Array.isArray(payload.hints)) {
    rawHints = payload.hints.filter((h) => h && typeof h === "object");
  } else {
    rawHints = [];
  }

  // Build and quality-filter hints
  const allBuilt = rawHints.map((h) => buildBridgeHint({ ...h, source }));
  const usable   = allBuilt.filter(isFeedbackHintUsable);
  const droppedCount = allBuilt.length - usable.length;

  // ── Workflow: classify feedback and detect followup need ──
  const feedbackCategory = classifyFeedbackCategory(usable, notes);
  const hasHighSeverity  = usable.some((h) => h.severity === "high");
  const needsFollowup    = hasHighSeverity ||
    ["guard"].includes(feedbackCategory) ||
    usable.some((h) => (h.backendFollowups || []).length > 0);

  // ── Step 3: Learning signal (cooperative cause→effect→follow-up) ──
  const learningSignal = buildLearningSignal(
    feedbackCategory,
    usable,
    {
      observedEffect:    capText(payload.observedEffect, 300),
      suspectedCause:    capText(payload.suspectedCause, 300),
      suggestedFollowup: capText(payload.suggestedFollowup, 300),
      layerReference:    capText(payload.layerReference, 100),
    }
  );

  const entry = {
    receivedAt: new Date().toISOString(),
    source,
    area:   area || null,
    notes:  notes || null,
    hints:  usable,
    feedbackCategory,
    needsFollowup,
    learningSignal,
  };

  // Only store entries that carry real information
  const hasValue = usable.length > 0 || (notes && notes.length >= 10);
  if (hasValue) {
    _pendingFrontendFeedback.push(entry);

    // Keep at most 50 pending entries (simple guard against unbounded growth)
    if (_pendingFrontendFeedback.length > MAX_PENDING_FEEDBACK) {
      _pendingFrontendFeedback = _pendingFrontendFeedback.slice(-MAX_PENDING_FEEDBACK);
    }
  }

  // ── Step 3 + 4 + 6: Cause → Effect → Follow-up → Readiness logging ──
  logger.info("[agentBridge] frontend feedback received (observed effect)", {
    source,
    area,
    rawHintsCount:      rawHints.length,
    usableHints:        usable.length,
    droppedHints:       droppedCount,
    hasNotes:           !!(notes && notes.length >= 10),
    stored:             hasValue,
    feedbackCategory,
    needsFollowup,
    observedEffect:     learningSignal.observedEffect || null,
    // Step 4: pattern context
    patternKey:         learningSignal.patternKey,
    confidenceBand:     learningSignal.confidenceBand,
    // Step 6: action readiness
    actionReadinessBand:   learningSignal.actionReadinessBand,
    recommendedActionType: learningSignal.recommendedActionType,
    workflowStage:      "feedback_received",
  });

  if (learningSignal.suspectedCause || learningSignal.suggestedFollowup) {
    logger.info("[agentBridge] learning signal prepared (cause → follow-up)", {
      suspectedCause:      learningSignal.suspectedCause || null,
      likelyCauseLayer:    learningSignal.likelyCauseLayer,
      suggestedFollowup:   learningSignal.suggestedFollowup || null,
      followupNeed:        learningSignal.followupNeed,
      // Step 4: pattern enrichment
      patternKey:          learningSignal.patternKey,
      signalType:          learningSignal.signalType,
      impactCategory:      learningSignal.impactCategory,
      confidenceBand:      learningSignal.confidenceBand,
      // Step 6: readiness context
      actionReadinessBand:   learningSignal.actionReadinessBand,
      recommendedActionType: learningSignal.recommendedActionType,
    });
  }

  if (droppedCount > 0) {
    logger.info("[agentBridge] frontend hints filtered", {
      dropped: droppedCount,
      reason:  "weak or empty title/summary",
    });
  }

  if (needsFollowup) {
    logger.info("[agentBridge] feedback signals followup needed", {
      feedbackCategory,
      highSeverityHints: usable.filter((h) => h.severity === "high").length,
      source,
      followupNeed: learningSignal.followupNeed,
    });
  }

  return {
    accepted:          true,
    hintsReceived:     rawHints.length,
    hintsKept:         usable.length,
    hintsDropped:      droppedCount,
    stored:            hasValue,
    receivedAt:        entry.receivedAt,
    feedbackCategory,
    needsFollowup,
    learningSignal,
  };
}

/* ─────────────────────────────────────────────
   Step 4: Pattern key derivation
   ─────────────────────────────────────────────
   Builds a deterministic, human-readable pattern
   key from cause / layer / mode / follow-up so
   the system can group recurring situations
   without complex ML.  The key is intentionally
   short and stable – it captures *what kind* of
   situation this is, not every detail.
   ───────────────────────────────────────────── */

/**
 * Derive the dominant hint type from a hint set.
 * Returns the type with the highest severity-weighted count.
 */
function deriveDominantHintType(hints) {
  if (!hints || !hints.length) return "none";
  const votes = {};
  for (const h of hints) {
    votes[h.type] = (votes[h.type] || 0) + (SEVERITY_WEIGHT[h.severity] || 1);
  }
  let best = "review";
  let bestScore = 0;
  for (const [type, score] of Object.entries(votes)) {
    if (score > bestScore) { best = type; bestScore = score; }
  }
  return best;
}

/**
 * Derive a deterministic pattern key from the learning signal context.
 *
 * Format: `<sourceCategory>:<layerCategory>:<followupCategory>:<recommendedMode>`
 *
 * Each segment is a short, stable token derived from the hint set
 * and feedback classification.  The key lets the system cluster
 * similar observations without opaque hashing.
 */
function derivePatternKey(sourceCategory, layerCategory, followupCategory, recommendedMode) {
  const src  = sourceCategory  || "general";
  const lyr  = layerCategory   || "cross_layer";
  const fup  = followupCategory || "none";
  const mode = recommendedMode || "layout_review";
  return `${src}:${lyr}:${fup}:${mode}`;
}

/* ─────────────────────────────────────────────
   Step 4: Signal quality / confidence band
   ─────────────────────────────────────────────
   Not every learning signal is equally valuable.
   A simple, transparent quality assessment
   ensures the system does not learn from noise.

   Criteria (deterministic, no statistics):
   - "high"   – cause, effect *and* follow-up are present,
                 plus at least one high-severity hint
   - "medium" – at least two of cause/effect/followup
                 or hints with medium+ severity
   - "low"    – sparse data, weak hints, or missing
                 context fields
   ───────────────────────────────────────────── */

const VALID_CONFIDENCE_BANDS = ["low", "medium", "high"];

/**
 * Assess how trustworthy a learning signal is.
 *
 * @param {Object} signal – the learning signal object
 * @param {Array}  hints  – the hint set used to build it
 * @returns {string} "low" | "medium" | "high"
 */
function assessSignalQuality(signal, hints) {
  let score = 0;

  // Explicit context fields contribute strength
  if (signal.observedEffect)    score += 1;
  if (signal.suspectedCause)    score += 1;
  if (signal.suggestedFollowup) score += 1;
  if (signal.layerReference)    score += 1;

  // Hint richness
  if (hints.length >= 3)                              score += 1;
  if (hints.some((h) => h.severity === "high"))       score += 2;
  else if (hints.some((h) => h.severity === "medium")) score += 1;

  // Derived fields present
  if (signal.observedLayers && signal.observedLayers.length > 0)     score += 1;
  if (signal.observedFollowups && signal.observedFollowups.length > 0) score += 1;

  if (score >= 6) return "high";
  if (score >= 3) return "medium";
  return "low";
}

/* ─────────────────────────────────────────────
   Step 6: Action readiness assessment
   ─────────────────────────────────────────────
   Determines how mature / actionable a signal
   or recommendation appears.

   IMPORTANT DESIGN PRINCIPLE:
   Action readiness is deliberately kept separate
   from trust / confidence.  A signal can have
   high trust but low readiness (well-observed
   but only warrants monitoring).  And a signal
   can be moderately trusted but already point
   to a clear next step.

   Criteria (deterministic, transparent):
   - "observation"               – sparse data, no clear follow-up
   - "further_check_recommended" – some evidence, follow-up warranted
   - "useful_next_step"          – clear cause→effect, follow-up present
   - "mature_recommendation"     – strong evidence, confirmed pattern,
                                   clear and specific next step
   ───────────────────────────────────────────── */

/**
 * Assess how action-ready a signal is.
 *
 * The scoring is intentionally conservative:
 * a high-trust signal still needs clear cause→effect
 * AND a concrete follow-up to be considered "mature".
 *
 * @param {Object} signal   – the learning signal
 * @param {Array}  hints    – the hints backing this signal
 * @param {string} confidenceBand – "low"|"medium"|"high"
 * @returns {string} one of VALID_ACTION_READINESS_BANDS
 */
function assessActionReadiness(signal, hints, confidenceBand) {
  let score = 0;

  // ── Evidence completeness (cause → effect → follow-up chain) ──
  if (signal.observedEffect)    score += 2;
  if (signal.suspectedCause)    score += 2;
  if (signal.suggestedFollowup) score += 2;

  // ── Clarity of cause → effect chain ──
  if (signal.observedLayers && signal.observedLayers.length > 0)       score += 1;
  if (signal.observedFollowups && signal.observedFollowups.length > 0) score += 1;

  // ── Hint quality (but NOT blind trust transfer) ──
  const highSevCount = hints.filter((h) => h.severity === "high").length;
  const medSevCount  = hints.filter((h) => h.severity === "medium").length;

  // Multiple high-severity hints increase readiness slightly
  if (highSevCount >= 2) score += 2;
  else if (highSevCount >= 1) score += 1;
  if (medSevCount >= 2) score += 1;

  // ── Pattern confirmation (recurring pattern = more mature) ──
  const patternEntry = signal.patternKey
    ? _patternMemory.get(signal.patternKey)
    : null;
  if (patternEntry) {
    if (patternEntry.count >= 5) score += 2;       // confirmed pattern
    else if (patternEntry.count >= 2) score += 1;  // recurring
  }

  // ── Confidence as minor modifier (NOT dominant factor) ──
  // This ensures high trust alone does NOT auto-promote readiness
  if (confidenceBand === "high" && score >= 4) score += 1;

  // ── Classify ──
  if (score >= 10) return "mature_recommendation";
  if (score >= 6)  return "useful_next_step";
  if (score >= 3)  return "further_check_recommended";
  return "observation";
}

/**
 * Derive which type of action would be most appropriate
 * for a given signal, based on its follow-up category,
 * hint types and severity.
 *
 * Returns a cooperative, non-prescriptive action type.
 *
 * @param {Object} signal – the learning signal
 * @param {Array}  hints  – the hints backing this signal
 * @returns {string} one of VALID_RECOMMENDED_ACTION_TYPES
 */
function deriveRecommendedActionType(signal, hints) {
  // If the signal has an explicit follow-up category, map it
  const fromFollowup = FOLLOWUP_TO_ACTION_TYPE[signal.followupCategory];

  // If readiness is low, default to observe regardless
  if (signal.actionReadinessBand === "observation") return "observe";

  // High-severity binding/schema/field → check_binding
  const hasBindingRisk = hints.some(
    (h) => h.severity === "high" &&
    ["schema_risk", "binding_risk", "field_risk"].includes(h.type)
  );
  if (hasBindingRisk) return "check_binding";

  // Multiple confirmed followups → run_followup
  if (signal.observedFollowups && signal.observedFollowups.length >= 2) {
    return "run_followup";
  }

  // Mature recommendation with clear follow-up → prepare_change
  if (signal.actionReadinessBand === "mature_recommendation" &&
      signal.suggestedFollowup) {
    return "prepare_change";
  }

  // Fall back to follow-up-type mapping or observe
  return fromFollowup || "observe";
}

/* ─────────────────────────────────────────────
   Step 3 + 4 + 6: Learning signal builder
   ─────────────────────────────────────────────
   Builds a cooperative learning signal from
   feedback classification and optional explicit
   cause/effect/follow-up hints provided by
   the caller.

   Step 4 additions:
   - signalType:        dominant hint type
   - patternKey:        deterministic cluster key
   - sourceCategory:    feedback-derived source area
   - impactCategory:    dominant impact kind
   - followupCategory:  dominant follow-up type
   - recommendedMode:   best-fitting Gemini mode
   - layerCategory:     dominant layer
   - confidenceBand:    signal quality (low/medium/high)
   - workflowCategory:  feedback category (alias)

   Step 6 additions (action readiness / recommendation quality):
   - actionReadinessBand:     observation / further_check / useful_next_step / mature
   - recommendedActionType:   observe / check_ui / check_binding / etc.

   The structure stays backwards-compatible –
   all Step 3 + 4 fields remain in place.
   ───────────────────────────────────────────── */

function buildLearningSignal(feedbackCategory, hints, explicit = {}) {
  // Determine likely cause layer from feedback category
  const likelyCauseLayer = FEEDBACK_TO_LIKELY_CAUSE[feedbackCategory] || "cross_layer";

  // Derive observed layers from hints
  const observedLayers = new Set();
  const observedFollowups = new Set();
  for (const h of hints) {
    if (h.likelyAffectedLayer) observedLayers.add(h.likelyAffectedLayer);
    if (h.suggestedFollowupType && h.suggestedFollowupType !== "none") {
      observedFollowups.add(h.suggestedFollowupType);
    }
  }

  // Determine follow-up need level
  let followupNeed = "none";
  if (hints.some((h) => h.severity === "high")) {
    followupNeed = "high";
  } else if (hints.some((h) => h.severity === "medium")) {
    followupNeed = "moderate";
  } else if (hints.length > 0) {
    followupNeed = "low";
  }

  // ── Step 4: enriched pattern / learning fields ──
  const signalType       = deriveDominantHintType(hints);
  const sourceCategory   = feedbackCategory || "general";
  const layerCategory    = likelyCauseLayer;
  const followupArr      = [...observedFollowups];
  const followupCategory = followupArr[0] || "none";
  const recommendedMode  = deriveRecommendedGeminiMode(hints);
  const impactCategory   = signalType === "none" ? "none"
    : (HINT_TYPE_TO_AFFECTED_LAYER[signalType] || "cross_layer");

  const patternKey = derivePatternKey(
    sourceCategory, layerCategory, followupCategory, recommendedMode
  );

  const signal = {
    // ── Step 3 fields (backwards-compatible) ──
    observedEffect:       explicit.observedEffect || null,
    suspectedCause:       explicit.suspectedCause || null,
    suggestedFollowup:    explicit.suggestedFollowup || null,
    layerReference:       explicit.layerReference || null,
    likelyCauseLayer,
    observedLayers:       [...observedLayers].slice(0, MAX_FOCUS_ITEMS),
    observedFollowups:    followupArr.slice(0, MAX_FOCUS_ITEMS),
    followupNeed,
    feedbackCategory,

    // ── Step 4 fields (pattern memory / learning) ──
    signalType,
    patternKey,
    sourceCategory,
    impactCategory,
    followupCategory,
    recommendedMode,
    layerCategory,
    confidenceBand:       null, // set below after quality assessment
    workflowCategory:     feedbackCategory,

    // ── Step 6 fields (action readiness / recommendation quality) ──
    actionReadinessBand:    null, // set below after readiness assessment
    recommendedActionType:  null, // set below after readiness assessment
  };

  // Assess signal quality (must happen after signal is built)
  signal.confidenceBand = assessSignalQuality(signal, hints);

  // ── Step 6: Assess action readiness (deliberately AFTER confidence) ──
  signal.actionReadinessBand = assessActionReadiness(signal, hints, signal.confidenceBand);
  signal.recommendedActionType = deriveRecommendedActionType(signal, hints);

  // ── Step 4: Record pattern in lightweight in-memory store ──
  recordPatternObservation(patternKey, signal);

  // ── Step 4 + 6: Pattern / learning / readiness logging ──
  logger.info("[agentBridge] learning signal built (Step 6 – readiness)", {
    patternKey,
    signalType,
    confidenceBand:         signal.confidenceBand,
    actionReadinessBand:    signal.actionReadinessBand,
    recommendedActionType:  signal.recommendedActionType,
    sourceCategory,
    layerCategory,
    impactCategory,
    followupCategory,
    recommendedMode,
    followupNeed,
    observedLayerCount:     signal.observedLayers.length,
    observedFollowupCount:  signal.observedFollowups.length,
    hasExplicitCause:       !!explicit.suspectedCause,
    hasExplicitEffect:      !!explicit.observedEffect,
    hasExplicitFollowup:    !!explicit.suggestedFollowup,
  });

  // ── Step 6: Explicit readiness reasoning log ──
  if (signal.actionReadinessBand !== "observation") {
    logger.info("[agentBridge] action readiness assessed (Step 6)", {
      readinessBand:   signal.actionReadinessBand,
      actionType:      signal.recommendedActionType,
      confidenceBand:  signal.confidenceBand,
      reason:          _describeReadinessReason(signal, hints),
    });
  }

  return signal;
}

/**
 * Generate a short, human-readable reason string
 * explaining why a given readiness band was assigned.
 * Used for transparent logging – no black-box scoring.
 */
function _describeReadinessReason(signal, hints) {
  const parts = [];
  if (signal.observedEffect)    parts.push("Beobachteter Effekt vorhanden");
  if (signal.suspectedCause)    parts.push("Vermutete Ursache angegeben");
  if (signal.suggestedFollowup) parts.push("Folgeaktion vorgeschlagen");

  const highCount = hints.filter((h) => h.severity === "high").length;
  if (highCount > 0) parts.push(`${highCount} Hinweis(e) mit hoher Dringlichkeit`);

  const patternEntry = signal.patternKey
    ? _patternMemory.get(signal.patternKey)
    : null;
  if (patternEntry && patternEntry.count >= 2) {
    parts.push(`Muster ${patternEntry.count}x beobachtet`);
  }

  if (parts.length === 0) parts.push("Nur wenig Evidenz vorhanden");
  return parts.join("; ");
}

/* ─────────────────────────────────────────────
   Step 4 + 6: In-memory pattern aggregation
   ─────────────────────────────────────────────
   Tracks how often a pattern key occurs and
   which modes / layers / follow-ups are most
   common for that pattern.  Purely in-memory,
   bounded by MAX_PATTERN_MEMORY_ENTRIES.

   Step 6: Also tallies action readiness bands
   and recommended action types per pattern.

   This is *not* a database or analytics engine.
   It provides lightweight observability so the
   system can later spot recurring situations.
   ───────────────────────────────────────────── */

/**
 * Record a new observation for a given pattern key.
 * Updates count, last seen timestamp, and frequency
 * tallies for mode / layer / follow-up / confidence /
 * readiness / action type.
 */
function recordPatternObservation(patternKey, signal) {
  if (!patternKey) return;

  let entry = _patternMemory.get(patternKey);
  if (!entry) {
    entry = {
      patternKey,
      count:              0,
      firstSeen:          new Date().toISOString(),
      lastSeen:           null,
      modeTally:          {},
      layerTally:         {},
      followupTally:      {},
      confidenceTally:    {},
      signalTypeTally:    {},
      // Step 6: action readiness tallies
      readinessTally:     {},
      actionTypeTally:    {},
    };
  }

  entry.count += 1;
  entry.lastSeen = new Date().toISOString();

  // Tally: recommended mode
  if (signal.recommendedMode) {
    entry.modeTally[signal.recommendedMode] =
      (entry.modeTally[signal.recommendedMode] || 0) + 1;
  }
  // Tally: layer category
  if (signal.layerCategory) {
    entry.layerTally[signal.layerCategory] =
      (entry.layerTally[signal.layerCategory] || 0) + 1;
  }
  // Tally: follow-up category
  if (signal.followupCategory && signal.followupCategory !== "none") {
    entry.followupTally[signal.followupCategory] =
      (entry.followupTally[signal.followupCategory] || 0) + 1;
  }
  // Tally: confidence band
  if (signal.confidenceBand) {
    entry.confidenceTally[signal.confidenceBand] =
      (entry.confidenceTally[signal.confidenceBand] || 0) + 1;
  }
  // Tally: signal type (dominant hint type)
  if (signal.signalType && signal.signalType !== "none") {
    entry.signalTypeTally[signal.signalType] =
      (entry.signalTypeTally[signal.signalType] || 0) + 1;
  }
  // Step 6: Tally action readiness band
  if (signal.actionReadinessBand) {
    entry.readinessTally = entry.readinessTally || {};
    entry.readinessTally[signal.actionReadinessBand] =
      (entry.readinessTally[signal.actionReadinessBand] || 0) + 1;
  }
  // Step 6: Tally recommended action type
  if (signal.recommendedActionType) {
    entry.actionTypeTally = entry.actionTypeTally || {};
    entry.actionTypeTally[signal.recommendedActionType] =
      (entry.actionTypeTally[signal.recommendedActionType] || 0) + 1;
  }

  _patternMemory.set(patternKey, entry);

  // Evict oldest entries if over limit
  if (_patternMemory.size > MAX_PATTERN_MEMORY_ENTRIES) {
    // Remove the entry with the oldest lastSeen timestamp
    let oldestKey = null;
    let oldestTime = null;
    for (const [key, val] of _patternMemory) {
      if (!oldestTime || val.lastSeen < oldestTime) {
        oldestTime = val.lastSeen;
        oldestKey = key;
      }
    }
    if (oldestKey) _patternMemory.delete(oldestKey);
  }
}

/**
 * Returns a summary of the current in-memory pattern memory.
 * Sorted by count (most frequent first), capped at 50 entries.
 *
 * Step 6: Each pattern entry now includes dominant readiness
 * band and recommended action type.
 */
function getPatternMemorySummary() {
  const entries = [..._patternMemory.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 50)
    .map((e) => ({
      patternKey:            e.patternKey,
      count:                 e.count,
      firstSeen:             e.firstSeen,
      lastSeen:              e.lastSeen,
      dominantMode:          _topKey(e.modeTally),
      dominantLayer:         _topKey(e.layerTally),
      dominantFollowup:      _topKey(e.followupTally),
      dominantConfidence:    _topKey(e.confidenceTally),
      dominantSignalType:    _topKey(e.signalTypeTally),
      // Step 6: action readiness summary per pattern
      dominantReadiness:     _topKey(e.readinessTally),
      dominantActionType:    _topKey(e.actionTypeTally),
    }));

  return {
    totalPatterns:  _patternMemory.size,
    topPatterns:    entries,
    generatedAt:    new Date().toISOString(),
  };
}

/* ─────────────────────────────────────────────
   Step 6: Action Readiness Summary
   ─────────────────────────────────────────────
   Returns a lightweight overview of how signals
   are distributed across readiness bands and
   action types.  Helps the HQS system understand
   - how many signals are still exploratory
   - how many are closer to actionable
   - which action types appear most often
   - how readiness relates to confidence

   This is purely observational, not prescriptive.
   ───────────────────────────────────────────── */

/**
 * Build an aggregated action-readiness overview
 * from all pattern memory entries.
 *
 * @returns {Object} readiness summary
 */
function getActionReadinessSummary() {
  const readinessCounts = {};
  const actionTypeCounts = {};
  const confidenceVsReadiness = {};

  for (const entry of _patternMemory.values()) {
    // Aggregate readiness tallies
    for (const [band, count] of Object.entries(entry.readinessTally || {})) {
      readinessCounts[band] = (readinessCounts[band] || 0) + count;
    }
    // Aggregate action type tallies
    for (const [type, count] of Object.entries(entry.actionTypeTally || {})) {
      actionTypeCounts[type] = (actionTypeCounts[type] || 0) + count;
    }
    // Cross-reference: confidence vs readiness
    const domConf = _topKey(entry.confidenceTally);
    const domRead = _topKey(entry.readinessTally);
    if (domConf && domRead) {
      const crossKey = `${domConf}→${domRead}`;
      confidenceVsReadiness[crossKey] =
        (confidenceVsReadiness[crossKey] || 0) + entry.count;
    }
  }

  // Count how many patterns are in each readiness stage
  const patternsPerReadiness = {};
  for (const entry of _patternMemory.values()) {
    const domRead = _topKey(entry.readinessTally);
    if (domRead) {
      patternsPerReadiness[domRead] = (patternsPerReadiness[domRead] || 0) + 1;
    }
  }

  return {
    totalPatterns:          _patternMemory.size,
    readinessDistribution:  readinessCounts,
    actionTypeDistribution: actionTypeCounts,
    patternsPerReadiness,
    confidenceVsReadiness,
    generatedAt:            new Date().toISOString(),
  };
}

/** Pick the key with the highest count from a tally object */
function _topKey(tally) {
  if (!tally) return null;
  let best = null;
  let bestCount = 0;
  for (const [key, count] of Object.entries(tally)) {
    if (count > bestCount) { best = key; bestCount = count; }
  }
  return best;
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
  getPatternMemorySummary,
  getActionReadinessSummary,
  BRIDGE_VERSION,
  VALID_HINT_TYPES,
  VALID_SEVERITIES,
  VALID_GEMINI_MODES,
  VALID_REVIEW_INTENTS,
  VALID_FEEDBACK_CATEGORIES,
  VALID_FOLLOWUP_TYPES,
  VALID_IMPACT_LAYERS,
  VALID_CONFIDENCE_BANDS,
  VALID_ACTION_READINESS_BANDS,
  VALID_RECOMMENDED_ACTION_TYPES,
};
