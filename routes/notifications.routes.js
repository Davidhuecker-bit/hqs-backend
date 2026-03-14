"use strict";

const express = require("express");
const router = express.Router();

const {
  listNotifications,
  unreadCount,
  markRead,
  saveDeviceToken,
} = require("../services/notifications.repository");
const {
  badRequest,
  parseEnum,
  parseInteger,
} = require("../utils/requestValidation");

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
    const userIdResult = parseInteger(req.query.userId, {
      required: true,
      min: 1,
      label: "userId",
    });
    if (userIdResult.error) {
      return badRequest(res, userIdResult.error);
    }

    const limitResult = parseInteger(req.query.limit, {
      defaultValue: 50,
      min: 1,
      max: 200,
      label: "limit",
    });
    if (limitResult.error) {
      return badRequest(res, limitResult.error);
    }

    const items = await listNotifications(userIdResult.value, limitResult.value);
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
    const userIdResult = parseInteger(req.query.userId, {
      required: true,
      min: 1,
      label: "userId",
    });
    if (userIdResult.error) {
      return badRequest(res, userIdResult.error);
    }

    const c = await unreadCount(userIdResult.value);
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
    const userIdResult = parseInteger(req.body?.userId, {
      required: true,
      min: 1,
      label: "userId",
    });
    if (userIdResult.error) {
      return badRequest(res, userIdResult.error);
    }

    const notificationIdResult = parseInteger(req.body?.notificationId, {
      required: true,
      min: 1,
      label: "notificationId",
    });
    if (notificationIdResult.error) {
      return badRequest(res, notificationIdResult.error);
    }

    await markRead(userIdResult.value, notificationIdResult.value);
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
    const userIdResult = parseInteger(req.body?.userId, {
      required: true,
      min: 1,
      label: "userId",
    });
    if (userIdResult.error) {
      return badRequest(res, userIdResult.error);
    }

    const token = String(req.body?.token || "").trim();
    if (!token) {
      return badRequest(res, "token is required");
    }

    if (token.length > 2048) {
      return badRequest(res, "token is too long");
    }

    const deviceTypeResult = parseEnum(
      req.body?.deviceType,
      ["web", "ios", "android"],
      {
        defaultValue: "web",
        label: "deviceType",
      }
    );
    if (deviceTypeResult.error) {
      return badRequest(res, deviceTypeResult.error);
    }

    await saveDeviceToken(userIdResult.value, token, deviceTypeResult.value);
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
