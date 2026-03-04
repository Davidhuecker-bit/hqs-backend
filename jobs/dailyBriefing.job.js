"use strict";

require("dotenv").config();

const logger = require("../utils/logger");
const { acquireLock } = require("../services/jobLock.repository");
const { getMarketData } = require("../services/marketService");

const {
  getActiveBriefingUsers,
  getUserWatchlistSymbols,
  createNotification,
} = require("../services/notifications.repository");

// ✅ OpenAI
const { generateBriefingText } = require("../services/openai.service");

function buildFactsFromMarket(stocks) {
  const lines = [];
  for (const s of stocks) {
    const cp =
      s.changesPercentage !== null && s.changesPercentage !== undefined
        ? Number(s.changesPercentage).toFixed(2) + "%"
        : "unbekannt";

    const score =
      s.hqsScore !== null && s.hqsScore !== undefined ? String(s.hqsScore) : "unbekannt";

    const regime = s.regime || "unbekannt";

    lines.push(
      `- ${s.symbol}: Kurs ${s.price ?? "?"}, Änderung ${cp}, HQS ${score}, Marktphase ${regime}.`
    );
  }
  return lines.join("\n");
}

async function runDailyBriefing() {
  const won = await acquireLock("daily_briefing_job", 15 * 60);
  if (!won) {
    logger.warn("Daily briefing skipped (lock held)");
    return;
  }

  logger.info("Daily briefing job started");

  // 1) Aktive User laden
  const users = await getActiveBriefingUsers(500);
  if (!users.length) {
    logger.warn("No active briefing users found");
    return;
  }

  let createdCount = 0;
  let skippedCount = 0;

  for (const u of users) {
    try {
      const userId = u.id;

      // 2) Watchlist je User laden
      const wl = await getUserWatchlistSymbols(userId, 50);
      const symbols = wl.map((x) => x.symbol).filter(Boolean);

      if (!symbols.length) {
        skippedCount++;
        logger.warn("User has no watchlist, skipping", { userId });
        continue;
      }

      // 3) Marktdaten holen (DB-first steckt ja in getMarketData)
      const stocks = [];
      for (const sym of symbols) {
        const arr = await getMarketData(sym);
        if (Array.isArray(arr) && arr[0]) stocks.push(arr[0]);
      }

      if (!stocks.length) {
        skippedCount++;
        logger.warn("No market data for user symbols, skipping", { userId });
        continue;
      }

      // 4) Fakten bauen
      const facts = buildFactsFromMarket(stocks);

      // 5) OpenAI Text erstellen
      const text = await generateBriefingText({
        userName: "Nutzer",
        symbols,
        facts,
      });

      const titleMatch = text.match(/^TITEL:\s*(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : "Dein Morgen-Update";

      // 6) In-App Notification speichern
      await createNotification({
        userId,
        title,
        body: text,
        kind: "daily_briefing",
      });

      createdCount++;
      logger.info("Daily briefing created", { userId });
    } catch (e) {
      // Wichtig: pro User abfangen, damit Job weiterläuft
      logger.error("Daily briefing user failed", {
        userId: u?.id,
        message: e.message,
      });
    }
  }

  logger.info("Daily briefing job finished", {
    created: createdCount,
    skipped: skippedCount,
    users: users.length,
  });
}

if (require.main === module) {
  runDailyBriefing()
    .then(() => process.exit(0))
    .catch((e) => {
      logger.error("Daily briefing fatal", { message: e.message });
      process.exit(1);
    });
}

module.exports = { runDailyBriefing };
