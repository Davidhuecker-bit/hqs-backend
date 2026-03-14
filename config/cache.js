"use strict";

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

let NodeCache = null;
try {
  NodeCache = require("node-cache");
} catch (error) {
  if (logger?.warn) {
    logger.warn("node-cache module unavailable; using in-memory fallback", {
      message: error.message,
    });
  }
}

function normalizeBaseTtl(ttlSeconds, fallback = 600) {
  const ttl = Number(ttlSeconds);
  if (Number.isFinite(ttl) && ttl > 0) return ttl;
  return fallback;
}

const DEFAULT_TTL_SECONDS = normalizeBaseTtl(
  process.env.CACHE_TTL_SECONDS,
  600
);

function normalizeTtl(ttlSeconds) {
  return normalizeBaseTtl(ttlSeconds, DEFAULT_TTL_SECONDS);
}

function createMemoryFallbackCache(defaultTtlSeconds) {
  const store = new Map();

  function isExpired(entry) {
    return entry?.expiresAt != null && entry.expiresAt <= Date.now();
  }

  function getEntry(key) {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (isExpired(entry)) {
      store.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    get(key) {
      return getEntry(key)?.value;
    },
    set(key, value, ttlSeconds = defaultTtlSeconds) {
      const ttl = normalizeTtl(ttlSeconds);
      store.set(key, {
        value,
        expiresAt: Date.now() + ttl * 1000,
      });
      return true;
    },
    del(key) {
      store.delete(key);
    },
  };
}

const localCache = NodeCache
  ? new NodeCache({
      stdTTL: DEFAULT_TTL_SECONDS,
      checkperiod: Math.max(60, Math.floor(DEFAULT_TTL_SECONDS / 2)),
    })
  : createMemoryFallbackCache(DEFAULT_TTL_SECONDS);

let redisClient = null;
if (
  process.env.UPSTASH_REDIS_REST_URL &&
  process.env.UPSTASH_REDIS_REST_TOKEN
) {
  try {
    const { Redis } = require("@upstash/redis");
    redisClient = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  } catch (error) {
    if (logger?.warn) {
      logger.warn("Upstash Redis client could not be initialized", {
        message: error.message,
      });
    }
  }
}

async function get(key) {
  if (redisClient) {
    try {
      const value = await redisClient.get(key);
      if (value != null) {
        let localTtl = DEFAULT_TTL_SECONDS;
        try {
          if (typeof redisClient.ttl === "function") {
            const remainingTtl = await redisClient.ttl(key);
            if (Number.isFinite(remainingTtl) && remainingTtl > 0) {
              localTtl = remainingTtl;
            }
          }
        } catch (_) {
          localTtl = DEFAULT_TTL_SECONDS;
        }

        localCache.set(key, value, localTtl);
        return value;
      }
    } catch (error) {
      if (logger?.warn) {
        logger.warn("Redis cache get failed; using local fallback", {
          key,
          message: error.message,
        });
      }
    }
  }

  return localCache.get(key);
}

async function set(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const ttl = normalizeTtl(ttlSeconds);
  localCache.set(key, value, ttl);

  if (redisClient) {
    try {
      await redisClient.set(key, value, { ex: ttl });
    } catch (error) {
      if (logger?.warn) {
        logger.warn("Redis cache set failed; local fallback remains active", {
          key,
          message: error.message,
        });
      }
    }
  }

  return true;
}

async function del(key) {
  localCache.del(key);

  if (redisClient) {
    try {
      await redisClient.del(key);
    } catch (error) {
      if (logger?.warn) {
        logger.warn("Redis cache delete failed", {
          key,
          message: error.message,
        });
      }
    }
  }
}

module.exports = {
  get,
  set,
  del,
  isRedisEnabled: Boolean(redisClient),
};
