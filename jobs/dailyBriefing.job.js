"use strict";

require("dotenv").config();

const logger = require("../utils/logger");
const { acquireLock } = require("../services/jobLock.repository");
const { getMarketData } = require("../services/marketService");

const { createNotification } = require("../services/notifications.repository");

// ✅ OpenAI statt Gemini
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

  // V1: Demo-User userId=1
  const userId = 1;
  const symbols = ["AAPL", "MSFT", "NVDA", "AMD"];

  const stocks = [];
  for (const sym of symbols) {
    const arr = await getMarketData(sym);
    if (Array.isArray(arr) && arr[0]) stocks.push(arr[0]);
  }

  const facts = buildFactsFromMarket(stocks);

  const text = await generateBriefingText({
    userName: "Nutzer",
    symbols,
    facts,
  });

  const titleMatch = text.match(/^TITEL:\s*(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "Dein Morgen-Update";

  await
