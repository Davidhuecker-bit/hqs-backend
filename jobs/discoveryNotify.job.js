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
} = require("../services/notifications.repository");

/**
 * Derive a minimal Action-Orchestration for a discovery pick.
 * Discovery picks don't go through getTopOpportunities(), so we derive
 * deliveryMode and escalationLevel directly from pick confidence/score.
 *
 * Rules (first match wins):
 *   high confidence (≥75) or high score (≥75) → notification + high escalation
 *   on watchlist or decent confidence (≥55) or decent score (≥55) → notification + medium
 *   else → none (skip push – low-signal pick not worth notifying)
 */
function _derivePickOrchestration(pick, onWatchlist) {
  const confidence = Number(pick?.confidence ?? 0);
  const score = Number(pick?.discoveryScore ?? pick?.opportunityScore ?? pick?.hqsScore ?? 0);

  if (confidence >= 75 || score >= 75) {
    return { deliveryMode: "notification", escalationLevel: "high", followUpNeeded: true };
  }
  if (onWatchlist || confidence >= 55 || score >= 55) {
    return { deliveryMode: "notification", escalationLevel: "medium", followUpNeeded: false };
  }
  return { deliveryMode: "none", escalationLevel: "none", followUpNeeded: false };
}

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
