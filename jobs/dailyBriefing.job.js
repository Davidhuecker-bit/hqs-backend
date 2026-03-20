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
  computeUserState,             // ✅ Step 5 User-State: consolidated state for briefing prioritization
  getOpenFollowUps,             // ✅ Step 5 Follow-up: open follow-ups for review-due boost
  computeUserPreferenceHints,   // ✅ Step 6 Block 2: per-user preference hints
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

/**
 * Derive a minimal Action-Orchestration for a briefing stock using only the
 * already-computed attention level. No extra DB calls.
 *
 * This maps attention level → escalation/deliveryMode for briefing ordering.
 *
 * escalationLevel: 'high' | 'medium' | 'none'
 * followUpNeeded:  boolean – whether the stock warrants explicit follow-up
 * deliveryMode:    'briefing_and_notification' | 'briefing' | 'passive_briefing' | 'none'
 */
function _deriveBriefingOrchestration(stock) {
  const level = stock._attentionLevel || "low";

  if (level === "critical") {
    return { escalationLevel: "high", followUpNeeded: true, deliveryMode: "briefing_and_notification" };
  }
  if (level === "high") {
    return { escalationLevel: "high", followUpNeeded: false, deliveryMode: "briefing_and_notification" };
  }
  if (level === "medium") {
    return { escalationLevel: "medium", followUpNeeded: false, deliveryMode: "briefing" };
  }
  return { escalationLevel: "none", followUpNeeded: false, deliveryMode: "passive_briefing" };
}

/**
 * Sort value for briefing order using Action-Orchestration.
 * Lower = higher priority (appears first in briefing).
 *   0 – review-due follow-up + high escalation (highest urgency)
 *   1 – review-due follow-up + medium escalation
 *   2 – high escalation + follow-up needed (critical risk)
 *   3 – high escalation
 *   4 – medium escalation + follow-up (portfolio/risk change)
 *   5 – medium escalation
 *   6 – attention-based fallback (low/none escalation)
 *
 * @param {object} stock
 * @param {boolean} [userHasOpenFollowUps=false] – true when user has unresolved follow-ups
 */
function _briefingOrchestrationRank(stock, userHasOpenFollowUps = false) {
  const orch = stock._orchestration || {};
  // Review-due follow-ups rank highest when the user has open follow-ups to resolve
  if (userHasOpenFollowUps && orch.followUpNeeded) {
    if (orch.escalationLevel === "high") return 0;
    if (orch.escalationLevel === "medium") return 1;
    return 2;
  }
  if (orch.escalationLevel === "high" && orch.followUpNeeded) return 2;
  if (orch.escalationLevel === "high") return 3;
  if (orch.escalationLevel === "medium" && orch.followUpNeeded) return 4;
  if (orch.escalationLevel === "medium") return 5;
  return 6;
}

/**
 * Build a brief orchestration label for a stock's fact line.
 * Returns empty string for passive/none delivery modes (no clutter for routine stocks).
 */
function _buildOrchLabel(orch) {
  if (!orch?.deliveryMode) return "";
  if (orch.deliveryMode === "passive_briefing" || orch.deliveryMode === "none") return "";
  const followUp = orch.followUpNeeded ? " · Follow-up empfohlen" : "";
  return `, Behandlung: ${orch.deliveryMode}${followUp}`;
}

// ── Urgency/priority resolution ─────────────────────────────────────────────
const URGENCY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Resolves the effective briefing priority by taking the more urgent of the
 * stock-level attention and the user-state briefing urgency.
 * Lower rank = higher urgency.
 */
function _resolveEffectivePriority(stateBriefingUrgency, stockAttentionLevel) {
  const stateRank = URGENCY_RANK[stateBriefingUrgency] ?? 3;
  const stockRank = URGENCY_RANK[stockAttentionLevel] ?? 3;
  return stateRank <= stockRank ? stateBriefingUrgency : stockAttentionLevel;
}

/**
 * Step 6 Block 3 / Block 4: Small adaptive sort adjustment for briefing order.
 * Returns a numeric offset: negative = higher priority (appears earlier).
 * Only used as a third tie-breaker, after orchestration and attention ranks.
 *
 * Guardrail (Block 4): this function only ever returns 0 or -1 (boost toward
 * the front), never +1. Critical/high-attention stocks therefore cannot be
 * demoted by adaptive preference signals – the adaptive layer is purely
 * additive within the tie-breaker slot.
 *
 * @param {object}      stock – stock with _attentionLevel and _attentionReason
 * @param {object|null} hints – computeUserPreferenceHints() result
 * @returns {number}
 */
function _adaptiveBriefingBoost(stock, hints) {
  if (!hints || (hints.sampleSize || 0) < 3) return 0;
  const level  = stock._attentionLevel  || "low";
  const reason = stock._attentionReason || "";
  // risk_averse user: risk/high-attention stocks get a tighter slot in the briefing
  if (hints.riskSensitivity === "risk_averse" &&
      (level === "high" || level === "critical")) {
    return -1;
  }
  // exploration-affinity user: new-signal or discovery-type stocks move up
  if (hints.explorationAffinity === "high" &&
      (reason.toLowerCase().includes("new") || reason.toLowerCase().includes("first"))) {
    return -1;
  }
  return 0;
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

    // Include attention level when elevated
    const attnLabel = s._attentionLevel && s._attentionLevel !== "low"
      ? `, Aufmerksamkeit: ${s._attentionLevel}` + (s._attentionReason ? ` (${s._attentionReason})` : "")
      : "";

    // Include orchestration hint when actionable (not passive/none)
    const orchLabel = _buildOrchLabel(s._orchestration);

    // Step 5 Follow-up/Reminder: mark review-due follow-up stocks with a brief note
    const followUpLabel = s._orchestration?.followUpNeeded ? " · Wiedervorlage" : "";

    lines.push(
      `- ${s.symbol}: Kurs ${s.price ?? "?"}, Änderung ${cp}, HQS ${score}, Marktphase ${regime}${attnLabel}${orchLabel}${followUpLabel}.`
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

      // Step 5 User-State: load consolidated state for this user (single DB call).
      // Used to boost briefing priority when there is a critical/high attention backlog.
      let userState = null;
      try {
        userState = await computeUserState(userId);
      } catch (usErr) {
        logger.warn("Daily briefing: computeUserState failed (ignored)", { userId, message: usErr.message });
      }

      // Step 5 Follow-up/Reminder: load count of open follow-ups for sort-order boost.
      // Uses activeFollowUpCount from userState (no extra DB round-trip).
      const userHasOpenFollowUps = (userState?.activeFollowUpCount ?? 0) > 0;

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

      // Step 5: Compute attention level per stock, then derive Action-Orchestration,
      // and sort by orchestration priority first (escalation/follow-up), then attention rank.
      for (const s of stocks) {
        const attn = _stockAttentionLevel(s);
        s._attentionLevel = attn.level;
        s._attentionReason = attn.reason;
        // Derive minimal orchestration from attention level for briefing ordering
        s._orchestration = _deriveBriefingOrchestration(s);
      }
      // Primary sort: orchestration rank (escalation/follow-up urgency, review-due boost when user has open follow-ups)
      // Secondary sort: attention level rank (critical → high → medium → low)
      // Tertiary sort: Step 6 Block 3 adaptive tie-breaker (risk/exploration preference)
      stocks.sort((a, b) => {
        const orchDiff = _briefingOrchestrationRank(a, userHasOpenFollowUps) - _briefingOrchestrationRank(b, userHasOpenFollowUps);
        if (orchDiff !== 0) return orchDiff;
        const attnDiff = (ATTENTION_RANK[a._attentionLevel] ?? 3) - (ATTENTION_RANK[b._attentionLevel] ?? 3);
        if (attnDiff !== 0) return attnDiff;
        return _adaptiveBriefingBoost(a, userPreferenceHints) - _adaptiveBriefingBoost(b, userPreferenceHints);
      });

      // Derive briefing priority from the highest escalation/attention level found.
      // Step 5 User-State: if the user has a critical/high urgency backlog, escalate
      // the briefing priority even when the current stock signals are moderate.
      const topOrch = stocks[0]?._orchestration || {};
      const topAttention = stocks[0]?._attentionLevel || "low";
      const topAttentionReason = stocks[0]?._attentionReason || null;
      const topDeliveryMode = topOrch.deliveryMode || "passive_briefing";

      // Resolve effective priority: user-state urgency may escalate stock-level attention
      const stateBriefingUrgency = userState?.briefingUrgency || "low";
      const effectivePriority = _resolveEffectivePriority(stateBriefingUrgency, topAttention);

      // Step 6 Block 2 / Block 4: User preference hints – use notificationFatigue for
      // delivery downgrade and briefingAffinity / preferredActionType for light adaptation.
      // One CTE query replaces the old computeProductSignals call. Non-fatal.
      //
      // adaptedDeliveryMode starts from the stock-/orchestration-level delivery mode.
      // adaptedActionType starts from urgency logic: "reduce_risk" on high urgency, else null.
      //   → If null, the user's historically preferred action type can fill the slot below.
      //
      // GUARDRAIL (Block 4): delivery-mode downgrade is never applied when effectivePriority
      // or topAttention is "critical". Critical topics must use briefing_and_notification
      // regardless of user fatigue – safety and governance override comfort.
      let adaptedDeliveryMode = topDeliveryMode;
      let adaptedActionType = topOrch.escalationLevel === "high" || stateBriefingUrgency === "critical" ? "reduce_risk" : null;
      let userPreferenceHints = null;
      try {
        userPreferenceHints = await computeUserPreferenceHints(userId, { days: 30 });
        if (userPreferenceHints.sampleSize >= 5) {
          // Downgrade delivery mode for users with high notification fatigue –
          // GUARDRAIL: never downgrade critical priority topics.
          const hasCriticalTopic = (effectivePriority === "critical" || topAttention === "critical");
          if (topDeliveryMode === "briefing_and_notification" &&
              userPreferenceHints.notificationFatigue === "high") {
            if (!hasCriticalTopic) {
              adaptedDeliveryMode = "briefing";
              logger.info("dailyBriefing: delivery downgraded (high notification fatigue)", {
                userId, notificationFatigue: userPreferenceHints.notificationFatigue,
                sampleSize: userPreferenceHints.sampleSize,
              });
            } else {
              // Guardrail triggered: log that downgrade was blocked for critical topic.
              logger.info("dailyBriefing: delivery downgrade blocked (critical topic protected from fatigue gate)", {
                userId, effectivePriority, topAttention,
              });
            }
          }
          // If no urgent action type is set, use the user's historically preferred action type
          if (adaptedActionType === null && userPreferenceHints.preferredActionType) {
            adaptedActionType = userPreferenceHints.preferredActionType;
          }
          if (userPreferenceHints.briefingAffinity) {
            logger.info("dailyBriefing: user briefing affinity", {
              userId, briefingAffinity: userPreferenceHints.briefingAffinity,
            });
          }
        }
      } catch (sigErr) {
        logger.warn("dailyBriefing: computeUserPreferenceHints failed (ignored)", { userId, message: sigErr.message });
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
        priority: effectivePriority,
        reason: topAttentionReason || userState?.userStateSummary || null,
        actionType: adaptedActionType,
        deliveryMode: adaptedDeliveryMode,
      });

      if (created.inserted) {
        createdCount++;
        logger.info("Daily briefing created", {
          userId, deliveryMode: adaptedDeliveryMode, userStateUrgency: stateBriefingUrgency,
          notificationFatigue: userPreferenceHints?.notificationFatigue || null,
        });
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
