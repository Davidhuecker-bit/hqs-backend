"use strict";

const logger = require("../utils/logger");
const {
  createDeepSeekChatCompletion,
  isDeepSeekConfigured,
} = require("./deepseek.service");
const {
  isGeminiConfigured,
  runGeminiChat,
} = require("./geminiArchitect.service");

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
   Step 7 – Recommendation Feedback /
   Improvement Loop Light
   ─────────────────────────────────────────────
   A lightweight feedback layer that lets the
   HQS system learn which recommendations
   proved helpful in practice, which were too
   early, and which needed adjustment.

   IMPORTANT DESIGN PRINCIPLE:
   - Readiness = how action-ready something
     CURRENTLY appears (Step 6)
   - Improvement / Feedback = how well this
     KIND of recommendation worked IN RETROSPECT

   These two dimensions must not be mixed.
   A signal can look action-ready but turn out
   to be too early; a low-readiness signal can
   still produce a helpful follow-up.

   This is NOT an outcome engine or auto-
   optimisation.  It is a light feedback
   classification so the system can later
   produce better recommendations.
   ───────────────────────────────────────────── */

/**
 * Valid recommendation feedback categories –
 * cooperative language describing how a recommendation
 * turned out in retrospect.
 */
const VALID_RECOMMENDATION_FEEDBACK_CATEGORIES = [
  "helpful",               // Empfehlung war hilfreich
  "usable",                // brauchbare Richtung
  "too_early",             // zu frühes Signal
  "unclear",               // unklare Empfehlung
  "not_needed",            // nicht nötig
  "followup_was_better",   // Folgeprüfung war sinnvoller
];

/**
 * Valid improvement signals – describes what kind of
 * adjustment would make the recommendation better
 * next time.
 */
const VALID_IMPROVEMENT_SIGNALS = [
  "none",                  // kein Verbesserungsbedarf
  "needs_more_context",    // mehr Kontext nötig
  "too_generic",           // zu allgemein
  "timing_off",            // Zeitpunkt unpassend
  "wrong_layer",           // falsche Schicht adressiert
  "followup_preferred",    // Folgeprüfung wäre besser gewesen
];

/** Maximum recommendation feedback entries kept in memory */
const MAX_RECOMMENDATION_FEEDBACK_ENTRIES = 100;

/* ─────────────────────────────────────────────
   Step 8 – Recommendation Policy /
   Governance Light
   ─────────────────────────────────────────────
   A lightweight governance layer that classifies
   recommendations into visibility / policy
   classes.  This does NOT auto-execute, auto-
   promote or auto-publish anything.  It only
   provides a transparent, deterministic policy
   classification so the HQS system can later
   steer which recommendations remain internal,
   become admin-visible, are guardian-candidates,
   or need more evidence.

   IMPORTANT DESIGN PRINCIPLES:
   - Readiness  = how action-ready something
     currently appears (Step 6)
   - Improvement = how well this kind of
     recommendation worked in retrospect (Step 7)
   - Governance / Policy = whether / where / how
     this recommendation should be visible or
     eligible for promotion

   These three dimensions MUST remain separate.
   A signal can have high readiness, good
   improvement history, and still be classified
   as admin_visible or needs_more_evidence from
   a governance perspective.
   ───────────────────────────────────────────── */

/**
 * Valid governance policy classes – determines the
 * visibility and promotion eligibility of a
 * recommendation.
 *
 * Ordered from most restricted to most eligible:
 *   shadow_only         → only observed internally, not surfaced
 *   internal_only       → visible in internal logs / analytics
 *   needs_more_evidence → promising but insufficient backing
 *   admin_visible       → ready to be shown to admin users
 *   guardian_candidate  → strong enough to be considered
 *                         for guardian-level promotion (NOT auto-promoted)
 */
const VALID_GOVERNANCE_POLICY_CLASSES = [
  "shadow_only",
  "internal_only",
  "needs_more_evidence",
  "admin_visible",
  "guardian_candidate",
];

/**
 * Governance classification thresholds.
 * Kept deliberately conservative – the system
 * should under-promote rather than over-promote.
 */
const GOV_MIN_PATTERN_COUNT_FOR_ADMIN     = 2;  // pattern must be seen ≥2x for admin visibility
const GOV_MIN_PATTERN_COUNT_FOR_GUARDIAN   = 4;  // pattern must be seen ≥4x for guardian candidacy
const GOV_MIN_FEEDBACK_FOR_GUARDIAN        = 2;  // at least 2 feedback entries required
const GOV_POSITIVE_FEEDBACK_RATIO_GUARDIAN = 0.6; // ≥60% helpful/usable feedback for guardian
const GOV_MIN_CONFIDENCE_FOR_ADMIN        = "medium"; // minimum confidence for admin visibility
const GOV_READINESS_BANDS_FOR_GUARDIAN     = ["useful_next_step", "mature_recommendation"];

/** Maximum guardian candidates shown in governance summary */
const GOV_MAX_GUARDIAN_CANDIDATES_IN_SUMMARY = 20;

/* ─────────────────────────────────────────────
   Step 10 – Issue Intelligence / Error Detection Light
   ─────────────────────────────────────────────
   Adds a lightweight issue-detection layer so the
   HQS system can structure technical
   Auffälligkeiten as Issues without changing the
   existing governance / routing / readiness model.

   IMPORTANT DESIGN PRINCIPLES:
   - Issue Intelligence = what likely looks wrong
     or inconsistent on a technical / structural /
     operational level
   - Governance        = visibility / release /
     promotion classification
   - Routing / Surface = where a recommendation
     may later be shown or reviewed

   These dimensions stay deliberately separate.
   ───────────────────────────────────────────── */

const VALID_ISSUE_TYPES = [
  "consistency_issue",
  "service_issue",
  "freshness_issue",
  "data_issue",
  "configuration_issue",
  "unknown_issue_type",
];

const VALID_ISSUE_CATEGORIES = [
  "frontend_binding_issue",
  "frontend_structure_issue",
  "backend_service_issue",
  "mapping_schema_issue",
  "pipeline_staleness_issue",
  "db_completeness_issue",
  "config_threshold_issue",
  "unknown_issue",
];

const VALID_ISSUE_LAYERS = [
  "frontend",
  "backend",
  "binding",
  "mapping",
  "pipeline",
  "database",
  "ops",
  "config",
  "unknown",
];

const VALID_ISSUE_SEVERITY_LEVELS = ["low", "medium", "high"];

const VALID_ISSUE_CAUSES = [
  "frontend_binding_mismatch",
  "frontend_structure_inconsistency",
  "backend_service_dependency",
  "schema_mapping_drift",
  "pipeline_freshness_gap",
  "database_completeness_gap",
  "config_threshold_misalignment",
  "unknown_cause",
];

const VALID_ISSUE_SUGGESTED_FIXES = [
  "check_binding_fields",
  "review_frontend_structure",
  "check_service_route_dependency",
  "review_schema_mapping",
  "check_pipeline_freshness",
  "check_table_completeness",
  "check_config_thresholds",
  "run_followup_review",
];

const ISSUE_LABELS = {
  frontend_binding_issue: {
    issueType: "consistency_issue",
    affectedLayer: "binding",
    suspectedCause: "frontend_binding_mismatch",
    suggestedFix: "check_binding_fields",
  },
  frontend_structure_issue: {
    issueType: "consistency_issue",
    affectedLayer: "frontend",
    suspectedCause: "frontend_structure_inconsistency",
    suggestedFix: "review_frontend_structure",
  },
  backend_service_issue: {
    issueType: "service_issue",
    affectedLayer: "backend",
    suspectedCause: "backend_service_dependency",
    suggestedFix: "check_service_route_dependency",
  },
  mapping_schema_issue: {
    issueType: "consistency_issue",
    affectedLayer: "mapping",
    suspectedCause: "schema_mapping_drift",
    suggestedFix: "review_schema_mapping",
  },
  pipeline_staleness_issue: {
    issueType: "freshness_issue",
    affectedLayer: "pipeline",
    suspectedCause: "pipeline_freshness_gap",
    suggestedFix: "check_pipeline_freshness",
  },
  db_completeness_issue: {
    issueType: "data_issue",
    affectedLayer: "database",
    suspectedCause: "database_completeness_gap",
    suggestedFix: "check_table_completeness",
  },
  config_threshold_issue: {
    issueType: "configuration_issue",
    affectedLayer: "config",
    suspectedCause: "config_threshold_misalignment",
    suggestedFix: "check_config_thresholds",
  },
  unknown_issue: {
    issueType: "unknown_issue_type",
    affectedLayer: "unknown",
    suspectedCause: "unknown_cause",
    suggestedFix: "run_followup_review",
  },
};

const ISSUE_KEYWORD_RULES = [
  {
    category: "config_threshold_issue",
    keywords: ["config", "konfig", "threshold", "schwelle", "variable", "env", "limit"],
  },
  {
    category: "db_completeness_issue",
    keywords: ["db", "datenbank", "table", "tabelle", "vollständ", "fehlend", "missing row", "record"],
  },
  {
    category: "pipeline_staleness_issue",
    keywords: ["stale", "freshness", "veraltet", "pipeline", "lag", "delayed", "snapshot"],
  },
  {
    category: "mapping_schema_issue",
    keywords: ["schema", "mapping", "contract", "vertrag", "api", "payload"],
  },
  {
    category: "frontend_binding_issue",
    keywords: ["binding", "feld", "field", "prop", "placeholder"],
  },
  {
    category: "frontend_structure_issue",
    keywords: ["layout", "struktur", "hierarchie", "frontend", "ui", "darstellung"],
  },
  {
    category: "backend_service_issue",
    keywords: ["backend", "service", "route", "controller", "dependency", "server"],
  },
];

const HINT_TYPE_TO_ISSUE_CATEGORY = {
  binding_risk: "frontend_binding_issue",
  field_risk: "frontend_binding_issue",
  schema_risk: "mapping_schema_issue",
  contract_warning: "mapping_schema_issue",
  staleness: "pipeline_staleness_issue",
  ui_impact: "frontend_structure_issue",
  change_guard: "backend_service_issue",
  review: "backend_service_issue",
};

/* ─────────────────────────────────────────────
   Step 11 – Case / Resolution / Operator Loop Light
   ─────────────────────────────────────────────
   Adds a lightweight operative case-/resolution
   layer so the HQS system can track the
   Bearbeitungszustand of recognised hints,
   recommendations, and issues without building
   a full ticket system or persistence platform.

   IMPORTANT DESIGN PRINCIPLES:
   - Case / Resolution  = how a specific hint /
     issue / recommendation is operatively
     tracked and resolved over time
   - Issue Intelligence  = what likely looks wrong
     (technical / structural)
   - Improvement         = retrospective feedback
     on recommendation quality
   - Readiness           = how actionable something
     is right now
   - Governance          = visibility / promotion
     classification

   These dimensions stay deliberately separate.
   A case can be issue-seitig "mapping_schema_issue",
   readiness-seitig "observation", improvement-seitig
   "helpful", and case-seitig "watching" – all at
   the same time, each independently meaningful.
   ───────────────────────────────────────────── */

const VALID_CASE_STATUSES = [
  "open",
  "watching",
  "confirmed",
  "resolved",
  "dismissed",
  "needs_followup",
];

const VALID_CASE_OUTCOMES = [
  "pending",
  "confirmed_helpful",
  "confirmed_not_helpful",
  "resolved_fixed",
  "resolved_no_action",
  "dismissed_noise",
  "dismissed_duplicate",
  "needs_further_review",
];

const VALID_HELPFULNESS_BANDS = [
  "clearly_helpful",
  "somewhat_helpful",
  "unclear",
  "not_helpful",
  "too_early_to_tell",
];

/** Conservative thresholds for case status derivation */
const CASE_MIN_OBSERVATIONS_FOR_WATCHING   = 2;
const CASE_MIN_OBSERVATIONS_FOR_CONFIRMED  = 4;
const CASE_MIN_POSITIVE_RATIO_FOR_HELPFUL  = 0.6;
const CASE_MAX_ENTRIES                     = 200;
const CASE_MAX_SUMMARY_ENTRIES             = 50;

/* ─────────────────────────────────────────────
   Step 12: Attention / Priority Queue /
   Operator Focus Light
   ─────────────────────────────────────────────
   Adds a lightweight internal attention /
   priority layer that helps the operator
   understand what deserves focus right now,
   what should be reviewed today, what to
   keep watching, and what can stay in the
   background.

   Separation principle:
   - attentionBand = how much operator attention
     this currently deserves
   - issueType    = what is technically wrong
   - caseStatus   = operative Bearbeitungszustand
   - readiness    = how actionable it is
   - governance   = visibility classification

   A case can be:
   - issue-seitig: "mapping_schema_issue"
   - case-seitig:  "watching"
   - readiness:    "observation"
   - attention:    "watch_next"
   – each dimension independently meaningful.

   Priority is derived transparently from
   existing dimensions (issue severity, case
   status, readiness, governance, confidence,
   pattern frequency, helpfulness, follow-up
   need) — no black-box scoring.
   ───────────────────────────────────────────── */

const VALID_ATTENTION_BANDS = [
  "focus_now",
  "review_today",
  "watch_next",
  "background",
];

/**
 * Weights used to derive the attention score
 * from existing dimensions.  Each dimension
 * contributes a small, transparent increment.
 *
 * The total score is mapped to an attention band:
 *   >= 7  → focus_now
 *   >= 4  → review_today
 *   >= 2  → watch_next
 *   <  2  → background
 */
const ATTENTION_SCORE_THRESHOLDS = {
  focus_now:    7,
  review_today: 4,
  watch_next:   2,
};

/** Max entries in attention priority summary */
const ATTENTION_MAX_SUMMARY_ENTRIES = 50;

/* ─────────────────────────────────────────────
   Step 13: Resolution Confidence / Decision
   Maturity Light
   ─────────────────────────────────────────────
   Adds a lightweight internal maturity /
   confidence layer that helps the operator
   understand how robust, confirmed, and
   operationally reliable a current direction is.

   Separation principle:
   - Trust / Usefulness     = how trustworthy
     the underlying hints are
   - Readiness              = how actionable it is
   - Case                   = operative processing
     status
   - Attention / Priority   = how much focus this
     currently deserves
   - Decision Maturity /
     Resolution Confidence  = how robust / settled /
     operationally dependable
     the direction has become

   A case can be:
   - issue-seitig: "mapping_schema_issue"
   - case-seitig:  "watching"
   - attention:    "focus_now"
   - maturity:     "early_signal"
   – each dimension independently meaningful.

   Maturity is derived transparently from existing
   dimensions (observation count, confidence,
   readiness, case status, helpfulness, governance,
   issue severity, attention) — no black-box scoring.
   ───────────────────────────────────────────── */

const VALID_DECISION_MATURITY_BANDS = [
  "early_signal",  // frühes Signal – noch keine Verdichtung
  "building",      // baut sich auf – erste Substanz erkennbar
  "credible",      // tragfähiger – gewinnt an Substanz
  "confirmed",     // belastbar bestätigt – operativ verlässlich
];

/**
 * Weights used to derive the maturity score from
 * existing dimensions.  Each dimension contributes
 * a small, transparent increment.
 *
 * The total score is mapped to a maturity band:
 *   >= 9  → confirmed
 *   >= 6  → credible
 *   >= 3  → building
 *   <  3  → early_signal
 */
const MATURITY_SCORE_THRESHOLDS = {
  confirmed: 9,
  credible:  6,
  building:  3,
};

/** Max entries in decision maturity summary */
const MATURITY_MAX_SUMMARY_ENTRIES = 50;

/* ─────────────────────────────────────────────
   Step 14: Agent Problem Detection / Solution
   Proposal / Approval Chat Foundation
   ─────────────────────────────────────────────
   Transforms diagnostic data from Steps 1–13
   into agentisches Handeln:

   - Problem erkennen
   - Ursache klar benennen
   - konkrete Lösung vorschlagen
   - Freigabe einholen
   - nach OK Lösungsvorbereitung ermöglichen

   Separation principle:
   - Trust / Usefulness   = Vertrauenswürdigkeit
   - Readiness            = Handlungsbereitschaft
   - Case / Resolution    = operativer Verlauf
   - Attention / Priority = Fokussierung
   - Decision Maturity    = Belastbarkeit
   - Agent Case (Step 14) = agentische Problemerkennung,
     Lösungsvorschlag, Freigabeschleife und
     Chat-Grundlage

   This is NOT autonomous execution. It is
   cooperative agentic behaviour:
   "Ich habe ein Problem erkannt → Soll ich
    das vorbereiten?"
   ───────────────────────────────────────────── */

/** Agent roles – DeepSeek = Backend, Gemini = Frontend */
const VALID_AGENT_ROLES = [
  "deepseek_backend",  // Backend / API / Code / Datenfluss / Logik
  "gemini_frontend",   // Frontend / Design / UX / Darstellung
];

/** Problem types recognised by the agent layer */
const VALID_AGENT_PROBLEM_TYPES = [
  "backend_logic_issue",
  "backend_schema_issue",
  "api_contract_issue",
  "frontend_binding_issue",
  "frontend_layout_issue",
  "frontend_presentation_issue",
  "cross_layer_issue",
  "data_flow_issue",
  "mapping_issue",
  "performance_issue",
  "staleness_issue",
  "unknown",
];

/** Agent message types for the chat foundation */
const VALID_AGENT_MESSAGE_TYPES = [
  "problem_detected",
  "root_cause_identified",
  "solution_proposed",
  "approval_requested",
  "feedback_received",
  "plan_refined",
  "preparation_started",
  "status_update",
];

/** Message intents for chat messages */
const VALID_AGENT_MESSAGE_INTENTS = [
  "inform",
  "propose",
  "ask_approval",
  "ask_feedback",
  "confirm",
  "refine",
];

/** Approval scopes – what the user can approve */
const VALID_APPROVAL_SCOPES = [
  "full_fix",
  "backend_only",
  "frontend_only",
  "diagnosis_only",
  "partial_fix",
  "observation_only",
];

/** Preparation types the agent can propose */
const VALID_PREPARATION_TYPES = [
  "harden_logic",
  "fix_mapping",
  "fix_binding",
  "adjust_layout",
  "adjust_presentation",
  "remove_legacy_path",
  "add_validation",
  "refactor_data_flow",
  "deepen_diagnosis",
  "cross_layer_review",
];

/** Feedback types the user can provide */
const VALID_AGENT_FEEDBACK_TYPES = [
  "approve",
  "reject",
  "modify",
  "narrow_scope",
  "suggest_alternative",
  "request_more_info",
  "defer",
  "approve_partial",
];

/** Confidence thresholds for agent case derivation */
const AGENT_CONFIDENCE_THRESHOLDS = {
  high:   0.75,
  medium: 0.45,
  low:    0.0,
};

/** Max entries in in-memory stores */
const AGENT_CASE_MAX_ENTRIES = 200;
const AGENT_CHAT_MAX_MESSAGES = 500;
const AGENT_CASE_MAX_SUMMARY_ENTRIES = 50;
const AGENT_CHAT_MAX_QUERY_LIMIT = 100;
const MAX_PROBLEM_TITLE_LENGTH = 120;

/* ─────────────────────────────────────────────
   Step 15: Agent Approval / Plan Refinement /
   Controlled Preparation – Constants
   ─────────────────────────────────────────────
   These constants extend the Step 14 foundation
   to support:
   - real plan-refinement phases
   - controlled preparation categories
   - richer approval decision stages
   - cross-agent coordination fields
   ───────────────────────────────────────────── */

/**
 * Plan phases for the agent work lifecycle.
 * Tracks which stage of the Problem→Preparation
 * pipeline a case is currently in.
 */
const VALID_PLAN_PHASES = [
  "problem_phase",       // Agent detected problem, not yet proposed
  "solution_phase",      // Agent proposed solution, awaiting approval
  "feedback_phase",      // User provided feedback, plan being refined
  "refinement_phase",    // Plan is actively being refined
  "preparation_phase",   // Plan approved, controlled preparation started
  "hold_phase",          // Case deferred or requires cross-agent review
];

/**
 * Controlled preparation types for Step 15.
 * Deliberately conservative – no auto-execution.
 * Each type describes what the agent *prepares*,
 * not what it *executes*.
 */
const VALID_CONTROLLED_PREPARATION_TYPES = [
  "diagnosis_only",        // Deepen analysis, no fix yet
  "backend_prepare",       // Prepare backend-side change only
  "frontend_prepare",      // Prepare frontend-side change only
  "partial_fix_prepare",   // Prepare a limited / scoped fix
  "cross_agent_review",    // Requires DeepSeek ↔ Gemini review before proceeding
  "full_preparation",      // Both backend + frontend preparation
  "hold",                  // No preparation yet – case held back
];

/**
 * Approval decision stages – richer than a boolean.
 * Tracks the precise state of the operator's decision.
 */
const VALID_APPROVAL_DECISION_STAGES = [
  "awaiting_decision",        // No feedback yet
  "approved_full",            // Full fix approved
  "approved_partial",         // Partial / scoped approval
  "approved_diagnosis_only",  // Only deepen diagnosis, no fix
  "approved_backend_only",    // Backend preparation approved
  "approved_frontend_only",   // Frontend preparation approved
  "deferred",                 // Operator deferred the decision
  "rejected",                 // Operator rejected the proposal
  "refinement_in_progress",   // Operator requested modification/alternative
  "cross_agent_pending",      // Cross-agent review required before deciding
];

/** Step 15 size limits */
const PLAN_REFINEMENT_MAX_STEPS = 10;
const REFINED_PLAN_SUMMARY_MAX_ENTRIES = 50;

/* ─────────────────────────────────────────────
   Step 16: Controlled Action Draft /
   Fix Bundle Preparation – Constants
   ─────────────────────────────────────────────
   These constants extend Steps 14+15 so that
   approved / refined plans can be translated
   into concrete, controlled solution drafts.

   Key principle: drafts are *prepared*, never
   *executed* autonomously.  The user must
   explicitly approve every draft before any
   productive action.
   ───────────────────────────────────────────── */

/**
 * Draft types – what kind of solution draft the agent prepares.
 * Each type maps to a specific domain of change.
 */
const VALID_DRAFT_TYPES = [
  "diagnosis_draft",         // Deeper diagnostic steps, no fix yet
  "backend_fix_draft",       // Backend-focused fix preparation
  "frontend_fix_draft",      // Frontend-focused fix preparation
  "partial_fix_draft",       // Scoped / limited fix draft
  "cross_agent_draft",       // Coordinated draft requiring both agents
  "data_contract_draft",     // API / data-contract change draft
  "mapping_fix_draft",       // Data-mapping / binding fix draft
  "route_hardening_draft",   // Route / API hardening draft
  "config_check_draft",      // Configuration / ops check draft
  "ui_clarity_draft",        // UI labeling / clarity improvement draft
];

/**
 * Change categories – what kind of change the draft represents.
 * Used for grouping, filtering, and summary views.
 */
const VALID_CHANGE_CATEGORIES = [
  "backend_logic",           // Core backend logic change
  "api_contract",            // API endpoint / contract change
  "data_mapping",            // Data-binding / mapping fix
  "frontend_structure",      // Frontend component / structure change
  "ui_clarity",              // UI labeling / copy improvement
  "ops_check",               // Operational / config verification
  "schema_alignment",        // Schema / model alignment fix
  "diagnosis_extension",     // Deeper diagnostic investigation
  "route_hardening",         // Route validation / security hardening
  "cross_layer_coordination",// Change that spans backend ↔ frontend
];

/**
 * Draft statuses – lifecycle of a single draft.
 */
const VALID_DRAFT_STATUSES = [
  "prepared",                // Draft created, awaiting review
  "reviewed",                // Draft reviewed by operator
  "approved_for_execution",  // Draft approved for productive execution
  "rejected",                // Draft rejected
  "superseded",              // Draft replaced by a newer version
  "needs_revision",          // Draft requires further changes
];

/** Step 16 size limits */
const ACTION_DRAFT_MAX_STEPS = 8;
const ACTION_DRAFT_SUMMARY_MAX_ENTRIES = 50;

/* ─────────────────────────────────────────────
   Step 17: Controlled Execution Proposal /
   Apply-Readiness / Final Approval Layer –
   Constants
   ─────────────────────────────────────────────
   These constants extend Steps 14–16 so that
   prepared drafts can be assessed for apply-
   readiness and a clear execution proposal /
   final approval proposal can be generated.

   Key principle: no productive execution.
   The system evaluates *how ready* a draft is,
   structures what is still missing, and
   prepares a clear approval package for the
   user.  The user always has the final say.
   ───────────────────────────────────────────── */

/**
 * Readiness bands: how close a draft is to being
 * ready for the next controlled application step.
 */
const VALID_READINESS_BANDS = [
  "not_ready",               // Draft not ready for any application
  "diagnosis_only",          // Only suitable for further diagnosis
  "review_ready",            // Ready for operator review
  "partial_apply_ready",     // Parts could be applied in isolation
  "final_approval_ready",    // Fully ready, awaiting last user OK
  "blocked_pending_review",  // Structurally ready but blocked
  "cross_agent_pending",     // Needs cross-agent alignment first
];

/**
 * Recommended apply modes: what the system would
 * suggest as a next step for this draft.
 */
const VALID_APPLY_MODES = [
  "diagnosis_only",          // No apply – deepen analysis
  "review_only",             // Recommend review, no apply yet
  "partial_apply",           // Partial / scoped application
  "full_apply_candidate",    // Full application candidate
  "handoff_first",           // Hand off to other agent first
  "wait_for_user",           // Wait for explicit user decision
];

/**
 * Blocking factor types: why a draft may not
 * be ready yet.
 */
const VALID_BLOCKING_FACTOR_TYPES = [
  "scope_unclear",           // Draft scope not fully defined
  "missing_confirmation",    // User confirmation still missing
  "cross_agent_dependency",  // Depends on other agent's work
  "needs_fresh_evidence",    // Newer diagnostic data needed
  "risk_not_mitigated",      // Identified risk not addressed
  "partial_coverage",        // Draft only covers part of problem
  "approval_pending",        // Explicit approval not yet given
  "handoff_incomplete",      // Cross-agent handoff not done
];

/**
 * Risk flag types: potential risks identified
 * in a draft.
 */
const VALID_RISK_FLAG_TYPES = [
  "scope_uncertainty",       // Scope may be wider than drafted
  "side_effect_possible",    // Fix may have side effects
  "regression_risk",         // Change could cause regressions
  "incomplete_testing",      // Testing coverage unclear
  "cross_layer_impact",      // Affects multiple system layers
  "data_integrity_concern",  // Could affect data consistency
  "timing_sensitivity",      // Timing-dependent change
];

/** Step 17 size limits */
const APPLY_READINESS_SUMMARY_MAX_ENTRIES = 50;

// ── Step 18 constants: Controlled Apply Simulation / Execution Preview / Reversal Safety ──

const VALID_PREVIEW_STATES = [
  "preview_not_available",
  "low_impact_preview",
  "moderate_impact_preview",
  "high_attention_preview",
  "blocked_pending_safety",
  "rollback_required",
  "cross_agent_preview_pending",
];

const VALID_SAFETY_BANDS = [
  "low_risk",
  "controlled_risk",
  "elevated_attention",
  "blocked",
];

const VALID_REVERSAL_COMPLEXITY = [
  "simple",
  "moderate",
  "complex",
  "not_reversible",
];

const VALID_APPLY_WINDOWS = [
  "safe_anytime",
  "low_activity_window",
  "after_review",
  "after_cross_agent_review",
  "not_recommended_yet",
];

const EXECUTION_PREVIEW_SUMMARY_MAX_ENTRIES = 50;

// ── Step 19 constants: Controlled Apply Candidate / Action Package / Approval Gate ──

const VALID_CANDIDATE_STATUSES = [
  "candidate_not_available",
  "candidate_diagnosis_only",
  "candidate_partial",
  "candidate_ready_for_final_approval",
  "candidate_blocked",
  "candidate_cross_agent_pending",
  "candidate_scope_confirmation_needed",
];

const VALID_CANDIDATE_MODES = [
  "diagnosis_only",
  "partial_scope",
  "backend_only",
  "frontend_only",
  "cross_agent_candidate",
  "final_approval_candidate",
  "wait_for_user",
];

const VALID_SCOPE_GUARDRAIL_TYPES = [
  "scope_boundary",
  "layer_restriction",
  "no_auto_execute",
  "requires_user_confirmation",
  "cross_agent_gate",
  "rollback_mandatory",
  "data_safety_gate",
];

const CANDIDATE_SUMMARY_MAX_ENTRIES = 50;

// ── Step 20 constants: Controlled Execution Orchestrator / Apply Runtime / Audit & Kill Switch ──

const VALID_RUNTIME_STATUSES = [
  "runtime_not_created",
  "runtime_blocked",
  "runtime_ready",
  "runtime_awaiting_user_start",
  "runtime_running",
  "runtime_completed",
  "runtime_aborted",
  "runtime_failed",
  "runtime_rollback_reserved",
];

const VALID_RUNTIME_MODES = [
  "dry_run",
  "controlled_apply",
  "partial_apply",
  "backend_only",
  "frontend_only",
  "cross_agent_controlled",
];

const VALID_EXECUTION_STATES = [
  "pending",
  "ready",
  "blocked",
  "active",
  "stopped",
  "finished",
  "failed",
];

const VALID_EXECUTION_GUARDRAIL_TYPES = [
  "no_auto_execute",
  "requires_user_start",
  "scope_locked",
  "no_scope_expansion",
  "target_restriction",
  "kill_switch_required",
  "abort_path_required",
  "rollback_on_failure",
  "cross_agent_gate",
];

const RUNTIME_SUMMARY_MAX_ENTRIES = 50;

// ── Step 21 constants: Agent Conversation Runtime / Persistent Case Chat / Freeform Admin Dialogue ──

/** Thread status values for agent conversation threads */
const VALID_THREAD_STATUSES = [
  "thread_open",
  "thread_waiting_for_user",
  "thread_waiting_for_agent",
  "thread_blocked",
  "thread_in_refinement",
  "thread_ready_for_decision",
  "thread_runtime_pending",
  "thread_closed",
];

/** Speaker roles for conversation messages */
const VALID_SPEAKER_AGENTS = [
  "user",
  "deepseek",
  "gemini",
  "system",
];

/** Speaker role labels for frontend display */
const VALID_SPEAKER_ROLES = [
  "admin",
  "backend_agent",
  "frontend_agent",
  "coordinator",
];

/** Message intents for conversation messages */
const VALID_CONVERSATION_INTENTS = [
  "question",
  "clarification",
  "scope_change",
  "diagnosis_request",
  "approval_feedback",
  "refinement",
  "runtime_question",
  "explanation",
  "recommendation",
  "handoff",
  "follow_up",
  "freeform",
];

/** Conversation phases for thread tracking */
const VALID_CONVERSATION_PHASES = [
  "problem_phase",
  "solution_phase",
  "feedback_phase",
  "refinement_phase",
  "draft_phase",
  "approval_phase",
  "preview_safety_phase",
  "candidate_gate_phase",
  "runtime_execution_phase",
  "conversation_phase",
  "cross_agent_handoff_phase",
];

/** Keywords for routing to DeepSeek (backend agent) */
const DEEPSEEK_ROUTING_KEYWORDS = [
  "backend", "api", "datenfluss", "code", "logik", "mapping",
  "runtime", "execution", "guard", "schema", "route", "endpoint",
  "service", "datenbank", "query", "server", "migration",
  "validierung", "controller", "middleware",
];

/** Keywords for routing to Gemini (frontend agent) */
const GEMINI_ROUTING_KEYWORDS = [
  "frontend", "ux", "design", "darstellung", "label", "layout",
  "ui", "anzeige", "karte", "ansicht", "button", "formular",
  "navigation", "farbe", "schrift", "responsive", "komponente",
  "verständlichkeit", "klarheit", "beschriftung",
];

const CONVERSATION_THREAD_MAX_ENTRIES = 200;
const CONVERSATION_MESSAGE_MAX_PER_THREAD = 100;
const CONVERSATION_SUMMARY_MAX_THREADS = 50;

/* ─────────────────────────────────────────────────────────────────────
   Step 22: Multi-Agent Handoff / Cross-Agent Dialogue /
            Coordinated Case Exchange Light

   Constants for controlled handoff between DeepSeek and Gemini
   within the same case/thread.
   ───────────────────────────────────────────────────────────────────── */

/** Handoff lifecycle statuses */
const VALID_HANDOFF_STATUSES = [
  "handoff_not_needed",
  "handoff_suggested",
  "handoff_pending",
  "handoff_in_progress",
  "handoff_completed",
];

/** Cross-agent coordination states */
const VALID_CROSS_AGENT_STATES = [
  "single_agent",
  "cross_agent_review_needed",
  "cross_agent_waiting",
  "cross_agent_active",
  "cross_agent_completed",
];

/** Reasons why a handoff is triggered */
const VALID_HANDOFF_REASONS = [
  "cross_layer_issue",
  "frontend_impact_detected",
  "backend_cause_detected",
  "ux_consequence",
  "data_flow_dependency",
  "scope_expansion",
  "user_requested",
  "complementary_expertise",
];

/** Message types specific to handoff / cross-agent coordination */
const VALID_HANDOFF_MESSAGE_TYPES = [
  "agent_reply",
  "handoff_initiation",
  "handoff_acceptance",
  "supporting_agent_reply",
  "handoff_completion",
  "cross_agent_note",
];

/** Keywords indicating cross-layer / dual-agent concerns */
const CROSS_LAYER_KEYWORDS = [
  "frontend und backend", "backend und frontend", "ui und api",
  "darstellung und logik", "anzeige und daten", "oberfläche und server",
  "schichtübergreifend", "cross-layer", "beide seiten", "beides",
  "zusammenspiel", "end-to-end", "full-stack", "fullstack",
  "api und darstellung", "datenfluss und anzeige", "mapping und ui",
];

/** Maximum handoff history entries per thread */
const HANDOFF_HISTORY_MAX_ENTRIES = 20;

/* ─────────────────────────────────────────────────────────────────────
   Step 23: Conversation Memory / Case Continuity / Agent Memory Anchors

   Constants for structured case memory that allows DeepSeek and Gemini
   to remember the working context, decisions, open points, and agreed
   directions within a case – without a large external persistence layer.
   ───────────────────────────────────────────────────────────────────── */

/** Continuity status taxonomy – how well established is the case memory */
const VALID_CONTINUITY_STATUSES = [
  "continuity_not_started",
  "continuity_light",
  "continuity_established",
  "continuity_needs_refresh",
];

/** Memory freshness – how recently was the case memory updated */
const VALID_MEMORY_FRESHNESS = [
  "memory_empty",
  "memory_partial",
  "memory_stable",
  "memory_recently_updated",
];

/** Anchor types – categories of meaningful case anchors */
const VALID_MEMORY_ANCHOR_TYPES = [
  "scope_decision",
  "direction_agreed",
  "direction_discarded",
  "user_preference",
  "open_question",
  "resolved_point",
  "handoff_completed",
  "plan_refinement",
  "approval_decision",
  "diagnosis_finding",
  "next_step_identified",
];

/** Maximum memory anchors per thread */
const CASE_MEMORY_MAX_ANCHORS = 30;

/** Maximum open questions per thread */
const CASE_MEMORY_MAX_OPEN_QUESTIONS = 15;

/** Maximum resolved points per thread */
const CASE_MEMORY_MAX_RESOLVED_POINTS = 30;

/* ─────────────────────────────────────────────────────────────────────
   Step 24: Action Negotiation / Option Comparison / Decision Framing

   Constants for structured action options that allow DeepSeek and Gemini
   to present 2–4 meaningful options per case, compare them along stable
   dimensions, and frame the decision space for the user.
   ───────────────────────────────────────────────────────────────────── */

/** Decision frame status – lifecycle of the option/comparison set */
const VALID_DECISION_FRAME_STATUSES = [
  "options_not_ready",
  "options_prepared",
  "options_stable",
  "decision_pending",
  "decision_narrowed",
  "decision_ready_for_user",
];

/** Option status – lifecycle of a single option */
const VALID_OPTION_STATUSES = [
  "option_draft",
  "option_viable",
  "option_preferred",
  "option_discarded",
  "option_needs_review",
];

/** Comparison dimensions – stable axes for option comparison */
const VALID_COMPARISON_DIMENSIONS = [
  "scopeWidth",
  "riskLevel",
  "safetyLevel",
  "implementationBreadth",
  "confidenceLevel",
  "expectedImpact",
  "reversibility",
  "needsCrossAgentSupport",
  "needsMoreDiagnosis",
  "readinessHint",
];

/** Dimension rating values – human-friendly assessment scale */
const VALID_DIMENSION_RATINGS = [
  "low",
  "moderate",
  "high",
  "very_high",
];

/** Decision modes – how the decision is framed */
const VALID_DECISION_MODES = [
  "conservative_vs_broad",
  "fast_vs_thorough",
  "scope_tradeoff",
  "risk_tradeoff",
  "diagnosis_vs_action",
  "single_layer_vs_cross_layer",
];

/** Option owner types – which agent primarily drives an option */
const VALID_OPTION_OWNER_TYPES = [
  "deepseek",
  "gemini",
  "cross_agent",
  "user_suggested",
];

/** Maximum action options per thread */
const DECISION_FRAME_MAX_OPTIONS = 4;

/** Maximum comparison dimensions per option */
const DECISION_FRAME_MAX_DIMENSIONS = 10;

/** Minimum open questions before preferring wait/clarify option */
const DECISION_OPEN_QUESTIONS_THRESHOLD = 2;

/* ─────────────────────────────────────────────────────────────────────
   Konferenz Step A: DeepSeek ↔ Gemini – Conference Session /
   Targeting / Mode / Summary

   Dedicated backend support for the conference workspace.
   Provides: session lifecycle, agent targeting, conference modes,
   conference summaries, and lightweight conference data model.

   Not: new architecture, autonomy, OpenAI, Claude, or monster platform.
   ───────────────────────────────────────────────────────────────────── */

/** Conference session lifecycle statuses */
const VALID_CONFERENCE_SESSION_STATUSES = [
  "session_open",
  "session_active",
  "session_paused",
  "session_closed",
  "session_archived",
];

/** Conference modes – how the conference room is operating */
const VALID_CONFERENCE_MODES = [
  "work_chat",
  "problem_solving",
  "decision_mode",
];

/** Target agent options – clean routing without text-prefix hacks */
const VALID_CONFERENCE_TARGET_AGENTS = [
  "deepseek",
  "gemini",
  "both",
  "system",
];

/** Maximum conference sessions in memory */
const CONFERENCE_SESSION_MAX_ENTRIES = 100;

/** Maximum messages per conference session */
const CONFERENCE_SESSION_MAX_MESSAGES = 500;

/* ─────────────────────────────────────────────
   Konferenz Step B: Coordination / Moderation / Coordinated Reply Flow
   ───────────────────────────────────────────── */

/** Reply patterns – how an answer is produced within the conference */
const VALID_CONFERENCE_REPLY_PATTERNS = [
  "solo_reply",           // Single agent answers alone
  "supporting_reply",     // Lead answers, support adds targeted supplement
  "coordinated_reply",    // Both agents contribute, merged before delivery
  "bundled_reply",        // Moderated summary combining both perspectives
  "needs_user_clarification", // Agents defer – clarification request instead
  "phase_closed",         // No new reply – phase is considered done
  "cross_agent_followup", // One agent follows up on the other's point
];

/** Coordination states – where the conference coordination currently stands */
const VALID_CONFERENCE_COORDINATION_STATES = [
  "uncoordinated",        // No coordination active (legacy / simple mode)
  "lead_assigned",        // One agent is clearly leading
  "support_active",       // Supporting agent is supplementing the lead
  "coordinated_active",   // Both agents actively coordinating
  "bundling_needed",      // Answers should be bundled before delivery
  "clarification_pending",// Waiting for user clarification
  "phase_closing",        // Current phase is wrapping up
  "phase_closed",         // Current phase is complete
];

/** Phase statuses – lifecycle of a discussion phase within a session */
const VALID_CONFERENCE_PHASE_STATUSES = [
  "phase_open",            // Discussion phase is open
  "problem_scoped",        // Problem has been scoped/narrowed
  "cause_identified",      // Root cause identified
  "recommendation_ready",  // Recommendation prepared
  "decision_pending",      // Decision awaiting user input
  "clarification_open",    // Open clarification needed
  "phase_concluded",       // Phase concluded with summary
];

/** Coordinator message types – quiet, value-adding moderation hints */
const VALID_COORDINATOR_MESSAGE_TYPES = [
  "lead_assigned",          // Agent X leads this point
  "supplement_added",       // Agent Y supplemented
  "reply_bundled",          // Replies were bundled into coordinated answer
  "clarification_needed",   // Clarification from user is needed
  "point_concluded",        // Point/topic concluded
  "phase_summary",          // Phase summary available
  "next_step_suggested",    // Suggested next step
  "leadership_changed",     // Lead agent changed
];

/** Keywords used to detect backend domain relevance (Step B lead derivation) */
const CONFERENCE_BACKEND_KEYWORDS = ["backend", "api", "server", "datenbank", "logik", "route", "endpoint", "service", "middleware"];

/** Keywords used to detect frontend domain relevance (Step B lead derivation) */
const CONFERENCE_FRONTEND_KEYWORDS = ["frontend", "ui", "ux", "design", "component", "darstellung", "layout", "css", "animation"];

/** Signals that indicate clarification is needed rather than expansion */
const CONFERENCE_CLARIFICATION_SIGNALS = ["was meinst du", "unklar", "könntest du", "nicht verstanden", "genauer", "was genau", "worum geht es", "bitte erkläre"];

/** Keywords indicating discussion convergence / phase closure */
const CONFERENCE_CONVERGENCE_KEYWORDS = ["einverstanden", "klar", "abgeschlossen", "verstanden", "passt", "reicht", "nächster punkt", "weiter", "gut so", "erledigt", "zusammengefasst"];

/** Signals indicating a user message covers multiple topics */
const CONFERENCE_TOPIC_SPLITTERS = ["und auch", "außerdem", "zusätzlich", "und dann noch", "plus"];

/* ─────────────────────────────────────────────
   Konferenz Step C: Conference Phases / Decision Room / Result Cards / Strategic Expansion
   ───────────────────────────────────────────── */

/** Work phases – structured lifecycle stages of a conference session */
const VALID_CONFERENCE_WORK_PHASES = [
  "intake",               // Topic and participants established
  "problem_clarification",// Problem or question being scoped/clarified
  "analysis",             // Deeper analysis of causes or dimensions
  "option_room",          // Options/alternatives actively being evaluated
  "tradeoff",             // Active tradeoff discussion, no clear winner yet
  "decision_preparation", // Direction converging, decision being prepared
  "result_transition",    // Result ready, preparing for handoff or next step
];

/** Decision room states – what is happening in the decision space */
const VALID_CONFERENCE_DECISION_ROOM_STATES = [
  "not_active",             // No decision room open
  "options_collected",      // Options gathered, not yet compared
  "options_compared",       // Options compared across dimensions
  "direction_emerging",     // One direction becoming preferred
  "direction_split",        // Agents disagree – split recommendation
  "tradeoff_open",          // Tradeoff explicitly unresolved
  "decision_ready",         // Decision crystallised, ready for user
];

/** Consensus states – where agreement / disagreement stands */
const VALID_CONFERENCE_CONSENSUS_STATES = [
  "neutral",              // No clear consensus or dissent signal yet
  "converging",           // Moving toward agreement
  "consensus_reached",    // Both agents and/or user agree on direction
  "partial_consensus",    // Agreement on some points, open on others
  "dissent_active",       // Clear disagreement between agents/perspectives
  "clarification_needed", // Consensus blocked by unresolved question
];

/** Controlled handoff directions – where the conference result could go next */
const VALID_CONFERENCE_HANDOFF_DIRECTIONS = [
  "continue_session",         // More work needed in this session
  "further_clarification",    // Clarification required before proceeding
  "prepare_draft",            // Start preparing a draft/proposal
  "prepare_candidate",        // Elevate to candidate / approval preparation
  "further_review",           // Send for broader review
  "pause_session",            // Pause for now, resume later
  "close_session",            // Session complete, no further step needed
];

/** Moderation signals – working hints from the moderator about session flow */
const VALID_CONFERENCE_MODERATION_SIGNALS = [
  "phase_stable",              // Current phase is still active and productive
  "ready_for_phase_advance",   // Enough material to move to the next phase
  "consensus_possible",        // Signals suggest convergence is achievable
  "dissent_requires_attention",// Disagreement needs to be addressed
  "clarification_blocking",    // A question is blocking progress
  "result_ready",              // A result or result card can be generated
  "handoff_ready",             // Session ready for controlled handoff
  "session_closing",           // Natural closing point reached
];

/** Keywords that signal entry into option evaluation / tradeoff territory */
const CONFERENCE_OPTION_KEYWORDS = ["option", "variante", "alternative", "möglichkeit", "entweder", "oder", "vergleich", "abwägung", "vor- und nachteile", "tradeoff"];

/** Keywords that signal a decision is being prepared */
const CONFERENCE_DECISION_KEYWORDS = ["entscheidung", "entscheiden", "beschluss", "festlegen", "wählen", "empfehle", "würde empfehlen", "bevorzuge", "beste wahl", "gehe mit"];

/** Keywords indicating a result/conclusion is forming */
const CONFERENCE_RESULT_KEYWORDS = ["ergebnis", "fazit", "zusammenfassung", "abschluss", "outcome", "ergibt sich", "im ergebnis", "abschließend", "final"];

/** Max character length for lastContribution excerpts in perspective comparison */
const PERSPECTIVE_CONTRIBUTION_MAX_LENGTH = 150;

/* ─────────────────────────────────────────────
   Konferenz Step D: Live Dialog / User Message Handling /
   Agent Reply Routing / Dialogue Reliability

   Strengthens the conference into a real live dialog room:
   - Free user messages per session, sauber gespeichert
   - Stable agent targeting (deepseek/gemini/both/system)
   - Agent replies routed back into the same session thread
   - Reply reference / context (responseType, replyToMessageId, followUpOf)
   - Follow-up and counter-question support
   - Pending/lifecycle states for reliable dialog tracking
   - Enhanced admin summary with dialog quality metrics
   ───────────────────────────────────────────────────────── */

/** Response types – what kind of reply an agent is giving */
const VALID_CONFERENCE_RESPONSE_TYPES = [
  "direct_answer",   // Direct answer to user question
  "clarification",   // Clarifying the question or context
  "rückfrage",       // Counter-question: agent asks user for more info
  "follow_up",       // Extends or builds on a previous answer in the thread
  "coordinated",     // Part of a coordinated multi-agent reply
  "summary",         // Summary of the thread or current topic
];

/** Dialog states – lifecycle of a user ↔ agent exchange within a session */
const VALID_CONFERENCE_DIALOG_STATES = [
  "dialog_idle",              // No recent message; session open but quiet
  "message_received",         // User message just recorded, routing in progress
  "agent_reply_pending",      // Routing decided, agent reply not yet recorded
  "reply_delivered",          // Agent reply recorded; awaiting next user action
  "additional_agent_pending", // First agent replied; second agent (both mode) still pending
  "reply_cycle_complete",     // All targeted agents replied; cycle finished
  "clarification_open",       // Agent returned a Rückfrage; awaiting user follow-up
  "follow_up_pending",        // Recent follow-up message; reply cycle not yet complete
];

/** Keywords indicating a follow-up or clarification from the user */
const CONFERENCE_FOLLOWUP_KEYWORDS = [
  "nochmal", "ergänzend", "noch eine frage", "noch etwas", "und was", "außerdem",
  "ich meinte", "korrigiere", "genauer", "was noch", "kannst du", "und wenn",
  "was ist mit", "was passiert", "wie sieht es aus", "was würdest du", "warum",
  "konkret", "beispiel", "detail", "bitte erkläre", "erkläre mir",
];

/** Max length for lastUserMessage excerpt stored on session */
const CONFERENCE_LAST_USER_MSG_MAX_LENGTH = 200;

/** Max chars of userMessage sent to AI APIs – prevents oversized payloads */
const CONFERENCE_USER_MSG_MAX_INPUT = 4000;

/** Max chars of each historical message included in conversation-history prompts */
const CONFERENCE_HISTORY_MSG_MAX_LENGTH = 400;

/** Max chars for the conferenceFocus field */
const CONFERENCE_FOCUS_MAX_LENGTH = 200;

/** Max chars of userMessage sent to Step-21 conversation AI APIs */
const CONVERSATION_USER_MSG_MAX_INPUT = 4000;

/* ─────────────────────────────────────────────────────────────────────
   Konferenz Step E: Companion Multi-Agent Both-Mode Backend –
   Dual Reply Routing / Same-Thread Two-Agent Responses /
   Explicit Both Opinion Flow

   Strengthens the "both" mode into a first-class dual-agent reply flow:
   - Explicit both-mode detection (text and parameter)
   - Two real agent replies (DeepSeek + Gemini) in the same thread
   - Structured reply references and cooperation types
   - Pending state between first and second reply
   - Both-mode metrics in admin summary
   - bothModeContext injected into Gemini prompt
   ───────────────────────────────────────────────────────────────────── */

/** Cooperation types for second-agent reply in both-mode */
const VALID_BOTH_MODE_COOPERATION_TYPES = [
  "supplements",      // Gemini adds complementary information to DeepSeek's reply
  "aligns",           // Gemini agrees and confirms DeepSeek's main point
  "contrasts",        // Gemini offers a different angle or priority
  "extends",          // Gemini deepens the reply with additional scope
  "dissent_light",    // Gemini mildly disagrees on a specific aspect
  "common_line",      // Both agents converge on same recommendation
];

/** Sequence position of an agent reply in a both-mode cycle */
const VALID_BOTH_MODE_SEQUENCES = [
  "primary",    // First agent to reply (DeepSeek leads by default)
  "secondary",  // Second agent to reply (Gemini supplements by default)
];

/**
 * Conservative German phrases that indicate a user explicitly wants
 * both agents to respond. Only used when no explicit targetAgent="both"
 * is set. Matching is phrase-boundary-aware.
 */
const BOTH_MODE_DETECTION_PHRASES = [
  "beide meinungen",
  "beide eure einschätzung",
  "beide ihre einschätzung",
  "deepseek und gemini",
  "gemini und deepseek",
  "was meint ihr beide",
  "ich will beide",
  "gebt mir beide",
  "beide antworten",
  "beide sichtweisen",
  "beide perspektiven",
  "von beiden",
  "euch beide",
];

/** Minimum word length when computing overlap for common_line detection */
const BOTH_MODE_MIN_WORD_LENGTH_FOR_OVERLAP = 4;

/** Minimum number of shared words for the secondary reply to be classified as common_line */
const BOTH_MODE_MIN_OVERLAP_FOR_COMMON_LINE = 3;

/* ─────────────────────────────────────────────
   In-memory bridge state (lightweight, no DB)
   Stores the most recently generated bridge
   package and any pending frontend feedback.
   ───────────────────────────────────────────── */

let _currentBridgePackage = null;
let _pendingFrontendFeedback = [];

/* ─────────────────────────────────────────────
   Step 14: In-memory agent case & chat stores
   ───────────────────────────────────────────── */

/** @type {Map<string, Object>} agentCaseId → agent case object */
const _agentCaseRegistry = new Map();

/** @type {Array<Object>} ordered list of agent chat messages */
const _agentChatMessages = [];

/** Auto-increment counter for agent case IDs */
let _agentCaseIdCounter = 0;

/* ─────────────────────────────────────────────
   Step 21: In-memory conversation thread store
   ───────────────────────────────────────────── */

/** @type {Map<string, Object>} threadId → conversation thread object */
const _conversationThreads = new Map();

/** Auto-increment counter for conversation message IDs */
let _conversationMsgCounter = 0;

/* ─────────────────────────────────────────────
   Conference Agent Registry
   ───────────────────────────────────────────────────────────────────
   To add a new AI participant to the conference system, add one entry
   here. No other code needs to change for basic participation.

   Each entry must provide:
     id           – unique string identifier used as targetAgent value
     label        – human-readable name used in German prompts
     role         – speaker role string (e.g. "backend_agent")
     domain       – domain description used in German prompts
     isConfigured – () => boolean, returns true when the API key / SDK is ready
     callApi      – async (systemPrompt, userMessage, opts) => string
                    must throw on failure (fallback is handled by caller)
   ───────────────────────────────────────────────────────────────────
   */
const _conferenceAgentRegistry = new Map([
  [
    "deepseek",
    {
      id: "deepseek",
      label: "DeepSeek (Backend)",
      role: "backend_agent",
      domain: "Backend-Entwicklung, APIs und Systemlogik",
      isConfigured: () => isDeepSeekConfigured(),
      async callApi(systemPrompt, userMessage, opts = {}) {
        const completion = await createDeepSeekChatCompletion({
          tier: "fast",
          timeoutMs: opts.timeoutMs || 20000,
          temperature: opts.temperature || 0.5,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
        });
        const text = completion?.choices?.[0]?.message?.content || "";
        if (!text.trim()) throw new Error("DEEPSEEK_EMPTY_RESPONSE");
        return text.trim();
      },
    },
  ],
  [
    "gemini",
    {
      id: "gemini",
      label: "Gemini (Frontend)",
      role: "frontend_agent",
      domain: "Frontend-Entwicklung, UX und Systemarchitektur",
      isConfigured: () => isGeminiConfigured(),
      async callApi(systemPrompt, userMessage, opts = {}) {
        const result = await runGeminiChat({
          systemPrompt,
          userMessage,
          maxTokens: opts.maxTokens || 512,
          timeoutMs: opts.timeoutMs || 22000,
        });
        if (result.success && result.text.trim()) return result.text.trim();
        throw new Error(result.error || "GEMINI_EMPTY_RESPONSE");
      },
    },
  ],
]);

/* ─────────────────────────────────────────────
   Konferenz Step A: In-memory conference session store
   ───────────────────────────────────────────── */

/** @type {Map<string, Object>} conferenceId → conference session object */
const _conferenceSessions = new Map();

/** Auto-increment counter for conference session IDs */
let _conferenceIdCounter = 0;

/** Auto-increment counter for conference message IDs */
let _conferenceMsgCounter = 0;

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
   Step 7: In-memory recommendation feedback
   ─────────────────────────────────────────────
   Stores lightweight retrospective feedback on
   recommendations so the system can learn which
   recommendation types and action types tend to
   be helpful, too early, unclear, etc.

   Deliberately separate from readiness (Step 6).
   ───────────────────────────────────────────── */

/** @type {Array<Object>} */
let _recommendationFeedbackLog = [];

/* ─────────────────────────────────────────────
   Step 11: In-memory case registry (lightweight)
   ─────────────────────────────────────────────
   Tracks the operative Bearbeitungszustand of
   hints / recommendations / issues as lightweight
   cases.  No database – purely in-memory,
   intentionally ephemeral.

   Each entry is keyed by patternKey and tracks:
   - caseStatus (open/watching/confirmed/resolved/
     dismissed/needs_followup)
   - caseOutcome (pending/confirmed_helpful/…)
   - helpfulness assessment
   - operator notes
   ───────────────────────────────────────────── */

/** @type {Map<string, CaseRegistryEntry>} */
const _caseRegistry = new Map();

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
   Step 7: Improvement context derivation
   ─────────────────────────────────────────────
   Looks up whether we already have retrospective
   feedback for a pattern and returns a compact
   improvement context object.  This is injected
   into the bridge package so Gemini can see
   whether this type of recommendation has
   historically been helpful or not.

   Readiness (Step 6) stays separate – this
   is purely about retrospective quality.
   ───────────────────────────────────────────── */

/**
 * Derive improvement context for a given pattern key.
 *
 * @param {string} patternKey – the pattern key to look up
 * @returns {Object} compact improvement context (may be empty)
 */
function _deriveImprovementContext(patternKey) {
  const empty = {
    hasFeedback:          false,
    dominantFeedback:     null,
    dominantImprovement:  null,
    feedbackCount:        0,
    needsAdjustment:      false,
  };

  if (!patternKey) return empty;
  const entry = _patternMemory.get(patternKey);
  if (!entry || !entry.feedbackTally || Object.keys(entry.feedbackTally).length === 0) {
    return empty;
  }

  const dominantFeedback    = _topKey(entry.feedbackTally);
  const dominantImprovement = _topKey(entry.improvementTally);
  const feedbackCount       = Object.values(entry.feedbackTally).reduce((a, b) => a + b, 0);

  // Determine if adjustment is likely needed
  const needsAdjustment = ["too_early", "unclear", "not_needed"].includes(dominantFeedback);

  return {
    hasFeedback:         true,
    dominantFeedback,
    dominantImprovement: dominantImprovement || null,
    feedbackCount,
    needsAdjustment,
  };
}

/* ─────────────────────────────────────────────
   Step 8: Governance / Policy classification
   ─────────────────────────────────────────────
   Classifies a recommendation into a governance
   policy class based on readiness, confidence,
   pattern stability, feedback history and
   evidence sufficiency.

   Rules are transparent and conservative:
   - guardian_candidate  requires strong evidence,
     confirmed pattern AND positive feedback
   - admin_visible       requires moderate
     confidence, recurring pattern
   - needs_more_evidence covers promising signals
     that lack sufficient backing
   - internal_only       for signals with some
     substance but no visibility justification
   - shadow_only         for early / weak /
     unstable signals

   This NEVER auto-promotes or auto-publishes.
   It only classifies for later human review.
   ───────────────────────────────────────────── */

/**
 * Classify a recommendation / signal into a
 * governance policy class.
 *
 * @param {Object} params
 * @param {string}  params.readinessBand       – from Step 6
 * @param {string}  params.confidenceBand      – from Step 4
 * @param {string}  params.patternKey          – pattern key
 * @param {Object}  params.improvementContext  – from Step 7
 * @param {number}  params.hintCount           – number of hints
 * @param {number}  params.highSeverityCount   – count of high-severity hints
 * @returns {{ policyClass: string, guardianEligibility: boolean,
 *             needsMoreEvidence: boolean, reason: string }}
 */
function classifyGovernancePolicy(params = {}) {
  const {
    readinessBand      = "observation",
    confidenceBand     = "low",
    patternKey         = null,
    improvementContext = {},
    hintCount          = 0,
    highSeverityCount  = 0,
  } = params;

  const reasons = [];

  // ── Look up pattern stability ──
  const patternEntry = patternKey ? _patternMemory.get(patternKey) : null;
  const patternCount = patternEntry ? patternEntry.count : 0;

  // ── Assess evidence sufficiency ──
  const evidenceSufficiency = _assessEvidenceSufficiency({
    patternCount,
    feedbackCount:    improvementContext.feedbackCount || 0,
    confidenceBand,
    hintCount,
    highSeverityCount,
  });

  // ── Assess guardian eligibility ──
  const guardianEligibility = _assessGuardianEligibility({
    readinessBand,
    confidenceBand,
    patternCount,
    improvementContext,
    evidenceSufficiency,
  });

  // ── Classify policy class (conservative, bottom-up) ──
  let policyClass = "shadow_only"; // most restricted default

  if (hintCount === 0) {
    policyClass = "shadow_only";
    reasons.push("Keine Hinweise vorhanden");
  } else if (guardianEligibility.eligible) {
    policyClass = "guardian_candidate";
    reasons.push(...guardianEligibility.reasons);
  } else if (
    !evidenceSufficiency.sufficient &&
    (readinessBand === "useful_next_step" || readinessBand === "mature_recommendation")
  ) {
    policyClass = "needs_more_evidence";
    reasons.push("Handlungsreife vorhanden, aber Evidenz noch unzureichend");
    reasons.push(...evidenceSufficiency.missingReasons);
  } else if (
    confidenceBand !== "low" &&
    patternCount >= GOV_MIN_PATTERN_COUNT_FOR_ADMIN &&
    readinessBand !== "observation"
  ) {
    policyClass = "admin_visible";
    reasons.push(`Muster ${patternCount}x bestätigt`);
    reasons.push(`Konfidenz: ${confidenceBand}`);
  } else if (
    hintCount >= 2 ||
    confidenceBand === "medium" ||
    readinessBand === "further_check_recommended"
  ) {
    policyClass = "internal_only";
    reasons.push("Signal vorhanden, aber noch nicht admin-sichtbar");
  } else {
    policyClass = "shadow_only";
    reasons.push("Frühes Signal – nur interne Beobachtung");
  }

  // ── Override: negative feedback history demotes ──
  if (
    policyClass !== "shadow_only" &&
    improvementContext.hasFeedback &&
    improvementContext.needsAdjustment
  ) {
    // Don't promote beyond needs_more_evidence if feedback is negative
    if (policyClass === "guardian_candidate" || policyClass === "admin_visible") {
      policyClass = "needs_more_evidence";
      reasons.push("Bisherige Rückmeldung deutet auf Verbesserungsbedarf");
    }
  }

  return {
    policyClass,
    guardianEligibility: guardianEligibility.eligible,
    needsMoreEvidence:   !evidenceSufficiency.sufficient,
    reason:              reasons.join("; ") || "Standardklassifikation",
  };
}

/**
 * Assess whether a signal has enough evidence to
 * be considered sufficiently backed.
 *
 * This is deliberately conservative – the system
 * should require clear evidence before promoting.
 *
 * @param {Object} params
 * @returns {{ sufficient: boolean, missingReasons: string[] }}
 */
function _assessEvidenceSufficiency(params) {
  const {
    patternCount      = 0,
    feedbackCount     = 0,
    confidenceBand    = "low",
    hintCount         = 0,
    highSeverityCount = 0,
  } = params;

  const missingReasons = [];
  let score = 0;

  // Pattern recurrence
  if (patternCount >= GOV_MIN_PATTERN_COUNT_FOR_ADMIN) score += 2;
  else missingReasons.push(`Muster erst ${patternCount}x beobachtet (min. ${GOV_MIN_PATTERN_COUNT_FOR_ADMIN})`);

  // Confidence level
  if (confidenceBand === "high") score += 2;
  else if (confidenceBand === "medium") score += 1;
  else missingReasons.push("Konfidenz noch niedrig");

  // Hint richness
  if (hintCount >= 3) score += 1;
  if (highSeverityCount >= 1) score += 1;

  // Feedback availability
  if (feedbackCount >= 1) score += 1;

  return {
    sufficient:     score >= 3,
    missingReasons,
  };
}

/**
 * Assess whether a recommendation is eligible
 * to be marked as a guardian candidate.
 *
 * Guardian candidacy requires:
 * - sufficient pattern stability (≥4 observations)
 * - adequate readiness (useful_next_step or mature)
 * - sufficient feedback with positive tendency
 * - medium or high confidence
 *
 * This NEVER auto-promotes.  It only marks
 * eligibility for later human review.
 *
 * @param {Object} params
 * @returns {{ eligible: boolean, reasons: string[] }}
 */
function _assessGuardianEligibility(params) {
  const {
    readinessBand      = "observation",
    confidenceBand     = "low",
    patternCount       = 0,
    improvementContext = {},
    evidenceSufficiency = { sufficient: false },
  } = params;

  const reasons = [];
  let eligible = true;

  // Must have sufficient evidence base
  if (!evidenceSufficiency.sufficient) {
    eligible = false;
  }

  // Pattern must be well-confirmed
  if (patternCount < GOV_MIN_PATTERN_COUNT_FOR_GUARDIAN) {
    eligible = false;
  } else {
    reasons.push(`Muster ${patternCount}x bestätigt`);
  }

  // Readiness must be at least useful_next_step
  if (!GOV_READINESS_BANDS_FOR_GUARDIAN.includes(readinessBand)) {
    eligible = false;
  } else {
    reasons.push(`Handlungsreife: ${readinessBand}`);
  }

  // Confidence must be at least medium
  if (confidenceBand === "low") {
    eligible = false;
  } else {
    reasons.push(`Konfidenz: ${confidenceBand}`);
  }

  // Feedback must exist and be predominantly positive
  if (improvementContext.hasFeedback) {
    const feedbackCount = improvementContext.feedbackCount || 0;
    if (feedbackCount < GOV_MIN_FEEDBACK_FOR_GUARDIAN) {
      eligible = false;
    } else {
      const dominantFeedback = improvementContext.dominantFeedback;
      const isPositive = ["helpful", "usable"].includes(dominantFeedback);
      if (!isPositive) {
        eligible = false;
      } else {
        reasons.push(`Rückmeldung überwiegend positiv (${dominantFeedback})`);
      }
    }
  } else {
    // No feedback yet → cannot be guardian candidate
    eligible = false;
  }

  // Negative improvement signal blocks guardian candidacy
  if (improvementContext.needsAdjustment) {
    eligible = false;
  }

  if (!eligible) {
    reasons.length = 0;
    reasons.push("Guardian-Voraussetzungen noch nicht erfüllt");
  }

  return { eligible, reasons };
}

/* ─────────────────────────────────────────────
   Step 10: Issue Intelligence classification
   ───────────────────────────────────────────── */

function deriveIssueCategory(hints, fallbackText = "") {
  const text = [
    fallbackText,
    ...hints.map((h) => `${h.title || ""} ${h.summary || ""}`),
  ].join(" ").toLowerCase();

  for (const rule of ISSUE_KEYWORD_RULES) {
    if (rule.keywords.some((kw) => text.includes(kw))) {
      return rule.category;
    }
  }

  const issueVotes = {};
  for (const h of hints) {
    const category = HINT_TYPE_TO_ISSUE_CATEGORY[h.type] || "unknown_issue";
    issueVotes[category] = (issueVotes[category] || 0) + (SEVERITY_WEIGHT[h.severity] || 1);
  }

  let bestCategory = "unknown_issue";
  let bestScore = 0;
  for (const [category, score] of Object.entries(issueVotes)) {
    if (score > bestScore) {
      bestCategory = category;
      bestScore = score;
    }
  }

  return bestCategory;
}

function assessIssueSeverity(hints, readinessBand, confidenceBand) {
  const highCount = hints.filter((h) => h.severity === "high").length;
  const medCount = hints.filter((h) => h.severity === "medium").length;

  if (
    highCount >= 2 ||
    (highCount >= 1 &&
      ["useful_next_step", "mature_recommendation"].includes(readinessBand) &&
      confidenceBand !== "low")
  ) {
    return "high";
  }

  if (
    highCount >= 1 ||
    medCount >= 2 ||
    ["further_check_recommended", "useful_next_step", "mature_recommendation"].includes(readinessBand)
  ) {
    return "medium";
  }

  return "low";
}

function buildIssueReason(issueCategory, issueSeverity, hints, patternKey) {
  const reasons = [];
  if (issueCategory && issueCategory !== "unknown_issue") {
    reasons.push(`Problemtyp: ${issueCategory}`);
  }
  if (issueSeverity !== "low") {
    reasons.push(`Einstufung: ${issueSeverity}`);
  }
  const highCount = hints.filter((h) => h.severity === "high").length;
  if (highCount > 0) {
    reasons.push(`${highCount} Hinweis(e) mit hoher Dringlichkeit`);
  }
  const patternEntry = patternKey ? _patternMemory.get(patternKey) : null;
  if (patternEntry && patternEntry.count >= 2) {
    reasons.push(`Muster ${patternEntry.count}x beobachtet`);
  }
  if (!reasons.length) {
    reasons.push("Frühe Auffälligkeit – weitere Prüfung sinnvoll");
  }
  return reasons.join("; ");
}

function classifyIssueIntelligence(params = {}) {
  const {
    hints = [],
    readinessBand = "observation",
    confidenceBand = "low",
    patternKey = null,
    fallbackText = "",
  } = params;

  const issueCategory = deriveIssueCategory(hints, fallbackText);
  const label = ISSUE_LABELS[issueCategory] || ISSUE_LABELS.unknown_issue;
  const issueSeverity = assessIssueSeverity(hints, readinessBand, confidenceBand);
  const needsFollowup =
    issueSeverity !== "low" ||
    ["further_check_recommended", "useful_next_step", "mature_recommendation"].includes(readinessBand) ||
    issueCategory === "unknown_issue";

  return {
    issueType: label.issueType,
    issueCategory,
    issueSeverity,
    affectedLayer: label.affectedLayer,
    suspectedCause: label.suspectedCause,
    suggestedFix: label.suggestedFix,
    needsFollowup,
    issueConfidence: confidenceBand,
    issueReason: buildIssueReason(issueCategory, issueSeverity, hints, patternKey),
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

  // ── Step 7: Derive improvement context from pattern memory ──
  const improvementContext = _deriveImprovementContext(bridgePatternKey);

  // ── Step 8: Governance / Policy classification ──
  // Derive a lightweight confidence estimate from hint quality alone
  // (no full signal object available at package level)
  const highSeverityCount = bridgeHints.filter((h) => h.severity === "high").length;
  const medSeverityCount  = bridgeHints.filter((h) => h.severity === "medium").length;
  let packageConfidenceBand = "low";
  if (highSeverityCount >= 1 && bridgeHints.length >= 3) packageConfidenceBand = "high";
  else if (medSeverityCount >= 1 || bridgeHints.length >= 2)  packageConfidenceBand = "medium";

  const governancePolicy = classifyGovernancePolicy({
    readinessBand:     packageReadiness.band,
    confidenceBand:    packageConfidenceBand,
    patternKey:        bridgePatternKey,
    improvementContext,
    hintCount:         bridgeHints.length,
    highSeverityCount,
  });

  const issueContext = classifyIssueIntelligence({
    hints: bridgeHints,
    readinessBand: packageReadiness.band,
    confidenceBand: packageConfidenceBand,
    patternKey: bridgePatternKey,
    fallbackText: [
      backendState.lastKnownArea,
      reviewIntent,
      impactTranslation.impactSummary,
    ].filter(Boolean).join(" "),
  });

  // ── Step 11: Case / Resolution classification ──
  const caseClassification = classifyCaseStatus({
    patternKey:    bridgePatternKey,
    readinessBand: packageReadiness.band,
    confidenceBand: packageConfidenceBand,
    issueSeverity: issueContext.issueSeverity,
    needsFollowup: issueContext.needsFollowup,
    hintCount:     bridgeHints.length,
  });

  // Ensure case registry entry exists (does not overwrite manual decisions)
  _ensureCaseRegistryEntry(bridgePatternKey, caseClassification);

  // ── Step 12: Attention / Priority classification ──
  const patternEntry = bridgePatternKey ? _patternMemory.get(bridgePatternKey) : null;
  const attentionClassification = classifyAttentionPriority({
    issueSeverity:         issueContext.issueSeverity,
    caseStatus:            caseClassification.caseStatus,
    readinessBand:         packageReadiness.band,
    confidenceBand:        packageConfidenceBand,
    governancePolicyClass: governancePolicy.policyClass,
    helpfulnessBand:       caseClassification.helpfulnessBand,
    needsFollowup:         issueContext.needsFollowup,
    patternCount:          patternEntry ? patternEntry.count : 0,
    hintCount:             bridgeHints.length,
  });

  // ── Step 13: Decision Maturity / Resolution Confidence classification ──
  const maturityClassification = classifyDecisionMaturity({
    observationCount:     patternEntry ? patternEntry.count : 0,
    confidenceBand:       packageConfidenceBand,
    readinessBand:        packageReadiness.band,
    caseStatus:           caseClassification.caseStatus,
    helpfulnessBand:      caseClassification.helpfulnessBand,
    governancePolicyClass: governancePolicy.policyClass,
    issueSeverity:        issueContext.issueSeverity,
    attentionBand:        attentionClassification.attentionBand,
    needsFollowup:        issueContext.needsFollowup,
    hintCount:            bridgeHints.length,
  });

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
    // Step 7: recommendation improvement context (retrospective feedback)
    improvementContext,
    // Step 8: governance / policy classification (visibility steering)
    governanceContext: {
      policyClass:         governancePolicy.policyClass,
      guardianEligibility: governancePolicy.guardianEligibility,
      needsMoreEvidence:   governancePolicy.needsMoreEvidence,
      governanceReason:    governancePolicy.reason,
    },
    issueContext,
    // Step 11: case / resolution / operator loop (operative Verlaufsform)
    caseContext: {
      caseStatus:       caseClassification.caseStatus,
      caseOutcome:      caseClassification.caseOutcome,
      helpfulnessBand:  caseClassification.helpfulnessBand,
      caseReason:       caseClassification.caseReason,
    },
    // Step 12: attention / priority / operator focus (ruhige Aufmerksamkeitsschicht)
    attentionContext: {
      attentionBand:   attentionClassification.attentionBand,
      attentionScore:  attentionClassification.attentionScore,
      attentionReason: attentionClassification.attentionReason,
      focusDrivers:    attentionClassification.focusDrivers,
    },
    // Step 13: decision maturity / resolution confidence (ruhige Reifeschicht)
    maturityContext: {
      decisionMaturityBand: maturityClassification.decisionMaturityBand,
      maturityScore:        maturityClassification.maturityScore,
      maturityReason:       maturityClassification.maturityReason,
      maturityDrivers:      maturityClassification.maturityDrivers,
    },
    meta: {
      hintsTotal:     rawHints.length,
      hintsKept:      bridgeHints.length,
      hintsDropped:   dropped,
      sourceMode:     sourceMode || null,
    },
  };

  _currentBridgePackage = pkg;

  // ── Step 14: Derive agent case from completed bridge package ──
  const agentCase = buildAgentCaseFromBridgePackage(pkg);
  if (agentCase) {
    pkg.agentCaseContext = {
      agentCaseId:            agentCase.agentCaseId,
      agentRole:              agentCase.agentRole,
      problemType:            agentCase.problemType,
      problemTitle:           agentCase.problemTitle,
      suspectedRootCause:     agentCase.suspectedRootCause,
      recommendedFixes:       agentCase.recommendedFixes,
      approvalQuestion:       agentCase.approvalQuestion,
      agentConfidence:        agentCase.agentConfidence,
      needsApproval:          agentCase.needsApproval,
      approvalScope:          agentCase.approvalScope,
      nextSuggestedStep:      agentCase.nextSuggestedStep,
      chatMessage:            agentCase.chatMessage,
    };

    // ── Step 16: Attach action draft context when available ──
    if (agentCase.actionDraft16) {
      const ad = agentCase.actionDraft16;
      pkg.actionDraftContext = {
        draftType:              ad.draftType,
        draftStatus:            ad.draftStatus,
        changeCategory:         ad.changeCategory,
        draftSummary:           ad.draftSummary,
        preparationOwner:       ad.preparationOwner,
        affectedDomain:         ad.affectedTargets ? ad.affectedTargets.affectedDomain : null,
        handoffSuggested:       ad.handoffSuggested,
        requiresFurtherApproval: ad.requiresFurtherApproval,
      };
    }

    // ── Step 17: Attach apply-readiness context when available ──
    if (agentCase.applyReadiness17) {
      const ar = agentCase.applyReadiness17;
      pkg.applyReadinessContext = {
        readinessScore:        ar.readinessScore,
        readinessBand:         ar.readinessBand,
        recommendedApplyMode:  ar.recommendedApplyMode,
        eligibleForApply:      ar.eligibleForApply,
        applyBlocked:          ar.applyBlocked,
        executionOwner:        ar.executionOwner,
        proposalOwner:         ar.proposalOwner,
        executionIntent:       ar.executionIntent,
        requiresFinalApproval: ar.requiresFinalApproval,
        blockingFactorCount:   (ar.blockingFactors || []).length,
        riskFlagCount:         (ar.riskFlags || []).length,
        openCheckCount:        (ar.openChecks || []).length,
      };
    }

    // ── Step 18: Attach execution preview context when available ──
    if (agentCase.executionPreview18) {
      const ep = agentCase.executionPreview18;
      pkg.executionPreviewContext = {
        previewState:           ep.previewState,
        safetyBand:             ep.safetyBand,
        previewConfidence:      ep.previewConfidence,
        previewBlocked:         ep.previewBlocked,
        dryRunOnly:             ep.dryRunOnly,
        reversalComplexity:     ep.reversalComplexity,
        rollbackRecommended:    ep.rollbackRecommended,
        recommendedApplyWindow: ep.recommendedApplyWindow,
        previewOwner:           ep.previewOwner,
        safetyOwner:            ep.safetyOwner,
        needsCrossAgentReview:  ep.needsCrossAgentReview,
        expectedImpactCount:    (ep.expectedImpact || []).length,
        sideEffectCount:        (ep.possibleSideEffects || []).length,
        preApplyCheckCount:     (ep.preApplyChecks || []).length,
        previewWarningCount:    (ep.previewWarnings || []).length,
      };
    }

    // ── Step 19: Attach apply candidate context when available ──
    if (agentCase.applyCandidate19) {
      const ac = agentCase.applyCandidate19;
      pkg.applyCandidateContext = {
        candidateStatus:                ac.candidateStatus,
        candidateMode:                  ac.candidateMode,
        candidateVersion:               ac.candidateVersion,
        candidateReadyForFinalApproval: ac.candidateReadyForFinalApproval,
        candidateBlocked:               ac.candidateBlocked,
        scopeLocked:                    ac.scopeLocked,
        candidateOwner:                 ac.candidateOwner,
        gateOwner:                      ac.gateOwner,
        finalApprovalOwner:             ac.finalApprovalOwner,
        needsCrossAgentReview:          ac.needsCrossAgentReview,
        includedActionCount:            (ac.includedActions || []).length,
        excludedActionCount:            (ac.excludedActions || []).length,
        guardrailCount:                 (ac.guardrails || []).length,
        preconditionCount:              (ac.finalPreconditions || []).length,
        checklistItemCount:             (ac.approvalChecklist || []).length,
        missingApprovalCount:           (ac.missingApprovals || []).length,
      };
    }

    // ── Step 20: Attach execution runtime context when available ──
    if (agentCase.executionSession20) {
      const es = agentCase.executionSession20;
      pkg.executionRuntimeContext = {
        runtimeId:               es.runtimeId,
        runtimeStatus:           es.runtimeStatus,
        runtimeMode:             es.runtimeMode,
        executionState:          es.executionState,
        executionAllowed:        es.executionAllowed,
        executionBlocked:        es.executionBlocked,
        runtimeOwner:            es.runtimeOwner,
        executionOwner:          es.executionOwner,
        finalApprovalOwner:      es.finalApprovalOwner,
        abortAvailable:          es.abortAvailable,
        killSwitchAvailable:     es.killSwitchAvailable,
        rollbackReserved:        es.rollbackReserved,
        rollbackOnFailure:       es.rollbackOnFailure,
        needsCrossAgentReview:   es.needsCrossAgentReview,
        guardrailCount:          (es.runtimeGuardrails || []).length,
        checklistItemCount:      (es.runtimeChecklist || []).length,
        auditEntryCount:         (es.executionAudit || []).length,
        dryRunOnly:              es.dryRunOnly,
      };
    }

    // ── Step 21: Attach conversation context when a thread exists ──
    const convThread = _conversationThreads.get(agentCase.agentCaseId);
    if (convThread) {
      pkg.conversationContext = {
        threadId:            convThread.threadId,
        threadStatus:        convThread.threadStatus,
        conversationState:   convThread.conversationState,
        conversationOpen:    convThread.conversationOpen,
        messageCount:        convThread.messageCount,
        userMessageCount:    convThread.userMessageCount,
        deepseekMessageCount: convThread.deepseekMessageCount,
        geminiMessageCount:  convThread.geminiMessageCount,
        awaitingUserReply:   convThread.awaitingUserReply,
        awaitingAgentReply:  convThread.awaitingAgentReply,
        lastSpeaker:         convThread.lastSpeaker,
        dominantAgent:       convThread.dominantAgent,
        conversationSummary: convThread.conversationSummary,
      };

      // ── Step 22: Attach cross-agent handoff context ──
      if (convThread.handoffCount > 0 || convThread.handoffStatus !== "handoff_not_needed") {
        pkg.crossAgentHandoffContext = {
          handoffStatus:    convThread.handoffStatus,
          crossAgentState:  convThread.crossAgentState,
          handoffFrom:      convThread.handoffFrom,
          handoffTo:        convThread.handoffTo,
          handoffReason:    convThread.handoffReason,
          dominantAgent:    convThread.dominantAgent,
          supportingAgent:  convThread.supportingAgent,
          handoffCount:     convThread.handoffCount,
          lastHandoffAt:    convThread.lastHandoffAt,
        };
      }

      // ── Step 23: Attach case memory context ──
      if (convThread.caseMemory && convThread.caseMemory.caseContinuityStatus !== "continuity_not_started") {
        pkg.caseMemoryContext = {
          caseContinuityStatus: convThread.caseMemory.caseContinuityStatus,
          memoryFreshness:      convThread.caseMemory.memoryFreshness,
          workingSummary:       convThread.caseMemory.workingSummary,
          agreedDirection:      convThread.caseMemory.agreedDirection,
          nextOpenStep:         convThread.caseMemory.nextOpenStep,
          caseScope:            convThread.caseMemory.caseScope,
          dominantMemoryOwner:  convThread.caseMemory.dominantMemoryOwner,
          memoryFocus:          convThread.caseMemory.memoryFocus,
          openQuestionCount:    (convThread.caseMemory.openQuestions || []).length,
          resolvedPointCount:   (convThread.caseMemory.resolvedPoints || []).length,
          anchorCount:          (convThread.caseMemory.memoryAnchors || []).length,
          memoryUpdateCount:    convThread.caseMemory.memoryUpdateCount,
        };
      }

      // ── Step 24: Attach decision frame context ──
      if (convThread.decisionFrame && convThread.decisionFrame.decisionFrameStatus !== "options_not_ready") {
        pkg.decisionFrameContext = {
          decisionFrameStatus:     convThread.decisionFrame.decisionFrameStatus,
          decisionMode:            convThread.decisionFrame.decisionMode,
          optionCount:             convThread.decisionFrame.optionCount,
          recommendedOptionId:     convThread.decisionFrame.recommendedOptionId,
          conservativeOptionId:    convThread.decisionFrame.conservativeOptionId,
          fastestOptionId:         convThread.decisionFrame.fastestOptionId,
          widestOptionId:          convThread.decisionFrame.widestOptionId,
          safestOptionId:          convThread.decisionFrame.safestOptionId,
          preferredStrategy:       convThread.decisionFrame.preferredStrategy,
          primaryDecisionAgent:    convThread.decisionFrame.primaryDecisionAgent,
          crossAgentDecisionNeeded: convThread.decisionFrame.crossAgentDecisionNeeded,
          userDecisionNeeded:      convThread.decisionFrame.userDecisionNeeded,
          decisionTradeoff:        convThread.decisionFrame.decisionTradeoff,
          nextDecisionQuestion:    convThread.decisionFrame.nextDecisionQuestion,
          optionSummary:           convThread.decisionFrame.optionSummary,
        };
      }
    }

    _currentBridgePackage = pkg;
  } else {
    pkg.agentCaseContext = null;
  }

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

  // Step 7: Improvement context log
  if (improvementContext.hasFeedback) {
    logger.info("[agentBridge] improvement context available (Step 7)", {
      patternKey:          bridgePatternKey,
      dominantFeedback:    improvementContext.dominantFeedback,
      dominantImprovement: improvementContext.dominantImprovement,
      feedbackCount:       improvementContext.feedbackCount,
      needsAdjustment:     improvementContext.needsAdjustment,
      readinessBand:       packageReadiness.band,
    });
  }

  // Step 8: Governance / Policy classification log
  logger.info("[agentBridge] governance policy classified (Step 8)", {
    policyClass:         governancePolicy.policyClass,
    guardianEligibility: governancePolicy.guardianEligibility,
    needsMoreEvidence:   governancePolicy.needsMoreEvidence,
    governanceReason:    governancePolicy.reason,
    // Separation transparency: readiness vs improvement vs governance
    readinessBand:       packageReadiness.band,
    improvementFeedback: improvementContext.dominantFeedback || "keine",
    patternKey:          bridgePatternKey,
    hintCount:           bridgeHints.length,
  });

  logger.info("[agentBridge] issue intelligence classified (Step 10)", {
    issueType:       issueContext.issueType,
    issueCategory:   issueContext.issueCategory,
    issueSeverity:   issueContext.issueSeverity,
    affectedLayer:   issueContext.affectedLayer,
    suspectedCause:  issueContext.suspectedCause,
    suggestedFix:    issueContext.suggestedFix,
    needsFollowup:   issueContext.needsFollowup,
    issueConfidence: issueContext.issueConfidence,
    patternKey:      bridgePatternKey,
  });

  // Step 11: Case / Resolution classification log
  logger.info("[agentBridge] case / resolution classified (Step 11)", {
    caseStatus:       caseClassification.caseStatus,
    caseOutcome:      caseClassification.caseOutcome,
    helpfulnessBand:  caseClassification.helpfulnessBand,
    caseReason:       caseClassification.caseReason,
    patternKey:       bridgePatternKey,
    // Separation transparency: case vs issue vs readiness vs governance
    issueSeverity:    issueContext.issueSeverity,
    readinessBand:    packageReadiness.band,
    policyClass:      governancePolicy.policyClass,
  });

  // Step 12: Attention / Priority classification log
  logger.info("[agentBridge] attention / priority classified (Step 12)", {
    attentionBand:   attentionClassification.attentionBand,
    attentionScore:  attentionClassification.attentionScore,
    attentionReason: attentionClassification.attentionReason,
    focusDrivers:    attentionClassification.focusDrivers,
    patternKey:      bridgePatternKey,
    // Separation transparency: attention vs issue vs case vs readiness vs governance
    issueSeverity:   issueContext.issueSeverity,
    caseStatus:      caseClassification.caseStatus,
    readinessBand:   packageReadiness.band,
    policyClass:     governancePolicy.policyClass,
  });

  // Step 13: Decision Maturity / Resolution Confidence log
  logger.info("[agentBridge] decision maturity classified (Step 13)", {
    decisionMaturityBand: maturityClassification.decisionMaturityBand,
    maturityScore:        maturityClassification.maturityScore,
    maturityReason:       maturityClassification.maturityReason,
    maturityDrivers:      maturityClassification.maturityDrivers,
    patternKey:           bridgePatternKey,
    // Separation transparency: maturity vs attention vs case vs readiness vs governance
    attentionBand:        attentionClassification.attentionBand,
    caseStatus:           caseClassification.caseStatus,
    readinessBand:        packageReadiness.band,
    policyClass:          governancePolicy.policyClass,
    issueSeverity:        issueContext.issueSeverity,
  });

  // Step 13: Log when attention is high but maturity is still early
  if (
    (attentionClassification.attentionBand === "focus_now" || attentionClassification.attentionBand === "review_today") &&
    maturityClassification.decisionMaturityBand === "early_signal"
  ) {
    logger.info("[agentBridge] attention ↔ maturity divergence (Step 13)", {
      attentionBand:        attentionClassification.attentionBand,
      decisionMaturityBand: maturityClassification.decisionMaturityBand,
      insight:              "Hohe Aufmerksamkeit empfohlen, aber Richtung noch nicht ausreichend verdichtet – frühes Signal.",
    });
  }

  // Step 12: Log when attention is high but case is still early
  if (
    attentionClassification.attentionBand === "focus_now" &&
    (caseClassification.caseStatus === "open" || caseClassification.caseStatus === "watching")
  ) {
    logger.info("[agentBridge] attention ↔ case divergence (Step 12)", {
      attentionBand: attentionClassification.attentionBand,
      caseStatus:    caseClassification.caseStatus,
      insight:       "Hohe Aufmerksamkeit empfohlen, aber Fall operativ noch früh – bewusste Beobachtung.",
    });
  }

  // Step 11: Log divergence between case status and issue severity
  if (
    caseClassification.caseStatus === "open" &&
    issueContext.issueSeverity === "high"
  ) {
    logger.info("[agentBridge] case ↔ issue divergence (Step 11)", {
      caseStatus:    caseClassification.caseStatus,
      issueSeverity: issueContext.issueSeverity,
      insight:       "Hohe technische Dringlichkeit, aber Fall operativ noch offen – weitere Beobachtung empfohlen.",
    });
  }

  // Step 8: Log divergence between readiness/improvement and governance
  if (
    GOV_READINESS_BANDS_FOR_GUARDIAN.includes(packageReadiness.band) &&
    (governancePolicy.policyClass === "needs_more_evidence" || governancePolicy.policyClass === "shadow_only")
  ) {
    logger.info("[agentBridge] readiness ↔ governance divergence (Step 8)", {
      readinessBand:  packageReadiness.band,
      policyClass:    governancePolicy.policyClass,
      insight:        "Handlungsreife vorhanden, aber Governance-Klasse noch zurückhaltend – bewusste Trennung.",
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
    // Step 7: empty improvement context (no retrospective feedback yet)
    improvementContext: {
      hasFeedback:          false,
      dominantFeedback:     null,
      dominantImprovement:  null,
      feedbackCount:        0,
      needsAdjustment:      false,
    },
    // Step 8: empty governance context (no policy classification yet)
    governanceContext: {
      policyClass:         "shadow_only",
      guardianEligibility: false,
      needsMoreEvidence:   true,
      governanceReason:    "Keine Hinweise vorhanden – nur Shadow-Beobachtung.",
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
    // Step 10: issue intelligence
    issueCategory:      learningSignal.issueCategory,
    issueSeverity:      learningSignal.issueSeverity,
    affectedLayer:      learningSignal.affectedLayer,
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
      // Step 10: issue intelligence
      issueCategory:         learningSignal.issueCategory,
      affectedLayer:         learningSignal.affectedLayer,
      suggestedFix:          learningSignal.suggestedFix,
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
      issueCategory: learningSignal.issueCategory,
      issueSeverity: learningSignal.issueSeverity,
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

    // ── Step 8 fields (governance / policy classification) ──
    governancePolicyClass:  null, // set below after governance classification
    guardianEligibility:    false,
    needsMoreEvidence:      true,

    // ── Step 10 fields (issue intelligence / error detection) ──
    issueType:              null,
    issueCategory:          null,
    issueSeverity:          null,
    affectedLayer:          null,
    suspectedIssueCause:    null,
    suggestedFix:           null,
    issueNeedsFollowup:     false,
    issueConfidence:        null,

    // ── Step 12 fields (attention / priority / operator focus) ──
    attentionBand:          null, // set below after attention classification
    attentionScore:         null,

    // ── Step 13 fields (decision maturity / resolution confidence) ──
    decisionMaturityBand:   null, // set below after maturity classification
    maturityScore:          null,
  };

  // Assess signal quality (must happen after signal is built)
  signal.confidenceBand = assessSignalQuality(signal, hints);

  // ── Step 6: Assess action readiness (deliberately AFTER confidence) ──
  signal.actionReadinessBand = assessActionReadiness(signal, hints, signal.confidenceBand);
  signal.recommendedActionType = deriveRecommendedActionType(signal, hints);

  // ── Step 8: Governance / Policy classification (deliberately AFTER readiness + confidence) ──
  const sigImprovementCtx = _deriveImprovementContext(patternKey);
  const sigGovernance = classifyGovernancePolicy({
    readinessBand:     signal.actionReadinessBand,
    confidenceBand:    signal.confidenceBand,
    patternKey,
    improvementContext: sigImprovementCtx,
    hintCount:         hints.length,
    highSeverityCount: hints.filter((h) => h.severity === "high").length,
  });
  signal.governancePolicyClass = sigGovernance.policyClass;
  signal.guardianEligibility   = sigGovernance.guardianEligibility;
  signal.needsMoreEvidence     = sigGovernance.needsMoreEvidence;

  // ── Step 10: Issue intelligence (separate from governance + routing) ──
  const issueContext = classifyIssueIntelligence({
    hints,
    readinessBand: signal.actionReadinessBand,
    confidenceBand: signal.confidenceBand,
    patternKey,
    fallbackText: [
      signal.observedEffect,
      signal.suspectedCause,
      signal.suggestedFollowup,
      signal.layerReference,
    ].filter(Boolean).join(" "),
  });
  signal.issueType           = issueContext.issueType;
  signal.issueCategory       = issueContext.issueCategory;
  signal.issueSeverity       = issueContext.issueSeverity;
  signal.affectedLayer       = issueContext.affectedLayer;
  signal.suspectedIssueCause = issueContext.suspectedCause;
  signal.suggestedFix        = issueContext.suggestedFix;
  signal.issueNeedsFollowup  = issueContext.needsFollowup;
  signal.issueConfidence     = issueContext.issueConfidence;
  signal.issueReason         = issueContext.issueReason;

  // ── Step 11: Case / Resolution classification for learning signal ──
  const sigCase = classifyCaseStatus({
    patternKey,
    readinessBand:  signal.actionReadinessBand,
    confidenceBand: signal.confidenceBand,
    issueSeverity:  signal.issueSeverity,
    needsFollowup:  signal.issueNeedsFollowup,
    hintCount:      hints.length,
  });
  signal.caseStatus       = sigCase.caseStatus;
  signal.caseOutcome      = sigCase.caseOutcome;
  signal.helpfulnessBand  = sigCase.helpfulnessBand;

  // ── Step 12: Attention / Priority classification for learning signal ──
  const sigPatternEntry = patternKey ? _patternMemory.get(patternKey) : null;
  const sigAttention = classifyAttentionPriority({
    issueSeverity:         signal.issueSeverity,
    caseStatus:            signal.caseStatus,
    readinessBand:         signal.actionReadinessBand,
    confidenceBand:        signal.confidenceBand,
    governancePolicyClass: signal.governancePolicyClass,
    helpfulnessBand:       signal.helpfulnessBand,
    needsFollowup:         signal.issueNeedsFollowup,
    patternCount:          sigPatternEntry ? sigPatternEntry.count : 0,
    hintCount:             hints.length,
  });
  signal.attentionBand   = sigAttention.attentionBand;
  signal.attentionScore  = sigAttention.attentionScore;

  // ── Step 13: Decision Maturity / Resolution Confidence for learning signal ──
  const sigMaturity = classifyDecisionMaturity({
    observationCount:     sigPatternEntry ? sigPatternEntry.count : 0,
    confidenceBand:       signal.confidenceBand,
    readinessBand:        signal.actionReadinessBand,
    caseStatus:           signal.caseStatus,
    helpfulnessBand:      signal.helpfulnessBand,
    governancePolicyClass: signal.governancePolicyClass,
    issueSeverity:        signal.issueSeverity,
    attentionBand:        signal.attentionBand,
    needsFollowup:        signal.issueNeedsFollowup,
    hintCount:            hints.length,
  });
  signal.decisionMaturityBand = sigMaturity.decisionMaturityBand;
  signal.maturityScore        = sigMaturity.maturityScore;

  // ── Step 14: Agent case context for learning signal ──
  const sigAgentRole = _resolveAgentRole(signal.affectedLayer || "cross_layer");
  const sigProblemType = _deriveAgentProblemType({
    issueCategory: signal.issueCategory,
    affectedLayer: signal.affectedLayer,
    dominantHintType: signal.dominantHintType,
  });
  signal.agentRole      = sigAgentRole;
  signal.agentProblemType = sigProblemType;

  // ── Step 4: Record pattern in lightweight in-memory store ──
  recordPatternObservation(patternKey, signal);

  // ── Step 4 + 6 + 8: Pattern / learning / readiness / governance logging ──
  logger.info("[agentBridge] learning signal built (Step 8 – governance)", {
    patternKey,
    signalType,
    confidenceBand:         signal.confidenceBand,
    actionReadinessBand:    signal.actionReadinessBand,
    recommendedActionType:  signal.recommendedActionType,
    governancePolicyClass:  signal.governancePolicyClass,
    guardianEligibility:    signal.guardianEligibility,
    needsMoreEvidence:      signal.needsMoreEvidence,
    issueCategory:          signal.issueCategory,
    issueSeverity:          signal.issueSeverity,
    affectedLayer:          signal.affectedLayer,
    suspectedIssueCause:    signal.suspectedIssueCause,
    suggestedFix:           signal.suggestedFix,
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
    // Step 14: agent case context
    agentRole:              signal.agentRole,
    agentProblemType:       signal.agentProblemType,
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

  logger.info("[agentBridge] issue intelligence classified (Step 10)", {
    patternKey,
    issueType:       signal.issueType,
    issueCategory:   signal.issueCategory,
    issueSeverity:   signal.issueSeverity,
    affectedLayer:   signal.affectedLayer,
    suspectedCause:  signal.suspectedIssueCause,
    suggestedFix:    signal.suggestedFix,
    needsFollowup:   signal.issueNeedsFollowup,
    issueConfidence: signal.issueConfidence,
  });

  // Step 11: Case / resolution classification logging
  logger.info("[agentBridge] case / resolution classified (Step 11 – learning signal)", {
    patternKey,
    caseStatus:       signal.caseStatus,
    caseOutcome:      signal.caseOutcome,
    helpfulnessBand:  signal.helpfulnessBand,
    // Separation: case vs issue vs readiness
    issueSeverity:    signal.issueSeverity,
    readinessBand:    signal.actionReadinessBand,
  });

  // Step 12: Attention / priority classification logging
  logger.info("[agentBridge] attention / priority classified (Step 12 – learning signal)", {
    patternKey,
    attentionBand:   signal.attentionBand,
    attentionScore:  signal.attentionScore,
    // Separation: attention vs case vs issue vs readiness
    caseStatus:      signal.caseStatus,
    issueSeverity:   signal.issueSeverity,
    readinessBand:   signal.actionReadinessBand,
    policyClass:     signal.governancePolicyClass,
  });

  // Step 13: Decision maturity / resolution confidence logging
  logger.info("[agentBridge] decision maturity classified (Step 13 – learning signal)", {
    patternKey,
    decisionMaturityBand: signal.decisionMaturityBand,
    maturityScore:        signal.maturityScore,
    // Separation: maturity vs attention vs case vs readiness
    attentionBand:        signal.attentionBand,
    caseStatus:           signal.caseStatus,
    readinessBand:        signal.actionReadinessBand,
    policyClass:          signal.governancePolicyClass,
    issueSeverity:        signal.issueSeverity,
  });

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
       // Step 8: governance policy tallies
       governanceTally:    {},
       // Step 10: issue intelligence tallies
       issueCategoryTally: {},
       issueLayerTally:    {},
       issueSeverityTally: {},
       issueCauseTally:    {},
       issueFixTally:      {},
       // Step 11: case / resolution tallies
       caseStatusTally:    {},
       caseOutcomeTally:   {},
       helpfulnessTally:   {},
       // Step 12: attention / priority tallies
       attentionBandTally: {},
       // Step 13: decision maturity tallies
       maturityBandTally:  {},
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
  // Step 8: Tally governance policy class
  if (signal.governancePolicyClass) {
    entry.governanceTally = entry.governanceTally || {};
    entry.governanceTally[signal.governancePolicyClass] =
      (entry.governanceTally[signal.governancePolicyClass] || 0) + 1;
  }
  // Step 10: issue category / layer / severity / cause / fix tallies
  if (signal.issueCategory) {
    entry.issueCategoryTally = entry.issueCategoryTally || {};
    entry.issueCategoryTally[signal.issueCategory] =
      (entry.issueCategoryTally[signal.issueCategory] || 0) + 1;
  }
  if (signal.affectedLayer) {
    entry.issueLayerTally = entry.issueLayerTally || {};
    entry.issueLayerTally[signal.affectedLayer] =
      (entry.issueLayerTally[signal.affectedLayer] || 0) + 1;
  }
  if (signal.issueSeverity) {
    entry.issueSeverityTally = entry.issueSeverityTally || {};
    entry.issueSeverityTally[signal.issueSeverity] =
      (entry.issueSeverityTally[signal.issueSeverity] || 0) + 1;
  }
  if (signal.suspectedIssueCause) {
    entry.issueCauseTally = entry.issueCauseTally || {};
    entry.issueCauseTally[signal.suspectedIssueCause] =
      (entry.issueCauseTally[signal.suspectedIssueCause] || 0) + 1;
  }
  if (signal.suggestedFix) {
    entry.issueFixTally = entry.issueFixTally || {};
    entry.issueFixTally[signal.suggestedFix] =
      (entry.issueFixTally[signal.suggestedFix] || 0) + 1;
  }
  // Step 11: case status / outcome / helpfulness tallies
  if (signal.caseStatus) {
    entry.caseStatusTally = entry.caseStatusTally || {};
    entry.caseStatusTally[signal.caseStatus] =
      (entry.caseStatusTally[signal.caseStatus] || 0) + 1;
  }
  if (signal.caseOutcome) {
    entry.caseOutcomeTally = entry.caseOutcomeTally || {};
    entry.caseOutcomeTally[signal.caseOutcome] =
      (entry.caseOutcomeTally[signal.caseOutcome] || 0) + 1;
  }
  if (signal.helpfulnessBand) {
    entry.helpfulnessTally = entry.helpfulnessTally || {};
    entry.helpfulnessTally[signal.helpfulnessBand] =
      (entry.helpfulnessTally[signal.helpfulnessBand] || 0) + 1;
  }
  // Step 12: attention band tally
  if (signal.attentionBand) {
    entry.attentionBandTally = entry.attentionBandTally || {};
    entry.attentionBandTally[signal.attentionBand] =
      (entry.attentionBandTally[signal.attentionBand] || 0) + 1;
  }
  // Step 13: decision maturity band tally
  if (signal.decisionMaturityBand) {
    entry.maturityBandTally = entry.maturityBandTally || {};
    entry.maturityBandTally[signal.decisionMaturityBand] =
      (entry.maturityBandTally[signal.decisionMaturityBand] || 0) + 1;
  }
  // Step 14: agent role and problem type tallies
  if (signal.agentRole) {
    entry.agentRoleTally = entry.agentRoleTally || {};
    entry.agentRoleTally[signal.agentRole] =
      (entry.agentRoleTally[signal.agentRole] || 0) + 1;
  }
  if (signal.agentProblemType) {
    entry.agentProblemTypeTally = entry.agentProblemTypeTally || {};
    entry.agentProblemTypeTally[signal.agentProblemType] =
      (entry.agentProblemTypeTally[signal.agentProblemType] || 0) + 1;
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
      // Step 7: recommendation feedback / improvement per pattern
      dominantFeedback:      _topKey(e.feedbackTally),
      dominantImprovement:   _topKey(e.improvementTally),
      hasFeedback:           !!(e.feedbackTally && Object.keys(e.feedbackTally).length > 0),
      // Step 8: governance policy per pattern
      dominantGovernance:    _topKey(e.governanceTally),
      // Step 10: issue intelligence per pattern
      dominantIssueCategory: _topKey(e.issueCategoryTally),
      dominantIssueLayer:    _topKey(e.issueLayerTally),
      dominantIssueSeverity: _topKey(e.issueSeverityTally),
      dominantIssueCause:    _topKey(e.issueCauseTally),
      dominantSuggestedFix:  _topKey(e.issueFixTally),
      // Step 11: case / resolution per pattern
      dominantCaseStatus:    _topKey(e.caseStatusTally),
      dominantCaseOutcome:   _topKey(e.caseOutcomeTally),
      dominantHelpfulness:   _topKey(e.helpfulnessTally),
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

/* ─────────────────────────────────────────────
   Step 8: Governance Policy Summary
   ─────────────────────────────────────────────
   Returns a lightweight overview of how
   recommendations are distributed across
   governance / policy classes.

   Helps the HQS system understand:
   - how many signals are shadow-only
   - how many are internal-only
   - how many need more evidence
   - how many are admin-visible
   - how many are guardian candidates
   - how governance relates to readiness

   Purely observational – no auto-promotion.
   ───────────────────────────────────────────── */

/**
 * Build an aggregated governance policy overview
 * from all pattern memory entries.
 *
 * @returns {Object} governance policy summary
 */
function getGovernancePolicySummary() {
  const governanceCounts = {};
  const patternsPerGovernance = {};
  const readinessVsGovernance = {};
  const confidenceVsGovernance = {};
  const guardianCandidates = [];

  for (const entry of _patternMemory.values()) {
    // Aggregate governance tallies
    for (const [cls, count] of Object.entries(entry.governanceTally || {})) {
      governanceCounts[cls] = (governanceCounts[cls] || 0) + count;
    }

    // Count patterns per dominant governance class
    const domGov = _topKey(entry.governanceTally);
    if (domGov) {
      patternsPerGovernance[domGov] = (patternsPerGovernance[domGov] || 0) + 1;
    }

    // Cross-reference: readiness vs governance
    const domRead = _topKey(entry.readinessTally);
    if (domRead && domGov) {
      const crossKey = `${domRead}→${domGov}`;
      readinessVsGovernance[crossKey] =
        (readinessVsGovernance[crossKey] || 0) + entry.count;
    }

    // Cross-reference: confidence vs governance
    const domConf = _topKey(entry.confidenceTally);
    if (domConf && domGov) {
      const crossKey = `${domConf}→${domGov}`;
      confidenceVsGovernance[crossKey] =
        (confidenceVsGovernance[crossKey] || 0) + entry.count;
    }

    // Collect guardian candidates
    if (domGov === "guardian_candidate") {
      guardianCandidates.push({
        patternKey:         entry.patternKey,
        count:              entry.count,
        dominantReadiness:  _topKey(entry.readinessTally),
        dominantConfidence: _topKey(entry.confidenceTally),
        dominantFeedback:   _topKey(entry.feedbackTally),
        lastSeen:           entry.lastSeen,
      });
    }
  }

  // Sort guardian candidates by observation count (most observed first)
  guardianCandidates.sort((a, b) => b.count - a.count);

  return {
    totalPatterns:           _patternMemory.size,
    governanceDistribution:  governanceCounts,
    patternsPerGovernance,
    readinessVsGovernance,
    confidenceVsGovernance,
    guardianCandidates:      guardianCandidates.slice(0, GOV_MAX_GUARDIAN_CANDIDATES_IN_SUMMARY),
    generatedAt:             new Date().toISOString(),
  };
}

/* ─────────────────────────────────────────────
   Step 10: Issue Intelligence Summary
   ───────────────────────────────────────────── */

function getIssueIntelligenceSummary() {
  const issueCategoryDistribution = {};
  const affectedLayerDistribution = {};
  const issueSeverityDistribution = {};
  const suspectedCauseDistribution = {};
  const suggestedFixDistribution = {};
  const patternsPerIssueCategory = {};
  const patternsPerAffectedLayer = {};
  let patternsNeedingFollowup = 0;

  for (const entry of _patternMemory.values()) {
    for (const [category, count] of Object.entries(entry.issueCategoryTally || {})) {
      issueCategoryDistribution[category] = (issueCategoryDistribution[category] || 0) + count;
    }
    for (const [layer, count] of Object.entries(entry.issueLayerTally || {})) {
      affectedLayerDistribution[layer] = (affectedLayerDistribution[layer] || 0) + count;
    }
    for (const [severity, count] of Object.entries(entry.issueSeverityTally || {})) {
      issueSeverityDistribution[severity] = (issueSeverityDistribution[severity] || 0) + count;
    }
    for (const [cause, count] of Object.entries(entry.issueCauseTally || {})) {
      suspectedCauseDistribution[cause] = (suspectedCauseDistribution[cause] || 0) + count;
    }
    for (const [fix, count] of Object.entries(entry.issueFixTally || {})) {
      suggestedFixDistribution[fix] = (suggestedFixDistribution[fix] || 0) + count;
    }

    const dominantIssueCategory = _topKey(entry.issueCategoryTally);
    if (dominantIssueCategory) {
      patternsPerIssueCategory[dominantIssueCategory] =
        (patternsPerIssueCategory[dominantIssueCategory] || 0) + 1;
    }

    const dominantIssueLayer = _topKey(entry.issueLayerTally);
    if (dominantIssueLayer) {
      patternsPerAffectedLayer[dominantIssueLayer] =
        (patternsPerAffectedLayer[dominantIssueLayer] || 0) + 1;
    }

    const dominantSeverity = _topKey(entry.issueSeverityTally);
    if (dominantSeverity && dominantSeverity !== "low") {
      patternsNeedingFollowup += 1;
    }
  }

  return {
    totalPatterns: _patternMemory.size,
    currentBridgeIssue: _currentBridgePackage?.issueContext || null,
    issueCategoryDistribution,
    affectedLayerDistribution,
    issueSeverityDistribution,
    suspectedCauseDistribution,
    suggestedFixDistribution,
    patternsPerIssueCategory,
    patternsPerAffectedLayer,
    patternsNeedingFollowup,
    generatedAt: new Date().toISOString(),
  };
}

/* ─────────────────────────────────────────────
   Step 11: Case / Resolution / Operator Loop Light
   ─────────────────────────────────────────────
   Derives a lightweight operative case status for
   a bridge package based on existing signals.
   Does NOT auto-execute or auto-resolve.

   Separation principle:
   - caseStatus  = operative Bearbeitungszustand
   - issueType   = what is technically wrong
   - readiness   = how actionable it is
   - improvement = how well it worked historically
   - governance  = visibility classification
   ───────────────────────────────────────────── */

/**
 * Derive the initial case status for a bridge package
 * based on existing pattern observations and signal quality.
 *
 * Conservative rule-based derivation – no model involvement.
 *
 * @param {Object} params
 * @param {string}  params.patternKey
 * @param {string}  params.readinessBand
 * @param {string}  params.confidenceBand
 * @param {string}  params.issueSeverity
 * @param {boolean} params.needsFollowup
 * @param {number}  params.hintCount
 * @returns {Object} { caseStatus, caseOutcome, helpfulnessBand, caseReason }
 */
function classifyCaseStatus({
  patternKey,
  readinessBand,
  confidenceBand,
  issueSeverity,
  needsFollowup,
  hintCount,
} = {}) {
  const patternEntry = patternKey ? _patternMemory.get(patternKey) : null;
  const observationCount = patternEntry ? patternEntry.count : 0;

  // Check existing case registry for manual overrides
  const existingCase = patternKey ? _caseRegistry.get(patternKey) : null;
  if (existingCase && existingCase.manualOverride) {
    return {
      caseStatus:       existingCase.caseStatus,
      caseOutcome:      existingCase.caseOutcome,
      helpfulnessBand:  existingCase.helpfulnessBand,
      caseReason:       "Manuell gesetzter Bearbeitungszustand – keine automatische Änderung.",
    };
  }

  // ── Conservative status derivation ──
  let caseStatus = "open";
  let caseReason = "Neuer Fall – noch keine ausreichende Beobachtungshistorie.";

  // Needs followup → explicit needs_followup
  if (needsFollowup) {
    caseStatus = "needs_followup";
    caseReason = "Folgeprüfung wird empfohlen – Fall bleibt offen zur weiteren Beobachtung.";
  }
  // Enough observations → watching
  else if (observationCount >= CASE_MIN_OBSERVATIONS_FOR_WATCHING) {
    caseStatus = "watching";
    caseReason = `Muster wurde ${observationCount}× beobachtet – wird aktiv beobachtet.`;
  }
  // Enough observations + decent confidence → confirmed
  if (
    observationCount >= CASE_MIN_OBSERVATIONS_FOR_CONFIRMED &&
    (confidenceBand === "medium" || confidenceBand === "high")
  ) {
    caseStatus = "confirmed";
    caseReason = `Muster wurde ${observationCount}× beobachtet mit ${confidenceBand} Konfidenz – Fall bestätigt.`;
  }
  // High severity issue with good confidence → confirmed immediately
  if (issueSeverity === "high" && confidenceBand === "high" && hintCount >= 2) {
    caseStatus = "confirmed";
    caseReason = "Hohe Dringlichkeit mit hoher Konfidenz – sofortige Bestätigung.";
  }

  // ── Derive outcome and helpfulness ──
  const caseOutcome = _deriveCaseOutcome(patternEntry, caseStatus);
  const helpfulnessBand = _deriveHelpfulnessBand(patternEntry);

  return { caseStatus, caseOutcome, helpfulnessBand, caseReason };
}

/**
 * Derive a case outcome from pattern memory and current status.
 * Conservative – defaults to "pending" when insufficient data.
 */
function _deriveCaseOutcome(patternEntry, caseStatus) {
  if (!patternEntry) return "pending";
  if (caseStatus === "dismissed") return "dismissed_noise";
  if (caseStatus === "resolved") return "resolved_fixed";

  const feedbackTally = patternEntry.feedbackTally || {};
  const totalFeedback = Object.values(feedbackTally).reduce((a, b) => a + b, 0);
  if (totalFeedback === 0) return "pending";

  const positiveFeedback = (feedbackTally.helpful || 0) + (feedbackTally.usable || 0);
  const negativeFeedback = (feedbackTally.not_needed || 0) + (feedbackTally.unclear || 0);

  if (totalFeedback >= 2 && positiveFeedback / totalFeedback >= CASE_MIN_POSITIVE_RATIO_FOR_HELPFUL) {
    return "confirmed_helpful";
  }
  if (totalFeedback >= 2 && negativeFeedback / totalFeedback >= CASE_MIN_POSITIVE_RATIO_FOR_HELPFUL) {
    return "confirmed_not_helpful";
  }
  return "needs_further_review";
}

/**
 * Derive a helpfulness band from pattern memory feedback.
 * Conservative – defaults to "too_early_to_tell".
 */
function _deriveHelpfulnessBand(patternEntry) {
  if (!patternEntry) return "too_early_to_tell";

  const feedbackTally = patternEntry.feedbackTally || {};
  const totalFeedback = Object.values(feedbackTally).reduce((a, b) => a + b, 0);
  if (totalFeedback === 0) return "too_early_to_tell";

  const helpful = feedbackTally.helpful || 0;
  const usable  = feedbackTally.usable || 0;
  const notNeeded = feedbackTally.not_needed || 0;
  const unclear = feedbackTally.unclear || 0;
  const positiveRatio = (helpful + usable) / totalFeedback;
  const negativeRatio = (notNeeded + unclear) / totalFeedback;

  if (totalFeedback < 2) return "too_early_to_tell";
  if (positiveRatio >= 0.7) return "clearly_helpful";
  if (positiveRatio >= 0.4) return "somewhat_helpful";
  if (negativeRatio >= 0.6) return "not_helpful";
  return "unclear";
}

/**
 * Update the operative case status for a given pattern key.
 * This is the operator/admin action endpoint – allows manual
 * status changes, outcome marking, and note-taking.
 *
 * The system does NOT auto-resolve or auto-dismiss.
 * All status transitions are operator-driven.
 *
 * @param {Object} payload
 * @param {string}  payload.patternKey     – the case's pattern key
 * @param {string}  [payload.caseStatus]   – new case status
 * @param {string}  [payload.caseOutcome]  – new case outcome
 * @param {string}  [payload.caseNote]     – operator note
 * @param {boolean} [payload.wasHelpful]   – operator helpfulness verdict
 * @param {boolean} [payload.followupNeeded] – whether follow-up is needed
 * @returns {Object} acknowledgement with updated case state
 */
function updateCaseStatus(payload = {}) {
  const patternKey = toStr(payload.patternKey);
  if (!patternKey) {
    return { success: false, error: "patternKey is required" };
  }

  // Normalise inputs
  const newStatus = VALID_CASE_STATUSES.includes(toStr(payload.caseStatus))
    ? toStr(payload.caseStatus)
    : null;
  const newOutcome = VALID_CASE_OUTCOMES.includes(toStr(payload.caseOutcome))
    ? toStr(payload.caseOutcome)
    : null;
  const caseNote = capText(payload.caseNote, 500) || null;
  const wasHelpful = typeof payload.wasHelpful === "boolean" ? payload.wasHelpful : null;
  const followupNeeded = typeof payload.followupNeeded === "boolean" ? payload.followupNeeded : null;

  // Get or create registry entry
  const existing = _caseRegistry.get(patternKey) || {
    patternKey,
    caseStatus:      "open",
    caseOutcome:     "pending",
    helpfulnessBand: "too_early_to_tell",
    caseNote:        null,
    wasHelpful:      null,
    followupNeeded:  null,
    manualOverride:  false,
    createdAt:       new Date().toISOString(),
    updatedAt:       new Date().toISOString(),
    statusHistory:   [],
  };

  // Track status transitions
  if (newStatus && newStatus !== existing.caseStatus) {
    existing.statusHistory.push({
      from: existing.caseStatus,
      to:   newStatus,
      at:   new Date().toISOString(),
    });
    // Cap history at 20 entries
    if (existing.statusHistory.length > 20) {
      existing.statusHistory = existing.statusHistory.slice(-20);
    }
    existing.caseStatus = newStatus;
    existing.manualOverride = true;
  }

  if (newOutcome) existing.caseOutcome = newOutcome;
  if (caseNote)   existing.caseNote = caseNote;
  if (wasHelpful !== null) {
    existing.wasHelpful = wasHelpful;
    existing.helpfulnessBand = wasHelpful ? "clearly_helpful" : "not_helpful";
  }
  if (followupNeeded !== null) existing.followupNeeded = followupNeeded;

  existing.updatedAt = new Date().toISOString();
  _caseRegistry.set(patternKey, existing);

  // Evict oldest entries if over limit
  if (_caseRegistry.size > CASE_MAX_ENTRIES) {
    let oldestKey = null;
    let oldestTime = null;
    for (const [key, val] of _caseRegistry) {
      if (!oldestTime || val.updatedAt < oldestTime) {
        oldestTime = val.updatedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) _caseRegistry.delete(oldestKey);
  }

  logger.info("[agentBridge] case status updated (Step 11)", {
    patternKey,
    caseStatus:     existing.caseStatus,
    caseOutcome:    existing.caseOutcome,
    helpfulnessBand: existing.helpfulnessBand,
    wasHelpful:     existing.wasHelpful,
    followupNeeded: existing.followupNeeded,
    manualOverride: existing.manualOverride,
    statusTransitions: existing.statusHistory.length,
  });

  return {
    success:     true,
    patternKey,
    caseStatus:     existing.caseStatus,
    caseOutcome:    existing.caseOutcome,
    helpfulnessBand: existing.helpfulnessBand,
    wasHelpful:     existing.wasHelpful,
    followupNeeded: existing.followupNeeded,
    manualOverride: existing.manualOverride,
    updatedAt:      existing.updatedAt,
    statusHistory:  existing.statusHistory,
  };
}

/**
 * Returns a lightweight summary of the case registry:
 * - status distribution (open/watching/confirmed/resolved/dismissed/needs_followup)
 * - outcome distribution
 * - helpfulness distribution
 * - cases needing follow-up
 * - recently updated cases
 *
 * Purely observational – the admin can use this to understand
 * the operative Verlauf of recognised patterns.
 */
function getCaseResolutionSummary() {
  const statusDistribution = {};
  const outcomeDistribution = {};
  const helpfulnessDistribution = {};
  let casesNeedingFollowup = 0;
  let casesWithManualOverride = 0;
  let casesHelpful = 0;
  let casesNotHelpful = 0;

  const caseList = [];

  for (const entry of _caseRegistry.values()) {
    // Status distribution
    statusDistribution[entry.caseStatus] =
      (statusDistribution[entry.caseStatus] || 0) + 1;

    // Outcome distribution
    outcomeDistribution[entry.caseOutcome] =
      (outcomeDistribution[entry.caseOutcome] || 0) + 1;

    // Helpfulness distribution
    helpfulnessDistribution[entry.helpfulnessBand] =
      (helpfulnessDistribution[entry.helpfulnessBand] || 0) + 1;

    if (entry.followupNeeded === true || entry.caseStatus === "needs_followup") {
      casesNeedingFollowup += 1;
    }
    if (entry.manualOverride) casesWithManualOverride += 1;
    if (entry.wasHelpful === true) casesHelpful += 1;
    if (entry.wasHelpful === false) casesNotHelpful += 1;

    caseList.push({
      patternKey:      entry.patternKey,
      caseStatus:      entry.caseStatus,
      caseOutcome:     entry.caseOutcome,
      helpfulnessBand: entry.helpfulnessBand,
      wasHelpful:      entry.wasHelpful,
      followupNeeded:  entry.followupNeeded,
      manualOverride:  entry.manualOverride,
      updatedAt:       entry.updatedAt,
      statusTransitions: entry.statusHistory.length,
    });
  }

  // Sort by updatedAt descending (most recently updated first)
  caseList.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));

  // Also derive case view from pattern memory for patterns
  // that have observations but no explicit case yet
  const patternCaseOverview = {};
  for (const entry of _patternMemory.values()) {
    const existingCase = _caseRegistry.get(entry.patternKey);
    const derivedStatus = existingCase
      ? existingCase.caseStatus
      : _deriveFallbackCaseStatus(entry);
    patternCaseOverview[derivedStatus] =
      (patternCaseOverview[derivedStatus] || 0) + 1;
  }

  return {
    totalCases:            _caseRegistry.size,
    totalPatternsTracked:  _patternMemory.size,
    statusDistribution,
    outcomeDistribution,
    helpfulnessDistribution,
    casesNeedingFollowup,
    casesWithManualOverride,
    casesHelpful,
    casesNotHelpful,
    patternCaseOverview,
    recentCases:           caseList.slice(0, CASE_MAX_SUMMARY_ENTRIES),
    generatedAt:           new Date().toISOString(),
  };
}

/**
 * Derive a fallback case status for a pattern that has observations
 * but no explicit case registry entry.  Used only for summary views.
 */
function _deriveFallbackCaseStatus(patternEntry) {
  if (!patternEntry) return "open";
  if (patternEntry.count >= CASE_MIN_OBSERVATIONS_FOR_CONFIRMED) return "confirmed";
  if (patternEntry.count >= CASE_MIN_OBSERVATIONS_FOR_WATCHING)  return "watching";
  return "open";
}

/**
 * Ensure a case registry entry exists for a given pattern key,
 * initialised with the derived case classification.
 * Called during bridge package building to keep registry in sync.
 */
function _ensureCaseRegistryEntry(patternKey, caseClassification) {
  if (!patternKey) return;

  const existing = _caseRegistry.get(patternKey);
  if (existing && existing.manualOverride) {
    // Do not overwrite manual operator decisions
    return;
  }

  const entry = existing || {
    patternKey,
    caseStatus:      "open",
    caseOutcome:     "pending",
    helpfulnessBand: "too_early_to_tell",
    caseNote:        null,
    wasHelpful:      null,
    followupNeeded:  null,
    manualOverride:  false,
    createdAt:       new Date().toISOString(),
    updatedAt:       new Date().toISOString(),
    statusHistory:   [],
  };

  // Update with derived classification (only if not manually overridden)
  entry.caseStatus      = caseClassification.caseStatus;
  entry.caseOutcome     = caseClassification.caseOutcome;
  entry.helpfulnessBand = caseClassification.helpfulnessBand;
  entry.updatedAt       = new Date().toISOString();

  _caseRegistry.set(patternKey, entry);

  // Evict oldest entries if over limit
  if (_caseRegistry.size > CASE_MAX_ENTRIES) {
    let oldestKey = null;
    let oldestTime = null;
    for (const [key, val] of _caseRegistry) {
      if (!oldestTime || val.updatedAt < oldestTime) {
        oldestTime = val.updatedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) _caseRegistry.delete(oldestKey);
  }
}

/* ─────────────────────────────────────────────
   Step 12: Attention / Priority Classification
   ─────────────────────────────────────────────
   Derives a lightweight attention / priority
   band from existing dimensions.  This is a
   quiet distillation of what the system already
   knows – not a new parallel scoring world.

   Inputs (all optional – missing values
   contribute 0):
   - issueSeverity           (high=3, medium=1)
   - caseStatus              (needs_followup=2, confirmed=2, watching=1)
   - readinessBand           (mature_recommendation=2, useful_next_step=1)
   - confidenceBand          (high=1)
   - governancePolicyClass   (guardian_candidate=1, admin_visible=1)
   - patternCount            (>=5 → 1)
   - helpfulnessBand         (clearly_helpful=1)
   - needsFollowup           (true=1)
   - hintCount               (not scored directly, reserved for future use)

   Output:
   {
     attentionBand,   // focus_now | review_today | watch_next | background
     attentionScore,  // numeric (transparent, for logging only)
     attentionReason, // short human-readable explanation
     focusDrivers,    // array of dimension names that contributed
   }
   ───────────────────────────────────────────── */

/**
 * Classify the attention / priority band for a given
 * combination of existing dimensions.
 *
 * Conservative, rule-based, no model involvement.
 *
 * @param {Object} params
 * @param {string}  [params.issueSeverity]
 * @param {string}  [params.caseStatus]
 * @param {string}  [params.readinessBand]
 * @param {string}  [params.confidenceBand]
 * @param {string}  [params.governancePolicyClass]
 * @param {string}  [params.helpfulnessBand]
 * @param {boolean} [params.needsFollowup]
 * @param {number}  [params.patternCount]
 * @param {number}  [params.hintCount]
 * @returns {Object} { attentionBand, attentionScore, attentionReason, focusDrivers }
 */
function classifyAttentionPriority({
  issueSeverity,
  caseStatus,
  readinessBand,
  confidenceBand,
  governancePolicyClass,
  helpfulnessBand,
  needsFollowup,
  patternCount,
  hintCount,
} = {}) {
  let score = 0;
  const drivers = [];

  // ── Issue severity ──
  if (issueSeverity === "high") {
    score += 3;
    drivers.push("issue_severity_high");
  } else if (issueSeverity === "medium") {
    score += 1;
    drivers.push("issue_severity_medium");
  }

  // ── Case status ──
  if (caseStatus === "needs_followup") {
    score += 2;
    drivers.push("case_needs_followup");
  } else if (caseStatus === "confirmed") {
    score += 2;
    drivers.push("case_confirmed");
  } else if (caseStatus === "watching") {
    score += 1;
    drivers.push("case_watching");
  }

  // ── Action readiness ──
  if (readinessBand === "mature_recommendation") {
    score += 2;
    drivers.push("readiness_mature");
  } else if (readinessBand === "useful_next_step") {
    score += 1;
    drivers.push("readiness_useful");
  }

  // ── Confidence ──
  if (confidenceBand === "high") {
    score += 1;
    drivers.push("confidence_high");
  }

  // ── Governance ──
  if (governancePolicyClass === "guardian_candidate" || governancePolicyClass === "admin_visible") {
    score += 1;
    drivers.push("governance_visible");
  }

  // ── Pattern frequency ──
  const pCount = typeof patternCount === "number" ? patternCount : 0;
  if (pCount >= 5) {
    score += 1;
    drivers.push("pattern_recurring");
  }

  // ── Helpfulness ──
  if (helpfulnessBand === "clearly_helpful") {
    score += 1;
    drivers.push("clearly_helpful");
  }

  // ── Follow-up need ──
  if (needsFollowup === true) {
    score += 1;
    drivers.push("followup_needed");
  }

  // ── Classify into attention band ──
  let attentionBand;
  if (score >= ATTENTION_SCORE_THRESHOLDS.focus_now) {
    attentionBand = "focus_now";
  } else if (score >= ATTENTION_SCORE_THRESHOLDS.review_today) {
    attentionBand = "review_today";
  } else if (score >= ATTENTION_SCORE_THRESHOLDS.watch_next) {
    attentionBand = "watch_next";
  } else {
    attentionBand = "background";
  }

  return {
    attentionBand,
    attentionScore:  score,
    attentionReason: _buildAttentionReason(attentionBand, drivers),
    focusDrivers:    drivers,
  };
}

/**
 * Build a short, human-readable explanation of
 * why a given attention band was assigned.
 *
 * Cooperative language – no alarm rhetoric.
 *
 * @param {string}   band    – the assigned attention band
 * @param {string[]} drivers – array of contributing dimension names
 * @returns {string} reason
 */
function _buildAttentionReason(band, drivers) {
  if (!drivers || drivers.length === 0) {
    return "Keine auffälligen Dimensionen – bleibt im Hintergrund.";
  }

  const driverLabels = {
    issue_severity_high:  "hohe technische Dringlichkeit",
    issue_severity_medium: "mittlere technische Dringlichkeit",
    case_needs_followup:  "Folgeprüfung empfohlen",
    case_confirmed:       "Fall bestätigt",
    case_watching:        "Fall wird beobachtet",
    readiness_mature:     "reife Handlungsempfehlung",
    readiness_useful:     "nützlicher nächster Schritt",
    confidence_high:      "hohe Konfidenz",
    governance_visible:   "für Admin sichtbar",
    pattern_recurring:    "häufig beobachtetes Muster",
    clearly_helpful:      "als hilfreich bestätigt",
    followup_needed:      "Folgeaktion wird benötigt",
  };

  const labels = drivers
    .map((d) => driverLabels[d] || d)
    .slice(0, 4);

  const bandLabels = {
    focus_now:    "Jetzt prüfen",
    review_today: "Heute relevant",
    watch_next:   "Weiter beobachten",
    background:   "Im Hintergrund",
  };

  const bandLabel = bandLabels[band] || band;
  return `${bandLabel} – ${labels.join(", ")}.`;
}

/**
 * Build an aggregated attention / priority overview
 * from all pattern memory entries and the case registry.
 *
 * Provides:
 * - attention band distribution
 * - which issue/case/readiness combinations frequently
 *   produce higher attention
 * - focus driver frequency
 * - recent high-priority entries
 *
 * @returns {Object} attention priority summary
 */
function getAttentionPrioritySummary() {
  const bandDistribution = {
    focus_now:    0,
    review_today: 0,
    watch_next:   0,
    background:   0,
  };
  const driverFrequency = {};
  const issueVsAttention = {};
  const caseVsAttention = {};
  const readinessVsAttention = {};
  const highPriorityEntries = [];

  for (const entry of _patternMemory.values()) {
    // Derive dominant dimensions from tallies
    const domIssueSeverity     = _topKey(entry.issueSeverityTally);
    const domCaseStatus        = _topKey(entry.caseStatusTally);
    const domReadiness         = _topKey(entry.readinessTally);
    const domConfidence        = _topKey(entry.confidenceTally);
    const domGovernance        = _topKey(entry.governanceTally);
    const domHelpfulness       = _topKey(entry.helpfulnessTally);

    // Check case registry for this pattern
    const caseEntry = _caseRegistry.get(entry.patternKey);
    const effectiveCaseStatus = caseEntry
      ? caseEntry.caseStatus
      : domCaseStatus;
    const effectiveNeedsFollowup = caseEntry
      ? (caseEntry.followupNeeded === true || caseEntry.caseStatus === "needs_followup")
      : false;

    const attention = classifyAttentionPriority({
      issueSeverity:         domIssueSeverity,
      caseStatus:            effectiveCaseStatus,
      readinessBand:         domReadiness,
      confidenceBand:        domConfidence,
      governancePolicyClass: domGovernance,
      helpfulnessBand:       domHelpfulness,
      needsFollowup:         effectiveNeedsFollowup,
      patternCount:          entry.count,
      hintCount:             0,
    });

    // Tally from pattern memory (if stored)
    const storedBandTally = entry.attentionBandTally || {};
    for (const [band, count] of Object.entries(storedBandTally)) {
      if (bandDistribution[band] !== undefined) {
        bandDistribution[band] += count;
      }
    }

    // Also count the current derived band (for patterns without stored tallies)
    bandDistribution[attention.attentionBand] =
      (bandDistribution[attention.attentionBand] || 0) + 1;

    // Driver frequency
    for (const driver of attention.focusDrivers) {
      driverFrequency[driver] = (driverFrequency[driver] || 0) + 1;
    }

    // Cross-references
    if (domIssueSeverity && attention.attentionBand) {
      const crossKey = `${domIssueSeverity}→${attention.attentionBand}`;
      issueVsAttention[crossKey] = (issueVsAttention[crossKey] || 0) + 1;
    }
    if (effectiveCaseStatus && attention.attentionBand) {
      const crossKey = `${effectiveCaseStatus}→${attention.attentionBand}`;
      caseVsAttention[crossKey] = (caseVsAttention[crossKey] || 0) + 1;
    }
    if (domReadiness && attention.attentionBand) {
      const crossKey = `${domReadiness}→${attention.attentionBand}`;
      readinessVsAttention[crossKey] = (readinessVsAttention[crossKey] || 0) + 1;
    }

    // Collect high-priority entries for the summary
    if (attention.attentionBand === "focus_now" || attention.attentionBand === "review_today") {
      highPriorityEntries.push({
        patternKey:      entry.patternKey,
        attentionBand:   attention.attentionBand,
        attentionScore:  attention.attentionScore,
        attentionReason: attention.attentionReason,
        focusDrivers:    attention.focusDrivers,
        issueSeverity:   domIssueSeverity,
        caseStatus:      effectiveCaseStatus,
        readinessBand:   domReadiness,
        observationCount: entry.count,
        lastSeen:        entry.lastSeen,
      });
    }
  }

  // Sort high-priority entries by score (highest first)
  highPriorityEntries.sort((a, b) => b.attentionScore - a.attentionScore);

  return {
    totalPatterns:          _patternMemory.size,
    totalCases:             _caseRegistry.size,
    bandDistribution,
    driverFrequency,
    issueVsAttention,
    caseVsAttention,
    readinessVsAttention,
    highPriorityEntries:    highPriorityEntries.slice(0, ATTENTION_MAX_SUMMARY_ENTRIES),
    currentBridgeAttention: _currentBridgePackage?.attentionContext || null,
    generatedAt:            new Date().toISOString(),
  };
}

/* ─────────────────────────────────────────────
   Step 13: Decision Maturity / Resolution
   Confidence classification
   ─────────────────────────────────────────────
   Derives a lightweight maturity / robustness
   classification from existing dimensions.
   Not a second trust layer or an auto-decision
   engine — just a quiet internal robustness
   assessment.
   ───────────────────────────────────────────── */

/**
 * Classify how mature / robust / confirmed a direction
 * currently is.  Derived transparently from existing
 * dimensions — no black-box scoring.
 *
 * @param {Object} params
 * @param {number}  [params.observationCount]
 * @param {string}  [params.confidenceBand]
 * @param {string}  [params.readinessBand]
 * @param {string}  [params.caseStatus]
 * @param {string}  [params.helpfulnessBand]
 * @param {string}  [params.governancePolicyClass]
 * @param {string}  [params.issueSeverity]
 * @param {string}  [params.attentionBand]
 * @param {boolean} [params.needsFollowup]
 * @param {number}  [params.hintCount]
 * @returns {{ decisionMaturityBand: string, maturityScore: number, maturityReason: string, maturityDrivers: string[] }}
 */
function classifyDecisionMaturity({
  observationCount = 0,
  confidenceBand   = "low",
  readinessBand    = "observation",
  caseStatus       = "open",
  helpfulnessBand  = "too_early_to_tell",
  governancePolicyClass = "shadow_only",
  issueSeverity    = null,
  attentionBand    = "background",
  needsFollowup    = false,
  hintCount        = 0,
} = {}) {
  let score = 0;
  const drivers = [];

  // ── Observation count (repeated confirmation strengthens maturity) ──
  if (observationCount >= 6) {
    score += 3;
    drivers.push("observations_substantial");
  } else if (observationCount >= 4) {
    score += 2;
    drivers.push("observations_recurring");
  } else if (observationCount >= 2) {
    score += 1;
    drivers.push("observations_repeated");
  }

  // ── Confidence band ──
  if (confidenceBand === "high") {
    score += 2;
    drivers.push("confidence_high");
  } else if (confidenceBand === "medium") {
    score += 1;
    drivers.push("confidence_medium");
  }

  // ── Readiness (mature recommendations strengthen maturity) ──
  if (readinessBand === "mature_recommendation") {
    score += 2;
    drivers.push("readiness_mature");
  } else if (readinessBand === "useful_next_step") {
    score += 1;
    drivers.push("readiness_useful");
  }

  // ── Case status (confirmed / resolved cases indicate maturity) ──
  if (caseStatus === "resolved") {
    score += 2;
    drivers.push("case_resolved");
  } else if (caseStatus === "confirmed") {
    score += 2;
    drivers.push("case_confirmed");
  } else if (caseStatus === "watching") {
    score += 1;
    drivers.push("case_watching");
  }

  // ── Helpfulness (clearly helpful signals confirm maturity) ──
  if (helpfulnessBand === "clearly_helpful") {
    score += 1;
    drivers.push("clearly_helpful");
  } else if (helpfulnessBand === "somewhat_helpful") {
    score += 1;
    drivers.push("somewhat_helpful");
  }

  // ── Governance (visible / guardian candidates carry weight) ──
  if (governancePolicyClass === "guardian_candidate") {
    score += 1;
    drivers.push("governance_guardian");
  } else if (governancePolicyClass === "admin_visible") {
    score += 1;
    drivers.push("governance_visible");
  }

  // ── Penalty: follow-up need reduces maturity (not yet settled) ──
  if (needsFollowup) {
    score = Math.max(0, score - 1);
    drivers.push("followup_pending");
  }

  // ── Classify into maturity band ──
  let decisionMaturityBand;
  if (score >= MATURITY_SCORE_THRESHOLDS.confirmed) {
    decisionMaturityBand = "confirmed";
  } else if (score >= MATURITY_SCORE_THRESHOLDS.credible) {
    decisionMaturityBand = "credible";
  } else if (score >= MATURITY_SCORE_THRESHOLDS.building) {
    decisionMaturityBand = "building";
  } else {
    decisionMaturityBand = "early_signal";
  }

  return {
    decisionMaturityBand,
    maturityScore:   score,
    maturityReason:  _buildMaturityReason(decisionMaturityBand, drivers),
    maturityDrivers: drivers,
  };
}

/**
 * Build a cooperative, human-readable maturity reason
 * in German — no alarm language, no absolute certainty.
 */
function _buildMaturityReason(band, drivers) {
  const labels = [];

  for (const d of drivers) {
    switch (d) {
      case "observations_substantial":
        labels.push("mehrfach beobachtet, Substanz vorhanden");
        break;
      case "observations_recurring":
        labels.push("wiederholt beobachtet");
        break;
      case "observations_repeated":
        labels.push("erste Wiederholung erkannt");
        break;
      case "confidence_high":
        labels.push("Konfidenz hoch");
        break;
      case "confidence_medium":
        labels.push("Konfidenz mittel");
        break;
      case "readiness_mature":
        labels.push("Handlungsempfehlung ausgereift");
        break;
      case "readiness_useful":
        labels.push("nützlicher nächster Schritt erkannt");
        break;
      case "case_resolved":
        labels.push("Fall operativ gelöst");
        break;
      case "case_confirmed":
        labels.push("Fall bestätigt");
        break;
      case "case_watching":
        labels.push("Fall wird beobachtet");
        break;
      case "clearly_helpful":
        labels.push("als hilfreich bestätigt");
        break;
      case "somewhat_helpful":
        labels.push("teilweise hilfreich");
        break;
      case "governance_guardian":
        labels.push("Guardian-Eignung erkannt");
        break;
      case "governance_visible":
        labels.push("Admin-sichtbar");
        break;
      case "followup_pending":
        labels.push("Folgeprüfung noch offen – Verdichtung eingeschränkt");
        break;
      default:
        break;
    }
  }

  // If no drivers matched, provide a safe default
  if (!labels.length) {
    labels.push("noch keine ausreichende Verdichtung");
  }

  const bandLabels = {
    early_signal: "Frühes Signal",
    building:     "Baut sich auf",
    credible:     "Gewinnt an Substanz",
    confirmed:    "Belastbar bestätigt",
  };

  const bandLabel = bandLabels[band] || band;
  return `${bandLabel} – ${labels.slice(0, 4).join(", ")}.`;
}

/**
 * Build an aggregated decision maturity / resolution
 * confidence overview from all pattern memory entries
 * and the case registry.
 *
 * Provides:
 * - maturity band distribution
 * - which dimensions frequently drive higher maturity
 * - cross-references (readiness vs maturity, case vs maturity,
 *   attention vs maturity)
 * - entries that are still early despite high attention
 *
 * @returns {Object} decision maturity summary
 */
function getDecisionMaturitySummary() {
  const bandDistribution = {
    early_signal: 0,
    building:     0,
    credible:     0,
    confirmed:    0,
  };
  const driverFrequency = {};
  const readinessVsMaturity = {};
  const caseVsMaturity = {};
  const attentionVsMaturity = {};
  const highMaturityEntries = [];
  const earlyDespiteAttention = [];

  for (const entry of _patternMemory.values()) {
    // Derive dominant dimensions from tallies
    const domConfidence        = _topKey(entry.confidenceTally);
    const domReadiness         = _topKey(entry.readinessTally);
    const domCaseStatus        = _topKey(entry.caseStatusTally);
    const domHelpfulness       = _topKey(entry.helpfulnessTally);
    const domGovernance        = _topKey(entry.governanceTally);
    const domIssueSeverity     = _topKey(entry.issueSeverityTally);
    const domAttention         = _topKey(entry.attentionBandTally);

    // Check case registry for this pattern
    const caseEntry = _caseRegistry.get(entry.patternKey);
    const effectiveCaseStatus = caseEntry
      ? caseEntry.caseStatus
      : domCaseStatus;
    const effectiveNeedsFollowup = caseEntry
      ? (caseEntry.followupNeeded === true || caseEntry.caseStatus === "needs_followup")
      : false;

    const maturity = classifyDecisionMaturity({
      observationCount:     entry.count,
      confidenceBand:       domConfidence,
      readinessBand:        domReadiness,
      caseStatus:           effectiveCaseStatus,
      helpfulnessBand:      domHelpfulness,
      governancePolicyClass: domGovernance,
      issueSeverity:        domIssueSeverity,
      attentionBand:        domAttention,
      needsFollowup:        effectiveNeedsFollowup,
      hintCount:            0,
    });

    // Tally from pattern memory (if stored)
    const storedBandTally = entry.maturityBandTally || {};
    for (const [band, count] of Object.entries(storedBandTally)) {
      if (bandDistribution[band] !== undefined) {
        bandDistribution[band] += count;
      }
    }

    // Also count current derived band
    bandDistribution[maturity.decisionMaturityBand] =
      (bandDistribution[maturity.decisionMaturityBand] || 0) + 1;

    // Driver frequency
    for (const driver of maturity.maturityDrivers) {
      driverFrequency[driver] = (driverFrequency[driver] || 0) + 1;
    }

    // Cross-references
    if (domReadiness && maturity.decisionMaturityBand) {
      const crossKey = `${domReadiness}→${maturity.decisionMaturityBand}`;
      readinessVsMaturity[crossKey] = (readinessVsMaturity[crossKey] || 0) + 1;
    }
    if (effectiveCaseStatus && maturity.decisionMaturityBand) {
      const crossKey = `${effectiveCaseStatus}→${maturity.decisionMaturityBand}`;
      caseVsMaturity[crossKey] = (caseVsMaturity[crossKey] || 0) + 1;
    }
    if (domAttention && maturity.decisionMaturityBand) {
      const crossKey = `${domAttention}→${maturity.decisionMaturityBand}`;
      attentionVsMaturity[crossKey] = (attentionVsMaturity[crossKey] || 0) + 1;
    }

    // Collect high-maturity entries
    if (maturity.decisionMaturityBand === "confirmed" || maturity.decisionMaturityBand === "credible") {
      highMaturityEntries.push({
        patternKey:           entry.patternKey,
        decisionMaturityBand: maturity.decisionMaturityBand,
        maturityScore:        maturity.maturityScore,
        maturityReason:       maturity.maturityReason,
        maturityDrivers:      maturity.maturityDrivers,
        readinessBand:        domReadiness,
        caseStatus:           effectiveCaseStatus,
        attentionBand:        domAttention,
        observationCount:     entry.count,
        lastSeen:             entry.lastSeen,
      });
    }

    // Detect entries that are early_signal despite high attention
    if (
      maturity.decisionMaturityBand === "early_signal" &&
      (domAttention === "focus_now" || domAttention === "review_today")
    ) {
      earlyDespiteAttention.push({
        patternKey:           entry.patternKey,
        decisionMaturityBand: maturity.decisionMaturityBand,
        attentionBand:        domAttention,
        maturityReason:       maturity.maturityReason,
        observationCount:     entry.count,
        lastSeen:             entry.lastSeen,
      });
    }
  }

  // Sort high-maturity entries by score (highest first)
  highMaturityEntries.sort((a, b) => b.maturityScore - a.maturityScore);
  earlyDespiteAttention.sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""));

  return {
    totalPatterns:           _patternMemory.size,
    totalCases:              _caseRegistry.size,
    bandDistribution,
    driverFrequency,
    readinessVsMaturity,
    caseVsMaturity,
    attentionVsMaturity,
    highMaturityEntries:     highMaturityEntries.slice(0, MATURITY_MAX_SUMMARY_ENTRIES),
    earlyDespiteAttention:   earlyDespiteAttention.slice(0, 20),
    currentBridgeMaturity:   _currentBridgePackage?.maturityContext || null,
    generatedAt:             new Date().toISOString(),
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
   Step 14: Agent Problem Detection / Solution
   Proposal / Approval Chat Foundation
   ─────────────────────────────────────────────
   Core functions that transform diagnostic data
   from Steps 1–13 into agentisches Handeln:

   1. Problem erkannt
   2. wahrscheinliche Ursache
   3. konkrete Lösung
   4. Freigabefrage
   5. nächster Schritt bei OK

   Cooperative, not autonomous.
   ───────────────────────────────────────────── */

/**
 * Determine the owning agent role based on the affected layer.
 * DeepSeek owns backend/API/logic/schema layers.
 * Gemini owns frontend/layout/presentation/binding layers.
 *
 * @param {string} affectedLayer
 * @returns {string} agent role
 */
function _resolveAgentRole(affectedLayer) {
  const frontendLayers = [
    "frontend_binding",
    "frontend_layout",
    "frontend_presentation",
    "frontend_priority",
  ];
  if (frontendLayers.includes(affectedLayer)) {
    return "gemini_frontend";
  }
  return "deepseek_backend";
}

/**
 * Derive the problem type from issue/layer/hint information.
 *
 * @param {Object} params
 * @param {string} [params.issueCategory]
 * @param {string} [params.affectedLayer]
 * @param {string} [params.dominantHintType]
 * @returns {string} problem type
 */
function _deriveAgentProblemType({ issueCategory, affectedLayer, dominantHintType }) {
  // Direct layer-based mapping
  const layerMap = {
    backend_logic:          "backend_logic_issue",
    backend_schema:         "backend_schema_issue",
    api_contract:           "api_contract_issue",
    frontend_binding:       "frontend_binding_issue",
    frontend_layout:        "frontend_layout_issue",
    frontend_presentation:  "frontend_presentation_issue",
    cross_layer:            "cross_layer_issue",
  };

  if (affectedLayer && layerMap[affectedLayer]) {
    return layerMap[affectedLayer];
  }

  // Issue category fallbacks
  if (issueCategory === "mapping_problem") return "mapping_issue";
  if (issueCategory === "stale_data") return "staleness_issue";
  if (issueCategory === "data_inconsistency") return "data_flow_issue";

  // Hint type fallbacks
  if (dominantHintType === "schema_risk") return "backend_schema_issue";
  if (dominantHintType === "binding_risk") return "frontend_binding_issue";
  if (dominantHintType === "staleness") return "staleness_issue";
  if (dominantHintType === "contract_warning") return "api_contract_issue";

  return "unknown";
}

/**
 * Derive concrete recommended fixes from existing diagnostic data.
 * Returns an array of short, actionable fix descriptions.
 *
 * @param {Object} params
 * @param {string} params.problemType
 * @param {string} params.agentRole
 * @param {string} [params.issueSeverity]
 * @param {string} [params.suggestedFix]
 * @param {string} [params.issueCategory]
 * @param {string} [params.readinessBand]
 * @returns {string[]} recommended fixes
 */
function _deriveRecommendedFixes({ problemType, agentRole, issueSeverity, suggestedFix, issueCategory, readinessBand }) {
  const fixes = [];
  const addedCategories = new Set();

  // Start with system-suggested fix if available
  if (suggestedFix && suggestedFix !== "none" && suggestedFix !== "observe") {
    const fixLabels = {
      review_mapping:   "Mapping-Zuordnung prüfen und korrigieren",
      fix_binding:      "Datenbindung im Frontend reparieren",
      fix_schema:       "Schema-Definition bereinigen",
      fix_contract:     "API-Vertrag absichern",
      harden_logic:     "Backend-Logik härten",
      adjust_priority:  "Prioritäts-Darstellung anpassen",
      review_layout:    "Layout-Struktur überprüfen",
      add_validation:   "Validierung ergänzen",
    };
    fixes.push(fixLabels[suggestedFix] || suggestedFix);
    addedCategories.add(suggestedFix);
  }

  // Problem-type-specific fixes
  if (agentRole === "deepseek_backend") {
    if (problemType === "backend_logic_issue") {
      fixes.push("Backend-Logik härten und Fehlerpfade absichern");
      addedCategories.add("secure_path");
    }
    if (problemType === "backend_schema_issue") {
      fixes.push("Schema-Definition bereinigen und Konsistenz sicherstellen");
    }
    if (problemType === "api_contract_issue") {
      fixes.push("API-Vertrag prüfen und Rückgabewerte absichern");
      addedCategories.add("secure_path");
    }
    if (problemType === "data_flow_issue") {
      fixes.push("Datenfluss nachverfolgen und Inkonsistenzen beheben");
    }
    if (problemType === "mapping_issue") {
      fixes.push("Mapping-Zuordnung korrigieren und alten Pfad entfernen");
    }
  } else {
    if (problemType === "frontend_binding_issue") {
      fixes.push("Datenbindung prüfen und korrekte Felder anbinden");
    }
    if (problemType === "frontend_layout_issue") {
      fixes.push("Layout-Struktur anpassen und Darstellung klären");
    }
    if (problemType === "frontend_presentation_issue") {
      fixes.push("Beschriftung und View-Struktur anpassen");
    }
  }

  // Severity-driven additions (only if no secure_path fix already present)
  if (issueSeverity === "high" && !addedCategories.has("secure_path")) {
    fixes.push("Kritischen Pfad absichern");
  }

  // Cap at 3 fixes to keep proposals concise
  return fixes.slice(0, 3);
}

/**
 * Derive the recommended action path (preparation type).
 *
 * @param {Object} params
 * @param {string} params.problemType
 * @param {string} params.agentRole
 * @param {string} [params.suggestedFix]
 * @returns {string} preparation type
 */
function _derivePreparationType({ problemType, agentRole, suggestedFix }) {
  if (suggestedFix === "harden_logic" || problemType === "backend_logic_issue") return "harden_logic";
  if (suggestedFix === "fix_binding" || problemType === "frontend_binding_issue") return "fix_binding";
  if (suggestedFix === "review_mapping" || problemType === "mapping_issue") return "fix_mapping";
  if (problemType === "frontend_layout_issue") return "adjust_layout";
  if (problemType === "frontend_presentation_issue") return "adjust_presentation";
  if (problemType === "backend_schema_issue") return "add_validation";
  if (problemType === "api_contract_issue") return "add_validation";
  if (problemType === "data_flow_issue") return "refactor_data_flow";
  if (problemType === "cross_layer_issue") return "cross_layer_review";
  return "deepen_diagnosis";
}

/**
 * Compute agent confidence from existing dimensions.
 * Returns a value between 0 and 1.
 *
 * @param {Object} params
 * @returns {number} confidence 0.0–1.0
 */
function _computeAgentConfidence({
  confidenceBand = "low",
  readinessBand = "observation",
  maturityBand = "early_signal",
  attentionBand = "background",
  observationCount = 0,
}) {
  let score = 0;

  // Confidence band contribution
  if (confidenceBand === "high") score += 0.3;
  else if (confidenceBand === "medium") score += 0.15;

  // Readiness contribution
  if (readinessBand === "mature_recommendation") score += 0.25;
  else if (readinessBand === "useful_next_step") score += 0.15;
  else if (readinessBand === "further_check_recommended") score += 0.05;

  // Maturity contribution
  if (maturityBand === "confirmed") score += 0.25;
  else if (maturityBand === "credible") score += 0.15;
  else if (maturityBand === "building") score += 0.05;

  // Observation count contribution (capped)
  score += Math.min(0.15, observationCount * 0.025);

  // Attention contribution (high attention = more relevance)
  if (attentionBand === "focus_now") score += 0.05;
  else if (attentionBand === "review_today") score += 0.03;

  return Math.min(1.0, Math.round(score * 100) / 100);
}

/**
 * Build a cooperative, human-readable agent chat message
 * in German. The message follows the pattern:
 *   1. "Ich habe ein Problem erkannt."
 *   2. "Es liegt wahrscheinlich an …"
 *   3. "Ich würde … ändern."
 *   4. "Soll ich das vorbereiten?"
 *
 * @param {Object} agentCase
 * @returns {string} chat message
 */
function _buildAgentChatMessage(agentCase) {
  const parts = [];
  const isBackend = agentCase.agentRole === "deepseek_backend";
  const agentName = isBackend ? "DeepSeek" : "Gemini";
  const domain = isBackend ? "Backend" : "Frontend";

  // 1. Problem statement
  if (agentCase.problemTitle) {
    parts.push(`Ich habe ein ${domain}-Problem erkannt: ${agentCase.problemTitle}.`);
  } else {
    parts.push(`Ich habe ein ${domain}-Problem erkannt.`);
  }

  // 2. Root cause
  if (agentCase.suspectedRootCause) {
    parts.push(`Wahrscheinlich liegt es an: ${agentCase.suspectedRootCause}.`);
  }

  // 3. Proposed fix
  if (agentCase.recommendedFixes && agentCase.recommendedFixes.length > 0) {
    if (agentCase.recommendedFixes.length === 1) {
      parts.push(`Ich würde Folgendes ändern: ${agentCase.recommendedFixes[0]}.`);
    } else {
      parts.push(`Das ist mein Vorschlag:\n${agentCase.recommendedFixes.map(f => `– ${f}`).join("\n")}`);
    }
  }

  // 4. Approval question
  if (agentCase.approvalQuestion) {
    parts.push(agentCase.approvalQuestion);
  }

  return parts.join("\n");
}

/**
 * Build a targeted approval question based on the agent case.
 *
 * @param {Object} params
 * @param {string} params.agentRole
 * @param {string} params.problemType
 * @param {string} params.proposedPreparationType
 * @param {boolean} params.needsCrossAgentReview
 * @returns {string} approval question
 */
function _buildApprovalQuestion({ agentRole, problemType, proposedPreparationType, needsCrossAgentReview }) {
  const isBackend = agentRole === "deepseek_backend";

  // Specific approval questions based on preparation type
  const prepLabels = {
    harden_logic:       "die Backend-Logik härten",
    fix_mapping:        "die Mapping-Zuordnung korrigieren",
    fix_binding:        "die Datenbindung reparieren",
    adjust_layout:      "die Layout-Struktur anpassen",
    adjust_presentation: "die Darstellung anpassen",
    remove_legacy_path: "den alten Pfad entfernen",
    add_validation:     "eine Validierung ergänzen",
    refactor_data_flow: "den Datenfluss überarbeiten",
    deepen_diagnosis:   "die Diagnose vertiefen",
    cross_layer_review: "eine schichtübergreifende Prüfung vorbereiten",
  };

  const actionLabel = prepLabels[proposedPreparationType] || "das vorbereiten";

  let question = `Soll ich ${actionLabel}?`;

  if (needsCrossAgentReview) {
    question += " (Hinweis: Dieser Fall betrifft auch die andere Schicht.)";
  }

  question += "\nWenn du eine andere Idee hast, passe ich den Vorschlag an.";

  return question;
}

/**
 * Derive a suspected root cause description from diagnostic data.
 *
 * @param {Object} params
 * @returns {string} root cause summary
 */
function _deriveSuspectedRootCause({ problemType, issueCategory, affectedLayer, dominantHintType, suspectedIssueCause }) {
  // Use the explicit suspected cause if available
  if (suspectedIssueCause && suspectedIssueCause !== "unknown" && suspectedIssueCause !== "none") {
    const causeLabels = {
      outdated_mapping:     "eine veraltete Mapping-Zuordnung",
      missing_field:        "ein fehlendes Datenfeld",
      wrong_binding:        "eine falsche Datenbindung",
      stale_cache:          "veraltete Cache-Daten",
      schema_mismatch:      "ein Schema-Mismatch",
      logic_error:          "ein Logikfehler im Backend",
      priority_drift:       "eine Prioritätsverschiebung",
      layout_conflict:      "ein Layout-Konflikt",
      presentation_error:   "ein Darstellungsfehler",
    };
    return causeLabels[suspectedIssueCause] || suspectedIssueCause;
  }

  // Derive from problem type
  const typeLabels = {
    backend_logic_issue:          "fehlerhafte oder unvollständige Backend-Logik",
    backend_schema_issue:         "ein Schema- oder Strukturproblem im Backend",
    api_contract_issue:           "ein API-Vertragsproblem",
    frontend_binding_issue:       "eine falsche oder fehlende Datenbindung im Frontend",
    frontend_layout_issue:        "ein Layout- oder Strukturproblem in der Darstellung",
    frontend_presentation_issue:  "unklare oder fehlerhafte Darstellung",
    cross_layer_issue:            "ein schichtübergreifendes Problem zwischen Backend und Frontend",
    data_flow_issue:              "Inkonsistenzen im Datenfluss",
    mapping_issue:                "fehlerhafte Mapping-Zuordnung",
    staleness_issue:              "veraltete Daten oder Strukturen",
    performance_issue:            "ein Performance-Engpass",
  };

  return typeLabels[problemType] || "ein noch nicht vollständig geklärtes Problem";
}

/**
 * Build a complete agent case from a bridge package.
 * This is the central Step 14 function that transforms
 * diagnostic data into an actionable agent case with:
 * - problem summary
 * - root cause
 * - recommended fixes
 * - approval question
 * - chat message
 *
 * @param {Object} bridgePackage - current bridge package
 * @returns {Object|null} agent case or null if not actionable
 */
function buildAgentCaseFromBridgePackage(bridgePackage) {
  if (!bridgePackage) return null;

  const issue = bridgePackage.issueContext || {};
  const pattern = bridgePackage.patternContext || {};
  const maturity = bridgePackage.maturityContext || {};
  const attention = bridgePackage.attentionContext || {};
  const caseCtx = bridgePackage.caseContext || {};
  const governance = bridgePackage.governanceContext || {};
  const impact = bridgePackage.impactTranslation || {};
  const hints = bridgePackage.bridgeHints || [];

  // Only create agent cases for actionable situations
  const isActionable =
    (issue.issueSeverity === "high" || issue.issueSeverity === "medium") ||
    (attention.attentionBand === "focus_now" || attention.attentionBand === "review_today") ||
    (pattern.actionReadinessBand === "useful_next_step" || pattern.actionReadinessBand === "mature_recommendation") ||
    (maturity.decisionMaturityBand === "credible" || maturity.decisionMaturityBand === "confirmed");

  if (!isActionable) {
    return null;
  }

  // Determine affected layer and domain
  const affectedLayer = issue.affectedLayer || pattern.dominantLayer || "cross_layer";
  const agentRole = _resolveAgentRole(affectedLayer);
  const problemType = _deriveAgentProblemType({
    issueCategory: issue.issueCategory,
    affectedLayer,
    dominantHintType: pattern.dominantHintType,
  });

  // Determine if cross-agent review is needed
  const isBackend = agentRole === "deepseek_backend";
  const needsCrossAgentReview =
    affectedLayer === "cross_layer" ||
    (isBackend && hints.some(h => ["frontend_binding", "frontend_layout", "frontend_presentation"].includes(h.affectedLayer))) ||
    (!isBackend && hints.some(h => ["backend_logic", "backend_schema", "api_contract"].includes(h.affectedLayer)));

  // Build problem title from issue or hint data
  const problemTitle = issue.issueTitle
    || (hints.length > 0 ? hints[0].summary : null)
    || impact.impactSummary
    || `${problemType.replace(/_/g, " ")}`;

  // Derive root cause
  const suspectedRootCause = _deriveSuspectedRootCause({
    problemType,
    issueCategory: issue.issueCategory,
    affectedLayer,
    dominantHintType: pattern.dominantHintType,
    suspectedIssueCause: issue.suspectedIssueCause,
  });

  // Derive recommended fixes
  const recommendedFixes = _deriveRecommendedFixes({
    problemType,
    agentRole,
    issueSeverity: issue.issueSeverity,
    suggestedFix: issue.suggestedFix,
    issueCategory: issue.issueCategory,
    readinessBand: pattern.actionReadinessBand,
  });

  // Derive preparation type and action path
  const proposedPreparationType = _derivePreparationType({
    problemType,
    agentRole,
    suggestedFix: issue.suggestedFix,
  });

  // Compute agent confidence
  const agentConfidence = _computeAgentConfidence({
    confidenceBand: pattern.confidenceBand || "low",
    readinessBand: pattern.actionReadinessBand,
    maturityBand: maturity.decisionMaturityBand,
    attentionBand: attention.attentionBand,
    observationCount: 0,
  });

  // Determine approval scope
  let approvalScope = "full_fix";
  if (needsCrossAgentReview) approvalScope = "full_fix";
  else if (isBackend) approvalScope = "backend_only";
  else approvalScope = "frontend_only";
  if (agentConfidence < AGENT_CONFIDENCE_THRESHOLDS.medium) {
    approvalScope = "diagnosis_only";
  }

  // Build approval question
  const approvalQuestion = _buildApprovalQuestion({
    agentRole,
    problemType,
    proposedPreparationType,
    needsCrossAgentReview,
  });

  // Build change targets
  const changeTargets = [];
  if (issue.affectedComponents && issue.affectedComponents.length) {
    changeTargets.push(...issue.affectedComponents.slice(0, 3));
  }
  if (impact.likelyAffectedArtifacts && impact.likelyAffectedArtifacts.length) {
    for (const a of impact.likelyAffectedArtifacts.slice(0, 2)) {
      if (!changeTargets.includes(a)) changeTargets.push(a);
    }
  }

  // Assign case ID
  _agentCaseIdCounter += 1;
  const agentCaseId = `ac-${Date.now()}-${_agentCaseIdCounter}`;

  const agentCase = {
    agentCaseId,
    agentRole,
    ownerAgent: agentRole,
    affectedDomain: isBackend ? "backend" : "frontend",
    solutionDomain: isBackend ? "backend" : "frontend",
    needsCrossAgentReview,

    // Problem description
    problemType,
    problemTitle:        problemTitle.length > MAX_PROBLEM_TITLE_LENGTH ? problemTitle.slice(0, MAX_PROBLEM_TITLE_LENGTH - 3) + "..." : problemTitle,
    problemSummary:      `${_resolveAgentRole(affectedLayer) === "deepseek_backend" ? "Backend" : "Frontend"}-Problem erkannt: ${problemTitle}.`,
    suspectedRootCause,

    // Solution proposal
    recommendedFixes,
    recommendedActionPath:   proposedPreparationType,
    changeTargets:           changeTargets.slice(0, 5),

    // Approval / Feedback
    needsApproval:           true,
    approvalQuestion,
    approvalScope,
    proposedPreparationType,
    proposedActionBundle:    recommendedFixes.join("; "),
    userFeedbackSupported:   true,

    // Feedback loop preparation
    feedbackOptions:         ["approve", "reject", "modify", "narrow_scope", "suggest_alternative", "defer"],
    acceptedFeedbackTypes:   VALID_AGENT_FEEDBACK_TYPES,
    agentCanRefinePlan:      true,
    planVersion:             1,
    alternateSuggestionSupported: true,

    // Confidence & context
    agentConfidence,
    issueSeverity:           issue.issueSeverity || null,
    attentionBand:           attention.attentionBand || null,
    maturityBand:            maturity.decisionMaturityBand || null,
    readinessBand:           pattern.actionReadinessBand || null,
    caseStatus:              caseCtx.caseStatus || null,
    governanceClass:         governance.policyClass || null,

    // Lifecycle
    status:                  "proposed",
    feedbackHistory:         [],
    createdAt:               new Date().toISOString(),
    updatedAt:               new Date().toISOString(),
  };

  // Build the chat message
  agentCase.chatMessage = _buildAgentChatMessage(agentCase);

  // Derive next suggested step
  if (agentConfidence >= AGENT_CONFIDENCE_THRESHOLDS.high) {
    agentCase.nextSuggestedStep = "Freigabe erteilen und Vorbereitung starten";
  } else if (agentConfidence >= AGENT_CONFIDENCE_THRESHOLDS.medium) {
    agentCase.nextSuggestedStep = "Vorschlag prüfen und ggf. anpassen";
  } else {
    agentCase.nextSuggestedStep = "Diagnose vertiefen – noch nicht ausreichend belastbar";
  }

  // Store in registry
  _agentCaseRegistry.set(agentCaseId, agentCase);

  // Evict oldest if over limit
  if (_agentCaseRegistry.size > AGENT_CASE_MAX_ENTRIES) {
    let oldestKey = null;
    let oldestTime = null;
    for (const [key, val] of _agentCaseRegistry) {
      if (!oldestTime || val.createdAt < oldestTime) {
        oldestTime = val.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey) _agentCaseRegistry.delete(oldestKey);
  }

  // Create chat messages for this case
  _recordAgentChatMessage({
    agentCaseId,
    agentRole,
    messageType: "problem_detected",
    messageIntent: "inform",
    messagePriority: attention.attentionBand === "focus_now" ? "high" : "normal",
    requiresUserDecision: true,
    message: agentCase.chatMessage,
    problemType,
  });

  // Log agent case creation
  logger.info("[agentBridge] Step 14 – agent case created", {
    agentCaseId,
    agentRole,
    problemType,
    problemTitle: agentCase.problemTitle,
    suspectedRootCause,
    fixCount: recommendedFixes.length,
    approvalScope,
    agentConfidence,
    needsCrossAgentReview,
    preparationType: proposedPreparationType,
    attentionBand: attention.attentionBand,
    maturityBand: maturity.decisionMaturityBand,
    status: "proposed",
  });

  return agentCase;
}

/**
 * Record a chat message in the agent message store.
 * Step 15 adds optional planPhase and controlledPreparationType
 * fields to support richer thread tracking.
 * Step 17 adds apply-readiness / approval phase fields.
 * Step 18 adds execution preview / safety / reversal fields.
 * Step 19 adds apply candidate / approval gate fields.
 *
 * @param {Object} params
 */
function _recordAgentChatMessage({
  agentCaseId,
  agentRole,
  messageType,
  messageIntent,
  messagePriority = "normal",
  requiresUserDecision = false,
  message,
  problemType = null,
  planPhase = null,
  controlledPreparationType = null,
  // Step 16 additions
  draftType = null,
  draftStatus = null,
  bundleType = null,
  actionIntent = null,
  nextActionAvailable = false,
  // Step 17 additions
  readinessBand = null,
  executionIntent = null,
  applyBlocked = null,
  recommendedApplyMode = null,
  nextApprovalAvailable = false,
  // Step 18 additions
  previewState = null,
  safetyBand = null,
  previewBlocked = null,
  rollbackRequired = null,
  recommendedApplyWindow = null,
  nextSafetyStep = null,
  // Step 19 additions
  candidateStatus = null,
  candidateMode = null,
  scopeLocked = null,
  nextApprovalStep = null,
  candidateReadyForFinalApproval = null,
  // Step 20 additions
  runtimeStatus = null,
  runtimeMode = null,
  executionState = null,
  executionAllowed = null,
  executionBlocked = null,
  abortAvailable = null,
  killSwitchAvailable = null,
  rollbackReserved = null,
  nextRuntimeStep = null,
  // Step 22 additions
  handoffStatus = null,
  crossAgentState = null,
  handoffFrom = null,
  handoffTo = null,
  handoffReason = null,
}) {
  const chatMessage = {
    messageId:           `msg-${Date.now()}-${_agentChatMessages.length + 1}`,
    threadId:            agentCaseId,
    caseId:              agentCaseId,
    agentRole,
    messageType,
    messageIntent,
    messagePriority,
    requiresUserDecision,
    agentMessage:        message,
    problemType,
    createdAt:           new Date().toISOString(),
  };

  // Step 15: attach plan context when available
  if (planPhase) {
    chatMessage.planPhase = planPhase;
  }
  if (controlledPreparationType) {
    chatMessage.controlledPreparationType = controlledPreparationType;
  }

  // Step 16: attach draft / bundle context when available
  if (draftType) {
    chatMessage.draftType = draftType;
  }
  if (draftStatus) {
    chatMessage.draftStatus = draftStatus;
  }
  if (bundleType) {
    chatMessage.bundleType = bundleType;
  }
  if (actionIntent) {
    chatMessage.actionIntent = actionIntent;
  }
  if (nextActionAvailable) {
    chatMessage.nextActionAvailable = true;
  }

  // Step 17: attach apply-readiness / approval context when available
  if (readinessBand) {
    chatMessage.readinessBand = readinessBand;
  }
  if (executionIntent) {
    chatMessage.executionIntent = executionIntent;
  }
  if (applyBlocked !== null && applyBlocked !== undefined) {
    chatMessage.applyBlocked = applyBlocked;
  }
  if (recommendedApplyMode) {
    chatMessage.recommendedApplyMode = recommendedApplyMode;
  }
  if (nextApprovalAvailable) {
    chatMessage.nextApprovalAvailable = true;
  }

  // Step 18: attach preview / safety context when available
  if (previewState) {
    chatMessage.previewState = previewState;
  }
  if (safetyBand) {
    chatMessage.safetyBand = safetyBand;
  }
  if (previewBlocked !== null && previewBlocked !== undefined) {
    chatMessage.previewBlocked = previewBlocked;
  }
  if (rollbackRequired !== null && rollbackRequired !== undefined) {
    chatMessage.rollbackRequired = rollbackRequired;
  }
  if (recommendedApplyWindow) {
    chatMessage.recommendedApplyWindow = recommendedApplyWindow;
  }
  if (nextSafetyStep) {
    chatMessage.nextSafetyStep = nextSafetyStep;
  }

  // Step 19: attach apply candidate / approval gate context when available
  if (candidateStatus) {
    chatMessage.candidateStatus = candidateStatus;
  }
  if (candidateMode) {
    chatMessage.candidateMode = candidateMode;
  }
  if (scopeLocked !== null && scopeLocked !== undefined) {
    chatMessage.scopeLocked = scopeLocked;
  }
  if (nextApprovalStep) {
    chatMessage.nextApprovalStep = nextApprovalStep;
  }
  if (candidateReadyForFinalApproval !== null && candidateReadyForFinalApproval !== undefined) {
    chatMessage.candidateReadyForFinalApproval = candidateReadyForFinalApproval;
  }

  // Step 20: attach runtime / execution orchestrator context when available
  if (runtimeStatus) {
    chatMessage.runtimeStatus = runtimeStatus;
  }
  if (runtimeMode) {
    chatMessage.runtimeMode = runtimeMode;
  }
  if (executionState) {
    chatMessage.executionState = executionState;
  }
  if (executionAllowed !== null && executionAllowed !== undefined) {
    chatMessage.executionAllowed = executionAllowed;
  }
  if (executionBlocked !== null && executionBlocked !== undefined) {
    chatMessage.executionBlocked = executionBlocked;
  }
  if (abortAvailable !== null && abortAvailable !== undefined) {
    chatMessage.abortAvailable = abortAvailable;
  }
  if (killSwitchAvailable !== null && killSwitchAvailable !== undefined) {
    chatMessage.killSwitchAvailable = killSwitchAvailable;
  }
  if (rollbackReserved !== null && rollbackReserved !== undefined) {
    chatMessage.rollbackReserved = rollbackReserved;
  }
  if (nextRuntimeStep) {
    chatMessage.nextRuntimeStep = nextRuntimeStep;
  }

  // Step 22: attach handoff / cross-agent context when available
  if (handoffStatus) {
    chatMessage.handoffStatus = handoffStatus;
  }
  if (crossAgentState) {
    chatMessage.crossAgentState = crossAgentState;
  }
  if (handoffFrom) {
    chatMessage.handoffFrom = handoffFrom;
  }
  if (handoffTo) {
    chatMessage.handoffTo = handoffTo;
  }
  if (handoffReason) {
    chatMessage.handoffReason = handoffReason;
  }

  // Derive message phase from available context (Step 22 → Step 21 → Step 20 → … → Step 15)
  if (planPhase === "cross_agent_handoff_phase" || (handoffStatus && handoffStatus !== "handoff_not_needed")) {
    chatMessage.messagePhase = "cross_agent_handoff_phase";
  } else if (planPhase === "conversation_phase") {
    chatMessage.messagePhase = "conversation_phase";
  } else if (runtimeStatus || planPhase === "runtime_execution_phase") {
    chatMessage.messagePhase = "runtime_execution_phase";
  } else if (candidateStatus || planPhase === "candidate_gate_phase") {
    chatMessage.messagePhase = "candidate_gate_phase";
  } else if (previewState || planPhase === "preview_safety_phase") {
    chatMessage.messagePhase = "preview_safety_phase";
  } else if (planPhase === "approval_phase" || readinessBand) {
    chatMessage.messagePhase = "approval_phase";
  } else if (draftType || planPhase === "draft_phase") {
    chatMessage.messagePhase = "draft_phase";
  } else if (planPhase === "preparation_phase") {
    chatMessage.messagePhase = "preparation_phase";
  } else if (planPhase === "refinement_phase") {
    chatMessage.messagePhase = "refinement_phase";
  } else if (planPhase === "feedback_phase") {
    chatMessage.messagePhase = "feedback_phase";
  } else if (planPhase === "solution_phase") {
    chatMessage.messagePhase = "solution_phase";
  } else if (planPhase === "problem_phase" || messageType === "problem_detected") {
    chatMessage.messagePhase = "problem_phase";
  }

  _agentChatMessages.push(chatMessage);

  // Evict oldest if over limit
  while (_agentChatMessages.length > AGENT_CHAT_MAX_MESSAGES) {
    _agentChatMessages.shift();
  }

  return chatMessage;
}

/**
 * Process user feedback on an agent case.
 * Supports: approve, reject, modify, narrow_scope,
 * suggest_alternative, request_more_info, defer, approve_partial.
 *
 * Step 15: After updating the case status, this function now
 * also builds a refined plan via _translateFeedbackToRefinedPlan()
 * and attaches it to the case as `refinedPlan15`.
 *
 * @param {Object} params
 * @param {string} params.agentCaseId
 * @param {string} params.feedbackType
 * @param {string} [params.userMessage]
 * @param {string} [params.preferredScope]
 * @param {string} [params.alternativeSuggestion]
 * @returns {Object} feedback result
 */
function submitAgentCaseFeedback({
  agentCaseId,
  feedbackType,
  userMessage = null,
  preferredScope = null,
  alternativeSuggestion = null,
} = {}) {
  if (!agentCaseId || !_agentCaseRegistry.has(agentCaseId)) {
    logger.warn("[agentBridge] Step 14 – feedback for unknown agent case", { agentCaseId });
    return { success: false, error: "Agent case not found" };
  }

  if (!feedbackType || !VALID_AGENT_FEEDBACK_TYPES.includes(feedbackType)) {
    return { success: false, error: `Invalid feedback type. Valid: ${VALID_AGENT_FEEDBACK_TYPES.join(", ")}` };
  }

  const agentCase = _agentCaseRegistry.get(agentCaseId);

  // Record feedback
  const feedbackEntry = {
    feedbackType,
    userMessage:            userMessage || null,
    preferredScope:         preferredScope || null,
    alternativeSuggestion:  alternativeSuggestion || null,
    receivedAt:             new Date().toISOString(),
    planVersionAtFeedback:  agentCase.planVersion,
  };

  agentCase.feedbackHistory.push(feedbackEntry);
  agentCase.updatedAt = new Date().toISOString();

  // Update case status based on feedback
  if (feedbackType === "approve") {
    agentCase.status = "approved";
    agentCase.nextSuggestedStep = "Lösungsvorbereitung kann gestartet werden";
  } else if (feedbackType === "approve_partial") {
    agentCase.status = "partially_approved";
    if (preferredScope && VALID_APPROVAL_SCOPES.includes(preferredScope)) {
      agentCase.approvalScope = preferredScope;
    }
    agentCase.nextSuggestedStep = `Teilweise Freigabe – Scope: ${agentCase.approvalScope}`;
  } else if (feedbackType === "reject") {
    agentCase.status = "rejected";
    agentCase.nextSuggestedStep = "Vorschlag wurde abgelehnt – warte auf neue Richtung";
  } else if (feedbackType === "modify" || feedbackType === "suggest_alternative") {
    agentCase.status = "refinement_requested";
    agentCase.planVersion += 1;
    if (alternativeSuggestion) {
      agentCase.recommendedFixes = [alternativeSuggestion];
      agentCase.proposedActionBundle = alternativeSuggestion;
    }
    agentCase.nextSuggestedStep = "Vorschlag wird angepasst – neue Version vorbereiten";
    agentCase.chatMessage = _buildAgentChatMessage(agentCase);
  } else if (feedbackType === "narrow_scope") {
    agentCase.status = "scope_narrowed";
    if (preferredScope && VALID_APPROVAL_SCOPES.includes(preferredScope)) {
      agentCase.approvalScope = preferredScope;
    }
    agentCase.nextSuggestedStep = `Scope eingegrenzt auf: ${agentCase.approvalScope}`;
  } else if (feedbackType === "request_more_info") {
    agentCase.status = "info_requested";
    agentCase.nextSuggestedStep = "Diagnose wird vertieft – weitere Informationen sammeln";
  } else if (feedbackType === "defer") {
    agentCase.status = "deferred";
    agentCase.nextSuggestedStep = "Fall zurückgestellt – wird später erneut geprüft";
  }

  // ── Step 15: Translate feedback into a real refined plan ──
  const refinedPlan = _translateFeedbackToRefinedPlan({
    agentCase,
    feedbackType,
    userMessage,
    preferredScope,
    alternativeSuggestion,
  });

  // Attach refined plan to agent case
  agentCase.refinedPlan15 = refinedPlan;

  // ── Step 16: Build action draft when preparation is possible ──
  const actionDraft = _buildActionDraft(agentCase);
  if (actionDraft) {
    agentCase.actionDraft16 = actionDraft;
  }

  // ── Step 17: Assess apply-readiness and build execution proposal ──
  let applyReadiness = null;
  if (actionDraft) {
    applyReadiness = _assessApplyReadiness(agentCase);
    if (applyReadiness) {
      agentCase.applyReadiness17 = applyReadiness;
    }
  }

  // Use the best available cooperative response message
  // Step 16 draft > Step 15 plan (Step 17 data is provided as separate fields)
  const responseText = actionDraft
    ? actionDraft.draftMessage
    : refinedPlan.refinedPlanMessage;

  _agentCaseRegistry.set(agentCaseId, agentCase);

  // Record feedback chat message from user side
  _recordAgentChatMessage({
    agentCaseId,
    agentRole: "user",
    messageType: "feedback_received",
    messageIntent: feedbackType === "approve" || feedbackType === "approve_partial" ? "confirm" : "refine",
    messagePriority: "normal",
    requiresUserDecision: false,
    message: userMessage || feedbackType,
    planPhase: refinedPlan.planPhase,
  });

  // Record agent response using Step 16 draft type when available, Step 15 type otherwise
  _recordAgentChatMessage({
    agentCaseId,
    agentRole: agentCase.agentRole,
    messageType: actionDraft ? "draft_prepared" : (refinedPlan.canPrepareNow ? "preparation_started" : "plan_refined"),
    messageIntent: actionDraft ? "draft" : (refinedPlan.canPrepareNow ? "confirm" : "refine"),
    messagePriority: applyReadiness && applyReadiness.readinessBand === "final_approval_ready" ? "high" : "normal",
    requiresUserDecision: applyReadiness ? applyReadiness.requiresFinalApproval : actionDraft ? actionDraft.requiresFurtherApproval : !refinedPlan.canPrepareNow,
    message: responseText,
    planPhase: actionDraft ? "draft_phase" : applyReadiness ? "approval_phase" : refinedPlan.planPhase,
    controlledPreparationType: refinedPlan.controlledPreparationType,
    // Step 16 additions
    draftType: actionDraft ? actionDraft.draftType : null,
    draftStatus: actionDraft ? actionDraft.draftStatus : null,
    bundleType: actionDraft ? actionDraft.changeCategory : null,
    actionIntent: actionDraft ? "prepare_draft" : applyReadiness ? "execution_proposal" : null,
    nextActionAvailable: applyReadiness ? applyReadiness.eligibleForApply : actionDraft ? !actionDraft.executionBlocked : false,
    // Step 17 additions (only when no draft is available, to preserve draft_phase messagePhase)
    readinessBand: (applyReadiness && !actionDraft) ? applyReadiness.readinessBand : null,
    executionIntent: (applyReadiness && !actionDraft) ? applyReadiness.executionIntent : null,
    applyBlocked: (applyReadiness && !actionDraft) ? applyReadiness.applyBlocked : null,
    recommendedApplyMode: (applyReadiness && !actionDraft) ? applyReadiness.recommendedApplyMode : null,
    nextApprovalAvailable: (applyReadiness && !actionDraft) ? applyReadiness.requiresFinalApproval && applyReadiness.eligibleForApply : false,
  });

  // Step 16 logging
  if (actionDraft) {
    logger.info("[agentBridge] Step 16 – action draft prepared", {
      agentCaseId,
      draftId:                actionDraft.draftId,
      draftType:              actionDraft.draftType,
      draftStatus:            actionDraft.draftStatus,
      changeCategory:         actionDraft.changeCategory,
      preparationOwner:       actionDraft.preparationOwner,
      draftOwner:             actionDraft.draftOwner,
      handoffSuggested:       actionDraft.handoffSuggested,
      handoffReason:          actionDraft.handoffReason,
      needsCrossAgentReview:  actionDraft.needsCrossAgentReview,
      requiresFurtherApproval: actionDraft.requiresFurtherApproval,
      affectedDomain:         actionDraft.affectedTargets.affectedDomain,
      affectedRoutesCount:    actionDraft.affectedTargets.affectedRoutes.length,
      affectedServicesCount:  actionDraft.affectedTargets.affectedServices.length,
      draftVersion:           actionDraft.draftVersion,
      preparedByAgent:        actionDraft.preparedByAgent,
    });
  }

  // Step 17 logging
  if (applyReadiness) {
    logger.info("[agentBridge] Step 17 – apply-readiness assessed", {
      agentCaseId,
      proposalId:             applyReadiness.proposalId,
      readinessScore:         applyReadiness.readinessScore,
      readinessBand:          applyReadiness.readinessBand,
      recommendedApplyMode:   applyReadiness.recommendedApplyMode,
      eligibleForApply:       applyReadiness.eligibleForApply,
      applyBlocked:           applyReadiness.applyBlocked,
      requiresFinalApproval:  applyReadiness.requiresFinalApproval,
      executionOwner:         applyReadiness.executionOwner,
      proposalOwner:          applyReadiness.proposalOwner,
      blockingFactorCount:    applyReadiness.blockingFactors.length,
      openCheckCount:         applyReadiness.openChecks.length,
      riskFlagCount:          applyReadiness.riskFlags.length,
      executionIntent:        applyReadiness.executionIntent,
      handoffSuggested:       applyReadiness.handoffSuggested,
      assessedByAgent:        applyReadiness.assessedByAgent,
    });
  }

  logger.info("[agentBridge] Step 15 – plan refinement applied", {
    agentCaseId,
    feedbackType,
    newStatus:                 agentCase.status,
    planVersion:               agentCase.planVersion,
    approvalScope:             agentCase.approvalScope,
    planPhase:                 refinedPlan.planPhase,
    approvalDecisionStage:     refinedPlan.approvalDecisionStage,
    controlledPreparationType: refinedPlan.controlledPreparationType,
    preparationStatus:         refinedPlan.preparationStatus,
    canPrepareNow:             refinedPlan.canPrepareNow,
    handoffSuggested:          refinedPlan.handoffSuggested,
    needsCrossAgentReview:     refinedPlan.needsCrossAgentReview,
    refinementReason:          refinedPlan.refinementReason,
    hasAlternative:            !!alternativeSuggestion,
  });

  return {
    success:              true,
    agentCaseId,
    feedbackType,
    newStatus:            agentCase.status,
    planVersion:          agentCase.planVersion,
    approvalScope:        agentCase.approvalScope,
    nextSuggestedStep:    agentCase.nextSuggestedStep,
    agentResponse:        responseText,
    // Step 15 additions
    planPhase:                 refinedPlan.planPhase,
    approvalDecisionStage:     refinedPlan.approvalDecisionStage,
    controlledPreparationType: refinedPlan.controlledPreparationType,
    preparationSteps:          refinedPlan.preparationSteps,
    preparationStatus:         refinedPlan.preparationStatus,
    canPrepareNow:             refinedPlan.canPrepareNow,
    handoffSuggested:          refinedPlan.handoffSuggested,
    needsCrossAgentReview:     refinedPlan.needsCrossAgentReview,
    refinementReason:          refinedPlan.refinementReason,
    // Step 16 additions
    hasActionDraft:            !!actionDraft,
    draftType:                 actionDraft ? actionDraft.draftType : null,
    draftStatus:               actionDraft ? actionDraft.draftStatus : null,
    changeCategory:            actionDraft ? actionDraft.changeCategory : null,
    preparationOwner:          actionDraft ? actionDraft.preparationOwner : null,
    affectedTargets:           actionDraft ? actionDraft.affectedTargets : null,
    draftMessage:              actionDraft ? actionDraft.draftMessage : null,
    requiresFurtherApproval:   actionDraft ? actionDraft.requiresFurtherApproval : null,
    executionBlocked:          actionDraft ? actionDraft.executionBlocked : null,
    // Step 17 additions
    hasApplyReadiness:         !!applyReadiness,
    readinessScore:            applyReadiness ? applyReadiness.readinessScore : null,
    readinessBand:             applyReadiness ? applyReadiness.readinessBand : null,
    recommendedApplyMode:      applyReadiness ? applyReadiness.recommendedApplyMode : null,
    eligibleForApply:          applyReadiness ? applyReadiness.eligibleForApply : null,
    applyBlocked:              applyReadiness ? applyReadiness.applyBlocked : null,
    applyBlockedReason:        applyReadiness ? applyReadiness.applyBlockedReason : null,
    executionOwner:            applyReadiness ? applyReadiness.executionOwner : null,
    proposalOwner:             applyReadiness ? applyReadiness.proposalOwner : null,
    executionIntent:           applyReadiness ? applyReadiness.executionIntent : null,
    executionProposalMessage:  applyReadiness ? applyReadiness.executionProposalMessage : null,
  };
}

/**
 * Get a summary of all agent cases, problems, and solutions.
 * Provides overview for the operator including:
 * - total agent cases
 * - cases by role / status / problem type
 * - cases with/without clear fixes
 * - cases needing approval
 * - recent agent cases
 *
 * @returns {Object} agent case summary
 */
function getAgentCaseSummary() {
  const byRole = { deepseek_backend: 0, gemini_frontend: 0 };
  const byStatus = {};
  const byProblemType = {};
  const bySeverity = {};

  let withClearFixes = 0;
  let needsApproval = 0;
  let needsCrossReview = 0;
  let totalConfidence = 0;
  const recentCases = [];

  for (const agentCase of _agentCaseRegistry.values()) {
    // By role
    if (byRole[agentCase.agentRole] !== undefined) {
      byRole[agentCase.agentRole] += 1;
    }

    // By status
    byStatus[agentCase.status] = (byStatus[agentCase.status] || 0) + 1;

    // By problem type
    byProblemType[agentCase.problemType] = (byProblemType[agentCase.problemType] || 0) + 1;

    // By severity
    if (agentCase.issueSeverity) {
      bySeverity[agentCase.issueSeverity] = (bySeverity[agentCase.issueSeverity] || 0) + 1;
    }

    // Counts
    if (agentCase.recommendedFixes && agentCase.recommendedFixes.length > 0) {
      withClearFixes += 1;
    }
    if (agentCase.needsApproval && agentCase.status === "proposed") {
      needsApproval += 1;
    }
    if (agentCase.needsCrossAgentReview) {
      needsCrossReview += 1;
    }
    totalConfidence += agentCase.agentConfidence || 0;

    // Collect recent cases
    recentCases.push({
      agentCaseId:        agentCase.agentCaseId,
      agentRole:          agentCase.agentRole,
      problemType:        agentCase.problemType,
      problemTitle:       agentCase.problemTitle,
      status:             agentCase.status,
      agentConfidence:    agentCase.agentConfidence,
      needsApproval:      agentCase.needsApproval && agentCase.status === "proposed",
      approvalScope:      agentCase.approvalScope,
      fixCount:           (agentCase.recommendedFixes || []).length,
      nextSuggestedStep:  agentCase.nextSuggestedStep,
      createdAt:          agentCase.createdAt,
      updatedAt:          agentCase.updatedAt,
    });
  }

  // Sort recent cases (newest first)
  recentCases.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  const totalCases = _agentCaseRegistry.size;

  return {
    totalAgentCases:        totalCases,
    totalChatMessages:      _agentChatMessages.length,
    casesByRole:            byRole,
    casesByStatus:          byStatus,
    casesByProblemType:     byProblemType,
    casesBySeverity:        bySeverity,
    withClearFixes,
    needsApproval,
    needsCrossAgentReview:  needsCrossReview,
    averageConfidence:      totalCases > 0 ? Math.round((totalConfidence / totalCases) * 100) / 100 : 0,
    recentCases:            recentCases.slice(0, AGENT_CASE_MAX_SUMMARY_ENTRIES),
    generatedAt:            new Date().toISOString(),
  };
}

/**
 * Get agent chat messages, optionally filtered by case.
 *
 * @param {Object} [params]
 * @param {string} [params.agentCaseId] - filter by case
 * @param {string} [params.agentRole] - filter by role
 * @param {number} [params.limit] - max messages to return
 * @returns {Object} chat messages
 */
function getAgentChatMessages({ agentCaseId, agentRole, limit = 50 } = {}) {
  let filtered = [..._agentChatMessages];

  if (agentCaseId) {
    filtered = filtered.filter(m => m.caseId === agentCaseId);
  }
  if (agentRole) {
    filtered = filtered.filter(m => m.agentRole === agentRole);
  }

  // Return newest first, capped
  filtered.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  filtered = filtered.slice(0, Math.min(limit, AGENT_CHAT_MAX_QUERY_LIMIT));

  return {
    totalMessages: _agentChatMessages.length,
    filteredCount: filtered.length,
    messages: filtered,
    generatedAt: new Date().toISOString(),
  };
}

/* ═══════════════════════════════════════════════════════════
   Step 15: Agent Approval / Plan Refinement /
   Controlled Preparation
   ═══════════════════════════════════════════════════════════
   This layer sits on top of Step 14 and transforms
   user feedback into real plan refinement:

     Problem → Solution Proposal → User Feedback
       → Plan Refinement → Controlled Preparation

   Key principles:
   - No automatic productive execution
   - Agent cooperates with user, does not act alone
   - Each feedback type maps to a concrete plan change
   - Controlled preparation types distinguish what the
     agent prepares (never what it executes autonomously)
   ─────────────────────────────────────────────────────── */

/**
 * Derive the controlled preparation type from the agent case
 * scope and feedback type.  This is the central Step 15 mapping:
 *   approvalScope + feedbackType → VALID_CONTROLLED_PREPARATION_TYPES
 *
 * Conservative by design: defaults to "diagnosis_only" when unsure.
 *
 * @param {Object} params
 * @param {string} params.feedbackType
 * @param {string} params.approvalScope
 * @param {boolean} params.needsCrossAgentReview
 * @returns {string} one of VALID_CONTROLLED_PREPARATION_TYPES
 */
function _deriveControlledPreparationType({ feedbackType, approvalScope, needsCrossAgentReview }) {
  if (feedbackType === "reject" || feedbackType === "defer") {
    return "hold";
  }
  if (feedbackType === "request_more_info") {
    return "diagnosis_only";
  }
  if (needsCrossAgentReview && feedbackType !== "reject" && feedbackType !== "defer") {
    return "cross_agent_review";
  }
  if (feedbackType === "approve") {
    if (approvalScope === "backend_only")    return "backend_prepare";
    if (approvalScope === "frontend_only")   return "frontend_prepare";
    if (approvalScope === "diagnosis_only")  return "diagnosis_only";
    if (approvalScope === "partial_fix")     return "partial_fix_prepare";
    if (approvalScope === "full_fix")        return "full_preparation";
    return "full_preparation";
  }
  if (feedbackType === "approve_partial") {
    if (approvalScope === "backend_only")    return "backend_prepare";
    if (approvalScope === "frontend_only")   return "frontend_prepare";
    if (approvalScope === "diagnosis_only")  return "diagnosis_only";
    return "partial_fix_prepare";
  }
  if (feedbackType === "narrow_scope") {
    if (approvalScope === "backend_only")    return "backend_prepare";
    if (approvalScope === "frontend_only")   return "frontend_prepare";
    if (approvalScope === "diagnosis_only")  return "diagnosis_only";
    return "partial_fix_prepare";
  }
  // modify / suggest_alternative → still refining, not yet preparing
  return "diagnosis_only";
}

/**
 * Derive the approval decision stage from the agent case status
 * and scope.  This is richer than a boolean approved/not-approved.
 *
 * @param {Object} params
 * @param {string} params.status          - current agent case status
 * @param {string} params.approvalScope   - current approval scope
 * @param {boolean} params.needsCrossAgentReview
 * @returns {string} one of VALID_APPROVAL_DECISION_STAGES
 */
function _deriveApprovalDecisionStage({ status, approvalScope, needsCrossAgentReview }) {
  if (status === "proposed")             return "awaiting_decision";
  if (status === "rejected")             return "rejected";
  if (status === "deferred")             return "deferred";
  if (status === "refinement_requested") return "refinement_in_progress";
  if (status === "info_requested")       return "approved_diagnosis_only";
  if (status === "scope_narrowed") {
    if (approvalScope === "backend_only")   return "approved_backend_only";
    if (approvalScope === "frontend_only")  return "approved_frontend_only";
    if (approvalScope === "diagnosis_only") return "approved_diagnosis_only";
    return "approved_partial";
  }
  if (status === "partially_approved") {
    if (approvalScope === "backend_only")   return "approved_backend_only";
    if (approvalScope === "frontend_only")  return "approved_frontend_only";
    if (approvalScope === "diagnosis_only") return "approved_diagnosis_only";
    return "approved_partial";
  }
  if (status === "approved") {
    if (needsCrossAgentReview)            return "cross_agent_pending";
    if (approvalScope === "backend_only")   return "approved_backend_only";
    if (approvalScope === "frontend_only")  return "approved_frontend_only";
    if (approvalScope === "diagnosis_only") return "approved_diagnosis_only";
    if (approvalScope === "partial_fix")    return "approved_partial";
    return "approved_full";
  }
  return "awaiting_decision";
}

/**
 * Derive the current plan phase from the agent case status.
 *
 * @param {string} status - agent case status
 * @returns {string} one of VALID_PLAN_PHASES
 */
function _derivePlanPhase(status) {
  switch (status) {
    case "proposed":             return "solution_phase";
    case "refinement_requested": return "refinement_phase";
    case "scope_narrowed":       return "feedback_phase";
    case "info_requested":       return "feedback_phase";
    case "partially_approved":   return "preparation_phase";
    case "approved":             return "preparation_phase";
    case "rejected":             return "hold_phase";
    case "deferred":             return "hold_phase";
    default:                     return "problem_phase";
  }
}

/**
 * Build the concrete preparation steps for the refined plan.
 * These are human-readable action items that describe what
 * the agent would prepare – no auto-execution.
 *
 * @param {Object} params
 * @param {string} params.controlledPreparationType
 * @param {string} params.agentRole
 * @param {string[]} params.recommendedFixes
 * @param {string[]} params.changeTargets
 * @param {string} params.problemType
 * @returns {string[]} ordered preparation steps
 */
function _buildPreparationSteps({
  controlledPreparationType,
  agentRole,
  recommendedFixes,
  changeTargets,
  problemType,
}) {
  const isBackend = agentRole === "deepseek_backend";
  const steps = [];

  switch (controlledPreparationType) {
    case "diagnosis_only":
      steps.push("Ursache vollständig dokumentieren");
      steps.push("Betroffene Codestellen identifizieren");
      steps.push("Auswirkungsanalyse erstellen");
      break;
    case "backend_prepare":
      steps.push("Backend-Änderungsumfang festlegen");
      if (recommendedFixes.length > 0) {
        steps.push(`Geplante Maßnahme: ${recommendedFixes[0]}`);
      }
      if (changeTargets.length > 0) {
        steps.push(`Betroffene Komponenten: ${changeTargets.slice(0, 3).join(", ")}`);
      }
      steps.push("Vorbereitung prüfen – keine automatische Ausführung");
      break;
    case "frontend_prepare":
      steps.push("Frontend-Änderungsumfang festlegen");
      if (recommendedFixes.length > 0) {
        steps.push(`Geplante Maßnahme: ${recommendedFixes[0]}`);
      }
      steps.push("UI-Auswirkung prüfen");
      steps.push("Vorbereitung prüfen – keine automatische Ausführung");
      break;
    case "partial_fix_prepare":
      steps.push("Teilumfang klären und eingrenzen");
      if (recommendedFixes.length > 0) {
        steps.push(`Eingegrenzter Fix: ${recommendedFixes[0]}`);
      }
      steps.push("Auswirkung auf angrenzende Bereiche prüfen");
      steps.push("Vorbereitung prüfen – keine automatische Ausführung");
      break;
    case "cross_agent_review":
      steps.push("DeepSeek-Backend-Analyse vorbereiten");
      steps.push("Gemini-Frontend-Analyse vorbereiten");
      steps.push("Schichtübergreifende Auswirkungen dokumentieren");
      steps.push("Cross-Agent-Zusammenfassung erstellen");
      break;
    case "full_preparation":
      steps.push("Backend-Änderungsumfang festlegen");
      steps.push("Frontend-Änderungsumfang festlegen");
      if (recommendedFixes.length > 0) {
        steps.push(`Geplante Maßnahmen: ${recommendedFixes.slice(0, 2).join("; ")}`);
      }
      steps.push("Vollständige Auswirkungsanalyse erstellen");
      steps.push("Vorbereitung prüfen – keine automatische Ausführung");
      break;
    case "hold":
    default:
      steps.push("Fall zurückgestellt – keine Vorbereitung");
      steps.push("Auf neue Richtung warten");
      break;
  }

  return steps.slice(0, PLAN_REFINEMENT_MAX_STEPS);
}

/**
 * Build a cooperative, agent-style response message for
 * plan refinement.  This is the Step 15 equivalent of
 * _buildAgentChatMessage() for the refinement phase.
 *
 * Language is deliberately cooperative and first-person.
 *
 * @param {Object} params
 * @param {string} params.feedbackType
 * @param {string} params.controlledPreparationType
 * @param {string} params.agentRole
 * @param {string} params.approvalScope
 * @param {string} params.refinementReason
 * @param {string} [params.alternativeSuggestion]
 * @param {string} [params.userMessage]
 * @returns {string} German cooperative agent message
 */
function _buildRefinedPlanMessage({
  feedbackType,
  controlledPreparationType,
  agentRole,
  approvalScope,
  refinementReason,
  alternativeSuggestion = null,
  userMessage = null,
}) {
  const agentLabel = agentRole === "deepseek_backend" ? "Backend-Analyse" : "Frontend-Analyse";
  const parts = [];

  // Acknowledge user input
  if (userMessage) {
    parts.push(`Ich habe deinen Hinweis berücksichtigt.`);
  }

  // Describe what the agent now plans to do
  switch (feedbackType) {
    case "approve":
      if (controlledPreparationType === "full_preparation") {
        parts.push("Ich bereite jetzt die vollständige Lösung vor.");
      } else if (controlledPreparationType === "backend_prepare") {
        parts.push("Ich bereite nur den Backend-Teil vor.");
      } else if (controlledPreparationType === "frontend_prepare") {
        parts.push("Ich bereite nur den Frontend-Teil vor.");
      } else if (controlledPreparationType === "diagnosis_only") {
        parts.push("Ich vertiefe zuerst die Ursache, bevor ich einen Fix vorbereite.");
      } else if (controlledPreparationType === "cross_agent_review") {
        parts.push("Ich koordiniere mit dem anderen Agenten, bevor wir weitermachen.");
      } else {
        parts.push("Ich starte die kontrollierte Vorbereitung.");
      }
      break;
    case "approve_partial":
      parts.push(`Ich habe den Plan auf den Bereich „${approvalScope}" eingegrenzt.`);
      if (controlledPreparationType === "backend_prepare") {
        parts.push("Ich bereite nur den Backend-Teil vor.");
      } else if (controlledPreparationType === "frontend_prepare") {
        parts.push("Ich bereite nur den Frontend-Teil vor.");
      } else {
        parts.push("Ich bereite den freigegebenen Teilbereich vor.");
      }
      break;
    case "narrow_scope":
      parts.push(`Ich würde den Plan so eingrenzen: nur ${approvalScope.replace(/_/g, " ")}.`);
      if (controlledPreparationType === "backend_prepare") {
        parts.push("Ich konzentriere mich auf den Backend-Teil.");
      } else if (controlledPreparationType === "frontend_prepare") {
        parts.push("Ich konzentriere mich auf den Frontend-Teil.");
      } else if (controlledPreparationType === "diagnosis_only") {
        parts.push("Ich vertiefe zuerst die Diagnose.");
      }
      break;
    case "modify":
      parts.push("Ich passe den Vorschlag entsprechend an.");
      if (alternativeSuggestion) {
        parts.push(`Ich habe deinen Vorschlag übernommen: „${alternativeSuggestion}".`);
      }
      parts.push("Der angepasste Plan liegt zur Prüfung bereit.");
      break;
    case "suggest_alternative":
      if (alternativeSuggestion) {
        parts.push(`Ich habe deinen Alternativvorschlag übernommen: „${alternativeSuggestion}".`);
      } else {
        parts.push("Ich baue auf deinem Alternativvorschlag auf.");
      }
      parts.push("Ich passe den Plan auf dieser Basis an.");
      break;
    case "request_more_info":
      parts.push("Ich vertiefe zuerst die Ursache.");
      parts.push("Ich sammle weitere Informationen, bevor ich einen Fix vorbereite.");
      break;
    case "defer":
      parts.push("Ich stelle den Fall zurück.");
      parts.push("Ich warte auf eine neue Richtung, bevor ich weitermache.");
      break;
    case "reject":
      parts.push("Ich halte den Vorschlag zurück.");
      parts.push("Sobald du eine neue Richtung gibst, passe ich den Plan an.");
      break;
    default:
      parts.push("Ich habe das Feedback berücksichtigt.");
  }

  // Add refinement reason if available
  if (refinementReason) {
    parts.push(`Grund: ${refinementReason}`);
  }

  // Close with cooperative question for actionable states
  if (!["reject", "defer"].includes(feedbackType)) {
    parts.push("Soll ich auf dieser Basis weitermachen?");
  }

  return parts.join(" ");
}

/**
 * Translate user feedback into a concrete refined plan object.
 * This is the core Step 15 transformation:
 *   feedbackType + agentCase → refinedPlan object
 *
 * The refined plan is attached to the agent case and carries
 * all information needed to describe what the agent now proposes
 * to prepare (without executing anything).
 *
 * @param {Object} params
 * @param {Object} params.agentCase        - current agent case
 * @param {string} params.feedbackType     - user feedback type
 * @param {string|null} params.userMessage
 * @param {string|null} params.preferredScope
 * @param {string|null} params.alternativeSuggestion
 * @returns {Object} refined plan object
 */
function _translateFeedbackToRefinedPlan({
  agentCase,
  feedbackType,
  userMessage,
  preferredScope,
  alternativeSuggestion,
}) {
  const effectiveScope = (preferredScope && VALID_APPROVAL_SCOPES.includes(preferredScope))
    ? preferredScope
    : (agentCase.approvalScope && VALID_APPROVAL_SCOPES.includes(agentCase.approvalScope))
      ? agentCase.approvalScope
      : "diagnosis_only";

  const controlledPreparationType = _deriveControlledPreparationType({
    feedbackType,
    approvalScope: effectiveScope,
    needsCrossAgentReview: agentCase.needsCrossAgentReview,
  });

  // Derive what changed and why
  const refinementReason = _buildRefinementReason({ feedbackType, alternativeSuggestion, preferredScope });

  // Build the preparation steps
  const preparationSteps = _buildPreparationSteps({
    controlledPreparationType,
    agentRole: agentCase.agentRole,
    recommendedFixes: alternativeSuggestion
      ? [alternativeSuggestion]
      : (agentCase.recommendedFixes || []),
    changeTargets: agentCase.changeTargets || [],
    problemType: agentCase.problemType,
  });

  // Determine if the agent can now prepare (needs actionable approval)
  const canPrepareNow = [
    "approve", "approve_partial", "narrow_scope",
  ].includes(feedbackType) && controlledPreparationType !== "hold";

  // Build cooperative agent message for this refinement step
  const refinedPlanMessage = _buildRefinedPlanMessage({
    feedbackType,
    controlledPreparationType,
    agentRole: agentCase.agentRole,
    approvalScope: effectiveScope,
    refinementReason,
    alternativeSuggestion,
    userMessage,
  });

  // Determine secondary agent and handoff needs
  const secondaryAgent = agentCase.agentRole === "deepseek_backend"
    ? "gemini_frontend"
    : "deepseek_backend";

  const handoffSuggested = controlledPreparationType === "cross_agent_review" ||
    controlledPreparationType === "full_preparation";

  const handoffReason = handoffSuggested
    ? (controlledPreparationType === "full_preparation"
      ? "Vollständige Vorbereitung erfordert beide Agenten"
      : "Schichtübergreifendes Problem erfordert Cross-Agent-Prüfung")
    : null;

  return {
    planVersion:            agentCase.planVersion,
    planPhase:              _derivePlanPhase(agentCase.status),
    refinedPlan:            alternativeSuggestion || agentCase.proposedActionBundle || null,
    refinementReason,
    userDecision:           feedbackType,
    decisionSnapshot:       {
      feedbackType,
      preferredScope:       preferredScope || null,
      userMessage:          userMessage || null,
      alternativeSuggestion: alternativeSuggestion || null,
      decidedAt:            new Date().toISOString(),
    },
    approvedScope:          effectiveScope,
    narrowedScope:          (feedbackType === "narrow_scope" || feedbackType === "approve_partial")
      ? effectiveScope
      : null,
    controlledPreparationType,
    preparationSteps,
    preparationStatus:      canPrepareNow ? "ready_to_prepare" : "not_ready",
    canPrepareNow,

    // Agent message for this refinement
    refinedPlanMessage,

    // Cross-agent coordination
    ownerAgent:             agentCase.agentRole,
    secondaryAgent,
    handoffSuggested,
    handoffReason,
    needsCrossAgentReview:  agentCase.needsCrossAgentReview,

    // Approval decision stage
    approvalDecisionStage:  _deriveApprovalDecisionStage({
      status: agentCase.status,
      approvalScope: effectiveScope,
      needsCrossAgentReview: agentCase.needsCrossAgentReview,
    }),

    refinedAt:              new Date().toISOString(),
  };
}

/**
 * Build a human-readable reason string for a plan refinement.
 *
 * @param {Object} params
 * @returns {string} German reason label
 */
function _buildRefinementReason({ feedbackType, alternativeSuggestion, preferredScope }) {
  switch (feedbackType) {
    case "approve":         return "Vollständige Freigabe erteilt";
    case "approve_partial": return `Teilfreigabe erteilt${preferredScope ? ` (${preferredScope})` : ""}`;
    case "narrow_scope":    return `Scope eingegrenzt auf: ${preferredScope || "unbekannt"}`;
    case "modify":          return alternativeSuggestion
      ? `Vorschlag angepasst: ${alternativeSuggestion}`
      : "Anpassung angefordert";
    case "suggest_alternative": return alternativeSuggestion
      ? `Alternativvorschlag übernommen: ${alternativeSuggestion}`
      : "Alternativer Ansatz angefordert";
    case "request_more_info": return "Diagnose-Vertiefung angefordert";
    case "defer":           return "Fall zurückgestellt";
    case "reject":          return "Vorschlag abgelehnt";
    default:                return "Feedback verarbeitet";
  }
}

/**
 * Get a summary of all agent cases with Step 15 plan refinement
 * and preparation statistics.
 *
 * Extends the Step 14 getAgentCaseSummary() with:
 * - preparation type distribution
 * - approval decision stage distribution
 * - plan phase distribution
 * - cases ready to prepare
 * - cross-agent coordination counts
 * - refined plan count
 *
 * @returns {Object} plan refinement summary
 */
function getRefinedPlanSummary() {
  const byPreparationType = {};
  const byApprovalDecisionStage = {};
  const byPlanPhase = {};
  const byCrossAgentStatus = { needsCrossAgentReview: 0, handoffSuggested: 0 };

  let readyToPrepare = 0;
  let withRefinedPlan = 0;
  let diagnosisOnly = 0;
  let awaitingDecision = 0;

  const refinedCases = [];

  for (const agentCase of _agentCaseRegistry.values()) {
    const refinedPlan = agentCase.refinedPlan15 || null;

    // Approval decision stage
    const decisionStage = refinedPlan
      ? refinedPlan.approvalDecisionStage
      : _deriveApprovalDecisionStage({
        status: agentCase.status,
        approvalScope: agentCase.approvalScope,
        needsCrossAgentReview: agentCase.needsCrossAgentReview,
      });
    byApprovalDecisionStage[decisionStage] = (byApprovalDecisionStage[decisionStage] || 0) + 1;

    // Plan phase
    const planPhase = refinedPlan
      ? refinedPlan.planPhase
      : _derivePlanPhase(agentCase.status);
    byPlanPhase[planPhase] = (byPlanPhase[planPhase] || 0) + 1;

    // Preparation type
    const prepType = refinedPlan
      ? refinedPlan.controlledPreparationType
      : null;
    if (prepType) {
      byPreparationType[prepType] = (byPreparationType[prepType] || 0) + 1;
    }

    // Cross-agent
    if (agentCase.needsCrossAgentReview) {
      byCrossAgentStatus.needsCrossAgentReview += 1;
    }
    if (refinedPlan && refinedPlan.handoffSuggested) {
      byCrossAgentStatus.handoffSuggested += 1;
    }

    // Counts
    if (refinedPlan && refinedPlan.canPrepareNow) {
      readyToPrepare += 1;
    }
    if (refinedPlan) {
      withRefinedPlan += 1;
    }
    if (prepType === "diagnosis_only") {
      diagnosisOnly += 1;
    }
    if (decisionStage === "awaiting_decision") {
      awaitingDecision += 1;
    }

    refinedCases.push({
      agentCaseId:            agentCase.agentCaseId,
      agentRole:              agentCase.agentRole,
      problemType:            agentCase.problemType,
      problemTitle:           agentCase.problemTitle,
      status:                 agentCase.status,
      planPhase,
      approvalDecisionStage:  decisionStage,
      controlledPreparationType: prepType || null,
      preparationStatus:      refinedPlan ? refinedPlan.preparationStatus : "not_started",
      canPrepareNow:          refinedPlan ? refinedPlan.canPrepareNow : false,
      hasRefinedPlan:         !!refinedPlan,
      planVersion:            agentCase.planVersion,
      needsCrossAgentReview:  agentCase.needsCrossAgentReview,
      handoffSuggested:       refinedPlan ? refinedPlan.handoffSuggested : false,
      ownerAgent:             agentCase.agentRole,
      secondaryAgent:         agentCase.agentRole === "deepseek_backend" ? "gemini_frontend" : "deepseek_backend",
      updatedAt:              agentCase.updatedAt,
    });
  }

  refinedCases.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));

  return {
    totalAgentCases:          _agentCaseRegistry.size,
    withRefinedPlan,
    readyToPrepare,
    awaitingDecision,
    diagnosisOnly,
    byPreparationType,
    byApprovalDecisionStage,
    byPlanPhase,
    crossAgentStatus:         byCrossAgentStatus,
    refinedCases:             refinedCases.slice(0, REFINED_PLAN_SUMMARY_MAX_ENTRIES),
    generatedAt:              new Date().toISOString(),
  };
}

/* ═══════════════════════════════════════════════════════════
   Step 16: Controlled Action Draft / Fix Bundle Preparation
   ═══════════════════════════════════════════════════════════
   This layer sits on top of Steps 14+15 and translates
   approved / refined plans into concrete, controlled
   solution drafts (Action Drafts / Fix Bundles).

     Problem → Solution Proposal → User Feedback
       → Plan Refinement → Controlled Preparation
       → **Action Draft / Fix Bundle**

   Key principles:
   - Drafts are PREPARED, never executed autonomously
   - Every draft requires explicit user approval
   - DeepSeek owns backend/API/data drafts
   - Gemini owns frontend/UX/presentation drafts
   - Cross-agent drafts carry handoff metadata
   ─────────────────────────────────────────────────────── */

/**
 * Derive the draft type from the controlled preparation type
 * and agent role.  This maps the Step 15 preparation intent
 * into a concrete Step 16 draft type.
 *
 * @param {Object} params
 * @param {string} params.controlledPreparationType
 * @param {string} params.agentRole
 * @param {string} params.problemType
 * @returns {string} one of VALID_DRAFT_TYPES
 */
function _deriveDraftType({ controlledPreparationType, agentRole, problemType }) {
  const isBackend = agentRole === "deepseek_backend";

  switch (controlledPreparationType) {
    case "diagnosis_only":
      return "diagnosis_draft";
    case "backend_prepare":
      if (problemType === "api_issue" || problemType === "contract_mismatch") return "data_contract_draft";
      if (problemType === "mapping_error" || problemType === "binding_error") return "mapping_fix_draft";
      if (problemType === "route_issue") return "route_hardening_draft";
      return "backend_fix_draft";
    case "frontend_prepare":
      if (problemType === "presentation_issue" || problemType === "labeling_error") return "ui_clarity_draft";
      return "frontend_fix_draft";
    case "partial_fix_prepare":
      return "partial_fix_draft";
    case "cross_agent_review":
      return "cross_agent_draft";
    case "full_preparation":
      return isBackend ? "backend_fix_draft" : "frontend_fix_draft";
    case "hold":
    default:
      return "diagnosis_draft";
  }
}

/**
 * Derive the change category from the draft type and problem type.
 *
 * @param {Object} params
 * @param {string} params.draftType
 * @param {string} params.problemType
 * @param {string} params.agentRole
 * @returns {string} one of VALID_CHANGE_CATEGORIES
 */
function _deriveChangeCategory({ draftType, problemType, agentRole }) {
  switch (draftType) {
    case "diagnosis_draft":       return "diagnosis_extension";
    case "backend_fix_draft":     return "backend_logic";
    case "frontend_fix_draft":    return "frontend_structure";
    case "data_contract_draft":   return "api_contract";
    case "mapping_fix_draft":     return "data_mapping";
    case "route_hardening_draft": return "route_hardening";
    case "config_check_draft":    return "ops_check";
    case "ui_clarity_draft":      return "ui_clarity";
    case "cross_agent_draft":     return "cross_layer_coordination";
    case "partial_fix_draft": {
      if (agentRole === "deepseek_backend") return "backend_logic";
      if (agentRole === "gemini_frontend")  return "frontend_structure";
      return "backend_logic";
    }
    default:
      return "diagnosis_extension";
  }
}

/**
 * Derive structured affected targets from the agent case.
 * Conservative: only includes what is reasonably derivable.
 *
 * @param {Object} params
 * @param {Object} params.agentCase
 * @param {string} params.draftType
 * @param {string} params.changeCategory
 * @returns {Object} structured affected targets
 */
function _deriveAffectedTargets({ agentCase, draftType, changeCategory }) {
  const targets = {
    affectedDomain:     agentCase.affectedDomain || (agentCase.agentRole === "deepseek_backend" ? "backend" : "frontend"),
    affectedServices:   [],
    affectedRoutes:     [],
    affectedFiles:      [],
    affectedTables:     [],
    affectedComponents: [],
  };

  // Pull from change targets (Step 14)
  const ct = agentCase.changeTargets || [];
  for (const t of ct) {
    const lower = (t || "").toLowerCase();
    if (lower.includes("route") || lower.includes("/api/")) {
      targets.affectedRoutes.push(t);
    } else if (lower.includes("service") || lower.includes("Service")) {
      targets.affectedServices.push(t);
    } else if (lower.includes("table") || lower.includes("schema") || lower.includes("model")) {
      targets.affectedTables.push(t);
    } else if (lower.includes("component") || lower.includes("view") || lower.includes("page")) {
      targets.affectedComponents.push(t);
    } else {
      // Default: treat as file reference
      targets.affectedFiles.push(t);
    }
  }

  // Enrich based on change category
  if (changeCategory === "api_contract" && targets.affectedRoutes.length === 0) {
    targets.affectedRoutes.push("(API-Vertrag – Routen prüfen)");
  }
  if (changeCategory === "data_mapping" && targets.affectedServices.length === 0) {
    targets.affectedServices.push("(Mapping-Service prüfen)");
  }

  return targets;
}

/**
 * Determine preparation ownership for the draft.
 *
 * Ownership rules:
 * - `draftOwner` is always the agent that initiated the case
 *   (tracks origin for audit purposes).
 * - `preparationOwner` may differ when the draft domain
 *   does not match the initiating agent:
 *   - Backend drafts from gemini_frontend → preparationOwner = deepseek_backend
 *   - Frontend drafts from deepseek_backend → preparationOwner = gemini_frontend
 *   - Cross-agent drafts → both agents coordinate (handoff suggested)
 * - `secondaryAgent` is the other agent (for potential review).
 *
 * @param {Object} params
 * @param {string} params.draftType   - one of VALID_DRAFT_TYPES
 * @param {string} params.agentRole   - the initiating agent role
 * @returns {Object} ownership metadata with:
 *   preparationOwner, draftOwner, secondaryAgent,
 *   handoffSuggested, handoffReason, needsCrossAgentReview
 */
function _derivePreparationOwnership({ draftType, agentRole }) {
  const isBackendDraft = [
    "backend_fix_draft", "data_contract_draft", "mapping_fix_draft",
    "route_hardening_draft", "config_check_draft",
  ].includes(draftType);

  const isFrontendDraft = [
    "frontend_fix_draft", "ui_clarity_draft",
  ].includes(draftType);

  const isCrossDraft = draftType === "cross_agent_draft";

  let preparationOwner = agentRole;
  let draftOwner = agentRole;
  let secondaryAgent = agentRole === "deepseek_backend" ? "gemini_frontend" : "deepseek_backend";
  let handoffSuggested = false;
  let handoffReason = null;
  let needsCrossAgentReview = false;

  if (isCrossDraft) {
    needsCrossAgentReview = true;
    handoffSuggested = true;
    handoffReason = "Schichtübergreifender Draft erfordert Abstimmung beider Agenten";
  } else if (isBackendDraft && agentRole === "gemini_frontend") {
    handoffSuggested = true;
    handoffReason = "Backend-Draft – DeepSeek sollte die Federführung übernehmen";
    preparationOwner = "deepseek_backend";
  } else if (isFrontendDraft && agentRole === "deepseek_backend") {
    handoffSuggested = true;
    handoffReason = "Frontend-Draft – Gemini sollte die Federführung übernehmen";
    preparationOwner = "gemini_frontend";
  }

  return {
    preparationOwner,
    draftOwner,
    secondaryAgent,
    handoffSuggested,
    handoffReason,
    needsCrossAgentReview,
  };
}

/**
 * Build a human-readable, cooperative German message for
 * the action draft.  This is the Step 16 equivalent of
 * _buildRefinedPlanMessage() for the draft phase.
 *
 * @param {Object} params
 * @returns {string} German cooperative agent message
 */
function _buildActionDraftMessage({
  draftType,
  changeCategory,
  agentRole,
  affectedTargets,
  preparationOwner,
  handoffSuggested,
  draftSummary,
  requiresFurtherApproval,
}) {
  const parts = [];

  // Draft type announcement
  const draftLabels = {
    diagnosis_draft:       "einen vertieften Diagnose-Entwurf",
    backend_fix_draft:     "einen eingegrenzten Backend-Entwurf",
    frontend_fix_draft:    "einen Frontend-Entwurf für die Darstellungsanpassung",
    partial_fix_draft:     "einen eingegrenzten Teilfix-Entwurf",
    cross_agent_draft:     "einen Cross-Agent-Entwurf",
    data_contract_draft:   "einen Entwurf für die API-/Vertragsanpassung",
    mapping_fix_draft:     "einen Entwurf für die Daten-Zuordnungskorrektur",
    route_hardening_draft: "einen Entwurf zur API-Härtung",
    config_check_draft:    "einen Konfigurationsprüfungs-Entwurf",
    ui_clarity_draft:      "einen Entwurf für die UI-Verbesserung",
  };
  const draftLabel = draftLabels[draftType] || "einen Lösungsentwurf";
  parts.push(`Ich habe ${draftLabel} vorbereitet.`);

  // Change category
  const categoryLabels = {
    backend_logic:            "Backend-Logik",
    api_contract:             "API-Vertrag",
    data_mapping:             "Daten-Zuordnung",
    frontend_structure:       "Frontend-Struktur",
    ui_clarity:               "UI-Klarheit",
    ops_check:                "Konfigurationsprüfung",
    schema_alignment:         "Schema-Abgleich",
    diagnosis_extension:      "Diagnose-Vertiefung",
    route_hardening:          "Routen-Härtung",
    cross_layer_coordination: "Schichtübergreifend",
  };
  const catLabel = categoryLabels[changeCategory] || changeCategory;
  parts.push(`Der Schwerpunkt liegt auf: ${catLabel}.`);

  // Affected areas (show max 2, indicate remaining count)
  const areas = [];
  if (affectedTargets.affectedRoutes && affectedTargets.affectedRoutes.length > 0) {
    const shown = affectedTargets.affectedRoutes.slice(0, 2).join(", ");
    const remaining = affectedTargets.affectedRoutes.length - 2;
    areas.push(`Routen: ${shown}${remaining > 0 ? ` und ${remaining} weitere` : ""}`);
  }
  if (affectedTargets.affectedServices && affectedTargets.affectedServices.length > 0) {
    const shown = affectedTargets.affectedServices.slice(0, 2).join(", ");
    const remaining = affectedTargets.affectedServices.length - 2;
    areas.push(`Services: ${shown}${remaining > 0 ? ` und ${remaining} weitere` : ""}`);
  }
  if (affectedTargets.affectedComponents && affectedTargets.affectedComponents.length > 0) {
    const shown = affectedTargets.affectedComponents.slice(0, 2).join(", ");
    const remaining = affectedTargets.affectedComponents.length - 2;
    areas.push(`Komponenten: ${shown}${remaining > 0 ? ` und ${remaining} weitere` : ""}`);
  }
  if (areas.length > 0) {
    parts.push(`Diese Bereiche wären betroffen: ${areas.join("; ")}.`);
  }

  // Summary
  if (draftSummary) {
    parts.push(draftSummary);
  }

  // Handoff
  if (handoffSuggested) {
    const ownerLabel = preparationOwner === "deepseek_backend" ? "DeepSeek (Backend)" : "Gemini (Frontend)";
    parts.push(`Ich habe den Fall in einen Cross-Agent-Entwurf überführt – ${ownerLabel} sollte die Federführung übernehmen.`);
  }

  // Approval notice
  if (requiresFurtherApproval) {
    parts.push("Ich brauche dafür noch deine Bestätigung.");
  } else {
    parts.push("Auf dieser Basis kann ich den nächsten kontrollierten Schritt vorbereiten.");
  }

  return parts.join(" ");
}

/**
 * Build a concrete action draft from an approved / refined agent case.
 * This is the central Step 16 function.
 *
 * @param {Object} params
 * @param {Object} params.agentCase - the agent case with refinedPlan15
 * @returns {Object|null} action draft or null if not ready
 */
function _buildActionDraft(agentCase) {
  if (!agentCase) return null;

  const refinedPlan = agentCase.refinedPlan15;
  if (!refinedPlan) return null;

  // Only build drafts when preparation is allowed
  if (!refinedPlan.canPrepareNow && refinedPlan.controlledPreparationType === "hold") {
    return null;
  }

  const draftType = _deriveDraftType({
    controlledPreparationType: refinedPlan.controlledPreparationType,
    agentRole: agentCase.agentRole,
    problemType: agentCase.problemType,
  });

  const changeCategory = _deriveChangeCategory({
    draftType,
    problemType: agentCase.problemType,
    agentRole: agentCase.agentRole,
  });

  const affectedTargets = _deriveAffectedTargets({
    agentCase,
    draftType,
    changeCategory,
  });

  const ownership = _derivePreparationOwnership({
    draftType,
    agentRole: agentCase.agentRole,
  });

  const requiresFurtherApproval = !refinedPlan.canPrepareNow ||
    draftType === "cross_agent_draft" ||
    refinedPlan.approvalDecisionStage === "refinement_in_progress";

  // Build summary text
  const fixText = (agentCase.recommendedFixes || []).slice(0, 2).join("; ");
  const draftSummary = fixText
    ? `Geplante Maßnahme: ${fixText}.`
    : null;

  const draftMessage = _buildActionDraftMessage({
    draftType,
    changeCategory,
    agentRole: agentCase.agentRole,
    affectedTargets,
    preparationOwner: ownership.preparationOwner,
    handoffSuggested: ownership.handoffSuggested,
    draftSummary,
    requiresFurtherApproval,
  });

  const actionDraft = {
    draftId:                `draft-${Date.now()}-${agentCase.agentCaseId}`,
    agentCaseId:            agentCase.agentCaseId,
    draftVersion:           agentCase.planVersion || 1,
    draftType,
    draftStatus:            "prepared",
    changeCategory,
    draftSummary:           draftSummary || `${draftType.replace(/_/g, " ")} vorbereitet`,
    draftReason:            refinedPlan.refinementReason || "Plan-Verfeinerung abgeschlossen",

    // Affected targets
    affectedTargets,

    // Ownership
    preparationOwner:       ownership.preparationOwner,
    draftOwner:             ownership.draftOwner,
    secondaryAgent:         ownership.secondaryAgent,
    handoffSuggested:       ownership.handoffSuggested,
    handoffReason:          ownership.handoffReason,
    needsCrossAgentReview:  ownership.needsCrossAgentReview,

    // Execution control
    requiresFurtherApproval,
    executionBlocked:       true,  // Always blocked until explicit release

    // Human-readable draft message
    draftMessage,

    // Context from refined plan
    planVersion:            agentCase.planVersion,
    approvalDecisionStage:  refinedPlan.approvalDecisionStage,
    controlledPreparationType: refinedPlan.controlledPreparationType,
    preparationSteps:       refinedPlan.preparationSteps || [],

    // Lifecycle
    preparedAt:             new Date().toISOString(),
    preparedByAgent:        agentCase.agentRole,
  };

  return actionDraft;
}

/**
 * Get a summary of all action drafts / fix bundles across agent cases.
 * Provides the operator a clear view of:
 * - how many cases have drafts
 * - draft type distribution
 * - change category distribution
 * - affected domains
 * - drafts awaiting further approval
 * - handoff / cross-agent status
 *
 * @returns {Object} action draft summary
 */
function getActionDraftSummary() {
  const byDraftType = {};
  const byChangeCategory = {};
  const byDraftStatus = {};
  const byPreparationOwner = { deepseek_backend: 0, gemini_frontend: 0 };
  const byAffectedDomain = {};

  let totalWithDraft = 0;
  let totalDiagnosisOnly = 0;
  let totalAwaitingApproval = 0;
  let totalHandoffSuggested = 0;
  let totalCrossAgentDrafts = 0;
  let totalBackendDrafts = 0;
  let totalFrontendDrafts = 0;

  const draftCases = [];

  for (const agentCase of _agentCaseRegistry.values()) {
    const draft = agentCase.actionDraft16 || null;
    if (!draft) continue;

    totalWithDraft += 1;

    // By draft type
    byDraftType[draft.draftType] = (byDraftType[draft.draftType] || 0) + 1;

    // By change category
    byChangeCategory[draft.changeCategory] = (byChangeCategory[draft.changeCategory] || 0) + 1;

    // By draft status
    byDraftStatus[draft.draftStatus] = (byDraftStatus[draft.draftStatus] || 0) + 1;

    // By preparation owner
    if (byPreparationOwner[draft.preparationOwner] !== undefined) {
      byPreparationOwner[draft.preparationOwner] += 1;
    }

    // By affected domain
    const domain = draft.affectedTargets ? draft.affectedTargets.affectedDomain : "unknown";
    byAffectedDomain[domain] = (byAffectedDomain[domain] || 0) + 1;

    // Counts
    if (draft.draftType === "diagnosis_draft") totalDiagnosisOnly += 1;
    if (draft.requiresFurtherApproval) totalAwaitingApproval += 1;
    if (draft.handoffSuggested) totalHandoffSuggested += 1;
    if (draft.draftType === "cross_agent_draft") totalCrossAgentDrafts += 1;
    if (["backend_fix_draft", "data_contract_draft", "mapping_fix_draft", "route_hardening_draft", "config_check_draft"].includes(draft.draftType)) {
      totalBackendDrafts += 1;
    }
    if (["frontend_fix_draft", "ui_clarity_draft"].includes(draft.draftType)) {
      totalFrontendDrafts += 1;
    }

    draftCases.push({
      agentCaseId:            agentCase.agentCaseId,
      agentRole:              agentCase.agentRole,
      problemType:            agentCase.problemType,
      problemTitle:           agentCase.problemTitle,
      draftId:                draft.draftId,
      draftType:              draft.draftType,
      draftStatus:            draft.draftStatus,
      changeCategory:         draft.changeCategory,
      preparationOwner:       draft.preparationOwner,
      handoffSuggested:       draft.handoffSuggested,
      requiresFurtherApproval: draft.requiresFurtherApproval,
      executionBlocked:       draft.executionBlocked,
      affectedDomain:         domain,
      draftVersion:           draft.draftVersion,
      preparedAt:             draft.preparedAt,
    });
  }

  // Sort by preparedAt (newest first)
  draftCases.sort((a, b) => (b.preparedAt || "").localeCompare(a.preparedAt || ""));

  return {
    totalAgentCases:          _agentCaseRegistry.size,
    totalWithDraft,
    totalDiagnosisOnly,
    totalAwaitingApproval,
    totalHandoffSuggested,
    totalCrossAgentDrafts,
    totalBackendDrafts,
    totalFrontendDrafts,
    byDraftType,
    byChangeCategory,
    byDraftStatus,
    byPreparationOwner,
    byAffectedDomain,
    draftCases:               draftCases.slice(0, ACTION_DRAFT_SUMMARY_MAX_ENTRIES),
    generatedAt:              new Date().toISOString(),
  };
}

/* ─────────────────────────────────────────────
   Step 17: Controlled Execution Proposal /
   Apply-Readiness / Final Approval Layer
   ─────────────────────────────────────────────
   Extends Steps 14–16 so that the system can:

   1. Assess *how ready* a prepared draft is
      for the next controlled application step.
   2. Generate a clear Execution Proposal /
      Final Approval Proposal.
   3. Structure what still blocks, what risks
      exist, and whether further review is
      needed.
   4. Produce cooperative, human-readable
      readiness messages.

   No productive execution.  No autonomous
   decisions.  The user always decides.
   ───────────────────────────────────────────── */

/**
 * Derive blocking factors for a given draft / agent case.
 *
 * Conservative: only flags what can be clearly inferred
 * from the existing case & draft context.
 *
 * @param {Object} params
 * @returns {Array<Object>} blocking factors
 */
function _deriveBlockingFactors({ agentCase, actionDraft }) {
  const factors = [];

  if (!actionDraft) return factors;

  // Scope unclear when no preparation steps defined
  if (!actionDraft.preparationSteps || actionDraft.preparationSteps.length === 0) {
    factors.push({
      type: "scope_unclear",
      reason: "Keine konkreten Vorbereitungsschritte definiert.",
    });
  }

  // Missing confirmation when still awaiting approval
  if (actionDraft.requiresFurtherApproval) {
    factors.push({
      type: "approval_pending",
      reason: "Eine weitere Freigabe ist noch erforderlich.",
    });
  }

  // Cross-agent dependency
  if (actionDraft.needsCrossAgentReview) {
    factors.push({
      type: "cross_agent_dependency",
      reason: "Eine Abstimmung mit dem anderen Agenten steht noch aus.",
    });
  }

  // Handoff incomplete
  if (actionDraft.handoffSuggested && actionDraft.draftStatus !== "reviewed") {
    factors.push({
      type: "handoff_incomplete",
      reason: "Die vorgeschlagene Übergabe an den anderen Agenten ist noch nicht abgeschlossen.",
    });
  }

  // Partial coverage for partial drafts
  if (actionDraft.draftType === "partial_fix_draft") {
    factors.push({
      type: "partial_coverage",
      reason: "Der Entwurf deckt nur einen Teil des Problems ab.",
    });
  }

  // Needs fresh evidence for diagnosis drafts
  if (actionDraft.draftType === "diagnosis_draft") {
    factors.push({
      type: "needs_fresh_evidence",
      reason: "Es handelt sich um einen Diagnose-Entwurf – weitere Daten werden benötigt.",
    });
  }

  return factors;
}

/**
 * Derive open checks that should be completed before
 * a draft can be safely applied.
 *
 * @param {Object} params
 * @returns {Array<string>} open checks
 */
function _deriveOpenChecks({ agentCase, actionDraft }) {
  const checks = [];

  if (!actionDraft) return checks;

  if (actionDraft.draftStatus === "prepared") {
    checks.push("Entwurf wurde noch nicht durch den Operator geprüft.");
  }

  if (actionDraft.draftType === "cross_agent_draft") {
    checks.push("Cross-Agent-Abstimmung noch offen.");
  }

  if (actionDraft.handoffSuggested) {
    checks.push("Übergabe an den zuständigen Agenten prüfen.");
  }

  const refinedPlan = agentCase.refinedPlan15;
  if (refinedPlan && refinedPlan.approvalDecisionStage === "refinement_in_progress") {
    checks.push("Plan-Verfeinerung ist noch nicht abgeschlossen.");
  }

  if (actionDraft.changeCategory === "cross_layer_coordination") {
    checks.push("Änderungen betreffen mehrere Systemebenen – zusätzliche Prüfung empfohlen.");
  }

  return checks;
}

/**
 * Derive risk flags for a draft.
 *
 * @param {Object} params
 * @returns {Array<Object>} risk flags
 */
function _deriveRiskFlags({ agentCase, actionDraft }) {
  const flags = [];

  if (!actionDraft) return flags;

  // Cross-layer impact
  if (actionDraft.changeCategory === "cross_layer_coordination") {
    flags.push({
      type: "cross_layer_impact",
      reason: "Die Änderung betrifft mehrere Systemebenen.",
    });
  }

  // Scope uncertainty for broad changes
  if (actionDraft.affectedTargets) {
    const targets = actionDraft.affectedTargets;
    const totalAffected = (targets.affectedRoutes || []).length +
      (targets.affectedServices || []).length +
      (targets.affectedViews || []).length;
    if (totalAffected > 4) {
      flags.push({
        type: "scope_uncertainty",
        reason: `Die Änderung betrifft ${totalAffected} Ziele – der Umfang könnte größer sein als geplant.`,
      });
    }
  }

  // Side effects for backend logic changes
  if (["backend_logic", "api_contract", "data_mapping"].includes(actionDraft.changeCategory)) {
    flags.push({
      type: "side_effect_possible",
      reason: "Bei Backend-/API-Änderungen sind Seiteneffekte nicht ausgeschlossen.",
    });
  }

  // Data integrity concern for schema/mapping changes
  if (["schema_alignment", "data_mapping"].includes(actionDraft.changeCategory)) {
    flags.push({
      type: "data_integrity_concern",
      reason: "Schema-/Mapping-Änderungen könnten die Datenkonsistenz beeinflussen.",
    });
  }

  return flags;
}

/**
 * Compute a readiness score (0–10) and derive a readiness band
 * from the draft's context.
 *
 * @param {Object} params
 * @returns {{ readinessScore: number, readinessBand: string }}
 */
function _computeReadinessScore({ agentCase, actionDraft, blockingFactors, riskFlags }) {
  if (!actionDraft) {
    return { readinessScore: 0, readinessBand: "not_ready" };
  }

  let score = 5; // Start at mid-point

  // Boost: draft is reviewed or approved
  if (actionDraft.draftStatus === "reviewed") score += 2;
  if (actionDraft.draftStatus === "approved_for_execution") score += 3;

  // Boost: has clear preparation steps
  if (actionDraft.preparationSteps && actionDraft.preparationSteps.length > 0) score += 1;

  // Boost: no further approval required
  if (!actionDraft.requiresFurtherApproval) score += 1;

  // Penalty: each blocking factor reduces readiness
  score -= Math.min(blockingFactors.length, 3);

  // Penalty: risk flags reduce readiness
  score -= Math.min(Math.floor(riskFlags.length / 2), 2);

  // Penalty: diagnosis-only drafts
  if (actionDraft.draftType === "diagnosis_draft") score -= 3;

  // Penalty: needs revision
  if (actionDraft.draftStatus === "needs_revision") score -= 2;
  if (actionDraft.draftStatus === "rejected") score -= 4;

  // Clamp
  score = Math.max(0, Math.min(10, score));

  // Derive band
  let band;
  if (actionDraft.draftType === "diagnosis_draft") {
    band = "diagnosis_only";
  } else if (actionDraft.draftStatus === "rejected" || actionDraft.draftStatus === "superseded") {
    band = "not_ready";
  } else if (actionDraft.needsCrossAgentReview && actionDraft.draftStatus !== "approved_for_execution") {
    band = "cross_agent_pending";
  } else if (blockingFactors.length > 0 && score < 6) {
    band = "blocked_pending_review";
  } else if (score >= 8) {
    band = "final_approval_ready";
  } else if (score >= 5 && actionDraft.draftType === "partial_fix_draft") {
    band = "partial_apply_ready";
  } else if (score >= 4) {
    band = "review_ready";
  } else {
    band = "not_ready";
  }

  return { readinessScore: score, readinessBand: band };
}

/**
 * Derive the recommended apply mode for a draft.
 *
 * @param {Object} params
 * @returns {string} one of VALID_APPLY_MODES
 */
function _deriveApplyMode({ readinessBand, actionDraft }) {
  if (!actionDraft) return "wait_for_user";

  switch (readinessBand) {
    case "final_approval_ready":
      return "full_apply_candidate";
    case "partial_apply_ready":
      return "partial_apply";
    case "review_ready":
      return "review_only";
    case "diagnosis_only":
      return "diagnosis_only";
    case "cross_agent_pending":
      return "handoff_first";
    case "blocked_pending_review":
      return "review_only";
    case "not_ready":
    default:
      return "wait_for_user";
  }
}

/**
 * Derive execution ownership for the final approval layer.
 *
 * DeepSeek = execution owner for backend / API / code / data flow
 * Gemini   = execution owner for frontend / UX / design / views
 *
 * @param {Object} params
 * @returns {Object} execution ownership details
 */
function _deriveExecutionOwnership({ actionDraft, agentRole }) {
  if (!actionDraft) {
    return {
      executionOwner: agentRole || "deepseek_backend",
      proposalOwner: agentRole || "deepseek_backend",
      secondaryAgent: null,
      handoffSuggested: false,
      handoffReason: null,
      needsCrossAgentReview: false,
      finalApprovalOwner: "user",
    };
  }

  const isBackendDraft = [
    "backend_fix_draft", "data_contract_draft", "mapping_fix_draft",
    "route_hardening_draft", "config_check_draft",
  ].includes(actionDraft.draftType);

  const isFrontendDraft = [
    "frontend_fix_draft", "ui_clarity_draft",
  ].includes(actionDraft.draftType);

  const isCrossAgent = actionDraft.draftType === "cross_agent_draft";

  let executionOwner;
  let proposalOwner;
  let secondaryAgent = null;
  let handoffSuggested = false;
  let handoffReason = null;
  let needsCrossAgentReview = false;

  if (isCrossAgent) {
    executionOwner = agentRole || "deepseek_backend";
    proposalOwner = agentRole || "deepseek_backend";
    secondaryAgent = agentRole === "gemini_frontend" ? "deepseek_backend" : "gemini_frontend";
    handoffSuggested = true;
    handoffReason = "Cross-Agent-Entwurf erfordert Abstimmung beider Agenten.";
    needsCrossAgentReview = true;
  } else if (isBackendDraft) {
    executionOwner = "deepseek_backend";
    proposalOwner = "deepseek_backend";
    if (agentRole === "gemini_frontend") {
      secondaryAgent = "gemini_frontend";
      handoffSuggested = true;
      handoffReason = "Backend-Entwurf stammt vom Frontend-Agenten – Übergabe empfohlen.";
    }
  } else if (isFrontendDraft) {
    executionOwner = "gemini_frontend";
    proposalOwner = "gemini_frontend";
    if (agentRole === "deepseek_backend") {
      secondaryAgent = "deepseek_backend";
      handoffSuggested = true;
      handoffReason = "Frontend-Entwurf stammt vom Backend-Agenten – Übergabe empfohlen.";
    }
  } else {
    executionOwner = agentRole || "deepseek_backend";
    proposalOwner = agentRole || "deepseek_backend";
  }

  return {
    executionOwner,
    proposalOwner,
    secondaryAgent,
    handoffSuggested,
    handoffReason,
    needsCrossAgentReview,
    finalApprovalOwner: "user",   // Always the user
  };
}

/**
 * Build a cooperative, human-readable execution proposal message.
 *
 * @param {Object} params
 * @returns {string} German cooperative message
 */
function _buildApplyReadinessMessage({
  readinessBand,
  readinessScore,
  recommendedApplyMode,
  blockingFactors,
  openChecks,
  riskFlags,
  executionOwner,
  draftType,
  draftSummary,
}) {
  const parts = [];

  // Opening – readiness assessment
  switch (readinessBand) {
    case "final_approval_ready":
      parts.push("Ich habe den Entwurf bewertet und halte ihn für freigabereif.");
      parts.push("Für den nächsten Schritt brauche ich noch deine letzte Bestätigung.");
      break;
    case "partial_apply_ready":
      parts.push("Ich habe den Entwurf bewertet und halte eine kontrollierte Teilfreigabe für sinnvoll.");
      parts.push("Nicht alle Teile sind vollständig bereit, aber ein eingegrenzter Anwendungsschritt wäre möglich.");
      break;
    case "review_ready":
      parts.push("Ich würde den Entwurf aktuell als reviewbereit einstufen.");
      parts.push("Vor einer Anwendung empfehle ich eine sorgfältige Prüfung.");
      break;
    case "diagnosis_only":
      parts.push("Der Entwurf ist ein Diagnose-Entwurf und nicht direkt anwendungsreif.");
      parts.push("Er dient der weiteren Vertiefung und Analyse.");
      break;
    case "cross_agent_pending":
      parts.push("Der Entwurf benötigt noch eine Abstimmung zwischen den Agenten.");
      parts.push("Ich würde zuerst die Cross-Agent-Koordination abschließen.");
      break;
    case "blocked_pending_review":
      parts.push("Ich sehe noch offene Prüfpunkte, bevor ich eine Anwendung empfehlen würde.");
      parts.push("Der Entwurf ist strukturell vorbereitet, aber noch nicht freigabereif.");
      break;
    case "not_ready":
    default:
      parts.push("Der Entwurf ist noch nicht bereit für den nächsten Schritt.");
      parts.push("Es sind noch grundlegende Punkte offen.");
      break;
  }

  // Draft summary if available
  if (draftSummary) {
    parts.push(`Zusammenfassung: ${draftSummary}`);
  }

  // Blocking factors
  if (blockingFactors.length > 0) {
    parts.push("Folgende Punkte blockieren aktuell noch:");
    for (const f of blockingFactors.slice(0, 4)) {
      parts.push(`– ${f.reason}`);
    }
  }

  // Open checks
  if (openChecks.length > 0) {
    parts.push("Offene Prüfpunkte:");
    for (const c of openChecks.slice(0, 4)) {
      parts.push(`– ${c}`);
    }
  }

  // Risk flags
  if (riskFlags.length > 0) {
    parts.push("Ich sehe folgende Risiken:");
    for (const r of riskFlags.slice(0, 3)) {
      parts.push(`– ${r.reason}`);
    }
  }

  // Apply mode recommendation
  switch (recommendedApplyMode) {
    case "full_apply_candidate":
      parts.push("Empfehlung: Der Entwurf ist aus meiner Sicht ein Kandidat für eine vollständige kontrollierte Anwendung.");
      break;
    case "partial_apply":
      parts.push("Empfehlung: Ich würde zuerst den eingegrenzten Teil freigeben.");
      break;
    case "review_only":
      parts.push("Empfehlung: Bitte zuerst prüfen, bevor eine Anwendung in Betracht kommt.");
      break;
    case "handoff_first":
      parts.push("Empfehlung: Zuerst die Übergabe an den zuständigen Agenten abschließen.");
      break;
    case "diagnosis_only":
      parts.push("Empfehlung: Diagnose vertiefen, keine Anwendung zum jetzigen Zeitpunkt.");
      break;
    case "wait_for_user":
    default:
      parts.push("Empfehlung: Ich warte auf deine Entscheidung.");
      break;
  }

  return parts.join("\n");
}

/**
 * Derive execution intent from recommended apply mode.
 * @param {string} mode
 * @returns {string}
 */
function _deriveExecutionIntent(mode) {
  switch (mode) {
    case "full_apply_candidate": return "controlled_full_apply";
    case "partial_apply":        return "controlled_partial_apply";
    default:                     return "no_apply_yet";
  }
}

/**
 * Derive apply scope from draft type.
 * @param {string} draftType
 * @returns {string}
 */
function _deriveApplyScope(draftType) {
  switch (draftType) {
    case "partial_fix_draft": return "partial";
    case "diagnosis_draft":   return "none";
    default:                  return "full";
  }
}

/**
 * Assess the apply-readiness of an action draft and build
 * a complete execution proposal.
 *
 * This is the central Step 17 function.
 *
 * @param {Object} agentCase - the agent case with actionDraft16
 * @returns {Object|null} apply-readiness assessment or null
 */
function _assessApplyReadiness(agentCase) {
  if (!agentCase) return null;

  const actionDraft = agentCase.actionDraft16;
  if (!actionDraft) return null;

  // Derive blocking factors, open checks, risk flags
  const blockingFactors = _deriveBlockingFactors({ agentCase, actionDraft });
  const openChecks = _deriveOpenChecks({ agentCase, actionDraft });
  const riskFlags = _deriveRiskFlags({ agentCase, actionDraft });

  // Compute readiness score and band
  const { readinessScore, readinessBand } = _computeReadinessScore({
    agentCase,
    actionDraft,
    blockingFactors,
    riskFlags,
  });

  // Derive recommended apply mode
  const recommendedApplyMode = _deriveApplyMode({ readinessBand, actionDraft });

  // Derive execution ownership
  const executionOwnership = _deriveExecutionOwnership({
    actionDraft,
    agentRole: agentCase.agentRole,
  });

  // Build human-readable message
  const executionProposalMessage = _buildApplyReadinessMessage({
    readinessBand,
    readinessScore,
    recommendedApplyMode,
    blockingFactors,
    openChecks,
    riskFlags,
    executionOwner: executionOwnership.executionOwner,
    draftType: actionDraft.draftType,
    draftSummary: actionDraft.draftSummary,
  });

  // Determine key booleans
  const eligibleForApply = readinessBand === "final_approval_ready" ||
    readinessBand === "partial_apply_ready";
  const applyBlocked = blockingFactors.length > 0 || readinessBand === "not_ready" ||
    readinessBand === "blocked_pending_review";
  const requiresFinalApproval = readinessBand !== "not_ready" &&
    readinessBand !== "diagnosis_only";

  const applyReadiness = {
    // Identity
    proposalId:            `proposal-${Date.now()}-${agentCase.agentCaseId}`,
    agentCaseId:           agentCase.agentCaseId,
    draftId:               actionDraft.draftId,

    // Readiness assessment
    readinessScore,
    readinessBand,
    recommendedApplyMode,

    // Apply eligibility
    eligibleForApply,
    applyBlocked,
    applyBlockedReason:    applyBlocked
      ? blockingFactors.map((f) => f.reason).join("; ") || "Entwurf noch nicht bereit."
      : null,
    requiresFinalApproval,

    // Blocking / risk detail
    blockingFactors,
    openChecks,
    riskFlags,

    // Execution ownership
    executionOwner:        executionOwnership.executionOwner,
    proposalOwner:         executionOwnership.proposalOwner,
    secondaryAgent:        executionOwnership.secondaryAgent,
    handoffSuggested:      executionOwnership.handoffSuggested,
    handoffReason:         executionOwnership.handoffReason,
    needsCrossAgentReview: executionOwnership.needsCrossAgentReview,
    finalApprovalOwner:    executionOwnership.finalApprovalOwner,

    // Execution intent (derived from recommended apply mode)
    executionIntent:       _deriveExecutionIntent(recommendedApplyMode),
    applyScope:            _deriveApplyScope(actionDraft.draftType),

    // Human-readable proposal
    executionProposalMessage,

    // Lifecycle
    assessedAt:            new Date().toISOString(),
    assessedByAgent:       agentCase.agentRole,
  };

  return applyReadiness;
}

/**
 * Get a summary of all apply-readiness assessments across
 * agent cases.  Provides the operator a clear view of:
 * - how many drafts are at each readiness band
 * - which blocking factors are most common
 * - which apply modes are recommended
 * - cross-agent review needs
 * - risk flag frequency
 *
 * @returns {Object} apply-readiness summary
 */
function getApplyReadinessSummary() {
  const byReadinessBand = {};
  const byApplyMode = {};
  const byBlockingFactor = {};
  const byRiskFlag = {};
  const byExecutionOwner = { deepseek_backend: 0, gemini_frontend: 0 };

  let totalWithReadiness = 0;
  let totalEligibleForApply = 0;
  let totalBlocked = 0;
  let totalNeedsCrossAgentReview = 0;
  let totalFinalApprovalReady = 0;
  let totalDiagnosisOnly = 0;

  const readinessCases = [];

  for (const agentCase of _agentCaseRegistry.values()) {
    const ar = agentCase.applyReadiness17 || null;
    if (!ar) continue;

    totalWithReadiness += 1;

    // By readiness band
    byReadinessBand[ar.readinessBand] = (byReadinessBand[ar.readinessBand] || 0) + 1;

    // By apply mode
    byApplyMode[ar.recommendedApplyMode] = (byApplyMode[ar.recommendedApplyMode] || 0) + 1;

    // By blocking factor type
    for (const f of ar.blockingFactors || []) {
      byBlockingFactor[f.type] = (byBlockingFactor[f.type] || 0) + 1;
    }

    // By risk flag type
    for (const r of ar.riskFlags || []) {
      byRiskFlag[r.type] = (byRiskFlag[r.type] || 0) + 1;
    }

    // By execution owner
    if (byExecutionOwner[ar.executionOwner] !== undefined) {
      byExecutionOwner[ar.executionOwner] += 1;
    }

    // Counts
    if (ar.eligibleForApply) totalEligibleForApply += 1;
    if (ar.applyBlocked) totalBlocked += 1;
    if (ar.needsCrossAgentReview) totalNeedsCrossAgentReview += 1;
    if (ar.readinessBand === "final_approval_ready") totalFinalApprovalReady += 1;
    if (ar.readinessBand === "diagnosis_only") totalDiagnosisOnly += 1;

    readinessCases.push({
      agentCaseId:           agentCase.agentCaseId,
      agentRole:             agentCase.agentRole,
      problemType:           agentCase.problemType,
      problemTitle:          agentCase.problemTitle,
      draftId:               ar.draftId,
      readinessScore:        ar.readinessScore,
      readinessBand:         ar.readinessBand,
      recommendedApplyMode:  ar.recommendedApplyMode,
      eligibleForApply:      ar.eligibleForApply,
      applyBlocked:          ar.applyBlocked,
      executionOwner:        ar.executionOwner,
      needsCrossAgentReview: ar.needsCrossAgentReview,
      requiresFinalApproval: ar.requiresFinalApproval,
      blockingFactorCount:   (ar.blockingFactors || []).length,
      riskFlagCount:         (ar.riskFlags || []).length,
      openCheckCount:        (ar.openChecks || []).length,
      assessedAt:            ar.assessedAt,
    });
  }

  // Sort by assessedAt (newest first)
  readinessCases.sort((a, b) => (b.assessedAt || "").localeCompare(a.assessedAt || ""));

  return {
    totalAgentCases:           _agentCaseRegistry.size,
    totalWithReadiness,
    totalEligibleForApply,
    totalBlocked,
    totalNeedsCrossAgentReview,
    totalFinalApprovalReady,
    totalDiagnosisOnly,
    byReadinessBand,
    byApplyMode,
    byBlockingFactor,
    byRiskFlag,
    byExecutionOwner,
    readinessCases:            readinessCases.slice(0, APPLY_READINESS_SUMMARY_MAX_ENTRIES),
    generatedAt:               new Date().toISOString(),
  };
}

/* ─────────────────────────────────────────────
   Step 18: Controlled Apply Simulation /
   Execution Preview / Reversal Safety
   ─────────────────────────────────────────────
   Extends Steps 14–17 so that the system can:

   1. Build a *preview* of what would happen
      if a draft were applied.
   2. Structure expected impact, benefits,
      side effects, and safety checks.
   3. Prepare a rollback / reversal plan.
   4. Assign preview / safety ownership to
      the responsible agent.
   5. Produce cooperative, human-readable
      preview messages.

   No productive execution.  No autonomous
   decisions.  The user always decides.
   ───────────────────────────────────────────── */

/**
 * Derive expected impact areas from draft and agent case.
 *
 * @param {Object} params
 * @returns {Array<string>} expected impact areas
 */
function _deriveExpectedImpact({ actionDraft, agentCase }) {
  const impact = [];
  if (!actionDraft) return impact;

  const dt = actionDraft.draftType || "";
  const cc = actionDraft.changeCategory || "";

  if (dt === "backend_fix_draft" || cc === "backend_logic") {
    impact.push("Backend-Logik und Datenverarbeitung");
  }
  if (dt === "frontend_fix_draft" || cc === "frontend_structure") {
    impact.push("Frontend-Darstellung und UI-Struktur");
  }
  if (cc === "api_contract" || dt === "route_hardening_draft") {
    impact.push("API-Schnittstellen und Route-Härtung");
  }
  if (cc === "data_mapping" || dt === "mapping_fix_draft") {
    impact.push("Daten-Mapping und Feldverknüpfungen");
  }
  if (cc === "schema_alignment") {
    impact.push("Schema-Ausrichtung und Datenstruktur");
  }
  if (dt === "ui_clarity_draft" || cc === "ui_clarity") {
    impact.push("UI-Klarheit und Beschriftungen");
  }
  if (dt === "config_check_draft" || cc === "ops_check") {
    impact.push("Konfiguration und Betriebsprüfung");
  }
  if (dt === "cross_agent_draft" || cc === "cross_layer_coordination") {
    impact.push("Cross-Layer-Koordination zwischen Agenten");
  }
  if (dt === "data_contract_draft") {
    impact.push("Datenvertrag und Schnittstellendefinition");
  }
  if (dt === "diagnosis_draft" || cc === "diagnosis_extension") {
    impact.push("Diagnose und Analysevertiefung");
  }

  if (impact.length === 0) {
    impact.push("Allgemeiner Systembereich");
  }

  return impact;
}

/**
 * Derive expected benefits from applying the draft.
 *
 * @param {Object} params
 * @returns {Array<string>} expected benefits
 */
function _deriveExpectedBenefits({ actionDraft, agentCase }) {
  const benefits = [];
  if (!actionDraft) return benefits;

  const dt = actionDraft.draftType || "";

  if (dt.includes("fix")) {
    benefits.push("Behebung des identifizierten Problems");
  }
  if (dt === "route_hardening_draft") {
    benefits.push("Erhöhte Stabilität und Sicherheit der API-Routen");
  }
  if (dt === "ui_clarity_draft") {
    benefits.push("Verbesserte Verständlichkeit der Benutzeroberfläche");
  }
  if (dt === "mapping_fix_draft" || dt === "data_contract_draft") {
    benefits.push("Korrektere Datenzuordnung und konsistentere Datenflüsse");
  }
  if (dt === "config_check_draft") {
    benefits.push("Sicherere und geprüfte Konfiguration");
  }
  if (dt === "diagnosis_draft") {
    benefits.push("Tieferes Verständnis des Problems für gezieltere Lösungsschritte");
  }
  if (dt === "cross_agent_draft") {
    benefits.push("Abgestimmte Cross-Agent-Lösung mit reduziertem Konfliktpotenzial");
  }

  if (benefits.length === 0) {
    benefits.push("Verbesserung des betroffenen Systembereichs");
  }

  return benefits;
}

/**
 * Derive possible side effects from applying the draft.
 *
 * @param {Object} params
 * @returns {Array<string>} possible side effects
 */
function _derivePossibleSideEffects({ actionDraft, agentCase }) {
  const effects = [];
  if (!actionDraft) return effects;

  const riskFlags = agentCase.applyReadiness17?.riskFlags || [];
  const dt = actionDraft.draftType || "";

  for (const rf of riskFlags.slice(0, 4)) {
    if (rf.type === "regression_risk") {
      effects.push("Mögliches Regressionsrisiko in angrenzenden Bereichen");
    } else if (rf.type === "cross_layer_impact") {
      effects.push("Potenzieller Cross-Layer-Effekt auf andere Systemschichten");
    } else if (rf.type === "data_integrity_concern") {
      effects.push("Datenintegrität sollte nach Anwendung geprüft werden");
    } else if (rf.type === "side_effect_possible") {
      effects.push("Nebenwirkungen in benachbarten Modulen nicht ausgeschlossen");
    } else if (rf.type === "timing_sensitivity") {
      effects.push("Zeitkritische Abhängigkeiten könnten betroffen sein");
    }
  }

  if (dt === "cross_agent_draft") {
    effects.push("Änderungen könnten Agent-übergreifende Abstimmung erfordern");
  }
  if (dt === "partial_fix_draft") {
    effects.push("Teilweise Lösung – verbleibende Teile könnten inkonsistent bleiben");
  }

  return effects;
}

/**
 * Derive safety checks that should run before / after applying.
 *
 * @param {Object} params
 * @returns {{ preApplyChecks: string[], postApplyChecks: string[] }}
 */
function _deriveSafetyChecks({ actionDraft, agentCase }) {
  const preApplyChecks = [];
  const postApplyChecks = [];

  if (!actionDraft) return { preApplyChecks, postApplyChecks };

  const dt = actionDraft.draftType || "";
  const ar = agentCase.applyReadiness17;
  const blockingFactors = ar?.blockingFactors || [];

  // Pre-apply checks
  if (blockingFactors.length > 0) {
    preApplyChecks.push("Alle blockierenden Faktoren vor Anwendung klären");
  }
  if (dt === "backend_fix_draft" || dt === "route_hardening_draft") {
    preApplyChecks.push("API-Endpunkte auf Kompatibilität prüfen");
  }
  if (dt === "frontend_fix_draft" || dt === "ui_clarity_draft") {
    preApplyChecks.push("Visuelle Prüfung der betroffenen Views");
  }
  if (dt === "mapping_fix_draft" || dt === "data_contract_draft") {
    preApplyChecks.push("Datenkonsistenz vor Anwendung sicherstellen");
  }
  if (dt === "cross_agent_draft") {
    preApplyChecks.push("Cross-Agent-Abstimmung abschließen");
  }
  if (ar?.needsCrossAgentReview) {
    preApplyChecks.push("Cross-Agent-Review durchführen");
  }

  // Post-apply checks
  postApplyChecks.push("Funktionsprüfung der betroffenen Bereiche");
  if (dt === "backend_fix_draft" || dt === "route_hardening_draft") {
    postApplyChecks.push("API-Antworten und Fehlercodes kontrollieren");
  }
  if (dt === "frontend_fix_draft" || dt === "ui_clarity_draft") {
    postApplyChecks.push("UI-Darstellung und Beschriftungen überprüfen");
  }
  if (dt === "mapping_fix_draft") {
    postApplyChecks.push("Datenfluss und Mapping-Ergebnisse validieren");
  }

  return { preApplyChecks, postApplyChecks };
}

/**
 * Derive rollback / reversal plan for a draft.
 *
 * @param {Object} params
 * @returns {Object} rollback plan
 */
function _deriveRollbackPlan({ actionDraft, agentCase }) {
  if (!actionDraft) {
    return {
      rollbackRecommended: false,
      reversalComplexity: "simple",
      rollbackPrerequisites: [],
      rollbackNotes: "Kein Entwurf vorhanden – kein Rollback erforderlich.",
      reversalPlan: null,
    };
  }

  const dt = actionDraft.draftType || "";
  const cc = actionDraft.changeCategory || "";
  const riskFlags = agentCase.applyReadiness17?.riskFlags || [];
  const hasDataRisk = riskFlags.some((r) => r.type === "data_integrity_concern");
  const hasCrossLayerRisk = riskFlags.some((r) => r.type === "cross_layer_impact");

  let reversalComplexity = "simple";
  const rollbackPrerequisites = [];
  const rollbackNotes = [];

  // Determine complexity
  if (hasDataRisk) {
    reversalComplexity = "complex";
    rollbackPrerequisites.push("Datensicherung vor Anwendung empfohlen");
    rollbackNotes.push("Datenänderungen sind möglicherweise schwer rückgängig zu machen.");
  } else if (hasCrossLayerRisk || dt === "cross_agent_draft") {
    reversalComplexity = "moderate";
    rollbackPrerequisites.push("Cross-Layer-Zustand vor Anwendung dokumentieren");
    rollbackNotes.push("Rückweg erfordert Abstimmung zwischen betroffenen Schichten.");
  } else if (dt === "partial_fix_draft") {
    reversalComplexity = "moderate";
    rollbackNotes.push("Teilweise Änderung – Rückweg grundsätzlich möglich, aber mit Vorsicht.");
  }

  if (dt === "backend_fix_draft" || dt === "route_hardening_draft") {
    rollbackPrerequisites.push("Aktuelle API-Konfiguration sichern");
    rollbackNotes.push("Backend-Änderungen können durch Konfigurations-Revert zurückgenommen werden.");
  }
  if (dt === "frontend_fix_draft" || dt === "ui_clarity_draft") {
    rollbackNotes.push("Frontend-Änderungen sind in der Regel einfach rückgängig zu machen.");
  }
  if (dt === "mapping_fix_draft" || dt === "data_contract_draft") {
    rollbackPrerequisites.push("Mapping-Zustand vor Anwendung dokumentieren");
  }
  if (dt === "config_check_draft") {
    rollbackPrerequisites.push("Aktuelle Konfiguration exportieren");
    rollbackNotes.push("Konfigurationsänderungen sind durch Reimport rückgängig zu machen.");
  }
  if (dt === "diagnosis_draft") {
    reversalComplexity = "simple";
    rollbackNotes.push("Diagnose-Entwurf hat keine produktiven Auswirkungen – kein Rollback nötig.");
  }

  const rollbackRecommended = reversalComplexity !== "simple" || riskFlags.length > 0;

  const reversalPlan = reversalComplexity === "simple" && !rollbackRecommended
    ? "Standard-Revert nach Anwendung ausreichend."
    : `Vor Anwendung: ${rollbackPrerequisites.join(", ") || "keine besonderen Voraussetzungen"}. ` +
      `Nach Bedarf: kontrollierter Revert mit ${reversalComplexity === "complex" ? "erhöhtem" : "moderatem"} Aufwand.`;

  return {
    rollbackRecommended,
    reversalComplexity,
    rollbackPrerequisites,
    rollbackNotes: rollbackNotes.join(" "),
    reversalPlan,
  };
}

/**
 * Derive preview state from apply-readiness and safety analysis.
 *
 * @param {Object} params
 * @returns {string} preview state
 */
function _derivePreviewState({ applyReadiness, safetyBand, rollbackPlan }) {
  if (!applyReadiness) return "preview_not_available";

  if (applyReadiness.applyBlocked && safetyBand === "blocked") {
    return "blocked_pending_safety";
  }
  if (rollbackPlan && rollbackPlan.reversalComplexity === "complex") {
    return "rollback_required";
  }
  if (applyReadiness.needsCrossAgentReview) {
    return "cross_agent_preview_pending";
  }
  if (safetyBand === "elevated_attention") {
    return "high_attention_preview";
  }
  if (safetyBand === "controlled_risk") {
    return "moderate_impact_preview";
  }
  return "low_impact_preview";
}

/**
 * Derive safety band from risk flags and blocking factors.
 *
 * @param {Object} params
 * @returns {string} safety band
 */
function _deriveSafetyBand({ applyReadiness, possibleSideEffects, rollbackPlan }) {
  if (!applyReadiness) return "blocked";

  const riskCount = (applyReadiness.riskFlags || []).length;
  const blockingCount = (applyReadiness.blockingFactors || []).length;
  const hasComplexReversal = rollbackPlan?.reversalComplexity === "complex";

  if (blockingCount > 2 || hasComplexReversal) return "blocked";
  if (riskCount >= 3 || blockingCount > 0) return "elevated_attention";
  if (riskCount >= 1 || possibleSideEffects.length >= 2) return "controlled_risk";
  return "low_risk";
}

/**
 * Derive recommended apply window from safety band and readiness.
 *
 * @param {Object} params
 * @returns {string} recommended apply window
 */
function _deriveApplyWindow({ safetyBand, applyReadiness }) {
  if (safetyBand === "blocked") return "not_recommended_yet";
  if (applyReadiness?.needsCrossAgentReview) return "after_cross_agent_review";
  if (safetyBand === "elevated_attention") return "after_review";
  if (safetyBand === "controlled_risk") return "low_activity_window";
  return "safe_anytime";
}

/**
 * Derive preview / safety ownership for a draft.
 *
 * @param {Object} params
 * @returns {Object} preview ownership
 */
function _derivePreviewOwnership({ actionDraft, agentRole }) {
  const dt = actionDraft?.draftType || "";

  const backendTypes = [
    "backend_fix_draft", "route_hardening_draft", "mapping_fix_draft",
    "data_contract_draft", "config_check_draft",
  ];
  const frontendTypes = [
    "frontend_fix_draft", "ui_clarity_draft",
  ];

  let previewOwner = agentRole || "deepseek_backend";
  let safetyOwner = agentRole || "deepseek_backend";
  let rollbackOwner = agentRole || "deepseek_backend";
  let secondaryAgent = null;
  let handoffSuggested = false;
  let needsCrossAgentReview = false;

  if (backendTypes.includes(dt)) {
    previewOwner = "deepseek_backend";
    safetyOwner = "deepseek_backend";
    rollbackOwner = "deepseek_backend";
  } else if (frontendTypes.includes(dt)) {
    previewOwner = "gemini_frontend";
    safetyOwner = "gemini_frontend";
    rollbackOwner = "gemini_frontend";
  } else if (dt === "cross_agent_draft") {
    previewOwner = agentRole || "deepseek_backend";
    safetyOwner = agentRole || "deepseek_backend";
    rollbackOwner = agentRole || "deepseek_backend";
    secondaryAgent = agentRole === "deepseek_backend" ? "gemini_frontend" : "deepseek_backend";
    handoffSuggested = true;
    needsCrossAgentReview = true;
  }

  return {
    previewOwner,
    safetyOwner,
    rollbackOwner,
    secondaryAgent,
    handoffSuggested,
    needsCrossAgentReview,
  };
}

/**
 * Derive preview warnings from safety analysis.
 *
 * @param {Object} params
 * @returns {Array<string>} preview warnings
 */
function _derivePreviewWarnings({ safetyBand, previewState, rollbackPlan, possibleSideEffects }) {
  const warnings = [];

  if (safetyBand === "blocked") {
    warnings.push("Anwendung ist aktuell blockiert – offene Sicherheitsfragen klären.");
  }
  if (safetyBand === "elevated_attention") {
    warnings.push("Erhöhte Aufmerksamkeit erforderlich – bitte sorgfältig prüfen.");
  }
  if (rollbackPlan?.reversalComplexity === "complex") {
    warnings.push("Rückweg wäre aufwendig – Datensicherung vor Anwendung empfohlen.");
  }
  if (rollbackPlan?.reversalComplexity === "moderate") {
    warnings.push("Rückweg wäre mit moderatem Aufwand verbunden.");
  }
  if (previewState === "cross_agent_preview_pending") {
    warnings.push("Cross-Agent-Abstimmung steht noch aus.");
  }
  if (possibleSideEffects.length >= 3) {
    warnings.push("Mehrere mögliche Nebenwirkungen identifiziert – erhöhte Vorsicht empfohlen.");
  }

  return warnings;
}

/**
 * Build a human-readable execution preview message.
 *
 * @param {Object} params
 * @returns {string} cooperative German preview message
 */
function _buildExecutionPreviewMessage({
  previewState,
  safetyBand,
  expectedImpact,
  expectedBenefits,
  possibleSideEffects,
  safetyChecks,
  rollbackPlan,
  previewWarnings,
  recommendedApplyWindow,
  draftType,
  draftSummary,
}) {
  const parts = [];

  // Opening – preview assessment
  switch (previewState) {
    case "low_impact_preview":
      parts.push("Ich habe eine Anwendungsvorschau vorbereitet. Die erwarteten Auswirkungen sind überschaubar.");
      break;
    case "moderate_impact_preview":
      parts.push("Ich habe eine Anwendungsvorschau vorbereitet. Ich sehe hier mittlere Auswirkungen.");
      break;
    case "high_attention_preview":
      parts.push("Ich habe eine Anwendungsvorschau vorbereitet. Ich sehe hier erhöhte Aufmerksamkeit.");
      parts.push("Bitte prüfe die Sicherheitsfragen vor einer möglichen Anwendung.");
      break;
    case "blocked_pending_safety":
      parts.push("Ich habe eine Vorschau vorbereitet, aber die Anwendung ist aktuell noch blockiert.");
      parts.push("Es gibt offene Sicherheitsfragen, die zuerst geklärt werden sollten.");
      break;
    case "rollback_required":
      parts.push("Ich habe eine Vorschau vorbereitet. Wichtig: Ein Rückweg wäre bei diesem Entwurf aufwendiger.");
      parts.push("Ich empfehle, vor einer Anwendung die Rollback-Voraussetzungen zu prüfen.");
      break;
    case "cross_agent_preview_pending":
      parts.push("Ich habe eine Vorschau vorbereitet, aber die Cross-Agent-Abstimmung ist noch offen.");
      parts.push("Für den nächsten Schritt sollte die Abstimmung abgeschlossen werden.");
      break;
    case "preview_not_available":
    default:
      parts.push("Eine Anwendungsvorschau ist aktuell noch nicht verfügbar.");
      parts.push("Der Entwurf ist noch nicht weit genug fortgeschritten.");
      break;
  }

  // Draft summary
  if (draftSummary) {
    parts.push(`Zusammenfassung: ${draftSummary}`);
  }

  // Expected impact
  if (expectedImpact.length > 0) {
    parts.push("Diese Bereiche wären voraussichtlich betroffen:");
    for (const area of expectedImpact.slice(0, 5)) {
      parts.push(`– ${area}`);
    }
  }

  // Expected benefits
  if (expectedBenefits.length > 0) {
    parts.push("Ich erwarte vor allem diese positiven Wirkungen:");
    for (const benefit of expectedBenefits.slice(0, 3)) {
      parts.push(`– ${benefit}`);
    }
  }

  // Possible side effects
  if (possibleSideEffects.length > 0) {
    parts.push("Folgende Nebenwirkungen sind nicht ausgeschlossen:");
    for (const effect of possibleSideEffects.slice(0, 3)) {
      parts.push(`– ${effect}`);
    }
  }

  // Safety band
  switch (safetyBand) {
    case "low_risk":
      parts.push("Ich sehe aktuell geringe Sicherheitsbedenken.");
      break;
    case "controlled_risk":
      parts.push("Ich sehe aktuell mittlere Sicherheitsbedenken – kontrollierte Anwendung möglich.");
      break;
    case "elevated_attention":
      parts.push("Ich sehe aktuell erhöhte Sicherheitsbedenken.");
      break;
    case "blocked":
      parts.push("Ich sehe aktuell noch offene Sicherheitsfragen, die eine Anwendung blockieren.");
      break;
  }

  // Pre-apply checks
  if (safetyChecks.preApplyChecks.length > 0) {
    parts.push("Ich würde vor einer Anwendung noch diese Prüfschritte empfehlen:");
    for (const check of safetyChecks.preApplyChecks.slice(0, 4)) {
      parts.push(`– ${check}`);
    }
  }

  // Rollback assessment
  if (rollbackPlan) {
    switch (rollbackPlan.reversalComplexity) {
      case "simple":
        parts.push("Ein Rückweg wäre in diesem Fall eher einfach.");
        break;
      case "moderate":
        parts.push("Ein Rückweg wäre in diesem Fall mit moderatem Aufwand verbunden.");
        break;
      case "complex":
        parts.push("Ein Rückweg wäre in diesem Fall aufwendiger. Vor einer Anwendung sollte ein Rückweg mitgedacht werden.");
        break;
    }
  }

  // Apply window
  switch (recommendedApplyWindow) {
    case "safe_anytime":
      parts.push("Empfehlung: Die Anwendung wäre aus meiner Sicht jederzeit sicher möglich.");
      break;
    case "low_activity_window":
      parts.push("Empfehlung: Ich würde die Anwendung in einem ruhigeren Zeitfenster durchführen.");
      break;
    case "after_review":
      parts.push("Empfehlung: Bitte zuerst noch ein Review durchführen, bevor eine Anwendung erfolgt.");
      break;
    case "after_cross_agent_review":
      parts.push("Empfehlung: Zuerst die Cross-Agent-Abstimmung abschließen.");
      break;
    case "not_recommended_yet":
      parts.push("Empfehlung: Eine Anwendung ist zum jetzigen Zeitpunkt noch nicht empfohlen.");
      break;
  }

  parts.push("Für den nächsten Schritt brauche ich noch deine Bestätigung.");

  return parts.join("\n");
}

/**
 * Build a complete execution preview / apply simulation
 * for an agent case that has an apply-readiness assessment.
 *
 * This is the central Step 18 function.
 *
 * @param {Object} agentCase - the agent case with applyReadiness17
 * @returns {Object|null} execution preview or null
 */
function _buildExecutionPreview(agentCase) {
  if (!agentCase) return null;

  const applyReadiness = agentCase.applyReadiness17;
  const actionDraft = agentCase.actionDraft16;
  if (!applyReadiness || !actionDraft) return null;

  // Derive all preview components
  const expectedImpact = _deriveExpectedImpact({ actionDraft, agentCase });
  const expectedBenefits = _deriveExpectedBenefits({ actionDraft, agentCase });
  const possibleSideEffects = _derivePossibleSideEffects({ actionDraft, agentCase });
  const safetyChecks = _deriveSafetyChecks({ actionDraft, agentCase });
  const rollbackPlan = _deriveRollbackPlan({ actionDraft, agentCase });

  // Derive safety band
  const safetyBand = _deriveSafetyBand({
    applyReadiness,
    possibleSideEffects,
    rollbackPlan,
  });

  // Derive preview state
  const previewState = _derivePreviewState({
    applyReadiness,
    safetyBand,
    rollbackPlan,
  });

  // Derive apply window
  const recommendedApplyWindow = _deriveApplyWindow({
    safetyBand,
    applyReadiness,
  });

  // Derive preview ownership
  const previewOwnership = _derivePreviewOwnership({
    actionDraft,
    agentRole: agentCase.agentRole,
  });

  // Derive preview warnings
  const previewWarnings = _derivePreviewWarnings({
    safetyBand,
    previewState,
    rollbackPlan,
    possibleSideEffects,
  });

  // Determine if preview is blocked
  const previewBlocked = previewState === "blocked_pending_safety" ||
    previewState === "preview_not_available";

  // Dry run only = always true (no real execution in Step 18)
  const dryRunOnly = true;

  // Confidence
  const previewConfidence = safetyBand === "low_risk" ? "high"
    : safetyBand === "controlled_risk" ? "medium"
    : "low";

  // Build human-readable preview message
  const executionPreviewMessage = _buildExecutionPreviewMessage({
    previewState,
    safetyBand,
    expectedImpact,
    expectedBenefits,
    possibleSideEffects,
    safetyChecks,
    rollbackPlan,
    previewWarnings,
    recommendedApplyWindow,
    draftType: actionDraft.draftType,
    draftSummary: actionDraft.draftSummary,
  });

  const executionPreview = {
    // Identity
    previewId:              `preview-${Date.now()}-${agentCase.agentCaseId}`,
    agentCaseId:            agentCase.agentCaseId,
    proposalId:             applyReadiness.proposalId,
    draftId:                actionDraft.draftId,

    // Preview state
    previewState,
    safetyBand,
    previewConfidence,
    previewBlocked,
    dryRunOnly,

    // Expected impact
    expectedImpact,
    expectedBenefits,
    possibleSideEffects,

    // Safety checks
    preApplyChecks:         safetyChecks.preApplyChecks,
    postApplyChecks:        safetyChecks.postApplyChecks,
    previewWarnings,

    // Rollback / reversal
    rollbackPlan:           rollbackPlan.reversalPlan,
    reversalComplexity:     rollbackPlan.reversalComplexity,
    rollbackPrerequisites:  rollbackPlan.rollbackPrerequisites,
    rollbackRecommended:    rollbackPlan.rollbackRecommended,
    rollbackNotes:          rollbackPlan.rollbackNotes,

    // Apply window
    recommendedApplyWindow,
    requiresRollbackPlan:   rollbackPlan.rollbackRecommended,

    // Preview ownership
    previewOwner:           previewOwnership.previewOwner,
    safetyOwner:            previewOwnership.safetyOwner,
    rollbackOwner:          previewOwnership.rollbackOwner,
    secondaryAgent:         previewOwnership.secondaryAgent,
    handoffSuggested:       previewOwnership.handoffSuggested,
    needsCrossAgentReview:  previewOwnership.needsCrossAgentReview,

    // Human-readable preview message
    executionPreviewMessage,

    // Lifecycle
    previewGeneratedAt:     new Date().toISOString(),
    previewGeneratedByAgent: agentCase.agentRole,
  };

  // Attach to agent case
  agentCase.executionPreview18 = executionPreview;

  // Record preview chat message
  _recordAgentChatMessage({
    agentCaseId:          agentCase.agentCaseId,
    agentRole:            agentCase.agentRole,
    messageType:          "execution_preview",
    messageIntent:        "preview_prepared",
    messagePriority:      safetyBand === "blocked" || safetyBand === "elevated_attention" ? "high" : "normal",
    requiresUserDecision: true,
    message:              executionPreviewMessage,
    problemType:          agentCase.problemType,
    // Step 18 fields
    previewState,
    safetyBand,
    previewBlocked,
    rollbackRequired:     rollbackPlan.rollbackRecommended,
    recommendedApplyWindow,
    nextSafetyStep:       previewBlocked ? "resolve_safety_blockers" : "user_confirmation",
  });

  // Logging
  logger.info("[agentBridge] Step 18 – Execution Preview erzeugt", {
    agentCaseId:          agentCase.agentCaseId,
    previewState,
    safetyBand,
    previewConfidence,
    previewBlocked,
    rollbackRecommended:  rollbackPlan.rollbackRecommended,
    reversalComplexity:   rollbackPlan.reversalComplexity,
    recommendedApplyWindow,
    previewOwner:         previewOwnership.previewOwner,
    expectedImpactCount:  expectedImpact.length,
    sideEffectCount:      possibleSideEffects.length,
    preApplyCheckCount:   safetyChecks.preApplyChecks.length,
    previewWarningCount:  previewWarnings.length,
    dryRunOnly,
  });

  // Step 19: Build apply candidate after execution preview
  _buildApplyCandidate(agentCase);

  return executionPreview;
}

/**
 * Get a summary of all execution previews across agent cases.
 * Provides the operator a clear view of preview / safety status.
 *
 * @returns {Object} execution preview summary
 */
function getExecutionPreviewSummary() {
  const byPreviewState = {};
  const bySafetyBand = {};
  const byReversalComplexity = {};
  const byApplyWindow = {};
  const byPreviewOwner = { deepseek_backend: 0, gemini_frontend: 0 };

  let totalWithPreview = 0;
  let totalPreviewBlocked = 0;
  let totalRollbackRecommended = 0;
  let totalNeedsCrossAgentReview = 0;
  let totalLowRisk = 0;
  let totalElevatedAttention = 0;

  const previewCases = [];
  const commonWarnings = {};

  for (const agentCase of _agentCaseRegistry.values()) {
    const ep = agentCase.executionPreview18 || null;
    if (!ep) continue;

    totalWithPreview += 1;

    // By preview state
    byPreviewState[ep.previewState] = (byPreviewState[ep.previewState] || 0) + 1;

    // By safety band
    bySafetyBand[ep.safetyBand] = (bySafetyBand[ep.safetyBand] || 0) + 1;

    // By reversal complexity
    byReversalComplexity[ep.reversalComplexity] = (byReversalComplexity[ep.reversalComplexity] || 0) + 1;

    // By apply window
    byApplyWindow[ep.recommendedApplyWindow] = (byApplyWindow[ep.recommendedApplyWindow] || 0) + 1;

    // By preview owner
    if (byPreviewOwner[ep.previewOwner] !== undefined) {
      byPreviewOwner[ep.previewOwner] += 1;
    }

    // Counts
    if (ep.previewBlocked) totalPreviewBlocked += 1;
    if (ep.rollbackRecommended) totalRollbackRecommended += 1;
    if (ep.needsCrossAgentReview) totalNeedsCrossAgentReview += 1;
    if (ep.safetyBand === "low_risk") totalLowRisk += 1;
    if (ep.safetyBand === "elevated_attention") totalElevatedAttention += 1;

    // Track common warnings
    for (const w of ep.previewWarnings || []) {
      commonWarnings[w] = (commonWarnings[w] || 0) + 1;
    }

    previewCases.push({
      agentCaseId:            agentCase.agentCaseId,
      agentRole:              agentCase.agentRole,
      problemType:            agentCase.problemType,
      problemTitle:           agentCase.problemTitle,
      draftId:                ep.draftId,
      previewState:           ep.previewState,
      safetyBand:             ep.safetyBand,
      previewConfidence:      ep.previewConfidence,
      previewBlocked:         ep.previewBlocked,
      reversalComplexity:     ep.reversalComplexity,
      rollbackRecommended:    ep.rollbackRecommended,
      recommendedApplyWindow: ep.recommendedApplyWindow,
      previewOwner:           ep.previewOwner,
      needsCrossAgentReview:  ep.needsCrossAgentReview,
      expectedImpactCount:    (ep.expectedImpact || []).length,
      sideEffectCount:        (ep.possibleSideEffects || []).length,
      previewWarningCount:    (ep.previewWarnings || []).length,
      previewGeneratedAt:     ep.previewGeneratedAt,
    });
  }

  // Sort by previewGeneratedAt (newest first)
  previewCases.sort((a, b) => (b.previewGeneratedAt || "").localeCompare(a.previewGeneratedAt || ""));

  // Top warnings
  const topWarnings = Object.entries(commonWarnings)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([warning, count]) => ({ warning, count }));

  return {
    totalAgentCases:          _agentCaseRegistry.size,
    totalWithPreview,
    totalPreviewBlocked,
    totalRollbackRecommended,
    totalNeedsCrossAgentReview,
    totalLowRisk,
    totalElevatedAttention,
    byPreviewState,
    bySafetyBand,
    byReversalComplexity,
    byApplyWindow,
    byPreviewOwner,
    topWarnings,
    previewCases:             previewCases.slice(0, EXECUTION_PREVIEW_SUMMARY_MAX_ENTRIES),
    generatedAt:              new Date().toISOString(),
  };
}

/* ─────────────────────────────────────────────
   Step 19: Controlled Apply Candidate /
   Action Package / Approval Gate
   ─────────────────────────────────────────────
   Translates the complete pipeline (problem →
   draft → readiness → preview → safety) into
   a clear final apply candidate with explicit
   scope, guardrails, preconditions, and an
   approval checklist.

   The system NEVER auto-executes.  It prepares
   the candidate – the user decides.
   ───────────────────────────────────────────── */

/**
 * Derive the candidate status from execution preview,
 * apply readiness, and action draft data.
 *
 * @param {Object} params
 * @returns {string} candidate status
 */
function _deriveCandidateStatus({ executionPreview, applyReadiness, actionDraft }) {
  if (!actionDraft || !applyReadiness) return "candidate_not_available";

  const dt = actionDraft.draftType || "";
  if (dt === "diagnosis_draft") return "candidate_diagnosis_only";

  if (applyReadiness.applyBlocked) return "candidate_blocked";

  if (executionPreview && executionPreview.previewBlocked) return "candidate_blocked";

  if (applyReadiness.needsCrossAgentReview) return "candidate_cross_agent_pending";

  if (dt === "partial_fix_draft") return "candidate_partial";

  const rb = applyReadiness.readinessBand || "";
  if (rb === "final_approval_ready") {
    const sb = executionPreview ? executionPreview.safetyBand : null;
    if (sb === "blocked" || sb === "elevated_attention") {
      return "candidate_scope_confirmation_needed";
    }
    return "candidate_ready_for_final_approval";
  }

  if (rb === "review_ready" || rb === "partial_apply_ready") {
    return "candidate_scope_confirmation_needed";
  }

  return "candidate_not_available";
}

/**
 * Derive the candidate mode from draft type, agent role,
 * and apply readiness.
 *
 * @param {Object} params
 * @returns {string} candidate mode
 */
function _deriveCandidateMode({ actionDraft, agentRole, applyReadiness }) {
  if (!actionDraft) return "wait_for_user";

  const dt = actionDraft.draftType || "";
  if (dt === "diagnosis_draft") return "diagnosis_only";

  if (dt === "partial_fix_draft") return "partial_scope";

  if (dt === "cross_agent_draft") return "cross_agent_candidate";

  if (applyReadiness && applyReadiness.readinessBand === "final_approval_ready") {
    return "final_approval_candidate";
  }

  if (agentRole === "deepseek_backend") {
    if (["backend_fix_draft", "route_hardening_draft", "data_contract_draft", "mapping_fix_draft", "config_check_draft"].includes(dt)) {
      return "backend_only";
    }
  }

  if (agentRole === "gemini_frontend") {
    if (["frontend_fix_draft", "ui_clarity_draft"].includes(dt)) {
      return "frontend_only";
    }
  }

  return "wait_for_user";
}

/**
 * Derive included actions from draft and apply readiness.
 * Returns a concise list of what the candidate covers.
 *
 * @param {Object} params
 * @returns {string[]} included actions
 */
function _deriveIncludedActions({ actionDraft, applyReadiness }) {
  const actions = [];
  if (!actionDraft) return actions;

  const dt = actionDraft.draftType || "";
  const summary = actionDraft.draftSummary || "";

  switch (dt) {
    case "backend_fix_draft":
      actions.push("Backend-Logik-Korrektur");
      break;
    case "frontend_fix_draft":
      actions.push("Frontend-Struktur-Anpassung");
      break;
    case "route_hardening_draft":
      actions.push("Route-Härtung / API-Absicherung");
      break;
    case "data_contract_draft":
      actions.push("Datenvertrag-Anpassung");
      break;
    case "mapping_fix_draft":
      actions.push("Mapping-Korrektur");
      break;
    case "config_check_draft":
      actions.push("Konfigurations-Prüfung / Anpassung");
      break;
    case "ui_clarity_draft":
      actions.push("UI-Klarheit / Beschriftungsverbesserung");
      break;
    case "partial_fix_draft":
      actions.push("Teilkorrektur (eingeschränkter Scope)");
      break;
    case "cross_agent_draft":
      actions.push("Schichtübergreifende Korrektur");
      break;
    case "diagnosis_draft":
      actions.push("Diagnose (keine produktive Änderung)");
      break;
    default:
      if (summary) actions.push(summary.slice(0, 120));
      break;
  }

  // Add scope details from readiness
  if (applyReadiness) {
    const scope = applyReadiness.applyScope || {};
    if (scope.affectedLayers && scope.affectedLayers.length > 0) {
      actions.push(`Betroffene Schichten: ${scope.affectedLayers.join(", ")}`);
    }
    if (scope.affectedTargets && scope.affectedTargets.length > 0) {
      actions.push(`Betroffene Bereiche: ${scope.affectedTargets.slice(0, 3).join(", ")}`);
    }
  }

  return actions;
}

/**
 * Derive excluded actions – what the candidate explicitly does NOT cover.
 *
 * @param {Object} params
 * @returns {string[]} excluded actions
 */
function _deriveExcludedActions({ actionDraft, agentRole, applyReadiness }) {
  const excluded = [];
  if (!actionDraft) return excluded;

  const dt = actionDraft.draftType || "";

  // Agent scope boundaries
  if (agentRole === "deepseek_backend") {
    excluded.push("Frontend- / UI-Änderungen");
    excluded.push("Visuelle Darstellung / Beschriftungen");
  }
  if (agentRole === "gemini_frontend") {
    excluded.push("Backend-Logik / API-Änderungen");
    excluded.push("Datenbank- / Schema-Änderungen");
  }

  // Draft type boundaries
  if (dt === "diagnosis_draft") {
    excluded.push("Produktive Code-Änderungen");
    excluded.push("Automatische Fehlerbehebung");
  }
  if (dt === "partial_fix_draft") {
    excluded.push("Vollständige Lösung aller betroffenen Bereiche");
  }

  // Blocked cross-agent items
  if (applyReadiness && applyReadiness.needsCrossAgentReview) {
    excluded.push("Änderungen an der jeweils anderen Schicht (Cross-Agent-Review ausstehend)");
  }

  return excluded;
}

/**
 * Derive scope guardrails – hard boundaries the candidate respects.
 *
 * @param {Object} params
 * @returns {Object[]} guardrails
 */
function _deriveScopeGuardrails({ candidateMode, candidateStatus, executionPreview, applyReadiness }) {
  const guardrails = [];

  // Always present: no auto-execute
  guardrails.push({
    type: "no_auto_execute",
    label: "Keine automatische Ausführung – nur nach expliziter Freigabe",
    active: true,
  });

  guardrails.push({
    type: "requires_user_confirmation",
    label: "Endgültige Entscheidung liegt beim Benutzer",
    active: true,
  });

  // Scope boundaries
  if (candidateMode === "backend_only") {
    guardrails.push({
      type: "layer_restriction",
      label: "Nur Backend-Änderungen – Frontend bleibt unverändert",
      active: true,
    });
  }
  if (candidateMode === "frontend_only") {
    guardrails.push({
      type: "layer_restriction",
      label: "Nur Frontend-Änderungen – Backend bleibt unverändert",
      active: true,
    });
  }
  if (candidateMode === "partial_scope") {
    guardrails.push({
      type: "scope_boundary",
      label: "Teilkorrektur – nicht alle betroffenen Bereiche abgedeckt",
      active: true,
    });
  }

  // Cross-agent gate
  if (candidateStatus === "candidate_cross_agent_pending" || candidateMode === "cross_agent_candidate") {
    guardrails.push({
      type: "cross_agent_gate",
      label: "Cross-Agent-Review erforderlich vor Freigabe",
      active: true,
    });
  }

  // Rollback gate
  if (executionPreview && executionPreview.rollbackRecommended) {
    guardrails.push({
      type: "rollback_mandatory",
      label: "Rollback-Plan muss vor Freigabe bestätigt werden",
      active: true,
    });
  }

  // Data safety
  if (executionPreview && executionPreview.reversalComplexity === "complex") {
    guardrails.push({
      type: "data_safety_gate",
      label: "Datensicherung vor Anwendung empfohlen",
      active: true,
    });
  }

  return guardrails;
}

/**
 * Derive the approval checklist – items to confirm before final approval.
 *
 * @param {Object} params
 * @returns {Object[]} checklist items
 */
function _deriveApprovalChecklist({ candidateStatus, candidateMode, executionPreview, applyReadiness }) {
  const checklist = [];

  checklist.push({
    item: "scope_confirmation",
    label: "Umfang des Kandidaten geprüft und bestätigt",
    required: true,
    completed: false,
  });

  if (executionPreview && executionPreview.rollbackRecommended) {
    checklist.push({
      item: "rollback_acknowledgement",
      label: "Rollback-Plan zur Kenntnis genommen",
      required: true,
      completed: false,
    });
  }

  if (candidateStatus === "candidate_cross_agent_pending" || candidateMode === "cross_agent_candidate") {
    checklist.push({
      item: "cross_agent_confirmation",
      label: "Cross-Agent-Review abgeschlossen",
      required: true,
      completed: false,
    });
  }

  if (applyReadiness && (applyReadiness.blockingFactors || []).length > 0) {
    checklist.push({
      item: "blocking_factors_resolved",
      label: "Blockierende Faktoren geklärt",
      required: true,
      completed: false,
    });
  }

  if (applyReadiness && (applyReadiness.riskFlags || []).length > 0) {
    checklist.push({
      item: "risk_flags_reviewed",
      label: "Risiko-Hinweise geprüft",
      required: true,
      completed: false,
    });
  }

  checklist.push({
    item: "final_user_approval",
    label: "Finale Freigabe durch Benutzer",
    required: true,
    completed: false,
  });

  return checklist;
}

/**
 * Derive final preconditions – what must be true before the candidate
 * can be approved.
 *
 * @param {Object} params
 * @returns {string[]} preconditions
 */
function _deriveFinalPreconditions({ candidateStatus, executionPreview, applyReadiness }) {
  const preconditions = [];

  if (candidateStatus === "candidate_blocked") {
    preconditions.push("Blockierung muss zuerst aufgelöst werden");
  }

  if (candidateStatus === "candidate_cross_agent_pending") {
    preconditions.push("Cross-Agent-Review muss abgeschlossen werden");
  }

  if (candidateStatus === "candidate_scope_confirmation_needed") {
    preconditions.push("Scope-Bestätigung durch Benutzer erforderlich");
  }

  if (executionPreview && executionPreview.rollbackRecommended) {
    preconditions.push("Rollback-Plan muss bestätigt werden");
  }

  if (applyReadiness && (applyReadiness.blockingFactors || []).length > 0) {
    preconditions.push("Alle blockierenden Faktoren müssen geklärt werden");
  }

  if (applyReadiness && (applyReadiness.openChecks || []).length > 0) {
    preconditions.push("Offene Prüfpunkte müssen abgeschlossen werden");
  }

  return preconditions;
}

/**
 * Derive candidate ownership – who prepared, who gates, who approves.
 *
 * @param {Object} params
 * @returns {Object} ownership
 */
function _deriveCandidateOwnership({ agentRole, candidateMode }) {
  const isBackend = agentRole === "deepseek_backend";

  let candidateOwner = agentRole;
  let gateOwner = agentRole;
  let proposalOwner = agentRole;
  let secondaryAgent = isBackend ? "gemini_frontend" : "deepseek_backend";
  let handoffSuggested = false;
  let needsCrossAgentReview = false;

  if (candidateMode === "cross_agent_candidate") {
    needsCrossAgentReview = true;
    handoffSuggested = true;
  }

  return {
    candidateOwner,
    gateOwner,
    proposalOwner,
    secondaryAgent,
    handoffSuggested,
    needsCrossAgentReview,
    finalApprovalOwner: "user",
  };
}

/**
 * Build a human-readable apply candidate message in cooperative German.
 *
 * @param {Object} params
 * @returns {string} message
 */
function _buildApplyCandidateMessage({
  candidateStatus,
  candidateMode,
  includedActions,
  excludedActions,
  guardrails,
  approvalChecklist,
  finalPreconditions,
  candidateOwner,
}) {
  const parts = [];

  // Opening statement
  switch (candidateStatus) {
    case "candidate_ready_for_final_approval":
      parts.push("Ich habe den finalen Anwendungskandidaten auf den folgenden Umfang eingegrenzt.");
      break;
    case "candidate_diagnosis_only":
      parts.push("Dieser Fall bleibt ein Diagnose-Kandidat – keine produktive Änderung wird vorgeschlagen.");
      break;
    case "candidate_partial":
      parts.push("Ein Teilkandidat liegt vor – er deckt nicht alle betroffenen Bereiche ab.");
      break;
    case "candidate_blocked":
      parts.push("Der Kandidat ist derzeit blockiert und kann noch nicht zur Freigabe vorgelegt werden.");
      break;
    case "candidate_cross_agent_pending":
      parts.push("Ein Cross-Agent-Review steht noch aus, bevor der Kandidat finalisiert werden kann.");
      break;
    case "candidate_scope_confirmation_needed":
      parts.push("Der Kandidat benötigt noch eine Scope-Bestätigung, bevor er zur Freigabe bereit ist.");
      break;
    default:
      parts.push("Es liegt noch kein freigabefähiger Kandidat vor.");
      break;
  }

  // Candidate mode
  switch (candidateMode) {
    case "backend_only":
      parts.push("Dieser Kandidat umfasst nur den Backend-Teil und schließt Frontend-Änderungen ausdrücklich aus.");
      break;
    case "frontend_only":
      parts.push("Dieser Kandidat umfasst nur den Frontend-Teil und schließt Backend-Änderungen ausdrücklich aus.");
      break;
    case "partial_scope":
      parts.push("Der Umfang ist bewusst eingegrenzt – nur ein Teil der identifizierten Punkte wird adressiert.");
      break;
    case "cross_agent_candidate":
      parts.push("Dieser Kandidat betrifft mehrere Schichten und erfordert eine abgestimmte Freigabe.");
      break;
    case "diagnosis_only":
      parts.push("Es handelt sich ausschließlich um eine Diagnose – keine Anwendung vorgesehen.");
      break;
    case "final_approval_candidate":
      parts.push("Der Kandidat ist vollständig und bereit für die finale Entscheidung.");
      break;
    default:
      break;
  }

  // Included actions
  if (includedActions && includedActions.length > 0) {
    parts.push(`\nEnthaltene Maßnahmen:\n${includedActions.map(a => `  • ${a}`).join("\n")}`);
  }

  // Excluded actions
  if (excludedActions && excludedActions.length > 0) {
    parts.push(`\nBewusst ausgeschlossen:\n${excludedActions.map(a => `  • ${a}`).join("\n")}`);
  }

  // Active guardrails
  const activeGuardrails = (guardrails || []).filter(g => g.active);
  if (activeGuardrails.length > 0) {
    parts.push(`\nAktive Guardrails:\n${activeGuardrails.map(g => `  • ${g.label}`).join("\n")}`);
  }

  // Preconditions
  if (finalPreconditions && finalPreconditions.length > 0) {
    parts.push(`\nVor der finalen Freigabe fehlen noch:\n${finalPreconditions.map(p => `  • ${p}`).join("\n")}`);
  }

  // Approval checklist
  const pendingChecks = (approvalChecklist || []).filter(c => c.required && !c.completed);
  if (pendingChecks.length > 0) {
    parts.push(`\nNoch zu bestätigen:\n${pendingChecks.map(c => `  ☐ ${c.label}`).join("\n")}`);
  }

  // Owner info
  const ownerLabel = candidateOwner === "deepseek_backend" ? "DeepSeek (Backend)" : "Gemini (Frontend)";
  parts.push(`\nVorbereitet von: ${ownerLabel}`);
  parts.push("Endgültige Freigabe: Du entscheidest.");

  // Closing
  if (candidateStatus === "candidate_ready_for_final_approval") {
    parts.push("\nAuf dieser Basis liegt jetzt ein klar abgegrenzter Kandidat zur letzten Entscheidung vor.");
    parts.push("Für den nächsten Schritt brauche ich noch deine letzte Entscheidung.");
  } else {
    parts.push("\nSobald die offenen Punkte geklärt sind, kann der Kandidat zur Freigabe vorbereitet werden.");
  }

  return parts.join("\n");
}

/**
 * Build a complete controlled apply candidate / action package
 * for an agent case that has an execution preview.
 *
 * This is the central Step 19 function.
 *
 * @param {Object} agentCase - the agent case with executionPreview18
 * @returns {Object|null} apply candidate or null
 */
function _buildApplyCandidate(agentCase) {
  if (!agentCase) return null;

  const executionPreview = agentCase.executionPreview18;
  const applyReadiness = agentCase.applyReadiness17;
  const actionDraft = agentCase.actionDraft16;
  if (!applyReadiness || !actionDraft) return null;

  // Derive candidate status
  const candidateStatus = _deriveCandidateStatus({
    executionPreview,
    applyReadiness,
    actionDraft,
  });

  // Derive candidate mode
  const candidateMode = _deriveCandidateMode({
    actionDraft,
    agentRole: agentCase.agentRole,
    applyReadiness,
  });

  // Derive included / excluded actions
  const includedActions = _deriveIncludedActions({ actionDraft, applyReadiness });
  const excludedActions = _deriveExcludedActions({
    actionDraft,
    agentRole: agentCase.agentRole,
    applyReadiness,
  });

  // Derive scope guardrails
  const guardrails = _deriveScopeGuardrails({
    candidateMode,
    candidateStatus,
    executionPreview,
    applyReadiness,
  });

  // Derive approval checklist
  const approvalChecklist = _deriveApprovalChecklist({
    candidateStatus,
    candidateMode,
    executionPreview,
    applyReadiness,
  });

  // Derive final preconditions
  const finalPreconditions = _deriveFinalPreconditions({
    candidateStatus,
    executionPreview,
    applyReadiness,
  });

  // Derive missing approvals
  const missingApprovals = approvalChecklist
    .filter(c => c.required && !c.completed)
    .map(c => c.item);

  // Derive ownership
  const ownership = _deriveCandidateOwnership({
    agentRole: agentCase.agentRole,
    candidateMode,
  });

  // Candidate state flags
  const candidateReadyForFinalApproval = candidateStatus === "candidate_ready_for_final_approval";
  const candidateBlocked = candidateStatus === "candidate_blocked";
  const scopeLocked = candidateReadyForFinalApproval;
  const requiresScopeConfirmation = candidateStatus === "candidate_scope_confirmation_needed";

  // Build scope summary
  const candidateScope = {
    affectedLayers: applyReadiness.applyScope?.affectedLayers || [],
    affectedTargets: applyReadiness.applyScope?.affectedTargets || [],
    draftType: actionDraft.draftType,
    changeCategory: actionDraft.changeCategory,
  };

  // Allowed / disallowed apply targets
  const allowedApplyTargets = [];
  const disallowedApplyTargets = [];
  if (candidateMode === "backend_only") {
    allowedApplyTargets.push("backend", "api", "datenfluss", "mapping", "route");
    disallowedApplyTargets.push("frontend", "ui", "design", "darstellung");
  } else if (candidateMode === "frontend_only") {
    allowedApplyTargets.push("frontend", "ui", "design", "darstellung", "beschriftung");
    disallowedApplyTargets.push("backend", "api", "datenbank", "schema");
  } else if (candidateMode === "diagnosis_only") {
    disallowedApplyTargets.push("backend", "frontend", "api", "datenbank");
  } else {
    allowedApplyTargets.push("pending_scope_confirmation");
  }

  // Build human-readable candidate message
  const applyCandidateMessage = _buildApplyCandidateMessage({
    candidateStatus,
    candidateMode,
    includedActions,
    excludedActions,
    guardrails,
    approvalChecklist,
    finalPreconditions,
    candidateOwner: ownership.candidateOwner,
  });

  // Build the candidate object
  const applyCandidate = {
    // Identity
    candidateId:                   `candidate-${Date.now()}-${agentCase.agentCaseId}`,
    agentCaseId:                   agentCase.agentCaseId,
    proposalId:                    applyReadiness.proposalId,
    draftId:                       actionDraft.draftId,
    previewId:                     executionPreview ? executionPreview.previewId : null,
    candidateVersion:              1,

    // Status
    candidateStatus,
    candidateMode,
    candidateReadyForFinalApproval,
    candidateBlocked,
    candidateBlockedReason:        candidateBlocked ? "Blockierende Faktoren oder Sicherheitsbedenken verhindern die Freigabe" : null,
    scopeLocked,
    requiresScopeConfirmation,

    // Scope
    candidateScope,
    candidateSummary:              actionDraft.draftSummary || "",
    candidateReason:               actionDraft.draftReason || applyReadiness.readinessReason || "",
    includedActions,
    excludedActions,
    allowedApplyTargets,
    disallowedApplyTargets,

    // Guardrails
    guardrails,

    // Approval gate
    approvalChecklist,
    finalPreconditions,
    missingApprovals,

    // Ownership
    candidateOwner:                ownership.candidateOwner,
    gateOwner:                     ownership.gateOwner,
    proposalOwner:                 ownership.proposalOwner,
    secondaryAgent:                ownership.secondaryAgent,
    handoffSuggested:              ownership.handoffSuggested,
    needsCrossAgentReview:         ownership.needsCrossAgentReview,
    finalApprovalOwner:            ownership.finalApprovalOwner,

    // Human-readable message
    applyCandidateMessage,

    // Lifecycle
    candidateGeneratedAt:          new Date().toISOString(),
    candidateGeneratedByAgent:     agentCase.agentRole,
    dryRunOnly:                    true,
  };

  // Attach to agent case
  agentCase.applyCandidate19 = applyCandidate;

  // Record candidate chat message
  _recordAgentChatMessage({
    agentCaseId:                 agentCase.agentCaseId,
    agentRole:                   agentCase.agentRole,
    messageType:                 "apply_candidate",
    messageIntent:               "candidate_prepared",
    messagePriority:             candidateBlocked ? "high" : candidateReadyForFinalApproval ? "high" : "normal",
    requiresUserDecision:        true,
    message:                     applyCandidateMessage,
    problemType:                 agentCase.problemType,
    // Step 19 fields
    candidateStatus,
    candidateMode,
    scopeLocked,
    candidateReadyForFinalApproval,
    nextApprovalStep:            candidateBlocked
      ? "resolve_blockers"
      : requiresScopeConfirmation
        ? "confirm_scope"
        : candidateReadyForFinalApproval
          ? "final_user_decision"
          : "await_prerequisites",
  });

  // Logging
  logger.info("[agentBridge] Step 19 – Apply Candidate erzeugt", {
    agentCaseId:                 agentCase.agentCaseId,
    candidateStatus,
    candidateMode,
    candidateReadyForFinalApproval,
    candidateBlocked,
    scopeLocked,
    requiresScopeConfirmation,
    candidateOwner:              ownership.candidateOwner,
    gateOwner:                   ownership.gateOwner,
    finalApprovalOwner:          ownership.finalApprovalOwner,
    includedActionCount:         includedActions.length,
    excludedActionCount:         excludedActions.length,
    guardrailCount:              guardrails.length,
    preconditionCount:           finalPreconditions.length,
    checklistItemCount:          approvalChecklist.length,
    missingApprovalCount:        missingApprovals.length,
    dryRunOnly:                  true,
  });

  // Step 20: Build controlled execution session after apply candidate
  _buildExecutionSession(agentCase);

  return applyCandidate;
}

/**
 * Get a summary of all apply candidates across agent cases.
 * Provides the operator a clear view of candidate / approval gate status.
 *
 * @returns {Object} apply candidate summary
 */
function getApplyCandidateSummary() {
  const byCandidateStatus = {};
  const byCandidateMode = {};
  const byCandidateOwner = { deepseek_backend: 0, gemini_frontend: 0 };
  const byGuardrailType = {};

  let totalWithCandidate = 0;
  let totalReadyForFinalApproval = 0;
  let totalBlocked = 0;
  let totalScopeConfirmationNeeded = 0;
  let totalCrossAgentPending = 0;
  let totalDiagnosisOnly = 0;
  let totalPartial = 0;

  const candidateCases = [];
  const commonMissingApprovals = {};
  const commonPreconditions = {};

  for (const agentCase of _agentCaseRegistry.values()) {
    const ac = agentCase.applyCandidate19 || null;
    if (!ac) continue;

    totalWithCandidate += 1;

    // By candidate status
    byCandidateStatus[ac.candidateStatus] = (byCandidateStatus[ac.candidateStatus] || 0) + 1;

    // By candidate mode
    byCandidateMode[ac.candidateMode] = (byCandidateMode[ac.candidateMode] || 0) + 1;

    // By candidate owner
    if (byCandidateOwner[ac.candidateOwner] !== undefined) {
      byCandidateOwner[ac.candidateOwner] += 1;
    }

    // Guardrail type distribution
    for (const g of ac.guardrails || []) {
      if (g.active) {
        byGuardrailType[g.type] = (byGuardrailType[g.type] || 0) + 1;
      }
    }

    // Counts
    if (ac.candidateReadyForFinalApproval) totalReadyForFinalApproval += 1;
    if (ac.candidateBlocked) totalBlocked += 1;
    if (ac.candidateStatus === "candidate_scope_confirmation_needed") totalScopeConfirmationNeeded += 1;
    if (ac.candidateStatus === "candidate_cross_agent_pending") totalCrossAgentPending += 1;
    if (ac.candidateStatus === "candidate_diagnosis_only") totalDiagnosisOnly += 1;
    if (ac.candidateStatus === "candidate_partial") totalPartial += 1;

    // Track common missing approvals
    for (const ma of ac.missingApprovals || []) {
      commonMissingApprovals[ma] = (commonMissingApprovals[ma] || 0) + 1;
    }

    // Track common preconditions
    for (const pc of ac.finalPreconditions || []) {
      commonPreconditions[pc] = (commonPreconditions[pc] || 0) + 1;
    }

    candidateCases.push({
      agentCaseId:                   agentCase.agentCaseId,
      agentRole:                     agentCase.agentRole,
      problemType:                   agentCase.problemType,
      problemTitle:                  agentCase.problemTitle,
      candidateStatus:               ac.candidateStatus,
      candidateMode:                 ac.candidateMode,
      candidateReadyForFinalApproval: ac.candidateReadyForFinalApproval,
      candidateBlocked:              ac.candidateBlocked,
      scopeLocked:                   ac.scopeLocked,
      requiresScopeConfirmation:     ac.requiresScopeConfirmation,
      candidateOwner:                ac.candidateOwner,
      gateOwner:                     ac.gateOwner,
      finalApprovalOwner:            ac.finalApprovalOwner,
      needsCrossAgentReview:         ac.needsCrossAgentReview,
      includedActionCount:           (ac.includedActions || []).length,
      excludedActionCount:           (ac.excludedActions || []).length,
      guardrailCount:                (ac.guardrails || []).length,
      missingApprovalCount:          (ac.missingApprovals || []).length,
      preconditionCount:             (ac.finalPreconditions || []).length,
      candidateGeneratedAt:          ac.candidateGeneratedAt,
    });
  }

  // Sort by candidateGeneratedAt (newest first)
  candidateCases.sort((a, b) => (b.candidateGeneratedAt || "").localeCompare(a.candidateGeneratedAt || ""));

  // Top missing approvals
  const topMissingApprovals = Object.entries(commonMissingApprovals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([approval, count]) => ({ approval, count }));

  // Top preconditions
  const topPreconditions = Object.entries(commonPreconditions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([precondition, count]) => ({ precondition, count }));

  return {
    totalAgentCases:               _agentCaseRegistry.size,
    totalWithCandidate,
    totalReadyForFinalApproval,
    totalBlocked,
    totalScopeConfirmationNeeded,
    totalCrossAgentPending,
    totalDiagnosisOnly,
    totalPartial,
    byCandidateStatus,
    byCandidateMode,
    byCandidateOwner,
    byGuardrailType,
    topMissingApprovals,
    topPreconditions,
    candidateCases:                candidateCases.slice(0, CANDIDATE_SUMMARY_MAX_ENTRIES),
    generatedAt:                   new Date().toISOString(),
  };
}

/* ─────────────────────────────────────────────
   Step 20: Controlled Execution Orchestrator /
   Apply Runtime / Audit & Kill Switch
   ─────────────────────────────────────────────
   Translates a final approved candidate into a
   controlled execution session with hard
   guardrails, abort/kill-switch paths, rollback
   reservation, and a full audit trail.

   The system NEVER auto-executes.  It prepares
   the runtime session – the user must explicitly
   start it.
   ───────────────────────────────────────────── */

/**
 * Derive the runtime status from a candidate's approval state,
 * guardrails, and readiness information.
 *
 * @param {Object} params
 * @returns {string} runtime status
 */
function _deriveRuntimeStatus({ applyCandidate, applyReadiness }) {
  if (!applyCandidate) return "runtime_not_created";

  if (applyCandidate.candidateBlocked) return "runtime_blocked";

  if (applyCandidate.candidateStatus === "candidate_diagnosis_only") return "runtime_not_created";

  if (!applyCandidate.candidateReadyForFinalApproval) {
    if (applyCandidate.candidateStatus === "candidate_cross_agent_pending") return "runtime_blocked";
    if (applyCandidate.candidateStatus === "candidate_scope_confirmation_needed") return "runtime_blocked";
    return "runtime_not_created";
  }

  // Candidate is approved – check guardrail completeness
  const guardrails = applyCandidate.guardrails || [];
  const allGuardrailsMet = guardrails.every(g => !g.active || g.satisfied !== false);
  if (!allGuardrailsMet) return "runtime_blocked";

  // Check for missing approvals
  const missingApprovals = applyCandidate.missingApprovals || [];
  if (missingApprovals.length > 0) return "runtime_blocked";

  // Check rollback requirements
  if (applyReadiness && applyReadiness.applyBlocked) return "runtime_blocked";

  return "runtime_awaiting_user_start";
}

/**
 * Derive the runtime mode from candidate mode and agent role.
 *
 * @param {Object} params
 * @returns {string} runtime mode
 */
function _deriveRuntimeMode({ applyCandidate, agentRole }) {
  if (!applyCandidate) return "dry_run";

  const cm = applyCandidate.candidateMode || "";

  if (cm === "diagnosis_only") return "dry_run";
  if (cm === "backend_only") return "backend_only";
  if (cm === "frontend_only") return "frontend_only";
  if (cm === "cross_agent_candidate") return "cross_agent_controlled";
  if (cm === "partial_scope") return "partial_apply";

  if (cm === "final_approval_candidate") {
    if (agentRole === "deepseek_backend") return "backend_only";
    if (agentRole === "gemini_frontend") return "frontend_only";
    return "controlled_apply";
  }

  return "dry_run";
}

/**
 * Derive the execution state from runtime status.
 *
 * @param {Object} params
 * @returns {string} execution state
 */
function _deriveExecutionState({ runtimeStatus }) {
  switch (runtimeStatus) {
    case "runtime_not_created":            return "pending";
    case "runtime_blocked":                return "blocked";
    case "runtime_ready":                  return "ready";
    case "runtime_awaiting_user_start":    return "ready";
    case "runtime_running":                return "active";
    case "runtime_completed":              return "finished";
    case "runtime_aborted":                return "stopped";
    case "runtime_failed":                 return "failed";
    case "runtime_rollback_reserved":      return "ready";
    default:                               return "pending";
  }
}

/**
 * Derive execution guardrails from candidate guardrails and runtime mode.
 * These are the hard constraints that govern the execution session.
 *
 * @param {Object} params
 * @returns {Array<Object>} execution guardrails
 */
function _deriveExecutionGuardrails({ applyCandidate, runtimeMode, runtimeStatus }) {
  const guardrails = [];

  // Always present: no auto-execute
  guardrails.push({
    type: "no_auto_execute",
    active: true,
    description: "Keine automatische Ausführung ohne explizite Benutzerfreigabe",
    enforced: true,
  });

  // Always present: requires user start
  guardrails.push({
    type: "requires_user_start",
    active: true,
    description: "Ausführung erfordert expliziten Startbefehl durch den Benutzer",
    enforced: true,
  });

  // Always present: scope locked
  guardrails.push({
    type: "scope_locked",
    active: true,
    description: "Der Ausführungsumfang ist auf den freigegebenen Kandidaten begrenzt",
    enforced: true,
  });

  // Always present: no scope expansion
  guardrails.push({
    type: "no_scope_expansion",
    active: true,
    description: "Keine Erweiterung des Ausführungsumfangs während der Laufzeit",
    enforced: true,
  });

  // Target restriction based on mode
  if (runtimeMode === "backend_only" || runtimeMode === "frontend_only") {
    guardrails.push({
      type: "target_restriction",
      active: true,
      description: runtimeMode === "backend_only"
        ? "Ausführung nur auf Backend-Ziele beschränkt"
        : "Ausführung nur auf Frontend-Ziele beschränkt",
      enforced: true,
    });
  }

  // Kill switch always required
  guardrails.push({
    type: "kill_switch_required",
    active: true,
    description: "Kill Switch bleibt während der gesamten Ausführung verfügbar",
    enforced: true,
  });

  // Abort path always required
  guardrails.push({
    type: "abort_path_required",
    active: true,
    description: "Kontrollierter Abbruchpfad ist jederzeit verfügbar",
    enforced: true,
  });

  // Rollback on failure
  const rollbackRequired = applyCandidate
    && applyCandidate.guardrails
    && applyCandidate.guardrails.some(g => g.type === "rollback_mandatory" && g.active);
  guardrails.push({
    type: "rollback_on_failure",
    active: true,
    description: rollbackRequired
      ? "Rollback ist bei Ausführungsfehler zwingend vorgesehen"
      : "Rollback-Vormerkung ist bei Ausführungsfehler vorgesehen",
    enforced: !!rollbackRequired,
  });

  // Cross-agent gate
  if (runtimeMode === "cross_agent_controlled") {
    guardrails.push({
      type: "cross_agent_gate",
      active: true,
      description: "Cross-Agent-Freigabe erforderlich vor Ausführung beider Seiten",
      enforced: true,
    });
  }

  return guardrails;
}

/**
 * Derive a runtime checklist based on candidate state and guardrails.
 *
 * @param {Object} params
 * @returns {Array<Object>} checklist items
 */
function _deriveRuntimeChecklist({ applyCandidate, runtimeStatus, runtimeMode }) {
  const checklist = [];

  // Candidate must be approved
  checklist.push({
    item: "Kandidat final freigegeben",
    required: true,
    completed: applyCandidate && applyCandidate.candidateReadyForFinalApproval === true,
  });

  // Guardrails must be complete
  const guardrailsComplete = applyCandidate
    && (applyCandidate.guardrails || []).every(g => !g.active || g.satisfied !== false);
  checklist.push({
    item: "Alle Guardrails erfüllt",
    required: true,
    completed: !!guardrailsComplete,
  });

  // No missing approvals
  const noMissingApprovals = applyCandidate
    && (applyCandidate.missingApprovals || []).length === 0;
  checklist.push({
    item: "Keine fehlenden Freigaben",
    required: true,
    completed: !!noMissingApprovals,
  });

  // Scope confirmed
  checklist.push({
    item: "Ausführungsumfang bestätigt",
    required: true,
    completed: applyCandidate && applyCandidate.scopeLocked === true,
  });

  // User start confirmation pending
  checklist.push({
    item: "Benutzer-Startfreigabe erteilt",
    required: true,
    completed: runtimeStatus === "runtime_running" || runtimeStatus === "runtime_completed",
  });

  // Cross-agent review (conditional)
  if (runtimeMode === "cross_agent_controlled") {
    checklist.push({
      item: "Cross-Agent-Review abgeschlossen",
      required: true,
      completed: applyCandidate && !applyCandidate.needsCrossAgentReview,
    });
  }

  return checklist;
}

/**
 * Derive runtime ownership based on agent role and candidate mode.
 *
 * @param {Object} params
 * @returns {Object} ownership info
 */
function _deriveRuntimeOwnership({ agentRole, runtimeMode }) {
  const isBackend = agentRole === "deepseek_backend";

  let runtimeOwner = agentRole;
  let executionOwner = agentRole;
  let secondaryAgent = isBackend ? "gemini_frontend" : "deepseek_backend";
  let handoffSuggested = false;
  let needsCrossAgentReview = false;

  if (runtimeMode === "cross_agent_controlled") {
    needsCrossAgentReview = true;
    handoffSuggested = true;
  }

  if (runtimeMode === "backend_only") {
    runtimeOwner = "deepseek_backend";
    executionOwner = "deepseek_backend";
  } else if (runtimeMode === "frontend_only") {
    runtimeOwner = "gemini_frontend";
    executionOwner = "gemini_frontend";
  }

  return {
    runtimeOwner,
    executionOwner,
    gateOwner: agentRole,
    secondaryAgent,
    handoffSuggested,
    needsCrossAgentReview,
    finalApprovalOwner: "user",
  };
}

/**
 * Derive the reason why execution is blocked, if applicable.
 *
 * @param {Object} params
 * @returns {string|null} blocked reason or null
 */
function _deriveExecutionBlockedReason({ runtimeStatus, applyCandidate }) {
  if (runtimeStatus !== "runtime_blocked") return null;

  if (applyCandidate && applyCandidate.candidateBlocked) {
    return applyCandidate.candidateBlockedReason || "Kandidat ist blockiert – Freigabe nicht möglich";
  }

  if (applyCandidate && applyCandidate.candidateStatus === "candidate_cross_agent_pending") {
    return "Cross-Agent-Freigabe steht noch aus";
  }

  if (applyCandidate && applyCandidate.candidateStatus === "candidate_scope_confirmation_needed") {
    return "Scope-Bestätigung erforderlich bevor Runtime gestartet werden kann";
  }

  if (applyCandidate && (applyCandidate.missingApprovals || []).length > 0) {
    return `Fehlende Freigaben: ${applyCandidate.missingApprovals.join(", ")}`;
  }

  const incompleteGuardrails = (applyCandidate?.guardrails || []).filter(g => g.active && g.satisfied === false);
  if (incompleteGuardrails.length > 0) {
    return `Unerfüllte Guardrails: ${incompleteGuardrails.map(g => g.type).join(", ")}`;
  }

  return "Runtime-Voraussetzungen nicht vollständig erfüllt";
}

/**
 * Build a human-readable, cooperative German message
 * describing the execution session state.
 *
 * @param {Object} params
 * @returns {string} message
 */
function _buildExecutionSessionMessage({
  runtimeStatus,
  runtimeMode,
  executionState,
  executionAllowed,
  executionBlocked,
  executionBlockedReason,
  runtimeOwner,
  abortAvailable,
  killSwitchAvailable,
  rollbackReserved,
  runtimeChecklist,
  runtimeGuardrails,
}) {
  const parts = [];

  if (executionBlocked) {
    parts.push("Ich habe die Ausführungssitzung vorbereitet, aber sie bleibt derzeit blockiert.");
    if (executionBlockedReason) {
      parts.push(`Grund: ${executionBlockedReason}`);
    }
    parts.push("Sobald die offenen Punkte geklärt sind, kann die Sitzung freigegeben werden.");
  } else if (executionAllowed) {
    parts.push("Ich habe eine kontrollierte Ausführungssitzung vorbereitet.");
    parts.push("Diese Sitzung ist auf den freigegebenen Kandidaten begrenzt.");
    parts.push("Die Ausführung bleibt blockiert, bis du final bestätigst.");
  } else {
    parts.push("Es wurde noch keine Ausführungssitzung erstellt.");
    parts.push("Dafür wird zunächst ein final freigegebener Kandidat benötigt.");
    return parts.join("\n");
  }

  // Scope description
  if (runtimeMode === "backend_only") {
    parts.push("\nDer Ausführungsumfang ist auf Backend-Änderungen beschränkt (APIs, Code, Datenfluss, Mapping, Routen).");
  } else if (runtimeMode === "frontend_only") {
    parts.push("\nDer Ausführungsumfang ist auf Frontend-Änderungen beschränkt (UX, Design, Darstellung, Beschriftung).");
  } else if (runtimeMode === "cross_agent_controlled") {
    parts.push("\nDie Ausführung erfordert koordinierte Änderungen auf Backend- und Frontend-Seite.");
  } else if (runtimeMode === "partial_apply") {
    parts.push("\nEs handelt sich um eine Teilanwendung – nicht alle Bereiche sind betroffen.");
  } else if (runtimeMode === "dry_run") {
    parts.push("\nDies ist ein Probelauf – keine echten Änderungen werden durchgeführt.");
  }

  // Guardrail summary
  const activeGuardrails = (runtimeGuardrails || []).filter(g => g.active);
  if (activeGuardrails.length > 0) {
    parts.push(`\nAktive Laufzeit-Guardrails: ${activeGuardrails.length}`);
    for (const g of activeGuardrails.slice(0, 4)) {
      parts.push(`- ${g.description}`);
    }
    if (activeGuardrails.length > 4) {
      parts.push(`- … und ${activeGuardrails.length - 4} weitere`);
    }
  }

  // Checklist summary
  const pendingItems = (runtimeChecklist || []).filter(c => c.required && !c.completed);
  if (pendingItems.length > 0) {
    parts.push(`\nOffene Prüfpunkte: ${pendingItems.length}`);
    for (const c of pendingItems) {
      parts.push(`- ${c.item}`);
    }
  }

  // Safety features
  const safetyNotes = [];
  if (abortAvailable) safetyNotes.push("Ein Abbruch ist jederzeit vorgesehen");
  if (killSwitchAvailable) safetyNotes.push("Kill Switch bleibt verfügbar");
  if (rollbackReserved) safetyNotes.push("Der Rückweg bleibt vorgemerkt, falls Probleme auftreten");
  if (safetyNotes.length > 0) {
    parts.push(`\n${safetyNotes.join(". ")}.`);
  }

  // Next step
  if (executionAllowed && !executionBlocked) {
    parts.push("\nFür den nächsten Schritt brauche ich noch deine letzte Startfreigabe.");
  } else if (executionBlocked) {
    parts.push("\nSobald die Blockierungsgründe beseitigt sind, kann ich die Sitzung zur Startfreigabe vorbereiten.");
  }

  return parts.join("\n");
}

/**
 * Build a complete controlled execution session / apply runtime
 * for an agent case that has an approved apply candidate.
 *
 * This is the central Step 20 function.
 *
 * @param {Object} agentCase - the agent case with applyCandidate19
 * @returns {Object|null} execution session or null
 */
function _buildExecutionSession(agentCase) {
  if (!agentCase) return null;

  const applyCandidate = agentCase.applyCandidate19;
  const applyReadiness = agentCase.applyReadiness17;
  const actionDraft = agentCase.actionDraft16;
  if (!applyCandidate) return null;

  // Derive runtime status
  const runtimeStatus = _deriveRuntimeStatus({ applyCandidate, applyReadiness });

  // Skip if no runtime can be created
  if (runtimeStatus === "runtime_not_created") return null;

  // Derive runtime mode
  const runtimeMode = _deriveRuntimeMode({
    applyCandidate,
    agentRole: agentCase.agentRole,
  });

  // Derive execution state
  const executionState = _deriveExecutionState({ runtimeStatus });

  // Derive execution guardrails
  const runtimeGuardrails = _deriveExecutionGuardrails({
    applyCandidate,
    runtimeMode,
    runtimeStatus,
  });

  // Derive runtime checklist
  const runtimeChecklist = _deriveRuntimeChecklist({
    applyCandidate,
    runtimeStatus,
    runtimeMode,
  });

  // Derive ownership
  const ownership = _deriveRuntimeOwnership({
    agentRole: agentCase.agentRole,
    runtimeMode,
  });

  // Derive execution flags
  const executionBlocked = runtimeStatus === "runtime_blocked";
  const executionAllowed = runtimeStatus === "runtime_awaiting_user_start" || runtimeStatus === "runtime_ready";
  const executionBlockedReason = _deriveExecutionBlockedReason({ runtimeStatus, applyCandidate });

  // Abort / Kill Switch / Rollback
  const abortAvailable = true;
  const killSwitchAvailable = true;
  const rollbackReserved = (applyCandidate.guardrails || []).some(g => g.type === "rollback_mandatory" && g.active)
    || runtimeMode !== "dry_run";
  const rollbackOnFailure = rollbackReserved;

  // Build human-readable message
  const executionSessionMessage = _buildExecutionSessionMessage({
    runtimeStatus,
    runtimeMode,
    executionState,
    executionAllowed,
    executionBlocked,
    executionBlockedReason,
    runtimeOwner: ownership.runtimeOwner,
    abortAvailable,
    killSwitchAvailable,
    rollbackReserved,
    runtimeChecklist,
    runtimeGuardrails,
  });

  // Build audit trail seed
  const now = new Date().toISOString();
  const executionAudit = [
    {
      event: "session_created",
      timestamp: now,
      runtimeStatus,
      runtimeMode,
      executionState,
      agent: agentCase.agentRole,
      detail: executionBlocked
        ? `Session erstellt, aber blockiert: ${executionBlockedReason || "unbekannt"}`
        : "Kontrollierte Ausführungssitzung erstellt und bereit für Startfreigabe",
    },
  ];

  // Build the execution session object
  const executionSession = {
    // Identity
    runtimeId:                     `runtime-${Date.now()}-${agentCase.agentCaseId}`,
    agentCaseId:                   agentCase.agentCaseId,
    candidateId:                   applyCandidate.candidateId,
    proposalId:                    applyCandidate.proposalId,
    draftId:                       applyCandidate.draftId,
    runtimeVersion:                1,

    // Status
    runtimeStatus,
    runtimeMode,
    executionState,
    executionAllowed,
    executionBlocked,
    executionBlockedReason,

    // Lifecycle timestamps
    executionStartedAt:            null,
    executionCompletedAt:          null,
    executionAbortedAt:            null,
    sessionCreatedAt:              now,

    // Scope
    executionScope: {
      affectedLayers:              applyCandidate.candidateScope?.affectedLayers || [],
      affectedTargets:             applyCandidate.candidateScope?.affectedTargets || [],
      allowedApplyTargets:         applyCandidate.allowedApplyTargets || [],
      disallowedApplyTargets:      applyCandidate.disallowedApplyTargets || [],
      draftType:                   applyCandidate.candidateScope?.draftType || null,
      changeCategory:              applyCandidate.candidateScope?.changeCategory || null,
    },

    // Guardrails
    runtimeGuardrails,
    runtimeChecklist,

    // Abort / Kill Switch / Rollback
    abortAvailable,
    killSwitchAvailable,
    abortRequested:                false,
    abortExecuted:                 false,
    abortReason:                   null,
    killSwitchRequested:           false,
    killSwitchReason:              null,
    rollbackReserved,
    rollbackOnFailure,
    rollbackReservation: rollbackReserved ? {
      reserved:    true,
      reservedAt:  now,
      reason:      "Automatische Rollback-Vormerkung bei kontrollierter Ausführung",
      triggeredAt: null,
      completed:   false,
    } : null,

    // Ownership
    runtimeOwner:                  ownership.runtimeOwner,
    executionOwner:                ownership.executionOwner,
    gateOwner:                     ownership.gateOwner,
    secondaryAgent:                ownership.secondaryAgent,
    handoffSuggested:              ownership.handoffSuggested,
    needsCrossAgentReview:         ownership.needsCrossAgentReview,
    finalApprovalOwner:            ownership.finalApprovalOwner,

    // Audit trail
    executionAudit,
    statusTransitions: [
      { from: null, to: runtimeStatus, at: now, reason: "Session erstellt" },
    ],

    // Summary
    executionSummary:              null,
    runtimeNotes:                  [],

    // Human-readable message
    executionSessionMessage,

    // Safety
    dryRunOnly:                    true,
    executionGeneratedAt:          now,
    executionGeneratedByAgent:     agentCase.agentRole,
  };

  // Attach to agent case
  agentCase.executionSession20 = executionSession;

  // Record runtime chat message
  _recordAgentChatMessage({
    agentCaseId:                 agentCase.agentCaseId,
    agentRole:                   agentCase.agentRole,
    messageType:                 "execution_session",
    messageIntent:               "runtime_prepared",
    messagePriority:             executionBlocked ? "high" : executionAllowed ? "high" : "normal",
    requiresUserDecision:        true,
    message:                     executionSessionMessage,
    problemType:                 agentCase.problemType,
    // Step 20 fields
    runtimeStatus,
    runtimeMode,
    executionState,
    executionAllowed,
    executionBlocked,
    abortAvailable,
    killSwitchAvailable,
    rollbackReserved,
    nextRuntimeStep:             executionBlocked
      ? "resolve_runtime_blockers"
      : executionAllowed
        ? "user_start_confirmation"
        : "await_candidate_approval",
  });

  // Logging
  logger.info("[agentBridge] Step 20 – Controlled Execution Session erzeugt", {
    agentCaseId:                 agentCase.agentCaseId,
    runtimeId:                   executionSession.runtimeId,
    runtimeStatus,
    runtimeMode,
    executionState,
    executionAllowed,
    executionBlocked,
    executionBlockedReason:      executionBlockedReason || null,
    runtimeOwner:                ownership.runtimeOwner,
    executionOwner:              ownership.executionOwner,
    gateOwner:                   ownership.gateOwner,
    finalApprovalOwner:          ownership.finalApprovalOwner,
    abortAvailable,
    killSwitchAvailable,
    rollbackReserved,
    rollbackOnFailure,
    guardrailCount:              runtimeGuardrails.length,
    checklistItemCount:          runtimeChecklist.length,
    auditEntryCount:             executionAudit.length,
    dryRunOnly:                  true,
  });

  return executionSession;
}

/**
 * Get a summary of all execution runtime sessions across agent cases.
 * Provides the operator a clear view of runtime / execution status.
 *
 * @returns {Object} execution runtime summary
 */
function getExecutionRuntimeSummary() {
  const byRuntimeStatus = {};
  const byRuntimeMode = {};
  const byExecutionState = {};
  const byRuntimeOwner = { deepseek_backend: 0, gemini_frontend: 0 };
  const byGuardrailType = {};

  let totalWithRuntime = 0;
  let totalBlocked = 0;
  let totalReady = 0;
  let totalAwaitingStart = 0;
  let totalRunning = 0;
  let totalCompleted = 0;
  let totalAborted = 0;
  let totalFailed = 0;
  let totalWithKillSwitch = 0;
  let totalWithAbort = 0;
  let totalWithRollback = 0;

  const runtimeCases = [];
  const commonBlockReasons = {};

  for (const agentCase of _agentCaseRegistry.values()) {
    const es = agentCase.executionSession20 || null;
    if (!es) continue;

    totalWithRuntime += 1;

    // By runtime status
    byRuntimeStatus[es.runtimeStatus] = (byRuntimeStatus[es.runtimeStatus] || 0) + 1;

    // By runtime mode
    byRuntimeMode[es.runtimeMode] = (byRuntimeMode[es.runtimeMode] || 0) + 1;

    // By execution state
    byExecutionState[es.executionState] = (byExecutionState[es.executionState] || 0) + 1;

    // By runtime owner
    if (byRuntimeOwner[es.runtimeOwner] !== undefined) {
      byRuntimeOwner[es.runtimeOwner] += 1;
    }

    // Guardrail type distribution
    for (const g of es.runtimeGuardrails || []) {
      if (g.active) {
        byGuardrailType[g.type] = (byGuardrailType[g.type] || 0) + 1;
      }
    }

    // Counts
    if (es.runtimeStatus === "runtime_blocked") totalBlocked += 1;
    if (es.runtimeStatus === "runtime_ready") totalReady += 1;
    if (es.runtimeStatus === "runtime_awaiting_user_start") totalAwaitingStart += 1;
    if (es.runtimeStatus === "runtime_running") totalRunning += 1;
    if (es.runtimeStatus === "runtime_completed") totalCompleted += 1;
    if (es.runtimeStatus === "runtime_aborted") totalAborted += 1;
    if (es.runtimeStatus === "runtime_failed") totalFailed += 1;
    if (es.killSwitchAvailable) totalWithKillSwitch += 1;
    if (es.abortAvailable) totalWithAbort += 1;
    if (es.rollbackReserved) totalWithRollback += 1;

    // Track common block reasons
    if (es.executionBlockedReason) {
      commonBlockReasons[es.executionBlockedReason] = (commonBlockReasons[es.executionBlockedReason] || 0) + 1;
    }

    runtimeCases.push({
      agentCaseId:             agentCase.agentCaseId,
      agentRole:               agentCase.agentRole,
      problemType:             agentCase.problemType,
      problemTitle:            agentCase.problemTitle,
      runtimeId:               es.runtimeId,
      runtimeStatus:           es.runtimeStatus,
      runtimeMode:             es.runtimeMode,
      executionState:          es.executionState,
      executionAllowed:        es.executionAllowed,
      executionBlocked:        es.executionBlocked,
      runtimeOwner:            es.runtimeOwner,
      executionOwner:          es.executionOwner,
      finalApprovalOwner:      es.finalApprovalOwner,
      abortAvailable:          es.abortAvailable,
      killSwitchAvailable:     es.killSwitchAvailable,
      rollbackReserved:        es.rollbackReserved,
      rollbackOnFailure:       es.rollbackOnFailure,
      guardrailCount:          (es.runtimeGuardrails || []).length,
      checklistItemCount:      (es.runtimeChecklist || []).length,
      auditEntryCount:         (es.executionAudit || []).length,
      sessionCreatedAt:        es.sessionCreatedAt,
      dryRunOnly:              es.dryRunOnly,
    });
  }

  // Sort by sessionCreatedAt (newest first)
  runtimeCases.sort((a, b) => (b.sessionCreatedAt || "").localeCompare(a.sessionCreatedAt || ""));

  // Top block reasons
  const topBlockReasons = Object.entries(commonBlockReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([reason, count]) => ({ reason, count }));

  return {
    totalAgentCases:             _agentCaseRegistry.size,
    totalWithRuntime,
    totalBlocked,
    totalReady,
    totalAwaitingStart,
    totalRunning,
    totalCompleted,
    totalAborted,
    totalFailed,
    totalWithKillSwitch,
    totalWithAbort,
    totalWithRollback,
    byRuntimeStatus,
    byRuntimeMode,
    byExecutionState,
    byRuntimeOwner,
    byGuardrailType,
    topBlockReasons,
    runtimeCases:                runtimeCases.slice(0, RUNTIME_SUMMARY_MAX_ENTRIES),
    generatedAt:                 new Date().toISOString(),
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

/* ─────────────────────────────────────────────
   Step 7: Recommendation Feedback /
   Improvement Loop Light
   ─────────────────────────────────────────────
   Accepts retrospective feedback on a previous
   recommendation.  This is NOT about real-time
   readiness (Step 6) – it is about learning
   which kinds of recommendations worked well
   and which did not.

   The system never auto-adjusts.  It stores
   the feedback so the HQS system can later
   derive improvement signals and produce
   better recommendations over time.
   ───────────────────────────────────────────── */

/**
 * Normalise a recommendation feedback category.
 * Falls back to "unclear" if the input is not recognised.
 */
function normaliseRecommendationFeedback(raw) {
  const s = toStr(raw).toLowerCase().replace(/[\s-]+/g, "_");
  return VALID_RECOMMENDATION_FEEDBACK_CATEGORIES.includes(s) ? s : "unclear";
}

/**
 * Normalise an improvement signal.
 * Falls back to "none" if the input is not recognised.
 */
function normaliseImprovementSignal(raw) {
  const s = toStr(raw).toLowerCase().replace(/[\s-]+/g, "_");
  return VALID_IMPROVEMENT_SIGNALS.includes(s) ? s : "none";
}

/**
 * Derive an improvement signal from the feedback category
 * when no explicit improvement signal is provided.
 *
 * Uses cooperative language – the system does not blame
 * any specific model or layer.
 */
function deriveImprovementSignal(feedbackCategory) {
  switch (feedbackCategory) {
    case "too_early":           return "timing_off";
    case "unclear":             return "too_generic";
    case "followup_was_better": return "followup_preferred";
    case "not_needed":          return "none";
    case "helpful":             return "none";
    case "usable":              return "none";
    default:                    return "none";
  }
}

/**
 * Submit retrospective feedback on a recommendation.
 *
 * @param {Object} payload
 * @param {string}  payload.patternKey                – pattern key of the original recommendation
 * @param {string}  payload.recommendationFeedback    – helpful|usable|too_early|unclear|not_needed|followup_was_better
 * @param {string}  [payload.improvementSignal]       – explicit improvement signal (optional)
 * @param {string}  [payload.notes]                   – optional free-text note
 * @param {string}  [payload.originalActionType]      – the recommended action type from the original signal
 * @param {string}  [payload.originalReadinessBand]   – the readiness band from the original signal
 * @param {string}  [payload.followupCategory]        – follow-up category if relevant
 * @param {string}  [payload.sourceCategory]          – source category of the original signal
 * @returns {Object} acknowledgement with derived improvement context
 */
function submitRecommendationFeedback(payload = {}) {
  const patternKey = toStr(payload.patternKey);
  const feedbackCategory = normaliseRecommendationFeedback(payload.recommendationFeedback);
  const notes = capText(payload.notes, 500);

  // Derive or normalise improvement signal
  const explicitImprovement = payload.improvementSignal
    ? normaliseImprovementSignal(payload.improvementSignal)
    : null;
  const improvementSignal = explicitImprovement || deriveImprovementSignal(feedbackCategory);

  // Capture context from original recommendation (if provided)
  const originalActionType    = toStr(payload.originalActionType) || null;
  const originalReadinessBand = toStr(payload.originalReadinessBand) || null;
  const followupCategory      = toStr(payload.followupCategory) || null;
  const sourceCategory        = toStr(payload.sourceCategory) || null;

  const entry = {
    receivedAt:             new Date().toISOString(),
    patternKey:             patternKey || null,
    recommendationFeedback: feedbackCategory,
    improvementSignal,
    notes:                  notes || null,
    originalActionType,
    originalReadinessBand,
    followupCategory,
    sourceCategory,
  };

  // Store in log (trim at threshold to reduce allocations)
  _recommendationFeedbackLog.push(entry);
  if (_recommendationFeedbackLog.length > MAX_RECOMMENDATION_FEEDBACK_ENTRIES + 20) {
    _recommendationFeedbackLog = _recommendationFeedbackLog.slice(
      -MAX_RECOMMENDATION_FEEDBACK_ENTRIES
    );
  }

  // ── Update pattern memory with improvement tallies ──
  if (patternKey && _patternMemory.has(patternKey)) {
    const patternEntry = _patternMemory.get(patternKey);
    patternEntry.feedbackTally = patternEntry.feedbackTally || {};
    patternEntry.feedbackTally[feedbackCategory] =
      (patternEntry.feedbackTally[feedbackCategory] || 0) + 1;

    patternEntry.improvementTally = patternEntry.improvementTally || {};
    if (improvementSignal !== "none") {
      patternEntry.improvementTally[improvementSignal] =
        (patternEntry.improvementTally[improvementSignal] || 0) + 1;
    }

    _patternMemory.set(patternKey, patternEntry);
  }

  // ── Step 7: Recommendation feedback logging ──
  logger.info("[agentBridge] recommendation feedback received (Step 7)", {
    patternKey:             patternKey || "(kein Muster)",
    recommendationFeedback: feedbackCategory,
    improvementSignal,
    originalActionType,
    originalReadinessBand,
    followupCategory,
    sourceCategory,
    hasNotes:               !!(notes && notes.length >= 5),
  });

  // Log readiness vs improvement separation for transparency
  if (originalReadinessBand && feedbackCategory) {
    const mismatch =
      (originalReadinessBand === "mature_recommendation" && ["too_early", "unclear", "not_needed"].includes(feedbackCategory)) ||
      (originalReadinessBand === "observation" && ["helpful", "usable"].includes(feedbackCategory));
    if (mismatch) {
      logger.info("[agentBridge] readiness ↔ improvement divergence (Step 7)", {
        originalReadinessBand,
        recommendationFeedback: feedbackCategory,
        insight: originalReadinessBand === "observation"
          ? "Beobachtungssignal war rückblickend hilfreich – Readiness war konservativ."
          : "Reife Empfehlung war rückblickend zu früh oder unklar – Readiness war zu optimistisch.",
      });
    }
  }

  return {
    accepted:               true,
    receivedAt:             entry.receivedAt,
    recommendationFeedback: feedbackCategory,
    improvementSignal,
    patternKey:             patternKey || null,
    patternFound:           !!(patternKey && _patternMemory.has(patternKey)),
  };
}

/* ─────────────────────────────────────────────
   Step 7: Recommendation Improvement Summary
   ─────────────────────────────────────────────
   Returns a lightweight overview of how
   recommendations have performed in retrospect.

   Dimensions:
   - feedback distribution (helpful / usable / too_early / ...)
   - improvement signal distribution
   - recommendation types that tend to be helpful vs. too early
   - readiness vs. improvement cross-reference
   - follow-up categories that worked well

   This is purely observational.  It does NOT
   auto-adjust anything.
   ───────────────────────────────────────────── */

/**
 * Build an aggregated recommendation improvement overview
 * from the recommendation feedback log and pattern memory.
 *
 * @returns {Object} improvement summary
 */
function getRecommendationImprovementSummary() {
  // ── Aggregate from feedback log ──
  const feedbackDistribution = {};
  const improvementDistribution = {};
  const actionTypeVsFeedback = {};
  const readinessVsFeedback = {};
  const followupVsFeedback = {};
  const sourceVsFeedback = {};

  for (const entry of _recommendationFeedbackLog) {
    // Feedback distribution
    feedbackDistribution[entry.recommendationFeedback] =
      (feedbackDistribution[entry.recommendationFeedback] || 0) + 1;

    // Improvement signal distribution
    if (entry.improvementSignal && entry.improvementSignal !== "none") {
      improvementDistribution[entry.improvementSignal] =
        (improvementDistribution[entry.improvementSignal] || 0) + 1;
    }

    // Action type vs. feedback cross-reference
    if (entry.originalActionType) {
      const atKey = `${entry.originalActionType}→${entry.recommendationFeedback}`;
      actionTypeVsFeedback[atKey] = (actionTypeVsFeedback[atKey] || 0) + 1;
    }

    // Readiness vs. feedback cross-reference (key separation dimension)
    if (entry.originalReadinessBand) {
      const rvfKey = `${entry.originalReadinessBand}→${entry.recommendationFeedback}`;
      readinessVsFeedback[rvfKey] = (readinessVsFeedback[rvfKey] || 0) + 1;
    }

    // Follow-up category vs. feedback
    if (entry.followupCategory) {
      const fcKey = `${entry.followupCategory}→${entry.recommendationFeedback}`;
      followupVsFeedback[fcKey] = (followupVsFeedback[fcKey] || 0) + 1;
    }

    // Source category vs. feedback
    if (entry.sourceCategory) {
      const scKey = `${entry.sourceCategory}→${entry.recommendationFeedback}`;
      sourceVsFeedback[scKey] = (sourceVsFeedback[scKey] || 0) + 1;
    }
  }

  // ── Aggregate improvement tallies from pattern memory ──
  const patternImprovementInsights = [];
  for (const entry of _patternMemory.values()) {
    if (!entry.feedbackTally || Object.keys(entry.feedbackTally).length === 0) continue;

    const dominantFeedback = _topKey(entry.feedbackTally);
    const dominantImprovement = _topKey(entry.improvementTally);
    const totalFeedback = Object.values(entry.feedbackTally).reduce((a, b) => a + b, 0);

    patternImprovementInsights.push({
      patternKey:             entry.patternKey,
      observationCount:       entry.count,
      feedbackCount:          totalFeedback,
      dominantFeedback,
      dominantImprovement:    dominantImprovement || "none",
      dominantReadiness:      _topKey(entry.readinessTally),
      dominantActionType:     _topKey(entry.actionTypeTally),
      feedbackTally:          entry.feedbackTally,
      improvementTally:       entry.improvementTally || {},
    });
  }

  // Sort by feedback count (most feedback first)
  patternImprovementInsights.sort((a, b) => b.feedbackCount - a.feedbackCount);

  return {
    totalFeedbackEntries:       _recommendationFeedbackLog.length,
    feedbackDistribution,
    improvementDistribution,
    actionTypeVsFeedback,
    readinessVsFeedback,
    followupVsFeedback,
    sourceVsFeedback,
    patternImprovementInsights: patternImprovementInsights.slice(0, 30),
    generatedAt:                new Date().toISOString(),
  };
}

/* ─────────────────────────────────────────────────────────────────────
   Step 21: Agent Conversation Runtime / Persistent Case Chat /
            Freeform Admin Dialogue
   ─────────────────────────────────────────────────────────────────────
   Adds a real conversational dialogue layer on top of agent cases.
   The user can write free-form messages and the system routes them
   to DeepSeek (backend) or Gemini (frontend) with cooperative,
   human-readable replies.

   Principles:
   - cooperative, not autonomous
   - no automatic execution
   - natural, clear German dialogue language
   - clean role separation: DeepSeek = backend, Gemini = frontend
   - compatible with Steps 14-20

   Key functions:
   - getOrCreateConversationThread()  – ensures a thread exists per case
   - sendUserMessage()                – accepts free user messages
   - _routeToAgent()                  – determines which agent should reply
   - _generateAgentReply()            – builds cooperative dialogue reply
   - _deriveMessageIntent()           – classifies user message intent
   - _deriveThreadStatus()            – manages thread state transitions
   - getConversationThread()          – retrieves thread with messages
   - getConversationSummary()         – summary across all threads
   ───────────────────────────────────────────────────────────────────── */

/**
 * Get or create a conversation thread for an agent case.
 * @param {string} agentCaseId
 * @returns {Object} thread object
 */
function getOrCreateConversationThread(agentCaseId) {
  if (_conversationThreads.has(agentCaseId)) {
    return _conversationThreads.get(agentCaseId);
  }

  const agentCase = _agentCaseRegistry.get(agentCaseId);

  const thread = {
    threadId: agentCaseId,
    caseId: agentCaseId,
    threadStatus: "thread_open",
    conversationState: "conversation_phase",
    conversationOpen: true,
    conversationMessages: [],
    lastUserMessageAt: null,
    lastAgentMessageAt: null,
    awaitingUserReply: false,
    awaitingAgentReply: false,
    lastSpeaker: null,
    nextSuggestedSpeaker: null,
    nextSuggestedIntent: null,
    dominantAgent: agentCase ? agentCase.agentRole : null,
    messageCount: 0,
    userMessageCount: 0,
    agentMessageCount: 0,
    deepseekMessageCount: 0,
    geminiMessageCount: 0,
    systemMessageCount: 0,
    conversationSummary: null,
    // Step 22: Cross-Agent Handoff / Coordinated Dialogue fields
    handoffStatus: "handoff_not_needed",
    crossAgentState: "single_agent",
    handoffFrom: null,
    handoffTo: null,
    handoffReason: null,
    supportingAgent: null,
    handoffCount: 0,
    lastHandoffAt: null,
    handoffHistory: [],
    // Step 23: Conversation Memory / Case Continuity / Memory Anchors
    caseMemory: {
      memoryVersion: 1,
      caseContinuityStatus: "continuity_not_started",
      memoryFreshness: "memory_empty",
      workingSummary: null,
      workingSummaryReady: false,
      agreedDirection: null,
      discardedDirections: [],
      openQuestions: [],
      resolvedPoints: [],
      caseDecisions: [],
      userPreferencesInCase: [],
      lastMeaningfulDecision: null,
      nextOpenStep: null,
      pendingClarifications: [],
      memoryAnchors: [],
      dominantMemoryOwner: null,
      lastContributingAgent: null,
      memoryContributors: [],
      lastMemorySource: null,
      memoryFocus: null,
      caseScope: null,
      memoryUpdatedAt: null,
      memoryUpdateCount: 0,
    },
    // Step 24: Action Options / Decision Framing
    decisionFrame: {
      decisionFrameVersion: 1,
      decisionFrameStatus: "options_not_ready",
      decisionMode: null,
      actionOptions: [],
      optionCount: 0,
      recommendedOptionId: null,
      recommendedBecause: null,
      conservativeOptionId: null,
      fastestOptionId: null,
      widestOptionId: null,
      safestOptionId: null,
      primaryDecisionAgent: null,
      secondaryDecisionAgent: null,
      crossAgentDecisionNeeded: false,
      decisionTradeoff: null,
      nextDecisionQuestion: null,
      narrowingHint: null,
      userDecisionNeeded: false,
      optionContrast: null,
      pendingDecisionReason: null,
      optionSummary: null,
      preferredStrategy: null,
      decisionContext: null,
      decisionFrameUpdatedAt: null,
      decisionFrameUpdateCount: 0,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  _conversationThreads.set(agentCaseId, thread);

  // Evict oldest threads if over limit
  if (_conversationThreads.size > CONVERSATION_THREAD_MAX_ENTRIES) {
    const oldestKey = _conversationThreads.keys().next().value;
    _conversationThreads.delete(oldestKey);
  }

  logger.info("[agentBridge] Step 21 – Conversation-Thread eröffnet", {
    threadId: agentCaseId,
    dominantAgent: thread.dominantAgent,
  });

  return thread;
}

/**
 * Route a message to the appropriate agent based on content analysis.
 * DeepSeek: backend / APIs / code / logic / data flow
 * Gemini: frontend / UX / design / presentation / clarity
 *
 * @param {string} userMessage
 * @param {Object} agentCase
 * @returns {{ speakerAgent: string, speakerRole: string, routingReason: string }}
 */
function _routeToAgent(userMessage, agentCase) {
  const lowerMsg = (userMessage || "").toLowerCase();

  let deepseekScore = 0;
  let geminiScore = 0;

  for (const kw of DEEPSEEK_ROUTING_KEYWORDS) {
    if (lowerMsg.includes(kw)) deepseekScore += 1;
  }
  for (const kw of GEMINI_ROUTING_KEYWORDS) {
    if (lowerMsg.includes(kw)) geminiScore += 1;
  }

  // Bias toward the case's dominant agent when scores are tied or both zero
  if (deepseekScore === geminiScore && agentCase) {
    if (agentCase.agentRole === "deepseek_backend" || agentCase.ownerAgent === "deepseek_backend") {
      deepseekScore += 1;
    } else if (agentCase.agentRole === "gemini_frontend" || agentCase.ownerAgent === "gemini_frontend") {
      geminiScore += 1;
    }
  }

  // Default to DeepSeek if still tied
  if (deepseekScore >= geminiScore) {
    return {
      speakerAgent: "deepseek",
      speakerRole: "backend_agent",
      routingReason: deepseekScore > 0
        ? "Nachricht bezieht sich auf Backend / API / Code / Logik"
        : "Standard-Routing zum Backend-Agenten",
    };
  }

  return {
    speakerAgent: "gemini",
    speakerRole: "frontend_agent",
    routingReason: "Nachricht bezieht sich auf Frontend / UX / Design / Darstellung",
  };
}

/**
 * Derive the intent of a user message from its content.
 * @param {string} userMessage
 * @returns {string} conversation intent
 */
function _deriveMessageIntent(userMessage) {
  const lower = (userMessage || "").toLowerCase();

  if (lower.includes("warum") || lower.includes("wieso") || lower.includes("weshalb") || lower.includes("?")) {
    return "question";
  }
  if (lower.includes("scope") || lower.includes("nur backend") || lower.includes("nur frontend") || lower.includes("enger") || lower.includes("breiter") || lower.includes("raus")) {
    return "scope_change";
  }
  if (lower.includes("erklär") || lower.includes("versteh") || lower.includes("genauer") || lower.includes("detail")) {
    return "clarification";
  }
  if (lower.includes("prüf") || lower.includes("ursache") || lower.includes("tiefer") || lower.includes("diagnos")) {
    return "diagnosis_request";
  }
  if (lower.includes("verfein") || lower.includes("anpass") || lower.includes("änder") || lower.includes("umstell")) {
    return "refinement";
  }
  if (lower.includes("freigab") || lower.includes("genehmig") || lower.includes("approve") || lower.includes("ableh") || lower.includes("reject")) {
    return "approval_feedback";
  }
  if (lower.includes("runtime") || lower.includes("ausführ") || lower.includes("apply") || lower.includes("starten")) {
    return "runtime_question";
  }
  if (lower.includes("vorschlag") || lower.includes("empfehl") || lower.includes("was würdest") || lower.includes("was wäre")) {
    return "recommendation";
  }
  if (lower.includes("weiter") || lower.includes("dazu noch") || lower.includes("außerdem") || lower.includes("und noch")) {
    return "follow_up";
  }

  return "freeform";
}

/**
 * Derive the conversation phase from thread and case context.
 * @param {Object} thread
 * @param {Object} agentCase
 * @returns {string}
 */
function _deriveConversationPhase(thread, agentCase) {
  if (!agentCase) return "conversation_phase";

  if (agentCase.executionSession20) return "runtime_execution_phase";
  if (agentCase.applyCandidate19) return "candidate_gate_phase";
  if (agentCase.executionPreview18) return "preview_safety_phase";
  if (agentCase.applyReadiness17) return "approval_phase";
  if (agentCase.actionDraft16) return "draft_phase";
  if (agentCase.refinedPlan15) return "refinement_phase";
  if (agentCase.feedbackHistory && agentCase.feedbackHistory.length > 0) return "feedback_phase";
  if (agentCase.recommendedFixes && agentCase.recommendedFixes.length > 0) return "solution_phase";
  if (agentCase.problemType) return "problem_phase";

  return "conversation_phase";
}

/**
 * Generate a cooperative, human-readable agent reply based on message intent and context.
 *
 * @param {Object} params
 * @param {string} params.speakerAgent - "deepseek" or "gemini"
 * @param {string} params.messageIntent
 * @param {string} params.userMessage
 * @param {Object} params.agentCase
 * @param {Object} params.thread
 * @returns {string} agent reply message
 */
function _generateAgentReply({ speakerAgent, messageIntent, userMessage, agentCase, thread }) {
  const isBackend = speakerAgent === "deepseek";
  const perspective = isBackend ? "Backend-Sicht" : "Frontend-Sicht";
  const domain = isBackend ? "Backend / API / Logik" : "Frontend / UX / Darstellung";
  const problemTitle = (agentCase && agentCase.problemTitle) || "den aktuellen Fall";

  const replies = {
    question: [
      `Ich habe mir den Fall nochmal genauer angesehen. Aus ${perspective} kann ich Folgendes sagen:`,
      `Das Thema berührt primär den Bereich ${domain}. Wenn du weitere Details brauchst, gehe ich gern tiefer rein.`,
      `Gute Frage. Aus ${perspective} liegt der Schwerpunkt bei ${problemTitle}. Ich schaue mir das weiter an, wenn du möchtest.`,
    ],
    clarification: [
      `Ich versuche es klarer einzuordnen. Aus ${perspective} geht es vor allem um: ${problemTitle}.`,
      `Lass mich das genauer erklären. Der relevante Bereich aus ${perspective} ist ${domain}.`,
      `Ich präzisiere gern. Aus ${perspective} sehe ich den Kern des Problems bei ${problemTitle}.`,
    ],
    scope_change: [
      `Verstanden. Ich passe den Scope an und konzentriere mich nur auf ${domain}.`,
      `Ich kann den Vorschlag enger fassen. Wenn du willst, grenze ich den Vorschlag nur auf ${isBackend ? "den API-Teil" : "den UI-Teil"} ein.`,
      `Ich reduziere den Scope wie gewünscht. ${isBackend ? "Frontend bleibt bewusst außen vor." : "Backend bleibt bewusst außen vor."}`,
    ],
    diagnosis_request: [
      `Ich schaue mir die Ursache nochmal tiefer an. Aus ${perspective} liegt das Problem wahrscheinlich bei ${problemTitle}.`,
      `Ich vertiefe die Diagnose. Aus ${perspective} prüfe ich jetzt gezielt den Bereich ${domain}.`,
      `Die Ursache wird genauer untersucht. Aus ${perspective} fokussiere ich mich auf die relevanten Zusammenhänge.`,
    ],
    refinement: [
      `Ich passe den Plan entsprechend an. Aus ${perspective} berücksichtige ich deine Rückmeldung.`,
      `Verstanden. Ich verfeinere den Vorschlag im Bereich ${domain} basierend auf deiner Eingabe.`,
      `Wenn du eine andere Idee hast, passe ich den Plan daran an. Aktuell fokussiere ich mich auf ${domain}.`,
    ],
    approval_feedback: [
      `Danke für deine Rückmeldung. Ich ordne sie ein und aktualisiere den Stand für ${problemTitle}.`,
      `Ich habe deine Entscheidung aufgenommen. Der Fall wird entsprechend weitergeführt.`,
      `Verstanden. Ich verarbeite dein Feedback und bereite den nächsten Schritt vor.`,
    ],
    runtime_question: [
      `Aus ${perspective} kann ich zum Ausführungsstatus Folgendes sagen: Der Fall befindet sich aktuell in der Vorbereitungsphase.`,
      `Zur Runtime: Aus ${perspective} ist die Ausführung derzeit nur als Probelauf vorgesehen. Keine autonome Aktion.`,
      `Ich bereite es vor, aber wende es noch nicht an. Du entscheidest, wann der nächste Schritt erfolgt.`,
    ],
    explanation: [
      `Aus ${perspective} erkläre ich den Zusammenhang: ${problemTitle} betrifft primär ${domain}.`,
      `Ich ordne den Fall ein. Aus ${perspective} sehe ich die Hauptursache im Bereich ${domain}.`,
    ],
    recommendation: [
      `Aus ${perspective} würde ich Folgendes empfehlen: Zunächst den Bereich ${domain} gezielt prüfen.`,
      `Mein Vorschlag aus ${perspective}: Wir schauen uns erst ${problemTitle} genauer an, bevor wir Maßnahmen einleiten.`,
      `Aus ${perspective} halte ich eine gezielte Prüfung im Bereich ${domain} für den sinnvollsten nächsten Schritt.`,
    ],
    handoff: [
      `Dieses Thema berührt auch den ${isBackend ? "Frontend" : "Backend"}-Bereich. Ich empfehle, dass der ${isBackend ? "Frontend-Agent" : "Backend-Agent"} sich das ebenfalls ansieht.`,
      `Ich übergebe den Teil, der ${isBackend ? "Frontend / UX" : "Backend / API"} betrifft, an den zuständigen Agenten.`,
    ],
    follow_up: [
      `Ich knüpfe an den letzten Punkt an. Aus ${perspective} gibt es noch Folgendes zu ergänzen.`,
      `Dazu noch aus ${perspective}: Der Bereich ${domain} zeigt weitere relevante Aspekte.`,
    ],
    freeform: [
      `Ich habe mir den Fall nochmal angesehen. Aus ${perspective} liegt der Schwerpunkt bei ${problemTitle}.`,
      `Danke für deine Nachricht. Aus ${perspective} ordne ich das wie folgt ein.`,
      `Ich habe deine Nachricht aufgenommen. Wenn du eine bestimmte Richtung bevorzugst, passe ich den Plan daran an.`,
      `Ich warte auf deine Rückmeldung, falls du möchtest, dass ich den Vorschlag in eine bestimmte Richtung anpasse.`,
    ],
  };

  const candidates = replies[messageIntent] || replies.freeform;
  // Deterministic selection based on thread message count
  const idx = (thread ? thread.messageCount : 0) % candidates.length;
  return candidates[idx];
}

/**
 * Determine whether a cross-agent note should be added.
 * @param {string} primaryAgent
 * @param {string} messageIntent
 * @param {Object} agentCase
 * @returns {{ needed: boolean, note: string|null }}
 */
function _checkCrossAgentCoordination(primaryAgent, messageIntent, agentCase) {
  if (!agentCase || !agentCase.needsCrossAgentReview) {
    return { needed: false, note: null };
  }

  const otherAgent = primaryAgent === "deepseek" ? "Gemini (Frontend-Agent)" : "DeepSeek (Backend-Agent)";

  if (messageIntent === "scope_change" || messageIntent === "handoff") {
    return {
      needed: true,
      note: `Hinweis: Dieses Thema hat auch eine ${primaryAgent === "deepseek" ? "Frontend" : "Backend"}-Dimension. ${otherAgent} wird bei Bedarf ergänzend hinzugezogen.`,
    };
  }

  return { needed: false, note: null };
}

/* ─────────────────────────────────────────────────────────────────────
   Step 22: Multi-Agent Handoff / Cross-Agent Dialogue /
            Coordinated Case Exchange Light

   Functions:
   - _assessHandoffNeed()              – detects when handoff is appropriate
   - _deriveHandoffReason()            – classifies the handoff reason
   - _generateHandoffMessage()         – human-readable handoff initiation
   - _generateSupportingAgentReply()   – supporting agent's complementary reply
   - _generateHandoffCompletionMsg()   – handoff completion message
   - _executeHandoff()                 – orchestrates handoff within a thread
   - triggerHandoff()                  – admin-triggered handoff
   - getHandoffSummary()               – analytics across all threads
   ───────────────────────────────────────────────────────────────────── */

/**
 * Assess whether a handoff from the primary agent to the other agent
 * is needed for this message / case combination.
 *
 * @param {string} primaryAgent - "deepseek" or "gemini"
 * @param {string} userMessage - the user's message text
 * @param {string} messageIntent - derived intent
 * @param {Object} agentCase - the agent case (may be null)
 * @param {Object} thread - the conversation thread
 * @returns {{ needed: boolean, reason: string|null, confidence: string }}
 */
function _assessHandoffNeed(primaryAgent, userMessage, messageIntent, agentCase, thread) {
  const lowerMsg = (userMessage || "").toLowerCase();

  // 1. Check for cross-layer keywords in the message
  let crossLayerScore = 0;
  for (const kw of CROSS_LAYER_KEYWORDS) {
    if (lowerMsg.includes(kw)) crossLayerScore += 2;
  }

  // 2. Check if message touches both agent domains
  let deepseekHits = 0;
  let geminiHits = 0;
  for (const kw of DEEPSEEK_ROUTING_KEYWORDS) {
    if (lowerMsg.includes(kw)) deepseekHits += 1;
  }
  for (const kw of GEMINI_ROUTING_KEYWORDS) {
    if (lowerMsg.includes(kw)) geminiHits += 1;
  }
  const touchesBothDomains = deepseekHits > 0 && geminiHits > 0;

  // 3. Check if the case itself needs cross-agent review
  const caseFlagsCrossAgent = agentCase && agentCase.needsCrossAgentReview;

  // 4. User explicitly asks for the other agent or a handoff
  const userRequestsHandoff =
    lowerMsg.includes("übergib") || lowerMsg.includes("anderer agent") ||
    lowerMsg.includes("deepseek dazu") || lowerMsg.includes("gemini dazu") ||
    lowerMsg.includes("zweite meinung") || lowerMsg.includes("ergänzung") ||
    messageIntent === "handoff";

  // 5. Determine need
  if (userRequestsHandoff) {
    return { needed: true, reason: "user_requested", confidence: "high" };
  }
  if (crossLayerScore >= 2) {
    return { needed: true, reason: "cross_layer_issue", confidence: "high" };
  }
  if (touchesBothDomains && crossLayerScore > 0) {
    return { needed: true, reason: "cross_layer_issue", confidence: "medium" };
  }
  if (touchesBothDomains) {
    const reason = primaryAgent === "deepseek" ? "frontend_impact_detected" : "backend_cause_detected";
    return { needed: true, reason, confidence: "medium" };
  }
  if (caseFlagsCrossAgent && (messageIntent === "scope_change" || messageIntent === "diagnosis_request")) {
    return { needed: true, reason: "complementary_expertise", confidence: "medium" };
  }

  // Also detect based on primary agent + message content mismatch
  if (primaryAgent === "deepseek" && geminiHits > deepseekHits && geminiHits >= 2) {
    return { needed: true, reason: "ux_consequence", confidence: "low" };
  }
  if (primaryAgent === "gemini" && deepseekHits > geminiHits && deepseekHits >= 2) {
    return { needed: true, reason: "data_flow_dependency", confidence: "low" };
  }

  return { needed: false, reason: null, confidence: "none" };
}

/**
 * Generate a cooperative, human-readable handoff initiation message.
 *
 * @param {string} fromAgent - "deepseek" or "gemini"
 * @param {string} toAgent - "deepseek" or "gemini"
 * @param {string} reason - one of VALID_HANDOFF_REASONS
 * @param {Object} thread
 * @returns {string}
 */
function _generateHandoffMessage(fromAgent, toAgent, reason, thread) {
  const fromLabel = fromAgent === "deepseek" ? "DeepSeek (Backend)" : "Gemini (Frontend)";
  const toLabel = toAgent === "deepseek" ? "DeepSeek (Backend)" : "Gemini (Frontend)";
  const toDomain = toAgent === "deepseek" ? "Backend / API / Logik" : "Frontend / UX / Darstellung";

  const templates = {
    cross_layer_issue: [
      `Dieses Thema berührt beide Schichten. Ich hole ${toLabel} für den ${toDomain}-Teil dazu.`,
      `Hier greifen Backend und Frontend ineinander. ${toLabel} ergänzt den relevanten Teil.`,
    ],
    frontend_impact_detected: [
      `Aus Backend-Sicht ist der technische Kern klar, aber die Frontend-Folge sollte ${toLabel} ergänzen.`,
      `Der technische Teil ist eingeordnet. Für die Auswirkung auf die Darstellung hole ich ${toLabel} dazu.`,
    ],
    backend_cause_detected: [
      `Ich übergebe diesen Teil an ${toLabel}, weil die Ursache eher im Backend liegt.`,
      `Die Wurzel des Problems liegt im Datenfluss. ${toLabel} kann das genauer einordnen.`,
    ],
    ux_consequence: [
      `Ich hole für die UX-Folge zusätzlich ${toLabel} dazu.`,
      `Für die Darstellungs- und Nutzbarkeitsseite ergänzt ${toLabel} den Fall.`,
    ],
    data_flow_dependency: [
      `Die Anzeige hängt an einem Datenfluss-Thema. Ich hole ${toLabel} für die technische Einordnung dazu.`,
      `Hier braucht es einen Blick auf die API-/Datenebene. ${toLabel} übernimmt diesen Teil.`,
    ],
    scope_expansion: [
      `Der Scope erweitert sich. Ich hole ${toLabel} für den ${toDomain}-Teil dazu.`,
    ],
    user_requested: [
      `Verstanden. Ich hole ${toLabel} für eine ergänzende Einschätzung dazu.`,
      `Wie gewünscht übergebe ich an ${toLabel} zur Ergänzung.`,
    ],
    complementary_expertise: [
      `Für eine vollständigere Einschätzung hole ich ${toLabel} ergänzend dazu.`,
      `${toLabel} hat für diesen Aspekt die passendere Perspektive. Ich übergebe kurz.`,
    ],
  };

  const options = templates[reason] || templates.complementary_expertise;
  const idx = (thread ? thread.messageCount : 0) % options.length;
  return options[idx];
}

/**
 * Generate a cooperative reply from the supporting (secondary) agent.
 *
 * @param {string} supportingAgent - "deepseek" or "gemini"
 * @param {string} reason - handoff reason
 * @param {string} userMessage
 * @param {Object} agentCase
 * @param {Object} thread
 * @returns {string}
 */
function _generateSupportingAgentReply(supportingAgent, reason, userMessage, agentCase, thread) {
  const isBackend = supportingAgent === "deepseek";
  const perspective = isBackend ? "Backend-Sicht" : "Frontend-Sicht";
  const domain = isBackend ? "Backend / API / Logik" : "Frontend / UX / Darstellung";
  const problemTitle = (agentCase && agentCase.problemTitle) || "den aktuellen Fall";

  const replies = {
    cross_layer_issue: [
      `Ich ergänze aus ${perspective}: ${problemTitle} hat auch eine klare ${domain}-Dimension. Ich schaue mir die relevanten Zusammenhänge an.`,
      `Aus ${perspective} sehe ich hier folgende Aspekte, die zum Gesamtbild beitragen.`,
    ],
    frontend_impact_detected: [
      `Ich ergänze den Fall jetzt aus ${perspective}. Die Darstellungsfolge ist relevant und wird hier eingeordnet.`,
      `Aus ${perspective} ordne ich die UX-Auswirkung ein: Das betrifft primär die Anzeige und Verständlichkeit.`,
    ],
    backend_cause_detected: [
      `Aus ${perspective} liegt die Ursache im Datenfluss / in der API-Logik. Ich ordne das technisch ein.`,
      `Ich schaue mir die technische Seite genauer an. Aus ${perspective} sehe ich den Kern bei ${problemTitle}.`,
    ],
    ux_consequence: [
      `Die UX-Folge ist aus ${perspective} klar erkennbar. Ich ergänze die wichtigsten Punkte.`,
    ],
    data_flow_dependency: [
      `Aus ${perspective} hängt das an einem Datenfluss-Thema. Ich ordne die technische Abhängigkeit ein.`,
    ],
    scope_expansion: [
      `Ich ergänze jetzt aus ${perspective} den erweiterten Scope.`,
    ],
    user_requested: [
      `Ich ergänze gern aus ${perspective}. Bezogen auf ${problemTitle} sehe ich Folgendes.`,
    ],
    complementary_expertise: [
      `Aus ${perspective} ergänze ich: Der relevante Bereich ist ${domain}. Ich schaue mir die Details an.`,
    ],
  };

  const options = replies[reason] || replies.complementary_expertise;
  const idx = (thread ? thread.messageCount : 0) % options.length;
  return options[idx];
}

/**
 * Generate a handoff completion message.
 *
 * @param {string} fromAgent
 * @param {string} toAgent
 * @returns {string}
 */
function _generateHandoffCompletionMsg(fromAgent, toAgent) {
  const toLabel = toAgent === "deepseek" ? "DeepSeek (Backend)" : "Gemini (Frontend)";
  return `Die Ergänzung durch ${toLabel} ist abgeschlossen. Der Thread kehrt zur normalen Führung zurück.`;
}

/**
 * Execute a handoff within a conversation thread.
 * Creates handoff initiation message + supporting agent reply + completion.
 *
 * @param {Object} params
 * @param {Object} params.thread
 * @param {string} params.primaryAgent - "deepseek" or "gemini"
 * @param {string} params.reason - handoff reason
 * @param {string} params.userMessage
 * @param {Object} params.agentCase
 * @param {string} params.afterMessageId - the message this handoff follows
 * @returns {{ handoffMessages: Array, supportingAgentReply: Object }}
 */
async function _executeHandoff({ thread, primaryAgent, reason, userMessage, agentCase, afterMessageId }) {
  const supportingAgent = primaryAgent === "deepseek" ? "gemini" : "deepseek";
  const supportingRole = supportingAgent === "deepseek" ? "backend_agent" : "frontend_agent";
  const handoffMessages = [];

  // 1. Handoff initiation message from primary agent
  _conversationMsgCounter += 1;
  const handoffMsgId = `conv-${Date.now()}-${_conversationMsgCounter}`;
  const handoffText = _generateHandoffMessage(primaryAgent, supportingAgent, reason, thread);

  const handoffInitMsg = {
    messageId: handoffMsgId,
    threadId: thread.threadId,
    caseId: thread.caseId,
    messageRole: "agent",
    speakerAgent: primaryAgent,
    speakerRole: primaryAgent === "deepseek" ? "backend_agent" : "frontend_agent",
    messageIntent: "handoff",
    messagePhase: "cross_agent_handoff_phase",
    messageType: "handoff_initiation",
    content: handoffText,
    replyToMessageId: afterMessageId,
    quotedMessageId: null,
    followUpOf: afterMessageId,
    relatedCaseId: thread.caseId,
    relatedDraftId: null,
    handoffReason: reason,
    handoffFrom: primaryAgent,
    handoffTo: supportingAgent,
    createdAt: new Date().toISOString(),
  };

  thread.conversationMessages.push(handoffInitMsg);
  thread.messageCount += 1;
  thread.agentMessageCount += 1;
  if (primaryAgent === "deepseek") thread.deepseekMessageCount += 1;
  if (primaryAgent === "gemini") thread.geminiMessageCount += 1;
  handoffMessages.push(handoffInitMsg);

  // Update thread handoff state
  thread.handoffStatus = "handoff_in_progress";
  thread.crossAgentState = "cross_agent_active";
  thread.handoffFrom = primaryAgent;
  thread.handoffTo = supportingAgent;
  thread.handoffReason = reason;
  thread.supportingAgent = supportingAgent;

  // Record in global chat
  _recordAgentChatMessage({
    agentCaseId: thread.caseId,
    agentRole: primaryAgent === "deepseek" ? "deepseek_backend" : "gemini_frontend",
    messageType: "handoff_initiation",
    messageIntent: "handoff",
    messagePriority: "normal",
    requiresUserDecision: false,
    message: handoffText,
    planPhase: "cross_agent_handoff_phase",
    handoffStatus: "handoff_in_progress",
    crossAgentState: "cross_agent_active",
    handoffFrom: primaryAgent,
    handoffTo: supportingAgent,
    handoffReason: reason,
  });

  logger.info("[agentBridge] Step 22 – Handoff eingeleitet", {
    threadId: thread.threadId,
    from: primaryAgent,
    to: supportingAgent,
    reason,
  });

  // 2. Supporting agent reply – real API call with fallback to template
  _conversationMsgCounter += 1;
  const supportMsgId = `conv-${Date.now()}-${_conversationMsgCounter}`;
  const supportText = await _generateConversationReply({
    speakerAgent: supportingAgent,
    messageIntent: "follow_up",
    userMessage: userMessage || "",
    agentCase,
    thread,
  });

  const supportMsg = {
    messageId: supportMsgId,
    threadId: thread.threadId,
    caseId: thread.caseId,
    messageRole: "agent",
    speakerAgent: supportingAgent,
    speakerRole: supportingRole,
    messageIntent: "follow_up",
    messagePhase: "cross_agent_handoff_phase",
    messageType: "supporting_agent_reply",
    content: supportText,
    replyToMessageId: handoffMsgId,
    quotedMessageId: null,
    followUpOf: handoffMsgId,
    relatedCaseId: thread.caseId,
    relatedDraftId: null,
    handoffReason: reason,
    handoffFrom: primaryAgent,
    handoffTo: supportingAgent,
    createdAt: new Date().toISOString(),
  };

  thread.conversationMessages.push(supportMsg);
  thread.messageCount += 1;
  thread.agentMessageCount += 1;
  if (supportingAgent === "deepseek") thread.deepseekMessageCount += 1;
  if (supportingAgent === "gemini") thread.geminiMessageCount += 1;
  handoffMessages.push(supportMsg);

  // Record in global chat
  _recordAgentChatMessage({
    agentCaseId: thread.caseId,
    agentRole: supportingAgent === "deepseek" ? "deepseek_backend" : "gemini_frontend",
    messageType: "supporting_agent_reply",
    messageIntent: "follow_up",
    messagePriority: "normal",
    requiresUserDecision: false,
    message: supportText,
    planPhase: "cross_agent_handoff_phase",
    handoffStatus: "handoff_in_progress",
    crossAgentState: "cross_agent_active",
    handoffFrom: primaryAgent,
    handoffTo: supportingAgent,
    handoffReason: reason,
  });

  logger.info("[agentBridge] Step 22 – Ergänzung durch zweiten Agenten", {
    threadId: thread.threadId,
    supportingAgent,
    reason,
  });

  // 3. Handoff completion message (system)
  _conversationMsgCounter += 1;
  const completionMsgId = `conv-${Date.now()}-${_conversationMsgCounter}`;
  const completionText = _generateHandoffCompletionMsg(primaryAgent, supportingAgent);

  const completionMsg = {
    messageId: completionMsgId,
    threadId: thread.threadId,
    caseId: thread.caseId,
    messageRole: "system",
    speakerAgent: "system",
    speakerRole: "coordinator",
    messageIntent: "handoff",
    messagePhase: "cross_agent_handoff_phase",
    messageType: "handoff_completion",
    content: completionText,
    replyToMessageId: supportMsgId,
    quotedMessageId: null,
    followUpOf: supportMsgId,
    relatedCaseId: thread.caseId,
    relatedDraftId: null,
    handoffReason: reason,
    handoffFrom: primaryAgent,
    handoffTo: supportingAgent,
    createdAt: new Date().toISOString(),
  };

  thread.conversationMessages.push(completionMsg);
  thread.messageCount += 1;
  thread.systemMessageCount += 1;
  handoffMessages.push(completionMsg);

  // Update thread: handoff complete
  thread.handoffStatus = "handoff_completed";
  thread.crossAgentState = "cross_agent_completed";
  thread.handoffCount += 1;
  thread.lastHandoffAt = new Date().toISOString();
  thread.lastSpeaker = "system";
  thread.awaitingUserReply = true;
  thread.awaitingAgentReply = false;
  thread.nextSuggestedSpeaker = "user";

  // Record handoff history entry
  thread.handoffHistory.push({
    handoffId: `ho-${Date.now()}-${thread.handoffCount}`,
    from: primaryAgent,
    to: supportingAgent,
    reason,
    initiatedAt: handoffInitMsg.createdAt,
    completedAt: completionMsg.createdAt,
    handoffMessageId: handoffMsgId,
    supportingMessageId: supportMsgId,
    completionMessageId: completionMsgId,
  });

  // Keep handoff history manageable
  while (thread.handoffHistory.length > HANDOFF_HISTORY_MAX_ENTRIES) {
    thread.handoffHistory.shift();
  }

  // Record completion in global chat
  _recordAgentChatMessage({
    agentCaseId: thread.caseId,
    agentRole: "system",
    messageType: "handoff_completion",
    messageIntent: "handoff",
    messagePriority: "normal",
    requiresUserDecision: false,
    message: completionText,
    planPhase: "cross_agent_handoff_phase",
    handoffStatus: "handoff_completed",
    crossAgentState: "cross_agent_completed",
    handoffFrom: primaryAgent,
    handoffTo: supportingAgent,
    handoffReason: reason,
  });

  logger.info("[agentBridge] Step 22 – Handoff abgeschlossen", {
    threadId: thread.threadId,
    from: primaryAgent,
    to: supportingAgent,
    reason,
    handoffCount: thread.handoffCount,
  });

  return {
    handoffMessages,
    supportingAgentReply: supportMsg,
  };
}

/**
 * Admin-triggered handoff: explicitly trigger a handoff within a thread.
 *
 * @param {Object} params
 * @param {string} params.agentCaseId
 * @param {string} [params.targetAgent] - "deepseek" or "gemini" (who to hand off to)
 * @param {string} [params.reason]
 * @returns {Object}
 */
async function triggerHandoff({ agentCaseId, targetAgent, reason } = {}) {
  if (!agentCaseId) {
    return { success: false, error: "agentCaseId is required" };
  }

  const thread = _conversationThreads.get(agentCaseId);
  if (!thread) {
    return { success: false, error: "No conversation thread found for this case" };
  }

  const agentCase = _agentCaseRegistry.get(agentCaseId) || null;
  const currentDominant = thread.dominantAgent || "deepseek_backend";
  const currentPrimary = currentDominant.includes("deepseek") ? "deepseek" : "gemini";

  // Determine target
  const resolvedTarget = targetAgent || (currentPrimary === "deepseek" ? "gemini" : "deepseek");
  if (resolvedTarget === currentPrimary) {
    return { success: false, error: "Cannot hand off to the same agent that is currently leading" };
  }

  const resolvedReason = reason || "user_requested";
  if (!VALID_HANDOFF_REASONS.includes(resolvedReason)) {
    return { success: false, error: `Invalid handoff reason. Valid: ${VALID_HANDOFF_REASONS.join(", ")}` };
  }

  const lastMsg = thread.conversationMessages.length > 0
    ? thread.conversationMessages[thread.conversationMessages.length - 1]
    : null;
  const afterMessageId = lastMsg ? lastMsg.messageId : null;

  const result = await _executeHandoff({
    thread,
    primaryAgent: currentPrimary,
    reason: resolvedReason,
    userMessage: lastMsg ? lastMsg.content : "",
    agentCase,
    afterMessageId,
  });

  thread.updatedAt = new Date().toISOString();

  return {
    success: true,
    threadId: thread.threadId,
    handoffStatus: thread.handoffStatus,
    crossAgentState: thread.crossAgentState,
    handoffFrom: currentPrimary,
    handoffTo: resolvedTarget,
    handoffReason: resolvedReason,
    handoffCount: thread.handoffCount,
    messagesAdded: result.handoffMessages.length,
    supportingAgentReply: result.supportingAgentReply,
  };
}

/**
 * Build a summary across all conversation threads for handoff / cross-agent analytics.
 *
 * @returns {Object}
 */
function getHandoffSummary() {
  const threads = Array.from(_conversationThreads.values());

  const byHandoffStatus = {};
  const byCrossAgentState = {};
  const byHandoffReason = {};
  const byHandoffDirection = {};

  let totalThreads = threads.length;
  let totalWithHandoffs = 0;
  let totalHandoffs = 0;
  let totalDeepseekToGemini = 0;
  let totalGeminiToDeepseek = 0;
  let totalCrossAgentActive = 0;
  let totalSingleAgent = 0;

  for (const t of threads) {
    const hs = t.handoffStatus || "handoff_not_needed";
    byHandoffStatus[hs] = (byHandoffStatus[hs] || 0) + 1;

    const cas = t.crossAgentState || "single_agent";
    byCrossAgentState[cas] = (byCrossAgentState[cas] || 0) + 1;

    if (cas === "single_agent") totalSingleAgent += 1;
    if (cas === "cross_agent_active") totalCrossAgentActive += 1;

    if (t.handoffCount > 0) {
      totalWithHandoffs += 1;
      totalHandoffs += t.handoffCount;
    }

    for (const h of (t.handoffHistory || [])) {
      const dir = `${h.from}→${h.to}`;
      byHandoffDirection[dir] = (byHandoffDirection[dir] || 0) + 1;
      if (h.reason) {
        byHandoffReason[h.reason] = (byHandoffReason[h.reason] || 0) + 1;
      }
      if (h.from === "deepseek" && h.to === "gemini") totalDeepseekToGemini += 1;
      if (h.from === "gemini" && h.to === "deepseek") totalGeminiToDeepseek += 1;
    }
  }

  // Top handoff reasons
  const topHandoffReasons = Object.entries(byHandoffReason)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));

  // Thread-level handoff summaries (most recent first)
  const handoffThreads = threads
    .filter((t) => t.handoffCount > 0)
    .sort((a, b) => (b.lastHandoffAt || "").localeCompare(a.lastHandoffAt || ""))
    .slice(0, CONVERSATION_SUMMARY_MAX_THREADS)
    .map((t) => ({
      threadId: t.threadId,
      handoffStatus: t.handoffStatus,
      crossAgentState: t.crossAgentState,
      dominantAgent: t.dominantAgent,
      supportingAgent: t.supportingAgent,
      handoffCount: t.handoffCount,
      lastHandoffAt: t.lastHandoffAt,
      messageCount: t.messageCount,
      deepseekMessageCount: t.deepseekMessageCount,
      geminiMessageCount: t.geminiMessageCount,
    }));

  logger.info("[agentBridge] Step 22 – Handoff-Zusammenfassung erzeugt", {
    totalThreads,
    totalWithHandoffs,
    totalHandoffs,
    totalDeepseekToGemini,
    totalGeminiToDeepseek,
  });

  return {
    totalThreads,
    totalWithHandoffs,
    totalHandoffs,
    totalDeepseekToGemini,
    totalGeminiToDeepseek,
    totalCrossAgentActive,
    totalSingleAgent,
    byHandoffStatus,
    byCrossAgentState,
    byHandoffDirection,
    byHandoffReason,
    topHandoffReasons,
    handoffThreads,
    generatedAt: new Date().toISOString(),
  };
}

/* ─────────────────────────────────────────────────────────────────────
   Step 23: Conversation Memory / Case Continuity / Agent Memory Anchors

   Provides structured case memory so DeepSeek and Gemini can remember
   decisions, open points, scope agreements, and agreed directions
   within a case – enabling true case continuity rather than isolated
   message exchanges.

   Functions:
   - _extractMemoryAnchors()       – derives anchors from conversation history
   - _buildWorkingSummary()        – generates human-readable case summary
   - _deriveCaseContinuityStatus() – classifies continuity maturity
   - _deriveMemoryFreshness()      – classifies memory staleness
   - _updateCaseMemory()           – updates memory after each interaction
   - _injectMemoryIntoReply()      – enriches agent replies with memory context
   - getCaseMemory()               – retrieves case memory for a thread
   - getCaseMemorySummary()        – analytics across all threads
   ───────────────────────────────────────────────────────────────────── */

/**
 * Extract memory anchors from conversation messages.
 * Identifies scope decisions, user preferences, agreed directions,
 * handoff completions, and other meaningful case events.
 *
 * A single message may produce multiple anchors when it matches
 * several patterns (e.g. a scope change that also expresses a
 * user preference).  All matching anchor types are collected
 * independently and the list is capped to CASE_MEMORY_MAX_ANCHORS
 * (most recent anchors kept).
 *
 * @param {Object} thread - conversation thread
 * @param {Object|null} agentCase - associated agent case
 * @returns {Array<Object>} extracted anchors
 */
function _extractMemoryAnchors(thread, agentCase) {
  const anchors = [];
  const messages = thread.conversationMessages || [];

  for (const msg of messages) {
    const content = (msg.content || "").toLowerCase();
    const intent = msg.messageIntent || "";
    const speaker = msg.speakerAgent || "";

    // Scope decisions: user or agent narrows scope
    if (intent === "scope_change" || /\b(nur backend|nur frontend|scope eingrenzen|nur api|frontend raus|backend raus)\b/i.test(msg.content || "")) {
      anchors.push({
        anchorType: "scope_decision",
        anchorText: msg.content || "",
        sourceMessageId: msg.messageId,
        sourceAgent: speaker,
        createdAt: msg.createdAt,
      });
    }

    // User preferences: explicit user direction
    if (speaker === "user" && (
      /\b(ich will|ich möchte|bitte nur|lieber|bevorzuge|konzentrier dich auf)\b/i.test(msg.content || "")
    )) {
      anchors.push({
        anchorType: "user_preference",
        anchorText: msg.content || "",
        sourceMessageId: msg.messageId,
        sourceAgent: speaker,
        createdAt: msg.createdAt,
      });
    }

    // Approval decisions
    if (intent === "approval_feedback") {
      anchors.push({
        anchorType: "approval_decision",
        anchorText: msg.content || "",
        sourceMessageId: msg.messageId,
        sourceAgent: speaker,
        createdAt: msg.createdAt,
      });
    }

    // Diagnosis findings from agents
    if (intent === "diagnosis_request" && (speaker === "deepseek" || speaker === "gemini")) {
      anchors.push({
        anchorType: "diagnosis_finding",
        anchorText: msg.content || "",
        sourceMessageId: msg.messageId,
        sourceAgent: speaker,
        createdAt: msg.createdAt,
      });
    }

    // Plan refinements
    if (intent === "refinement" && (speaker === "deepseek" || speaker === "gemini")) {
      anchors.push({
        anchorType: "plan_refinement",
        anchorText: msg.content || "",
        sourceMessageId: msg.messageId,
        sourceAgent: speaker,
        createdAt: msg.createdAt,
      });
    }

    // Discarded directions
    if (/\b(verworfen|zurückgestellt|nicht weiter|lassen wir|erstmal nicht|doch nicht)\b/i.test(msg.content || "")) {
      anchors.push({
        anchorType: "direction_discarded",
        anchorText: msg.content || "",
        sourceMessageId: msg.messageId,
        sourceAgent: speaker,
        createdAt: msg.createdAt,
      });
    }

    // Handoff completions
    if (msg.messageType === "handoff_completion" || intent === "handoff") {
      anchors.push({
        anchorType: "handoff_completed",
        anchorText: msg.content || "",
        sourceMessageId: msg.messageId,
        sourceAgent: speaker,
        createdAt: msg.createdAt,
      });
    }

    // Agreed direction
    if (/\b(einverstanden|einig|einigen wir uns|machen wir so|klingt gut|okay so|passt so)\b/i.test(msg.content || "")) {
      anchors.push({
        anchorType: "direction_agreed",
        anchorText: msg.content || "",
        sourceMessageId: msg.messageId,
        sourceAgent: speaker,
        createdAt: msg.createdAt,
      });
    }
  }

  // Derive anchors from agent case state (non-message-based)
  if (agentCase) {
    if (agentCase.refinedPlan15) {
      anchors.push({
        anchorType: "plan_refinement",
        anchorText: `Verfeinerter Plan liegt vor (Phase: ${agentCase.refinedPlan15.planPhase || "unbekannt"})`,
        sourceMessageId: null,
        sourceAgent: agentCase.agentRole === "deepseek_backend" ? "deepseek" : "gemini",
        createdAt: agentCase.refinedPlan15.refinedAt || null,
      });
    }
    if (agentCase.actionDraft16) {
      anchors.push({
        anchorType: "next_step_identified",
        anchorText: `Aktionsentwurf vorbereitet (Typ: ${agentCase.actionDraft16.draftType || "unbekannt"})`,
        sourceMessageId: null,
        sourceAgent: agentCase.agentRole === "deepseek_backend" ? "deepseek" : "gemini",
        createdAt: agentCase.actionDraft16.createdAt || null,
      });
    }
    if (agentCase.applyCandidate19 && agentCase.applyCandidate19.candidateStatus === "candidate_ready_for_final_approval") {
      anchors.push({
        anchorType: "next_step_identified",
        anchorText: "Kandidat ist vorbereitet und wartet auf finale Freigabe.",
        sourceMessageId: null,
        sourceAgent: agentCase.agentRole === "deepseek_backend" ? "deepseek" : "gemini",
        createdAt: agentCase.applyCandidate19.createdAt || null,
      });
    }
  }

  // Limit anchors to most recent
  return anchors.slice(-CASE_MEMORY_MAX_ANCHORS);
}

/**
 * Derive open questions from conversation messages and case state.
 *
 * @param {Object} thread
 * @param {Object|null} agentCase
 * @returns {Array<Object>}
 */
function _deriveOpenQuestions(thread, agentCase) {
  const questions = [];
  const messages = thread.conversationMessages || [];

  for (const msg of messages) {
    const intent = msg.messageIntent || "";
    const speaker = msg.speakerAgent || "";
    const content = msg.content || "";

    // User questions that have not been followed by agent explanation
    if (speaker === "user" && (intent === "question" || intent === "clarification" || intent === "diagnosis_request")) {
      const msgIdx = messages.indexOf(msg);
      const hasAgentReply = messages.slice(msgIdx + 1).some(
        (m) => (m.speakerAgent === "deepseek" || m.speakerAgent === "gemini") &&
               (m.messageIntent === "explanation" || m.messageIntent === "recommendation")
      );
      if (!hasAgentReply) {
        questions.push({
          question: content.length > 120 ? content.substring(0, 120) + "…" : content,
          askedBy: speaker,
          askedAt: msg.createdAt,
          sourceMessageId: msg.messageId,
          status: "open",
        });
      }
    }
  }

  // Agent case-derived open questions
  if (agentCase) {
    if (agentCase.applyReadiness17 && agentCase.applyReadiness17.readinessBand === "not_ready") {
      questions.push({
        question: "Voraussetzungen für Apply-Readiness sind noch nicht erfüllt.",
        askedBy: "system",
        askedAt: null,
        sourceMessageId: null,
        status: "open",
      });
    }
  }

  return questions.slice(-CASE_MEMORY_MAX_OPEN_QUESTIONS);
}

/**
 * Derive resolved points from conversation messages and case state.
 *
 * @param {Object} thread
 * @param {Object|null} agentCase
 * @returns {Array<Object>}
 */
function _deriveResolvedPoints(thread, agentCase) {
  const resolved = [];
  const messages = thread.conversationMessages || [];

  // Find user questions that were followed by agent explanations
  for (const msg of messages) {
    const intent = msg.messageIntent || "";
    const speaker = msg.speakerAgent || "";
    const content = msg.content || "";

    if (speaker === "user" && (intent === "question" || intent === "clarification")) {
      const msgIdx = messages.indexOf(msg);
      const agentReply = messages.slice(msgIdx + 1).find(
        (m) => (m.speakerAgent === "deepseek" || m.speakerAgent === "gemini") &&
               (m.messageIntent === "explanation" || m.messageIntent === "recommendation")
      );
      if (agentReply) {
        resolved.push({
          point: content.length > 120 ? content.substring(0, 120) + "…" : content,
          resolvedBy: agentReply.speakerAgent,
          resolvedAt: agentReply.createdAt,
          sourceMessageId: msg.messageId,
          resolutionMessageId: agentReply.messageId,
        });
      }
    }
  }

  // Scope changes that were acknowledged
  for (const msg of messages) {
    if (msg.messageIntent === "scope_change" && msg.speakerAgent === "user") {
      const msgIdx = messages.indexOf(msg);
      const ack = messages.slice(msgIdx + 1).find((m) => m.speakerAgent !== "user");
      if (ack) {
        resolved.push({
          point: `Scope-Änderung: ${(msg.content || "").substring(0, 80)}`,
          resolvedBy: ack.speakerAgent,
          resolvedAt: ack.createdAt,
          sourceMessageId: msg.messageId,
          resolutionMessageId: ack.messageId,
        });
      }
    }
  }

  return resolved.slice(-CASE_MEMORY_MAX_RESOLVED_POINTS);
}

/**
 * Derive the agreed direction from conversation history.
 * Looks for explicit user agreements or scope narrowing.
 *
 * @param {Object} thread
 * @param {Object|null} agentCase
 * @returns {string|null}
 */
function _deriveAgreedDirection(thread, agentCase) {
  const messages = (thread.conversationMessages || []).slice().reverse();

  for (const msg of messages) {
    const content = msg.content || "";
    if (msg.speakerAgent === "user") {
      if (/\b(nur backend|nur frontend|nur api|nur ui)\b/i.test(content)) {
        return content.length > 150 ? content.substring(0, 150) + "…" : content;
      }
      if (/\b(machen wir so|passt so|einverstanden|klingt gut|okay so|genau so)\b/i.test(content)) {
        return content.length > 150 ? content.substring(0, 150) + "…" : content;
      }
    }
  }

  // Fallback: derive from agent case scope
  if (agentCase && agentCase.refinedPlan15 && agentCase.refinedPlan15.effectiveScope) {
    return `Scope: ${agentCase.refinedPlan15.effectiveScope}`;
  }

  return null;
}

/**
 * Derive discarded directions from conversation.
 *
 * @param {Object} thread
 * @returns {Array<string>}
 */
function _deriveDiscardedDirections(thread) {
  const discarded = [];
  const messages = thread.conversationMessages || [];

  for (const msg of messages) {
    const content = msg.content || "";
    if (/\b(verworfen|zurückgestellt|nicht weiter|lassen wir|erstmal nicht|doch nicht|brauchen wir nicht)\b/i.test(content)) {
      const summary = content.length > 120 ? content.substring(0, 120) + "…" : content;
      discarded.push(summary);
    }
  }

  return discarded.slice(-10);
}

/**
 * Derive the next open step based on case state and conversation.
 *
 * @param {Object} thread
 * @param {Object|null} agentCase
 * @returns {string|null}
 */
function _deriveNextOpenStep(thread, agentCase) {
  // Check case pipeline state
  if (agentCase) {
    if (agentCase.executionSession20 && agentCase.executionSession20.runtimeStatus === "runtime_awaiting_user_start") {
      return "Ausführung wartet auf User-Freigabe.";
    }
    if (agentCase.applyCandidate19 && agentCase.applyCandidate19.candidateStatus === "candidate_ready_for_final_approval") {
      return "Kandidat ist bereit für die finale Freigabe.";
    }
    if (agentCase.applyCandidate19 && agentCase.applyCandidate19.candidateStatus === "candidate_scope_confirmation_needed") {
      return "Scope-Bestätigung erforderlich, bevor fortgefahren wird.";
    }
    if (agentCase.applyReadiness17 && agentCase.applyReadiness17.readinessBand === "not_ready") {
      return "Voraussetzungen für Apply-Readiness müssen noch erfüllt werden.";
    }
    if (agentCase.actionDraft16 && agentCase.actionDraft16.draftStatus === "draft_created") {
      return "Aktionsentwurf liegt vor – Review oder Verfeinerung als nächstes.";
    }
    if (agentCase.refinedPlan15) {
      return "Plan wurde verfeinert – nächster Schritt: Draft oder Scope-Bestätigung.";
    }
  }

  // From conversation: last open question
  const openQ = _deriveOpenQuestions(thread, agentCase);
  if (openQ.length > 0) {
    return `Offene Frage klären: ${openQ[openQ.length - 1].question}`;
  }

  // Default based on thread state
  if (thread.awaitingUserReply) {
    return "Wartet auf Rückmeldung des Users.";
  }
  if (thread.awaitingAgentReply) {
    return "Agent bereitet Antwort vor.";
  }

  return null;
}

/**
 * Derive case scope from conversation and agent case.
 *
 * @param {Object} thread
 * @param {Object|null} agentCase
 * @returns {string|null}
 */
function _deriveCaseScope(thread, agentCase) {
  // Check for explicit scope narrowing in messages
  const messages = (thread.conversationMessages || []).slice().reverse();
  for (const msg of messages) {
    if (msg.speakerAgent === "user" && msg.messageIntent === "scope_change") {
      const content = msg.content || "";
      if (/backend/i.test(content)) return "backend";
      if (/frontend/i.test(content)) return "frontend";
      if (/api/i.test(content)) return "api";
    }
  }

  // From agent case
  if (agentCase) {
    if (agentCase.agentRole === "deepseek_backend") return "backend";
    if (agentCase.agentRole === "gemini_frontend") return "frontend";
  }

  // Cross-agent
  if (thread.crossAgentState === "cross_agent_active" || thread.crossAgentState === "cross_agent_completed") {
    return "cross_agent";
  }

  return null;
}

/**
 * Derive case decisions from conversation.
 *
 * @param {Object} thread
 * @returns {Array<Object>}
 */
function _deriveCaseDecisions(thread) {
  const decisions = [];
  const messages = thread.conversationMessages || [];

  for (const msg of messages) {
    if (msg.messageIntent === "approval_feedback" || msg.messageIntent === "scope_change") {
      decisions.push({
        decision: (msg.content || "").substring(0, 120),
        madeBy: msg.speakerAgent,
        madeAt: msg.createdAt,
        sourceMessageId: msg.messageId,
      });
    }
  }

  return decisions.slice(-15);
}

/**
 * Derive user preferences expressed within the case.
 *
 * @param {Object} thread
 * @returns {Array<string>}
 */
function _deriveUserPreferences(thread) {
  const prefs = [];
  const messages = thread.conversationMessages || [];

  for (const msg of messages) {
    if (msg.speakerAgent !== "user") continue;
    const content = msg.content || "";

    if (/\b(ich will|ich möchte|bitte nur|lieber|bevorzuge|konzentrier dich)\b/i.test(content)) {
      prefs.push(content.length > 120 ? content.substring(0, 120) + "…" : content);
    }
  }

  return prefs.slice(-10);
}

/**
 * Derive the last meaningful decision from the conversation.
 *
 * @param {Object} thread
 * @returns {string|null}
 */
function _deriveLastMeaningfulDecision(thread) {
  const messages = (thread.conversationMessages || []).slice().reverse();

  for (const msg of messages) {
    if (msg.messageIntent === "approval_feedback" || msg.messageIntent === "scope_change") {
      return (msg.content || "").substring(0, 150);
    }
    if (msg.speakerAgent === "user" && /\b(machen wir so|passt|einverstanden|okay|genehmigt|freigegeben)\b/i.test(msg.content || "")) {
      return (msg.content || "").substring(0, 150);
    }
  }

  return null;
}

/**
 * Derive pending clarifications.
 *
 * @param {Object} thread
 * @returns {Array<string>}
 */
function _derivePendingClarifications(thread) {
  const clarifications = [];
  const messages = thread.conversationMessages || [];

  for (const msg of messages) {
    if ((msg.speakerAgent === "deepseek" || msg.speakerAgent === "gemini") &&
        msg.messageIntent === "clarification") {
      // Check if user replied after this clarification
      const idx = messages.indexOf(msg);
      const hasUserReply = messages.slice(idx + 1).some((m) => m.speakerAgent === "user");
      if (!hasUserReply) {
        clarifications.push(
          (msg.content || "").length > 120 ? (msg.content || "").substring(0, 120) + "…" : (msg.content || "")
        );
      }
    }
  }

  return clarifications.slice(-5);
}

/**
 * Derive case continuity status from memory state.
 *
 * @param {Object} caseMemory
 * @param {Object} thread
 * @returns {string}
 */
function _deriveCaseContinuityStatus(caseMemory, thread) {
  const anchorCount = (caseMemory.memoryAnchors || []).length;
  const hasWorkingSummary = !!caseMemory.workingSummary;
  const hasAgreedDirection = !!caseMemory.agreedDirection;
  const messageCount = thread.messageCount || 0;

  if (anchorCount === 0 && !hasWorkingSummary && messageCount < 2) {
    return "continuity_not_started";
  }

  if (anchorCount >= 3 && hasWorkingSummary && hasAgreedDirection) {
    return "continuity_established";
  }

  // Check staleness: if many messages but no recent memory update
  if (messageCount > 10 && anchorCount < 2) {
    return "continuity_needs_refresh";
  }

  return "continuity_light";
}

/**
 * Derive memory freshness from update timestamps.
 *
 * @param {Object} caseMemory
 * @param {Object} thread
 * @returns {string}
 */
function _deriveMemoryFreshness(caseMemory, thread) {
  if (!caseMemory.memoryUpdatedAt) {
    return "memory_empty";
  }

  const anchorCount = (caseMemory.memoryAnchors || []).length;
  const hasWorkingSummary = !!caseMemory.workingSummary;

  if (anchorCount < 2 && !hasWorkingSummary) {
    return "memory_partial";
  }

  // Check if memory was updated recently (same session as last message)
  const lastMsgAt = thread.updatedAt || thread.createdAt;
  if (caseMemory.memoryUpdatedAt >= lastMsgAt) {
    return "memory_recently_updated";
  }

  return "memory_stable";
}

/**
 * Build a human-readable working summary from case memory.
 * Uses cooperative, natural language – not raw technical labels.
 *
 * @param {Object} thread
 * @param {Object|null} agentCase
 * @param {Object} caseMemory
 * @returns {string}
 */
function _buildWorkingSummary(thread, agentCase, caseMemory) {
  const parts = [];
  const problemTitle = (agentCase && agentCase.problemTitle) || "den aktuellen Fall";

  // 1. Case scope
  if (caseMemory.caseScope) {
    const scopeLabel = {
      backend: "den Backend-Teil",
      frontend: "den Frontend-Teil",
      api: "den API-Bereich",
      cross_agent: "beide Bereiche (Backend und Frontend)",
    }[caseMemory.caseScope] || caseMemory.caseScope;
    parts.push(`Bisher wurde der Fall auf ${scopeLabel} eingegrenzt.`);
  }

  // 2. Agreed direction
  if (caseMemory.agreedDirection) {
    parts.push(`Vereinbarte Richtung: ${caseMemory.agreedDirection.length > 100 ? caseMemory.agreedDirection.substring(0, 100) + "…" : caseMemory.agreedDirection}`);
  }

  // 3. Discarded directions
  if (caseMemory.discardedDirections && caseMemory.discardedDirections.length > 0) {
    const last = caseMemory.discardedDirections[caseMemory.discardedDirections.length - 1];
    parts.push(`Zurückgestellt wurde: ${last.length > 80 ? last.substring(0, 80) + "…" : last}`);
  }

  // 4. Resolved points
  if (caseMemory.resolvedPoints && caseMemory.resolvedPoints.length > 0) {
    parts.push(`${caseMemory.resolvedPoints.length} Punkt(e) wurden bereits geklärt.`);
  }

  // 5. Open questions
  if (caseMemory.openQuestions && caseMemory.openQuestions.length > 0) {
    const lastQ = caseMemory.openQuestions[caseMemory.openQuestions.length - 1];
    parts.push(`Offen ist aktuell: ${lastQ.question || "eine Klärungsfrage"}.`);
  }

  // 6. Handoff state
  if (thread.handoffCount > 0 && thread.handoffStatus === "handoff_completed") {
    const from = thread.handoffFrom === "deepseek" ? "DeepSeek" : "Gemini";
    const to = thread.handoffTo === "deepseek" ? "DeepSeek" : "Gemini";
    parts.push(`Die Übergabe von ${from} an ${to} wurde bereits abgeschlossen.`);
  }

  // 7. Dominant agent
  if (caseMemory.dominantMemoryOwner) {
    const label = caseMemory.dominantMemoryOwner === "deepseek" ? "DeepSeek (Backend)" : "Gemini (Frontend)";
    parts.push(`Den Fall prägt aktuell ${label}.`);
  }

  // 8. Next open step
  if (caseMemory.nextOpenStep) {
    parts.push(`Als nächster Schritt ist offen: ${caseMemory.nextOpenStep}`);
  }

  // 9. Last meaningful decision
  if (caseMemory.lastMeaningfulDecision && parts.length < 4) {
    parts.push(`Letzte Entscheidung: ${caseMemory.lastMeaningfulDecision.length > 80 ? caseMemory.lastMeaningfulDecision.substring(0, 80) + "…" : caseMemory.lastMeaningfulDecision}`);
  }

  if (parts.length === 0) {
    return `Der Fall „${problemTitle}" wurde eröffnet, bisher liegen noch keine strukturierten Arbeitsergebnisse vor.`;
  }

  return parts.join(" ");
}

/**
 * Update the case memory on a thread after a new interaction.
 * Re-derives all memory fields from conversation history and case state.
 *
 * @param {Object} thread
 * @param {Object|null} agentCase
 * @param {string} triggerSource - what triggered the update (e.g. "user_message", "agent_reply", "handoff")
 * @returns {Object} updated caseMemory
 */
function _updateCaseMemory(thread, agentCase, triggerSource) {
  const mem = thread.caseMemory;
  const now = new Date().toISOString();

  // Re-derive all structured memory fields
  mem.memoryAnchors = _extractMemoryAnchors(thread, agentCase);
  mem.openQuestions = _deriveOpenQuestions(thread, agentCase);
  mem.resolvedPoints = _deriveResolvedPoints(thread, agentCase);
  mem.agreedDirection = _deriveAgreedDirection(thread, agentCase);
  mem.discardedDirections = _deriveDiscardedDirections(thread);
  mem.nextOpenStep = _deriveNextOpenStep(thread, agentCase);
  mem.caseScope = _deriveCaseScope(thread, agentCase);
  mem.caseDecisions = _deriveCaseDecisions(thread);
  mem.userPreferencesInCase = _deriveUserPreferences(thread);
  mem.lastMeaningfulDecision = _deriveLastMeaningfulDecision(thread);
  mem.pendingClarifications = _derivePendingClarifications(thread);

  // Role-based memory view
  if (thread.deepseekMessageCount > thread.geminiMessageCount) {
    mem.dominantMemoryOwner = "deepseek";
  } else if (thread.geminiMessageCount > thread.deepseekMessageCount) {
    mem.dominantMemoryOwner = "gemini";
  } else if (thread.deepseekMessageCount > 0 && thread.geminiMessageCount > 0) {
    mem.dominantMemoryOwner = "cross_agent";
  }

  // Last contributing agent
  const lastAgentMsg = (thread.conversationMessages || []).slice().reverse().find(
    (m) => m.speakerAgent === "deepseek" || m.speakerAgent === "gemini"
  );
  mem.lastContributingAgent = lastAgentMsg ? lastAgentMsg.speakerAgent : null;

  // Memory contributors
  const contributors = new Set();
  for (const m of (thread.conversationMessages || [])) {
    if (m.speakerAgent === "deepseek" || m.speakerAgent === "gemini") {
      contributors.add(m.speakerAgent);
    }
  }
  mem.memoryContributors = Array.from(contributors);

  // Memory focus
  if (mem.openQuestions.length > 0) {
    mem.memoryFocus = "offene_klärung";
  } else if (mem.agreedDirection) {
    mem.memoryFocus = "vereinbarte_richtung";
  } else if (mem.caseScope) {
    mem.memoryFocus = "scope_definiert";
  } else {
    mem.memoryFocus = "exploration";
  }

  mem.lastMemorySource = triggerSource;

  // Derive continuity status and freshness
  mem.caseContinuityStatus = _deriveCaseContinuityStatus(mem, thread);
  mem.memoryFreshness = _deriveMemoryFreshness(mem, thread);

  // Build working summary
  mem.workingSummary = _buildWorkingSummary(thread, agentCase, mem);
  mem.workingSummaryReady = !!mem.workingSummary;

  // Update metadata
  mem.memoryUpdatedAt = now;
  mem.memoryUpdateCount += 1;
  mem.memoryVersion += 1;

  logger.info("[agentBridge] Step 23 – Case Memory aktualisiert", {
    threadId: thread.threadId,
    triggerSource,
    anchorCount: mem.memoryAnchors.length,
    openQuestionCount: mem.openQuestions.length,
    resolvedPointCount: mem.resolvedPoints.length,
    continuityStatus: mem.caseContinuityStatus,
    memoryFreshness: mem.memoryFreshness,
    dominantMemoryOwner: mem.dominantMemoryOwner,
    memoryFocus: mem.memoryFocus,
    memoryVersion: mem.memoryVersion,
  });

  return mem;
}

/**
 * Inject case memory context into an agent reply.
 * Adds contextual references to the case history so replies feel continuous.
 *
 * @param {string} replyText - original agent reply
 * @param {Object} thread
 * @param {Object|null} agentCase
 * @returns {string} enriched reply text
 */
function _injectMemoryIntoReply(replyText, thread, agentCase) {
  const mem = thread.caseMemory;
  if (!mem || mem.caseContinuityStatus === "continuity_not_started") {
    return replyText;
  }

  const contextParts = [];

  // Reference scope if established
  if (mem.caseScope && mem.caseContinuityStatus !== "continuity_not_started") {
    const scopeLabels = {
      backend: "den Backend-Bereich",
      frontend: "den Frontend-Bereich",
      api: "den API-Teil",
      cross_agent: "beide Bereiche",
    };
    const scopeLabel = scopeLabels[mem.caseScope] || mem.caseScope;
    contextParts.push(`Ich knüpfe an den bisherigen Stand an – der Scope liegt auf ${scopeLabel}.`);
  }

  // Reference agreed direction
  if (mem.agreedDirection && !mem.caseScope) {
    contextParts.push("Ich beziehe mich auf die bisherige Arbeitsrichtung.");
  }

  // Reference discarded directions (only on every third interaction to avoid repetition)
  if (mem.discardedDirections && mem.discardedDirections.length > 0 && (thread.messageCount % 3 === 0)) {
    contextParts.push("Wir hatten eine andere Richtung zuvor zurückgestellt.");
  }

  // Reference last open point
  if (mem.nextOpenStep && mem.openQuestions.length > 0) {
    contextParts.push(`Der letzte offene Punkt war: ${mem.openQuestions[mem.openQuestions.length - 1].question.substring(0, 60)}.`);
  }

  // Reference handoff state
  if (thread.handoffStatus === "handoff_completed" && mem.lastContributingAgent) {
    const otherAgent = mem.lastContributingAgent === "deepseek" ? "Gemini" : "DeepSeek";
    contextParts.push(`Die Übergabe an ${otherAgent} wurde bereits abgeschlossen.`);
  }

  if (contextParts.length === 0) {
    return replyText;
  }

  // Pick at most 2 context references to avoid overwhelming replies
  const selected = contextParts.slice(0, 2);
  return selected.join(" ") + " " + replyText;
}

/**
 * Retrieve case memory for a specific thread.
 *
 * @param {Object} params
 * @param {string} params.agentCaseId
 * @returns {Object|null}
 */
function getCaseMemory({ agentCaseId } = {}) {
  if (!agentCaseId) return null;

  const thread = _conversationThreads.get(agentCaseId);
  if (!thread) return null;

  const agentCase = _agentCaseRegistry.get(agentCaseId) || null;

  // Refresh memory before returning
  _updateCaseMemory(thread, agentCase, "memory_read");

  return {
    threadId: thread.threadId,
    caseId: thread.caseId,
    caseMemory: { ...thread.caseMemory },
    threadStatus: thread.threadStatus,
    conversationState: thread.conversationState,
    dominantAgent: thread.dominantAgent,
    messageCount: thread.messageCount,
    handoffStatus: thread.handoffStatus,
    crossAgentState: thread.crossAgentState,
    updatedAt: thread.updatedAt,
  };
}

/**
 * Build analytics summary across all threads with case memory.
 *
 * @returns {Object}
 */
function getCaseMemorySummary() {
  const threads = Array.from(_conversationThreads.values());

  const byContinuityStatus = {};
  const byMemoryFreshness = {};
  const byDominantMemoryOwner = {};
  const byMemoryFocus = {};
  const byCaseScope = {};

  let totalWithMemory = 0;
  let totalWithWorkingSummary = 0;
  let totalWithOpenQuestions = 0;
  let totalWithAgreedDirection = 0;
  let totalDeepseekDominated = 0;
  let totalGeminiDominated = 0;
  let totalCrossAgentDominated = 0;
  let totalAnchors = 0;
  let totalOpenQuestions = 0;
  let totalResolvedPoints = 0;

  for (const t of threads) {
    const agentCase = _agentCaseRegistry.get(t.caseId) || null;
    // Refresh memory
    _updateCaseMemory(t, agentCase, "summary_read");

    const mem = t.caseMemory;

    byContinuityStatus[mem.caseContinuityStatus] = (byContinuityStatus[mem.caseContinuityStatus] || 0) + 1;
    byMemoryFreshness[mem.memoryFreshness] = (byMemoryFreshness[mem.memoryFreshness] || 0) + 1;

    if (mem.dominantMemoryOwner) {
      byDominantMemoryOwner[mem.dominantMemoryOwner] = (byDominantMemoryOwner[mem.dominantMemoryOwner] || 0) + 1;
    }
    if (mem.memoryFocus) {
      byMemoryFocus[mem.memoryFocus] = (byMemoryFocus[mem.memoryFocus] || 0) + 1;
    }
    if (mem.caseScope) {
      byCaseScope[mem.caseScope] = (byCaseScope[mem.caseScope] || 0) + 1;
    }

    if (mem.memoryAnchors.length > 0) totalWithMemory += 1;
    if (mem.workingSummaryReady) totalWithWorkingSummary += 1;
    if (mem.openQuestions.length > 0) totalWithOpenQuestions += 1;
    if (mem.agreedDirection) totalWithAgreedDirection += 1;

    if (mem.dominantMemoryOwner === "deepseek") totalDeepseekDominated += 1;
    if (mem.dominantMemoryOwner === "gemini") totalGeminiDominated += 1;
    if (mem.dominantMemoryOwner === "cross_agent") totalCrossAgentDominated += 1;

    totalAnchors += mem.memoryAnchors.length;
    totalOpenQuestions += mem.openQuestions.length;
    totalResolvedPoints += mem.resolvedPoints.length;
  }

  // Thread-level memory summaries (most recent first)
  const memoryThreads = threads
    .filter((t) => t.caseMemory.memoryAnchors.length > 0 || t.caseMemory.workingSummaryReady)
    .sort((a, b) => (b.caseMemory.memoryUpdatedAt || "").localeCompare(a.caseMemory.memoryUpdatedAt || ""))
    .slice(0, CONVERSATION_SUMMARY_MAX_THREADS)
    .map((t) => ({
      threadId: t.threadId,
      caseContinuityStatus: t.caseMemory.caseContinuityStatus,
      memoryFreshness: t.caseMemory.memoryFreshness,
      dominantMemoryOwner: t.caseMemory.dominantMemoryOwner,
      memoryFocus: t.caseMemory.memoryFocus,
      anchorCount: t.caseMemory.memoryAnchors.length,
      openQuestionCount: t.caseMemory.openQuestions.length,
      resolvedPointCount: t.caseMemory.resolvedPoints.length,
      hasAgreedDirection: !!t.caseMemory.agreedDirection,
      hasWorkingSummary: t.caseMemory.workingSummaryReady,
      workingSummary: t.caseMemory.workingSummary,
      memoryUpdateCount: t.caseMemory.memoryUpdateCount,
      memoryUpdatedAt: t.caseMemory.memoryUpdatedAt,
    }));

  logger.info("[agentBridge] Step 23 – Case-Memory-Zusammenfassung erzeugt", {
    totalThreads: threads.length,
    totalWithMemory,
    totalWithWorkingSummary,
    totalWithOpenQuestions,
    totalWithAgreedDirection,
    totalAnchors,
  });

  return {
    totalThreads: threads.length,
    totalWithMemory,
    totalWithWorkingSummary,
    totalWithOpenQuestions,
    totalWithAgreedDirection,
    totalDeepseekDominated,
    totalGeminiDominated,
    totalCrossAgentDominated,
    totalAnchors,
    totalOpenQuestions,
    totalResolvedPoints,
    byContinuityStatus,
    byMemoryFreshness,
    byDominantMemoryOwner,
    byMemoryFocus,
    byCaseScope,
    memoryThreads,
    generatedAt: new Date().toISOString(),
  };
}

/* ─────────────────────────────────────────────────────────────────────
   Step 24: Action Negotiation / Option Comparison / Decision Framing

   Key functions:
   - _deriveActionOptions()        – derives 2–4 options from case state
   - _buildOptionText()            – human-readable option description
   - _buildOptionComparison()      – comparison dimensions per option
   - _deriveRecommendedOption()    – selects preferred option with reason
   - _deriveDecisionRoles()        – DeepSeek/Gemini roles per option
   - _deriveDecisionFrameStatus()  – lifecycle of the decision frame
   - _deriveDecisionTradeoff()     – open tradeoff / narrowing hint
   - _updateDecisionFrame()        – re-derives all decision frame fields
   - _injectDecisionFrameIntoReply() – enriches agent replies with options
   - getDecisionFrame()            – retrieves decision frame for a thread
   - getDecisionFrameSummary()     – analytics across all threads
   ───────────────────────────────────────────────────────────────────── */

/**
 * Derive 2–4 meaningful action options from case state, memory, and thread.
 *
 * @param {Object} thread
 * @param {Object|null} agentCase
 * @returns {Array<Object>} array of option objects
 */
function _deriveActionOptions(thread, agentCase) {
  const options = [];
  const mem = thread.caseMemory || {};
  const msgs = thread.conversationMessages || [];

  // Determine problem type / domain
  const agentRole = (agentCase && agentCase.agentRole) || null;
  const hasHandoffs = (thread.handoffCount || 0) > 0;
  const openQuestionCount = (mem.openQuestions || []).length;
  const hasCandidate = !!(agentCase && agentCase.applyCandidate19);
  const hasRuntime = !!(agentCase && agentCase.executionSession20);

  /** Derive contributors based on handoff state and agent role */
  const defaultAgent = agentRole === "gemini_frontend" ? "gemini" : "deepseek";
  const singleContributors = [defaultAgent];
  const crossContributors = ["deepseek", "gemini"];

  let optionCounter = 0;

  // --- Option A: Conservative / Diagnose deeper ---
  const optionA = {
    optionId: `opt-${thread.threadId}-${++optionCounter}`,
    optionLabel: "A",
    optionTitle: "Diagnose vertiefen, noch nichts vorbereiten",
    optionText: _buildOptionText("diagnose_deeper", agentCase, mem),
    optionStatus: "option_viable",
    optionOwner: defaultAgent,
    optionContributors: hasHandoffs ? crossContributors : singleContributors,
    optionStrategy: "conservative",
    comparison: _buildOptionComparison("diagnose_deeper", agentCase, mem, thread),
    createdAt: new Date().toISOString(),
  };
  options.push(optionA);

  // --- Option B: Targeted scope (backend or frontend only) ---
  const isBackendCase = !agentRole || agentRole === "deepseek_backend";
  const targetedScope = isBackendCase ? "backend" : "frontend";
  const targetedLabel = isBackendCase ? "nur Backend eingrenzen und vorbereiten" : "nur Frontend-Teil eingrenzen und vorbereiten";
  const optionB = {
    optionId: `opt-${thread.threadId}-${++optionCounter}`,
    optionLabel: "B",
    optionTitle: targetedLabel,
    optionText: _buildOptionText("targeted_scope", agentCase, mem),
    optionStatus: "option_viable",
    optionOwner: isBackendCase ? "deepseek" : "gemini",
    optionContributors: singleContributors,
    optionStrategy: "targeted",
    comparison: _buildOptionComparison("targeted_scope", agentCase, mem, thread),
    createdAt: new Date().toISOString(),
  };
  options.push(optionB);

  // --- Option C: Broader preparation (backend + frontend follow-up) ---
  // Only if cross-agent relevance or handoff history
  const crossLayerRelevance = hasHandoffs ||
    (agentCase && agentCase.needsCrossAgentReview) ||
    msgs.some((m) => (m.content || "").toLowerCase().match(/frontend|backend|cross|übergreifend|api.*ui|schicht/));

  if (crossLayerRelevance) {
    const optionC = {
      optionId: `opt-${thread.threadId}-${++optionCounter}`,
      optionLabel: "C",
      optionTitle: "Backend + kleine Frontend-Folge gemeinsam vorbereiten",
      optionText: _buildOptionText("broad_scope", agentCase, mem),
      optionStatus: "option_viable",
      optionOwner: "cross_agent",
      optionContributors: crossContributors,
      optionStrategy: "broad",
      comparison: _buildOptionComparison("broad_scope", agentCase, mem, thread),
      createdAt: new Date().toISOString(),
    };
    options.push(optionC);
  }

  // --- Option D: Wait / clarify first ---
  // Only if open questions exist or candidate not finalized
  if (openQuestionCount > 0 || (hasCandidate && !hasRuntime)) {
    const optionD = {
      optionId: `opt-${thread.threadId}-${++optionCounter}`,
      optionLabel: options.length === 2 ? "C" : "D",
      optionTitle: openQuestionCount > 0
        ? "Erst offene Punkte klären, dann entscheiden"
        : "Kandidat noch nicht finalisieren, erst Scope bestätigen",
      optionText: _buildOptionText("wait_clarify", agentCase, mem),
      optionStatus: "option_viable",
      optionOwner: "user_suggested",
      optionContributors: hasHandoffs ? crossContributors : singleContributors,
      optionStrategy: "wait",
      comparison: _buildOptionComparison("wait_clarify", agentCase, mem, thread),
      createdAt: new Date().toISOString(),
    };
    options.push(optionD);
  }

  // Ensure at least 2 options: if only A exists, add a generic targeted one
  if (options.length < 2) {
    const genericB = {
      optionId: `opt-${thread.threadId}-${++optionCounter}`,
      optionLabel: "B",
      optionTitle: "Scope eng halten und gezielt vorbereiten",
      optionText: _buildOptionText("targeted_scope", agentCase, mem),
      optionStatus: "option_viable",
      optionOwner: defaultAgent,
      optionContributors: singleContributors,
      optionStrategy: "targeted",
      comparison: _buildOptionComparison("targeted_scope", agentCase, mem, thread),
      createdAt: new Date().toISOString(),
    };
    options.push(genericB);
  }

  // Cap at DECISION_FRAME_MAX_OPTIONS
  return options.slice(0, DECISION_FRAME_MAX_OPTIONS);
}

/**
 * Build human-readable option text based on strategy type.
 * Returns cooperative German text for the admin UI.
 *
 * @param {string} strategyType
 * @param {Object|null} agentCase
 * @param {Object} mem - case memory
 * @returns {string} German option description
 */
function _buildOptionText(strategyType, agentCase, mem) {
  const problemTitle = (agentCase && agentCase.problemTitle) || "den aktuellen Fall";
  const scope = mem.caseScope || "den relevanten Bereich";
  const scopeLabel = scope === "backend" ? "den Backend-Teil"
    : scope === "frontend" ? "den Frontend-Teil"
    : scope === "cross_layer" ? "beide Schichten"
    : "den relevanten Bereich";

  switch (strategyType) {
    case "diagnose_deeper":
      return `Diese Option hält den Scope bewusst eng und vertieft zuerst die Diagnose für ${problemTitle}. ` +
        `Es werden noch keine Entwürfe vorbereitet – stattdessen wird geprüft, ob die bisherige Analyse ausreicht. ` +
        `Das ist die konservativste Richtung.`;

    case "targeted_scope":
      return `Diese Option konzentriert sich gezielt auf ${scopeLabel} und bereitet dort einen konkreten Entwurf vor. ` +
        `Der Scope bleibt eng, und andere Schichten werden bewusst nicht mitgenommen. ` +
        `Das ist ein fokussierter, schneller Weg.`;

    case "broad_scope":
      return `Diese Option ergänzt zusätzlich eine kleine Folge für die andere Schicht. ` +
        `Backend und Frontend werden gemeinsam betrachtet, was mehr Wirkung hat, aber auch etwas mehr Breite erfordert. ` +
        `Das ist die vollständigere Richtung.`;

    case "wait_clarify":
      return `Diese Option wartet bewusst ab und klärt erst die offenen Punkte, bevor eine Richtung gewählt wird. ` +
        `Das gibt mehr Sicherheit, braucht aber auch etwas mehr Zeit. ` +
        `Das ist die vorsichtigste Richtung.`;

    default:
      return `Diese Option adressiert ${problemTitle} im Bereich ${scopeLabel}.`;
  }
}

/**
 * Build comparison dimensions for a single option.
 *
 * @param {string} strategyType
 * @param {Object|null} agentCase
 * @param {Object} mem
 * @param {Object} thread
 * @returns {Object} dimension ratings
 */
function _buildOptionComparison(strategyType, agentCase, mem, thread) {
  const hasHandoffs = (thread.handoffCount || 0) > 0;
  const openQs = (mem.openQuestions || []).length;

  const base = {
    scopeWidth: "low",
    riskLevel: "low",
    safetyLevel: "high",
    implementationBreadth: "low",
    confidenceLevel: "moderate",
    expectedImpact: "moderate",
    reversibility: "high",
    needsCrossAgentSupport: hasHandoffs ? "moderate" : "low",
    needsMoreDiagnosis: openQs > 0 ? "high" : "low",
    readinessHint: "moderate",
  };

  switch (strategyType) {
    case "diagnose_deeper":
      return {
        ...base,
        scopeWidth: "low",
        riskLevel: "low",
        safetyLevel: "very_high",
        implementationBreadth: "low",
        confidenceLevel: openQs > 0 ? "low" : "moderate",
        expectedImpact: "low",
        reversibility: "very_high",
        needsMoreDiagnosis: "high",
        readinessHint: "low",
      };

    case "targeted_scope":
      return {
        ...base,
        scopeWidth: "moderate",
        riskLevel: "low",
        safetyLevel: "high",
        implementationBreadth: "moderate",
        confidenceLevel: "moderate",
        expectedImpact: "moderate",
        reversibility: "high",
        needsMoreDiagnosis: openQs > 0 ? "moderate" : "low",
        readinessHint: "moderate",
      };

    case "broad_scope":
      return {
        ...base,
        scopeWidth: "high",
        riskLevel: "moderate",
        safetyLevel: "moderate",
        implementationBreadth: "high",
        confidenceLevel: "moderate",
        expectedImpact: "high",
        reversibility: "moderate",
        needsCrossAgentSupport: "high",
        needsMoreDiagnosis: openQs > 0 ? "moderate" : "low",
        readinessHint: hasHandoffs ? "moderate" : "low",
      };

    case "wait_clarify":
      return {
        ...base,
        scopeWidth: "low",
        riskLevel: "low",
        safetyLevel: "very_high",
        implementationBreadth: "low",
        confidenceLevel: "low",
        expectedImpact: "low",
        reversibility: "very_high",
        needsMoreDiagnosis: "very_high",
        readinessHint: "low",
      };

    default:
      return base;
  }
}

/**
 * Derive the recommended option and role-based labels.
 *
 * @param {Array<Object>} options
 * @param {Object} thread
 * @param {Object|null} agentCase
 * @param {Object} mem
 * @returns {Object} recommendation object
 */
function _deriveRecommendedOption(options, thread, agentCase, mem) {
  if (!options || options.length === 0) {
    return {
      recommendedOptionId: null,
      recommendedBecause: null,
      conservativeOptionId: null,
      fastestOptionId: null,
      widestOptionId: null,
      safestOptionId: null,
      preferredStrategy: null,
    };
  }

  const conservative = options.find((o) => o.optionStrategy === "conservative") || options[0];
  const targeted = options.find((o) => o.optionStrategy === "targeted");
  const broad = options.find((o) => o.optionStrategy === "broad");
  const wait = options.find((o) => o.optionStrategy === "wait");

  const openQs = (mem.openQuestions || []).length;
  const hasAgreedDirection = !!mem.agreedDirection;
  const hasDraft = !!(agentCase && agentCase.actionDraft16);

  // Decision logic: prefer conservative when uncertain, targeted when direction is clear
  let recommended;
  let because;

  if (openQs > DECISION_OPEN_QUESTIONS_THRESHOLD) {
    recommended = wait || conservative;
    because = "Es gibt noch mehrere offene Punkte. Eine vorsichtige Klärung ist aktuell sinnvoller als ein breiter Entwurf.";
  } else if (!hasAgreedDirection && !hasDraft) {
    recommended = conservative;
    because = "Es gibt noch keine vereinbarte Richtung. Die Diagnose zuerst zu vertiefen gibt mehr Sicherheit.";
  } else if (hasAgreedDirection && targeted) {
    recommended = targeted;
    because = "Es gibt bereits eine klare Richtung. Ein gezielter, enger Entwurf passt gut zum aktuellen Stand.";
  } else {
    recommended = targeted || conservative;
    because = "Der aktuelle Stand spricht für einen fokussierten nächsten Schritt.";
  }

  // Mark recommended option
  for (const opt of options) {
    opt.optionStatus = opt.optionId === recommended.optionId ? "option_preferred" : "option_viable";
  }

  return {
    recommendedOptionId: recommended.optionId,
    recommendedBecause: because,
    conservativeOptionId: conservative.optionId,
    fastestOptionId: (targeted || conservative).optionId,
    widestOptionId: broad ? broad.optionId : (targeted || conservative).optionId,
    safestOptionId: (wait || conservative).optionId,
    preferredStrategy: recommended.optionStrategy,
  };
}

/**
 * Derive DeepSeek / Gemini decision roles for the option set.
 *
 * @param {Array<Object>} options
 * @param {Object} thread
 * @param {Object|null} agentCase
 * @returns {Object} decision role info
 */
function _deriveDecisionRoles(options, thread, agentCase) {
  const hasHandoffs = (thread.handoffCount || 0) > 0;
  const agentRole = (agentCase && agentCase.agentRole) || null;

  const ownerCounts = { deepseek: 0, gemini: 0, cross_agent: 0, user_suggested: 0 };
  for (const opt of options) {
    if (ownerCounts[opt.optionOwner] !== undefined) {
      ownerCounts[opt.optionOwner] += 1;
    }
  }

  let primaryAgent = "deepseek";
  let secondaryAgent = null;

  if (ownerCounts.gemini > ownerCounts.deepseek) {
    primaryAgent = "gemini";
    secondaryAgent = ownerCounts.deepseek > 0 ? "deepseek" : null;
  } else if (ownerCounts.deepseek > 0) {
    primaryAgent = "deepseek";
    secondaryAgent = ownerCounts.gemini > 0 ? "gemini" : null;
  }

  if (ownerCounts.cross_agent > 0 || hasHandoffs) {
    secondaryAgent = primaryAgent === "deepseek" ? "gemini" : "deepseek";
  }

  return {
    primaryDecisionAgent: primaryAgent,
    secondaryDecisionAgent: secondaryAgent,
    crossAgentDecisionNeeded: ownerCounts.cross_agent > 0 || hasHandoffs,
    decisionFocus: agentRole === "gemini_frontend" ? "frontend" : "backend",
  };
}

/**
 * Derive the decision frame status from the current option set.
 *
 * @param {Array<Object>} options
 * @param {Object} recommendation
 * @param {Object} mem
 * @param {Object} thread
 * @returns {string}
 */
function _deriveDecisionFrameStatus(options, recommendation, mem, thread) {
  if (!options || options.length === 0) return "options_not_ready";

  const openQs = (mem.openQuestions || []).length;
  const hasRecommendation = !!recommendation.recommendedOptionId;
  const viableCount = options.filter((o) => o.optionStatus !== "option_discarded").length;

  if (viableCount <= 1 && hasRecommendation) return "decision_ready_for_user";
  if (hasRecommendation && openQs === 0) return "decision_narrowed";
  if (hasRecommendation && openQs > 0) return "decision_pending";
  if (viableCount >= 2) return "options_stable";
  return "options_prepared";
}

/**
 * Derive the current decision tradeoff, narrowing hint and open question.
 *
 * @param {Array<Object>} options
 * @param {Object} recommendation
 * @param {Object} mem
 * @param {Object|null} agentCase
 * @returns {Object}
 */
function _deriveDecisionTradeoff(options, recommendation, mem, agentCase) {
  const openQs = (mem.openQuestions || []).length;
  const conservative = options.find((o) => o.optionStrategy === "conservative");
  const targeted = options.find((o) => o.optionStrategy === "targeted");
  const broad = options.find((o) => o.optionStrategy === "broad");

  let tradeoff = null;
  let narrowingHint = null;
  let nextQuestion = null;
  let optionContrast = null;
  let pendingReason = null;
  let mode = null;

  if (conservative && broad) {
    tradeoff = "Der Hauptunterschied liegt zwischen einem engen, sicheren Schritt und einer breiteren Lösung mit mehr Wirkung.";
    optionContrast = `${conservative.optionLabel} (eng/sicher) vs. ${broad.optionLabel} (breit/wirkungsvoll)`;
    mode = "conservative_vs_broad";
  } else if (conservative && targeted) {
    tradeoff = "Der Unterschied liegt zwischen weiterer Diagnose und einem gezielten Entwurf im engeren Scope.";
    optionContrast = `${conservative.optionLabel} (Diagnose vertiefen) vs. ${targeted.optionLabel} (gezielt vorbereiten)`;
    mode = "diagnosis_vs_action";
  }

  if (openQs > 0) {
    nextQuestion = `Es gibt noch ${openQs} offene ${openQs === 1 ? "Frage" : "Fragen"}, die vor einer engeren Entscheidung geklärt werden sollten.`;
    pendingReason = "Offene Punkte müssen erst geklärt werden.";
    narrowingHint = "Wenn die offenen Fragen beantwortet sind, kann der Entscheidungsraum enger gefasst werden.";
  } else if (!mem.agreedDirection) {
    nextQuestion = "Es gibt noch keine vereinbarte Richtung. Welchen Scope möchtest du bevorzugen?";
    pendingReason = "Noch keine klare Richtungsentscheidung.";
    narrowingHint = "Sobald eine Richtung vereinbart ist, reduzieren sich die Optionen.";
  } else {
    nextQuestion = null;
    pendingReason = null;
    narrowingHint = "Der Entscheidungsraum ist bereits gut eingegrenzt.";
  }

  return {
    decisionTradeoff: tradeoff,
    narrowingHint,
    nextDecisionQuestion: nextQuestion,
    optionContrast,
    pendingDecisionReason: pendingReason,
    decisionMode: mode,
    userDecisionNeeded: !!nextQuestion,
  };
}

/**
 * Build the human-readable option summary text.
 *
 * @param {Array<Object>} options
 * @param {Object} recommendation
 * @returns {string}
 */
function _buildOptionSummary(options, recommendation) {
  if (!options || options.length === 0) return null;

  const parts = [`Ich sehe aktuell ${options.length} sinnvolle Wege:`];

  for (const opt of options) {
    const prefix = opt.optionId === recommendation.recommendedOptionId
      ? `▸ Option ${opt.optionLabel} (empfohlen)`
      : `  Option ${opt.optionLabel}`;
    parts.push(`${prefix}: ${opt.optionTitle}`);
  }

  if (recommendation.recommendedBecause) {
    parts.push("");
    parts.push(`Aktuell würde ich Option ${options.find((o) => o.optionId === recommendation.recommendedOptionId)?.optionLabel || "?"} bevorzugen, weil: ${recommendation.recommendedBecause}`);
  }

  return parts.join("\n");
}

/**
 * Build the decision context summary.
 *
 * @param {Object} thread
 * @param {Object|null} agentCase
 * @param {Object} mem
 * @returns {string|null}
 */
function _buildDecisionContext(thread, agentCase, mem) {
  const parts = [];

  if (mem.caseScope) {
    const scopeLabels = {
      backend: "Backend",
      frontend: "Frontend",
      cross_layer: "Backend + Frontend",
      data_layer: "Datenschicht",
    };
    parts.push(`Scope: ${scopeLabels[mem.caseScope] || mem.caseScope}`);
  }

  if (mem.agreedDirection) {
    parts.push(`Vereinbarte Richtung: ${mem.agreedDirection}`);
  }

  if (thread.handoffCount > 0) {
    parts.push(`${thread.handoffCount} Agent-Übergabe(n) bereits erfolgt`);
  }

  const openQs = (mem.openQuestions || []).length;
  if (openQs > 0) {
    parts.push(`${openQs} offene ${openQs === 1 ? "Frage" : "Fragen"}`);
  }

  if (parts.length === 0) return null;
  return parts.join(" · ");
}

/**
 * Re-derive all decision frame fields for a thread.
 *
 * @param {Object} thread
 * @param {Object|null} agentCase
 * @param {string} triggerSource - what triggered the update
 */
function _updateDecisionFrame(thread, agentCase, triggerSource) {
  const df = thread.decisionFrame;
  const mem = thread.caseMemory || {};
  const now = new Date().toISOString();

  // Only derive options when there's enough conversation context
  const minMessages = 2;
  if ((thread.messageCount || 0) < minMessages) {
    df.decisionFrameStatus = "options_not_ready";
    return df;
  }

  // Derive action options
  const prevOptionCount = df.optionCount;
  const prevRecommended = df.recommendedOptionId;

  df.actionOptions = _deriveActionOptions(thread, agentCase);
  df.optionCount = df.actionOptions.length;

  // Derive recommendation
  const recommendation = _deriveRecommendedOption(df.actionOptions, thread, agentCase, mem);
  df.recommendedOptionId = recommendation.recommendedOptionId;
  df.recommendedBecause = recommendation.recommendedBecause;
  df.conservativeOptionId = recommendation.conservativeOptionId;
  df.fastestOptionId = recommendation.fastestOptionId;
  df.widestOptionId = recommendation.widestOptionId;
  df.safestOptionId = recommendation.safestOptionId;
  df.preferredStrategy = recommendation.preferredStrategy;

  // Derive decision roles
  const roles = _deriveDecisionRoles(df.actionOptions, thread, agentCase);
  df.primaryDecisionAgent = roles.primaryDecisionAgent;
  df.secondaryDecisionAgent = roles.secondaryDecisionAgent;
  df.crossAgentDecisionNeeded = roles.crossAgentDecisionNeeded;

  // Derive tradeoff / narrowing / open question
  const tradeoff = _deriveDecisionTradeoff(df.actionOptions, recommendation, mem, agentCase);
  df.decisionTradeoff = tradeoff.decisionTradeoff;
  df.narrowingHint = tradeoff.narrowingHint;
  df.nextDecisionQuestion = tradeoff.nextDecisionQuestion;
  df.optionContrast = tradeoff.optionContrast;
  df.pendingDecisionReason = tradeoff.pendingDecisionReason;
  df.decisionMode = tradeoff.decisionMode;
  df.userDecisionNeeded = tradeoff.userDecisionNeeded;

  // Derive status
  df.decisionFrameStatus = _deriveDecisionFrameStatus(df.actionOptions, recommendation, mem, thread);

  // Build summaries
  df.optionSummary = _buildOptionSummary(df.actionOptions, recommendation);
  df.decisionContext = _buildDecisionContext(thread, agentCase, mem);

  // Update metadata
  df.decisionFrameUpdatedAt = now;
  df.decisionFrameUpdateCount += 1;
  df.decisionFrameVersion += 1;

  // Logging
  const recommendationChanged = prevRecommended !== null && prevRecommended !== df.recommendedOptionId;
  logger.info("[agentBridge] Step 24 – Decision Frame aktualisiert", {
    threadId: thread.threadId,
    triggerSource,
    optionCount: df.optionCount,
    decisionFrameStatus: df.decisionFrameStatus,
    recommendedOptionId: df.recommendedOptionId,
    preferredStrategy: df.preferredStrategy,
    decisionMode: df.decisionMode,
    crossAgentDecisionNeeded: df.crossAgentDecisionNeeded,
    userDecisionNeeded: df.userDecisionNeeded,
    recommendationChanged,
    frameVersion: df.decisionFrameVersion,
  });

  if (recommendationChanged) {
    logger.info("[agentBridge] Step 24 – Empfohlene Option gewechselt", {
      threadId: thread.threadId,
      previousRecommended: prevRecommended,
      newRecommended: df.recommendedOptionId,
      reason: df.recommendedBecause,
    });
  }

  return df;
}

/**
 * Inject decision frame context into an agent reply.
 * Adds brief option awareness so replies feel decision-oriented.
 *
 * @param {string} replyText
 * @param {Object} thread
 * @param {Object|null} agentCase
 * @returns {string}
 */
function _injectDecisionFrameIntoReply(replyText, thread, agentCase) {
  const df = thread.decisionFrame;
  if (!df || df.decisionFrameStatus === "options_not_ready" || df.optionCount === 0) {
    return replyText;
  }

  const injections = [];

  // Reference the current decision framing lightly
  if (df.optionCount >= 2 && df.decisionFrameStatus !== "options_not_ready") {
    const recommendedOpt = df.actionOptions.find((o) => o.optionId === df.recommendedOptionId);
    if (recommendedOpt) {
      injections.push(
        `\n\nDer eigentliche Entscheidungspunkt liegt gerade hier: Ich sehe ${df.optionCount} sinnvolle Wege. ` +
        `Aktuell würde ich Option ${recommendedOpt.optionLabel} bevorzugen – ${recommendedOpt.optionTitle.toLowerCase()}.`
      );
    }

    if (df.nextDecisionQuestion) {
      injections.push(` ${df.nextDecisionQuestion}`);
    }

    if (df.narrowingHint && df.decisionFrameStatus !== "decision_ready_for_user") {
      injections.push(` ${df.narrowingHint}`);
    }
  }

  if (injections.length === 0) return replyText;
  return replyText + injections.join("");
}

/**
 * Retrieve the decision frame for a specific thread.
 *
 * @param {Object} params
 * @param {string} params.agentCaseId
 * @returns {Object|null}
 */
function getDecisionFrame({ agentCaseId } = {}) {
  if (!agentCaseId) return null;

  const thread = _conversationThreads.get(agentCaseId);
  if (!thread) return null;

  const agentCase = _agentCaseRegistry.get(agentCaseId) || null;

  // Refresh decision frame
  _updateDecisionFrame(thread, agentCase, "decision_frame_read");

  const df = thread.decisionFrame;

  logger.info("[agentBridge] Step 24 – Decision Frame abgerufen", {
    threadId: agentCaseId,
    decisionFrameStatus: df.decisionFrameStatus,
    optionCount: df.optionCount,
    recommendedOptionId: df.recommendedOptionId,
  });

  return {
    threadId: agentCaseId,
    decisionFrameStatus: df.decisionFrameStatus,
    decisionMode: df.decisionMode,
    optionCount: df.optionCount,
    actionOptions: df.actionOptions,
    recommendedOptionId: df.recommendedOptionId,
    recommendedBecause: df.recommendedBecause,
    conservativeOptionId: df.conservativeOptionId,
    fastestOptionId: df.fastestOptionId,
    widestOptionId: df.widestOptionId,
    safestOptionId: df.safestOptionId,
    primaryDecisionAgent: df.primaryDecisionAgent,
    secondaryDecisionAgent: df.secondaryDecisionAgent,
    crossAgentDecisionNeeded: df.crossAgentDecisionNeeded,
    decisionTradeoff: df.decisionTradeoff,
    nextDecisionQuestion: df.nextDecisionQuestion,
    narrowingHint: df.narrowingHint,
    userDecisionNeeded: df.userDecisionNeeded,
    optionContrast: df.optionContrast,
    pendingDecisionReason: df.pendingDecisionReason,
    optionSummary: df.optionSummary,
    preferredStrategy: df.preferredStrategy,
    decisionContext: df.decisionContext,
    decisionFrameUpdatedAt: df.decisionFrameUpdatedAt,
    decisionFrameUpdateCount: df.decisionFrameUpdateCount,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Build analytics summary across all threads with decision frames.
 *
 * @returns {Object}
 */
function getDecisionFrameSummary() {
  const threads = Array.from(_conversationThreads.values());

  let totalWithOptions = 0;
  let totalWithRecommendation = 0;
  let totalWithTradeoff = 0;
  let totalUserDecisionNeeded = 0;
  let totalCrossAgentDecisions = 0;
  let totalConservative = 0;
  let totalTargeted = 0;
  let totalBroad = 0;
  let totalWait = 0;

  const byDecisionFrameStatus = {};
  const byDecisionMode = {};
  const byPreferredStrategy = {};
  const byPrimaryAgent = {};

  for (const t of threads) {
    const df = t.decisionFrame;
    if (!df || df.decisionFrameStatus === "options_not_ready") continue;

    totalWithOptions += 1;
    if (df.recommendedOptionId) totalWithRecommendation += 1;
    if (df.decisionTradeoff) totalWithTradeoff += 1;
    if (df.userDecisionNeeded) totalUserDecisionNeeded += 1;
    if (df.crossAgentDecisionNeeded) totalCrossAgentDecisions += 1;

    // Count strategies
    for (const opt of (df.actionOptions || [])) {
      if (opt.optionStrategy === "conservative") totalConservative += 1;
      if (opt.optionStrategy === "targeted") totalTargeted += 1;
      if (opt.optionStrategy === "broad") totalBroad += 1;
      if (opt.optionStrategy === "wait") totalWait += 1;
    }

    // Distribution by status
    byDecisionFrameStatus[df.decisionFrameStatus] = (byDecisionFrameStatus[df.decisionFrameStatus] || 0) + 1;

    // Distribution by mode
    if (df.decisionMode) {
      byDecisionMode[df.decisionMode] = (byDecisionMode[df.decisionMode] || 0) + 1;
    }

    // Distribution by preferred strategy
    if (df.preferredStrategy) {
      byPreferredStrategy[df.preferredStrategy] = (byPreferredStrategy[df.preferredStrategy] || 0) + 1;
    }

    // Distribution by primary agent
    if (df.primaryDecisionAgent) {
      byPrimaryAgent[df.primaryDecisionAgent] = (byPrimaryAgent[df.primaryDecisionAgent] || 0) + 1;
    }
  }

  const decisionThreads = threads
    .filter((t) => t.decisionFrame && t.decisionFrame.decisionFrameStatus !== "options_not_ready")
    .slice(-20)
    .map((t) => ({
      threadId: t.threadId,
      decisionFrameStatus: t.decisionFrame.decisionFrameStatus,
      optionCount: t.decisionFrame.optionCount,
      recommendedOptionId: t.decisionFrame.recommendedOptionId,
      preferredStrategy: t.decisionFrame.preferredStrategy,
      decisionMode: t.decisionFrame.decisionMode,
      crossAgentDecisionNeeded: t.decisionFrame.crossAgentDecisionNeeded,
      userDecisionNeeded: t.decisionFrame.userDecisionNeeded,
      primaryDecisionAgent: t.decisionFrame.primaryDecisionAgent,
      decisionFrameUpdateCount: t.decisionFrame.decisionFrameUpdateCount,
      decisionFrameUpdatedAt: t.decisionFrame.decisionFrameUpdatedAt,
    }));

  logger.info("[agentBridge] Step 24 – Decision-Frame-Zusammenfassung erzeugt", {
    totalThreads: threads.length,
    totalWithOptions,
    totalWithRecommendation,
    totalUserDecisionNeeded,
    totalCrossAgentDecisions,
  });

  return {
    totalThreads: threads.length,
    totalWithOptions,
    totalWithRecommendation,
    totalWithTradeoff,
    totalUserDecisionNeeded,
    totalCrossAgentDecisions,
    totalConservative,
    totalTargeted,
    totalBroad,
    totalWait,
    byDecisionFrameStatus,
    byDecisionMode,
    byPreferredStrategy,
    byPrimaryAgent,
    decisionThreads,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Derive thread status from current state.
 * @param {Object} thread
 * @param {Object} agentCase
 * @returns {string} thread status
 */
function _deriveThreadStatus(thread, agentCase) {
  if (!thread.conversationOpen) return "thread_closed";

  if (agentCase) {
    if (agentCase.executionSession20 && agentCase.executionSession20.runtimeStatus === "runtime_running") {
      return "thread_runtime_pending";
    }
    if (agentCase.status === "blocked" || agentCase.status === "rejected") {
      return "thread_blocked";
    }
  }

  if (thread.awaitingUserReply) return "thread_waiting_for_user";
  if (thread.awaitingAgentReply) return "thread_waiting_for_agent";

  // Check conversation phase for readiness
  const phase = _deriveConversationPhase(thread, agentCase);
  if (phase === "approval_phase" || phase === "candidate_gate_phase") {
    return "thread_ready_for_decision";
  }
  if (phase === "refinement_phase" || phase === "feedback_phase") {
    return "thread_in_refinement";
  }

  return "thread_open";
}

/**
 * Build a conversation summary line for a thread.
 * @param {Object} thread
 * @returns {string}
 */
function _buildConversationSummaryLine(thread) {
  const parts = [];
  parts.push(`${thread.messageCount} Nachrichten`);
  if (thread.userMessageCount > 0) parts.push(`${thread.userMessageCount} vom User`);
  if (thread.deepseekMessageCount > 0) parts.push(`${thread.deepseekMessageCount} von DeepSeek`);
  if (thread.geminiMessageCount > 0) parts.push(`${thread.geminiMessageCount} von Gemini`);
  parts.push(`Status: ${thread.threadStatus}`);
  if (thread.awaitingUserReply) parts.push("wartet auf User");
  if (thread.awaitingAgentReply) parts.push("wartet auf Agent");
  // Step 22: handoff info
  if (thread.handoffCount > 0) parts.push(`${thread.handoffCount} Übergabe(n)`);
  if (thread.handoffStatus === "handoff_in_progress") parts.push("Übergabe aktiv");
  if (thread.supportingAgent) parts.push(`Unterstützung: ${thread.supportingAgent}`);
  // Step 23: memory info
  if (thread.caseMemory) {
    if (thread.caseMemory.caseContinuityStatus !== "continuity_not_started") {
      parts.push(`Kontinuität: ${thread.caseMemory.caseContinuityStatus}`);
    }
    if (thread.caseMemory.openQuestions && thread.caseMemory.openQuestions.length > 0) {
      parts.push(`${thread.caseMemory.openQuestions.length} offene Frage(n)`);
    }
    if (thread.caseMemory.memoryAnchors && thread.caseMemory.memoryAnchors.length > 0) {
      parts.push(`${thread.caseMemory.memoryAnchors.length} Anker`);
    }
  }
  return parts.join(" · ");
}

/**
 * Accept a free user message for an agent case and generate a contextual agent reply.
 *
 * @param {Object} params
 * @param {string} params.agentCaseId - the agent case to address
 * @param {string} params.userMessage - free-form user text
 * @param {string} [params.replyToMessageId] - optional reference to a prior message
 * @param {string} [params.quotedMessageId] - optional quoted message
 * @returns {Object} result with user message, agent reply, thread state
 */
/**
 * Call the real AI API for a Step-21 conversation thread.
 * Uses _conferenceAgentRegistry for dispatch so new agents are plug-and-play.
 * Falls back to the static template reply when the API is unavailable.
 *
 * @param {Object} params
 * @param {string} params.speakerAgent  - "deepseek" | "gemini" | any registered agent id
 * @param {string} params.messageIntent
 * @param {string} params.userMessage
 * @param {Object} params.agentCase
 * @param {Object} params.thread
 * @returns {Promise<string>} agent reply text
 * @private
 */
async function _generateConversationReply({ speakerAgent, messageIntent, userMessage, agentCase, thread }) {
  const agentDef = _conferenceAgentRegistry.get(speakerAgent);
  if (!agentDef || !agentDef.isConfigured()) {
    // Fall back to static templates when API is not available
    return _generateAgentReply({ speakerAgent, messageIntent, userMessage, agentCase, thread });
  }

  const problemTitle = (agentCase && agentCase.problemTitle) || "den aktuellen Fall";
  const safeMsg = (userMessage || "").slice(0, CONVERSATION_USER_MSG_MAX_INPUT);

  // Build conversation history from thread
  const recentHistory = (thread.conversationMessages || [])
    .slice(-8)
    .filter((m) => m.messageRole === "user" || (m.messageRole === "agent" && m.speakerAgent !== "system"))
    .map((m) => {
      const isOwn = m.messageRole === "agent" && m.speakerAgent === speakerAgent;
      const label = m.messageRole === "user" ? "Nutzer" : isOwn ? agentDef.label : "Anderer Agent";
      return `${label}: ${(m.content || "").slice(0, CONFERENCE_HISTORY_MSG_MAX_LENGTH)}`;
    })
    .join("\n");

  const systemPrompt = [
    `Du bist ${agentDef.label}, ein spezialisierter KI-Assistent für ${agentDef.domain}.`,
    `Du führst einen technischen Dialog zu: ${problemTitle}.`,
    `Antworte immer auf Deutsch. Sei kooperativ, klar und präzise. Maximal 5 Sätze.`,
  ].join("\n");

  const fullMessage = recentHistory
    ? `${recentHistory}\n\nNutzer: ${safeMsg}`
    : safeMsg;

  try {
    const text = await agentDef.callApi(systemPrompt, fullMessage, {
      timeoutMs: speakerAgent === "deepseek" ? 20000 : 22000,
      maxTokens: 600,
      temperature: 0.5,
    });
    if (text.trim()) return text.trim();
  } catch (err) {
    logger.warn("[agentBridge] Step 21 – API Fehler, Fallback auf Template", {
      agent: speakerAgent,
      message: err.message,
    });
  }
  return _generateAgentReply({ speakerAgent, messageIntent, userMessage, agentCase, thread });
}

async function sendUserMessage({ agentCaseId, userMessage, replyToMessageId = null, quotedMessageId = null } = {}) {
  if (!agentCaseId) {
    logger.warn("[agentBridge] Step 21 – sendUserMessage ohne agentCaseId");
    return { success: false, error: "agentCaseId is required" };
  }
  if (!userMessage || typeof userMessage !== "string" || userMessage.trim().length === 0) {
    logger.warn("[agentBridge] Step 21 – sendUserMessage ohne userMessage");
    return { success: false, error: "userMessage is required and must be a non-empty string" };
  }

  const agentCase = _agentCaseRegistry.get(agentCaseId) || null;
  const thread = getOrCreateConversationThread(agentCaseId);

  // Derive intent from user message
  const messageIntent = _deriveMessageIntent(userMessage);

  // --- 1. Record user message ---
  _conversationMsgCounter += 1;
  const userMsgId = `conv-${Date.now()}-${_conversationMsgCounter}`;
  const now = new Date().toISOString();

  const userMsgRecord = {
    messageId: userMsgId,
    threadId: agentCaseId,
    caseId: agentCaseId,
    messageRole: "user",
    speakerAgent: "user",
    speakerRole: "admin",
    messageIntent,
    messagePhase: _deriveConversationPhase(thread, agentCase),
    content: userMessage.trim(),
    replyToMessageId: replyToMessageId || null,
    quotedMessageId: quotedMessageId || null,
    followUpOf: thread.conversationMessages.length > 0
      ? thread.conversationMessages[thread.conversationMessages.length - 1].messageId
      : null,
    relatedCaseId: agentCaseId,
    relatedDraftId: agentCase && agentCase.actionDraft16 ? agentCase.actionDraft16.draftId || null : null,
    createdAt: now,
  };

  thread.conversationMessages.push(userMsgRecord);
  thread.userMessageCount += 1;
  thread.messageCount += 1;
  thread.lastUserMessageAt = now;
  thread.lastSpeaker = "user";
  thread.awaitingAgentReply = true;
  thread.awaitingUserReply = false;

  // Also record in global agent chat messages
  _recordAgentChatMessage({
    agentCaseId,
    agentRole: "user",
    messageType: "status_update",
    messageIntent: messageIntent,
    messagePriority: "normal",
    requiresUserDecision: false,
    message: userMessage.trim(),
    planPhase: "conversation_phase",
  });

  logger.info("[agentBridge] Step 21 – User-Nachricht empfangen", {
    threadId: agentCaseId,
    messageIntent,
    messageLength: userMessage.trim().length,
  });

  // --- 2. Route to appropriate agent ---
  const routing = _routeToAgent(userMessage, agentCase);

  // --- 3. Generate agent reply via real API (falls back to template when unconfigured) ---
  let agentReplyText = await _generateConversationReply({
    speakerAgent: routing.speakerAgent,
    messageIntent,
    userMessage: userMessage.trim(),
    agentCase,
    thread,
  });

  // Step 23: Inject case memory context into agent reply
  agentReplyText = _injectMemoryIntoReply(agentReplyText, thread, agentCase);

  // Step 24: Inject decision frame context into agent reply
  agentReplyText = _injectDecisionFrameIntoReply(agentReplyText, thread, agentCase);

  _conversationMsgCounter += 1;
  const agentMsgId = `conv-${Date.now()}-${_conversationMsgCounter}`;
  const agentNow = new Date().toISOString();

  const agentMsgRecord = {
    messageId: agentMsgId,
    threadId: agentCaseId,
    caseId: agentCaseId,
    messageRole: "agent",
    speakerAgent: routing.speakerAgent,
    speakerRole: routing.speakerRole,
    messageIntent: messageIntent === "question" ? "explanation" : (messageIntent === "scope_change" ? "recommendation" : "follow_up"),
    messagePhase: _deriveConversationPhase(thread, agentCase),
    content: agentReplyText,
    replyToMessageId: userMsgId,
    quotedMessageId: null,
    followUpOf: userMsgId,
    relatedCaseId: agentCaseId,
    relatedDraftId: agentCase && agentCase.actionDraft16 ? agentCase.actionDraft16.draftId || null : null,
    routingReason: routing.routingReason,
    createdAt: agentNow,
  };

  thread.conversationMessages.push(agentMsgRecord);
  thread.agentMessageCount += 1;
  thread.messageCount += 1;
  if (routing.speakerAgent === "deepseek") thread.deepseekMessageCount += 1;
  if (routing.speakerAgent === "gemini") thread.geminiMessageCount += 1;
  thread.lastAgentMessageAt = agentNow;
  thread.lastSpeaker = routing.speakerAgent;
  thread.awaitingAgentReply = false;
  thread.awaitingUserReply = true;
  thread.nextSuggestedSpeaker = "user";
  thread.nextSuggestedIntent = "follow_up";

  // Record agent reply in global chat messages
  _recordAgentChatMessage({
    agentCaseId,
    agentRole: routing.speakerAgent === "deepseek" ? "deepseek_backend" : "gemini_frontend",
    messageType: "status_update",
    messageIntent: agentMsgRecord.messageIntent,
    messagePriority: "normal",
    requiresUserDecision: false,
    message: agentReplyText,
    planPhase: "conversation_phase",
  });

  // --- 4. Step 22: Assess and execute cross-agent handoff ---
  const handoffAssessment = _assessHandoffNeed(routing.speakerAgent, userMessage.trim(), messageIntent, agentCase, thread);
  let crossAgentNote = null;
  let handoffResult = null;

  if (handoffAssessment.needed) {
    // Execute the full handoff: initiation → supporting reply → completion
    handoffResult = await _executeHandoff({
      thread,
      primaryAgent: routing.speakerAgent,
      reason: handoffAssessment.reason,
      userMessage: userMessage.trim(),
      agentCase,
      afterMessageId: agentMsgId,
    });

    crossAgentNote = handoffResult.supportingAgentReply ? handoffResult.supportingAgentReply.content : null;

    logger.info("[agentBridge] Step 22 – Automatischer Handoff ausgeführt", {
      threadId: agentCaseId,
      primaryAgent: routing.speakerAgent,
      reason: handoffAssessment.reason,
      confidence: handoffAssessment.confidence,
      messagesAdded: handoffResult.handoffMessages.length,
    });
  } else {
    // Fallback: check legacy cross-agent coordination (Step 21 compat)
    const crossAgent = _checkCrossAgentCoordination(routing.speakerAgent, messageIntent, agentCase);

    if (crossAgent.needed && crossAgent.note) {
      _conversationMsgCounter += 1;
      const systemMsgId = `conv-${Date.now()}-${_conversationMsgCounter}`;

      const systemMsgRecord = {
        messageId: systemMsgId,
        threadId: agentCaseId,
        caseId: agentCaseId,
        messageRole: "system",
        speakerAgent: "system",
        speakerRole: "coordinator",
        messageIntent: "handoff",
        messagePhase: _deriveConversationPhase(thread, agentCase),
        messageType: "cross_agent_note",
        content: crossAgent.note,
        replyToMessageId: agentMsgId,
        quotedMessageId: null,
        followUpOf: agentMsgId,
        relatedCaseId: agentCaseId,
        relatedDraftId: null,
        createdAt: new Date().toISOString(),
      };

      thread.conversationMessages.push(systemMsgRecord);
      thread.systemMessageCount += 1;
      thread.messageCount += 1;
      crossAgentNote = crossAgent.note;

      // Update handoff state to suggested
      thread.handoffStatus = "handoff_suggested";
      thread.crossAgentState = "cross_agent_review_needed";

      logger.info("[agentBridge] Step 21/22 – Cross-Agent-Koordination vorgeschlagen", {
        threadId: agentCaseId,
        primaryAgent: routing.speakerAgent,
        messageIntent,
      });
    }
  }

  // --- 5. Update thread status and summary ---
  thread.threadStatus = _deriveThreadStatus(thread, agentCase);
  thread.conversationState = _deriveConversationPhase(thread, agentCase);

  // --- Step 23: Update case memory after interaction ---
  const memoryTrigger = handoffAssessment.needed ? "handoff" : "user_message";
  _updateCaseMemory(thread, agentCase, memoryTrigger);

  // --- Step 24: Update decision frame after interaction ---
  _updateDecisionFrame(thread, agentCase, memoryTrigger);

  thread.conversationSummary = _buildConversationSummaryLine(thread);
  thread.updatedAt = new Date().toISOString();

  // Evict oldest messages if thread exceeds limit
  while (thread.conversationMessages.length > CONVERSATION_MESSAGE_MAX_PER_THREAD) {
    thread.conversationMessages.shift();
  }

  logger.info("[agentBridge] Step 21/22/23/24 – Agent-Antwort erzeugt", {
    threadId: agentCaseId,
    speakerAgent: routing.speakerAgent,
    messageIntent,
    threadStatus: thread.threadStatus,
    messageCount: thread.messageCount,
    handoffTriggered: handoffAssessment.needed,
    handoffReason: handoffAssessment.reason,
    caseContinuityStatus: thread.caseMemory.caseContinuityStatus,
    memoryFreshness: thread.caseMemory.memoryFreshness,
    decisionFrameStatus: thread.decisionFrame.decisionFrameStatus,
    optionCount: thread.decisionFrame.optionCount,
    recommendedOptionId: thread.decisionFrame.recommendedOptionId,
  });

  return {
    success: true,
    threadId: agentCaseId,
    threadStatus: thread.threadStatus,
    conversationState: thread.conversationState,
    userMessage: userMsgRecord,
    agentReply: agentMsgRecord,
    crossAgentNote,
    routing: {
      speakerAgent: routing.speakerAgent,
      speakerRole: routing.speakerRole,
      routingReason: routing.routingReason,
    },
    // Step 22: Handoff / Cross-Agent state
    handoffTriggered: handoffAssessment.needed,
    handoffStatus: thread.handoffStatus,
    crossAgentState: thread.crossAgentState,
    handoffReason: handoffAssessment.reason,
    handoffConfidence: handoffAssessment.confidence,
    supportingAgent: thread.supportingAgent,
    handoffCount: thread.handoffCount,
    supportingAgentReply: handoffResult ? handoffResult.supportingAgentReply : null,
    awaitingUserReply: thread.awaitingUserReply,
    awaitingAgentReply: thread.awaitingAgentReply,
    lastSpeaker: thread.lastSpeaker,
    nextSuggestedSpeaker: thread.nextSuggestedSpeaker,
    messageCount: thread.messageCount,
    // Step 23: Case Memory / Continuity state
    caseContinuityStatus: thread.caseMemory.caseContinuityStatus,
    memoryFreshness: thread.caseMemory.memoryFreshness,
    workingSummary: thread.caseMemory.workingSummary,
    nextOpenStep: thread.caseMemory.nextOpenStep,
    dominantMemoryOwner: thread.caseMemory.dominantMemoryOwner,
    memoryFocus: thread.caseMemory.memoryFocus,
    // Step 24: Decision Frame / Option Comparison
    decisionFrameStatus: thread.decisionFrame.decisionFrameStatus,
    optionCount: thread.decisionFrame.optionCount,
    recommendedOptionId: thread.decisionFrame.recommendedOptionId,
    preferredStrategy: thread.decisionFrame.preferredStrategy,
    decisionMode: thread.decisionFrame.decisionMode,
    userDecisionNeeded: thread.decisionFrame.userDecisionNeeded,
    optionSummary: thread.decisionFrame.optionSummary,
    decisionTradeoff: thread.decisionFrame.decisionTradeoff,
    nextDecisionQuestion: thread.decisionFrame.nextDecisionQuestion,
  };
}

/**
 * Retrieve a conversation thread with all messages.
 *
 * @param {Object} params
 * @param {string} params.agentCaseId
 * @param {number} [params.limit] - max messages to return (newest first)
 * @returns {Object|null}
 */
function getConversationThread({ agentCaseId, limit = 50 } = {}) {
  if (!agentCaseId) return null;

  const thread = _conversationThreads.get(agentCaseId);
  if (!thread) return null;

  const agentCase = _agentCaseRegistry.get(agentCaseId) || null;

  // Refresh thread status
  thread.threadStatus = _deriveThreadStatus(thread, agentCase);
  thread.conversationState = _deriveConversationPhase(thread, agentCase);
  // Step 23: Refresh case memory
  _updateCaseMemory(thread, agentCase, "thread_read");
  // Step 24: Refresh decision frame
  _updateDecisionFrame(thread, agentCase, "thread_read");
  thread.conversationSummary = _buildConversationSummaryLine(thread);

  const messages = thread.conversationMessages.slice(-limit);

  return {
    threadId: thread.threadId,
    caseId: thread.caseId,
    threadStatus: thread.threadStatus,
    conversationState: thread.conversationState,
    conversationOpen: thread.conversationOpen,
    lastUserMessageAt: thread.lastUserMessageAt,
    lastAgentMessageAt: thread.lastAgentMessageAt,
    awaitingUserReply: thread.awaitingUserReply,
    awaitingAgentReply: thread.awaitingAgentReply,
    lastSpeaker: thread.lastSpeaker,
    nextSuggestedSpeaker: thread.nextSuggestedSpeaker,
    nextSuggestedIntent: thread.nextSuggestedIntent,
    dominantAgent: thread.dominantAgent,
    messageCount: thread.messageCount,
    userMessageCount: thread.userMessageCount,
    agentMessageCount: thread.agentMessageCount,
    deepseekMessageCount: thread.deepseekMessageCount,
    geminiMessageCount: thread.geminiMessageCount,
    systemMessageCount: thread.systemMessageCount,
    conversationSummary: thread.conversationSummary,
    // Step 22: Cross-Agent Handoff fields
    handoffStatus: thread.handoffStatus,
    crossAgentState: thread.crossAgentState,
    handoffFrom: thread.handoffFrom,
    handoffTo: thread.handoffTo,
    handoffReason: thread.handoffReason,
    supportingAgent: thread.supportingAgent,
    handoffCount: thread.handoffCount,
    lastHandoffAt: thread.lastHandoffAt,
    // Step 23: Case Memory / Continuity fields
    caseMemory: {
      caseContinuityStatus: thread.caseMemory.caseContinuityStatus,
      memoryFreshness: thread.caseMemory.memoryFreshness,
      workingSummary: thread.caseMemory.workingSummary,
      workingSummaryReady: thread.caseMemory.workingSummaryReady,
      agreedDirection: thread.caseMemory.agreedDirection,
      discardedDirections: thread.caseMemory.discardedDirections,
      openQuestions: thread.caseMemory.openQuestions,
      resolvedPoints: thread.caseMemory.resolvedPoints,
      caseDecisions: thread.caseMemory.caseDecisions,
      userPreferencesInCase: thread.caseMemory.userPreferencesInCase,
      lastMeaningfulDecision: thread.caseMemory.lastMeaningfulDecision,
      nextOpenStep: thread.caseMemory.nextOpenStep,
      pendingClarifications: thread.caseMemory.pendingClarifications,
      dominantMemoryOwner: thread.caseMemory.dominantMemoryOwner,
      lastContributingAgent: thread.caseMemory.lastContributingAgent,
      memoryContributors: thread.caseMemory.memoryContributors,
      memoryFocus: thread.caseMemory.memoryFocus,
      caseScope: thread.caseMemory.caseScope,
      anchorCount: thread.caseMemory.memoryAnchors.length,
      memoryUpdateCount: thread.caseMemory.memoryUpdateCount,
      memoryUpdatedAt: thread.caseMemory.memoryUpdatedAt,
    },
    // Step 24: Decision Frame / Option Comparison fields
    decisionFrame: {
      decisionFrameStatus: thread.decisionFrame.decisionFrameStatus,
      decisionMode: thread.decisionFrame.decisionMode,
      optionCount: thread.decisionFrame.optionCount,
      actionOptions: thread.decisionFrame.actionOptions,
      recommendedOptionId: thread.decisionFrame.recommendedOptionId,
      recommendedBecause: thread.decisionFrame.recommendedBecause,
      conservativeOptionId: thread.decisionFrame.conservativeOptionId,
      fastestOptionId: thread.decisionFrame.fastestOptionId,
      widestOptionId: thread.decisionFrame.widestOptionId,
      safestOptionId: thread.decisionFrame.safestOptionId,
      primaryDecisionAgent: thread.decisionFrame.primaryDecisionAgent,
      secondaryDecisionAgent: thread.decisionFrame.secondaryDecisionAgent,
      crossAgentDecisionNeeded: thread.decisionFrame.crossAgentDecisionNeeded,
      decisionTradeoff: thread.decisionFrame.decisionTradeoff,
      nextDecisionQuestion: thread.decisionFrame.nextDecisionQuestion,
      narrowingHint: thread.decisionFrame.narrowingHint,
      userDecisionNeeded: thread.decisionFrame.userDecisionNeeded,
      optionContrast: thread.decisionFrame.optionContrast,
      pendingDecisionReason: thread.decisionFrame.pendingDecisionReason,
      optionSummary: thread.decisionFrame.optionSummary,
      preferredStrategy: thread.decisionFrame.preferredStrategy,
      decisionContext: thread.decisionFrame.decisionContext,
      decisionFrameUpdateCount: thread.decisionFrame.decisionFrameUpdateCount,
      decisionFrameUpdatedAt: thread.decisionFrame.decisionFrameUpdatedAt,
    },
    messages,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

/**
 * Build a summary across all conversation threads.
 * Shows: open/waiting/active threads, dominant agents, intent distribution.
 *
 * @returns {Object}
 */
function getConversationSummary() {
  const threads = Array.from(_conversationThreads.values());

  const byThreadStatus = {};
  const byDominantAgent = {};
  const byConversationState = {};
  const intentFrequency = {};

  let totalOpen = 0;
  let totalWaitingForUser = 0;
  let totalWaitingForAgent = 0;
  let totalDeepseekDominated = 0;
  let totalGeminiDominated = 0;
  let totalCrossAgent = 0;
  let totalMessages = 0;

  for (const t of threads) {
    // Refresh status
    const agentCase = _agentCaseRegistry.get(t.caseId) || null;
    t.threadStatus = _deriveThreadStatus(t, agentCase);
    t.conversationState = _deriveConversationPhase(t, agentCase);
    t.conversationSummary = _buildConversationSummaryLine(t);

    byThreadStatus[t.threadStatus] = (byThreadStatus[t.threadStatus] || 0) + 1;
    byConversationState[t.conversationState] = (byConversationState[t.conversationState] || 0) + 1;

    const da = t.dominantAgent || "unknown";
    byDominantAgent[da] = (byDominantAgent[da] || 0) + 1;

    if (t.conversationOpen) totalOpen += 1;
    if (t.awaitingUserReply) totalWaitingForUser += 1;
    if (t.awaitingAgentReply) totalWaitingForAgent += 1;

    if (t.deepseekMessageCount > t.geminiMessageCount) totalDeepseekDominated += 1;
    else if (t.geminiMessageCount > t.deepseekMessageCount) totalGeminiDominated += 1;
    else if (t.deepseekMessageCount > 0 && t.geminiMessageCount > 0) totalCrossAgent += 1;

    totalMessages += t.messageCount;

    // Collect intent frequencies from messages
    for (const msg of t.conversationMessages) {
      if (msg.messageIntent) {
        intentFrequency[msg.messageIntent] = (intentFrequency[msg.messageIntent] || 0) + 1;
      }
    }
  }

  // Step 22: Collect handoff analytics
  let totalWithHandoffs = 0;
  let totalHandoffsAll = 0;

  for (const t of threads) {
    if (t.handoffCount > 0) {
      totalWithHandoffs += 1;
      totalHandoffsAll += t.handoffCount;
    }
  }

  // Build thread summaries (most recent first)
  const threadSummaries = threads
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
    .slice(0, CONVERSATION_SUMMARY_MAX_THREADS)
    .map((t) => ({
      threadId: t.threadId,
      threadStatus: t.threadStatus,
      conversationState: t.conversationState,
      dominantAgent: t.dominantAgent,
      supportingAgent: t.supportingAgent,
      messageCount: t.messageCount,
      userMessageCount: t.userMessageCount,
      deepseekMessageCount: t.deepseekMessageCount,
      geminiMessageCount: t.geminiMessageCount,
      awaitingUserReply: t.awaitingUserReply,
      awaitingAgentReply: t.awaitingAgentReply,
      lastSpeaker: t.lastSpeaker,
      conversationSummary: t.conversationSummary,
      // Step 22 handoff fields
      handoffStatus: t.handoffStatus,
      crossAgentState: t.crossAgentState,
      handoffCount: t.handoffCount,
      // Step 23: Memory fields
      caseContinuityStatus: t.caseMemory ? t.caseMemory.caseContinuityStatus : "continuity_not_started",
      memoryFreshness: t.caseMemory ? t.caseMemory.memoryFreshness : "memory_empty",
      dominantMemoryOwner: t.caseMemory ? t.caseMemory.dominantMemoryOwner : null,
      workingSummaryReady: t.caseMemory ? t.caseMemory.workingSummaryReady : false,
      openQuestionCount: t.caseMemory ? (t.caseMemory.openQuestions || []).length : 0,
      anchorCount: t.caseMemory ? (t.caseMemory.memoryAnchors || []).length : 0,
      // Step 24: Decision Frame fields
      decisionFrameStatus: t.decisionFrame ? t.decisionFrame.decisionFrameStatus : "options_not_ready",
      optionCount: t.decisionFrame ? t.decisionFrame.optionCount : 0,
      recommendedOptionId: t.decisionFrame ? t.decisionFrame.recommendedOptionId : null,
      preferredStrategy: t.decisionFrame ? t.decisionFrame.preferredStrategy : null,
      userDecisionNeeded: t.decisionFrame ? t.decisionFrame.userDecisionNeeded : false,
      crossAgentDecisionNeeded: t.decisionFrame ? t.decisionFrame.crossAgentDecisionNeeded : false,
      updatedAt: t.updatedAt,
    }));

  // Step 23: Collect memory analytics
  let totalWithMemory = 0;
  let totalWithWorkingSummary = 0;
  let totalWithOpenQuestions = 0;
  let totalWithAgreedDirection = 0;

  for (const t of threads) {
    if (t.caseMemory) {
      if ((t.caseMemory.memoryAnchors || []).length > 0) totalWithMemory += 1;
      if (t.caseMemory.workingSummaryReady) totalWithWorkingSummary += 1;
      if ((t.caseMemory.openQuestions || []).length > 0) totalWithOpenQuestions += 1;
      if (t.caseMemory.agreedDirection) totalWithAgreedDirection += 1;
    }
  }

  // Step 24: Collect decision frame analytics
  let totalWithOptions = 0;
  let totalWithRecommendation = 0;
  let totalDecisionNarrowed = 0;
  let totalDecisionUserNeeded = 0;
  let totalDecisionCrossAgent = 0;

  for (const t of threads) {
    if (t.decisionFrame && t.decisionFrame.decisionFrameStatus !== "options_not_ready") {
      totalWithOptions += 1;
      if (t.decisionFrame.recommendedOptionId) totalWithRecommendation += 1;
      if (t.decisionFrame.decisionFrameStatus === "decision_narrowed" || t.decisionFrame.decisionFrameStatus === "decision_ready_for_user") totalDecisionNarrowed += 1;
      if (t.decisionFrame.userDecisionNeeded) totalDecisionUserNeeded += 1;
      if (t.decisionFrame.crossAgentDecisionNeeded) totalDecisionCrossAgent += 1;
    }
  }

  logger.info("[agentBridge] Step 21/22/23/24 – Conversation-Zusammenfassung erzeugt", {
    totalThreads: threads.length,
    totalOpen,
    totalMessages,
    totalWaitingForUser,
    totalWaitingForAgent,
    totalWithHandoffs,
    totalWithMemory,
    totalWithWorkingSummary,
    totalWithOpenQuestions,
    totalWithOptions,
    totalWithRecommendation,
  });

  return {
    totalThreads: threads.length,
    totalOpen,
    totalWaitingForUser,
    totalWaitingForAgent,
    totalDeepseekDominated,
    totalGeminiDominated,
    totalCrossAgent,
    totalMessages,
    // Step 22: Handoff analytics
    totalWithHandoffs,
    totalHandoffs: totalHandoffsAll,
    // Step 23: Memory analytics
    totalWithMemory,
    totalWithWorkingSummary,
    totalWithOpenQuestions,
    totalWithAgreedDirection,
    // Step 24: Decision Frame analytics
    totalWithOptions,
    totalWithRecommendation,
    totalDecisionNarrowed,
    totalDecisionUserNeeded,
    totalDecisionCrossAgent,
    byThreadStatus,
    byDominantAgent,
    byConversationState,
    intentFrequency,
    threadSummaries,
    generatedAt: new Date().toISOString(),
  };
}

/* ─────────────────────────────────────────────────────────────────────
   Konferenz Step A: DeepSeek ↔ Gemini – Conference Session /
   Targeting / Mode / Summary

   Functions:
   - openConferenceSession()          – create or resume a conference session
   - sendConferenceMessage()          – send a message with clean agent targeting
   - updateConferenceSession()        – change session status / mode
   - closeConferenceSession()         – close or archive a session
   - getConferenceSession()           – retrieve session with messages
   - getConferenceSummary()           – generate a human-readable conference summary
   - getConferenceWorkspace()         – load full workspace data for frontend
   - getConferenceAdminSummary()      – analytics across all conference sessions
   ───────────────────────────────────────────────────────────────────── */

/**
 * Open (or resume) a conference session.
 *
 * @param {Object} params
 * @param {string} [params.conferenceId] – existing session to resume, or null for new
 * @param {string} [params.conferenceMode] – "work_chat" | "problem_solving" | "decision_mode"
 * @param {string} [params.relatedCaseId] – optional link to an agent case
 * @param {string} [params.conferenceFocus] – human-readable focus description
 * @param {string} [params.conferenceOwner] – who opened the session
 * @returns {Object} session data
 */
function openConferenceSession({
  conferenceId = null,
  conferenceMode = "work_chat",
  relatedCaseId = null,
  conferenceFocus = null,
  conferenceOwner = "admin",
} = {}) {
  // Resume existing session
  if (conferenceId && _conferenceSessions.has(conferenceId)) {
    const existing = _conferenceSessions.get(conferenceId);
    if (existing.conferenceStatus === "session_paused" || existing.conferenceStatus === "session_closed") {
      const previousStatus = existing.conferenceStatus;
      existing.conferenceStatus = "session_active";
      existing.updatedAt = new Date().toISOString();
      existing.statusHistory.push({ status: "session_active", changedAt: existing.updatedAt });
      logger.info("[agentBridge] Konferenz Step A – Session wiederaufgenommen", {
        conferenceId,
        previousStatus,
      });
    }
    return { success: true, conferenceId, session: _formatConferenceSession(existing), resumed: true };
  }

  // Validate and truncate inputs
  const mode = VALID_CONFERENCE_MODES.includes(conferenceMode) ? conferenceMode : "work_chat";
  const safeFocus = typeof conferenceFocus === "string"
    ? conferenceFocus.slice(0, CONFERENCE_FOCUS_MAX_LENGTH)
    : null;

  // Create new session
  _conferenceIdCounter += 1;
  const newId = conferenceId || `conf-${Date.now()}-${_conferenceIdCounter}`;
  const now = new Date().toISOString();

  const session = {
    conferenceId: newId,
    conferenceStatus: "session_active",
    conferenceMode: mode,
    conferenceFocus: safeFocus,
    conferenceOwner: conferenceOwner || "admin",
    relatedCaseId: relatedCaseId || null,
    activeAgents: ["deepseek", "gemini"],
    messages: [],
    messageCount: 0,
    userMessageCount: 0,
    deepseekMessageCount: 0,
    geminiMessageCount: 0,
    systemMessageCount: 0,
    lastTargetAgent: null,
    lastSpeaker: null,
    lastActivity: now,
    sessionOpenedAt: now,
    sessionClosedAt: null,
    conferenceSummary: null,
    // Konferenz Step B: Coordination fields
    coordinationState: "uncoordinated",
    currentReplyPattern: "solo_reply",
    leadAgent: null,
    supportAgent: null,
    currentPhaseStatus: "phase_open",
    phaseCount: 0,
    phases: [],
    coordinatedReplyCount: 0,
    soloReplyCount: 0,
    supportingReplyCount: 0,
    bundledReplyCount: 0,
    clarificationRequestCount: 0,
    leadershipChangeCount: 0,
    phasesClosedCount: 0,
    lastCoordinatorMessage: null,
    openPoints: [],
    phaseDigest: null,
    modeHistory: [{ mode, changedAt: now }],
    statusHistory: [{ status: "session_active", changedAt: now }],
    // Konferenz Step C: Work phases, decision room, result cards, history
    workPhase: "intake",
    workPhaseHistory: [{ phase: "intake", enteredAt: now }],
    decisionRoomActive: false,
    decisionRoomState: "not_active",
    optionRoomOptions: [],
    recommendedDirection: null,
    conservativeAlternative: null,
    broadAlternative: null,
    openTradeoff: null,
    nextDecisionNeed: null,
    consensusState: "neutral",
    resultCards: [],
    currentResultCard: null,
    handoffDirection: "continue_session",
    handoffDirectionReason: null,
    moderationSignal: "phase_stable",
    discardedDirections: [],
    lastKnownDecision: null,
    previousPhaseResult: null,
    perspectiveComparison: null,
    phaseTransitionCount: 0,
    resultCardCount: 0,
    decisionRoomActivationCount: 0,
    // Konferenz Step D: Live dialog / reply lifecycle tracking
    dialogState: "dialog_idle",
    followUpCount: 0,
    replyCycleCount: 0,
    openClarification: false,
    lastUserMessageId: null,
    lastUserMessage: null,
    lastReplyAgents: [],
    // Konferenz Step E: Both-Mode tracking
    bothModeMessageCount: 0,
    completedBothReplyCycles: 0,
    partialBothReplyCycles: 0,
    deepseekOnlyCount: 0,
    geminiOnlyCount: 0,
    bothModeCooperationTypes: {},
    createdAt: now,
    updatedAt: now,
  };

  _conferenceSessions.set(newId, session);

  // Evict oldest sessions if over limit
  if (_conferenceSessions.size > CONFERENCE_SESSION_MAX_ENTRIES) {
    const oldestKey = _conferenceSessions.keys().next().value;
    _conferenceSessions.delete(oldestKey);
  }

  logger.info("[agentBridge] Konferenz Step A – Neue Konferenz-Session eröffnet", {
    conferenceId: newId,
    conferenceMode: mode,
    conferenceFocus,
    relatedCaseId,
  });

  return { success: true, conferenceId: newId, session: _formatConferenceSession(session), resumed: false };
}

/**
 * Send a message to a conference session with clean agent targeting.
 *
 * @param {Object} params
 * @param {string} params.conferenceId – required
 * @param {string} params.userMessage – required, free-form text
 * @param {string} [params.targetAgent] – "deepseek" | "gemini" | "both" | "system"
 * @param {string} [params.replyToMessageId] – optional reply reference
 * @returns {Object} message result with agent reply/replies
 */
async function sendConferenceMessage({
  conferenceId,
  userMessage,
  targetAgent = null,
  replyToMessageId = null,
} = {}) {
  if (!conferenceId) {
    logger.warn("[agentBridge] Konferenz Step A – sendConferenceMessage ohne conferenceId");
    return { success: false, error: "conferenceId is required" };
  }
  if (!userMessage || typeof userMessage !== "string" || userMessage.trim().length === 0) {
    logger.warn("[agentBridge] Konferenz Step A – sendConferenceMessage ohne userMessage");
    return { success: false, error: "userMessage is required and must be a non-empty string" };
  }

  const session = _conferenceSessions.get(conferenceId);
  if (!session) {
    return { success: false, error: "Conference session not found" };
  }

  if (session.conferenceStatus === "session_closed" || session.conferenceStatus === "session_archived") {
    return { success: false, error: "Conference session is closed or archived" };
  }

  // Ensure session is active
  if (session.conferenceStatus === "session_paused") {
    session.conferenceStatus = "session_active";
    session.statusHistory.push({ status: "session_active", changedAt: new Date().toISOString() });
  }

  // Resolve target agent
  const resolvedTarget = _resolveConferenceTarget(targetAgent, userMessage, session);
  const messageIntent = _deriveMessageIntent(userMessage);
  const now = new Date().toISOString();

  // Konferenz Step D: Detect follow-up and update dialog state
  const isFollowUp = _isFollowUpMessage(userMessage, session);
  const followUpOf = isFollowUp ? (session.lastUserMessageId || null) : null;
  if (isFollowUp) {
    session.followUpCount += 1;
  }
  session.dialogState = "message_received";

  // Record user message
  _conferenceMsgCounter += 1;
  const userMsgId = `cfm-${Date.now()}-${_conferenceMsgCounter}`;

  const userMsgRecord = {
    messageId: userMsgId,
    conferenceId,
    messageRole: "user",
    speakerAgent: "user",
    messageIntent,
    targetAgent: resolvedTarget.target,
    content: userMessage.trim(),
    replyToMessageId: replyToMessageId || null,
    conferenceMode: session.conferenceMode,
    // Konferenz Step D: follow-up tracking
    isFollowUp,
    followUpOf,
    // Konferenz Step E: both-mode flag on user message
    bothMode: resolvedTarget.target === "both",
    createdAt: now,
  };

  session.messages.push(userMsgRecord);
  session.messageCount += 1;
  session.userMessageCount += 1;
  session.lastSpeaker = "user";
  session.lastActivity = now;

  // Konferenz Step D: track last user message for reply context
  session.lastUserMessageId = userMsgId;
  session.lastUserMessage = userMessage.trim().slice(0, CONFERENCE_LAST_USER_MSG_MAX_LENGTH);
  session.openClarification = false; // reset on new user message

  // Trim messages if over limit
  if (session.messages.length > CONFERENCE_SESSION_MAX_MESSAGES) {
    session.messages = session.messages.slice(-CONFERENCE_SESSION_MAX_MESSAGES);
  }

  // Konferenz Step D: update dialog state to routing
  session.dialogState = "agent_reply_pending";

  logger.info("[agentBridge] Konferenz Step D – User-Nachricht empfangen und geroutet", {
    conferenceId,
    targetAgent: resolvedTarget.target,
    routingReason: resolvedTarget.routingReason,
    messageIntent,
    isFollowUp,
    userMsgId,
  });

  // Konferenz Step E: log both-mode detection
  if (resolvedTarget.target === "both") {
    logger.info("[agentBridge] Konferenz Step E – Both-Mode erkannt, Zielagenten bestimmt", {
      conferenceId,
      routingReason: resolvedTarget.routingReason,
      primaryAgent: "deepseek",
      secondaryAgent: "gemini",
    });
  }

  // Generate agent replies based on target
  const agentReplies = [];

  if (resolvedTarget.target === "both") {
    // Konferenz Step E: Both-Mode – DeepSeek leads (primary), Gemini supplements (secondary)
    // Track both-mode message count
    session.bothModeMessageCount = (session.bothModeMessageCount || 0) + 1;

    // Generate DeepSeek reply (primary) – real API call
    const dsReply = await _generateConferenceReply("deepseek", messageIntent, userMessage, session);

    // Set intermediate dialog state: first agent replied, second still pending
    session.dialogState = "additional_agent_pending";

    const dsRecord = _recordConferenceAgentReply(session, "deepseek", dsReply.text, userMsgId, null, {
      bothMode: true,
      cooperationType: null,
      followsAgent: null,
      bothModeSequence: "primary",
      openSecondReply: true,
      usedFallback: dsReply.usedFallback,
      apiError: dsReply.apiError,
    });

    logger.info("[agentBridge] Konferenz Step E – DeepSeek-Antwort erzeugt (primär)", {
      conferenceId,
      messageId: dsRecord.messageId,
      responseType: dsRecord.responseType,
      usedFallback: dsReply.usedFallback,
    });

    // Generate Gemini reply (secondary) – knows about DeepSeek's reply via context
    const gmReply = await _generateConferenceReply("gemini", messageIntent, userMessage, session, { deepseekReply: dsReply.text });
    const cooperationType = _deriveCooperationType(gmReply.text, dsReply.text);

    const gmRecord = _recordConferenceAgentReply(session, "gemini", gmReply.text, userMsgId, dsRecord.messageId, {
      bothMode: true,
      cooperationType,
      followsAgent: "deepseek",
      bothModeSequence: "secondary",
      openSecondReply: false,
      usedFallback: gmReply.usedFallback,
      apiError: gmReply.apiError,
    });

    logger.info("[agentBridge] Konferenz Step E – Gemini-Antwort erzeugt (sekundär)", {
      conferenceId,
      messageId: gmRecord.messageId,
      responseType: gmRecord.responseType,
      cooperationType,
      usedFallback: gmReply.usedFallback,
    });

    agentReplies.push(dsRecord);
    agentReplies.push(gmRecord);
    session.lastReplyAgents = ["deepseek", "gemini"];

    // Track cooperation type
    if (cooperationType) {
      session.bothModeCooperationTypes = session.bothModeCooperationTypes || {};
      session.bothModeCooperationTypes[cooperationType] = (session.bothModeCooperationTypes[cooperationType] || 0) + 1;
    }

    logger.info("[agentBridge] Konferenz Step E – Doppelantwort-Zyklus abgeschlossen", {
      conferenceId,
      cooperationType,
      bothModeMessageCount: session.bothModeMessageCount,
    });
  } else if (resolvedTarget.target === "system") {
    const sysReply = _generateConferenceSystemReply(messageIntent, session);
    const sysRecord = _recordConferenceAgentReply(session, "system", sysReply, userMsgId, null);
    agentReplies.push(sysRecord);
    session.lastReplyAgents = ["system"];
  } else {
    // Single agent reply – real API call
    const reply = await _generateConferenceReply(resolvedTarget.target, messageIntent, userMessage, session);
    const record = _recordConferenceAgentReply(session, resolvedTarget.target, reply.text, userMsgId, null, {
      usedFallback: reply.usedFallback,
      apiError: reply.apiError,
    });
    agentReplies.push(record);
    session.lastReplyAgents = [resolvedTarget.target];
    // Konferenz Step E: track single-agent counts
    if (resolvedTarget.target === "deepseek") {
      session.deepseekOnlyCount = (session.deepseekOnlyCount || 0) + 1;
    } else if (resolvedTarget.target === "gemini") {
      session.geminiOnlyCount = (session.geminiOnlyCount || 0) + 1;
    }
  }

  // Konferenz Step D: derive dialog state after replies
  const hasRückfrage = agentReplies.some((r) => r.responseType === "rückfrage");
  if (hasRückfrage) {
    session.openClarification = true;
    session.dialogState = "clarification_open";
    logger.info("[agentBridge] Konferenz Step D – Rückfrage offen", { conferenceId });
  } else {
    session.openClarification = false;
    session.dialogState = "reply_cycle_complete";
    session.replyCycleCount += 1;
    // Konferenz Step E: track completed both-mode cycles
    if (resolvedTarget.target === "both") {
      const bothComplete = agentReplies.filter((r) => r.bothMode).length === 2;
      if (bothComplete) {
        session.completedBothReplyCycles = (session.completedBothReplyCycles || 0) + 1;
      } else {
        session.partialBothReplyCycles = (session.partialBothReplyCycles || 0) + 1;
      }
    }
    logger.info("[agentBridge] Konferenz Step D – Antwortzyklus abgeschlossen", {
      conferenceId,
      replyCycleCount: session.replyCycleCount,
      bothModeComplete: resolvedTarget.target === "both" ? agentReplies.filter((r) => r.bothMode).length === 2 : undefined,
    });
  }

  session.lastTargetAgent = resolvedTarget.target;
  session.updatedAt = now;

  // Konferenz Step C: update phases, decision room, result cards
  _updateConferenceStepC(session);

  return {
    success: true,
    conferenceId,
    conferenceStatus: session.conferenceStatus,
    conferenceMode: session.conferenceMode,
    userMessage: userMsgRecord,
    agentReplies,
    routing: {
      targetAgent: resolvedTarget.target,
      routingReason: resolvedTarget.routingReason,
    },
    messageCount: session.messageCount,
    // Konferenz Step C: expose current phase and moderation signal
    workPhase: session.workPhase,
    moderationSignal: session.moderationSignal,
    handoffDirection: session.handoffDirection,
    // Konferenz Step D: dialog state
    dialogState: session.dialogState,
    openClarification: session.openClarification,
    replyCycleCount: session.replyCycleCount,
    followUpCount: session.followUpCount,
    // Konferenz Step E: both-mode summary
    bothMode: resolvedTarget.target === "both",
    bothModeMessageCount: session.bothModeMessageCount || 0,
    completedBothReplyCycles: session.completedBothReplyCycles || 0,
    partialBothReplyCycles: session.partialBothReplyCycles || 0,
    // API status: whether the agent APIs are configured (helps frontend show live vs fallback state)
    agentApiConfigured: {
      deepseek: isDeepSeekConfigured(),
      gemini: isGeminiConfigured(),
    },
  };
}

/**
 * Record an agent reply within a conference session.
 * @param {Object} session
 * @param {string} agent
 * @param {string} content
 * @param {string} replyToMessageId – ID of the user message being replied to
 * @param {string|null} [followUpOf] – ID of a previous agent message this supplements (null for first reply)
 * @param {Object} [bothModeOptions] – Konferenz Step E both-mode metadata
 * @param {boolean} [bothModeOptions.bothMode] – true when this reply is part of a both-mode cycle
 * @param {string|null} [bothModeOptions.cooperationType] – cooperation classification
 * @param {string|null} [bothModeOptions.followsAgent] – agent whose reply came before this one
 * @param {string|null} [bothModeOptions.bothModeSequence] – "primary" or "secondary"
 * @param {boolean} [bothModeOptions.openSecondReply] – true if second reply not yet recorded
 * @private
 */
function _recordConferenceAgentReply(session, agent, content, replyToMessageId, followUpOf = null, bothModeOptions = {}) {
  _conferenceMsgCounter += 1;
  const msgId = `cfm-${Date.now()}-${_conferenceMsgCounter}`;
  const now = new Date().toISOString();

  // Konferenz Step D: derive response type
  const responseType = _deriveResponseType(agent, content, session, followUpOf);

  // Konferenz Step E: both-mode fields
  const {
    bothMode = false,
    cooperationType = null,
    followsAgent = null,
    bothModeSequence = null,
    openSecondReply = false,
    usedFallback = false,
    apiError = null,
  } = bothModeOptions;

  const record = {
    messageId: msgId,
    conferenceId: session.conferenceId,
    messageRole: "agent",
    speakerAgent: agent,
    speakerRole: agent === "deepseek" ? "backend_agent" : agent === "gemini" ? "frontend_agent" : "coordinator",
    content,
    replyToMessageId,
    // Konferenz Step E: explicit semantic alias so the frontend can identify which user
    // message this reply responds to without relying on the internal replyToMessageId name.
    responseToMessageId: replyToMessageId,
    responseType,
    responseToRole: "user",
    followUpOf: followUpOf || null,
    conferenceMode: session.conferenceMode,
    // Konferenz Step E: both-mode reply metadata
    bothMode,
    cooperationType: bothMode ? (cooperationType || null) : null,
    followsAgent: bothMode ? (followsAgent || null) : null,
    bothModeSequence: bothMode ? (bothModeSequence || null) : null,
    openSecondReply: bothMode ? openSecondReply : false,
    // API status: whether the reply came from real AI or a static fallback template
    usedFallback,
    apiError: usedFallback ? (apiError || null) : null,
    createdAt: now,
  };

  session.messages.push(record);
  session.messageCount += 1;
  session.lastSpeaker = agent;
  session.lastActivity = now;

  if (agent === "deepseek") session.deepseekMessageCount += 1;
  else if (agent === "gemini") session.geminiMessageCount += 1;
  else session.systemMessageCount += 1;

  logger.info("[agentBridge] Konferenz Step D – Agent-Antwort erzeugt", {
    conferenceId: session.conferenceId,
    agent,
    responseType,
    replyToMessageId,
    followUpOf,
    bothMode,
    cooperationType: bothMode ? cooperationType : undefined,
    bothModeSequence: bothMode ? bothModeSequence : undefined,
    usedFallback,
  });

  return record;
}

/**
 * Resolve the target agent for a conference message.
 * Uses explicit targetAgent parameter, falls back to keyword-based routing.
 * @private
 */
function _resolveConferenceTarget(targetAgent, userMessage, session) {
  // Explicit targeting – clean, no text prefix hacks
  if (targetAgent && VALID_CONFERENCE_TARGET_AGENTS.includes(targetAgent)) {
    const reasonMap = {
      deepseek: "Explizites Targeting: nur DeepSeek (Backend-Agent)",
      gemini: "Explizites Targeting: nur Gemini (Frontend-Agent)",
      both: "Explizites Targeting: beide Agenten",
      system: "Explizites Targeting: System-Antwort",
    };
    return { target: targetAgent, routingReason: reasonMap[targetAgent] || "Explizites Targeting" };
  }

  // Konferenz Step E: Conservative text-based both-mode detection (before keyword scoring)
  if (_detectBothModeFromText(userMessage)) {
    return { target: "both", routingReason: "Textuelle Erkennung: User möchte beide Meinungen" };
  }

  // Keyword-based routing as fallback
  const lowerMsg = (userMessage || "").toLowerCase();
  let dsScore = 0;
  let gmScore = 0;

  for (const kw of DEEPSEEK_ROUTING_KEYWORDS) {
    if (lowerMsg.includes(kw)) dsScore += 1;
  }
  for (const kw of GEMINI_ROUTING_KEYWORDS) {
    if (lowerMsg.includes(kw)) gmScore += 1;
  }

  // In decision mode, default to both agents
  if (session.conferenceMode === "decision_mode" && dsScore === 0 && gmScore === 0) {
    return { target: "both", routingReason: "Entscheidungsmodus – beide Agenten einbezogen" };
  }

  if (dsScore > 0 && gmScore > 0) {
    return { target: "both", routingReason: "Nachricht berührt beide Agenten-Domänen" };
  }
  if (gmScore > dsScore) {
    return { target: "gemini", routingReason: "Nachricht bezieht sich auf Frontend / UX / Design" };
  }
  if (dsScore > gmScore) {
    return { target: "deepseek", routingReason: "Nachricht bezieht sich auf Backend / API / Logik" };
  }

  // Default routing based on last speaker or deepseek
  return { target: "deepseek", routingReason: "Standard-Routing zum Backend-Agenten" };
}

/**
 * Konferenz Step E: Conservative detection of "both agents" intent from user message text.
 * Only triggers for clearly recognisable German phrases. Explicit targetAgent always takes priority.
 * @param {string} userMessage
 * @returns {boolean}
 * @private
 */
function _detectBothModeFromText(userMessage) {
  if (!userMessage || typeof userMessage !== "string") return false;
  const lower = userMessage.toLowerCase();
  return BOTH_MODE_DETECTION_PHRASES.some((phrase) => lower.includes(phrase));
}

/**
 * Konferenz Step E: Derive the cooperation type for the second agent's reply in both-mode.
 * Analyses the content of the second reply relative to the first to classify how they relate.
 * @param {string} secondContent - content of the second agent's reply
 * @param {string} firstContent  - content of the first agent's reply
 * @returns {string} one of VALID_BOTH_MODE_COOPERATION_TYPES
 * @private
 */
function _deriveCooperationType(secondContent, firstContent) {
  const lower = (secondContent || "").toLowerCase();
  const firstLower = (firstContent || "").toLowerCase();

  // Signals of disagreement / different angle
  const dissentSignals = [
    "jedoch", "allerdings", "aus meiner sicht anders", "ich sehe das etwas anders",
    "abweichend", "im gegensatz", "nicht ganz", "anders als",
  ];
  if (dissentSignals.some((s) => lower.includes(s))) return "dissent_light";

  // Signals of contrast / different priority
  const contrastSignals = [
    "dagegen", "im unterschied", "im vergleich dazu", "während deepseek", "andere perspektive",
    "andere priorität", "ich würde eher", "mein schwerpunkt liegt",
  ];
  if (contrastSignals.some((s) => lower.includes(s))) return "contrasts";

  // Signals of agreement / convergence
  const alignSignals = [
    "ich stimme zu", "ich bestätige", "wie bereits erwähnt", "ähnlich sehe ich",
    "das sehe ich genauso", "gemeinsame linie", "einig",
  ];
  if (alignSignals.some((s) => lower.includes(s))) return "aligns";

  // Signals of extending / deepening
  const extendSignals = [
    "zusätzlich", "darüber hinaus", "ich ergänze", "und auch", "noch wichtig",
    "erweitert", "es kommt hinzu", "außerdem",
  ];
  if (extendSignals.some((s) => lower.includes(s))) return "extends";

  // Default: supplements (adds complementary info)
  // If both content snippets share similar root words, classify as common_line
  const firstWords = new Set(firstLower.split(/\s+/).filter((w) => w.length > BOTH_MODE_MIN_WORD_LENGTH_FOR_OVERLAP));
  const secondWords = secondContent.toLowerCase().split(/\s+/).filter((w) => w.length > BOTH_MODE_MIN_WORD_LENGTH_FOR_OVERLAP);
  const overlap = secondWords.filter((w) => firstWords.has(w)).length;
  if (overlap >= BOTH_MODE_MIN_OVERLAP_FOR_COMMON_LINE) return "common_line";

  return "supplements";
}

/**
 * Generate a cooperative conference reply for an agent.
 * Falls back to static templates if the AI API is not configured or the call fails.
 * @private
 */
async function _generateConferenceReply(agent, messageIntent, userMessage, session, context = {}) {
  // ── Resolve agent from registry ──
  const agentDef = _conferenceAgentRegistry.get(agent);
  if (!agentDef) {
    logger.warn("[agentBridge] Konferenz – Unbekannter Agent angefordert", { agent });
    return _generateConferenceReplyFallback(agent, messageIntent, session);
  }

  if (!agentDef.isConfigured()) {
    return _generateConferenceReplyFallback(agent, messageIntent, session);
  }

  // ── Truncate user message to stay within API limits ──
  const safeUserMessage = (userMessage || "").slice(0, CONFERENCE_USER_MSG_MAX_INPUT);

  // ── Build conversation history for context ──
  const recentMessages = (session.messages || [])
    .slice(-10)
    .filter((m) => m.messageRole === "user" || (m.messageRole === "agent" && m.speakerAgent !== "system"))
    .map((m) => {
      const isOwnReply = m.messageRole === "agent" && m.speakerAgent === agent;
      const label = m.messageRole === "user"
        ? "Nutzer"
        : isOwnReply ? agentDef.label : "Anderer Agent";
      // Truncate each history excerpt to prevent prompt bloat
      const excerpt = (m.content || "").slice(0, CONFERENCE_HISTORY_MSG_MAX_LENGTH);
      return `${label}: ${excerpt}`;
    })
    .join("\n");

  const focus = session.conferenceFocus ? `Aktueller Fokus: ${session.conferenceFocus}\n` : "";
  const modeLabel = {
    work_chat: "Arbeitschat",
    problem_solving: "Problemlösung",
    decision_mode: "Entscheidungsmodus",
  }[session.conferenceMode] || "Arbeitschat";

  // ── Optional note when this agent replies after another agent in both-mode ──
  // context.deepseekReply and context.primaryAgentReply are plain strings from call sites
  const primaryReply = context.deepseekReply || context.primaryAgentReply || null;
  const prevNote = primaryReply
    ? `\nEin anderer Agent hat bereits geantwortet: "${primaryReply.slice(0, 300)}"\nDeine Antwort soll ergänzen, nicht wiederholen.`
    : "";

  const systemPrompt = [
    `Du bist ${agentDef.label}, ein spezialisierter KI-Assistent für ${agentDef.domain}.`,
    `Du nimmst an einer technischen Konferenz teil (Modus: ${modeLabel}).`,
    focus,
    `Antworte immer auf Deutsch. Sei klar, präzise und hilfreich. Beantworte die Frage direkt.`,
    `Halte deine Antwort fokussiert (2-5 Sätze).`,
    prevNote,
  ].filter(Boolean).join("\n").trim();

  const historyContext = recentMessages ? `Bisheriger Verlauf:\n${recentMessages}\n\nNutzer: ` : "";
  const fullMessage = `${historyContext}${safeUserMessage}`;

  try {
    const text = await agentDef.callApi(systemPrompt, fullMessage, {
      timeoutMs: agent === "deepseek" ? 20000 : 22000,
      maxTokens: 512,
      temperature: 0.5,
    });
    if (text.trim()) return { text: text.trim(), usedFallback: false, apiError: null };
  } catch (err) {
    logger.warn("[agentBridge] Konferenz API Fehler – Fallback aktiviert", {
      agent,
      message: err.message,
    });
    const fallback = _generateConferenceReplyFallback(agent, messageIntent, session);
    return { text: fallback.text, usedFallback: true, apiError: String(err.message || "").slice(0, 120) };
  }
  // API returned an empty response – fall back to static template
  return _generateConferenceReplyFallback(agent, messageIntent, session);
}

/**
 * Static template fallback – used when the AI API is unavailable.
 * @private
 */
function _generateConferenceReplyFallback(agent, messageIntent, session) {
  const isBackend = agent === "deepseek";
  const perspective = isBackend ? "Backend-Sicht" : "Frontend-Sicht";
  const domain = isBackend ? "Backend / API / Logik" : "Frontend / UX / Darstellung";
  const focus = session.conferenceFocus || "das aktuelle Thema";

  const modeLabel = {
    work_chat: "Arbeitschat",
    problem_solving: "Problemlösung",
    decision_mode: "Entscheidungsmodus",
  }[session.conferenceMode] || "Arbeitschat";

  const replies = {
    question: [
      `Aus ${perspective}: Gute Frage. Ich schaue mir ${focus} genauer an und gebe dir eine Einschätzung.`,
      `Zum Thema ${focus} – aus ${perspective} kann ich Folgendes beitragen:`,
    ],
    clarification: [
      `Ich präzisiere gern aus ${perspective}. Der relevante Bereich ist ${domain}.`,
      `Lass mich das aus ${perspective} genauer einordnen.`,
    ],
    scope_change: [
      `Verstanden. Ich passe den Fokus an und konzentriere mich auf ${domain}.`,
    ],
    diagnosis_request: [
      `Ich schaue mir die Ursache aus ${perspective} tiefer an. Fokus: ${focus}.`,
      `Diagnose aus ${perspective}: Ich prüfe jetzt gezielt den Bereich ${domain}.`,
    ],
    recommendation: [
      `Aus ${perspective} würde ich Folgendes empfehlen – bezogen auf ${focus}.`,
      `Mein Vorschlag aus ${perspective}: Zunächst ${domain} gezielt prüfen.`,
    ],
    follow_up: [
      `Ich knüpfe an den letzten Punkt an. Aus ${perspective} gibt es noch Folgendes zu ${focus}.`,
    ],
    freeform: [
      `Ich habe deine Nachricht aufgenommen. Aus ${perspective} ordne ich das ein.`,
      `Danke für den Beitrag. Aus ${perspective} liegt der Schwerpunkt bei ${focus}.`,
      `Diese Konferenz läuft aktuell im ${modeLabel}. Aus ${perspective} ergänze ich Folgendes.`,
    ],
  };

  const candidates = replies[messageIntent] || replies.freeform;
  const idx = (session.messageCount || 0) % candidates.length;
  return { text: candidates[idx], usedFallback: true, apiError: null };
}

/**
 * Generate a system reply for conference-level requests.
 * @private
 */
function _generateConferenceSystemReply(messageIntent, session) {
  const modeLabel = {
    work_chat: "Arbeitschat",
    problem_solving: "Problemlösung",
    decision_mode: "Entscheidungsmodus",
  }[session.conferenceMode] || "Arbeitschat";

  const focus = session.conferenceFocus || "kein spezifischer Fokus gesetzt";
  return `Konferenz-Status: ${session.conferenceStatus} | Modus: ${modeLabel} | Fokus: ${focus} | Nachrichten: ${session.messageCount} | Aktive Agenten: ${session.activeAgents.join(", ")}`;
}

/**
 * Update conference session status or mode.
 *
 * @param {Object} params
 * @param {string} params.conferenceId – required
 * @param {string} [params.conferenceStatus] – new status
 * @param {string} [params.conferenceMode] – new mode
 * @param {string} [params.conferenceFocus] – new focus description
 * @param {string} [params.relatedCaseId] – link to agent case
 * @returns {Object}
 */
function updateConferenceSession({
  conferenceId,
  conferenceStatus = null,
  conferenceMode = null,
  conferenceFocus = null,
  relatedCaseId = null,
} = {}) {
  if (!conferenceId) {
    return { success: false, error: "conferenceId is required" };
  }

  const session = _conferenceSessions.get(conferenceId);
  if (!session) {
    return { success: false, error: "Conference session not found" };
  }

  const now = new Date().toISOString();
  const changes = [];

  if (conferenceStatus && VALID_CONFERENCE_SESSION_STATUSES.includes(conferenceStatus)) {
    const oldStatus = session.conferenceStatus;
    session.conferenceStatus = conferenceStatus;
    session.statusHistory.push({ status: conferenceStatus, changedAt: now });
    changes.push(`Status: ${oldStatus} → ${conferenceStatus}`);
    if (conferenceStatus === "session_closed" || conferenceStatus === "session_archived") {
      session.sessionClosedAt = now;
    }
  }

  if (conferenceMode && VALID_CONFERENCE_MODES.includes(conferenceMode)) {
    const oldMode = session.conferenceMode;
    session.conferenceMode = conferenceMode;
    session.modeHistory.push({ mode: conferenceMode, changedAt: now });
    changes.push(`Modus: ${oldMode} → ${conferenceMode}`);
  }

  if (conferenceFocus !== null) {
    session.conferenceFocus = typeof conferenceFocus === "string"
      ? conferenceFocus.slice(0, CONFERENCE_FOCUS_MAX_LENGTH)
      : conferenceFocus;
    changes.push(`Fokus aktualisiert: ${session.conferenceFocus}`);
  }

  if (relatedCaseId !== null) {
    session.relatedCaseId = relatedCaseId;
    changes.push(`Fallbindung: ${relatedCaseId}`);
  }

  session.updatedAt = now;

  logger.info("[agentBridge] Konferenz Step A – Session aktualisiert", {
    conferenceId,
    changes,
  });

  return { success: true, conferenceId, session: _formatConferenceSession(session), changes };
}

/**
 * Close or archive a conference session.
 *
 * @param {Object} params
 * @param {string} params.conferenceId – required
 * @param {boolean} [params.archive] – if true, archive instead of close
 * @returns {Object}
 */
function closeConferenceSession({ conferenceId, archive = false } = {}) {
  if (!conferenceId) {
    return { success: false, error: "conferenceId is required" };
  }

  const session = _conferenceSessions.get(conferenceId);
  if (!session) {
    return { success: false, error: "Conference session not found" };
  }

  const now = new Date().toISOString();
  const newStatus = archive ? "session_archived" : "session_closed";
  session.conferenceStatus = newStatus;
  session.sessionClosedAt = now;
  session.statusHistory.push({ status: newStatus, changedAt: now });
  session.updatedAt = now;

  logger.info("[agentBridge] Konferenz Step A – Session geschlossen", {
    conferenceId,
    archived: archive,
    messageCount: session.messageCount,
  });

  return { success: true, conferenceId, conferenceStatus: newStatus, closedAt: now };
}

/**
 * Retrieve a conference session with messages.
 *
 * @param {Object} params
 * @param {string} params.conferenceId – required
 * @param {number} [params.limit] – max messages to return (newest first)
 * @returns {Object|null}
 */
function getConferenceSession({ conferenceId, limit = 50 } = {}) {
  if (!conferenceId) return null;

  const session = _conferenceSessions.get(conferenceId);
  if (!session) return null;

  const messages = session.messages.slice(-limit);
  return {
    ..._formatConferenceSession(session),
    messages,
  };
}

/**
 * Generate a human-readable conference summary.
 * Not a raw JSON dump – cooperative, structured, human-friendly.
 *
 * @param {Object} params
 * @param {string} params.conferenceId – required
 * @returns {Object|null}
 */
function getConferenceSummary({ conferenceId } = {}) {
  if (!conferenceId) return null;

  const session = _conferenceSessions.get(conferenceId);
  if (!session) return null;

  const modeLabel = {
    work_chat: "Arbeitschat",
    problem_solving: "Problemlösung",
    decision_mode: "Entscheidungsmodus",
  }[session.conferenceMode] || session.conferenceMode;

  const statusLabel = {
    session_open: "Offen",
    session_active: "Aktiv",
    session_paused: "Pausiert",
    session_closed: "Geschlossen",
    session_archived: "Archiviert",
  }[session.conferenceStatus] || session.conferenceStatus;

  // Derive who is leading
  const dsCount = session.deepseekMessageCount;
  const gmCount = session.geminiMessageCount;
  let leadingAgent = "Keiner klar führend";
  if (dsCount > gmCount + 2) leadingAgent = "DeepSeek führt den technischen Teil";
  else if (gmCount > dsCount + 2) leadingAgent = "Gemini führt den Frontend-/UX-Teil";
  else if (dsCount > 0 && gmCount > 0) leadingAgent = "Beide Agenten tragen bei";

  // Derive open points from recent messages
  const recentMessages = session.messages.slice(-10);
  const hasQuestions = recentMessages.some((m) => m.messageIntent === "question" || m.messageIntent === "clarification");
  const hasFollowUp = recentMessages.some((m) => m.messageIntent === "follow_up");
  const hasDecisionRequest = recentMessages.some((m) => m.messageIntent === "approval_feedback");

  const openPoints = [];
  if (hasQuestions) openPoints.push("Offene Fragen im letzten Gesprächsverlauf");
  if (hasFollowUp) openPoints.push("Follow-up-Themen angesprochen");
  if (hasDecisionRequest) openPoints.push("Entscheidungsbedarf signalisiert");
  if (openPoints.length === 0) openPoints.push("Keine offenen Punkte erkannt");

  // Current focus
  const currentFocus = session.conferenceFocus || "Kein spezifischer Fokus gesetzt";

  // What is understood so far
  const understood = session.messageCount > 5
    ? "Das Thema wurde in mehreren Beiträgen besprochen. Die Agenten haben ihre Sichten eingebracht."
    : session.messageCount > 0
      ? "Die Konferenz hat begonnen. Erste Einordnungen liegen vor."
      : "Noch keine Nachrichten ausgetauscht.";

  // Where is this heading
  const direction = session.conferenceMode === "decision_mode"
    ? "Die Konferenz steuert auf eine Entscheidung zu."
    : session.conferenceMode === "problem_solving"
      ? "Die Konferenz fokussiert sich auf Problemanalyse."
      : "Die Konferenz läuft als freier Arbeitschat.";

  // Next step
  const nextStep = session.conferenceStatus === "session_paused"
    ? "Die Sitzung ist pausiert. Sie kann jederzeit fortgesetzt werden."
    : session.conferenceStatus === "session_closed"
      ? "Die Sitzung ist abgeschlossen."
      : hasDecisionRequest
        ? "Der nächste Schritt wäre eine Entscheidung oder Freigabe."
        : "Der nächste Schritt wäre, das Thema weiter zu vertiefen oder den Fokus einzugrenzen.";

  const summary = {
    conferenceId: session.conferenceId,
    status: statusLabel,
    modus: modeLabel,
    currentFocus,
    understood,
    direction,
    leadingAgent,
    openPoints,
    nextStep,
    hasOpenFollowUp: hasFollowUp,
    hasOpenDecision: hasDecisionRequest,
    messageCount: session.messageCount,
    deepseekContributions: dsCount,
    geminiContributions: gmCount,
    sessionDuration: _formatDuration(session.sessionOpenedAt, session.sessionClosedAt || new Date().toISOString()),
    relatedCaseId: session.relatedCaseId,
    generatedAt: new Date().toISOString(),
  };

  // Cache summary on session
  session.conferenceSummary = summary;

  logger.info("[agentBridge] Konferenz Step A – Zusammenfassung generiert", {
    conferenceId,
    status: statusLabel,
    modus: modeLabel,
    messageCount: session.messageCount,
  });

  return summary;
}

/**
 * Load full conference workspace data for frontend.
 *
 * @returns {Object} workspace with active sessions, recent sessions, stats
 */
function getConferenceWorkspace() {
  const sessions = Array.from(_conferenceSessions.values());

  const activeSessions = sessions
    .filter((s) => s.conferenceStatus === "session_active" || s.conferenceStatus === "session_open")
    .sort((a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || ""))
    .map(_formatConferenceSession);

  const pausedSessions = sessions
    .filter((s) => s.conferenceStatus === "session_paused")
    .sort((a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || ""))
    .map(_formatConferenceSession);

  const recentClosed = sessions
    .filter((s) => s.conferenceStatus === "session_closed" || s.conferenceStatus === "session_archived")
    .sort((a, b) => (b.sessionClosedAt || "").localeCompare(a.sessionClosedAt || ""))
    .slice(0, 10)
    .map(_formatConferenceSession);

  return {
    success: true,
    totalSessions: sessions.length,
    activeSessions,
    pausedSessions,
    recentClosed,
    activeCount: activeSessions.length,
    pausedCount: pausedSessions.length,
    closedCount: sessions.filter((s) => s.conferenceStatus === "session_closed").length,
    archivedCount: sessions.filter((s) => s.conferenceStatus === "session_archived").length,
    // Convenience field: conferenceId of the most recently active session
    currentActiveConferenceId: activeSessions.length > 0 ? activeSessions[0].conferenceId : null,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Admin summary / analytics across all conference sessions.
 *
 * @returns {Object} aggregated conference stats
 */
function getConferenceAdminSummary() {
  const sessions = Array.from(_conferenceSessions.values());
  const total = sessions.length;

  const byStatus = {};
  const byMode = {};
  const byTarget = {};
  const byDialogState = {};

  for (const s of sessions) {
    byStatus[s.conferenceStatus] = (byStatus[s.conferenceStatus] || 0) + 1;
    byMode[s.conferenceMode] = (byMode[s.conferenceMode] || 0) + 1;
    if (s.lastTargetAgent) {
      byTarget[s.lastTargetAgent] = (byTarget[s.lastTargetAgent] || 0) + 1;
    }
    // Konferenz Step D: dialog state distribution
    const ds = s.dialogState || "dialog_idle";
    byDialogState[ds] = (byDialogState[ds] || 0) + 1;
  }

  const totalActive = byStatus["session_active"] || 0;
  const totalPaused = byStatus["session_paused"] || 0;
  const totalClosed = byStatus["session_closed"] || 0;
  const totalArchived = byStatus["session_archived"] || 0;

  const totalInDecisionMode = byMode["decision_mode"] || 0;
  const totalInProblemSolving = byMode["problem_solving"] || 0;
  const totalInWorkChat = byMode["work_chat"] || 0;

  const totalDeepseekOnly = byTarget["deepseek"] || 0;
  const totalGeminiOnly = byTarget["gemini"] || 0;
  const totalBothTargeted = byTarget["both"] || 0;

  const totalMessages = sessions.reduce((sum, s) => sum + s.messageCount, 0);
  const totalUserMessages = sessions.reduce((sum, s) => sum + (s.userMessageCount || 0), 0);

  // Sessions with follow-up need (recent messages with follow_up intent)
  const totalWithFollowUp = sessions.filter((s) => {
    const recent = s.messages.slice(-5);
    return recent.some((m) => m.messageIntent === "follow_up" || m.messageIntent === "question");
  }).length;

  // Sessions with related cases
  const totalWithCaseBinding = sessions.filter((s) => !!s.relatedCaseId).length;

  // Konferenz Step D: dialog quality metrics
  const totalFollowUpMessages = sessions.reduce((sum, s) => sum + (s.followUpCount || 0), 0);
  const totalCompletedCycles = sessions.reduce((sum, s) => sum + (s.replyCycleCount || 0), 0);
  const totalWithOpenClarification = sessions.filter((s) => s.openClarification === true).length;
  const totalWithActiveDialog = sessions.filter((s) =>
    s.dialogState !== "dialog_idle" && s.dialogState !== "reply_cycle_complete" &&
    (s.conferenceStatus === "session_active" || s.conferenceStatus === "session_open")
  ).length;

  // Konferenz Step E: Both-Mode metrics
  const totalBothModeMessages = sessions.reduce((sum, s) => sum + (s.bothModeMessageCount || 0), 0);
  const totalCompletedBothReplyCycles = sessions.reduce((sum, s) => sum + (s.completedBothReplyCycles || 0), 0);
  const totalPartialBothReplyCycles = sessions.reduce((sum, s) => sum + (s.partialBothReplyCycles || 0), 0);
  const totalDeepseekOnlyMessages = sessions.reduce((sum, s) => sum + (s.deepseekOnlyCount || 0), 0);
  const totalGeminiOnlyMessages = sessions.reduce((sum, s) => sum + (s.geminiOnlyCount || 0), 0);

  // Aggregate cooperation type distribution across all sessions
  const byCooperationType = {};
  for (const s of sessions) {
    const ct = s.bothModeCooperationTypes || {};
    for (const [type, count] of Object.entries(ct)) {
      byCooperationType[type] = (byCooperationType[type] || 0) + count;
    }
  }

  return {
    totalSessions: total,
    totalActive,
    totalPaused,
    totalClosed,
    totalArchived,
    totalInDecisionMode,
    totalInProblemSolving,
    totalInWorkChat,
    totalDeepseekOnly,
    totalGeminiOnly,
    totalBothTargeted,
    totalMessages,
    totalUserMessages,
    totalWithFollowUp,
    totalWithCaseBinding,
    // Konferenz Step D: dialog quality metrics
    totalFollowUpMessages,
    totalCompletedCycles,
    totalWithOpenClarification,
    totalWithActiveDialog,
    // Konferenz Step E: Both-Mode metrics
    totalBothModeMessages,
    totalCompletedBothReplyCycles,
    totalPartialBothReplyCycles,
    totalDeepseekOnlyMessages,
    totalGeminiOnlyMessages,
    byCooperationType,
    byStatus,
    byMode,
    byTarget,
    byDialogState,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Format a conference session for external consumption (without raw message array).
 * @private
 */
function _formatConferenceSession(session) {
  return {
    conferenceId: session.conferenceId,
    conferenceStatus: session.conferenceStatus,
    conferenceMode: session.conferenceMode,
    conferenceFocus: session.conferenceFocus,
    conferenceOwner: session.conferenceOwner,
    relatedCaseId: session.relatedCaseId,
    activeAgents: session.activeAgents,
    messageCount: session.messageCount,
    userMessageCount: session.userMessageCount,
    deepseekMessageCount: session.deepseekMessageCount,
    geminiMessageCount: session.geminiMessageCount,
    systemMessageCount: session.systemMessageCount,
    lastTargetAgent: session.lastTargetAgent,
    lastSpeaker: session.lastSpeaker,
    lastActivity: session.lastActivity,
    sessionOpenedAt: session.sessionOpenedAt,
    sessionClosedAt: session.sessionClosedAt,
    // Konferenz Step B coordination fields
    coordinationState: session.coordinationState || "uncoordinated",
    currentReplyPattern: session.currentReplyPattern || "solo_reply",
    leadAgent: session.leadAgent || null,
    supportAgent: session.supportAgent || null,
    currentPhaseStatus: session.currentPhaseStatus || "phase_open",
    phaseCount: session.phaseCount || 0,
    coordinatedReplyCount: session.coordinatedReplyCount || 0,
    soloReplyCount: session.soloReplyCount || 0,
    supportingReplyCount: session.supportingReplyCount || 0,
    bundledReplyCount: session.bundledReplyCount || 0,
    clarificationRequestCount: session.clarificationRequestCount || 0,
    leadershipChangeCount: session.leadershipChangeCount || 0,
    phasesClosedCount: session.phasesClosedCount || 0,
    openPointCount: (session.openPoints || []).length,
    // Konferenz Step C: Work phases, decision room, result cards
    workPhase: session.workPhase || "intake",
    decisionRoomActive: session.decisionRoomActive || false,
    decisionRoomState: session.decisionRoomState || "not_active",
    consensusState: session.consensusState || "neutral",
    handoffDirection: session.handoffDirection || "continue_session",
    moderationSignal: session.moderationSignal || "phase_stable",
    resultCardCount: session.resultCardCount || 0,
    phaseTransitionCount: session.phaseTransitionCount || 0,
    decisionRoomActivationCount: session.decisionRoomActivationCount || 0,
    currentResultCard: session.currentResultCard || null,
    // Konferenz Step D: Live dialog state
    dialogState: session.dialogState || "dialog_idle",
    openClarification: session.openClarification || false,
    followUpCount: session.followUpCount || 0,
    replyCycleCount: session.replyCycleCount || 0,
    lastUserMessageId: session.lastUserMessageId || null,
    lastUserMessage: session.lastUserMessage || null,
    lastReplyAgents: session.lastReplyAgents || [],
    // Konferenz Step E: Both-Mode tracking fields
    bothModeMessageCount: session.bothModeMessageCount || 0,
    completedBothReplyCycles: session.completedBothReplyCycles || 0,
    partialBothReplyCycles: session.partialBothReplyCycles || 0,
    deepseekOnlyCount: session.deepseekOnlyCount || 0,
    geminiOnlyCount: session.geminiOnlyCount || 0,
    bothModeCooperationTypes: session.bothModeCooperationTypes || {},
    createdAt: session.createdAt || session.sessionOpenedAt,
  };
}

/**
 * Format a duration between two ISO timestamps in human-readable form.
 * @private
 */
function _formatDuration(startIso, endIso) {
  try {
    const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
    if (ms < 0) return "—";
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes} Minuten`;
    const hours = Math.floor(minutes / 60);
    const remainMinutes = minutes % 60;
    return `${hours}h ${remainMinutes}min`;
  } catch {
    return "—";
  }
}

/* ─────────────────────────────────────────────
   Konferenz Step D: Live Dialog / User Message Handling /
   Agent Reply Routing / Dialogue Reliability
   ───────────────────────────────────────────── */

/**
 * Detect whether a user message is a follow-up on a previous exchange.
 * Uses keyword signals and session state (prior messages in session).
 * @param {string} userMessage
 * @param {Object} session
 * @returns {boolean}
 * @private
 */
function _isFollowUpMessage(userMessage, session) {
  if (!session.lastUserMessageId) return false; // first message in session
  // Pad with spaces so we can match whole words without triggering false positives
  // (e.g. "nochmal" should not match inside "nochmalig")
  const padded = ` ${userMessage.toLowerCase()} `;
  return CONFERENCE_FOLLOWUP_KEYWORDS.some((kw) => padded.includes(` ${kw} `) || padded.includes(` ${kw},`) || padded.includes(` ${kw}.`) || padded.includes(` ${kw}?`) || padded.includes(` ${kw}!`));
}

/**
 * Derive the response type for an agent reply.
 * Analyses content signals and context to classify the reply.
 * @param {string} agent - "deepseek" | "gemini" | "system"
 * @param {string} content - reply content
 * @param {Object} session - current session
 * @param {string|null} followUpOf - ID of a prior agent message this supplements
 * @returns {string} one of VALID_CONFERENCE_RESPONSE_TYPES
 * @private
 */
function _deriveResponseType(agent, content, session, followUpOf) {
  // System agents always provide a summary-style reply; they do not ask counter-questions.
  // This is intentional: system is a coordinator/status agent, not a dialogue partner.
  if (agent === "system") return "summary";
  const lower = (content || "").toLowerCase();

  // Supplementary agent reply in "both" mode → follow_up
  if (followUpOf) return "follow_up";

  // Coordinated reply (multi-agent active)
  if (session.coordinationState === "coordinated_active" ||
      session.currentReplyPattern === "coordinated_reply" ||
      session.currentReplyPattern === "bundled_reply") {
    return "coordinated";
  }

  // Counter-question signals
  const rückfrageSignals = [
    "kannst du", "könntest du", "was meinst du", "meinst du damit", "was genau",
    "könntest du das", "bitte erkläre", "ich bräuchte", "magst du", "darf ich fragen",
    "was ist der", "wie ist der", "wie meinst du", "könnten sie",
  ];
  if (rückfrageSignals.some((kw) => lower.includes(kw))) return "rückfrage";

  // Clarification
  const clarifySignals = ["ich präzisiere", "genauer gesagt", "ich klare", "zur klarstellung", "anders ausgedrückt"];
  if (clarifySignals.some((kw) => lower.includes(kw))) return "clarification";

  // Summary
  const summarySignals = ["zusammenfassend", "zusammenfassung", "fazit", "im ergebnis", "zusammengefasst"];
  if (summarySignals.some((kw) => lower.includes(kw))) return "summary";

  // Default: direct answer
  return "direct_answer";
}

/**
 * Get the current dialog state for a conference session, including
 * pending indicators and reply context for frontend consumption.
 *
 * @param {Object} params
 * @param {string} params.conferenceId – required
 * @returns {Object|null}
 */
function getConferenceDialogState({ conferenceId } = {}) {
  if (!conferenceId) return null;
  const session = _conferenceSessions.get(conferenceId);
  if (!session) return null;

  const dialogStateLabel = {
    dialog_idle: "Kein aktiver Dialog",
    message_received: "Nachricht empfangen",
    agent_reply_pending: "Agentenantwort ausstehend",
    reply_delivered: "Antwort zugestellt",
    additional_agent_pending: "Zweite Agentenantwort ausstehend",
    reply_cycle_complete: "Antwortzyklus abgeschlossen",
    clarification_open: "Rückfrage offen",
    follow_up_pending: "Folgefrage wartet auf Antwort",
  }[session.dialogState] || session.dialogState;

  // Last few messages for context
  const recentMessages = session.messages.slice(-6).map((m) => ({
    messageId: m.messageId,
    speakerAgent: m.speakerAgent,
    messageRole: m.messageRole,
    messageIntent: m.messageIntent || null,
    responseType: m.responseType || null,
    replyToMessageId: m.replyToMessageId || null,
    followUpOf: m.followUpOf || null,
    isFollowUp: m.isFollowUp || false,
    createdAt: m.createdAt,
    contentExcerpt: (m.content || "").slice(0, 100),
  }));

  return {
    conferenceId,
    dialogState: session.dialogState,
    dialogStateLabel,
    openClarification: session.openClarification,
    followUpCount: session.followUpCount,
    replyCycleCount: session.replyCycleCount,
    lastUserMessageId: session.lastUserMessageId,
    lastUserMessage: session.lastUserMessage,
    lastReplyAgents: session.lastReplyAgents || [],
    lastTargetAgent: session.lastTargetAgent,
    lastSpeaker: session.lastSpeaker,
    lastActivity: session.lastActivity,
    conferenceStatus: session.conferenceStatus,
    conferenceMode: session.conferenceMode,
    workPhase: session.workPhase,
    recentMessages,
    generatedAt: new Date().toISOString(),
  };
}

/* ─────────────────────────────────────────────
   Konferenz Step C: Conference Phases / Decision Room / Result Cards / Strategic Expansion
   ───────────────────────────────────────────── */

/**
 * Derive the current work phase of a conference session based on message
 * content, phase status, and session dynamics.
 * @param {Object} session
 * @returns {string} one of VALID_CONFERENCE_WORK_PHASES
 * @private
 */
function _deriveConferenceWorkPhase(session) {
  const msgCount = session.messageCount || 0;
  const phaseStatus = session.currentPhaseStatus || "phase_open";
  const mode = session.conferenceMode || "work_chat";

  // Check recent messages for content signals
  const recentMessages = (session.messages || []).slice(-8);
  const recentText = recentMessages.map((m) => (m.content || "").toLowerCase()).join(" ");

  // Result/conclusion signals → result_transition
  if (CONFERENCE_RESULT_KEYWORDS.some((kw) => recentText.includes(kw)) &&
      (phaseStatus === "phase_concluded" || phaseStatus === "recommendation_ready")) {
    return "result_transition";
  }

  // Decision keywords + decision mode → decision_preparation
  if (CONFERENCE_DECISION_KEYWORDS.some((kw) => recentText.includes(kw)) ||
      phaseStatus === "decision_pending" || phaseStatus === "recommendation_ready") {
    if (mode === "decision_mode" || msgCount > 6) {
      return "decision_preparation";
    }
  }

  // Option/tradeoff keywords → option_room or tradeoff
  if (CONFERENCE_OPTION_KEYWORDS.some((kw) => recentText.includes(kw))) {
    const tradeoffWords = ["abwägung", "tradeoff", "vor- und nachteile", "nachteil", "kompromiss"];
    if (tradeoffWords.some((kw) => recentText.includes(kw))) {
      return "tradeoff";
    }
    return "option_room";
  }

  // Cause identified / analysis in progress → analysis
  if (phaseStatus === "cause_identified" || (phaseStatus === "problem_scoped" && msgCount > 4)) {
    return "analysis";
  }

  // Problem scoped / clarification open → problem_clarification
  if (phaseStatus === "problem_scoped" || phaseStatus === "clarification_open" || msgCount > 2) {
    return "problem_clarification";
  }

  // Default: intake for fresh sessions
  return "intake";
}

/**
 * Derive the decision room state for the current conference session.
 * Activated when the session moves into option_room, tradeoff, or decision_preparation.
 * @param {Object} session
 * @returns {string} one of VALID_CONFERENCE_DECISION_ROOM_STATES
 * @private
 */
function _deriveDecisionRoomState(session) {
  const workPhase = session.workPhase || "intake";

  if (workPhase === "intake" || workPhase === "problem_clarification" || workPhase === "analysis") {
    return "not_active";
  }

  const options = session.optionRoomOptions || [];
  const optionCount = options.length;

  // result_transition → decision ready
  if (workPhase === "result_transition") {
    return "decision_ready";
  }

  // decision_preparation
  if (workPhase === "decision_preparation") {
    const hasConsensus = session.consensusState === "consensus_reached" || session.consensusState === "converging";
    if (hasConsensus) return "direction_emerging";
    if (optionCount >= 2) return "options_compared";
    return "options_collected";
  }

  // tradeoff
  if (workPhase === "tradeoff") {
    return "tradeoff_open";
  }

  // option_room
  if (workPhase === "option_room") {
    if (optionCount >= 2) return "options_compared";
    return "options_collected";
  }

  return "not_active";
}

/**
 * Derive the consensus state from recent messages and agent reply patterns.
 * @param {Object} session
 * @returns {string} one of VALID_CONFERENCE_CONSENSUS_STATES
 * @private
 */
function _deriveConsensusState(session) {
  const recentMessages = (session.messages || []).slice(-10);
  const recentText = recentMessages.map((m) => (m.content || "").toLowerCase()).join(" ");

  const clarificationSignals = CONFERENCE_CLARIFICATION_SIGNALS;
  const convergenceSignals = CONFERENCE_CONVERGENCE_KEYWORDS;

  // Clarification blocking
  if (session.currentPhaseStatus === "clarification_open" ||
      clarificationSignals.some((kw) => recentText.includes(kw))) {
    return "clarification_needed";
  }

  // Phase concluded → likely consensus reached
  if (session.currentPhaseStatus === "phase_concluded") {
    return "consensus_reached";
  }

  // Recommendation ready → converging
  if (session.currentPhaseStatus === "recommendation_ready") {
    return "converging";
  }

  // Convergence keywords
  if (convergenceSignals.some((kw) => recentText.includes(kw))) {
    const dsReplies = recentMessages.filter((m) => m.speakerAgent === "deepseek");
    const gmReplies = recentMessages.filter((m) => m.speakerAgent === "gemini");
    if (dsReplies.length > 0 && gmReplies.length > 0) return "consensus_reached";
    return "converging";
  }

  // Dissent: tradeoff active and no convergence
  if (session.workPhase === "tradeoff") {
    return "dissent_active";
  }

  // Multiple open points suggest partial consensus
  if ((session.openPoints || []).length >= 2) {
    return "partial_consensus";
  }

  return "neutral";
}

/**
 * Derive the recommended handoff direction for a conference session.
 * Does NOT trigger any automatic action – purely informational recommendation.
 * @param {Object} session
 * @returns {{ direction: string, reason: string }}
 * @private
 */
function _deriveHandoffDirection(session) {
  const workPhase = session.workPhase || "intake";
  const consensusState = session.consensusState || "neutral";
  const phaseStatus = session.currentPhaseStatus || "phase_open";

  if (phaseStatus === "phase_concluded" || workPhase === "result_transition") {
    if (consensusState === "consensus_reached" || consensusState === "converging") {
      return { direction: "prepare_candidate", reason: "Ergebnis konvergiert – Kandidat oder Genehmigungsschritt vorbereiten." };
    }
    return { direction: "prepare_draft", reason: "Phase abgeschlossen – Entwurf als nächsten Schritt vorbereiten." };
  }

  if (workPhase === "decision_preparation") {
    return { direction: "prepare_candidate", reason: "Entscheidungsvorbereitung läuft – Kandidatenschritt einleiten." };
  }

  if (consensusState === "clarification_needed") {
    return { direction: "further_clarification", reason: "Offene Klärung blockiert den Fortschritt – zuerst klären." };
  }

  if (consensusState === "dissent_active" || workPhase === "tradeoff") {
    return { direction: "further_review", reason: "Offener Zielkonflikt – weitere Prüfung oder Moderation nötig." };
  }

  if (session.conferenceStatus === "session_paused") {
    return { direction: "pause_session", reason: "Session pausiert – kann wiederaufgenommen werden." };
  }

  if (session.conferenceStatus === "session_closed") {
    return { direction: "close_session", reason: "Session abgeschlossen." };
  }

  return { direction: "continue_session", reason: "Session läuft – weitere Arbeit in dieser Sitzung." };
}

/**
 * Derive the moderation signal – a quiet workflow hint for the operator/frontend.
 * @param {Object} session
 * @returns {string} one of VALID_CONFERENCE_MODERATION_SIGNALS
 * @private
 */
function _deriveModerationSignal(session) {
  const workPhase = session.workPhase || "intake";
  const consensusState = session.consensusState || "neutral";
  const phaseStatus = session.currentPhaseStatus || "phase_open";
  const msgCount = session.messageCount || 0;

  if (phaseStatus === "phase_concluded" || workPhase === "result_transition") {
    if (session.handoffDirection === "close_session") return "session_closing";
    return "result_ready";
  }

  if (session.handoffDirection === "prepare_candidate" || session.handoffDirection === "prepare_draft") {
    return "handoff_ready";
  }

  if (consensusState === "clarification_needed") {
    return "clarification_blocking";
  }

  if (consensusState === "dissent_active") {
    return "dissent_requires_attention";
  }

  if (consensusState === "consensus_reached" || consensusState === "converging") {
    return "consensus_possible";
  }

  // Enough material to advance phase
  if (msgCount >= 4 && (workPhase === "intake" || workPhase === "problem_clarification")) {
    return "ready_for_phase_advance";
  }

  return "phase_stable";
}

/**
 * Build a structured result card for the current phase of the conference.
 * This is the per-phase result object: what was understood, where consensus stands,
 * remaining differences, open points, next step, handoff need.
 * @param {Object} session
 * @returns {Object} result card
 * @private
 */
function _buildConferenceResultCard(session) {
  const workPhase = session.workPhase || "intake";
  const consensusState = session.consensusState || "neutral";
  const openPoints = (session.openPoints || []).map((p) => p.label || p);

  // What was understood in this phase
  const phaseUnderstood = {
    intake: "Thema und Kontext wurden aufgenommen.",
    problem_clarification: "Das Problem wurde eingegrenzt und präzisiert.",
    analysis: "Ursachen und Dimensionen wurden analysiert.",
    option_room: "Optionen und Alternativen wurden gesammelt und verglichen.",
    tradeoff: "Zielkonflikte wurden identifiziert und diskutiert.",
    decision_preparation: "Eine Entscheidungsrichtung wurde vorbereitet.",
    result_transition: "Ein verwertbares Ergebnis liegt vor – bereit für den nächsten Schritt.",
  }[workPhase] || "Phase läuft.";

  // Where is it heading
  const directionLabel = {
    neutral: "Noch keine klare Richtung.",
    converging: "Richtung konvergiert.",
    consensus_reached: "Einigkeit erreicht.",
    partial_consensus: "Teilweise Einigkeit – einige Punkte noch offen.",
    dissent_active: "Offener Zielkonflikt – keine einheitliche Richtung.",
    clarification_needed: "Klärungsbedarf – Richtung noch nicht bestimmbar.",
  }[consensusState] || "Richtung unklar.";

  // Remaining differences (simple derivation from agent perspective signals)
  const dsMessages = (session.messages || []).filter((m) => m.speakerAgent === "deepseek").slice(-3);
  const gmMessages = (session.messages || []).filter((m) => m.speakerAgent === "gemini").slice(-3);
  let remainingDifferences = "Keine erkennbaren Unterschiede.";
  if (consensusState === "dissent_active" || consensusState === "partial_consensus") {
    if (dsMessages.length > 0 && gmMessages.length > 0) {
      remainingDifferences = "Backend- und Frontend-Perspektiven haben unterschiedliche Schwerpunkte gesetzt.";
    } else {
      remainingDifferences = "Offene Punkte wurden noch nicht vollständig abgeglichen.";
    }
  }

  // Next controlled step
  const handoffResult = session.handoffDirection
    ? { direction: session.handoffDirection, reason: session.handoffDirectionReason || "" }
    : _deriveHandoffDirection(session);

  const nextStepLabel = {
    continue_session: "Weitere Arbeit in dieser Sitzung.",
    further_clarification: "Offene Klärung zuerst beantworten.",
    prepare_draft: "Entwurf vorbereiten.",
    prepare_candidate: "Kandidaten- oder Genehmigungsschritt einleiten.",
    further_review: "Weitere Prüfung oder Moderation einschalten.",
    pause_session: "Session pausieren und zu gegebenem Zeitpunkt fortsetzen.",
    close_session: "Konferenz abschließen.",
  }[handoffResult.direction] || "Weiter in der Konferenz.";

  const handoffNeeded = !["continue_session", "pause_session"].includes(handoffResult.direction);

  const cardId = `rc-${session.conferenceId}-${Date.now()}`;
  const now = new Date().toISOString();

  return {
    resultCardId: cardId,
    conferenceId: session.conferenceId,
    workPhase,
    phaseStatus: session.currentPhaseStatus || "phase_open",
    generatedAt: now,
    // Core result fields
    understood: phaseUnderstood,
    direction: directionLabel,
    consensusState,
    remainingDifferences,
    openPoints,
    openPointCount: openPoints.length,
    nextStep: nextStepLabel,
    handoffNeeded,
    handoffDirection: handoffResult.direction,
    handoffDirectionReason: handoffResult.reason,
    // Recommended and alternative directions (light decision framing)
    recommendedDirection: session.recommendedDirection || null,
    conservativeAlternative: session.conservativeAlternative || null,
    broadAlternative: session.broadAlternative || null,
    openTradeoff: session.openTradeoff || null,
  };
}

/**
 * Build a lightweight perspective comparison between DeepSeek and Gemini perspectives.
 * Not a model battle – just a structured view of where they agree and differ.
 * @param {Object} session
 * @returns {Object|null}
 * @private
 */
function _buildPerspectiveComparison(session) {
  const dsMessages = (session.messages || []).filter((m) => m.speakerAgent === "deepseek");
  const gmMessages = (session.messages || []).filter((m) => m.speakerAgent === "gemini");

  if (dsMessages.length === 0 || gmMessages.length === 0) return null;

  const dsLast = dsMessages[dsMessages.length - 1];
  const gmLast = gmMessages[gmMessages.length - 1];

  const dsFocus = session.conferenceFocus
    ? `Backend-/API-Perspektive zu: ${session.conferenceFocus}`
    : "Backend-/API-Perspektive";
  const gmFocus = session.conferenceFocus
    ? `Frontend-/UX-Perspektive zu: ${session.conferenceFocus}`
    : "Frontend-/UX-Perspektive";

  // Determine common ground and dissent
  const consensusState = session.consensusState || "neutral";
  let commonLine = "Beide Agenten haben zum Thema beigetragen.";
  let dissent = "Kein offensichtlicher Dissens.";

  if (consensusState === "consensus_reached") {
    commonLine = "Beide Agenten konvergieren auf eine gemeinsame Richtung.";
    dissent = "Kein offener Dissens.";
  } else if (consensusState === "partial_consensus") {
    commonLine = "Grundlegendes Verständnis geteilt.";
    dissent = "Einige Punkte werden noch unterschiedlich bewertet.";
  } else if (consensusState === "dissent_active") {
    commonLine = "Thema ist von beiden Perspektiven aufgenommen worden.";
    dissent = "Unterschiedliche Schwerpunkte: Backend-Logik vs. Frontend-/UX-Anforderungen.";
  }

  return {
    conferenceId: session.conferenceId,
    workPhase: session.workPhase || "intake",
    generatedAt: new Date().toISOString(),
    deepseekView: {
      agent: "deepseek",
      perspective: dsFocus,
      messageCount: dsMessages.length,
      lastContribution: (dsLast.content || "").substring(0, PERSPECTIVE_CONTRIBUTION_MAX_LENGTH),
    },
    geminiView: {
      agent: "gemini",
      perspective: gmFocus,
      messageCount: gmMessages.length,
      lastContribution: (gmLast.content || "").substring(0, PERSPECTIVE_CONTRIBUTION_MAX_LENGTH),
    },
    commonLine,
    dissent,
    consensusState,
  };
}

/**
 * Advance a conference session's work phase, recording the transition.
 * Validates that the requested phase is valid and not a step backward.
 * @param {Object} session
 * @param {string} targetPhase
 * @returns {{ advanced: boolean, from: string, to: string, reason: string }}
 * @private
 */
function _advanceConferenceWorkPhase(session, targetPhase) {
  const currentPhase = session.workPhase || "intake";
  const phaseOrder = VALID_CONFERENCE_WORK_PHASES;
  const currentIdx = phaseOrder.indexOf(currentPhase);
  const targetIdx = phaseOrder.indexOf(targetPhase);

  if (targetIdx < 0) {
    return { advanced: false, from: currentPhase, to: currentPhase, reason: "Ungültige Zielphase." };
  }
  if (targetIdx <= currentIdx) {
    return { advanced: false, from: currentPhase, to: currentPhase, reason: "Zielphase ist gleich oder früher als aktuelle Phase." };
  }

  const previousPhase = currentPhase;
  session.previousPhaseResult = session.currentResultCard;
  session.workPhase = targetPhase;
  const now = new Date().toISOString();
  session.workPhaseHistory.push({ phase: targetPhase, enteredAt: now, previousPhase });
  session.phaseTransitionCount = (session.phaseTransitionCount || 0) + 1;
  session.updatedAt = now;

  logger.info("[agentBridge] Konferenz Step C – Phasenwechsel", {
    conferenceId: session.conferenceId,
    from: previousPhase,
    to: targetPhase,
    phaseTransitionCount: session.phaseTransitionCount,
  });

  return { advanced: true, from: previousPhase, to: targetPhase, reason: `Phase gewechselt von ${previousPhase} zu ${targetPhase}.` };
}

/**
 * Update all Step C fields on a conference session after an interaction.
 * Called at the end of sendConferenceMessage and sendCoordinatedConferenceMessage.
 * @param {Object} session
 * @private
 */
function _updateConferenceStepC(session) {
  const prevWorkPhase = session.workPhase;
  const prevDecisionRoomActive = session.decisionRoomActive;

  // Derive new work phase
  const newWorkPhase = _deriveConferenceWorkPhase(session);
  if (newWorkPhase !== prevWorkPhase) {
    _advanceConferenceWorkPhase(session, newWorkPhase);
  }

  // Derive consensus state
  session.consensusState = _deriveConsensusState(session);

  // Derive decision room state
  const newDRState = _deriveDecisionRoomState(session);
  const wasInactive = prevDecisionRoomActive === false;
  const nowActive = newDRState !== "not_active";

  if (wasInactive && nowActive) {
    session.decisionRoomActivationCount = (session.decisionRoomActivationCount || 0) + 1;
    logger.info("[agentBridge] Konferenz Step C – Decision Room aktiviert", {
      conferenceId: session.conferenceId,
      workPhase: session.workPhase,
      decisionRoomState: newDRState,
      activationCount: session.decisionRoomActivationCount,
    });
  }
  session.decisionRoomActive = nowActive;
  session.decisionRoomState = newDRState;

  // Derive handoff direction
  const handoffResult = _deriveHandoffDirection(session);
  session.handoffDirection = handoffResult.direction;
  session.handoffDirectionReason = handoffResult.reason;

  // Derive moderation signal
  session.moderationSignal = _deriveModerationSignal(session);

  // Update perspective comparison if both agents have contributed
  const dsCount = session.deepseekMessageCount || 0;
  const gmCount = session.geminiMessageCount || 0;
  if (dsCount > 0 && gmCount > 0) {
    session.perspectiveComparison = _buildPerspectiveComparison(session);
  }

  // Build result card when result_ready or result_transition
  if (session.moderationSignal === "result_ready" || session.workPhase === "result_transition") {
    const card = _buildConferenceResultCard(session);
    session.currentResultCard = card;
    session.resultCards.push(card);
    session.resultCardCount = (session.resultCardCount || 0) + 1;
    logger.info("[agentBridge] Konferenz Step C – Result Card erzeugt", {
      conferenceId: session.conferenceId,
      workPhase: session.workPhase,
      resultCardId: card.resultCardId,
      resultCardCount: session.resultCardCount,
    });
  }

  // Log consensus/dissent changes
  if (session.consensusState === "consensus_reached") {
    logger.info("[agentBridge] Konferenz Step C – Einigkeit erreicht", {
      conferenceId: session.conferenceId,
      workPhase: session.workPhase,
    });
  } else if (session.consensusState === "dissent_active") {
    logger.info("[agentBridge] Konferenz Step C – Offener Dissens", {
      conferenceId: session.conferenceId,
      workPhase: session.workPhase,
    });
  }

  // Log handoff readiness
  if (session.moderationSignal === "handoff_ready") {
    logger.info("[agentBridge] Konferenz Step C – Übergaberichtung bereit", {
      conferenceId: session.conferenceId,
      handoffDirection: session.handoffDirection,
      handoffDirectionReason: session.handoffDirectionReason,
    });
  }
}

/* ─────────────────────────────────────────────
   Konferenz Step C: Public functions
   ───────────────────────────────────────────── */

/**
 * Get the current result card for a specific conference session.
 * @param {Object} params
 * @param {string} params.conferenceId
 * @returns {Object|null}
 */
function getConferenceResultCard({ conferenceId } = {}) {
  if (!conferenceId) return null;
  const session = _conferenceSessions.get(conferenceId);
  if (!session) return null;
  // Build a fresh card (always current)
  return _buildConferenceResultCard(session);
}

/**
 * Get the decision room state for a specific conference session.
 * Includes: active options, recommended direction, conservative/broad alternatives,
 * open tradeoff, consensus state, next decision need.
 * @param {Object} params
 * @param {string} params.conferenceId
 * @returns {Object|null}
 */
function getConferenceDecisionRoom({ conferenceId } = {}) {
  if (!conferenceId) return null;
  const session = _conferenceSessions.get(conferenceId);
  if (!session) return null;

  return {
    conferenceId: session.conferenceId,
    workPhase: session.workPhase || "intake",
    decisionRoomActive: session.decisionRoomActive || false,
    decisionRoomState: session.decisionRoomState || "not_active",
    optionRoomOptions: session.optionRoomOptions || [],
    optionCount: (session.optionRoomOptions || []).length,
    recommendedDirection: session.recommendedDirection || null,
    conservativeAlternative: session.conservativeAlternative || null,
    broadAlternative: session.broadAlternative || null,
    openTradeoff: session.openTradeoff || null,
    nextDecisionNeed: session.nextDecisionNeed || null,
    consensusState: session.consensusState || "neutral",
    handoffDirection: session.handoffDirection || "continue_session",
    handoffDirectionReason: session.handoffDirectionReason || null,
    moderationSignal: session.moderationSignal || "phase_stable",
    discardedDirections: session.discardedDirections || [],
    lastKnownDecision: session.lastKnownDecision || null,
    decisionRoomActivationCount: session.decisionRoomActivationCount || 0,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Get the lightweight perspective comparison for a specific conference session.
 * @param {Object} params
 * @param {string} params.conferenceId
 * @returns {Object|null}
 */
function getConferencePerspectiveComparison({ conferenceId } = {}) {
  if (!conferenceId) return null;
  const session = _conferenceSessions.get(conferenceId);
  if (!session) return null;
  return _buildPerspectiveComparison(session);
}

/**
 * Admin summary across all conference sessions – Step C extension.
 * Adds phase distribution, decision room stats, consensus/dissent, handoff stats.
 * @returns {Object}
 */
function getConferenceStepCSummary() {
  const sessions = Array.from(_conferenceSessions.values());
  const total = sessions.length;

  const byWorkPhase = {};
  const byDecisionRoomState = {};
  const byConsensusState = {};
  const byHandoffDirection = {};
  const byModerationSignal = {};

  let totalDecisionRoomActive = 0;
  let totalWithConsensus = 0;
  let totalWithDissent = 0;
  let totalWithHandoffReady = 0;
  let totalWithResultCard = 0;
  let totalWithOpenClarification = 0;
  let totalPhaseTransitions = 0;
  let totalResultCards = 0;
  let totalDecisionRoomActivations = 0;

  for (const s of sessions) {
    const wp = s.workPhase || "intake";
    byWorkPhase[wp] = (byWorkPhase[wp] || 0) + 1;

    const drs = s.decisionRoomState || "not_active";
    byDecisionRoomState[drs] = (byDecisionRoomState[drs] || 0) + 1;

    const cs = s.consensusState || "neutral";
    byConsensusState[cs] = (byConsensusState[cs] || 0) + 1;

    const hd = s.handoffDirection || "continue_session";
    byHandoffDirection[hd] = (byHandoffDirection[hd] || 0) + 1;

    const ms = s.moderationSignal || "phase_stable";
    byModerationSignal[ms] = (byModerationSignal[ms] || 0) + 1;

    if (s.decisionRoomActive) totalDecisionRoomActive += 1;
    if (cs === "consensus_reached" || cs === "converging") totalWithConsensus += 1;
    if (cs === "dissent_active") totalWithDissent += 1;
    if (ms === "handoff_ready") totalWithHandoffReady += 1;
    if ((s.resultCards || []).length > 0) totalWithResultCard += 1;
    if (cs === "clarification_needed") totalWithOpenClarification += 1;
    totalPhaseTransitions += s.phaseTransitionCount || 0;
    totalResultCards += s.resultCardCount || 0;
    totalDecisionRoomActivations += s.decisionRoomActivationCount || 0;
  }

  return {
    totalSessions: total,
    byWorkPhase,
    byDecisionRoomState,
    byConsensusState,
    byHandoffDirection,
    byModerationSignal,
    highlights: {
      totalDecisionRoomActive,
      totalWithConsensus,
      totalWithDissent,
      totalWithHandoffReady,
      totalWithResultCard,
      totalWithOpenClarification,
      totalPhaseTransitions,
      totalResultCards,
      totalDecisionRoomActivations,
    },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Manually advance a conference session's work phase.
 * Does not auto-execute anything – operator/admin-controlled.
 * @param {Object} params
 * @param {string} params.conferenceId
 * @param {string} params.targetPhase - target phase from VALID_CONFERENCE_WORK_PHASES
 * @returns {Object}
 */
function advanceConferencePhase({ conferenceId, targetPhase } = {}) {
  if (!conferenceId) return { success: false, error: "conferenceId is required" };
  if (!targetPhase) return { success: false, error: "targetPhase is required" };
  if (!VALID_CONFERENCE_WORK_PHASES.includes(targetPhase)) {
    return { success: false, error: `Invalid targetPhase. Valid values: ${VALID_CONFERENCE_WORK_PHASES.join(", ")}` };
  }

  const session = _conferenceSessions.get(conferenceId);
  if (!session) return { success: false, error: "Conference session not found" };

  const result = _advanceConferenceWorkPhase(session, targetPhase);
  if (!result.advanced) {
    return { success: false, error: result.reason };
  }

  // Re-derive Step C fields after phase advance
  _updateConferenceStepC(session);

  return {
    success: true,
    conferenceId,
    from: result.from,
    to: result.to,
    reason: result.reason,
    workPhase: session.workPhase,
    moderationSignal: session.moderationSignal,
    handoffDirection: session.handoffDirection,
  };
}

/* ─────────────────────────────────────────────
   Konferenz Step B: Coordination / Moderation / Coordinated Reply Flow
   ───────────────────────────────────────────── */

/**
 * Derive which agent should lead based on message content, session history, and mode.
 * @private
 */
function _deriveLeadAgent(userMessage, session) {
  const lowerMsg = (userMessage || "").toLowerCase();
  
  // Check explicit domain references
  let dsScore = 0;
  let gmScore = 0;
  
  for (const kw of CONFERENCE_BACKEND_KEYWORDS) {
    if (lowerMsg.includes(kw)) dsScore += 1;
  }
  for (const kw of CONFERENCE_FRONTEND_KEYWORDS) {
    if (lowerMsg.includes(kw)) gmScore += 1;
  }

  // Factor in session history
  if (session.deepseekMessageCount > session.geminiMessageCount + 3) {
    dsScore += 1; // DeepSeek has been more active
  } else if (session.geminiMessageCount > session.deepseekMessageCount + 3) {
    gmScore += 1; // Gemini has been more active
  }

  // Decision mode: keep current lead or default to deepseek
  if (session.conferenceMode === "decision_mode") {
    if (dsScore === gmScore && session.leadAgent) return session.leadAgent;
  }

  if (dsScore > gmScore) return "deepseek";
  if (gmScore > dsScore) return "gemini";
  
  // Keep current lead if exists, otherwise deepseek as default
  return session.leadAgent || "deepseek";
}

/**
 * Assess which reply pattern should be used for this interaction.
 * @private
 */
function _assessReplyPattern(userMessage, session, resolvedTarget) {
  const lowerMsg = (userMessage || "").toLowerCase();
  const recentMessages = session.messages.slice(-6);
  
  // Check for clarification signals
  const needsClarification = CONFERENCE_CLARIFICATION_SIGNALS.some(s => lowerMsg.includes(s));
  if (needsClarification) return "needs_user_clarification";
  
  // If phase was just concluded, signal it
  if (session.currentPhaseStatus === "phase_concluded") return "phase_closed";
  
  // If target is single agent, solo reply
  if (resolvedTarget === "deepseek" || resolvedTarget === "gemini") {
    // Check if the other agent recently contributed something relevant
    const otherAgent = resolvedTarget === "deepseek" ? "gemini" : "deepseek";
    const recentOtherReply = recentMessages.some(m => m.speakerAgent === otherAgent && m.messageRole === "agent");
    
    if (recentOtherReply && session.conferenceMode === "problem_solving") {
      return "cross_agent_followup";
    }
    return "solo_reply";
  }
  
  // Target is "both" – decide between coordinated, supporting, or bundled
  if (resolvedTarget === "both") {
    // Decision mode → bundled reply preferred
    if (session.conferenceMode === "decision_mode") return "bundled_reply";
    
    // Problem solving with established lead → supporting reply
    if (session.conferenceMode === "problem_solving" && session.leadAgent) {
      return "supporting_reply";
    }
    
    // Default for both: coordinated
    return "coordinated_reply";
  }
  
  // System target
  return "solo_reply";
}

/**
 * Derive the coordination state based on session state and reply pattern.
 * @private
 */
function _deriveCoordinationState(session, replyPattern) {
  if (replyPattern === "needs_user_clarification") return "clarification_pending";
  if (replyPattern === "phase_closed") return "phase_closed";
  if (replyPattern === "bundled_reply") return "bundling_needed";
  if (replyPattern === "coordinated_reply") return "coordinated_active";
  if (replyPattern === "supporting_reply") return "support_active";
  if (replyPattern === "cross_agent_followup") return "coordinated_active";
  if (session.leadAgent) return "lead_assigned";
  return "uncoordinated";
}

/**
 * Assess whether the current discussion phase should be closed.
 * @private
 */
function _assessPhaseClosure(session) {
  const recentMessages = session.messages.slice(-8);
  if (recentMessages.length < 3) return { shouldClose: false, reason: null };
  
  // Check for convergence signals
  const recentTexts = recentMessages.map(m => (m.content || "").toLowerCase());
  
  let convergenceScore = 0;
  for (const text of recentTexts) {
    for (const kw of CONFERENCE_CONVERGENCE_KEYWORDS) {
      if (text.includes(kw)) convergenceScore += 1;
    }
  }
  
  // Both agents have replied and convergence signals present
  const hasDeepseekReply = recentMessages.some(m => m.speakerAgent === "deepseek");
  const hasGeminiReply = recentMessages.some(m => m.speakerAgent === "gemini");
  const bothContributed = hasDeepseekReply && hasGeminiReply;
  
  if (convergenceScore >= 2 && bothContributed) {
    return { shouldClose: true, reason: "Konvergenz erkannt – beide Agenten haben beigetragen und Einigkeit signalisiert" };
  }
  
  if (convergenceScore >= 3) {
    return { shouldClose: true, reason: "Mehrfache Konvergenz-Signale in der letzten Diskussion" };
  }
  
  return { shouldClose: false, reason: null };
}

/**
 * Derive the phase status based on messages and session state.
 * @private
 */
function _derivePhaseStatus(session) {
  const recentMessages = session.messages.slice(-10);
  if (recentMessages.length === 0) return "phase_open";
  
  const recentTexts = recentMessages.map(m => (m.content || "").toLowerCase()).join(" ");
  
  // Check for specific phase indicators
  if (recentTexts.includes("empfehlung") || recentTexts.includes("vorschlag") || recentTexts.includes("empfehle")) {
    return "recommendation_ready";
  }
  if (recentTexts.includes("ursache") || recentTexts.includes("root cause") || recentTexts.includes("grund dafür")) {
    return "cause_identified";
  }
  if (recentTexts.includes("eingegrenzt") || recentTexts.includes("scope") || recentTexts.includes("fokussier")) {
    return "problem_scoped";
  }
  if (recentTexts.includes("entscheidung") || recentTexts.includes("entscheid") || recentTexts.includes("wähle")) {
    return "decision_pending";
  }
  if (recentTexts.includes("unklar") || recentTexts.includes("rückfrage") || recentTexts.includes("klärung")) {
    return "clarification_open";
  }
  
  return "phase_open";
}

/**
 * Derive open points and pending clarifications from the session.
 * @private
 */
function _deriveConferenceOpenPoints(session) {
  const recentMessages = session.messages.slice(-12);
  const openPoints = [];
  
  // Check for unanswered questions (user question without subsequent agent answer)
  for (let i = 0; i < recentMessages.length; i++) {
    const msg = recentMessages[i];
    if (msg.messageRole === "user" && (msg.messageIntent === "question" || msg.messageIntent === "clarification")) {
      const subsequentAgentReply = recentMessages.slice(i + 1).some(m => m.messageRole === "agent");
      if (!subsequentAgentReply) {
        openPoints.push({
          type: "unanswered_question",
          label: "Offene Frage ohne Agentenantwort",
          messageId: msg.messageId,
        });
      }
    }
  }
  
  // Check for pending decisions
  if (session.conferenceMode === "decision_mode") {
    const recentTexts = recentMessages.map(m => (m.content || "").toLowerCase()).join(" ");
    if (recentTexts.includes("entscheidung") || recentTexts.includes("option")) {
      const hasResolution = recentTexts.includes("entschieden") || recentTexts.includes("gewählt") || recentTexts.includes("beschlossen");
      if (!hasResolution) {
        openPoints.push({
          type: "pending_decision",
          label: "Ausstehende Entscheidung im Entscheidungsmodus",
        });
      }
    }
  }
  
  // Check for scope gaps
  const allTexts = recentMessages.map(m => (m.content || "").toLowerCase()).join(" ");
  if (allTexts.includes("fehlt noch") || allTexts.includes("nicht geklärt") || allTexts.includes("offen bleibt")) {
    openPoints.push({
      type: "missing_scope_point",
      label: "Fehlender Scope-Punkt oder offene Klärung erkannt",
    });
  }
  
  // Check for near-ready decisions
  if (session.currentPhaseStatus === "recommendation_ready" || session.currentPhaseStatus === "cause_identified") {
    const hasUserConfirmation = recentMessages.some(m => m.messageRole === "user" && 
      (m.content || "").toLowerCase().match(/(ok|ja|passt|einverstanden|machen wir)/));
    if (!hasUserConfirmation) {
      openPoints.push({
        type: "awaiting_user_confirmation",
        label: "Empfehlung/Erkenntnis liegt vor – User-Bestätigung ausstehend",
      });
    }
  }
  
  return openPoints;
}

/**
 * Assess whether clarification should be requested instead of expanding.
 * @private
 */
function _assessClarificationNeed(userMessage, session) {
  const lowerMsg = (userMessage || "").toLowerCase();
  
  // Vague or very short messages in a complex context
  if (lowerMsg.length < 15 && session.messageCount > 5) {
    return { needsClarification: true, reason: "Sehr kurze Nachricht in fortgeschrittener Konferenz – Rückfrage sinnvoller als Ausweitung" };
  }
  
  // Multiple topics in one message
  const multiTopicCount = CONFERENCE_TOPIC_SPLITTERS.filter(s => lowerMsg.includes(s)).length;
  if (multiTopicCount >= 2) {
    return { needsClarification: true, reason: "Mehrere Themen in einer Nachricht – Priorisierung klären" };
  }
  
  // Contradictory signals
  if (lowerMsg.includes("aber") && lowerMsg.includes("oder") && lowerMsg.length > 50) {
    return { needsClarification: true, reason: "Widersprüchliche Signale erkannt – Rückfrage bevorzugt" };
  }
  
  return { needsClarification: false, reason: null };
}

/**
 * Build a phase digest (Ergebnisverdichtung) for the current or most recent phase.
 * @private
 */
function _buildPhaseDigest(session) {
  const messages = session.messages;
  if (messages.length === 0) return null;
  
  const recentMessages = messages.slice(-15);
  const dsMessages = recentMessages.filter(m => m.speakerAgent === "deepseek" && m.messageRole === "agent");
  const gmMessages = recentMessages.filter(m => m.speakerAgent === "gemini" && m.messageRole === "agent");
  
  // What was understood
  let understood = "Noch keine klare Einordnung.";
  if (dsMessages.length > 0 && gmMessages.length > 0) {
    understood = "Beide Agenten haben Beiträge geliefert. Backend- und Frontend-Sicht liegen vor.";
  } else if (dsMessages.length > 0) {
    understood = "DeepSeek hat eine Backend-Einordnung geliefert.";
  } else if (gmMessages.length > 0) {
    understood = "Gemini hat eine Frontend-/UX-Einordnung geliefert.";
  }
  
  // Where is this heading
  const phaseStatusLabels = {
    phase_open: "Die Diskussion ist offen – noch keine klare Richtung.",
    problem_scoped: "Das Problem wurde eingegrenzt.",
    cause_identified: "Eine Ursache wurde identifiziert.",
    recommendation_ready: "Eine Empfehlung liegt vor.",
    decision_pending: "Eine Entscheidung steht an.",
    clarification_open: "Eine Klärung ist offen.",
    phase_concluded: "Die Phase ist abgeschlossen.",
  };
  const direction = phaseStatusLabels[session.currentPhaseStatus] || "Kein klarer Phasenstatus.";
  
  // Differences remaining
  let differences = "Keine erkennbaren Unterschiede.";
  if (dsMessages.length > 0 && gmMessages.length > 0) {
    const dsLast = (dsMessages[dsMessages.length - 1].content || "").substring(0, 100);
    const gmLast = (gmMessages[gmMessages.length - 1].content || "").substring(0, 100);
    if (dsLast !== gmLast) {
      differences = "Die Agenten haben unterschiedliche Schwerpunkte gesetzt – Backend vs. Frontend/UX.";
    }
  }
  
  // Decision pending
  const decisionPending = session.currentPhaseStatus === "decision_pending" || 
    session.currentPhaseStatus === "recommendation_ready";
  
  // Next controlled step
  let nextStep = "Das Thema weiter vertiefen oder den Fokus eingrenzen.";
  if (session.currentPhaseStatus === "recommendation_ready") {
    nextStep = "Empfehlung prüfen und bestätigen oder anpassen.";
  } else if (session.currentPhaseStatus === "decision_pending") {
    nextStep = "Entscheidung treffen oder weiteren Input einholen.";
  } else if (session.currentPhaseStatus === "clarification_open") {
    nextStep = "Offene Klärung beantworten, bevor weitergearbeitet wird.";
  } else if (session.currentPhaseStatus === "cause_identified") {
    nextStep = "Ursache bestätigen und nächsten Lösungsschritt planen.";
  } else if (session.currentPhaseStatus === "phase_concluded") {
    nextStep = "Neues Thema starten oder Konferenz abschließen.";
  }
  
  const openPoints = _deriveConferenceOpenPoints(session);
  
  const digest = {
    conferenceId: session.conferenceId,
    phaseStatus: session.currentPhaseStatus,
    understood,
    direction,
    differences,
    decisionPending,
    openPoints: openPoints.map(p => p.label),
    openPointCount: openPoints.length,
    nextStep,
    leadAgent: session.leadAgent,
    supportAgent: session.supportAgent,
    currentReplyPattern: session.currentReplyPattern,
    coordinationState: session.coordinationState,
    messageCount: session.messageCount,
    generatedAt: new Date().toISOString(),
  };
  
  // Cache on session
  session.phaseDigest = digest;
  
  return digest;
}

/**
 * Generate a quiet, value-adding coordinator message.
 * Not log-spam – real moderation hints.
 * @private
 */
function _generateCoordinatorMessage(type, session, context = {}) {
  const templates = {
    lead_assigned: `Koordination: ${context.leadAgent === "deepseek" ? "DeepSeek (Backend)" : "Gemini (Frontend/UX)"} führt diesen Punkt.`,
    supplement_added: `Koordination: ${context.supportAgent === "deepseek" ? "DeepSeek" : "Gemini"} ergänzt gezielt.`,
    reply_bundled: "Koordination: Die Antworten beider Agenten wurden gebündelt zusammengeführt.",
    clarification_needed: "Koordination: Rückfrage empfohlen – eine Klärung wäre hilfreicher als weitere Ausweitung.",
    point_concluded: "Koordination: Dieser Punkt ist abgeschlossen. Zusammenfassung wurde erstellt.",
    phase_summary: "Koordination: Eine Phasenzusammenfassung ist verfügbar.",
    next_step_suggested: `Koordination: Nächster Schritt – ${context.nextStep || "weiteres Thema vertiefen oder Fokus eingrenzen"}.`,
    leadership_changed: `Koordination: Führungswechsel – ${context.newLead === "deepseek" ? "DeepSeek" : "Gemini"} übernimmt.`,
  };
  
  return templates[type] || "Koordination: Moderationshinweis.";
}

/**
 * Record a coordinator message in the session.
 * @private
 */
function _recordCoordinatorMessage(session, type, context = {}) {
  _conferenceMsgCounter += 1;
  const msgId = `cfm-${Date.now()}-${_conferenceMsgCounter}`;
  const now = new Date().toISOString();
  const content = _generateCoordinatorMessage(type, session, context);
  
  const record = {
    messageId: msgId,
    conferenceId: session.conferenceId,
    messageRole: "coordinator",
    speakerAgent: "system",
    speakerRole: "coordinator",
    coordinatorMessageType: type,
    content,
    conferenceMode: session.conferenceMode,
    replyPattern: session.currentReplyPattern,
    coordinationState: session.coordinationState,
    createdAt: now,
  };
  
  session.messages.push(record);
  session.messageCount += 1;
  session.systemMessageCount += 1;
  session.lastCoordinatorMessage = record;
  session.lastActivity = now;
  
  return record;
}

/**
 * Generate a supporting/supplemental reply for the support agent.
 * Different from the lead reply – shorter, targeted, complementary.
 * @private
 */
function _generateSupportingReply(supportAgent, leadAgent, messageIntent, userMessage, session) {
  const isBackend = supportAgent === "deepseek";
  const perspective = isBackend ? "Backend-Ergänzung" : "Frontend-/UX-Ergänzung";
  const leadPerspective = leadAgent === "deepseek" ? "Backend-Sicht" : "Frontend-/UX-Sicht";
  const focus = session.conferenceFocus || "das aktuelle Thema";
  
  const replies = {
    question: [
      `${perspective}: Zum Punkt von ${leadPerspective} ergänze ich, dass ${focus} auch aus meiner Sicht relevant ist.`,
      `Kurze Ergänzung aus ${perspective}: Dieser Aspekt berührt auch meinen Bereich.`,
    ],
    clarification: [
      `${perspective}: Ich stütze die Einordnung und füge einen Aspekt hinzu.`,
    ],
    diagnosis_request: [
      `${perspective}: Aus meinem Bereich sehe ich einen zusätzlichen Hinweis zu ${focus}.`,
    ],
    recommendation: [
      `${perspective}: Zur Empfehlung ergänze ich einen weiteren Gesichtspunkt.`,
    ],
    freeform: [
      `Ergänzung aus ${perspective}: Zum letzten Punkt von ${leadPerspective}.`,
      `${perspective}: Kurze Ergänzung – aus meiner Domäne heraus.`,
    ],
  };
  
  const candidates = replies[messageIntent] || replies.freeform;
  const idx = (session.messageCount || 0) % candidates.length;
  return candidates[idx];
}

/**
 * Generate a bundled/coordinated reply combining both agent perspectives.
 * @private
 */
function _generateBundledReply(messageIntent, userMessage, session) {
  const focus = session.conferenceFocus || "das aktuelle Thema";
  const modeLabel = {
    work_chat: "Arbeitschat",
    problem_solving: "Problemlösung",
    decision_mode: "Entscheidungsmodus",
  }[session.conferenceMode] || "Arbeitschat";
  
  const replies = {
    question: [
      `Gebündelte Antwort (${modeLabel}): Zu ${focus} – aus Backend-Sicht ist der technische Zustand relevant, aus Frontend-/UX-Sicht die Darstellung. Beide Aspekte wurden berücksichtigt.`,
    ],
    clarification: [
      `Gebündelte Einordnung: Backend und Frontend haben ihre Sicht zusammengeführt. ${focus} ist klarer eingegrenzt.`,
    ],
    diagnosis_request: [
      `Koordinierte Diagnose: Die Backend-Analyse und Frontend-Prüfung wurden zusammengeführt. Fokus: ${focus}.`,
    ],
    recommendation: [
      `Gebündelte Empfehlung (${modeLabel}): Backend und Frontend empfehlen gemeinsam den nächsten Schritt zu ${focus}.`,
    ],
    freeform: [
      `Zusammengeführte Antwort: Backend und Frontend haben zu ${focus} beigetragen. Die Einordnung wurde gebündelt.`,
      `Koordinierte Antwort (${modeLabel}): Beide Perspektiven zu ${focus} wurden berücksichtigt.`,
    ],
  };
  
  const candidates = replies[messageIntent] || replies.freeform;
  const idx = (session.messageCount || 0) % candidates.length;
  return candidates[idx];
}

/**
 * Generate a clarification request instead of expanding.
 * @private
 */
function _generateClarificationReply(session, clarificationContext = {}) {
  const focus = session.conferenceFocus || "das aktuelle Thema";
  const reason = clarificationContext.reason || "Rückfrage vor weiterer Ausweitung empfohlen";
  
  return `Rückfrage an den Nutzer: Bevor wir bei ${focus} weitermachen – ${reason}. Bitte kurz klären, damit die Konferenz gezielt weiterarbeiten kann.`;
}

/**
 * Send a coordinated conference message – Step B enhanced version.
 * Handles reply patterns, coordination state, lead/support agents,
 * phase tracking, and coordinator messages.
 * @param {Object} params
 * @returns {Object}
 */
async function sendCoordinatedConferenceMessage({
  conferenceId,
  userMessage,
  targetAgent = null,
  replyToMessageId = null,
  requestedReplyPattern = null,
} = {}) {
  if (!conferenceId) {
    logger.warn("[agentBridge] Konferenz Step B – sendCoordinatedConferenceMessage ohne conferenceId");
    return { success: false, error: "conferenceId is required" };
  }
  if (!userMessage || typeof userMessage !== "string" || userMessage.trim().length === 0) {
    logger.warn("[agentBridge] Konferenz Step B – sendCoordinatedConferenceMessage ohne userMessage");
    return { success: false, error: "userMessage is required and must be a non-empty string" };
  }

  const session = _conferenceSessions.get(conferenceId);
  if (!session) {
    return { success: false, error: "Conference session not found" };
  }

  if (session.conferenceStatus === "session_closed" || session.conferenceStatus === "session_archived") {
    return { success: false, error: "Conference session is closed or archived" };
  }

  // Ensure session is active
  if (session.conferenceStatus === "session_paused") {
    session.conferenceStatus = "session_active";
    session.statusHistory.push({ status: "session_active", changedAt: new Date().toISOString() });
  }

  // Resolve target agent (reuse Step A logic)
  const resolvedTarget = _resolveConferenceTarget(targetAgent, userMessage, session);
  const messageIntent = _deriveMessageIntent(userMessage);
  const now = new Date().toISOString();

  // Step B: Derive lead agent
  const previousLead = session.leadAgent;
  const newLead = _deriveLeadAgent(userMessage, session);
  const leadChanged = previousLead && previousLead !== newLead;
  session.leadAgent = newLead;
  session.supportAgent = newLead === "deepseek" ? "gemini" : "deepseek";

  // Step B: Assess clarification need
  const clarificationAssessment = _assessClarificationNeed(userMessage, session);
  
  // Step B: Determine reply pattern
  let replyPattern = requestedReplyPattern && VALID_CONFERENCE_REPLY_PATTERNS.includes(requestedReplyPattern)
    ? requestedReplyPattern
    : _assessReplyPattern(userMessage, session, resolvedTarget.target);
  
  // Override with clarification if assessed
  if (clarificationAssessment.needsClarification && replyPattern !== "phase_closed") {
    replyPattern = "needs_user_clarification";
  }

  // Step B: Update coordination state
  session.currentReplyPattern = replyPattern;
  session.coordinationState = _deriveCoordinationState(session, replyPattern);

  // Step B: Update phase status
  session.currentPhaseStatus = _derivePhaseStatus(session);

  // Record user message (same as Step A)
  _conferenceMsgCounter += 1;
  const userMsgId = `cfm-${Date.now()}-${_conferenceMsgCounter}`;

  const userMsgRecord = {
    messageId: userMsgId,
    conferenceId,
    messageRole: "user",
    speakerAgent: "user",
    messageIntent,
    targetAgent: resolvedTarget.target,
    content: userMessage.trim(),
    replyToMessageId: replyToMessageId || null,
    conferenceMode: session.conferenceMode,
    replyPattern,
    createdAt: now,
  };

  session.messages.push(userMsgRecord);
  session.messageCount += 1;
  session.userMessageCount += 1;
  session.lastSpeaker = "user";
  session.lastActivity = now;

  // Trim messages if over limit
  if (session.messages.length > CONFERENCE_SESSION_MAX_MESSAGES) {
    session.messages = session.messages.slice(-CONFERENCE_SESSION_MAX_MESSAGES);
  }

  // Generate replies based on reply pattern
  const agentReplies = [];
  const coordinatorMessages = [];

  switch (replyPattern) {
    case "solo_reply": {
      const agent = resolvedTarget.target === "both" ? session.leadAgent : resolvedTarget.target;
      const reply = await _generateConferenceReply(agent, messageIntent, userMessage, session);
      agentReplies.push(_recordConferenceAgentReply(session, agent, reply.text, userMsgId, null, {
        usedFallback: reply.usedFallback, apiError: reply.apiError,
      }));
      session.soloReplyCount += 1;
      break;
    }

    case "supporting_reply": {
      // Lead answers first via real API, then support agent adds a real supplementary reply
      const leadReply = await _generateConferenceReply(session.leadAgent, messageIntent, userMessage, session);
      agentReplies.push(_recordConferenceAgentReply(session, session.leadAgent, leadReply.text, userMsgId, null, {
        usedFallback: leadReply.usedFallback, apiError: leadReply.apiError,
      }));

      // Support agent gets the lead's reply as context so it can genuinely supplement
      const supportReply = await _generateConferenceReply(
        session.supportAgent,
        messageIntent,
        userMessage,
        session,
        { primaryAgentReply: leadReply.text }
      );
      agentReplies.push(_recordConferenceAgentReply(session, session.supportAgent, supportReply.text, userMsgId, null, {
        usedFallback: supportReply.usedFallback, apiError: supportReply.apiError,
      }));

      coordinatorMessages.push(_recordCoordinatorMessage(session, "supplement_added", { supportAgent: session.supportAgent }));
      session.supportingReplyCount += 1;
      break;
    }

    case "coordinated_reply": {
      // Both agents contribute
      const dsReply = await _generateConferenceReply("deepseek", messageIntent, userMessage, session);
      const gmReply = await _generateConferenceReply("gemini", messageIntent, userMessage, session, { deepseekReply: dsReply.text });
      agentReplies.push(_recordConferenceAgentReply(session, "deepseek", dsReply.text, userMsgId, null, {
        usedFallback: dsReply.usedFallback, apiError: dsReply.apiError,
      }));
      agentReplies.push(_recordConferenceAgentReply(session, "gemini", gmReply.text, userMsgId, null, {
        usedFallback: gmReply.usedFallback, apiError: gmReply.apiError,
      }));
      session.coordinatedReplyCount += 1;
      break;
    }

    case "bundled_reply": {
      // Both agents contribute; their replies are stored individually and summarised
      const dsBundle = await _generateConferenceReply("deepseek", messageIntent, userMessage, session);
      const gmBundle = await _generateConferenceReply("gemini", messageIntent, userMessage, session, { primaryAgentReply: dsBundle.text });
      const bundledText = `[Backend] ${dsBundle.text}\n\n[Frontend] ${gmBundle.text}`;
      agentReplies.push(_recordConferenceAgentReply(session, "system", bundledText, userMsgId, null, {
        usedFallback: dsBundle.usedFallback || gmBundle.usedFallback,
        apiError: dsBundle.apiError || gmBundle.apiError || null,
      }));
      coordinatorMessages.push(_recordCoordinatorMessage(session, "reply_bundled", {}));
      session.bundledReplyCount += 1;
      break;
    }

    case "needs_user_clarification": {
      // Clarification request instead of expanding
      const clarReply = _generateClarificationReply(session, clarificationAssessment);
      agentReplies.push(_recordConferenceAgentReply(session, "system", clarReply, userMsgId));
      coordinatorMessages.push(_recordCoordinatorMessage(session, "clarification_needed", {}));
      session.clarificationRequestCount += 1;
      break;
    }

    case "cross_agent_followup": {
      // One agent follows up on the other's point
      const agent = resolvedTarget.target === "both" ? session.leadAgent : resolvedTarget.target;
      const reply = await _generateConferenceReply(agent, messageIntent, userMessage, session);
      agentReplies.push(_recordConferenceAgentReply(session, agent, reply.text, userMsgId, null, {
        usedFallback: reply.usedFallback, apiError: reply.apiError,
      }));
      session.soloReplyCount += 1;
      break;
    }

    case "phase_closed": {
      coordinatorMessages.push(_recordCoordinatorMessage(session, "point_concluded", {}));
      session.phasesClosedCount += 1;
      break;
    }

    default: {
      // Fallback to solo reply
      const fallbackAgent = resolvedTarget.target === "both" ? session.leadAgent : (resolvedTarget.target || "deepseek");
      const reply = await _generateConferenceReply(fallbackAgent, messageIntent, userMessage, session);
      agentReplies.push(_recordConferenceAgentReply(session, fallbackAgent, reply.text, userMsgId, null, {
        usedFallback: reply.usedFallback, apiError: reply.apiError,
      }));
      session.soloReplyCount += 1;
    }
  }

  // Leadership change coordinator message
  if (leadChanged) {
    coordinatorMessages.push(_recordCoordinatorMessage(session, "leadership_changed", { newLead: newLead }));
    session.leadershipChangeCount += 1;
  } else if (replyPattern === "supporting_reply" || replyPattern === "coordinated_reply") {
    coordinatorMessages.push(_recordCoordinatorMessage(session, "lead_assigned", { leadAgent: session.leadAgent }));
  }

  // Assess phase closure
  const closureAssessment = _assessPhaseClosure(session);
  if (closureAssessment.shouldClose && session.currentPhaseStatus !== "phase_concluded") {
    session.currentPhaseStatus = "phase_concluded";
    session.coordinationState = "phase_closed";
    session.phasesClosedCount += 1;
    session.phaseCount += 1;
    
    const digest = _buildPhaseDigest(session);
    session.phases.push({
      phaseNumber: session.phaseCount,
      phaseStatus: "phase_concluded",
      closureReason: closureAssessment.reason,
      digest,
      closedAt: now,
    });
    
    coordinatorMessages.push(_recordCoordinatorMessage(session, "point_concluded", {}));
    coordinatorMessages.push(_recordCoordinatorMessage(session, "phase_summary", {}));
  }

  // Update open points
  session.openPoints = _deriveConferenceOpenPoints(session);

  session.lastTargetAgent = resolvedTarget.target;
  session.updatedAt = now;

  // Konferenz Step C: update phases, decision room, result cards
  _updateConferenceStepC(session);

  logger.info("[agentBridge] Konferenz Step B – Koordinierte Nachricht verarbeitet", {
    conferenceId,
    replyPattern,
    coordinationState: session.coordinationState,
    leadAgent: session.leadAgent,
    supportAgent: session.supportAgent,
    phaseStatus: session.currentPhaseStatus,
    agentReplyCount: agentReplies.length,
    coordinatorMessageCount: coordinatorMessages.length,
  });

  return {
    success: true,
    conferenceId,
    conferenceStatus: session.conferenceStatus,
    conferenceMode: session.conferenceMode,
    userMessage: userMsgRecord,
    agentReplies,
    coordinatorMessages,
    coordination: {
      replyPattern,
      coordinationState: session.coordinationState,
      leadAgent: session.leadAgent,
      supportAgent: session.supportAgent,
      phaseStatus: session.currentPhaseStatus,
      openPointCount: session.openPoints.length,
    },
    routing: {
      targetAgent: resolvedTarget.target,
      routingReason: resolvedTarget.routingReason,
    },
    messageCount: session.messageCount,
    // Konferenz Step C: expose current phase and moderation signal
    workPhase: session.workPhase,
    moderationSignal: session.moderationSignal,
    handoffDirection: session.handoffDirection,
  };
}

/**
 * Get a coordination summary across all conference sessions.
 * Admin/operator-suitable – counts, distributions, highlights.
 * @returns {Object}
 */
function getConferenceCoordinationSummary() {
  const sessions = Array.from(_conferenceSessions.values());
  const total = sessions.length;

  const byCoordinationState = {};
  const byReplyPattern = {};
  const byPhaseStatus = {};
  let totalCoordinatedReplies = 0;
  let totalSoloReplies = 0;
  let totalSupportingReplies = 0;
  let totalBundledReplies = 0;
  let totalClarificationRequests = 0;
  let totalLeadershipChanges = 0;
  let totalPhasesClosed = 0;
  let sessionsWithOpenPoints = 0;

  for (const s of sessions) {
    byCoordinationState[s.coordinationState || "uncoordinated"] = (byCoordinationState[s.coordinationState || "uncoordinated"] || 0) + 1;
    byReplyPattern[s.currentReplyPattern || "solo_reply"] = (byReplyPattern[s.currentReplyPattern || "solo_reply"] || 0) + 1;
    byPhaseStatus[s.currentPhaseStatus || "phase_open"] = (byPhaseStatus[s.currentPhaseStatus || "phase_open"] || 0) + 1;
    totalCoordinatedReplies += s.coordinatedReplyCount || 0;
    totalSoloReplies += s.soloReplyCount || 0;
    totalSupportingReplies += s.supportingReplyCount || 0;
    totalBundledReplies += s.bundledReplyCount || 0;
    totalClarificationRequests += s.clarificationRequestCount || 0;
    totalLeadershipChanges += s.leadershipChangeCount || 0;
    totalPhasesClosed += s.phasesClosedCount || 0;
    if ((s.openPoints || []).length > 0) sessionsWithOpenPoints += 1;
  }

  return {
    totalSessions: total,
    byCoordinationState,
    byReplyPattern,
    byPhaseStatus,
    replyStats: {
      totalCoordinatedReplies,
      totalSoloReplies,
      totalSupportingReplies,
      totalBundledReplies,
      totalClarificationRequests,
    },
    coordinationStats: {
      totalLeadershipChanges,
      totalPhasesClosed,
      sessionsWithOpenPoints,
    },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Get the phase digest for a specific conference session.
 * Human-readable Ergebnisverdichtung.
 * @param {Object} params
 * @returns {Object|null}
 */
function getConferencePhaseDigest({ conferenceId } = {}) {
  if (!conferenceId) return null;
  const session = _conferenceSessions.get(conferenceId);
  if (!session) return null;
  return _buildPhaseDigest(session);
}

module.exports = {
  buildBridgePackage,
  getCurrentBridgePackage,
  receiveFrontendFeedback,
  getPendingFrontendFeedback,
  getPatternMemorySummary,
  getActionReadinessSummary,
  // Step 7: Recommendation Feedback / Improvement Loop Light
  submitRecommendationFeedback,
  getRecommendationImprovementSummary,
  // Step 8: Governance Policy / Visibility Light
  getGovernancePolicySummary,
  // Step 10: Issue Intelligence / Error Detection Light
  getIssueIntelligenceSummary,
  // Step 11: Case / Resolution / Operator Loop Light
  updateCaseStatus,
  getCaseResolutionSummary,
  // Step 12: Attention / Priority / Operator Focus Light
  getAttentionPrioritySummary,
  // Step 13: Decision Maturity / Resolution Confidence Light
  classifyDecisionMaturity,
  getDecisionMaturitySummary,
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
  VALID_RECOMMENDATION_FEEDBACK_CATEGORIES,
  VALID_IMPROVEMENT_SIGNALS,
  VALID_GOVERNANCE_POLICY_CLASSES,
  VALID_ISSUE_TYPES,
  VALID_ISSUE_CATEGORIES,
  VALID_ISSUE_LAYERS,
  VALID_ISSUE_SEVERITY_LEVELS,
  VALID_ISSUE_CAUSES,
  VALID_ISSUE_SUGGESTED_FIXES,
  VALID_CASE_STATUSES,
  VALID_CASE_OUTCOMES,
  VALID_HELPFULNESS_BANDS,
  VALID_ATTENTION_BANDS,
  VALID_DECISION_MATURITY_BANDS,
  // Step 14: Agent Problem Detection / Solution Proposal / Approval Chat Foundation
  buildAgentCaseFromBridgePackage,
  submitAgentCaseFeedback,
  getAgentCaseSummary,
  getAgentChatMessages,
  VALID_AGENT_ROLES,
  VALID_AGENT_PROBLEM_TYPES,
  VALID_AGENT_MESSAGE_TYPES,
  VALID_AGENT_MESSAGE_INTENTS,
  VALID_APPROVAL_SCOPES,
  VALID_PREPARATION_TYPES,
  VALID_AGENT_FEEDBACK_TYPES,
  // Step 15: Agent Approval / Plan Refinement / Controlled Preparation
  getRefinedPlanSummary,
  VALID_PLAN_PHASES,
  VALID_CONTROLLED_PREPARATION_TYPES,
  VALID_APPROVAL_DECISION_STAGES,
  // Step 16: Controlled Action Draft / Fix Bundle Preparation
  getActionDraftSummary,
  VALID_DRAFT_TYPES,
  VALID_CHANGE_CATEGORIES,
  VALID_DRAFT_STATUSES,
  // Step 17: Controlled Execution Proposal / Apply-Readiness / Final Approval Layer
  getApplyReadinessSummary,
  VALID_READINESS_BANDS,
  VALID_APPLY_MODES,
  VALID_BLOCKING_FACTOR_TYPES,
  VALID_RISK_FLAG_TYPES,
  // Step 18: Controlled Apply Simulation / Execution Preview / Reversal Safety
  getExecutionPreviewSummary,
  VALID_PREVIEW_STATES,
  VALID_SAFETY_BANDS,
  VALID_REVERSAL_COMPLEXITY,
  VALID_APPLY_WINDOWS,
  // Step 19: Controlled Apply Candidate / Action Package / Approval Gate
  getApplyCandidateSummary,
  VALID_CANDIDATE_STATUSES,
  VALID_CANDIDATE_MODES,
  VALID_SCOPE_GUARDRAIL_TYPES,
  // Step 20: Controlled Execution Orchestrator / Apply Runtime / Audit & Kill Switch
  getExecutionRuntimeSummary,
  VALID_RUNTIME_STATUSES,
  VALID_RUNTIME_MODES,
  VALID_EXECUTION_STATES,
  VALID_EXECUTION_GUARDRAIL_TYPES,
  // Step 21: Agent Conversation Runtime / Persistent Case Chat / Freeform Admin Dialogue
  sendUserMessage,
  getConversationThread,
  getConversationSummary,
  getOrCreateConversationThread,
  VALID_THREAD_STATUSES,
  VALID_SPEAKER_AGENTS,
  VALID_SPEAKER_ROLES,
  VALID_CONVERSATION_INTENTS,
  VALID_CONVERSATION_PHASES,
  // Step 22: Multi-Agent Handoff / Cross-Agent Dialogue / Coordinated Case Exchange Light
  triggerHandoff,
  getHandoffSummary,
  VALID_HANDOFF_STATUSES,
  VALID_CROSS_AGENT_STATES,
  VALID_HANDOFF_REASONS,
  VALID_HANDOFF_MESSAGE_TYPES,
  // Step 23: Conversation Memory / Case Continuity / Agent Memory Anchors
  getCaseMemory,
  getCaseMemorySummary,
  VALID_CONTINUITY_STATUSES,
  VALID_MEMORY_FRESHNESS,
  VALID_MEMORY_ANCHOR_TYPES,
  // Step 24: Action Negotiation / Option Comparison / Decision Framing
  getDecisionFrame,
  getDecisionFrameSummary,
  VALID_DECISION_FRAME_STATUSES,
  VALID_OPTION_STATUSES,
  VALID_COMPARISON_DIMENSIONS,
  VALID_DIMENSION_RATINGS,
  VALID_DECISION_MODES,
  VALID_OPTION_OWNER_TYPES,
  // Konferenz Step A: DeepSeek ↔ Gemini – Conference Session / Targeting / Mode / Summary
  openConferenceSession,
  sendConferenceMessage,
  updateConferenceSession,
  closeConferenceSession,
  getConferenceSession,
  getConferenceSummary,
  getConferenceWorkspace,
  getConferenceAdminSummary,
  VALID_CONFERENCE_SESSION_STATUSES,
  VALID_CONFERENCE_MODES,
  VALID_CONFERENCE_TARGET_AGENTS,
  // Konferenz Step B: Coordination / Moderation / Coordinated Reply Flow
  sendCoordinatedConferenceMessage,
  getConferenceCoordinationSummary,
  getConferencePhaseDigest,
  VALID_CONFERENCE_REPLY_PATTERNS,
  VALID_CONFERENCE_COORDINATION_STATES,
  VALID_CONFERENCE_PHASE_STATUSES,
  VALID_COORDINATOR_MESSAGE_TYPES,
  // Konferenz Step C: Conference Phases / Decision Room / Result Cards / Strategic Expansion
  advanceConferencePhase,
  getConferenceResultCard,
  getConferenceDecisionRoom,
  getConferencePerspectiveComparison,
  getConferenceStepCSummary,
  VALID_CONFERENCE_WORK_PHASES,
  VALID_CONFERENCE_DECISION_ROOM_STATES,
  VALID_CONFERENCE_CONSENSUS_STATES,
  VALID_CONFERENCE_HANDOFF_DIRECTIONS,
  VALID_CONFERENCE_MODERATION_SIGNALS,
  // Konferenz Step D: Live Dialog / User Message Handling / Agent Reply Routing / Dialogue Reliability
  getConferenceDialogState,
  VALID_CONFERENCE_RESPONSE_TYPES,
  VALID_CONFERENCE_DIALOG_STATES,
  // Konferenz Step E: Companion Multi-Agent Both-Mode Backend – Dual Reply Routing
  VALID_BOTH_MODE_COOPERATION_TYPES,
  VALID_BOTH_MODE_SEQUENCES,
  BOTH_MODE_DETECTION_PHRASES,
};
