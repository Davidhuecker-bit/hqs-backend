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

module.exports = {
  initNotificationTables,
  seedDemoUserIfEmpty,
  getActiveBriefingUsers,
  getUserWatchlistSymbols,
  getUserIdsWithSymbolOnWatchlist,   // ✅ Step 5: batch watchlist check for discovery notify

  computeUserAttentionLevel,             // ✅ Step 5: user attention logic

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

  saveDeviceToken,
  getActiveDeviceTokens,
};
