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
};
