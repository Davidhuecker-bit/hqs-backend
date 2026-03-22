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

/* =========================================================
   STEP 9 BLOCK 1: AUTONOMY LEVELS + DRIFT DETECTION BASIS
   (Teilautonome Orchestrierung – Enterprise-Framework)

   First foundation layer for controlled autonomy:
   - Defines discrete autonomy levels with a hard cap at "supervised"
     (no autonomous execution yet).
   - Derives the effective autonomy level per opportunity from
     all existing governance, policy, resilience, tenant, evidence
     and exception signals (Step 7 + Step 8).
   - Computes a first drift/deviation detection layer that surfaces
     any signal that deviates from the expected "normal" baseline
     (governance drift, policy drift, resilience drift, evidence
     drift, tenant drift).
   - Provides an aggregate summary for admin observability.

   Design principles:
   - NO autonomous execution – this block only classifies and detects
   - Hard cap: the highest autonomy level emitted is "supervised"
   - Defensive: absent signals always resolve to the safest level
   - Governance-compatible: uses only signals from Step 7 + Step 8
   - Nachvollziehbar: every level decision includes a human-readable reason
========================================================= */

// ── Autonomy-Level Definitions ─────────────────────────────────────────────
// Ordered from most restrictive to most permissive.
// Step 9 Block 1 caps at "supervised" – "conditional" and "autonomous"
// are defined for forward compatibility but never emitted.
const AUTONOMY_LEVELS = {
  manual:      { rank: 0, label: "Manuell",     description: "Vollständige menschliche Kontrolle – kein automatisierter Schritt" },
  assisted:    { rank: 1, label: "Assistiert",   description: "System schlägt vor, Mensch entscheidet und führt aus" },
  supervised:  { rank: 2, label: "Überwacht",    description: "System führt nach menschlicher Freigabe aus" },
  conditional: { rank: 3, label: "Bedingt",      description: "System führt innerhalb vordefinierter Grenzen aus (noch nicht aktiv)" },
  autonomous:  { rank: 4, label: "Autonom",      description: "Vollautonome Ausführung (noch nicht aktiv)" },
};

// Hard cap for Step 9 Block 1 – never emit a level above this.
const AUTONOMY_LEVEL_CAP = "supervised";
const AUTONOMY_LEVEL_CAP_REASON = "step9_block1_basis_only";

/**
 * Compute the effective autonomy level for a single opportunity.
 * Uses all existing governance layers (Step 7 + Step 8) to derive
 * the safest applicable level.  Hard-capped at "supervised".
 *
 * @param {object} opp - Opportunity with governance layers attached
 * @returns {object} Autonomy level descriptor
 */
function computeAutonomyLevelContext(opp) {
  const gov   = opp?.governanceContext          || {};
  const pp    = opp?.policyPlane                || {};
  const trg   = opp?.tenantResourceGovernance   || {};
  const or_   = opp?.operationalResilience      || {};
  const exc   = opp?.exceptionFields            || {};
  const caf   = opp?.controlledApprovalFlow     || {};
  const evid  = opp?.evidencePackage            || {};

  // ── 1. Hard gates → manual ──────────────────────────────────────────────
  if (or_.degradationMode === "critical_guarded") {
    return _buildAutonomyResult("manual", "System kritisch abgesichert – kein automatischer Fortschritt");
  }
  if (trg.resourceGovernanceStatus === "hard_gated") {
    return _buildAutonomyResult("manual", "Ressource durch Guardrail gesperrt");
  }
  if (exc.exceptionType === "blocked_by_guardrail" || exc.exceptionPriority === "critical") {
    return _buildAutonomyResult("manual", "Guardrail-Sperre oder kritische Ausnahme aktiv");
  }
  if (gov.sodConflict === true) {
    return _buildAutonomyResult("manual", "Separation-of-Duties-Konflikt erkannt");
  }

  // ── 2. Elevated caution → assisted ──────────────────────────────────────
  if (or_.degradationMode === "constrained" || or_.degradationMode === "elevated_load") {
    return _buildAutonomyResult("assisted", `System im Modus ${or_.degradationMode} – erhöhte menschliche Kontrolle`);
  }
  if (pp.policyStatus === "pending_approval" || pp.policyStatus === "shadow" || pp.policyStatus === "draft") {
    return _buildAutonomyResult("assisted", `Policy-Status ${pp.policyStatus} – Freigabe erforderlich`);
  }
  if (gov.requiresApproval === true) {
    return _buildAutonomyResult("assisted", "Opportunity erfordert Genehmigung");
  }
  if (trg.tenantMaxAutonomyLevel === "restricted") {
    return _buildAutonomyResult("assisted", "Tenant-Autonomie eingeschränkt");
  }
  if (trg.rateLimitRisk === "high" || trg.backlogPressure === "elevated") {
    return _buildAutonomyResult("assisted", "Erhöhtes Rate-Limit-/Backlog-Risiko");
  }
  if (evid.policyValidity === "suspended" || evid.policyValidity === "pending") {
    return _buildAutonomyResult("assisted", `Policy-Validität ${evid.policyValidity} – manuelle Prüfung`);
  }

  // ── 3. Approved + clear signals → supervised (cap) ─────────────────────
  if (caf.approvalFlowStatus === "approved_pending_action" && pp.policyStatus === "active") {
    return _buildAutonomyResult("supervised", "Genehmigt und Policy aktiv – überwachte Ausführung");
  }

  // ── 4. Default: assisted (safe fallback) ────────────────────────────────
  return _buildAutonomyResult("assisted", "Standard-Fallback – assistierter Modus");
}

/** @private Build a normalised autonomy-level result object. */
function _buildAutonomyResult(level, reason) {
  return {
    effectiveLevel: level,
    levelRank:      AUTONOMY_LEVELS[level]?.rank ?? 1,
    levelLabel:     AUTONOMY_LEVELS[level]?.label ?? "Assistiert",
    levelCap:       AUTONOMY_LEVEL_CAP,
    capReason:      AUTONOMY_LEVEL_CAP_REASON,
    escalationRequired: level === "manual",
    levelBasis:     reason,
    autonomyBasis:  "step9_block1",
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   DRIFT DETECTION BASIS

   First drift/deviation detection layer.  Checks every governance signal
   against its expected "normal" baseline and surfaces deviations as
   typed drift signals.  No corrective action – observation only.

   Drift signal types:
     governance_drift  – SoD conflict, role anomaly
     policy_drift      – policy not active/live, shadow/pending
     resilience_drift  – degradation mode not normal, health not healthy
     evidence_drift    – policy validity not valid
     tenant_drift      – resource governance not open, quota warning, high load
     exception_drift   – non-normal exception type or elevated priority
   ───────────────────────────────────────────────────────────────────── */

/**
 * Compute a first drift-detection descriptor for a single opportunity.
 * Pure observation – no corrective action, no side-effects.
 *
 * @param {object} opp - Opportunity with governance layers attached
 * @returns {object} Drift detection descriptor
 */
function computeDriftDetectionBasis(opp) {
  const gov   = opp?.governanceContext          || {};
  const pp    = opp?.policyPlane                || {};
  const trg   = opp?.tenantResourceGovernance   || {};
  const or_   = opp?.operationalResilience      || {};
  const exc   = opp?.exceptionFields            || {};
  const evid  = opp?.evidencePackage            || {};

  const signals = [];

  // ── Governance drift ────────────────────────────────────────────────────
  if (gov.sodConflict === true) {
    signals.push({ type: "governance_drift", signal: "sod_conflict", severity: "high", detail: "Separation-of-Duties-Konflikt" });
  }
  if (gov.isBlocked === true) {
    signals.push({ type: "governance_drift", signal: "blocked", severity: "high", detail: "Opportunity durch Governance blockiert" });
  }

  // ── Policy drift ────────────────────────────────────────────────────────
  if (pp.policyStatus && pp.policyStatus !== "active") {
    signals.push({ type: "policy_drift", signal: `policy_status_${pp.policyStatus}`, severity: pp.policyStatus === "pending_approval" ? "medium" : "low", detail: `Policy-Status: ${pp.policyStatus}` });
  }
  if (pp.policyMode && pp.policyMode !== "live") {
    signals.push({ type: "policy_drift", signal: `policy_mode_${pp.policyMode}`, severity: "low", detail: `Policy-Modus: ${pp.policyMode}` });
  }

  // ── Resilience drift ───────────────────────────────────────────────────
  if (or_.degradationMode && or_.degradationMode !== "normal") {
    const sev = or_.degradationMode === "critical_guarded" ? "high" : or_.degradationMode === "constrained" ? "medium" : "low";
    signals.push({ type: "resilience_drift", signal: `degradation_${or_.degradationMode}`, severity: sev, detail: `Degradation: ${or_.degradationMode}` });
  }
  if (or_.operationalHealth && or_.operationalHealth !== "healthy") {
    signals.push({ type: "resilience_drift", signal: `health_${or_.operationalHealth}`, severity: or_.operationalHealth === "critical" ? "high" : "medium", detail: `Betriebszustand: ${or_.operationalHealth}` });
  }

  // ── Evidence drift ─────────────────────────────────────────────────────
  if (evid.policyValidity && evid.policyValidity !== "valid") {
    signals.push({ type: "evidence_drift", signal: `validity_${evid.policyValidity}`, severity: evid.policyValidity === "suspended" ? "high" : "medium", detail: `Policy-Validität: ${evid.policyValidity}` });
  }

  // ── Tenant drift ───────────────────────────────────────────────────────
  if (trg.resourceGovernanceStatus === "hard_gated") {
    signals.push({ type: "tenant_drift", signal: "hard_gated", severity: "high", detail: "Ressource durch Guardrail gesperrt" });
  } else if (trg.resourceGovernanceStatus === "controlled") {
    signals.push({ type: "tenant_drift", signal: "controlled", severity: "medium", detail: "Ressource unter aktiver Governance-Kontrolle" });
  }
  if (trg.quotaWarning === true) {
    signals.push({ type: "tenant_drift", signal: "quota_warning", severity: "medium", detail: "Quota-Warnung aktiv" });
  }
  if (trg.rateLimitRisk === "high") {
    signals.push({ type: "tenant_drift", signal: "rate_limit_high", severity: "medium", detail: "Hohes Rate-Limit-Risiko" });
  }

  // ── Exception drift ────────────────────────────────────────────────────
  if (exc.exceptionType && exc.exceptionType !== "normal") {
    signals.push({ type: "exception_drift", signal: `exception_${exc.exceptionType}`, severity: exc.exceptionPriority === "critical" ? "high" : exc.exceptionPriority === "high" ? "medium" : "low", detail: `Ausnahme: ${exc.exceptionType}` });
  }

  // ── Aggregate drift level ──────────────────────────────────────────────
  const highCount   = signals.filter((s) => s.severity === "high").length;
  const mediumCount = signals.filter((s) => s.severity === "medium").length;
  let driftLevel = "none";
  if (highCount > 0)        driftLevel = "high";
  else if (mediumCount >= 2) driftLevel = "medium";
  else if (signals.length > 0) driftLevel = "low";

  const metronomDeviation = signals.length > 0;
  let baselineState = "stable";
  if (highCount > 0)              baselineState = "critical";
  else if (mediumCount > 0)       baselineState = "drifting";

  return {
    driftSignals:       signals,
    driftSignalCount:   signals.length,
    driftLevel,
    metronomDeviation,
    baselineState,
    driftBasis:         "step9_block1",
  };
}

/**
 * Aggregate autonomy-level and drift-detection summary across opportunities.
 * For the admin /autonomy-drift endpoint.
 *
 * @param {Array<object>} opps - Array of enriched opportunities
 * @returns {object} Aggregate summary
 */
function computeAutonomyDriftSummary(opps) {
  if (!Array.isArray(opps) || opps.length === 0) {
    return {
      totalEvaluated: 0,
      autonomyDistribution: { manual: 0, assisted: 0, supervised: 0 },
      driftDistribution:    { none: 0, low: 0, medium: 0, high: 0 },
      metronomDeviationCount: 0,
      baselineStateCounts:  { stable: 0, drifting: 0, critical: 0 },
      dominantAutonomyLevel: "assisted",
      dominantDriftLevel:    "none",
      summaryBasis:          "step9_block1",
    };
  }

  let manualCount     = 0;
  let assistedCount   = 0;
  let supervisedCount = 0;
  let driftNone       = 0;
  let driftLow        = 0;
  let driftMedium     = 0;
  let driftHigh       = 0;
  let metronomCount   = 0;
  let stableCount     = 0;
  let driftingCount   = 0;
  let criticalCount   = 0;

  for (const o of opps) {
    const al = o.autonomyLevel || {};
    const dd = o.driftDetection || {};

    if (al.effectiveLevel === "manual")           manualCount++;
    else if (al.effectiveLevel === "supervised")   supervisedCount++;
    else                                           assistedCount++;

    if (dd.driftLevel === "high")        driftHigh++;
    else if (dd.driftLevel === "medium") driftMedium++;
    else if (dd.driftLevel === "low")    driftLow++;
    else                                 driftNone++;

    if (dd.metronomDeviation === true) metronomCount++;

    if (dd.baselineState === "critical")      criticalCount++;
    else if (dd.baselineState === "drifting")  driftingCount++;
    else                                       stableCount++;
  }

  // Dominant autonomy level: lowest (most restrictive) level present.
  let dominantAutonomyLevel = "supervised";
  if (manualCount > 0)        dominantAutonomyLevel = "manual";
  else if (assistedCount > 0) dominantAutonomyLevel = "assisted";

  // Dominant drift level: highest severity present.
  let dominantDriftLevel = "none";
  if (driftHigh > 0)        dominantDriftLevel = "high";
  else if (driftMedium > 0) dominantDriftLevel = "medium";
  else if (driftLow > 0)    dominantDriftLevel = "low";

  return {
    totalEvaluated: opps.length,
    autonomyDistribution: { manual: manualCount, assisted: assistedCount, supervised: supervisedCount },
    driftDistribution:    { none: driftNone, low: driftLow, medium: driftMedium, high: driftHigh },
    metronomDeviationCount: metronomCount,
    baselineStateCounts:  { stable: stableCount, drifting: driftingCount, critical: criticalCount },
    dominantAutonomyLevel,
    dominantDriftLevel,
    summaryBasis: "step9_block1",
  };
}

/* =========================================================
   STEP 9 BLOCK 2: ACTION CHAINS – STATE-MACHINE BASIS
   (Kontrollierte Aktionsketten-Grundlage)

   Builds a first structured state-machine layer on top of the
   autonomy levels and drift detection from Block 1.

   Purpose:
   - Map every opportunity to exactly ONE controlled chain state
     (idle / observing / preparing / awaiting_signal / executing /
      completed / aborted / escalated)
   - Derive the chain state defensively from ALL existing signals
     (Step 7 + Step 8 + Step 9 Block 1) – no new data sources
   - Provide safety-first conflict resolution: guardrail/block/drift
     signals always dominate growth/opportunity signals
   - Surface chain-blocking reasons and escalation paths
   - NO real execution engine – states only classify and recommend
   - NO autonomous market action – "executing" means "intent declared,
     awaiting human action"

   Design principles:
   - Defensive: missing signals → safest chain state (observing)
   - Safety-first: any conflict between risk-signals and growth-signals
     resolves in favour of the risk/review/guardrail path
   - Governance-compatible: all inputs come from Step 7-9 Block 1
   - Nachvollziehbar: every state decision includes a human-readable reason
========================================================= */

// ── Chain States (ordered from safest to most active) ──────────────────────
const ACTION_CHAIN_STATES = {
  idle:             { rank: 0, label: "Inaktiv",           description: "Kein aktiver Kettenzustand – Einstiegspunkt" },
  observing:        { rank: 1, label: "Beobachtend",       description: "System beobachtet Signale – keine Aktion geplant" },
  preparing:        { rank: 2, label: "Vorbereitend",      description: "Signal-Vorbereitung – Daten werden konsolidiert" },
  awaiting_signal:  { rank: 3, label: "Signal erwartet",   description: "Wartet auf menschliche Freigabe oder externe Daten" },
  executing:        { rank: 4, label: "Ausführungsintent",  description: "Handlungsabsicht erklärt – wartet auf menschliche Ausführung" },
  completed:        { rank: 5, label: "Abgeschlossen",     description: "Kette abgeschlossen – kein weiterer Schritt" },
  aborted:          { rank: 6, label: "Abgebrochen",       description: "Kette abgebrochen – Ablehnungs- oder Schließungsgrund" },
  escalated:        { rank: 7, label: "Eskaliert",         description: "Eskalation erforderlich – übergeordnete Prüfung nötig" },
};

/**
 * Compute the action-chain state for a single opportunity.
 *
 * Derives one chain state and supporting metadata from ALL existing signals:
 *   actionReadiness, approvalQueueEntry, decisionLayer, controlledApprovalFlow,
 *   auditTrace, governanceContext, exceptionFields, policyPlane, evidencePackage,
 *   tenantResourceGovernance, operationalResilience, autonomyLevel, driftDetection.
 *
 * Safety-first: guardrail / block / high-drift signals always win.
 *
 * @param {Object} opp – enriched opportunity with all Step 7-9 Block 1 fields
 * @returns {Object} actionChainState descriptor
 */
function computeActionChainState(opp) {
  const ar   = opp.actionReadiness       || {};
  const aq   = opp.approvalQueueEntry    || {};
  const dl   = opp.decisionLayer         || {};
  const caf  = opp.controlledApprovalFlow || {};
  const at   = opp.auditTrace            || {};
  const gov  = opp.governanceContext      || {};
  const exc  = opp.exceptionFields       || {};
  const pp   = opp.policyPlane           || {};
  const ep   = opp.evidencePackage       || {};
  const trg  = opp.tenantResourceGovernance || {};
  const or_  = opp.operationalResilience || {};
  const al   = opp.autonomyLevel         || {};
  const dd   = opp.driftDetection        || {};

  // ── 1. Hard-block gates (chainBlocked = true) ─────────────────────────
  // Any of these forces the chain into a blocked/safety state.
  const blockedByGuardrail  = at.blockedByGuardrail === true || exc.blockedByGuardrail === true;
  const hardGated           = trg.resourceGovernanceStatus === "hard_gated";
  const criticalGuarded     = or_.degradationMode === "critical_guarded";
  const policyInvalid       = (ep.policyValidity ?? opp.policyValidity) === "suspended";
  const sodConflict         = gov.separationOfDutiesViolation === true;
  const highDrift           = dd.driftLevel === "high";
  const criticalBaseline    = dd.baselineState === "critical";
  const manualAutonomy      = al.effectiveLevel === "manual";

  const chainBlocked = blockedByGuardrail || hardGated || criticalGuarded || policyInvalid || sodConflict;

  // ── 2. Build block-reason list (human-readable) ───────────────────────
  const blockReasons = [];
  if (blockedByGuardrail) blockReasons.push("Guardrail-Block aktiv");
  if (hardGated)          blockReasons.push("Ressource hart gesperrt (hard_gated)");
  if (criticalGuarded)    blockReasons.push("System kritisch abgesichert (critical_guarded)");
  if (policyInvalid)      blockReasons.push("Policy ungültig/suspendiert");
  if (sodConflict)        blockReasons.push("SoD-Konflikt erkannt");

  // ── 3. Conflict-risk assessment ───────────────────────────────────────
  // A conflict exists when growth/opportunity signals clash with risk/review signals.
  const hasGrowthSignal = (ar.actionReadiness === "proposal_ready" || ar.actionReadiness === "review_required")
                       && (dl.decisionStatus === "approved_candidate" || caf.approvalFlowStatus === "approved_pending_action");
  const hasRiskSignal   = highDrift || criticalBaseline || chainBlocked
                       || (trg.rateLimitRisk === "high") || (trg.backlogPressure === "elevated")
                       || (or_.operationalHealth === "critical" || or_.operationalHealth === "degraded")
                       || (pp.policyMode === "shadow" || pp.policyMode === "draft");

  const chainConflictRisk = hasGrowthSignal && hasRiskSignal;

  // ── 4. Safety mode ────────────────────────────────────────────────────
  // Safety mode is active when any block, high drift, or conflict is detected.
  const chainSafetyMode = chainBlocked || highDrift || criticalBaseline || chainConflictRisk
                        || manualAutonomy || (al.escalationRequired === true);

  // ── 5. Derive chain state from signal constellation ───────────────────
  let actionChainState  = "observing";
  let actionChainStage  = "signal_evaluation";
  let nextChainStep     = "Signale weiter beobachten";
  let escalationPath    = null;
  let chainBlockReason  = blockReasons.length > 0 ? blockReasons.join("; ") : null;

  // Priority 1: Blocked → escalated or aborted
  if (chainBlocked) {
    if (al.escalationRequired || exc.escalationLevel === "critical" || exc.escalationLevel === "high") {
      actionChainState = "escalated";
      actionChainStage = "blocked_escalation";
      nextChainStep    = "Eskalation an übergeordnete Instanz – manuelles Review erforderlich";
      escalationPath   = "governance_review";
    } else {
      actionChainState = "aborted";
      actionChainStage = "blocked_abort";
      nextChainStep    = "Kette blockiert – Blockierungsgrund beheben";
      escalationPath   = "manual_intervention";
    }
  }
  // Priority 2: High drift or critical baseline → escalated
  else if (highDrift || criticalBaseline) {
    actionChainState = "escalated";
    actionChainStage = "drift_escalation";
    nextChainStep    = "Drift-Eskalation – Baseline-Abweichung prüfen";
    escalationPath   = "drift_review";
  }
  // Priority 3: Decision = rejected / closed → aborted / completed
  else if (dl.decisionStatus === "rejected_candidate" || caf.closureStatus === "closed") {
    actionChainState = "aborted";
    actionChainStage = "decision_closed";
    nextChainStep    = "Fall abgeschlossen – keine weiteren Schritte";
    escalationPath   = null;
  }
  // Priority 4: Completed lifecycle
  else if (caf.actionLifecycleStage === "completed" || caf.approvalFlowStatus === "completed") {
    actionChainState = "completed";
    actionChainStage = "lifecycle_complete";
    nextChainStep    = "Kette abgeschlossen";
    escalationPath   = null;
  }
  // Priority 5: Awaiting review / approval / signal
  else if (dl.decisionStatus === "pending_review" || dl.decisionStatus === "needs_more_data"
        || caf.approvalFlowStatus === "awaiting_review" || caf.approvalFlowStatus === "waiting_for_more_data"
        || dl.decisionStatus === "deferred_review" || caf.approvalFlowStatus === "deferred") {
    actionChainState = "awaiting_signal";
    actionChainStage = "review_pending";
    nextChainStep    = dl.decisionStatus === "needs_more_data"
      ? "Weitere Daten erforderlich – beobachten"
      : "Review/Freigabe abwarten";
    escalationPath   = (exc.escalationLevel === "critical" || exc.escalationLevel === "high")
      ? "priority_review" : null;
  }
  // Priority 6: Approved + ready for manual action → executing (intent only)
  else if ((dl.decisionStatus === "approved_candidate" || caf.approvalFlowStatus === "approved_pending_action")
        && !chainConflictRisk) {
    actionChainState = "executing";
    actionChainStage = "approved_intent";
    nextChainStep    = "Handlungsabsicht erklärt – menschliche Ausführung ausstehend";
    escalationPath   = null;
  }
  // Priority 7: Proposal ready → preparing
  else if (ar.actionReadiness === "proposal_ready" || ar.actionReadiness === "review_required") {
    actionChainState = "preparing";
    actionChainStage = "proposal_consolidation";
    nextChainStep    = chainConflictRisk
      ? "Konflikt erkannt – Safety-First: Review priorisieren"
      : "Vorschlag konsolidieren – Review einleiten";
    escalationPath   = chainConflictRisk ? "conflict_resolution" : null;
  }
  // Priority 8: Monitor only / insufficient → observing
  else if (ar.actionReadiness === "monitor_only" || ar.actionReadiness === "insufficient_confidence") {
    actionChainState = "observing";
    actionChainStage = "monitoring";
    nextChainStep    = "Signale beobachten – keine Aktion geplant";
    escalationPath   = null;
  }
  // Default: idle
  else {
    actionChainState = "idle";
    actionChainStage = "no_signal";
    nextChainStep    = "Keine aktiven Signale";
    escalationPath   = null;
  }

  const stateInfo = ACTION_CHAIN_STATES[actionChainState] || ACTION_CHAIN_STATES.observing;

  return {
    actionChainState,
    actionChainStage,
    actionChainLabel: stateInfo.label,
    actionChainRank:  stateInfo.rank,
    nextChainStep,
    chainBlocked,
    chainBlockReason,
    escalationPath,
    chainConflictRisk,
    chainSafetyMode,
    chainBasis: "step9_block2",
  };
}

/**
 * Aggregate action-chain state distribution across opportunities.
 * For admin observability – no mutations, read-only summary.
 *
 * @param {Array} opps – array of enriched opportunities with actionChainState
 * @returns {Object} aggregate summary
 */
function computeActionChainSummary(opps) {
  if (!Array.isArray(opps) || opps.length === 0) {
    return {
      totalEvaluated: 0,
      stateDistribution: {},
      blockedCount: 0,
      escalatedCount: 0,
      conflictRiskCount: 0,
      safetyModeCount: 0,
      summaryBasis: "step9_block2",
    };
  }

  const dist = {};
  let blockedCount     = 0;
  let escalatedCount   = 0;
  let conflictRiskCount = 0;
  let safetyModeCount  = 0;

  for (const o of opps) {
    const acs = o.actionChainState || {};
    const state = acs.actionChainState || "idle";
    dist[state] = (dist[state] || 0) + 1;

    if (acs.chainBlocked)       blockedCount++;
    if (state === "escalated")  escalatedCount++;
    if (acs.chainConflictRisk)  conflictRiskCount++;
    if (acs.chainSafetyMode)    safetyModeCount++;
  }

  return {
    totalEvaluated:    opps.length,
    stateDistribution: dist,
    blockedCount,
    escalatedCount,
    conflictRiskCount,
    safetyModeCount,
    summaryBasis: "step9_block2",
  };
}

/* =========================================================
   STEP 9 BLOCK 3: CONTROLLED AUTO-PREPARATION LAYER
   (Kontrollierte automatische Vorbereitungsschicht)

   Builds the first controlled automatic preparation layer on top of
   the action-chain state-machine from Block 2.

   Purpose:
   - Derive ONE preparation type per opportunity from existing signals
   - Assign preparation priority, guarded state, window, and confirmation need
   - NO real execution – only pre-computation of what could be prepared
   - Safety-first: guardrail/block/drift signals always block auto-prep
   - Governance-compatible: all inputs from Step 7-9 Block 2

   Preparation types (ranked from safest / most blocked to most active):
     no_auto_prep             – no preparation eligible (idle/insufficient)
     guarded_hold             – preparation blocked by guardrail/safety gate
     review_packet            – review_required/pending_review → prepare review packet
     reassessment_scheduled   – deferred_review/needs_more_data → schedule reassessment
     followup_prep            – followUpNeeded/awaiting_signal → prepare follow-up
     proposal_card_ready      – proposal_ready → prepare proposal card
     manual_action_card_ready – approved_candidate → prepare manual action card

   Design principles:
   - Defensive: missing signals → no_auto_prep (safest)
   - Safety-first: any guardrail/block/drift resolves as guarded_hold
   - Risk-/review-/guardrail paths dominate opportunity-/growth paths
   - manualConfirmationRequired: always true for action-card and review types
   - No hidden automatic releases – system only PREPARES, never EXECUTES
========================================================= */

// ── Preparation Types (ordered from safest to most active) ─────────────────
const PREPARATION_TYPES = {
  no_auto_prep:             { rank: 0, label: "Keine Vorbereitung",         description: "Keine kontrollierte Vorbereitung möglich" },
  guarded_hold:             { rank: 1, label: "Gesicherter Halt",           description: "Vorbereitung durch Guardrail blockiert" },
  review_packet:            { rank: 2, label: "Review-Paket",               description: "Prüfungspaket wird vorbereitet – manuelle Freigabe erforderlich" },
  reassessment_scheduled:   { rank: 3, label: "Neubewertung geplant",       description: "Neubewertungs-Zeitfenster wird eingeplant" },
  followup_prep:            { rank: 4, label: "Follow-up Vorbereitung",     description: "Nachfolgeschritt wird vorbereitet" },
  proposal_card_ready:      { rank: 5, label: "Vorschlags-Karte bereit",    description: "Vorschlags-Karte für manuelle Prüfung vorbereitet" },
  manual_action_card_ready: { rank: 6, label: "Aktions-Karte bereit",       description: "Manuelle Aktionskarte vorbereitet – Bestätigung erforderlich" },
};

/**
 * Build a human-readable guarded reason string from hard-guard flags.
 * @private
 */
function _buildGuardedReason({ blockedByGuardrail, hardGated, criticalGuarded, policyInvalid, sodConflict, highDrift, criticalBaseline, escalationRequired, chainBlocked }) {
  const reasons = [];
  if (blockedByGuardrail) reasons.push("Guardrail-Block aktiv");
  if (hardGated)          reasons.push("Ressource hard-gated");
  if (criticalGuarded)    reasons.push("Kritischer Systemschutz aktiv");
  if (policyInvalid)      reasons.push("Policy ausgesetzt");
  if (sodConflict)        reasons.push("Rollentrennung verletzt");
  if (highDrift)          reasons.push("Hohe Signaldrift erkannt");
  if (criticalBaseline)   reasons.push("Kritische Baseline-Abweichung");
  if (escalationRequired) reasons.push("Eskalation erforderlich");
  if (chainBlocked)       reasons.push("Aktionskette blockiert");
  return reasons.length ? `Vorbereitung gesichert: ${reasons.join(", ")}` : "Vorbereitung gesichert";
}

/**
 * Build a human-readable suppression reason string from soft-suppress flags.
 * @private
 */
function _buildSuppressedReason({ highTenantPressure, criticalHealth, policyNotLive }) {
  const reasons = [];
  if (highTenantPressure) reasons.push("Hoher Tenant-/Ressourcendruck");
  if (criticalHealth)     reasons.push("Kritischer Systemzustand");
  if (policyNotLive)      reasons.push("Policy nicht im Live-Modus");
  return reasons.length ? `Vorbereitung unterdrückt: ${reasons.join(", ")}` : "Vorbereitung unterdrückt";
}

/**
 * Compute the controlled auto-preparation state for a single opportunity.
 *
 * Derives one preparation type and supporting metadata from ALL existing signals:
 *   actionChainState, actionReadiness, approvalQueueEntry, decisionLayer,
 *   controlledApprovalFlow, auditTrace, governanceContext, exceptionFields,
 *   policyPlane, evidencePackage, tenantResourceGovernance, operationalResilience,
 *   autonomyLevel, driftDetection.
 *
 * Safety-first: guardrail / block / high-drift signals always block auto-prep.
 *
 * @param {Object} opp – enriched opportunity with all Step 7-9 Block 2 fields
 * @returns {Object} controlledAutoPreparation descriptor
 */
function computeControlledAutoPreparation(opp) {
  const ar   = opp.actionReadiness        || {};
  const aq   = opp.approvalQueueEntry     || {};
  const dl   = opp.decisionLayer          || {};
  const caf  = opp.controlledApprovalFlow || {};
  const at   = opp.auditTrace             || {};
  const gov  = opp.governanceContext      || {};
  const exc  = opp.exceptionFields        || {};
  const pp   = opp.policyPlane            || {};
  const ep   = opp.evidencePackage        || {};
  const trg  = opp.tenantResourceGovernance || {};
  const or_  = opp.operationalResilience  || {};
  const al   = opp.autonomyLevel          || {};
  const dd   = opp.driftDetection         || {};
  const acs  = opp.actionChainState       || {};

  // ── 1. Hard-guard conditions (block all auto-prep) ───────────────────
  const blockedByGuardrail = at.blockedByGuardrail === true || exc.blockedByGuardrail === true;
  const hardGated          = trg.resourceGovernanceStatus === "hard_gated";
  const criticalGuarded    = or_.degradationMode === "critical_guarded";
  const policyInvalid      = (ep.policyValidity ?? opp.policyValidity) === "suspended";
  const sodConflict        = gov.separationOfDutiesViolation === true;
  const highDrift          = dd.driftLevel === "high";
  const criticalBaseline   = dd.baselineState === "critical";
  const escalationRequired    = al.escalationRequired === true;
  const chainBlocked       = acs.chainBlocked === true;

  const isGuarded = blockedByGuardrail || hardGated || criticalGuarded
                  || policyInvalid || sodConflict || highDrift
                  || criticalBaseline || escalationRequired || chainBlocked;

  // ── 2. Soft-suppress conditions (reduce but not fully block) ─────────
  const highTenantPressure = trg.rateLimitRisk === "high" || trg.backlogPressure === "elevated";
  const criticalHealth     = or_.operationalHealth === "critical";
  const policyNotLive      = pp.policyMode === "shadow" || pp.policyMode === "draft";
  const isSuppressed       = !isGuarded && (highTenantPressure || criticalHealth || policyNotLive);

  // ── 3. Derive preparation type ────────────────────────────────────────
  let preparationType            = "no_auto_prep";
  let preparationReason          = "Keine aktiven Signale für kontrollierte Vorbereitung";
  let preparationPriority        = "none";
  let preparationWindow          = null;
  let manualConfirmationRequired = false;

  if (isGuarded) {
    preparationType   = "guarded_hold";
    preparationReason = _buildGuardedReason({ blockedByGuardrail, hardGated, criticalGuarded, policyInvalid, sodConflict, highDrift, criticalBaseline, escalationRequired, chainBlocked });
    preparationWindow = "blocked";
    manualConfirmationRequired = true;
  } else if (isSuppressed) {
    preparationType   = "guarded_hold";
    preparationReason = _buildSuppressedReason({ highTenantPressure, criticalHealth, policyNotLive });
    preparationWindow = "blocked";
    manualConfirmationRequired = true;
  } else {
    // Priority 1 (highest risk path): review_required / pending_review → review_packet
    if (ar.actionReadiness === "review_required"
        || dl.decisionStatus === "pending_review"
        || caf.approvalFlowStatus === "awaiting_review") {
      preparationType   = "review_packet";
      preparationReason = "Review erforderlich – Prüfungspaket wird vorbereitet";
      preparationPriority = (exc.exceptionPriority === "critical" || exc.exceptionPriority === "high"
                             || aq.reviewPriority === "high") ? "high" : "medium";
      preparationWindow          = "immediate";
      manualConfirmationRequired = true;
    }
    // Priority 2: deferred_review / needs_more_data → reassessment_scheduled
    else if (dl.decisionStatus === "deferred_review"
             || dl.decisionStatus === "needs_more_data"
             || caf.approvalFlowStatus === "deferred") {
      preparationType            = "reassessment_scheduled";
      preparationReason          = "Prüfung zurückgestellt oder Datenbasis unvollständig – Neubewertung geplant";
      preparationPriority        = "low";
      preparationWindow          = "deferred";
      manualConfirmationRequired = false;
    }
    // Priority 3: approved_candidate / approved_pending_action → manual_action_card_ready
    else if (dl.decisionStatus === "approved_candidate"
             || caf.approvalFlowStatus === "approved_pending_action") {
      preparationType            = "manual_action_card_ready";
      preparationReason          = "Freigabekandidat bestätigt – Aktions-Karte für manuelle Ausführung vorbereitet";
      preparationPriority        = "high";
      preparationWindow          = "short_term";
      manualConfirmationRequired = true;
    }
    // Priority 4: followUpNeeded / awaiting_signal → followup_prep
    else if (caf.followUpNeeded === true
             || acs.actionChainState === "awaiting_signal") {
      preparationType            = "followup_prep";
      preparationReason          = "Nachfolgeschritt erforderlich – Follow-up wird vorbereitet";
      preparationPriority        = "medium";
      preparationWindow          = "short_term";
      manualConfirmationRequired = false;
    }
    // Priority 5: proposal_ready → proposal_card_ready
    else if (ar.actionReadiness === "proposal_ready"
             || caf.approvalFlowStatus === "proposal_available") {
      preparationType            = "proposal_card_ready";
      preparationReason          = "Strukturierter Vorschlag verfügbar – Vorschlags-Karte vorbereitet";
      preparationPriority        = "medium";
      preparationWindow          = "short_term";
      manualConfirmationRequired = false;
    }
  }

  // ── 4. Preparation guarded flag ───────────────────────────────────────
  const preparationGuarded = isGuarded || isSuppressed;

  // ── 5. Auto-preparation eligible ──────────────────────────────────────
  // Eligible only if not guarded and an actionable prep type was derived.
  const autoPreparationEligible = !preparationGuarded
    && preparationType !== "no_auto_prep"
    && preparationType !== "guarded_hold";

  // ── 6. Build preparation summary ─────────────────────────────────────
  const typeInfo     = PREPARATION_TYPES[preparationType] || PREPARATION_TYPES.no_auto_prep;
  const guardedNote  = preparationGuarded        ? " [Vorbereitung gesichert – keine automatische Ausführung]" : "";
  const confirmNote  = manualConfirmationRequired ? " [Manuelle Bestätigung erforderlich]" : "";
  const preparationSummary = `${typeInfo.label}: ${preparationReason}${guardedNote}${confirmNote}`;

  return {
    autoPreparationEligible,
    preparationType,
    preparationReason,
    preparationPriority,
    preparationGuarded,
    preparationWindow,
    manualConfirmationRequired,
    preparationSummary,
    preparationBasis: "step9_block3",
  };
}

/**
 * Aggregate controlled auto-preparation distribution across opportunities.
 * For admin observability – no mutations, read-only summary.
 *
 * @param {Array} opps – array of enriched opportunities with controlledAutoPreparation
 * @returns {Object} aggregate summary
 */
function computeControlledAutoPreparationSummary(opps) {
  if (!Array.isArray(opps) || opps.length === 0) {
    return {
      totalEvaluated:                  0,
      eligibleCount:                   0,
      guardedCount:                    0,
      manualConfirmationRequiredCount: 0,
      typeDistribution:                {},
      priorityDistribution:            {},
      preparationBasis:                "step9_block3",
    };
  }

  const typeDist     = {};
  const priorityDist = {};
  let eligibleCount                    = 0;
  let guardedCount                     = 0;
  let manualConfirmationRequiredCount  = 0;

  for (const o of opps) {
    const cap      = o.controlledAutoPreparation || {};
    const type     = cap.preparationType         || "no_auto_prep";
    const priority = cap.preparationPriority     || "none";

    typeDist[type]         = (typeDist[type]         || 0) + 1;
    priorityDist[priority] = (priorityDist[priority] || 0) + 1;

    if (cap.autoPreparationEligible)        eligibleCount++;
    if (cap.preparationGuarded)             guardedCount++;
    if (cap.manualConfirmationRequired)     manualConfirmationRequiredCount++;
  }

  return {
    totalEvaluated: opps.length,
    eligibleCount,
    guardedCount,
    manualConfirmationRequiredCount,
    typeDistribution:     typeDist,
    priorityDistribution: priorityDist,
    preparationBasis:     "step9_block3",
  };
}

/* =========================================================
   Step 9 – Block 4: Partial Auto-Execution under Policy
   ─────────────────────────────────────────────────────────
   Governance principle:
    - Block 3 = controlled PREPARATION (no execution)
    - Block 4 = first small INTERNAL execution steps allowed
      under strict policy constraints
   Safety guarantees:
    - No market / order / broker execution ever
    - No irreversible financial action
    - No policy mutation
    - No silent bypass of manualConfirmationRequired
    - Hard-guard conditions always dominate → autoExecutionEligible = false
    - executionScope is always "internal_only" or "none"
    - All derived execution types are reversible internal system steps
========================================================= */

// ── Execution Types (ordered safest → most active) ──────────────────────────
const EXECUTION_TYPES = {
  no_execution:                { rank: 0, label: "Keine Ausführung",            description: "Keine interne Mini-Ausführung möglich oder zulässig" },
  guarded_no_execution:        { rank: 1, label: "Ausführung blockiert",         description: "Ausführung durch Guardrail blockiert – kein interner Schritt" },
  suppress_noncritical_delivery: { rank: 2, label: "Nicht-kritische Zustellung unterdrückt", description: "Nicht-kritische Delivery intern unterdrückt – kein Marktschritt" },
  update_delivery_mode:        { rank: 3, label: "Zustellmodus aktualisiert",    description: "Interner Zustellmodus für Observation-Kandidat angepasst" },
  close_followup:              { rank: 4, label: "Follow-up intern geschlossen", description: "Follow-up intern abgeschlossen – kein Marktschritt" },
  mark_reassessment_waiting:   { rank: 5, label: "Neubewertung vorgemerkt",      description: "Kandidat intern als wartend auf Neubewertung markiert" },
  archive_closed_case:         { rank: 6, label: "Abgeschlossener Fall archiviert", description: "Abgeschlossener Fall intern archiviert – reversibel" },
  internal_status_advance:     { rank: 7, label: "Interner Status vorgerückt",   description: "Interner Lifecycle-Status vorgerückt – keine externe Aktion" },
  queue_manual_action_card:    { rank: 8, label: "Aktionskarte in Warteschlange", description: "Manuelle Aktionskarte intern eingereiht – Nutzer muss noch bestätigen" },
};

/**
 * Build a human-readable execution-blocked reason from hard-guard flags.
 * @private
 */
function _buildExecutionBlockedReason({ blockedByGuardrail, hardGated, criticalGuarded, policyInvalid, sodConflict, highDrift, criticalBaseline, escalationRequired, chainBlocked, manualConfirmationRequired }) {
  const reasons = [];
  if (blockedByGuardrail)          reasons.push("Guardrail-Block aktiv");
  if (hardGated)                   reasons.push("Ressource hard-gated");
  if (criticalGuarded)             reasons.push("Kritischer Systemschutz aktiv");
  if (policyInvalid)               reasons.push("Policy ausgesetzt");
  if (sodConflict)                 reasons.push("Rollentrennung verletzt");
  if (highDrift)                   reasons.push("Hohe Signaldrift erkannt");
  if (criticalBaseline)            reasons.push("Kritische Baseline-Abweichung");
  if (escalationRequired)          reasons.push("Eskalation erforderlich");
  if (chainBlocked)                reasons.push("Aktionskette blockiert");
  if (manualConfirmationRequired)  reasons.push("Manuelle Bestätigung ausstehend");
  return reasons.length ? `Ausführung blockiert: ${reasons.join(", ")}` : "Ausführung blockiert";
}

/**
 * Compute the partial auto-execution state for a single opportunity.
 *
 * Derives one safe internal execution type from ALL existing signals:
 *   controlledAutoPreparation, actionChainState, actionReadiness,
 *   controlledApprovalFlow, decisionLayer, auditTrace, governanceContext,
 *   policyPlane, evidencePackage, tenantResourceGovernance,
 *   operationalResilience, autonomyLevel, driftDetection.
 *
 * Safety-first: any hard-guard or manualConfirmationRequired always
 * results in autoExecutionEligible = false.
 *
 * executionScope is always "internal_only" – never market/order/broker.
 *
 * @param {Object} opp – enriched opportunity with all Step 9 Block 3 fields
 * @returns {Object} partialAutoExecution descriptor
 */
function computePartialAutoExecution(opp) {
  const cap  = opp.controlledAutoPreparation || {};
  const acs  = opp.actionChainState          || {};
  const ar   = opp.actionReadiness           || {};
  const caf  = opp.controlledApprovalFlow    || {};
  const dl   = opp.decisionLayer             || {};
  const at   = opp.auditTrace                || {};
  const gov  = opp.governanceContext         || {};
  const pp   = opp.policyPlane              || {};
  const ep   = opp.evidencePackage           || {};
  const trg  = opp.tenantResourceGovernance  || {};
  const or_  = opp.operationalResilience     || {};
  const al   = opp.autonomyLevel             || {};
  const dd   = opp.driftDetection            || {};

  // ── 1. Hard-guard conditions (block all auto-execution) ──────────────
  const blockedByGuardrail    = at.blockedByGuardrail === true || (opp.exceptionFields || {}).blockedByGuardrail === true;
  const hardGated             = trg.resourceGovernanceStatus === "hard_gated";
  const criticalGuarded       = or_.degradationMode === "critical_guarded";
  const policyInvalid         = (ep.policyValidity ?? opp.policyValidity) === "suspended";
  const sodConflict           = gov.separationOfDutiesViolation === true;
  const highDrift             = dd.driftLevel === "high";
  const criticalBaseline      = dd.baselineState === "critical";
  const escalationRequired    = al.escalationRequired === true;
  const chainBlocked          = acs.chainBlocked === true;
  // manualConfirmationRequired must never be silently bypassed
  const manualConfirmationRequired = cap.manualConfirmationRequired === true;

  const isBlocked = blockedByGuardrail || hardGated || criticalGuarded
                  || policyInvalid || sodConflict || highDrift
                  || criticalBaseline || escalationRequired || chainBlocked
                  || manualConfirmationRequired;

  // ── 2. Soft-guard conditions (defensive-only execution scope) ─────────
  const highTenantPressure = trg.rateLimitRisk === "high" || trg.backlogPressure === "elevated";
  const criticalHealth     = or_.operationalHealth === "critical";
  const policyNotLive      = pp.policyMode === "shadow" || pp.policyMode === "draft";
  const chainSafetyMode    = acs.chainSafetyMode === true;
  const isSoftGuarded      = !isBlocked && (highTenantPressure || criticalHealth || policyNotLive || chainSafetyMode);

  // ── 3. Derive safe internal execution type ────────────────────────────
  let autoExecutionType   = "no_execution";
  let autoExecutionReason = "Keine aktiven Signale für Partial-Auto-Execution";
  let executionIntent     = null;

  if (isBlocked) {
    autoExecutionType   = "guarded_no_execution";
    autoExecutionReason = _buildExecutionBlockedReason({
      blockedByGuardrail, hardGated, criticalGuarded, policyInvalid,
      sodConflict, highDrift, criticalBaseline, escalationRequired,
      chainBlocked, manualConfirmationRequired,
    });
    executionIntent = "blocked";
  } else if (isSoftGuarded) {
    // Only the safest possible internal step is allowed under soft-guard
    autoExecutionType   = "suppress_noncritical_delivery";
    autoExecutionReason = "Soft-Guard aktiv – nur nicht-kritische Delivery-Unterdrückung erlaubt";
    executionIntent     = "suppress_delivery";
  } else {
    // Derive from preparation type + chain state + decision state
    const prepType   = cap.preparationType;
    const chainState = acs.actionChainState;
    const decision   = dl.decisionStatus;
    const approval   = caf.approvalFlowStatus;
    const closureStatus = caf.closureStatus;
    const followUpNeeded = caf.followUpNeeded;

    if (closureStatus === "closed" || decision === "rejected_candidate") {
      // Case is fully closed – archive it internally
      autoExecutionType   = "archive_closed_case";
      autoExecutionReason = "Fall abgeschlossen oder abgelehnt – internes Archivieren sicher";
      executionIntent     = "archive";
    } else if (followUpNeeded === true && chainState === "awaiting_signal") {
      // Follow-up is pending and chain awaits signal – close follow-up internally
      autoExecutionType   = "close_followup";
      autoExecutionReason = "Follow-up ausstehend + Aktionskette wartend – Follow-up intern schließen";
      executionIntent     = "close_followup";
    } else if (prepType === "reassessment_scheduled"
               || decision === "deferred_review"
               || decision === "needs_more_data"
               || approval === "deferred") {
      // Case needs reassessment – mark it as waiting
      autoExecutionType   = "mark_reassessment_waiting";
      autoExecutionReason = "Neubewertung erforderlich – Kandidat intern als wartend markieren";
      executionIntent     = "mark_waiting";
    } else if (prepType === "manual_action_card_ready"
               || decision === "approved_candidate"
               || approval === "approved_pending_action") {
      // Manual action card is prepared – queue it for manual confirmation
      autoExecutionType   = "queue_manual_action_card";
      autoExecutionReason = "Freigabekandidat bereit – Aktionskarte intern einreihen (Nutzer muss noch bestätigen)";
      executionIntent     = "queue_card";
    } else if (prepType === "followup_prep"
               || chainState === "preparing"
               || chainState === "observing") {
      // System is in observation/preparation – advance internal delivery mode
      autoExecutionType   = "update_delivery_mode";
      autoExecutionReason = "Beobachtungs-/Vorbereitungsphase – internen Zustellmodus anpassen";
      executionIntent     = "update_mode";
    } else if (ar.actionReadiness === "monitor_only"
               || chainState === "idle") {
      // Monitor-only or idle – suppress non-critical delivery
      autoExecutionType   = "suppress_noncritical_delivery";
      autoExecutionReason = "Monitor-only / inaktive Kette – nicht-kritische Zustellung intern unterdrücken";
      executionIntent     = "suppress_delivery";
    } else if (chainState === "completed" || closureStatus === "completed") {
      // Chain completed – advance internal status lifecycle
      autoExecutionType   = "internal_status_advance";
      autoExecutionReason = "Aktionskette abgeschlossen – internen Lifecycle-Status vorrücken";
      executionIntent     = "advance_status";
    }
  }

  // ── 4. Execution eligibility and safety ───────────────────────────────
  const autoExecutionGuarded   = isBlocked || isSoftGuarded;
  const autoExecutionEligible  = !isBlocked
    && autoExecutionType !== "no_execution"
    && autoExecutionType !== "guarded_no_execution";

  const autoExecutionSafety =
    isBlocked    ? "blocked" :
    isSoftGuarded ? "guarded" :
    autoExecutionType === "no_execution" ? "none" :
    "safe";

  // ── 5. Execution scope – always internal_only ─────────────────────────
  const executionScope = autoExecutionEligible ? "internal_only" : "none";

  // ── 6. Build execution summary ────────────────────────────────────────
  const typeInfo       = EXECUTION_TYPES[autoExecutionType] || EXECUTION_TYPES.no_execution;
  const guardedNote    = autoExecutionGuarded    ? " [Ausführung gesichert – kein Marktschritt]" : "";
  const eligibleNote   = autoExecutionEligible   ? " [Intern ausführbar]" : "";
  const executionSummary = `${typeInfo.label}: ${autoExecutionReason}${guardedNote}${eligibleNote}`;

  return {
    autoExecutionEligible,
    autoExecutionType,
    autoExecutionReason,
    autoExecutionGuarded,
    autoExecutionSafety,
    executionIntent,
    executionScope,
    executionSummary,
    executionBasis: "step9_block4",
  };
}

/**
 * Aggregate partial auto-execution distribution across opportunities.
 * For admin observability – no mutations, read-only summary.
 *
 * @param {Array} opps – array of enriched opportunities with partialAutoExecution
 * @returns {Object} aggregate summary
 */
function computePartialAutoExecutionSummary(opps) {
  if (!Array.isArray(opps) || opps.length === 0) {
    return {
      totalEvaluated:    0,
      eligibleCount:     0,
      guardedCount:      0,
      blockedCount:      0,
      typeDistribution:  {},
      safetyDistribution: {},
      executionBasis:    "step9_block4",
    };
  }

  const typeDist   = {};
  const safetyDist = {};
  let eligibleCount = 0;
  let guardedCount  = 0;
  let blockedCount  = 0;

  for (const o of opps) {
    const pae    = o.partialAutoExecution || {};
    const type   = pae.autoExecutionType    || "no_execution";
    const safety = pae.autoExecutionSafety  || "none";

    typeDist[type]     = (typeDist[type]     || 0) + 1;
    safetyDist[safety] = (safetyDist[safety] || 0) + 1;

    if (pae.autoExecutionEligible)                 eligibleCount++;
    if (pae.autoExecutionGuarded)                  guardedCount++;
    if (pae.autoExecutionSafety === "blocked")      blockedCount++;
  }

  return {
    totalEvaluated: opps.length,
    eligibleCount,
    guardedCount,
    blockedCount,
    typeDistribution:   typeDist,
    safetyDistribution: safetyDist,
    executionBasis:     "step9_block4",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 9 Block 5 – Recovery, Stop, Override & Promotion Safety Layer
//
// Governance principle:
//   Blocks 1–4 established autonomy levels, drift detection, action-chain
//   states, controlled preparation and safe internal mini-execution.
//   Block 5 adds the first structured safety-control layer: clear rules for
//   when the system should stop, degrade, require operator intervention,
//   allow controlled recovery/resume, and block unsafe promotions to higher
//   autonomy.
//
//   Crucially:
//   - No real market/broker/order execution.
//   - No new workflow or execution engine.
//   - No real kill-switch infrastructure – killSwitchScope is only a
//     classification token.
//   - overrideAllowed is only a governance assertion, NOT a mutation action.
//   - All derived purely from existing Block 1–4 + upstream governance signals.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kill-switch scope classification tokens.
 * Purely descriptive – no real infrastructure kill-switch is built.
 *   none   – no safety concern requiring scope classification
 *   case   – single-case level isolation is sufficient
 *   tenant – tenant-wide caution should be considered
 *   global – platform-wide defensive posture should be considered
 */
const KILL_SWITCH_SCOPES = {
  none:   { rank: 0, label: "Kein Kill-Switch-Scope" },
  case:   { rank: 1, label: "Fall-Ebene (Einzelfall-Isolation)" },
  tenant: { rank: 2, label: "Tenant-Ebene (Tenant-weite Vorsicht)" },
  global: { rank: 3, label: "Globale Ebene (Plattform-weiter Defensiv-Modus)" },
};

/**
 * Derive a single Recovery, Stop, Override & Promotion Safety context for one
 * opportunity. All inputs are consumed defensively (safe defaults on null/undefined).
 *
 * @param {Object} ctx – enriched opportunity object carrying all Block 1–4 layers
 * @returns {Object} recoverySafetyLayer fields
 */
function computeRecoverySafetyLayer(ctx) {
  if (!ctx || typeof ctx !== "object") {
    return {
      stopEligible:                 false,
      overrideAllowed:              false,
      killSwitchScope:              "none",
      recoveryAction:               null,
      rollbackSuggested:            false,
      promotionBlocked:             false,
      degradeRequired:              false,
      resumeAllowed:                false,
      operatorInterventionRequired: false,
      safetyControlSummary:         "Kein Kontext verfügbar – Sicherheitslayer nicht ableitbar",
      safetyBasis:                  "step9_block5",
    };
  }

  // ── Destructure key upstream signals ─────────────────────────────────────
  const gc  = ctx.governanceContext            || {};
  const pp  = ctx.policyPlane                  || {};
  const ep  = ctx.evidencePackage              || {};
  const trg = ctx.tenantResourceGovernance     || {};
  const or_ = ctx.operationalResilience        || {};
  const al  = ctx.autonomyLevel                || {};
  const dd  = ctx.driftDetection               || {};
  const acs = ctx.actionChainState             || {};
  const cap = ctx.controlledAutoPreparation    || {};
  const pae = ctx.partialAutoExecution         || {};
  const at  = ctx.auditTrace                   || {};
  const dl  = ctx.decisionLayer                || {};
  const caf = ctx.controlledApprovalFlow       || {};

  // ── 1. Hard-block signals ─────────────────────────────────────────────────
  const blockedByGuardrail    = at.blockedByGuardrail === true || ctx.blockedByGuardrail === true;
  const hardGated             = gc.hardGated === true;
  const criticalGuarded       = or_.degradationMode === "critical_guarded";
  const policyInvalid         = ep.policyValidity === "suspended" || pp.policyStatus === "shadow";
  const sodConflict           = gc.sodConflict === true;
  const criticalBaseline      = dd.baselineState === "critical";
  const highDrift             = dd.driftLevel === "high";
  const escalationRequired    = al.escalationRequired === true;
  const chainBlocked          = acs.chainBlocked === true;
  const executionBlocked      = pae.autoExecutionSafety === "blocked";
  const manualConfirmRequired = cap.manualConfirmationRequired === true;

  // ── 2. Elevated-pressure signals ─────────────────────────────────────────
  const mediumDrift           = dd.driftLevel === "medium";
  const criticalHealth        = or_.operationalHealth === "critical";
  const degradedHealth        = or_.operationalHealth === "degraded";
  const highTenantPressure    = trg.rateLimitRisk === "high" || trg.backlogPressure === "elevated";
  const resourceGuardrail     = trg.resourceGuardrail === "active";
  const policyNotLive         = pp.policyMode === "draft";
  const chainEscalated        = acs.actionChainState === "escalated";
  const awaitingSignal        = acs.actionChainState === "awaiting_signal";
  const tenantMaxRestricted   = trg.tenantMaxAutonomyLevel === "restricted";

  // ── 3. stopEligible ───────────────────────────────────────────────────────
  // True when hard-block conditions indicate the current flow must stop.
  const stopEligible = blockedByGuardrail || hardGated || criticalGuarded
    || policyInvalid || sodConflict || criticalBaseline || highDrift
    || escalationRequired || chainBlocked || executionBlocked;

  // ── 4. degradeRequired ────────────────────────────────────────────────────
  // True when the system should operate in degraded/reduced mode.
  const degradeRequired = criticalHealth || criticalBaseline || hardGated
    || policyInvalid || criticalGuarded || (highDrift && blockedByGuardrail);

  // ── 5. promotionBlocked ───────────────────────────────────────────────────
  // Blocks promotion to a higher autonomy level when unsafe conditions exist.
  const promotionBlocked = stopEligible || degradeRequired || mediumDrift
    || highTenantPressure || resourceGuardrail || tenantMaxRestricted
    || policyNotLive || chainEscalated || degradedHealth;

  // ── 6. resumeAllowed ─────────────────────────────────────────────────────
  // Resume to normal flow is allowed only when all hard conditions are clear.
  const resumeAllowed = !stopEligible && !degradeRequired
    && or_.recoveryState !== "at_risk"
    && or_.operationalHealth !== "critical"
    && !chainBlocked
    && !blockedByGuardrail;

  // ── 7. operatorInterventionRequired ──────────────────────────────────────
  const operatorInterventionRequired = stopEligible || escalationRequired
    || criticalHealth || policyInvalid || sodConflict || chainEscalated;

  // ── 8. recoveryAction ────────────────────────────────────────────────────
  // Descriptive safe-next-step hint when the flow is blocked or awaiting.
  let recoveryAction = null;
  if (chainBlocked || chainEscalated) {
    recoveryAction = "Aktionskette entsperren oder Eskalation auflösen – Operateurprüfung erforderlich";
  } else if (awaitingSignal) {
    recoveryAction = "Auf fehlendes Signal warten – kein automatischer Fortschritt";
  } else if (caf.approvalFlowStatus === "waiting_for_more_data") {
    recoveryAction = "Fehlende Daten ergänzen – dann erneut prüfen";
  } else if (policyInvalid) {
    recoveryAction = "Policy-Freigabe / -Reaktivierung erforderlich – Operator einbeziehen";
  } else if (blockedByGuardrail) {
    recoveryAction = "Guardrail-Bedingung klären und Sperre administrativ aufheben";
  } else if (sodConflict) {
    recoveryAction = "SoD-Konflikt auflösen – keine automatische Maßnahme erlaubt";
  } else if (criticalHealth || criticalGuarded) {
    recoveryAction = "Betriebszustand stabilisieren – Systembetrieb im kritischen Modus";
  } else if (criticalBaseline || highDrift) {
    recoveryAction = "Drift-Signale normalisieren – Baseline-Recovery abwarten";
  }

  // ── 9. rollbackSuggested ─────────────────────────────────────────────────
  // Suggest rollback when a recovery is needed and execution was active.
  const wasExecuting = acs.actionChainState === "executing"
    || acs.actionChainState === "completed"
    || pae.autoExecutionEligible === true;
  const rollbackSuggested = recoveryAction !== null && wasExecuting;

  // ── 10. overrideAllowed ──────────────────────────────────────────────────
  // Purely a governance assertion – not a mutation action.
  // Allowed when: no hard SoD conflict, no hard-gated lock, operator context.
  const overrideAllowed = !sodConflict && !hardGated && !criticalGuarded
    && gc.callerRole !== "viewer";

  // ── 11. killSwitchScope (classification only, no real infra) ─────────────
  let killSwitchScope = "none";
  if (stopEligible || operatorInterventionRequired) {
    const globalCondition  = (sodConflict || criticalGuarded || policyInvalid)
      && (criticalHealth || criticalBaseline);
    const tenantCondition  = highTenantPressure || resourceGuardrail || tenantMaxRestricted;
    if (globalCondition) {
      killSwitchScope = "global";
    } else if (tenantCondition) {
      killSwitchScope = "tenant";
    } else {
      killSwitchScope = "case";
    }
  }

  // ── 12. safetyControlSummary ─────────────────────────────────────────────
  const summaryParts = [];
  if (stopEligible)                 summaryParts.push("🛑 Stop möglich");
  if (degradeRequired)              summaryParts.push("⬇️ Degradierung erforderlich");
  if (operatorInterventionRequired) summaryParts.push("👷 Operator-Eingriff nötig");
  if (promotionBlocked)             summaryParts.push("🚫 Promotion blockiert");
  if (resumeAllowed)                summaryParts.push("✅ Resume erlaubt");
  if (rollbackSuggested)            summaryParts.push("↩️ Rollback empfohlen");
  if (overrideAllowed)              summaryParts.push("🔓 Override strukturell erlaubt");
  if (recoveryAction)               summaryParts.push(`🔄 Recovery: ${recoveryAction}`);
  if (killSwitchScope !== "none")   summaryParts.push(`⚡ Kill-Switch-Scope: ${killSwitchScope}`);

  const safetyControlSummary = summaryParts.length
    ? summaryParts.join(" · ")
    : "✅ Keine aktiven Sicherheits-/Stoppbedingungen";

  return {
    stopEligible,
    overrideAllowed,
    killSwitchScope,
    recoveryAction,
    rollbackSuggested,
    promotionBlocked,
    degradeRequired,
    resumeAllowed,
    operatorInterventionRequired,
    safetyControlSummary,
    safetyBasis: "step9_block5",
  };
}

/**
 * Aggregate recovery-safety distribution across opportunities.
 * For admin observability – no mutations, read-only summary.
 *
 * @param {Array} opps – array of enriched opportunities with recoverySafetyLayer
 * @returns {Object} aggregate summary
 */
function computeRecoverySafetyLayerSummary(opps) {
  if (!Array.isArray(opps) || opps.length === 0) {
    return {
      totalEvaluated:                0,
      stopEligibleCount:             0,
      degradeRequiredCount:          0,
      promotionBlockedCount:         0,
      operatorInterventionCount:     0,
      resumeAllowedCount:            0,
      rollbackSuggestedCount:        0,
      overrideAllowedCount:          0,
      killSwitchScopeDistribution:   {},
      safetyBasis:                   "step9_block5",
    };
  }

  let stopEligibleCount         = 0;
  let degradeRequiredCount      = 0;
  let promotionBlockedCount     = 0;
  let operatorInterventionCount = 0;
  let resumeAllowedCount        = 0;
  let rollbackSuggestedCount    = 0;
  let overrideAllowedCount      = 0;
  const scopeDist               = {};

  for (const o of opps) {
    const rsl = o.recoverySafetyLayer || {};
    if (rsl.stopEligible)                 stopEligibleCount++;
    if (rsl.degradeRequired)              degradeRequiredCount++;
    if (rsl.promotionBlocked)             promotionBlockedCount++;
    if (rsl.operatorInterventionRequired) operatorInterventionCount++;
    if (rsl.resumeAllowed)                resumeAllowedCount++;
    if (rsl.rollbackSuggested)            rollbackSuggestedCount++;
    if (rsl.overrideAllowed)              overrideAllowedCount++;
    const scope = rsl.killSwitchScope || "none";
    scopeDist[scope] = (scopeDist[scope] || 0) + 1;
  }

  return {
    totalEvaluated:                opps.length,
    stopEligibleCount,
    degradeRequiredCount,
    promotionBlockedCount,
    operatorInterventionCount,
    resumeAllowedCount,
    rollbackSuggestedCount,
    overrideAllowedCount,
    killSwitchScopeDistribution:   scopeDist,
    safetyBasis:                   "step9_block5",
  };
}

// ── Step 10 Block 2: Attention Management / Delivery Intelligence ─────────────
// Aggregates attention/delivery state from existing per-opp signals.
// No new scoring, no new data access – reads from already-computed opp fields.

/**
 * Derive a delivery mode from a single opportunity's existing signals.
 * Conservative rules: risk/guardrail signals dominate; defaults to monitor_silently.
 *
 * @param {object} opp – opportunity object with existing governance/exception/follow-up fields
 * @returns {string} deliveryMode
 */
function _deriveOppDeliveryMode(opp) {
  const rsl         = opp.recoverySafetyLayer       ?? null;
  const audit       = opp.auditTrace                ?? null;
  const opRes       = opp.operationalResilience     ?? null;
  const exFields    = opp.exceptionFields           ?? null;
  const attnLevel   = opp.userAttentionLevel        ?? null;
  const followUp    = opp.followUpContext           ?? null;

  const isBlocked  = audit?.blockedByGuardrail === true
    || rsl?.stopEligible === true
    || rsl?.degradeRequired === true
    || opRes?.degradationMode === "critical_guarded";
  const isCritical = attnLevel === "critical"
    || exFields?.exceptionPriority === "critical"
    || rsl?.operatorInterventionRequired === true;
  const isHigh     = attnLevel === "high" || exFields?.exceptionPriority === "high";
  const isOverdue  = followUp?.followUpStatus === "overdue" || followUp?.reviewDue === true;
  const isPending  = followUp?.followUpStatus === "pending" || followUp?.reminderEligible === true;

  if (isBlocked || isCritical || isOverdue) return "interrupt_now";
  if (isHigh)                               return "include_in_briefing";
  if (attnLevel === "medium" || isPending)  return "bundle_for_digest";
  return "monitor_silently";
}

/**
 * Step 10 Block 2: Compute an Attention-Management / Delivery-Intelligence aggregate
 * across a set of opportunity objects.
 *
 * Reads from already-computed per-opp fields:
 *   - userAttentionLevel, exceptionFields, auditTrace, recoverySafetyLayer,
 *     operationalResilience, followUpContext
 *
 * @param {Array} opps – array of opportunity objects (already scored/classified)
 * @returns {object} attention/delivery aggregate summary
 */
function computeAttentionDeliveryMeta(opps) {
  if (!Array.isArray(opps) || opps.length === 0) {
    return {
      totalEvaluated:        0,
      interruptNowCount:     0,
      includeInBriefingCount: 0,
      bundleForDigestCount:  0,
      monitorSilentlyCount:  0,
      shouldInterruptCount:  0,
      bundleCandidateCount:  0,
      quietModeCount:        0,
      criticalUrgencyCount:  0,
      highUrgencyCount:      0,
      deliveryModeDistribution: {},
      attentionDeliveryBasis: "step10_block2",
    };
  }

  let interruptNowCount      = 0;
  let includeInBriefingCount = 0;
  let bundleForDigestCount   = 0;
  let monitorSilentlyCount   = 0;
  let criticalUrgencyCount   = 0;
  let highUrgencyCount       = 0;
  const modeDist             = {};

  for (const o of opps) {
    // Use already-computed attentionDeliveryOutput if present; derive otherwise.
    const mode = o.attentionDeliveryOutput?.deliveryMode ?? _deriveOppDeliveryMode(o);
    modeDist[mode] = (modeDist[mode] || 0) + 1;
    if (mode === "interrupt_now")       interruptNowCount++;
    else if (mode === "include_in_briefing") includeInBriefingCount++;
    else if (mode === "bundle_for_digest")   bundleForDigestCount++;
    else                                     monitorSilentlyCount++;

    const urgency = o.attentionDeliveryOutput?.deliveryUrgency ?? null;
    if (urgency === "critical")                          criticalUrgencyCount++;
    else if (urgency === "high" || urgency === "medium") highUrgencyCount++;
  }

  return {
    totalEvaluated:          opps.length,
    interruptNowCount,
    includeInBriefingCount,
    bundleForDigestCount,
    monitorSilentlyCount,
    shouldInterruptCount:    interruptNowCount,
    bundleCandidateCount:    bundleForDigestCount,
    quietModeCount:          monitorSilentlyCount,
    criticalUrgencyCount,
    highUrgencyCount,
    deliveryModeDistribution: modeDist,
    attentionDeliveryBasis:  "step10_block2",
  };
}

// ── Step 10 Block 3: Autonomy Preview / Companion Trust Layer ─────────────────
// Aggregates autonomy-state and trust-preview distribution from per-opp signals.
// No new scoring, no new data access – reads from already-computed opp fields.

/**
 * Named autonomy states for the preview layer.
 * Each state maps directly to a recognisable plain-language label for users.
 * Priority order (first match wins): stopped → blocked → awaiting_confirmation →
 *   guarded → internal_update_only → prepared → suggestion
 */
const AUTONOMY_STATES = {
  stopped:              "Gestoppt",
  blocked:              "Blockiert",
  awaiting_confirmation: "Bestätigung nötig",
  guarded:              "Gebremst",
  internal_update_only: "Internes Update",
  prepared:             "Vorbereitet",
  suggestion:           "Vorschlag",
};

/**
 * Derive the autonomy state for a single opportunity from its existing signals.
 * Conservative rules: safety/stop signals dominate; defaults to suggestion.
 *
 * @param {object} opp – opportunity object with already-computed governance fields
 * @returns {string} autonomyState key (matches AUTONOMY_STATES)
 */
function _deriveOppAutonomyState(opp) {
  const rsl  = opp.recoverySafetyLayer        ?? null;
  const audit = opp.auditTrace                ?? null;
  const acs  = opp.actionChainState           ?? null;
  const cap  = opp.controlledAutoPreparation  ?? null;
  const pae  = opp.partialAutoExecution       ?? null;
  const al   = opp.autonomyLevel              ?? null;
  const dd   = opp.driftDetection             ?? null;
  const opRes = opp.operationalResilience     ?? null;
  const pp   = opp.policyPlane                ?? null;

  if (rsl?.stopEligible || rsl?.degradeRequired)                                       return "stopped";
  if (audit?.blockedByGuardrail || acs?.chainBlocked)                                 return "blocked";
  if (rsl?.operatorInterventionRequired || cap?.manualConfirmationRequired
      || pp?.requiresSecondApproval)                                                   return "awaiting_confirmation";
  if (rsl?.promotionBlocked || cap?.preparationGuarded || pae?.autoExecutionGuarded
      || opRes?.degradationMode === "critical_guarded"
      || dd?.driftLevel === "high" || al?.effectiveLevel === "manual")                 return "guarded";
  if (pae?.autoExecutionEligible && pae?.executionScope === "internal_only"
      && pae?.autoExecutionSafety === "safe")                                          return "internal_update_only";
  if (cap?.autoPreparationEligible)                                                    return "prepared";
  return "suggestion";
}

/**
 * Step 10 Block 3: Compute an Autonomy Preview / Trust aggregate across
 * a set of opportunity objects.
 *
 * Reads from already-computed per-opp fields:
 *   - recoverySafetyLayer, auditTrace, actionChainState,
 *     controlledAutoPreparation, partialAutoExecution, autonomyLevel,
 *     driftDetection, operationalResilience, policyPlane, autonomyPreview
 *
 * @param {Array} opps – array of opportunity objects (already scored/classified)
 * @returns {object} autonomy-preview aggregate summary
 */
function computeAutonomyPreviewSummary(opps) {
  if (!Array.isArray(opps) || opps.length === 0) {
    return {
      totalEvaluated:              0,
      stateDistribution:           {},
      stoppedCount:                0,
      blockedCount:                0,
      awaitingConfirmationCount:   0,
      guardedCount:                0,
      internalUpdateOnlyCount:     0,
      preparedCount:               0,
      suggestionCount:             0,
      needsUserConfirmationCount:  0,
      stopAvailableCount:          0,
      confidenceBandDistribution:  {},
      highConfidenceCount:         0,
      mediumConfidenceCount:       0,
      lowConfidenceCount:          0,
      autonomyPreviewBasis:        "step10_block3",
    };
  }

  let stoppedCount              = 0;
  let blockedCount              = 0;
  let awaitingConfirmationCount = 0;
  let guardedCount              = 0;
  let internalUpdateOnlyCount   = 0;
  let preparedCount             = 0;
  let suggestionCount           = 0;
  let needsUserConfirmationCount = 0;
  let stopAvailableCount        = 0;
  let highConfidenceCount       = 0;
  let mediumConfidenceCount     = 0;
  let lowConfidenceCount        = 0;
  const stateDist               = {};
  const bandDist                = {};

  for (const o of opps) {
    const state = o.autonomyPreview?.autonomyState ?? _deriveOppAutonomyState(o);
    stateDist[state] = (stateDist[state] || 0) + 1;
    if (state === "stopped")               stoppedCount++;
    else if (state === "blocked")          blockedCount++;
    else if (state === "awaiting_confirmation") awaitingConfirmationCount++;
    else if (state === "guarded")          guardedCount++;
    else if (state === "internal_update_only") internalUpdateOnlyCount++;
    else if (state === "prepared")         preparedCount++;
    else                                   suggestionCount++;

    if (o.autonomyPreview?.needsUserConfirmation || o.recoverySafetyLayer?.operatorInterventionRequired
        || o.controlledAutoPreparation?.manualConfirmationRequired) {
      needsUserConfirmationCount++;
    }
    if (o.autonomyPreview?.stopAvailable || o.recoverySafetyLayer?.stopEligible) {
      stopAvailableCount++;
    }

    const band = o.autonomyPreview?.confidenceBand ?? null;
    if (band) {
      bandDist[band] = (bandDist[band] || 0) + 1;
      if (band === "high")        highConfidenceCount++;
      else if (band === "medium") mediumConfidenceCount++;
      else if (band === "low")    lowConfidenceCount++;
    }
  }

  return {
    totalEvaluated:              opps.length,
    stateDistribution:           stateDist,
    stoppedCount,
    blockedCount,
    awaitingConfirmationCount,
    guardedCount,
    internalUpdateOnlyCount,
    preparedCount,
    suggestionCount,
    needsUserConfirmationCount,
    stopAvailableCount,
    confidenceBandDistribution:  bandDist,
    highConfidenceCount,
    mediumConfidenceCount,
    lowConfidenceCount,
    autonomyPreviewBasis:        "step10_block3",
  };
}

/**
 * Step 10 Block 4: Aggregate adaptive UX / feedback distribution from all opportunities.
 * Reads from per-opp adaptiveUXOutput fields – no new logic, no DB calls.
 *
 * @param {object[]} opps – array of opportunity objects (post-scanner, with adaptiveUXOutput)
 * @returns {object} adaptive UX aggregate summary
 */
function computeAdaptiveUXSummary(opps) {
  if (!Array.isArray(opps) || opps.length === 0) {
    return { totalEvaluated: 0, adaptiveUXBasis: "step10_block4" };
  }

  const profileDist = {};
  const densityDist = {};
  const toneDist    = {};
  const fitDist     = {};
  let coachCount     = 0;
  let executiveCount = 0;
  let analystCount   = 0;
  let calmCount      = 0;
  let alertCount     = 0;
  let highDensityCount = 0;
  let lowDensityCount  = 0;

  for (const o of opps) {
    const aux = o.adaptiveUXOutput ?? null;
    if (!aux) continue;
    const { styleProfile, communicationDensity, adaptiveTone, outputFit } = aux;
    if (styleProfile) {
      profileDist[styleProfile] = (profileDist[styleProfile] || 0) + 1;
      if (styleProfile === "coach")     coachCount++;
      else if (styleProfile === "executive") executiveCount++;
      else if (styleProfile === "analyst")   analystCount++;
    }
    if (communicationDensity) {
      densityDist[communicationDensity] = (densityDist[communicationDensity] || 0) + 1;
      if (communicationDensity === "high") highDensityCount++;
      else if (communicationDensity === "low") lowDensityCount++;
    }
    if (adaptiveTone) {
      toneDist[adaptiveTone] = (toneDist[adaptiveTone] || 0) + 1;
      if (adaptiveTone === "calm")  calmCount++;
      else if (adaptiveTone === "alert") alertCount++;
    }
    if (outputFit) {
      fitDist[outputFit] = (fitDist[outputFit] || 0) + 1;
    }
  }

  return {
    totalEvaluated:           opps.length,
    styleProfileDistribution: profileDist,
    densityDistribution:      densityDist,
    toneDistribution:         toneDist,
    outputFitDistribution:    fitDist,
    coachCount,
    executiveCount,
    analystCount,
    calmCount,
    alertCount,
    highDensityCount,
    lowDensityCount,
    adaptiveUXBasis:          "step10_block4",
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
  AUTONOMY_LEVELS,
  AUTONOMY_LEVEL_CAP,
  computeAutonomyLevelContext,
  computeDriftDetectionBasis,
  computeAutonomyDriftSummary,
  ACTION_CHAIN_STATES,
  computeActionChainState,
  computeActionChainSummary,
  PREPARATION_TYPES,
  computeControlledAutoPreparation,
  computeControlledAutoPreparationSummary,
  EXECUTION_TYPES,
  computePartialAutoExecution,
  computePartialAutoExecutionSummary,
  KILL_SWITCH_SCOPES,
  computeRecoverySafetyLayer,
  computeRecoverySafetyLayerSummary,
  computeAttentionDeliveryMeta,
  AUTONOMY_STATES,
  computeAutonomyPreviewSummary,
  computeAdaptiveUXSummary,
};
