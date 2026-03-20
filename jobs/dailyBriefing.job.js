"use strict";

require("dotenv").config();

const logger = require("../utils/logger");
const { acquireLock } = require("../services/jobLock.repository");
const { runJob } = require("../utils/jobRunner");
const { getMarketData } = require("../services/marketService");

const {
  getActiveBriefingUsers,
  getUserWatchlistSymbols,
  createNotificationOncePerDay, // ✅ NEW (anti spam)
} = require("../services/notifications.repository");

// ✅ OpenAI
const { generateBriefingText } = require("../services/openai.service");

// Read stored discovery picks (written by discoveryNotify job) – no re-scoring
let getLatestDiscoveryPick = null;
try {
  ({ getLatestDiscoveryPick } = require("../services/discoveryEngine.service"));
} catch (_) {
  getLatestDiscoveryPick = null;
}

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

function buildHiddenWinnerBlock(pick) {
  if (!pick) return "";

  const sym = String(pick.symbol || "").toUpperCase();
  const conf = pick.confidence !== null && pick.confidence !== undefined ? `${pick.confidence}/100` : "unbekannt";
  const reason = pick.reason ? String(pick.reason) : "unbekannt";
  const regime = pick.regime ? String(pick.regime) : "neutral";

  return `
HIDDEN WINNER (Wochen/Monate):
- Kandidat: ${sym}
- Sicherheit: ${conf}
- Marktphase: ${regime}
- Warum: ${reason}

Hinweis: Keine Kauf-/Verkaufsempfehlung. Nur Analyse.
`.trim();
}

async function runDailyBriefing() {
  return runJob("dailyBriefing", async () => {
    const won = await acquireLock("daily_briefing_job", 15 * 60);
    if (!won) {
      logger.warn("[job:dailyBriefing] skipped – lock held");
      return { processedCount: 0, skippedCount: 0 };
    }

    // Load stored discovery pick (produced by discoveryNotify job) – DB-first, no re-scoring
    let hiddenWinner = null;
    if (typeof getLatestDiscoveryPick === "function") {
      try {
        const picks = await getLatestDiscoveryPick(1);
        hiddenWinner = Array.isArray(picks) && picks[0] ? picks[0] : null;
        if (hiddenWinner) logger.info("Hidden winner pick loaded", { symbol: hiddenWinner.symbol });
      } catch (e) {
        logger.warn("Hidden winner pick failed (ignored)", { message: e.message });
      }
    }

  // 1) Aktive User laden
    const users = await getActiveBriefingUsers(500);
    if (!users.length) {
      logger.warn("No active briefing users found");
      return { processedCount: 0, skippedCount: 0 };
    }

  let createdCount = 0;
  let skippedCount = 0;
  let alreadyToday = 0;

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

      // ✅ NEW: Hidden Winner Block anhängen (wenn vorhanden)
      const body = hiddenWinner ? `${text}\n\n${buildHiddenWinnerBlock(hiddenWinner)}` : text;

      // ✅ 6) In-App Notification speichern (nur 1x pro Tag pro User)
      const created = await createNotificationOncePerDay({
        userId,
        title,
        body,
        kind: "daily_briefing",
      });

      if (created.inserted) {
        createdCount++;
        logger.info("Daily briefing created", { userId });
      } else {
        alreadyToday++;
        logger.info("Daily briefing skipped (already today)", { userId });
      }
    } catch (e) {
      // Wichtig: pro User abfangen, damit Job weiterläuft
      logger.error("Daily briefing user failed", {
        userId: u?.id,
        message: e.message,
      });
    }
  }

  return {
    processedCount: createdCount,
    skippedCount: skippedCount + alreadyToday,
    created: createdCount,
    alreadyToday,
    users: users.length,
  };
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
