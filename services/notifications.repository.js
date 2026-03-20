"use strict";

const { Pool } = require("pg");
let logger = null;
try { logger = require("../utils/logger"); } catch (_) { logger = null; }

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initNotificationTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS briefing_users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE,
      is_active BOOLEAN DEFAULT TRUE,
      timezone TEXT DEFAULT 'Europe/Berlin',
      wants_push BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS briefing_watchlist (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES briefing_users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      weight FLOAT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, symbol)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES briefing_users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      kind TEXT DEFAULT 'daily_briefing',
      is_read BOOLEAN DEFAULT FALSE,
      priority TEXT DEFAULT 'normal',
      reason TEXT,
      action_type TEXT,
      delivery_mode TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      delivered_at TIMESTAMP,
      seen_at TIMESTAMP,
      acted_at TIMESTAMP,
      dismissed_at TIMESTAMP,
      response_type TEXT,
      feedback_signal TEXT,
      follow_up_outcome TEXT
    );
  `);

  // One-time migrations: add columns to existing notifications tables.
  // Safe to re-run – ADD COLUMN IF NOT EXISTS is idempotent on PostgreSQL 9.6+.
  try {
    await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'normal'`);
    await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS reason TEXT`);
    await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS action_type TEXT`);
    await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS delivery_mode TEXT`);
    // Step 5: feedback/reaction columns
    await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP`);
    await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS seen_at TIMESTAMP`);
    await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS acted_at TIMESTAMP`);
    await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMP`);
    await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS response_type TEXT`);
    await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS feedback_signal TEXT`);
    await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS follow_up_outcome TEXT`);
  } catch (migErr) {
    // Warn but continue – migration may fail if columns already exist in some PG versions
    // or due to transient lock issues; table is still usable without these columns.
    if (logger?.warn) logger.warn("notifications columns migration skipped", { message: migErr.message });
  }

  // tokens für Web Push / spätere App Push
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_devices (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES briefing_users(id) ON DELETE CASCADE,
      device_type TEXT DEFAULT 'web',
      fcm_token TEXT NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      last_seen TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, fcm_token)
    );
  `);

  // ✅ Performance Indexe (safe)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_notifications_user_created
    ON notifications(user_id, created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_notifications_user_kind_created
    ON notifications(user_id, kind, created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_devices_user_active
    ON user_devices(user_id, is_active);
  `);

  if (logger?.info) logger.info("✅ notification tables ready");
}

async function seedDemoUserIfEmpty() {
  // Nur für Start, damit du sofort testen kannst
  const r = await pool.query(`SELECT COUNT(*)::int AS c FROM briefing_users;`);
  if ((r.rows?.[0]?.c ?? 0) > 0) return;

  // Demo User ohne Email (nur intern). Kannst du später ersetzen.
  const ins = await pool.query(
    `INSERT INTO briefing_users(email, is_active, wants_push) VALUES ($1, TRUE, FALSE) RETURNING id`,
    ["demo@local"]
  );
  const userId = ins.rows[0].id;

  const defaults = ["AAPL", "MSFT", "NVDA", "AMD"];
  for (const s of defaults) {
    await pool.query(
      `INSERT INTO briefing_watchlist(user_id, symbol) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [userId, s]
    );
  }
  if (logger?.info) logger.info("✅ demo user seeded");
}

async function getActiveBriefingUsers(limit = 500) {
  const res = await pool.query(
    `
    SELECT id, email, timezone, wants_push
    FROM briefing_users
    WHERE is_active = TRUE
    ORDER BY id ASC
    LIMIT $1
    `,
    [limit]
  );
  return res.rows;
}

async function getUserWatchlistSymbols(userId, limit = 200) {
  const res = await pool.query(
    `
    SELECT symbol, weight
    FROM briefing_watchlist
    WHERE user_id = $1
    ORDER BY symbol ASC
    LIMIT $2
    `,
    [userId, limit]
  );
  return res.rows.map(r => ({
    symbol: String(r.symbol).toUpperCase(),
    weight: r.weight !== null ? Number(r.weight) : null,
  }));
}

async function createNotification({ userId, title, body, kind = "daily_briefing", priority = "normal", reason = null, actionType = null, deliveryMode = null }) {
  const res = await pool.query(
    `
    INSERT INTO notifications(user_id, title, body, kind, priority, reason, action_type, delivery_mode, delivered_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
    RETURNING id, created_at, delivered_at
    `,
    [userId, title, body, kind, String(priority || "normal"), reason || null, actionType || null, deliveryMode || null]
  );
  return {
    id: res.rows[0].id,
    createdAt: new Date(res.rows[0].created_at).toISOString(),
    deliveredAt: res.rows[0].delivered_at ? new Date(res.rows[0].delivered_at).toISOString() : null,
  };
}

/**
 * ✅ NEW:
 * verhindert Spam: pro user+kind nur 1 Notification pro Tag
 * returns { inserted: boolean, id?, createdAt? }
 */
async function createNotificationOncePerDay({ userId, title, body, kind, priority = "normal", reason = null, actionType = null, deliveryMode = null }) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return { inserted: false };

  const k = String(kind || "daily_briefing");
  const t = String(title || "").trim() || "Update";
  const b = String(body || "").trim() || "";

  // check: existiert heute schon eine?
  const exists = await pool.query(
    `
    SELECT id
    FROM notifications
    WHERE user_id = $1
      AND kind = $2
      AND created_at >= date_trunc('day', NOW())
    LIMIT 1
    `,
    [uid, k]
  );

  if (exists.rows.length) {
    return { inserted: false, id: exists.rows[0].id };
  }

  const created = await createNotification({ userId: uid, title: t, body: b, kind: k, priority, reason, actionType, deliveryMode });
  return { inserted: true, ...created };
}

/**
 * ✅ NEW:
 * holt die letzte Notification eines Typs (für Debug/Frontend)
 */
async function getLatestNotificationByKind(userId, kind = "daily_briefing") {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return null;

  const k = String(kind || "daily_briefing");

  const res = await pool.query(
    `
    SELECT id, title, body, kind, is_read, created_at
    FROM notifications
    WHERE user_id = $1 AND kind = $2
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [uid, k]
  );

  if (!res.rows.length) return null;

  const r = res.rows[0];
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    kind: r.kind,
    isRead: !!r.is_read,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/**
 * Derives a user attention level from existing portfolio/delta/action signals.
 * Uses only already-computed fields – no extra DB calls.
 *
 * Rules (first match wins, transparent and explainable):
 *   critical – owned position with high concentration risk AND degrading delta
 *   high     – owned with high concentration risk  |  high action priority  |
 *              elevated delta on owned or watchlist symbol
 *   medium   – watchlist symbol with non-stable delta  |  high portfolio priority  |
 *              significant price move (≥5%) with strong HQS score (≥65)
 *   low      – default (no notable signal)
 *
 * @param {object} signals
 * @param {boolean} [signals.alreadyOwned=false]
 * @param {boolean} [signals.onWatchlist=false]
 * @param {string}  [signals.concentrationRisk='none']   'high' | 'medium' | 'none'
 * @param {string}  [signals.deltaPriority='stable']     'elevated' | 'caution' | 'degraded' | 'stable'
 * @param {string}  [signals.portfolioPriority='medium'] 'high' | 'medium' | 'low'
 * @param {string}  [signals.actionPriority=null]        'high' | 'medium' | 'low'
 * @param {number}  [signals.changesPercentage=0]        daily price change %
 * @param {number}  [signals.hqsScore=50]
 * @returns {{ level: 'critical'|'high'|'medium'|'low', reason: string|null }}
 */
function computeUserAttentionLevel({
  alreadyOwned = false,
  onWatchlist = false,
  concentrationRisk = "none",
  deltaPriority = "stable",
  portfolioPriority = "medium",
  actionPriority = null,
  changesPercentage = 0,
  hqsScore = 50,
} = {}) {
  // CRITICAL: owned position with high concentration risk AND deteriorating delta
  if (alreadyOwned && concentrationRisk === "high" && deltaPriority === "degraded") {
    return { level: "critical", reason: "Eigene Position: kritisches Konzentrationsrisiko und sinkende Überzeugung" };
  }

  // HIGH: owned position with high concentration risk
  if (alreadyOwned && concentrationRisk === "high") {
    return { level: "high", reason: "Eigene Position: hohes Konzentrationsrisiko" };
  }

  // HIGH: action priority high (reduce_risk or starter_position)
  if (actionPriority === "high") {
    return { level: "high", reason: "Hohe Handlungspriorität erforderlich" };
  }

  // HIGH: elevated delta on a known symbol (owned or on watchlist)
  if (deltaPriority === "elevated" && (alreadyOwned || onWatchlist)) {
    return { level: "high", reason: "Steigende Relevanz bei bekanntem Symbol" };
  }

  // MEDIUM: watchlist symbol with any delta change
  if (onWatchlist && deltaPriority !== "stable") {
    return { level: "medium", reason: "Beobachtetes Symbol mit Marktveränderung" };
  }

  // MEDIUM: high portfolio priority and not in decline
  if (portfolioPriority === "high" && deltaPriority !== "degraded") {
    return { level: "medium", reason: "Hohes Portfolio-Potenzial" };
  }

  // MEDIUM: significant move on a strong signal
  if (Math.abs(Number(changesPercentage) || 0) >= 5 && (Number(hqsScore) || 0) >= 65) {
    return { level: "medium", reason: "Starkes Signal mit signifikanter Kursbewegung" };
  }

  return { level: "low", reason: null };
}

/**
 * ✅ NEW:
 * Helper für Discovery Push/In-App Notification
 * Erwartet discovery-Pick Objekt:
 * { symbol, discoveryScore, confidence, reason, regime }
 */
async function createDiscoveryNotification({ userId, pick, onWatchlist = false }) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return { inserted: false };

  const sym = String(pick?.symbol || "").toUpperCase() || "Aktie";
  const score = pick?.discoveryScore ?? pick?.opportunityScore ?? null;
  const conf = pick?.confidence ?? null;
  const reason = String(pick?.reason || "").trim();
  const regime = pick?.regime ? String(pick.regime) : "neutral";

  const title = `Hidden Winner Kandidat: ${sym}`;

  const bodyLines = [
    `Symbol: ${sym}`,
    score !== null ? `Score: ${Number(score).toFixed(1)}` : null,
    conf !== null ? `Sicherheit: ${Number(conf)} / 100` : null,
    `Marktphase: ${regime}`,
    reason ? `Warum: ${reason}` : null,
    "",
    "Hinweis: Keine Kauf-/Verkaufsempfehlung. Nur Analyse.",
  ].filter(Boolean);

  const body = bodyLines.join("\n");

  // Derive notification priority from available pick signals
  const attention = computeUserAttentionLevel({
    onWatchlist,
    hqsScore: pick?.hqsScore ?? 50,
    // discoveryScore acts as a proxy for delta elevation when pick is fresh
    deltaPriority: (score !== null && Number(score) >= 70) ? "elevated" : "stable",
    portfolioPriority: (conf !== null && Number(conf) >= 75) ? "high" : "medium",
  });

  // 1 pro Tag
  return await createNotificationOncePerDay({
    userId: uid,
    title,
    body,
    kind: "discovery_pick",
    priority: attention.level,
    reason: attention.reason,
    actionType: "starter_position",
    deliveryMode: "notification",
  });
}

/**
 * Returns the set of user IDs that have a given symbol on their briefing watchlist.
 * Used by discoveryNotify to check per-user relevance in a single DB round-trip.
 *
 * @param {string} symbol
 * @returns {Promise<Set<number>>}
 */
async function getUserIdsWithSymbolOnWatchlist(symbol) {
  const sym = String(symbol || "").toUpperCase();
  if (!sym) return new Set();
  const res = await pool.query(
    `SELECT DISTINCT user_id FROM briefing_watchlist WHERE symbol = $1`,
    [sym]
  );
  return new Set(res.rows.map((r) => Number(r.user_id)));
}

async function listNotifications(userId, limit = 50) {
  const res = await pool.query(
    `
    SELECT id, title, body, kind, is_read, priority, reason, action_type, delivery_mode, created_at,
           delivered_at, seen_at, acted_at, dismissed_at, response_type, feedback_signal, follow_up_outcome
    FROM notifications
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT $2
    `,
    [userId, limit]
  );

  return res.rows.map(r => ({
    id: r.id,
    title: r.title,
    body: r.body,
    kind: r.kind,
    isRead: !!r.is_read,
    priority: r.priority || "normal",
    reason: r.reason || null,
    actionType: r.action_type || null,
    deliveryMode: r.delivery_mode || null,
    createdAt: new Date(r.created_at).toISOString(),
    deliveredAt: r.delivered_at ? new Date(r.delivered_at).toISOString() : null,
    seenAt: r.seen_at ? new Date(r.seen_at).toISOString() : null,
    actedAt: r.acted_at ? new Date(r.acted_at).toISOString() : null,
    dismissedAt: r.dismissed_at ? new Date(r.dismissed_at).toISOString() : null,
    responseType: r.response_type || null,
    feedbackSignal: r.feedback_signal || null,
    followUpOutcome: r.follow_up_outcome || null,
  }));
}

async function unreadCount(userId) {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS c FROM notifications WHERE user_id=$1 AND is_read=FALSE`,
    [userId]
  );
  return res.rows?.[0]?.c ?? 0;
}

async function markRead(userId, notificationId) {
  await pool.query(
    `UPDATE notifications SET is_read=TRUE WHERE user_id=$1 AND id=$2`,
    [userId, notificationId]
  );
}

async function saveDeviceToken(userId, token, deviceType = "web") {
  const t = String(token || "").trim();
  if (!t) return;

  await pool.query(
    `
    INSERT INTO user_devices(user_id, device_type, fcm_token, is_active, last_seen)
    VALUES ($1,$2,$3,TRUE,NOW())
    ON CONFLICT(user_id, fcm_token)
    DO UPDATE SET is_active=TRUE, last_seen=NOW(), device_type=EXCLUDED.device_type
    `,
    [userId, String(deviceType || "web"), t]
  );
}

async function getActiveDeviceTokens(userId, limit = 20) {
  const res = await pool.query(
    `
    SELECT fcm_token
    FROM user_devices
    WHERE user_id=$1 AND is_active=TRUE
    ORDER BY last_seen DESC
    LIMIT $2
    `,
    [userId, limit]
  );
  return res.rows.map(r => r.fcm_token);
}

/**
 * Step 5: Feedback/Reaction layer
 * markSeen – records when a user first sees/opens a notification.
 * Also sets is_read=TRUE (seeing implies reading).
 */
async function markSeen(userId, notificationId) {
  const uid = Number(userId);
  const nid = Number(notificationId);
  if (!Number.isFinite(uid) || uid <= 0 || !Number.isFinite(nid) || nid <= 0) return false;

  await pool.query(
    `UPDATE notifications
     SET seen_at = COALESCE(seen_at, NOW()), is_read = TRUE
     WHERE user_id = $1 AND id = $2`,
    [uid, nid]
  );
  return true;
}

/**
 * Step 5: Feedback/Reaction layer
 * markActed – records that the user acted on the notification (positive feedback signal).
 * responseType: 'acted' | 'starter_position' | 'watchlist_added' | 'rebalanced' (caller-defined)
 */
async function markActed(userId, notificationId, responseType = "acted") {
  const uid = Number(userId);
  const nid = Number(notificationId);
  if (!Number.isFinite(uid) || uid <= 0 || !Number.isFinite(nid) || nid <= 0) return false;

  const rt = String(responseType || "acted").trim().slice(0, 64) || "acted";

  await pool.query(
    `UPDATE notifications
     SET acted_at = COALESCE(acted_at, NOW()),
         response_type = $3,
         feedback_signal = 'positive',
         seen_at = COALESCE(seen_at, NOW()),
         is_read = TRUE
     WHERE user_id = $1 AND id = $2`,
    [uid, nid, rt]
  );
  return true;
}

/**
 * Step 5: Feedback/Reaction layer
 * markDismissed – records that the user dismissed the notification (negative/neutral feedback signal).
 */
async function markDismissed(userId, notificationId) {
  const uid = Number(userId);
  const nid = Number(notificationId);
  if (!Number.isFinite(uid) || uid <= 0 || !Number.isFinite(nid) || nid <= 0) return false;

  await pool.query(
    `UPDATE notifications
     SET dismissed_at = COALESCE(dismissed_at, NOW()),
         response_type = COALESCE(response_type, 'dismissed'),
         feedback_signal = COALESCE(feedback_signal, 'negative'),
         seen_at = COALESCE(seen_at, NOW()),
         is_read = TRUE
     WHERE user_id = $1 AND id = $2`,
    [uid, nid]
  );
  return true;
}

/**
 * Step 5: Feedback/Reaction layer
 * linkFollowUpOutcome – stores a reference to an outcome_tracking id or result label
 * so the notification can be connected to its measurable outcome later.
 */
async function linkFollowUpOutcome(notificationId, followUpOutcome) {
  const nid = Number(notificationId);
  if (!Number.isFinite(nid) || nid <= 0) return false;
  const outcome = String(followUpOutcome || "").trim().slice(0, 255);
  if (!outcome) return false;

  await pool.query(
    `UPDATE notifications SET follow_up_outcome = $2 WHERE id = $1`,
    [nid, outcome]
  );
  return true;
}

/**
 * Step 5 User-State: computeUserState
 * Derives a first consolidated user-state view from existing notification data.
 * No new tables, no new schema – reads only from the notifications table.
 *
 * Returned fields (all cleanly derivable from existing data):
 *   openAttentionCount    – critical/high-priority notifications not yet seen (last 7 days)
 *   criticalAttentionCount – critical-priority notifications not yet seen (last 7 days)
 *   activeFollowUpCount   – notifications with a linked follow-up outcome that have
 *                           not been acted on or dismissed yet (last 7 days)
 *   attentionBacklog      – total unseen notifications (last 7 days)
 *   lastResponseType      – most recent responseType recorded via markActed (any time)
 *   briefingUrgency       – derived: 'critical' | 'high' | 'medium' | 'low'
 *   userStateSummary      – short German label describing the overall user state
 *
 * @param {number} userId
 * @returns {Promise<object|null>}
 */
async function computeUserState(userId) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return null;

  const res = await pool.query(
    `
    WITH agg AS (
      SELECT
        COUNT(*) FILTER (WHERE priority IN ('critical','high') AND seen_at IS NULL) AS open_attention_count,
        COUNT(*) FILTER (WHERE priority = 'critical' AND seen_at IS NULL)           AS critical_attention_count,
        COUNT(*) FILTER (
          WHERE follow_up_outcome IS NOT NULL
            AND acted_at IS NULL
            AND dismissed_at IS NULL
        )                                                                             AS active_follow_up_count,
        COUNT(*) FILTER (WHERE seen_at IS NULL)                                      AS attention_backlog
      FROM notifications
      WHERE user_id = $1
        AND created_at >= NOW() - INTERVAL '7 days'
    ),
    last_act AS (
      SELECT response_type
      FROM notifications
      WHERE user_id = $1 AND acted_at IS NOT NULL
      ORDER BY acted_at DESC
      LIMIT 1
    )
    SELECT agg.*, last_act.response_type AS last_response_type
    FROM agg
    LEFT JOIN last_act ON TRUE
    `,
    [uid]
  );

  const row = res.rows?.[0] || {};
  const openAttentionCount    = Number(row.open_attention_count    || 0);
  const criticalAttentionCount = Number(row.critical_attention_count || 0);
  const activeFollowUpCount   = Number(row.active_follow_up_count   || 0);
  const attentionBacklog      = Number(row.attention_backlog        || 0);
  const lastResponseType      = row.last_response_type || null;

  // briefingUrgency – first-match rules, transparent and explainable
  let briefingUrgency;
  if (criticalAttentionCount > 0) {
    briefingUrgency = "critical";
  } else if (openAttentionCount > 0 || activeFollowUpCount > 1) {
    briefingUrgency = "high";
  } else if (activeFollowUpCount > 0 || attentionBacklog > 3) {
    briefingUrgency = "medium";
  } else {
    briefingUrgency = "low";
  }

  // userStateSummary – short German label for frontend/guardian display
  let userStateSummary;
  if (briefingUrgency === "critical") {
    userStateSummary = "Kritischer Aufmerksamkeitsbedarf: sofortige Prüfung empfohlen";
  } else if (briefingUrgency === "high") {
    userStateSummary = `${openAttentionCount} Aufmerksamkeitssignal(e) offen – Briefing priorisiert`;
  } else if (briefingUrgency === "medium") {
    userStateSummary = "Moderater Rückstand – reguläres Briefing ausreichend";
  } else {
    userStateSummary = "Kein akuter Handlungsbedarf";
  }

  return {
    openAttentionCount,
    criticalAttentionCount,
    activeFollowUpCount,
    attentionBacklog,
    lastResponseType,
    briefingUrgency,
    userStateSummary,
  };
}

// ── Step 5 Follow-up / Reminder layer ────────────────────────────────────────

/**
 * computeFollowUpStatus – pure function, no DB.
 * Derives follow-up/reminder status from existing notification fields.
 *
 * Inputs (subset of a notification row):
 *   priority, followUpOutcome, seenAt, actedAt, dismissedAt, createdAt
 *
 * Returned fields:
 *   followUpStatus   – 'overdue' | 'pending' | 'closed' | 'none'
 *   reminderEligible – boolean
 *   reminderReason   – short German reason string | null
 *   reminderAt       – ISO timestamp estimate for when to remind | null
 *   reviewDue        – boolean – notification is old enough to warrant review
 *   reminderWindow   – 'immediate' | 'short' | 'medium' | 'long' | null
 *   needsClosure     – boolean – acted/dismissed with a linked outcome → can close
 */
function computeFollowUpStatus({
  priority = "normal",
  followUpOutcome = null,
  seenAt = null,
  actedAt = null,
  dismissedAt = null,
  createdAt = null,
} = {}) {
  const now = Date.now();
  const createdMs = createdAt ? new Date(createdAt).getTime() : now;
  const ageHours = (now - createdMs) / (1000 * 60 * 60);

  const isClosed = !!(actedAt || dismissedAt);
  const isSeen = !!seenAt;
  const hasLinkedOutcome = !!followUpOutcome;

  // needsClosure: has a linked outcome and was already acted/dismissed
  const needsClosure = isClosed && hasLinkedOutcome;

  // reviewDue: old enough to warrant attention but not yet resolved
  const reviewDue =
    !isClosed &&
    (
      (priority === "critical" && ageHours >= 2) ||
      (priority === "high" && ageHours >= 8) ||
      ageHours >= 24
    );

  // reminderEligible rules (first match):
  let reminderEligible = false;
  let reminderReason   = null;
  let reminderWindow   = null;

  if (!isClosed) {
    if (hasLinkedOutcome) {
      reminderEligible = true;
      reminderReason   = "Offenes Follow-up ohne Nutzeraktion";
      reminderWindow   = priority === "critical" ? "immediate" : priority === "high" ? "short" : "medium";
    } else if ((priority === "critical" || priority === "high") && !isSeen && ageHours >= 4) {
      reminderEligible = true;
      reminderReason   = "Hohes Signal ohne Lesebestätigung";
      reminderWindow   = priority === "critical" ? "immediate" : "short";
    } else if (!isSeen && ageHours >= 24) {
      reminderEligible = true;
      reminderReason   = "Signal ungelesen – Wiedervorlage";
      reminderWindow   = "medium";
    }
  }

  // followUpStatus
  let followUpStatus = "none";
  if (isClosed) {
    followUpStatus = "closed";
  } else if (reminderEligible && reviewDue) {
    followUpStatus = "overdue";
  } else if (reminderEligible) {
    followUpStatus = "pending";
  }

  // reminderAt: estimated from reminder window offset
  const REMINDER_DELAY_HOURS = { immediate: 2, short: 8, medium: 24, long: 72 };
  const reminderAt = reminderEligible
    ? new Date(createdMs + (REMINDER_DELAY_HOURS[reminderWindow] || 24) * 3600 * 1000).toISOString()
    : null;

  return { followUpStatus, reminderEligible, reminderReason, reminderAt, reviewDue, reminderWindow, needsClosure };
}

/**
 * getOpenFollowUps – notifications with a linked follow_up_outcome that have not
 * been acted on or dismissed (last 14 days). Ordered by priority then age.
 *
 * @param {number} userId
 * @param {number} [limit=20]
 * @returns {Promise<object[]>}
 */
async function getOpenFollowUps(userId, limit = 20) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return [];

  const res = await pool.query(
    `SELECT id, title, kind, priority, reason, action_type, delivery_mode,
            created_at, seen_at, acted_at, dismissed_at,
            response_type, feedback_signal, follow_up_outcome
     FROM notifications
     WHERE user_id = $1
       AND follow_up_outcome IS NOT NULL
       AND acted_at IS NULL
       AND dismissed_at IS NULL
       AND created_at >= NOW() - INTERVAL '14 days'
     ORDER BY
       CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC,
       created_at ASC
     LIMIT $2`,
    [uid, Math.min(Number(limit) || 20, 100)]
  );

  return res.rows.map((r) => ({
    id: r.id,
    title: r.title,
    kind: r.kind,
    priority: r.priority || "normal",
    reason: r.reason || null,
    actionType: r.action_type || null,
    deliveryMode: r.delivery_mode || null,
    createdAt: new Date(r.created_at).toISOString(),
    seenAt: r.seen_at ? new Date(r.seen_at).toISOString() : null,
    actedAt: r.acted_at ? new Date(r.acted_at).toISOString() : null,
    dismissedAt: r.dismissed_at ? new Date(r.dismissed_at).toISOString() : null,
    responseType: r.response_type || null,
    feedbackSignal: r.feedback_signal || null,
    followUpOutcome: r.follow_up_outcome,
    ...computeFollowUpStatus({
      priority: r.priority,
      followUpOutcome: r.follow_up_outcome,
      seenAt: r.seen_at,
      actedAt: r.acted_at,
      dismissedAt: r.dismissed_at,
      createdAt: new Date(r.created_at).toISOString(),
    }),
  }));
}

/**
 * getReminderEligibleNotifications – notifications that qualify for a reminder.
 * Includes:
 *   - follow_up_outcome-linked but not acted/dismissed
 *   - high/critical unseen after 4 hours
 *   - any priority unseen after 24 hours
 * Defensive: limited to last 7 days, max 10 results.
 *
 * @param {number} userId
 * @param {number} [limit=10]
 * @returns {Promise<object[]>}
 */
async function getReminderEligibleNotifications(userId, limit = 10) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return [];

  const res = await pool.query(
    `SELECT id, title, kind, priority, reason, action_type, delivery_mode,
            created_at, seen_at, acted_at, dismissed_at,
            response_type, feedback_signal, follow_up_outcome
     FROM notifications
     WHERE user_id = $1
       AND acted_at IS NULL
       AND dismissed_at IS NULL
       AND created_at >= NOW() - INTERVAL '7 days'
       AND (
         (follow_up_outcome IS NOT NULL)
         OR (priority IN ('critical','high') AND seen_at IS NULL AND created_at <= NOW() - INTERVAL '4 hours')
         OR (seen_at IS NULL AND created_at <= NOW() - INTERVAL '24 hours')
       )
     ORDER BY
       CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC,
       created_at ASC
     LIMIT $2`,
    [uid, Math.min(Number(limit) || 10, 50)]
  );

  return res.rows.map((r) => ({
    id: r.id,
    title: r.title,
    kind: r.kind,
    priority: r.priority || "normal",
    reason: r.reason || null,
    actionType: r.action_type || null,
    deliveryMode: r.delivery_mode || null,
    createdAt: new Date(r.created_at).toISOString(),
    seenAt: r.seen_at ? new Date(r.seen_at).toISOString() : null,
    followUpOutcome: r.follow_up_outcome || null,
    ...computeFollowUpStatus({
      priority: r.priority,
      followUpOutcome: r.follow_up_outcome,
      seenAt: r.seen_at,
      actedAt: r.acted_at,
      dismissedAt: r.dismissed_at,
      createdAt: new Date(r.created_at).toISOString(),
    }),
  }));
}

/**
 * Step 5: Feedback/Reaction layer
 * getRecentFeedbackSignals – returns aggregated feedback signal counts for a user,
 * optionally filtered by kind. Used to understand how well a user responds to
 * different notification types.
 *
 * @param {number} userId
 * @param {object} [opts]
 * @param {string} [opts.kind]  - filter by notification kind
 * @param {number} [opts.days=30] - how far back to look
 * @returns {Promise<{ positive: number, negative: number, neutral: number, noResponse: number, total: number }>}
 */
async function getRecentFeedbackSignals(userId, { kind = null, days = 30 } = {}) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return { positive: 0, negative: 0, neutral: 0, noResponse: 0, total: 0 };

  const d = Math.min(Math.max(Number(days) || 30, 1), 365);

  const kindClause = kind ? `AND kind = $3` : "";
  const params = kind ? [uid, d, String(kind)] : [uid, d];

  const res = await pool.query(
    `SELECT
       COUNT(*) AS total,
       COUNT(CASE WHEN feedback_signal = 'positive' THEN 1 END) AS positive,
       COUNT(CASE WHEN feedback_signal = 'negative' THEN 1 END) AS negative,
       COUNT(CASE WHEN feedback_signal = 'neutral'  THEN 1 END) AS neutral,
       COUNT(CASE WHEN feedback_signal IS NULL AND seen_at IS NOT NULL THEN 1 END) AS seen_no_signal,
       COUNT(CASE WHEN seen_at IS NULL THEN 1 END) AS unseen
     FROM notifications
     WHERE user_id = $1
       AND created_at >= NOW() - ($2 || ' days')::interval
       ${kindClause}`,
    params
  );

  const row = res.rows?.[0] || {};
  const total = Number(row.total || 0);
  const positive = Number(row.positive || 0);
  const negative = Number(row.negative || 0);
  const neutral = Number(row.neutral || 0);
  // noResponse = notifications where no feedback_signal was recorded (seen or unseen)
  const noResponse = Number(row.seen_no_signal || 0) + Number(row.unseen || 0);

  return { positive, negative, neutral, noResponse, total };
}

// ── Step 6: Adaptive Product Signals ─────────────────────────────────────────

/**
 * computeProductSignals – aggregates normalized product signals for a user
 * from existing notification reaction data. No schema changes required.
 *
 * Derived scores (all 0..1):
 *   engagementScore       – seen / total (how often the user opens notifications)
 *   actionTakenScore      – acted / seen (how often seen leads to action)
 *   dismissalScore        – dismissed / seen (how often seen leads to dismissal)
 *   deliveryEffectiveness – acted / delivered (overall delivery quality)
 *   followUpEffectiveness – acted-on follow-up-linked / total follow-up-linked
 *
 * userPreferenceHints contains the delivery_mode and action_type combinations
 * that historically produced the most acted responses.
 *
 * @param {number} userId
 * @param {object} [opts]
 * @param {number} [opts.days=30] - look-back window
 * @returns {Promise<object>}
 */
async function computeProductSignals(userId, { days = 30 } = {}) {
  const uid = Number(userId);
  const empty = {
    engagementScore: 0, actionTakenScore: 0, dismissalScore: 0,
    deliveryEffectiveness: 0, followUpEffectiveness: 0,
    userPreferenceHints: { preferredDeliveryMode: null, preferredActionType: null, topCombinations: [] },
    sampleSize: 0, computedAt: new Date().toISOString(),
  };
  if (!Number.isFinite(uid) || uid <= 0) return empty;

  const d = Math.min(Math.max(Number(days) || 30, 1), 365);
  try {
    const res = await pool.query(
      `SELECT
         COUNT(*)                                                                      AS total,
         COUNT(CASE WHEN delivered_at IS NOT NULL THEN 1 END)                         AS delivered,
         COUNT(CASE WHEN seen_at IS NOT NULL THEN 1 END)                              AS seen,
         COUNT(CASE WHEN acted_at IS NOT NULL THEN 1 END)                             AS acted,
         COUNT(CASE WHEN dismissed_at IS NOT NULL THEN 1 END)                         AS dismissed,
         COUNT(CASE WHEN follow_up_outcome IS NOT NULL AND acted_at IS NOT NULL THEN 1 END) AS follow_up_acted,
         COUNT(CASE WHEN follow_up_outcome IS NOT NULL THEN 1 END)                    AS follow_up_total
       FROM notifications
       WHERE user_id = $1
         AND created_at >= NOW() - ($2 || ' days')::interval`,
      [uid, d]
    );

    const row           = res.rows?.[0] || {};
    const total         = Number(row.total          || 0);
    const delivered     = Number(row.delivered      || 0);
    const seen          = Number(row.seen           || 0);
    const acted         = Number(row.acted          || 0);
    const dismissed     = Number(row.dismissed      || 0);
    const followUpActed = Number(row.follow_up_acted || 0);
    const followUpTotal = Number(row.follow_up_total || 0);

    const engagementScore       = total        > 0 ? Number((seen        / total       ).toFixed(4)) : 0;
    const actionTakenScore      = seen         > 0 ? Number((acted       / seen        ).toFixed(4)) : 0;
    const dismissalScore        = seen         > 0 ? Number((dismissed   / seen        ).toFixed(4)) : 0;
    const deliveryEffectiveness = delivered    > 0 ? Number((acted       / delivered   ).toFixed(4)) : 0;
    const followUpEffectiveness = followUpTotal > 0 ? Number((followUpActed / followUpTotal).toFixed(4)) : 0;

    // Preference hints: which delivery_mode + action_type combinations led to acted responses.
    const hintRes = await pool.query(
      `SELECT delivery_mode, action_type, COUNT(*) AS acted_count
       FROM notifications
       WHERE user_id = $1
         AND acted_at IS NOT NULL
         AND created_at >= NOW() - ($2 || ' days')::interval
       GROUP BY delivery_mode, action_type
       ORDER BY acted_count DESC
       LIMIT 5`,
      [uid, d]
    );

    const preferredDeliveryMode = hintRes.rows?.[0]?.delivery_mode || null;
    const preferredActionType   = hintRes.rows?.[0]?.action_type   || null;
    const userPreferenceHints   = {
      preferredDeliveryMode,
      preferredActionType,
      topCombinations: hintRes.rows.slice(0, 3).map((r) => ({
        deliveryMode: r.delivery_mode || null,
        actionType:   r.action_type   || null,
        actedCount:   Number(r.acted_count || 0),
      })),
    };

    return {
      engagementScore,
      actionTakenScore,
      dismissalScore,
      deliveryEffectiveness,
      followUpEffectiveness,
      userPreferenceHints,
      sampleSize: total,
      computedAt: new Date().toISOString(),
    };
  } catch (err) {
    if (logger?.warn) logger.warn("computeProductSignals error", { userId: uid, message: err.message });
    return empty;
  }
}

module.exports = {
  initNotificationTables,
  seedDemoUserIfEmpty,
  getActiveBriefingUsers,
  getUserWatchlistSymbols,
  getUserIdsWithSymbolOnWatchlist,   // ✅ Step 5: batch watchlist check for discovery notify

  computeUserAttentionLevel,             // ✅ Step 5: user attention logic
  computeUserState,                      // ✅ Step 5 User-State: consolidated user state from notification data
  computeProductSignals,                 // ✅ Step 6: adaptive product signals (engagement/action/dismissal scores)

  createNotification,
  createNotificationOncePerDay,          // ✅ accepts priority/reason
  getLatestNotificationByKind,           // ✅ new
  createDiscoveryNotification,           // ✅ uses attention level + onWatchlist

  listNotifications,
  unreadCount,
  markRead,
  markSeen,                              // ✅ Step 5: reaction – seen/opened
  markActed,                             // ✅ Step 5: reaction – user acted (positive)
  markDismissed,                         // ✅ Step 5: reaction – user dismissed (negative)
  linkFollowUpOutcome,                   // ✅ Step 5: link notification to outcome_tracking result
  getRecentFeedbackSignals,              // ✅ Step 5: aggregate feedback signals per user/kind

  // ✅ Step 5 Follow-up/Reminder
  computeFollowUpStatus,                 // pure – derives follow-up/reminder status from notification fields
  getOpenFollowUps,                      // DB – notifications with open follow_up_outcome
  getReminderEligibleNotifications,      // DB – notifications that qualify for a reminder push

  saveDeviceToken,
  getActiveDeviceTokens,
};
