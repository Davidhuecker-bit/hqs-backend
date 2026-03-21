"use strict";

require("dotenv").config();

const logger = require("../utils/logger");
const { runJob } = require("../utils/jobRunner");
const { acquireLock } = require("../services/jobLock.repository");

const { discoverStocks } = require("../services/discoveryEngine.service");
const {
  getActiveBriefingUsers,
  getUserIdsWithSymbolOnWatchlist,
  createDiscoveryNotification,
  linkFollowUpOutcome,
  computeUserState,
  getReminderEligibleNotifications,
  computeUserPreferenceHints,        // ✅ Step 6 Block 2: per-user preference hints
} = require("../services/notifications.repository");

/**
 * Derive a minimal Action-Orchestration for a discovery pick.
 * Discovery picks don't go through getTopOpportunities(), so we derive
 * deliveryMode and escalationLevel directly from pick confidence/score.
 *
 * Also attaches actionReadiness (Step 7 Block 1) so the notification gate
 * can suppress monitor_only picks and prioritise review_required / proposal_ready.
 *
 * Step 7 Block 2: attaches reviewBucket so the delivery loop can log and
 * observe which queue tier each pick falls into. No execution change.
 *
 * Step 7 Block 3: attaches decisionStatus so the delivery loop can apply
 * cleaner gating: pending_review / needs_more_data are not pushed aggressively;
 * approved_candidate picks receive priority delivery with guardrails.
 *
 * Rules (first match wins):
 *   high confidence (≥75) or high score (≥75) → notification + high escalation + review_required → risk_review
 *   on watchlist or decent confidence (≥55) or decent score (≥55) → notification + medium + proposal_ready → proposal_bucket
 *   else → none (skip push – low-signal pick not worth notifying) + monitor_only
 */
function _derivePickOrchestration(pick, onWatchlist) {
  const confidence = Number(pick?.confidence ?? 0);
  const score = Number(pick?.discoveryScore ?? pick?.opportunityScore ?? pick?.hqsScore ?? 0);

  if (confidence >= 75 || score >= 75) {
    // Step 7 Block 3: high-signal review cases – derive decision status from data quality
    const hasStrongData = confidence >= 75 && score >= 70;
    const decisionStatus = hasStrongData ? "approved_candidate" : "pending_review";
    // Step 7 Block 4: derive controlled approval flow status from decision state
    const approvalFlowStatus = hasStrongData ? "approved_pending_action" : "awaiting_review";
    const postDecisionAction = hasStrongData ? "ready_for_manual_action" : "pending_human_review";
    // Step 7 Block 5: derive audit/safety signals
    const governanceStatus = "review_controlled";
    const traceReason = hasStrongData
      ? "Starke Datenbasis und konsistente Signale – manuelle Bestätigung empfohlen"
      : "Freigabepflichtig – manuelle Prüfung erforderlich";
    const safetyFlags = ["approval:required", "bucket:risk_review"];
    return {
      deliveryMode: "notification",
      escalationLevel: "high",
      followUpNeeded: true,
      actionReadiness: "review_required",
      reviewBucket: "risk_review",
      decisionStatus,
      approvalFlowStatus,
      postDecisionAction,
      governanceStatus,
      traceReason,
      safetyFlags,
      blockedByGuardrail: false,
      // Step 8 Block 2: exception classification for operating console
      exceptionType: hasStrongData ? "risk_review_pending" : "review_required",
      exceptionPriority: "high",
      // Step 8 Block 1: governance classification for high-signal picks
      governanceContext: {
        requiredRole: "operator",
        separationOfDutiesFlag: true,
        approvalActionAllowed: true,
        policyMutationAllowed: false,
        governanceBasis: "step8_block1",
      },
    };
  }
  if (onWatchlist || confidence >= 55 || score >= 55) {
    return {
      deliveryMode: "notification",
      escalationLevel: "medium",
      followUpNeeded: false,
      actionReadiness: "proposal_ready",
      reviewBucket: "proposal_bucket",
      decisionStatus: null,
      approvalFlowStatus: "proposal_available",
      postDecisionAction: "user_may_review_proposal",
      governanceStatus: "proposal_available",
      traceReason: "Strukturierter Vorschlag verfügbar – Nutzer entscheidet eigenständig",
      safetyFlags: [],
      blockedByGuardrail: false,
      // Step 8 Block 2: exception classification for operating console
      exceptionType: "normal",
      exceptionPriority: "low",
      // Step 8 Block 1: governance classification for proposal-level picks
      governanceContext: {
        requiredRole: "viewer",
        separationOfDutiesFlag: false,
        approvalActionAllowed: false,
        policyMutationAllowed: false,
        governanceBasis: "step8_block1",
      },
    };
  }
  return {
    deliveryMode: "none",
    escalationLevel: "none",
    followUpNeeded: false,
    actionReadiness: "monitor_only",
    reviewBucket: null,
    decisionStatus: null,
    approvalFlowStatus: null,
    postDecisionAction: null,
    governanceStatus: "observation",
    traceReason: "Signal zu schwach für aktive Zustellung – nur Beobachtung",
    safetyFlags: [],
    blockedByGuardrail: false,
    // Step 8 Block 2: exception classification for operating console
    exceptionType: "normal",
    exceptionPriority: "low",
    // Step 8 Block 1: governance classification for monitor-only picks
    governanceContext: {
      requiredRole: "viewer",
      separationOfDutiesFlag: false,
      approvalActionAllowed: false,
      policyMutationAllowed: false,
      governanceBasis: "step8_block1",
    },
  };
}

// Step 5 Follow-up/Reminder: max open reminder-eligible notifications before gating new delivery
const MAX_OPEN_REMINDERS_THRESHOLD = 3;

async function runDiscoveryNotify() {
  return runJob("discoveryNotify", async () => {
    // Lock: verhindert Doppel-Run bei Deploy/Cron
    const won = await acquireLock("discovery_notify_job", 20 * 60);
    if (!won) {
      logger.warn("[job:discoveryNotify] skipped – lock held");
      return { processedCount: 0 };
    }

    // 1) Hidden Winner Pick berechnen (einmal pro Job)
    const picks = await discoverStocks(1);
    const pick = Array.isArray(picks) && picks[0] ? picks[0] : null;

    if (!pick) {
      logger.warn("No discovery pick found");
      return { processedCount: 0 };
    }

    logger.info("Discovery pick selected", { symbol: pick.symbol, confidence: pick.confidence });

    // 2) Aktive User laden
    const users = await getActiveBriefingUsers(500);
    if (!users.length) {
      logger.warn("No active users found");
      return { processedCount: 0 };
    }

    // 3) Batch-check: welche User haben dieses Symbol auf der Watchlist
    let usersWithPickOnWatchlist = new Set();
    try {
      usersWithPickOnWatchlist = await getUserIdsWithSymbolOnWatchlist(pick.symbol);
    } catch (e) {
      logger.warn("Discovery notify: watchlist batch check failed (ignored)", { message: e.message });
    }

    let created = 0;
    let skipped = 0;
    let gatedOut = 0;

    for (const u of users) {
      try {
        const userId = u.id;
        const onWatchlist = usersWithPickOnWatchlist.has(Number(userId));

        // Action-Orchestration: derive per-user delivery intent
        const orchestration = _derivePickOrchestration(pick, onWatchlist);

        // Gate: skip notification for low-signal picks (deliveryMode=none)
        if (orchestration.deliveryMode === "none") {
          gatedOut++;
          continue;
        }

        // Step 7 Block 1: gate monitor_only picks from push notifications.
        // Only review_required and proposal_ready picks are worth a push.
        if (orchestration.actionReadiness === "monitor_only") {
          gatedOut++;
          logger.info("discoveryNotify: user gated (action_readiness=monitor_only)", {
            userId, actionReadiness: orchestration.actionReadiness,
          });
          continue;
        }

        // Step 7 Block 3: decision-status aware gating – pending_review and needs_more_data
        // picks should not be pushed aggressively; downgrade to non-aggressive delivery.
        // approved_candidate picks keep priority delivery but remain gated by guardrails.
        if (orchestration.decisionStatus === "needs_more_data") {
          gatedOut++;
          logger.info("discoveryNotify: user gated (decisionStatus=needs_more_data)", {
            userId, decisionStatus: orchestration.decisionStatus,
          });
          continue;
        }

        // Step 7 Block 4: controlled approval flow gating – deferred and waiting_for_more_data
        // should not be pushed aggressively. awaiting_review gets softer delivery.
        // ready_for_manual_action (approved_pending_action) gets priority delivery with guardrails.
        if (orchestration.approvalFlowStatus === "deferred") {
          gatedOut++;
          logger.info("discoveryNotify: user gated (approvalFlowStatus=deferred)", {
            userId, approvalFlowStatus: orchestration.approvalFlowStatus,
          });
          continue;
        }
        if (orchestration.approvalFlowStatus === "waiting_for_more_data") {
          gatedOut++;
          logger.info("discoveryNotify: user gated (approvalFlowStatus=waiting_for_more_data)", {
            userId, approvalFlowStatus: orchestration.approvalFlowStatus,
          });
          continue;
        }
        if (orchestration.approvalFlowStatus === "closed") {
          gatedOut++;
          logger.info("discoveryNotify: user gated (approvalFlowStatus=closed)", {
            userId, approvalFlowStatus: orchestration.approvalFlowStatus,
          });
          continue;
        }

        // Step 8 Block 2: defensive exception-hub gate – blockedByGuardrail picks must not
        // be delivered automatically.  Log for operating-console observability.
        if (orchestration.blockedByGuardrail === true) {
          gatedOut++;
          logger.info("discoveryNotify: user gated (exception=guardrail_blocked)", {
            userId, symbol: pick.symbol,
            exceptionType: orchestration.exceptionType || "guardrail_blocked",
          });
          continue;
        }

        // Step 7 Block 2: log the review bucket for observability (no gate change).
        // review_required → risk_review bucket (high-priority, follow-up needed)
        // proposal_ready  → proposal_bucket (medium priority, no follow-up required)
        if (orchestration.reviewBucket) {
          logger.info("discoveryNotify: pick assigned to review bucket", {
            userId, symbol: pick.symbol,
            actionReadiness: orchestration.actionReadiness,
            reviewBucket: orchestration.reviewBucket,
            escalationLevel: orchestration.escalationLevel,
            decisionStatus: orchestration.decisionStatus || null,
            approvalFlowStatus: orchestration.approvalFlowStatus || null,
            postDecisionAction: orchestration.postDecisionAction || null,
            // Step 7 Block 5: audit/safety context for observability
            governanceStatus: orchestration.governanceStatus || null,
            traceReason: orchestration.traceReason || null,
            safetyFlags: orchestration.safetyFlags?.length ? orchestration.safetyFlags : null,
            // Step 8 Block 1: governance context for observability
            governanceRole: orchestration.governanceContext?.requiredRole || null,
            sodFlag: orchestration.governanceContext?.separationOfDutiesFlag || false,
            // Step 8 Block 2: exception context for operating-console observability
            exceptionType: orchestration.exceptionType || null,
            exceptionPriority: orchestration.exceptionPriority || null,
          });
        }

        // Step 5 User-State: skip discovery notification when user already has a large
        // attention backlog (≥5 unseen) AND pick is not high-escalation – prevents spam
        // for users who are not engaging with notifications.
        if (orchestration.escalationLevel !== "high") {
          try {
            const state = await computeUserState(userId);
            if (state && state.attentionBacklog >= 5) {
              gatedOut++;
              logger.info("discoveryNotify: user gated (attention backlog)", { userId, attentionBacklog: state.attentionBacklog });
              continue;
            }
          } catch (stateErr) {
            // Non-fatal: proceed with delivery if state check fails
            logger.warn("discoveryNotify: computeUserState failed (ignored)", { userId, message: stateErr.message });
          }

          // Step 5 Follow-up/Reminder: skip new discovery notification when the user
          // already has ≥3 open reminder-eligible notifications – they should resolve
          // existing follow-ups before receiving more. High-escalation bypasses this.
          try {
            const reminders = await getReminderEligibleNotifications(userId, MAX_OPEN_REMINDERS_THRESHOLD);
            if (reminders.length >= MAX_OPEN_REMINDERS_THRESHOLD) {
              gatedOut++;
              logger.info("discoveryNotify: user gated (open follow-ups)", { userId, openReminders: reminders.length });
              continue;
            }
          } catch (reminderErr) {
            logger.warn("discoveryNotify: getReminderEligibleNotifications failed (ignored)", { userId, message: reminderErr.message });
          }

          // Step 6 Block 2 / Block 4: User preference hints – gate on notificationFatigue
          // and log explorationAffinity for observability. Uses one CTE query instead of
          // two separate computeProductSignals calls. Defensively non-fatal.
          // Step 6 Block 3: High explorationAffinity overrides the notificationFatigue
          // gate for discovery content – users who actively engage with discovery picks
          // should still receive them even when fatigued by other notification types.
          //
          // GUARDRAIL (Block 4): this gate only runs when escalationLevel === "medium".
          // High-escalation picks (confidence ≥ 75 or score ≥ 75) bypass all gates,
          // including notificationFatigue, because high-signal content must always reach
          // the user. See outer guard: `if (orchestration.escalationLevel !== "high")`.
          if (orchestration.escalationLevel === "medium") {
            try {
              const hints = await computeUserPreferenceHints(userId, { days: 30 });
              const explorationOverrides = hints.explorationAffinity === "high";
              if (hints.sampleSize >= 5 && hints.notificationFatigue === "high" && !explorationOverrides) {
                gatedOut++;
                logger.info("discoveryNotify: user gated (high notification fatigue)", {
                  userId, notificationFatigue: hints.notificationFatigue, sampleSize: hints.sampleSize,
                });
                continue;
              }
              if (hints.explorationAffinity) {
                logger.info("discoveryNotify: user exploration affinity", {
                  userId, explorationAffinity: hints.explorationAffinity, explorationOverrides,
                });
              }
            } catch (sigErr) {
              logger.warn("discoveryNotify: computeUserPreferenceHints failed (ignored)", { userId, message: sigErr.message });
            }
          }
        }

        const r = await createDiscoveryNotification({ userId, pick, onWatchlist });
        if (r?.inserted) {
          created++;
          // Step 5: link follow_up_outcome to pattern_key so the notification
          // can be connected to its measurable outcome when verification runs.
          if (r.id && pick?.patternKey) {
            try {
              await linkFollowUpOutcome(r.id, `pattern:${pick.patternKey}`);
            } catch (linkErr) {
              logger.warn("discoveryNotify: linkFollowUpOutcome failed (ignored)", { message: linkErr.message });
            }
          }
        } else {
          skipped++;
        }
      } catch (e) {
        logger.error("Discovery notify user failed", { userId: u?.id, message: e.message });
      }
    }

    logger.info("Discovery notify complete", {
      created, skipped, gatedOut, users: users.length, pick: pick.symbol,
    });

    return {
      processedCount: created,
      skippedCount: skipped,
      gatedOutCount: gatedOut,
      users: users.length,
      pick: pick.symbol,
    };
  });
}

if (require.main === module) {
  runDiscoveryNotify()
    .then(() => process.exit(0))
    .catch((e) => {
      logger.error("Discovery notify fatal", { message: e.message });
      process.exit(1);
    });
}

module.exports = { runDiscoveryNotify };
