"use strict";

/**
 * Rate-Limiting Middleware
 *
 * Uses express-rate-limit (in-memory, per-IP, no external Redis needed).
 *
 * Two tiers:
 *
 *   apiLimiter   – general API routes
 *                  100 requests per 15 minutes per IP
 *
 *   adminLimiter – /api/admin/* routes (applied AFTER adminAuth)
 *                  30 requests per 15 minutes per IP
 *
 * Configuration via environment variables:
 *   RATE_LIMIT_API_WINDOW_MIN    – window in minutes for API tier    (default: 15)
 *   RATE_LIMIT_API_MAX           – max requests for API tier         (default: 100)
 *   RATE_LIMIT_ADMIN_WINDOW_MIN  – window in minutes for admin tier  (default: 15)
 *   RATE_LIMIT_ADMIN_MAX         – max requests for admin tier       (default: 30)
 *
 * Error responses return JSON { success: false, message, retryAfterSecs }.
 * Standard Retry-After header is set automatically.
 */

const rateLimit = require("express-rate-limit");

const API_WINDOW_MIN   = Math.max(1, Number(process.env.RATE_LIMIT_API_WINDOW_MIN   || 15));
const API_MAX          = Math.max(1, Number(process.env.RATE_LIMIT_API_MAX           || 100));
const ADMIN_WINDOW_MIN = Math.max(1, Number(process.env.RATE_LIMIT_ADMIN_WINDOW_MIN || 15));
const ADMIN_MAX        = Math.max(1, Number(process.env.RATE_LIMIT_ADMIN_MAX        || 30));

function makeHandler(label) {
  return (req, res, _next, options) => {
    const retryAfterSecs = Math.ceil(options.windowMs / 1000);
    res.status(429).json({
      success: false,
      message: `Too many requests (${label}). Please try again later.`,
      retryAfterSecs,
    });
  };
}

const apiLimiter = rateLimit({
  windowMs: API_WINDOW_MIN * 60 * 1000,
  max: API_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: makeHandler("api"),
});

const adminLimiter = rateLimit({
  windowMs: ADMIN_WINDOW_MIN * 60 * 1000,
  max: ADMIN_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: makeHandler("admin"),
});

module.exports = { apiLimiter, adminLimiter };
