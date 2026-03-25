"use strict";

/**
 * Push Delivery Service
 *
 * Sends Web Push notifications via the W3C Web Push Protocol (VAPID).
 * Supports web browsers (Chrome, Firefox, Safari 16.4+).
 *
 * iOS/Android native push (via FCM) requires FIREBASE_SERVICE_ACCOUNT and
 * is logged as "skipped – native push requires Firebase" until credentials
 * are provided; all other delivery paths run normally.
 *
 * Configuration (env vars):
 *   VAPID_SUBJECT         – "mailto:admin@yourdomain.com" or https:// URL (required for web push)
 *   VAPID_PUBLIC_KEY      – VAPID public key (base64url)
 *   VAPID_PRIVATE_KEY     – VAPID private key (base64url)
 *
 * Generate VAPID keys once with:
 *   node -e "const wp=require('web-push'); const k=wp.generateVAPIDKeys(); console.log(JSON.stringify(k,null,2));"
 *
 * The fcm_token column in user_devices stores the serialised PushSubscription
 * JSON object for device_type='web', or a raw FCM registration token for
 * device_type='ios'/'android'.
 *
 * Writer:  this service (sendPushToUser, sendBulkPush)
 * Readers: discoveryNotify.job.js, dailyBriefing.job.js (future)
 */

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = console;
}

const { getSharedPool } = require("../config/database");

let webpush = null;
let vapidConfigured = false;

function initVapid() {
  if (vapidConfigured) return true;
  try {
    webpush = require("web-push");
  } catch (_) {
    return false;
  }

  const subject    = String(process.env.VAPID_SUBJECT     || "").trim();
  const publicKey  = String(process.env.VAPID_PUBLIC_KEY  || "").trim();
  const privateKey = String(process.env.VAPID_PRIVATE_KEY || "").trim();

  if (!subject || !publicKey || !privateKey) return false;

  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
  return true;
}

/**
 * Load all active web-push subscriptions for a user.
 * Returns array of subscription objects (parsed JSON from fcm_token column).
 */
async function loadWebSubscriptions(userId) {
  const pool = getSharedPool();
  const res = await pool.query(
    `SELECT id, fcm_token, device_type
     FROM user_devices
     WHERE user_id = $1
       AND is_active = TRUE
       AND device_type = 'web'
     ORDER BY last_seen DESC
     LIMIT 10`,
    [userId]
  );
  return res.rows;
}

/**
 * Mark a device token as inactive (e.g. when push returns 410 Gone).
 */
async function deactivateDevice(deviceId) {
  const pool = getSharedPool();
  await pool.query(
    `UPDATE user_devices SET is_active = FALSE WHERE id = $1`,
    [deviceId]
  );
}

/**
 * Send a single push notification to one device.
 *
 * @param {object} row       – user_devices row (id, fcm_token, device_type)
 * @param {object} payload   – { title, body, url?, tag? }
 * @returns {{ sent: boolean, reason?: string }}
 */
async function sendToDevice(row, payload) {
  const { device_type: deviceType, fcm_token: token, id: deviceId } = row;

  // ── Web Push (VAPID) ──────────────────────────────────────────────────────
  if (deviceType === "web") {
    if (!initVapid()) {
      return { sent: false, reason: "vapid_not_configured" };
    }

    let subscription;
    try {
      subscription = typeof token === "string" ? JSON.parse(token) : token;
    } catch (_) {
      return { sent: false, reason: "invalid_subscription_json" };
    }

    if (!subscription?.endpoint) {
      return { sent: false, reason: "missing_subscription_endpoint" };
    }

    try {
      await webpush.sendNotification(
        subscription,
        JSON.stringify({
          title: String(payload?.title || "HQS"),
          body: String(payload?.body || ""),
          url: String(payload?.url || "/"),
          tag: String(payload?.tag || "hqs-default"),
        })
      );
      return { sent: true };
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription expired – deactivate silently
        await deactivateDevice(deviceId).catch(() => {});
        return { sent: false, reason: "subscription_expired" };
      }
      return { sent: false, reason: err.message };
    }
  }

  // ── FCM (iOS / Android) ──────────────────────────────────────────────────
  // Requires firebase-admin + FIREBASE_SERVICE_ACCOUNT env var.
  // Full support can be added once Firebase credentials are available.
  if (deviceType === "ios" || deviceType === "android") {
    const serviceAccount = String(process.env.FIREBASE_SERVICE_ACCOUNT || "").trim();
    if (!serviceAccount) {
      return { sent: false, reason: "firebase_not_configured" };
    }

    try {
      const admin = require("firebase-admin");
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert(JSON.parse(serviceAccount)),
        });
      }
      await admin.messaging().send({
        token,
        notification: {
          title: String(payload?.title || "HQS"),
          body: String(payload?.body || ""),
        },
      });
      return { sent: true };
    } catch (err) {
      return { sent: false, reason: err.message };
    }
  }

  return { sent: false, reason: `unsupported_device_type:${deviceType}` };
}

/**
 * Send a push notification to all active devices of a user.
 *
 * @param {number} userId
 * @param {{ title: string, body: string, url?: string, tag?: string }} payload
 * @returns {{ sent: number, skipped: number }}
 */
async function sendPushToUser(userId, payload) {
  const rows = await loadWebSubscriptions(userId);
  if (!rows.length) return { sent: 0, skipped: 0 };

  let sent = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      const result = await sendToDevice(row, payload);
      if (result.sent) {
        sent += 1;
      } else {
        skipped += 1;
        if (result.reason && result.reason !== "vapid_not_configured") {
          logger.warn("pushDelivery: device send skipped", {
            userId,
            deviceId: row.id,
            deviceType: row.device_type,
            reason: result.reason,
          });
        }
      }
    } catch (err) {
      skipped += 1;
      logger.error("pushDelivery: sendToDevice threw", {
        userId,
        deviceId: row.id,
        message: err.message,
      });
    }
  }

  return { sent, skipped };
}

/**
 * Send a push notification to multiple users in bulk.
 *
 * @param {number[]} userIds
 * @param {object} payload
 * @returns {{ totalSent: number, totalSkipped: number }}
 */
async function sendBulkPush(userIds, payload) {
  let totalSent = 0;
  let totalSkipped = 0;

  for (const userId of Array.isArray(userIds) ? userIds : []) {
    try {
      const { sent, skipped } = await sendPushToUser(userId, payload);
      totalSent += sent;
      totalSkipped += skipped;
    } catch (err) {
      totalSkipped += 1;
      logger.error("pushDelivery: sendBulkPush user failed", {
        userId,
        message: err.message,
      });
    }
  }

  return { totalSent, totalSkipped };
}

/**
 * Returns true if push delivery is configured and operational.
 * Useful for health checks.
 */
function isPushConfigured() {
  return initVapid();
}

module.exports = {
  sendPushToUser,
  sendBulkPush,
  isPushConfigured,
};
