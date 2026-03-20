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
} = require("../services/notifications.repository");

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

    // 3) Notification pro User speichern (1 pro Tag geschützt)
    // Step 5: Single DB query to find all users who have this symbol on their watchlist.
    // This avoids an N+1 query pattern (one query per user) for the watchlist check.
    let usersWithPickOnWatchlist = new Set();
    try {
      usersWithPickOnWatchlist = await getUserIdsWithSymbolOnWatchlist(pick.symbol);
    } catch (e) {
      logger.warn("Discovery notify: watchlist batch check failed (ignored)", { message: e.message });
    }

    let created = 0;
    let skipped = 0;

    for (const u of users) {
      try {
        const userId = u.id;
        const onWatchlist = usersWithPickOnWatchlist.has(Number(userId));
        const r = await createDiscoveryNotification({ userId, pick, onWatchlist });
        if (r?.inserted) created++;
        else skipped++;
      } catch (e) {
        logger.error("Discovery notify user failed", { userId: u?.id, message: e.message });
      }
    }

    return {
      processedCount: created,
      skippedCount: skipped,
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
