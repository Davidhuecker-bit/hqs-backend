"use strict";

require("dotenv").config();

const logger = require("../utils/logger");
const { acquireLock, initJobLocksTable } = require("../services/jobLock.repository");
const { runJob } = require("../utils/jobRunner");
const { getMarketData } = require("../services/marketService");

const {
  getActiveBriefingUsers,
  getUserWatchlistSymbols,
  createNotificationOncePerDay, // ✅ NEW (anti spam)
  computeUserAttentionLevel,    // ✅ Step 5: attention-level priority
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

// ── Attention level ordering ─────────────────────────────────────────────────
const ATTENTION_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

// Thresholds for stock attention classification based on daily price change and HQS score.
// A significant DROP (≤ -5%) on a scored stock (≥ 55) triggers a high-attention risk alert.
// A significant GAIN (≥ +5%) on a strong-score stock (≥ 65) triggers a medium/high alert.
const ATTENTION_DROP_THRESHOLD     = -5;   // % daily change (negative)
const ATTENTION_GAIN_THRESHOLD     =  5;   // % daily change (positive)
const ATTENTION_DROP_MIN_SCORE     = 55;   // min HQS score for drop alert
const ATTENTION_GAIN_MIN_SCORE     = 65;   // min HQS score for gain alert

/**
 * Compute a simple attention level for a stock using available market data.
 * Uses hqsScore and changesPercentage (already in getMarketData response).
 * No extra DB calls.
 */
function _stockAttentionLevel(stock) {
  const change = Math.abs(Number(stock.changesPercentage) || 0);
  const score  = Number(stock.hqsScore) || 50;

  // High: significant drop on scored stock → risk alert
  if ((Number(stock.changesPercentage) || 0) <= ATTENTION_DROP_THRESHOLD && score >= ATTENTION_DROP_MIN_SCORE) {
    return computeUserAttentionLevel({ actionPriority: "high", changesPercentage: stock.changesPercentage, hqsScore: score });
  }
  // Medium/High: strong upward move on high-score stock
  if (change >= ATTENTION_GAIN_THRESHOLD && score >= ATTENTION_GAIN_MIN_SCORE) {
    return computeUserAttentionLevel({ portfolioPriority: "high", changesPercentage: stock.changesPercentage, hqsScore: score });
  }
  // General: pass through available signals
  return computeUserAttentionLevel({ changesPercentage: stock.changesPercentage, hqsScore: score });
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

    // Step 5: include attention level in briefing context when elevated
    const attnLabel = s._attentionLevel && s._attentionLevel !== "low"
      ? `, Aufmerksamkeit: ${s._attentionLevel}` + (s._attentionReason ? ` (${s._attentionReason})` : "")
      : "";

    lines.push(
      `- ${s.symbol}: Kurs ${s.price ?? "?"}, Änderung ${cp}, HQS ${score}, Marktphase ${regime}${attnLabel}.`
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
    await initJobLocksTable();

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

      // Step 5: Compute attention level per stock and sort by priority.
      // Most important signals (critical → high → medium → low) appear first.
      // Uses only existing market data fields – no extra DB calls.
      for (const s of stocks) {
        const attn = _stockAttentionLevel(s);
        s._attentionLevel = attn.level;
        s._attentionReason = attn.reason;
      }
      stocks.sort((a, b) =>
        (ATTENTION_RANK[a._attentionLevel] ?? 3) - (ATTENTION_RANK[b._attentionLevel] ?? 3)
      );

      // Derive briefing priority from the highest attention level found
      const topAttention = stocks[0]?._attentionLevel || "low";
      const topAttentionReason = stocks[0]?._attentionReason || null;

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
        priority: topAttention,
        reason: topAttentionReason,
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
