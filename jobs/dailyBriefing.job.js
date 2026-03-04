"use strict";

require("dotenv").config();

const logger = require("../utils/logger");

const { getMarketData } = require("../services/marketService");
const { acquireLock } = require("../services/jobLock.repository");

const {
  getActiveBriefingUsers,
  getUserWatchlistSymbols,
  createNotification,
  getActiveDeviceTokens,
} = require("../services/notifications.repository");

const { generateBriefingText } = require("../services/gemini.service");

// Optional: Push (erst aktivieren, wenn du firebase-admin eingerichtet hast)
let sendPushToTokens = null;
try {
  ({ sendPushToTokens } = require("../services/push.service"));
} catch (_) {
  sendPushToTokens = null;
}

function buildFactsFromMarket(stocks) {
  // Fakten kurz und klar
  const lines = [];
  for (const s of stocks) {
    const cp = (s.changesPercentage !== null && s.changesPercentage !== undefined)
      ? Number(s.changesPercentage).toFixed(2) + "%"
      : "unbekannt";

    const score = (s.hqsScore !== null && s.hqsScore !== undefined)
      ? String(s.hqsScore)
      : "unbekannt";

    const regime = s.regime || "unbekannt";

    lines.push(
      `- ${s.symbol}: Kurs ${s.price ?? "?"}, Änderung ${cp}, HQS ${score}, Marktphase ${regime}.`
    );
  }
  return lines.join("\n");
}

async function runDailyBriefing() {
  // Lock: verhindert Doppel-Run
  const won = await acquireLock("daily_briefing_job", 15 * 60);
  if (!won) {
    logger.warn("Daily briefing skipped (lock held)");
    return;
  }

  logger.info("Daily briefing job started");

  const users = await getActiveBriefingUsers(500);

  for (const u of users) {
    try {
      const watch = await getUserWatchlistSymbols(u.id, 50);
      const symbols = watch.map(x => x.symbol);

      if (!symbols.length) continue;

      // Marketdaten DB-first holen (einzeln pro Symbol)
      const stocks = [];
      for (const sym of symbols) {
        const arr = await getMarketData(sym);
        if (Array.isArray(arr) && arr[0]) stocks.push(arr[0]);
      }

      const facts = buildFactsFromMarket(stocks);

      const text = await generateBriefingText({
        userName: u.email || "Nutzer",
        symbols,
        facts
      });

      // Titel aus der Antwort ziehen
      const titleMatch = text.match(/^TITEL:\s*(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : "Dein Morgen-Update";

      // Body ist der ganze Text (einfach)
      const body = text;

      const saved = await createNotification({
        userId: u.id,
        title,
        body,
        kind: "daily_briefing",
      });

      // Optional Push
      if (u.wants_push && typeof sendPushToTokens === "function") {
        const tokens = await getActiveDeviceTokens(u.id, 10);
        if (tokens.length) {
          await sendPushToTokens(tokens, {
            title,
            body: "Dein Morgen-Update ist da. Tippe zum Öffnen.",
            url: "/notifications"
          });
        }
      }

      logger.info("Briefing created", { userId: u.id, notificationId: saved.id });
    } catch (e) {
      logger.error("Briefing error", { userId: u.id, message: e.message });
    }
  }

  logger.info("Daily briefing job finished");
}

// Wenn direkt ausgeführt:
if (require.main === module) {
  runDailyBriefing()
    .then(() => process.exit(0))
    .catch((e) => {
      logger.error("Daily briefing fatal", { message: e.message });
      process.exit(1);
    });
}

module.exports = { runDailyBriefing };
