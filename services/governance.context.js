"use strict";

/* =========================================================
   STEP 8 BLOCK 1: IDENTITY-, ROLLEN- & GOVERNANCE-BASIS

   Central governance classification module.
   Derives actor-role, governance-role, tenant-scope,
   separation-of-duties constraints, and policy/audit
   permissions from existing system context.

   Design principles:
   - NO full IAM / SSO / SCIM integration
   - Defensive safe defaults when identity data is absent
   - Through-pass compatible: downstream layers can consume
     governance context without breaking if it is null
   - Role definitions enforce Separation of Duties:
       Policy Admin ≠ Operator ≠ Auditor
   - No role carries contradictory core permissions
   - Tenant scope prepared but defaults to "platform"
     until external IAM provides real tenant identity

   Upstream consumers:
   - opportunityScanner → attaches governanceContext per opp
   - admin.routes → exposes governance summary in review-queue
   - frontendAdapter → passes governance meta to UI layer
   - guardianService → adds governance context to AI prompt
   - dailyBriefing / discoveryNotify → governance-aware labels
========================================================= */

// ── Actor-Role Definitions ─────────────────────────────────────────────────
// Each role has a clearly bounded set of permissions.
// Separation-of-Duties: no role combines policy mutation + approval action.
// Policy read (audit) may coexist with policy mutation (admin) since
// reading policies does not create an operational conflict.
const ACTOR_ROLES = {
  platform_admin: {
    label: "Platform Admin",
    policyMutationAllowed: true,
    approvalActionAllowed: false,
    auditReadAllowed: true,
    governanceRole: "policy_admin",
    separationOfDutiesFlag: true,
    description: "Manages platform policies and configuration. Cannot approve operational actions.",
  },
  operator: {
    label: "Operator",
    policyMutationAllowed: false,
    approvalActionAllowed: true,
    auditReadAllowed: false,
    governanceRole: "operator",
    separationOfDutiesFlag: true,
    description: "Executes approved actions and reviews proposals. Cannot mutate policies or read full audit.",
  },
  auditor: {
    label: "Auditor",
    policyMutationAllowed: false,
    approvalActionAllowed: false,
    auditReadAllowed: true,
    governanceRole: "auditor",
    separationOfDutiesFlag: true,
    description: "Read-only governance and audit access. Cannot approve or mutate.",
  },
  viewer: {
    label: "Viewer",
    policyMutationAllowed: false,
    approvalActionAllowed: false,
    auditReadAllowed: false,
    governanceRole: "viewer",
    separationOfDutiesFlag: false,
    description: "Read-only signal/portfolio access. No governance permissions.",
  },
};

// Safe default when no identity context is available
const DEFAULT_ACTOR_ROLE = "viewer";
const DEFAULT_TENANT_SCOPE = "platform";

/**
 * Resolve the actor role from the available context.
 * Currently uses defensive defaults since no external IAM is integrated.
 * When IAM/SSO is connected, this function will resolve from token claims.
 *
 * @param {object} [ctx] - Optional context with identity hints
 * @param {string} [ctx.actorRole] - Explicit role override (e.g. from request header or token)
 * @param {boolean} [ctx.isAdminRoute] - Whether the request originates from an admin route
 * @returns {string} Resolved actor role key
 */
function resolveActorRole(ctx) {
  // 1. Explicit role from upstream identity (future IAM integration point)
  if (ctx?.actorRole && ACTOR_ROLES[ctx.actorRole]) {
    return ctx.actorRole;
  }
  // 2. Admin-route heuristic: admin callers get operator role (can review/approve, not mutate policy)
  if (ctx?.isAdminRoute) {
    return "operator";
  }
  // 3. Safe default: viewer (read-only, no governance permissions)
  return DEFAULT_ACTOR_ROLE;
}

/**
 * Resolve the tenant scope from the available context.
 * Defaults to "platform" (single-tenant) until external IAM provides real tenant identity.
 *
 * @param {object} [ctx] - Optional context with tenant hints
 * @param {string} [ctx.tenantScope] - Explicit tenant scope from token/header
 * @param {number} [ctx.userId] - User ID for future per-tenant resolution
 * @returns {string} Resolved tenant scope
 */
function resolveTenantScope(ctx) {
  if (ctx?.tenantScope && typeof ctx.tenantScope === "string") {
    return ctx.tenantScope;
  }
  return DEFAULT_TENANT_SCOPE;
}

/**
 * Compute the full governance context for a given actor/request context.
 * This is the central function consumed by all downstream layers.
 *
 * Returns a compact governance descriptor that can be attached to
 * opportunities, admin responses, frontend payloads, and AI prompts.
 *
 * @param {object} [ctx] - Request/actor context
 * @param {string} [ctx.actorRole] - Explicit actor role
 * @param {boolean} [ctx.isAdminRoute] - Admin-route flag
 * @param {string} [ctx.tenantScope] - Explicit tenant scope
 * @param {number} [ctx.userId] - User ID
 * @returns {object} Governance context descriptor
 */
function computeGovernanceContext(ctx) {
  const actorRoleKey = resolveActorRole(ctx);
  const roleDef = ACTOR_ROLES[actorRoleKey] || ACTOR_ROLES[DEFAULT_ACTOR_ROLE];
  const tenantScope = resolveTenantScope(ctx);

  return {
    actorRole: actorRoleKey,
    actorLabel: roleDef.label,
    governanceRole: roleDef.governanceRole,
    tenantScope,
    separationOfDutiesFlag: roleDef.separationOfDutiesFlag,
    policyMutationAllowed: roleDef.policyMutationAllowed,
    approvalActionAllowed: roleDef.approvalActionAllowed,
    auditReadAllowed: roleDef.auditReadAllowed,
    governanceBasis: "step8_block1",
    identitySource: ctx?.actorRole ? "explicit" : "safe_default",
  };
}

/**
 * Derive a per-opportunity governance classification.
 * Augments the existing audit/trace/safety layer with actor-aware
 * governance context so downstream consumers know which governance
 * rules apply to this specific opportunity in the current actor context.
 *
 * @param {object} opp - Opportunity with existing governance layers
 * @param {object} [govCtx] - Pre-computed governance context (from computeGovernanceContext)
 * @returns {object} Per-opportunity governance classification
 */
function deriveOpportunityGovernance(opp, govCtx) {
  const gc = govCtx || computeGovernanceContext();

  const auditTrace = opp?.auditTrace || {};
  const approvalFlow = opp?.controlledApprovalFlow || {};
  const actionReadiness = opp?.actionReadiness || {};

  // Determine whether this opportunity requires elevated governance
  const requiresApproval = actionReadiness.approvalRequired === true;
  const isReviewControlled = auditTrace.governanceStatus === "review_controlled";
  const isBlocked = auditTrace.blockedByGuardrail === true;

  // Policy compliance: can the current actor act on this opportunity?
  let actorCanApprove = gc.approvalActionAllowed && !isBlocked;
  let actorCanMutatePolicy = gc.policyMutationAllowed;
  let actorCanReadAudit = gc.auditReadAllowed;

  // Separation-of-Duties enforcement:
  // With the built-in roles this is always false (no role has both permissions).
  // This guard exists for future IAM integration where external identity providers
  // might assign custom roles that violate SoD constraints.
  const sodConflict = requiresApproval && gc.policyMutationAllowed && gc.approvalActionAllowed;

  return {
    actorRole: gc.actorRole,
    governanceRole: gc.governanceRole,
    tenantScope: gc.tenantScope,
    separationOfDutiesFlag: gc.separationOfDutiesFlag,
    requiresApproval,
    isReviewControlled,
    isBlocked,
    actorCanApprove,
    actorCanMutatePolicy,
    actorCanReadAudit,
    sodConflict,
    governanceBasis: "step8_block1",
  };
}

/* =========================================================
   STEP 8 BLOCK 2: OPERATING CONSOLE / EXCEPTION HUB BASIS

   Aggregates existing per-opportunity governance signals into
   a read-heavy operating-console view.  No new signals are
   introduced – this is a pure read/fold over already-computed
   layers (actionReadiness, approvalQueueEntry, decisionLayer,
   controlledApprovalFlow, auditTrace, followUpContext,
   userAttentionLevel).

   operatingSummary levels:
     normal              – no open exceptions
     backlog_present     – deferred / needs_more_data / follow-up items
     elevated_review_load – open reviews or pending approvals
     critical_exceptions – guardrail blocks or critical attention items
========================================================= */

/**
 * Compute the Operating Console / Exception Hub context for a list of
 * already-enriched opportunities.
 *
 * @param {Array} opps - Opportunities with governance layers attached
 * @returns {object} Operating console / exception hub descriptor
 */
function computeOperatingConsoleContext(opps) {
  const EMPTY_BUCKETS = {
    guardrailBlocked:  [],
    openReview:        [],
    pendingApproval:   [],
    deferred:          [],
    needsMoreData:     [],
    followUpBacklog:   [],
    criticalAttention: [],
  };

  if (!Array.isArray(opps) || opps.length === 0) {
    return {
      openReviewCount:         0,
      pendingApprovalCount:    0,
      deferredCount:           0,
      needsMoreDataCount:      0,
      blockedByGuardrailCount: 0,
      followUpBacklogCount:    0,
      criticalAttentionCount:  0,
      exceptionBuckets:        EMPTY_BUCKETS,
      operatingSummary:        "no_data",
      operatingBasis:          "step8_block2",
    };
  }

  const toSymbols = (arr) => arr.map((o) => o.symbol || o.id).filter(Boolean);

  const blocked          = opps.filter((o) => o.auditTrace?.blockedByGuardrail === true);
  const openReview       = opps.filter((o) => o.actionReadiness?.actionReadiness === "review_required");
  const pendingApproval  = opps.filter((o) => o.approvalQueueEntry?.pendingApproval === true);
  const deferred         = opps.filter((o) => o.controlledApprovalFlow?.approvalFlowStatus === "deferred");
  const needsMoreData    = opps.filter((o) => o.decisionLayer?.decisionStatus === "needs_more_data");
  const followUpBacklog  = opps.filter((o) =>
    o.followUpContext?.followUpStatus === "overdue" ||
    o.followUpContext?.followUpStatus === "pending"
  );
  const criticalAttention = opps.filter((o) =>
    o.userAttentionLevel === "critical" || o.attentionLevel === "critical"
  );

  const hasCritical = blocked.length > 0 || criticalAttention.length > 0;
  const hasElevated = openReview.length > 0 || pendingApproval.length > 0;
  const hasBacklog  = deferred.length > 0 || needsMoreData.length > 0 || followUpBacklog.length > 0;

  let operatingSummary = "normal";
  if (hasCritical)      operatingSummary = "critical_exceptions";
  else if (hasElevated) operatingSummary = "elevated_review_load";
  else if (hasBacklog)  operatingSummary = "backlog_present";

  return {
    openReviewCount:         openReview.length,
    pendingApprovalCount:    pendingApproval.length,
    deferredCount:           deferred.length,
    needsMoreDataCount:      needsMoreData.length,
    blockedByGuardrailCount: blocked.length,
    followUpBacklogCount:    followUpBacklog.length,
    criticalAttentionCount:  criticalAttention.length,
    exceptionBuckets: {
      guardrailBlocked:  toSymbols(blocked),
      openReview:        toSymbols(openReview),
      pendingApproval:   toSymbols(pendingApproval),
      deferred:          toSymbols(deferred),
      needsMoreData:     toSymbols(needsMoreData),
      followUpBacklog:   toSymbols(followUpBacklog),
      criticalAttention: toSymbols(criticalAttention),
    },
    operatingSummary,
    operatingBasis: "step8_block2",
  };
}

/* =========================================================
   STEP 8 BLOCK 3: POLICY PLANE / SHADOW MODE / FOUR-EYES BASIS

   Derives a first-class policy-plane descriptor per opportunity.
   No external policy engine – only structured internal context
   with version, status, mode, shadow-readiness and four-eyes
   (second-approval) classification.

   policyStatus values:
     active           – policy is live and operative
     pending_approval – policy mutation awaiting (first) approval
     shadow           – policy in what-if / shadow evaluation
     draft            – policy prepared but not yet active

   policyMode values:
     live   – normal execution path
     shadow – what-if observation only, no real action
     draft  – not yet promoted to any execution path

   requiresSecondApproval / approvalState:
     Only for critical policy mutations (approved_candidate +
     review_required, or guardrail-blocked): signals that a second
     independent actor must confirm before any mutation proceeds.
     No digital signature or workflow engine – structural readiness only.
========================================================= */

/**
 * Compute the Policy Plane context for a single opportunity.
 * Derives policy version, status, mode, shadow-mode readiness,
 * and four-eyes / dual-approval classification from existing
 * governance signals.  No new DB calls.
 *
 * @param {object} opp    - Opportunity with governance layers attached
 * @param {object} [govCtx] - Pre-computed governance context
 * @returns {object} Policy plane descriptor
 */
function computePolicyPlaneContext(opp, govCtx) {
  const gc = govCtx || computeGovernanceContext();

  const auditTrace           = opp?.auditTrace           || {};
  const decisionLayer        = opp?.decisionLayer        || {};
  const actionReadiness      = opp?.actionReadiness      || {};
  const controlledApprovalFlow = opp?.controlledApprovalFlow || {};

  const isBlocked          = auditTrace.blockedByGuardrail === true;
  const isApprovedCandidate = decisionLayer.decisionStatus === "approved_candidate";
  const isReviewRequired   = actionReadiness.actionReadiness === "review_required";
  const isDeferred         = controlledApprovalFlow.approvalFlowStatus === "deferred";
  const isPendingApproval  =
    controlledApprovalFlow.approvalFlowStatus === "approved_pending_action" ||
    controlledApprovalFlow.approvalFlowStatus === "awaiting_review";

  // ── Policy status ─────────────────────────────────────────────────────────
  // Derived from existing operational state; no new signals introduced.
  let policyStatus = "active";
  if (isBlocked) {
    // Blocked = policy-level gate: must receive approval before re-activation
    policyStatus = "pending_approval";
  } else if (isDeferred) {
    // Deferred = policy evaluated in shadow mode first before going live
    policyStatus = "shadow";
  } else if (isPendingApproval) {
    policyStatus = "pending_approval";
  }

  // ── Policy mode ───────────────────────────────────────────────────────────
  // live by default; shadow for deferred/what-if cases; draft for blocked
  let policyMode = "live";
  if (isDeferred) policyMode = "shadow";
  if (isBlocked)  policyMode = "draft";

  // ── Four-eyes / dual-approval ─────────────────────────────────────────────
  // Required when the decision is critical: approved_candidate + review_required,
  // or when a guardrail blocks further progress.
  const requiresSecondApproval = (isApprovedCandidate && isReviewRequired) || isBlocked;

  // approvalState: structural readiness – no workflow engine, classification only
  const approvalState = requiresSecondApproval ? "awaiting_second" : "none";

  // secondApprovalReady: current governance actor can perform the second approval
  const secondApprovalReady = requiresSecondApproval && gc.approvalActionAllowed === true;

  // ── Shadow-mode eligibility ───────────────────────────────────────────────
  // True when the policy could be evaluated in shadow mode (not hard-blocked,
  // not already in draft, and in a review or proposal state).
  const shadowModeEligible =
    !isBlocked &&
    policyMode !== "draft" &&
    (isReviewRequired || isApprovedCandidate || isPendingApproval);

  // shadowReason: only set when the policy is actively in shadow mode
  const shadowReason =
    policyMode === "shadow"
      ? "Deferred pending re-evaluation – shadow observation active"
      : null;

  return {
    policyVersion:         "v1",
    policyStatus,
    policyMode,
    requiresSecondApproval,
    approvalState,
    secondApprovalReady,
    shadowModeEligible,
    shadowReason,
    policyScope:           "per_opportunity",
    policyMutationAllowed: gc.policyMutationAllowed === true,
    policyPlaneBasis:      "step8_block3",
  };
}

/* =========================================================
   STEP 8 BLOCK 4: EVIDENCE PACKAGES & POLICY VERSIONING

   Builds a first evidence/policy-versioning layer from
   existing governance signals.  No cryptography, no Merkle,
   no external workflow – only structured internal derivation.

   Fields derived:
     policyFingerprint     – compact deterministic key from policy-state signals
     policyValidity        – valid / pending / suspended
     policyApprovalHistory – ordered approval-event list from existing layers
     operatorActionTrace   – operator-readable governance trace entries
     evidencePackage       – compact evidence summary for audit/admin/frontend

   All fields are derived solely from already-computed layers:
     policyPlane, auditTrace, decisionLayer, controlledApprovalFlow,
     actionReadiness, approvalQueueEntry, governanceContext
   No new DB calls.  No real cryptography.
========================================================= */

/**
 * Compute an evidence package + policy-versioning descriptor for a single
 * opportunity.  All fields are derived from already-computed governance
 * layers – no new DB calls, no real cryptography.
 *
 * @param {object} opp    - Opportunity with full governance layers attached
 * @param {object} [govCtx] - Pre-computed governance context
 * @returns {object} Evidence package + policy versioning descriptor
 */
function computeEvidencePackage(opp, govCtx) {
  const gc = govCtx || computeGovernanceContext();

  const policyPlane            = opp?.policyPlane            || {};
  const auditTrace             = opp?.auditTrace             || {};
  const decisionLayer          = opp?.decisionLayer          || {};
  const controlledApprovalFlow = opp?.controlledApprovalFlow || {};
  const actionReadiness        = opp?.actionReadiness        || {};
  const approvalQueueEntry     = opp?.approvalQueueEntry     || {};

  // ── Policy fingerprint (deterministic, no crypto) ─────────────────────────
  // A short structured key derived from policy-state signals.
  // Format: "<version>:<status>:<mode>:<decisionStatus>"
  // Allows downstream consumers to detect policy-state changes without a
  // full changelog system.
  const policyVersion   = policyPlane.policyVersion   || "v1";
  const policyStatus    = policyPlane.policyStatus    || "active";
  const policyMode      = policyPlane.policyMode      || "live";
  const decisionStatus  = decisionLayer.decisionStatus || "none";
  const policyFingerprint = `${policyVersion}:${policyStatus}:${policyMode}:${decisionStatus}`;

  // ── Policy validity ────────────────────────────────────────────────────────
  // suspended – hard-blocked by guardrail or in draft (not yet active)
  // pending   – awaiting approval or in shadow evaluation
  // valid     – active, live, operative
  let policyValidity = "valid";
  if (auditTrace.blockedByGuardrail === true || policyMode === "draft") {
    policyValidity = "suspended";
  } else if (policyStatus === "pending_approval" || policyMode === "shadow") {
    policyValidity = "pending";
  }

  // ── Policy approval history (from existing state, no persistence) ─────────
  // An ordered list of approval-relevant state transitions derived from what
  // the layers already know.  Not a persisted ledger – a structured read-out
  // of the current approval-chain state for evidence/audit purposes.
  const policyApprovalHistory = [];
  if (auditTrace.governanceStatus) {
    policyApprovalHistory.push({
      event:  "governance_status",
      state:  auditTrace.governanceStatus,
      source: "auditTrace",
    });
  }
  if (approvalQueueEntry.pendingApproval === true) {
    policyApprovalHistory.push({
      event:  "approval_queued",
      state:  approvalQueueEntry.approvalQueueBucket || "unknown",
      source: "approvalQueueEntry",
    });
  }
  if (decisionLayer.decisionStatus) {
    policyApprovalHistory.push({
      event:  "decision_recorded",
      state:  decisionLayer.decisionStatus,
      source: "decisionLayer",
    });
  }
  if (controlledApprovalFlow.approvalFlowStatus) {
    policyApprovalHistory.push({
      event:  "approval_flow",
      state:  controlledApprovalFlow.approvalFlowStatus,
      source: "controlledApprovalFlow",
    });
  }
  if (policyPlane.requiresSecondApproval === true) {
    policyApprovalHistory.push({
      event:  "four_eyes_required",
      state:  policyPlane.approvalState || "awaiting_second",
      source: "policyPlane",
    });
  }

  // ── Operator action trace ─────────────────────────────────────────────────
  // Readable governance trace derived from available layers.
  // Gives operators and auditors a narrative of which governance controls
  // are active for this opportunity.
  const operatorActionTrace = [];
  if (auditTrace.traceReason) {
    operatorActionTrace.push({ trace: "audit_reason",     value: auditTrace.traceReason });
  }
  if (auditTrace.tracePath) {
    operatorActionTrace.push({ trace: "audit_path",       value: auditTrace.tracePath });
  }
  if (auditTrace.blockedByGuardrail === true) {
    operatorActionTrace.push({ trace: "guardrail_active", value: "blocked" });
  }
  if (actionReadiness.actionReadiness) {
    operatorActionTrace.push({ trace: "action_readiness", value: actionReadiness.actionReadiness });
  }
  if (policyMode !== "live") {
    operatorActionTrace.push({ trace: "policy_mode",      value: policyMode });
  }
  if (policyPlane.requiresSecondApproval === true) {
    operatorActionTrace.push({
      trace: "second_approval",
      value: policyPlane.secondApprovalReady ? "ready" : "awaiting",
    });
  }

  // ── Evidence package (compact structured summary) ─────────────────────────
  const evidencePackage = {
    policyVersion,
    policyFingerprint,
    policyValidity,
    governanceStatus:  auditTrace.governanceStatus  || "observation",
    traceReason:       auditTrace.traceReason       || null,
    tracePath:         auditTrace.tracePath         || null,
    // Review / decision / approval chain summary
    reviewSummary: {
      actionReadiness:     actionReadiness.actionReadiness     || null,
      approvalQueueBucket: approvalQueueEntry.approvalQueueBucket || null,
      pendingApproval:     approvalQueueEntry.pendingApproval === true,
    },
    decisionSummary: {
      decisionStatus:  decisionLayer.decisionStatus  || null,
      decisionReason:  decisionLayer.decisionReason  || null,
    },
    approvalSummary: {
      approvalFlowStatus:     controlledApprovalFlow.approvalFlowStatus || null,
      requiresSecondApproval: policyPlane.requiresSecondApproval === true,
      approvalState:          policyPlane.approvalState || "none",
    },
    // Actor / role context
    actorContext: {
      actorRole:              gc.actorRole,
      governanceRole:         gc.governanceRole,
      tenantScope:            gc.tenantScope,
      separationOfDutiesFlag: gc.separationOfDutiesFlag,
    },
    policyApprovalHistory,
    operatorActionTrace,
    evidenceBasis: "step8_block4",
  };

  return {
    policyVersion,
    policyFingerprint,
    policyValidity,
    policyApprovalHistory,
    operatorActionTrace,
    evidencePackage,
    evidenceBasis: "step8_block4",
  };
}

/* =========================================================
   STEP 8 BLOCK 5: TENANT-AWARE POLICIES & RESOURCE GOVERNANCE BASIS

   Builds a first tenant-aware resource- and policy-layer from
   existing governance signals.  No real Multi-Tenant DB isolation,
   no global quota engine – only structured internal classification
   that gives the platform a defensible, traceable first resource-
   governance layer.

   Fields derived per-opportunity:
     tenantId               – resolved from ctx (defaults to "tenant_default")
     tenantPolicyScope      – scope of applicable policies
     tenantMaxAutonomyLevel – max permitted action autonomy for this tenant context
     tenantQuotaProfile     – rough quota risk tier (high_risk / elevated / standard / relaxed)
     resourceGovernanceStatus – hard_gated / controlled / monitored / open
     rateLimitRisk          – high / medium / low
     noisyNeighborRisk      – high / medium / low (load-relative)
     quotaUsage             – 0.0–1.0 normalised load estimate
     backlogPressure        – elevated / moderate / none
     tenantLoadBand         – critical / high / medium / low
     quotaWarning           – boolean flag when load band is high/critical
     resourceGuardrail      – active / standby / inactive

   All derived from already-computed layers:
     actionReadiness, decisionLayer, controlledApprovalFlow,
     auditTrace, exceptionFields, governanceContext, policyPlane
   No new DB calls.  No quota database.  No rate-limit engine.
========================================================= */

// ── Autonomy-level mapping by action-readiness tier ───────────────────────
const AUTONOMY_BY_READINESS = {
  review_required:        "restricted",
  proposal_ready:         "standard",
  monitor_only:           "permissive",
  insufficient_confidence: "minimal",
};

// ── Quota profile mapping by exception priority ────────────────────────────
const QUOTA_BY_EXCEPTION_PRIORITY = {
  critical: "high_risk",
  high:     "elevated",
  medium:   "standard",
  low:      "relaxed",
};

/**
 * Compute a per-opportunity tenant/resource governance descriptor.
 * All fields are derived from already-computed governance layers –
 * no new DB calls, no real quota engine.
 *
 * @param {object} opp    - Opportunity with governance layers attached
 * @param {object} [govCtx] - Pre-computed governance context
 * @returns {object} Tenant/resource governance descriptor
 */
function computeTenantResourceGovernance(opp, govCtx) {
  const gc = govCtx || computeGovernanceContext();

  const actionReadiness        = opp?.actionReadiness        || {};
  const decisionLayer          = opp?.decisionLayer          || {};
  const controlledApprovalFlow = opp?.controlledApprovalFlow || {};
  const auditTrace             = opp?.auditTrace             || {};
  const exceptionFields        = opp?.exceptionFields        || {};
  const policyPlane            = opp?.policyPlane            || {};

  // ── Tenant identification (preparatory – no real IAM yet) ─────────────────
  // Falls back to a deterministic per-user slug when no explicit tenantId
  // is available.  Designed as an integration point for future IAM.
  const tenantId =
    opp?.tenantId ||
    gc?.tenantId ||
    (opp?.userId ? `tenant_user_${opp.userId}` : "tenant_default");

  // ── Tenant policy scope (from existing policyPlane / governance scope) ─────
  const tenantPolicyScope =
    policyPlane.policyScope || gc.tenantScope || DEFAULT_TENANT_SCOPE;

  // ── Tenant max autonomy level – derived from action-readiness tier ─────────
  const readinessTier = actionReadiness.actionReadiness || "insufficient_confidence";
  const tenantMaxAutonomyLevel =
    AUTONOMY_BY_READINESS[readinessTier] || "minimal";

  // ── Tenant quota profile – derived from exception priority ────────────────
  const exceptionPriority = exceptionFields.exceptionPriority || "low";
  const tenantQuotaProfile =
    QUOTA_BY_EXCEPTION_PRIORITY[exceptionPriority] || "standard";

  // ── Resource governance status ────────────────────────────────────────────
  // hard_gated: guardrail blocks progress – requires manual release
  // controlled: review/approval required – governed path
  // monitored:  proposal tier – user-driven, observed
  // open:       observation only – no active governance gate
  let resourceGovernanceStatus = "open";
  if (auditTrace.blockedByGuardrail === true) {
    resourceGovernanceStatus = "hard_gated";
  } else if (
    readinessTier === "review_required" ||
    controlledApprovalFlow.approvalFlowStatus === "awaiting_review" ||
    controlledApprovalFlow.approvalFlowStatus === "approved_pending_action"
  ) {
    resourceGovernanceStatus = "controlled";
  } else if (readinessTier === "proposal_ready") {
    resourceGovernanceStatus = "monitored";
  }

  // ── Rate-limit risk – from exception priority / governance pressure ────────
  let rateLimitRisk = "low";
  if (exceptionPriority === "critical" || auditTrace.blockedByGuardrail === true) {
    rateLimitRisk = "high";
  } else if (exceptionPriority === "high" || readinessTier === "review_required") {
    rateLimitRisk = "medium";
  }

  // ── Noisy-neighbor risk (per-opp: structural, not load-based) ─────────────
  // Per-opportunity this is always low; aggregate variant computes actual load.
  const noisyNeighborRisk = "low";

  // ── Backlog pressure ─────────────────────────────────────────────────────
  // elevated: follow-up needed + open decision pending
  // moderate: deferred or needs-more-data without critical flag
  // none:     no backlog signals
  let backlogPressure = "none";
  const followUpNeeded = opp?.followUpContext?.followUpStatus === "overdue" ||
    opp?.followUpContext?.followUpStatus === "pending" ||
    opp?.actionOrchestration?.followUpNeeded === true;
  const hasPendingDecision =
    decisionLayer.decisionStatus === "pending_review" ||
    decisionLayer.decisionStatus === "needs_more_data";
  const isDeferred =
    controlledApprovalFlow.approvalFlowStatus === "deferred";

  if (followUpNeeded && hasPendingDecision) {
    backlogPressure = "elevated";
  } else if (isDeferred || decisionLayer.decisionStatus === "needs_more_data") {
    backlogPressure = "moderate";
  }

  // ── Tenant load band (per-opp structural estimate) ────────────────────────
  let tenantLoadBand = "low";
  if (resourceGovernanceStatus === "hard_gated" || rateLimitRisk === "high") {
    tenantLoadBand = "critical";
  } else if (rateLimitRisk === "medium" || backlogPressure === "elevated") {
    tenantLoadBand = "high";
  } else if (backlogPressure === "moderate" || readinessTier === "proposal_ready") {
    tenantLoadBand = "medium";
  }

  // ── Quota signals ─────────────────────────────────────────────────────────
  // quotaUsage: rough 0.0–1.0 signal derived from load band (not a real counter)
  const LOAD_BAND_QUOTA = { critical: 1.0, high: 0.75, medium: 0.4, low: 0.1 };
  const quotaUsage = LOAD_BAND_QUOTA[tenantLoadBand] ?? 0.1;

  const quotaWarning = tenantLoadBand === "high" || tenantLoadBand === "critical";

  // ── Resource guardrail ────────────────────────────────────────────────────
  // active:   hard_gated – explicit governance block
  // standby:  controlled – under active governance supervision
  // inactive: monitored / open – no active guardrail
  let resourceGuardrail = "inactive";
  if (resourceGovernanceStatus === "hard_gated") {
    resourceGuardrail = "active";
  } else if (resourceGovernanceStatus === "controlled") {
    resourceGuardrail = "standby";
  }

  return {
    tenantId,
    tenantPolicyScope,
    tenantMaxAutonomyLevel,
    tenantQuotaProfile,
    resourceGovernanceStatus,
    rateLimitRisk,
    noisyNeighborRisk,
    quotaUsage,
    backlogPressure,
    tenantLoadBand,
    quotaWarning,
    resourceGuardrail,
    tenantResourceBasis: "step8_block5",
  };
}

/**
 * Compute an aggregate tenant/resource governance summary across a list of
 * already-enriched opportunities.  Used by the admin endpoint and
 * frontendAdapter portfolio summary.  No new DB calls.
 *
 * @param {Array} opps - Opportunities with tenantResourceGovernance attached
 * @returns {object} Aggregate tenant/resource governance summary
 */
function computeTenantResourceGovernanceSummary(opps) {
  if (!Array.isArray(opps) || opps.length === 0) {
    return {
      totalEvaluated:       0,
      hardGatedCount:       0,
      controlledCount:      0,
      quotaWarningCount:    0,
      highLoadCount:        0,
      rateLimitRiskHighCount: 0,
      noisyNeighborRisk:    "low",
      backlogPressureElevatedCount: 0,
      tenantLoadBandSummary: { critical: 0, high: 0, medium: 0, low: 0 },
      resourceGuardrailActiveCount: 0,
      tenantResourceBasis: "step8_block5",
    };
  }

  const trg = (o) => o.tenantResourceGovernance || {};

  const hardGatedCount    = opps.filter((o) => trg(o).resourceGovernanceStatus === "hard_gated").length;
  const controlledCount   = opps.filter((o) => trg(o).resourceGovernanceStatus === "controlled").length;
  const quotaWarningCount = opps.filter((o) => trg(o).quotaWarning === true).length;
  const highLoadCount     = opps.filter((o) => trg(o).tenantLoadBand === "high" || trg(o).tenantLoadBand === "critical").length;
  const rateLimitHighCount = opps.filter((o) => trg(o).rateLimitRisk === "high").length;
  const backlogElevated   = opps.filter((o) => trg(o).backlogPressure === "elevated").length;
  const guardrailActive   = opps.filter((o) => trg(o).resourceGuardrail === "active").length;

  const loadBandCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const o of opps) {
    const band = trg(o).tenantLoadBand || "low";
    if (band in loadBandCounts) loadBandCounts[band]++;
  }

  // Noisy-neighbor risk at aggregate level: elevated when >25% of opps are high/critical load
  const highLoadRatio = opps.length > 0 ? highLoadCount / opps.length : 0;
  let noisyNeighborRisk = "low";
  if (highLoadRatio >= 0.5) noisyNeighborRisk = "high";
  else if (highLoadRatio >= 0.25) noisyNeighborRisk = "medium";

  return {
    totalEvaluated:               opps.length,
    hardGatedCount,
    controlledCount,
    quotaWarningCount,
    highLoadCount,
    rateLimitRiskHighCount:       rateLimitHighCount,
    noisyNeighborRisk,
    backlogPressureElevatedCount: backlogElevated,
    tenantLoadBandSummary:        loadBandCounts,
    resourceGuardrailActiveCount: guardrailActive,
    tenantResourceBasis:          "step8_block5",
  };
}

/* =========================================================
   STEP 8 BLOCK 6: GRACEFUL DEGRADATION, RECOVERY &
   OPERATIONAL RESILIENCE

   Derives a first operational-resilience layer from existing
   governance, tenant-resource, exception, and backlog signals.
   No new DB calls. No SRE platform. No rate-limit engine.

   Fields derived per-opportunity:
     degradationMode      – normal / elevated_load / constrained / critical_guarded
     operationalHealth    – healthy / degraded / critical
     fallbackTier         – full_context / reduced_context / essential_only
     resilienceFlags      – array of active pressure flags
     recoveryState        – stable / recovering / at_risk
     resumeReady          – boolean: safe to resume normal processing
     systemPressureSummary – human-readable one-liner

   All derived from already-computed layers:
     tenantResourceGovernance (Block 5), exceptionFields (Block 2),
     auditTrace (Step 7 Block 5), actionReadiness (Step 7 Block 1),
     decisionLayer (Step 7 Block 3), controlledApprovalFlow (Step 7 Block 4)
   No new infrastructure.
========================================================= */

// ── Degradation-mode label mapping ────────────────────────────────────────
const PRESSURE_SUMMARY = {
  normal:           "Normalbetrieb – kein erhöhter Systemdruck",
  elevated_load:    "Erhöhte Last – defensiver Betrieb empfohlen",
  constrained:      "System eingeschränkt – reduzierter Kontext, manuelle Prüfung erforderlich",
  critical_guarded: "Kritisch abgesichert – nur essentielle Signale, kein automatischer Fortschritt",
};

/**
 * Compute a per-opportunity operational-resilience descriptor.
 * All fields are derived from already-computed governance layers –
 * no new DB calls, no real infrastructure.
 *
 * @param {object} opp    - Opportunity with governance layers attached
 * @returns {object} Operational resilience descriptor
 */
function computeOperationalResilienceContext(opp) {
  const trg  = opp?.tenantResourceGovernance || {};
  const exc  = opp?.exceptionFields          || {};
  const aud  = opp?.auditTrace               || {};
  const caf  = opp?.controlledApprovalFlow   || {};

  const tenantLoadBand              = trg.tenantLoadBand              || "low";
  const backlogPressure             = trg.backlogPressure             || "none";
  const rateLimitRisk               = trg.rateLimitRisk               || "low";
  const quotaWarning                = trg.quotaWarning                === true;
  const resourceGovernanceStatus    = trg.resourceGovernanceStatus    || "open";
  const blockedByGuardrail          = aud.blockedByGuardrail          === true;
  const exceptionPriority           = exc.exceptionPriority           || "low";
  const approvalFlowStatus          = caf.approvalFlowStatus          || null;

  // ── Degradation mode ─────────────────────────────────────────────────────
  // critical_guarded: hard guardrail block or critical exception + critical load
  // constrained:      critical load band or (high exception + elevated backlog)
  // elevated_load:    high load band or elevated backlog or high rate-limit risk
  // normal:           no significant pressure signals
  let degradationMode = "normal";
  if (
    blockedByGuardrail ||
    (exceptionPriority === "critical" && tenantLoadBand === "critical")
  ) {
    degradationMode = "critical_guarded";
  } else if (
    tenantLoadBand === "critical" ||
    (exceptionPriority === "high" && backlogPressure === "elevated")
  ) {
    degradationMode = "constrained";
  } else if (
    tenantLoadBand === "high" ||
    backlogPressure === "elevated" ||
    rateLimitRisk === "high"
  ) {
    degradationMode = "elevated_load";
  }

  // ── Operational health ────────────────────────────────────────────────────
  const operationalHealth =
    degradationMode === "critical_guarded" ? "critical" :
    degradationMode !== "normal"           ? "degraded" :
    "healthy";

  // ── Fallback tier ─────────────────────────────────────────────────────────
  // essential_only:  critical degradation – surface only blocking signals
  // reduced_context: constrained – reduce non-essential context fields
  // full_context:    normal or elevated_load – full governance context
  const fallbackTier =
    degradationMode === "critical_guarded" ? "essential_only" :
    degradationMode === "constrained"      ? "reduced_context" :
    "full_context";

  // ── Resilience flags ──────────────────────────────────────────────────────
  const resilienceFlags = [];
  if (blockedByGuardrail)                           resilienceFlags.push("guardrail_active");
  if (quotaWarning)                                 resilienceFlags.push("quota_warning");
  if (backlogPressure === "elevated")               resilienceFlags.push("backlog_elevated");
  if (rateLimitRisk === "high" || rateLimitRisk === "medium") resilienceFlags.push("rate_limit_risk");
  if (tenantLoadBand === "critical")                resilienceFlags.push("load_band_critical");
  if (resourceGovernanceStatus === "hard_gated")    resilienceFlags.push("resource_hard_gated");

  // ── Recovery state ────────────────────────────────────────────────────────
  const recoveryState =
    operationalHealth === "critical" ? "at_risk"   :
    operationalHealth === "degraded" ? "recovering" :
    "stable";

  // ── Resume readiness ──────────────────────────────────────────────────────
  // Eligible to resume normal processing when:
  //   - not hard-blocked by a guardrail
  //   - not stuck in a stalled flow state
  //   - not in at_risk recovery state
  const stalledFlow = approvalFlowStatus === "deferred" ||
    approvalFlowStatus === "waiting_for_more_data";
  const resumeReady = !blockedByGuardrail && !stalledFlow && recoveryState !== "at_risk";

  const systemPressureSummary = PRESSURE_SUMMARY[degradationMode] || PRESSURE_SUMMARY.normal;

  return {
    degradationMode,
    operationalHealth,
    fallbackTier,
    resilienceFlags,
    recoveryState,
    resumeReady,
    systemPressureSummary,
    resilienceBasis: "step8_block6",
  };
}

/**
 * Compute an aggregate operational-resilience summary across a list of
 * already-enriched opportunities (with operationalResilience attached).
 * Used by the admin endpoint and frontendAdapter portfolio summary.
 *
 * @param {Array} opps - Opportunities with operationalResilience attached
 * @returns {object} Aggregate operational resilience summary
 */
function computeOperationalResilienceContextSummary(opps) {
  if (!Array.isArray(opps) || opps.length === 0) {
    return {
      totalEvaluated:        0,
      criticalGuardedCount:  0,
      constrainedCount:      0,
      elevatedLoadCount:     0,
      normalCount:           0,
      criticalHealthCount:   0,
      degradedHealthCount:   0,
      healthyCount:          0,
      resumeReadyCount:      0,
      fallbackTierCounts:    { essential_only: 0, reduced_context: 0, full_context: 0 },
      dominantDegradationMode: "normal",
      systemPressureLevel:   "none",
      resilienceBasis:       "step8_block6",
    };
  }

  const r = (o) => o.operationalResilience || {};

  const criticalGuardedCount = opps.filter((o) => r(o).degradationMode === "critical_guarded").length;
  const constrainedCount     = opps.filter((o) => r(o).degradationMode === "constrained").length;
  const elevatedLoadCount    = opps.filter((o) => r(o).degradationMode === "elevated_load").length;
  const normalCount          = opps.filter((o) => r(o).degradationMode === "normal" || !r(o).degradationMode).length;

  const criticalHealthCount  = opps.filter((o) => r(o).operationalHealth === "critical").length;
  const degradedHealthCount  = opps.filter((o) => r(o).operationalHealth === "degraded").length;
  const healthyCount         = opps.filter((o) => r(o).operationalHealth === "healthy" || !r(o).operationalHealth).length;

  const resumeReadyCount     = opps.filter((o) => r(o).resumeReady === true).length;

  const fallbackTierCounts = { essential_only: 0, reduced_context: 0, full_context: 0 };
  for (const o of opps) {
    const tier = r(o).fallbackTier || "full_context";
    if (tier in fallbackTierCounts) fallbackTierCounts[tier]++;
  }

  // Dominant mode: whichever non-normal mode has the highest count; fallback normal.
  let dominantDegradationMode = "normal";
  if (criticalGuardedCount > 0)                                  dominantDegradationMode = "critical_guarded";
  else if (constrainedCount > elevatedLoadCount)                 dominantDegradationMode = "constrained";
  else if (elevatedLoadCount > 0)                                dominantDegradationMode = "elevated_load";

  // System pressure level: aggregate severity signal.
  // critical: ≥10% of opps are critical_guarded (avoid alerting on a single outlier)
  const critRatio = opps.length > 0 ? criticalGuardedCount / opps.length : 0;
  const constRatio = opps.length > 0 ? constrainedCount / opps.length : 0;
  const elevRatio  = opps.length > 0 ? elevatedLoadCount / opps.length : 0;
  let systemPressureLevel = "none";
  if (critRatio >= 0.1)        systemPressureLevel = "critical";
  else if (constRatio >= 0.25) systemPressureLevel = "high";
  else if (constRatio > 0)     systemPressureLevel = "medium";
  else if (elevRatio >= 0.25)  systemPressureLevel = "medium";
  else if (elevRatio > 0)      systemPressureLevel = "low";

  return {
    totalEvaluated: opps.length,
    criticalGuardedCount,
    constrainedCount,
    elevatedLoadCount,
    normalCount,
    criticalHealthCount,
    degradedHealthCount,
    healthyCount,
    resumeReadyCount,
    fallbackTierCounts,
    dominantDegradationMode,
    systemPressureLevel,
    resilienceBasis: "step8_block6",
  };
}

module.exports = {
  ACTOR_ROLES,
  DEFAULT_ACTOR_ROLE,
  DEFAULT_TENANT_SCOPE,
  resolveActorRole,
  resolveTenantScope,
  computeGovernanceContext,
  deriveOpportunityGovernance,
  computeOperatingConsoleContext,
  computePolicyPlaneContext,
  computeEvidencePackage,
  computeTenantResourceGovernance,
  computeTenantResourceGovernanceSummary,
  computeOperationalResilienceContext,
  computeOperationalResilienceContextSummary,
  PRESSURE_SUMMARY,
};
