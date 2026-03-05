"use strict";

require("dotenv").config();

const logger = require("../utils/logger");
const { acquireLock } = require("../services/jobLock.repository");

const { discoverStocks } = require("../services/discoveryEngine.service");
const { getActiveBriefingUsers, createDiscoveryNotification } = require("../services/notifications.repository");

async function runDiscoveryNotify() {
  // Lock: verhindert Doppel-Run bei Deploy/Cron
  const won = await acquireLock("discovery_notify_job", 20 * 60);
  if (!won) {
    logger.warn("Discovery notify skipped (lock held)");
    return;
  }

  logger.info("Discovery notify job started");

  // 1) Hidden Winner Pick berechnen (einmal pro Job)
  const picks = await discoverStocks(1);
  const pick = Array.isArray(picks) && picks[0] ? picks[0] : null;

  if (!pick) {
    logger.warn("No discovery pick found");
    return;
  }

  logger.info("Discovery pick selected", { symbol: pick.symbol, confidence: pick.confidence });

  // 2) Aktive User laden
  const users = await getActiveBriefingUsers(500);
  if (!users.length) {
    logger.warn("No active users found");
    return;
  }

  // 3) Notification pro User speichern (1 pro Tag geschützt)
  let created = 0;
  let skipped = 0;

  for (const u of users) {
    try {
      const userId = u.id;

      const r = await createDiscoveryNotification({
        userId,
        pick,
      });

      if (r?.inserted) created++;
      else skipped++;
    } catch (e) {
      logger.error("Discovery notify user failed", { userId: u?.id, message: e.message });
    }
  }

  logger.info("Discovery notify job finished", {
    users: users.length,
    created,
    skipped,
    pick: pick.symbol,
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
