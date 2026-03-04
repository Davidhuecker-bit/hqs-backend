"use strict";

const express = require("express");
const router = express.Router();

const {
  listNotifications,
  unreadCount,
  markRead,
  saveDeviceToken,
} = require("../services/notifications.repository");

router.get("/", async (req, res) => {
  try {
    const userId = Number(req.query.userId);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ success: false, message: "userId fehlt." });
    }

    const items = await listNotifications(userId, 50);
    return res.json({ success: true, notifications: items });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

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

router.post("/mark-read", async (req, res) => {
  try {
    const userId = Number(req.body?.userId);
    const notificationId = Number(req.body?.notificationId);

    if (!Number.isFinite(userId) || !Number.isFinite(notificationId)) {
      return res.status(400).json({ success: false, message: "userId/notificationId fehlt." });
    }

    await markRead(userId, notificationId);
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

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
