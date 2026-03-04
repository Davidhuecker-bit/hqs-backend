"use strict";

const express = require("express");
const router = express.Router();

const {
  listNotifications,
  unreadCount,
  markRead,
  saveDeviceToken,
} = require("../services/notifications.repository");

/**
 * ✅ Health / Quick Test
 * GET /api/notifications/health
 */
router.get("/health", async (req, res) => {
  try {
    return res.json({ success: true, status: "notifications routes ok" });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * ✅ List notifications
 * GET /api/notifications?userId=1&limit=50
 */
router.get("/", async (req, res) => {
  try {
    const userId = Number(req.query.userId);
    const limit = Number(req.query.limit || 50);

    if (!Number.isFinite(userId)) {
      return res.status(400).json({ success: false, message: "userId fehlt." });
    }

    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 50;

    const items = await listNotifications(userId, safeLimit);
    return res.json({ success: true, notifications: items });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * ✅ Unread count
 * GET /api/notifications/unread-count?userId=1
 */
router.get("/unread-count", async (req, res) => {
  try {
    const userId = Number(req.query.userId);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ success: false, message: "userId fehlt." });
    }

    const c = await unreadCount(userId);
    return res.json({ success: true, unread: c });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * ✅ Mark read
 * POST /api/notifications/mark-read
 * body: { userId, notificationId }
 */
router.post("/mark-read", async (req, res) => {
  try {
    const userId = Number(req.body?.userId);
    const notificationId = Number(req.body?.notificationId);

    if (!Number.isFinite(userId) || !Number.isFinite(notificationId)) {
      return res
        .status(400)
        .json({ success: false, message: "userId/notificationId fehlt." });
    }

    await markRead(userId, notificationId);
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * ✅ Register device token (für Push später)
 * POST /api/notifications/register-device
 * body: { userId, token, deviceType }
 */
router.post("/register-device", async (req, res) => {
  try {
    const userId = Number(req.body?.userId);
    const token = String(req.body?.token || "");
    const deviceType = String(req.body?.deviceType || "web");

    if (!Number.isFinite(userId) || !token.trim()) {
      return res.status(400).json({ success: false, message: "userId/token fehlt." });
    }

    await saveDeviceToken(userId, token, deviceType);
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
