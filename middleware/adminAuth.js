"use strict";

/**
 * Admin Authentication Middleware
 *
 * Protects all /api/admin/* routes with a shared secret key.
 *
 * How it works:
 *   Every request to /api/admin must include one of:
 *     - Header:       X-Admin-Key: <ADMIN_API_KEY>
 *     - Query param:  ?adminKey=<ADMIN_API_KEY>
 *
 * Configuration:
 *   Set the ADMIN_API_KEY environment variable to a strong random secret
 *   (e.g., `openssl rand -hex 32`).
 *
 *   If ADMIN_API_KEY is NOT set the middleware will block ALL requests with
 *   503 Service Unavailable to prevent accidental open access.
 *
 * Timing-safe comparison is used to prevent timing-based key enumeration.
 */

const crypto = require("crypto");

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = console;
}

const ADMIN_API_KEY = String(process.env.ADMIN_API_KEY || "").trim();

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  try {
    const aBuf = Buffer.from(a, "utf8");
    const bBuf = Buffer.from(b, "utf8");
    if (aBuf.length !== bBuf.length) {
      // Still run a dummy comparison to avoid timing leak on length mismatch
      crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
      return false;
    }
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch (_) {
    return false;
  }
}

function adminAuth(req, res, next) {
  if (!ADMIN_API_KEY) {
    logger.error("adminAuth: ADMIN_API_KEY is not configured – blocking all admin access");
    return res.status(503).json({
      success: false,
      message: "Admin access is not configured. Set ADMIN_API_KEY.",
    });
  }

  const headerKey = String(req.headers["x-admin-key"] || "").trim();
  const queryKey  = String(req.query?.adminKey   || "").trim();
  const candidate = headerKey || queryKey;

  if (!candidate || !timingSafeEqual(candidate, ADMIN_API_KEY)) {
    logger.warn("adminAuth: unauthorized admin access attempt", {
      ip: req.ip,
      path: req.path,
      method: req.method,
      hasHeader: Boolean(headerKey),
      hasQuery: Boolean(queryKey),
    });
    return res.status(401).json({
      success: false,
      message: "Unauthorized. Provide a valid admin key via X-Admin-Key header.",
    });
  }

  next();
}

module.exports = { adminAuth };
