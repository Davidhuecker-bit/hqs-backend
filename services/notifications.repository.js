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
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

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

async function createNotification({ userId, title, body, kind = "daily_briefing" }) {
  const res = await pool.query(
    `
    INSERT INTO notifications(user_id, title, body, kind)
    VALUES ($1,$2,$3,$4)
    RETURNING id, created_at
    `,
    [userId, title, body, kind]
  );
  return {
    id: res.rows[0].id,
    createdAt: new Date(res.rows[0].created_at).toISOString(),
  };
}

/**
 * ✅ NEW:
 * verhindert Spam: pro user+kind nur 1 Notification pro Tag
 * returns { inserted: boolean, id?, createdAt? }
 */
async function createNotificationOncePerDay({ userId, title, body, kind }) {
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

  const created = await createNotification({ userId: uid, title: t, body: b, kind: k });
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
 * ✅ NEW:
 * Helper für Discovery Push/In-App Notification
 * Erwartet discovery-Pick Objekt:
 * { symbol, discoveryScore, confidence, reason, regime }
 */
async function createDiscoveryNotification({ userId, pick }) {
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

  // 1 pro Tag
  return await createNotificationOncePerDay({
    userId: uid,
    title,
    body,
    kind: "discovery_pick",
  });
}

async function listNotifications(userId, limit = 50) {
  const res = await pool.query(
    `
    SELECT id, title, body, kind, is_read, created_at
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
    createdAt: new Date(r.created_at).toISOString(),
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

module.exports = {
  initNotificationTables,
  seedDemoUserIfEmpty,
  getActiveBriefingUsers,
  getUserWatchlistSymbols,

  createNotification,
  createNotificationOncePerDay,      // ✅ new
  getLatestNotificationByKind,       // ✅ new
  createDiscoveryNotification,       // ✅ new

  listNotifications,
  unreadCount,
  markRead,
  saveDeviceToken,
  getActiveDeviceTokens,
};
