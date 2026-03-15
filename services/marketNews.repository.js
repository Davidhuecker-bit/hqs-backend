"use strict";

const { Pool } = require("pg");
let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = null;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const MARKET_NEWS_SYMBOL_URL_CONSTRAINT = "market_news_symbol_url_key";
const SQL_INTERVAL_COOLING_EXTENDED = "7 days";
const SQL_INTERVAL_COOLING_STANDARD = "3 days";
const SQL_INTERVAL_COOLING_SHORT = "1 day";
const SQL_INTERVAL_DELETE_EXTENDED = "45 days";
const SQL_INTERVAL_DELETE_STANDARD = "21 days";
const SQL_INTERVAL_DELETE_SHORT = "7 days";

function cleanText(value) {
  const text = String(value ?? "").trim();
  return text.length ? text : null;
}

function cleanSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  return symbol.length ? symbol : null;
}

function cleanPublishedAt(value) {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString();
}

function cleanRetentionClass(value) {
  const retentionClass = String(value ?? "").trim().toLowerCase();
  if (["short", "standard", "extended"].includes(retentionClass)) {
    return retentionClass;
  }
  return "standard";
}

function cleanLifecycleState(value) {
  const lifecycleState = String(value ?? "").trim().toLowerCase();
  if (["active", "cooling", "expired"].includes(lifecycleState)) {
    return lifecycleState;
  }
  return "active";
}

function cleanBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function safeJson(value, fallback = {}) {
  if (value == null) return fallback;

  if (typeof value === "object") {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return fallback;
    }
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return parsed;
      return fallback;
    } catch (_) {
      return fallback;
    }
  }

  return fallback;
}

function buildRetentionIntervalCaseSql({
  columnName = "retention_class",
  extendedInterval,
  standardInterval,
  shortInterval,
}) {
  return `CASE
    WHEN COALESCE(${columnName}, 'standard') = 'extended' THEN INTERVAL '${extendedInterval}'
    WHEN COALESCE(${columnName}, 'standard') = 'short' THEN INTERVAL '${shortInterval}'
    ELSE INTERVAL '${standardInterval}'
  END`;
}

function normalizeNewsItem(item) {
  const symbol = cleanSymbol(item?.symbol);
  const title = cleanText(item?.title);
  const url = cleanText(item?.url);

  if (!symbol || !title || !url) return null;

  return {
    symbol,
    title,
    source: cleanText(item?.source),
    url,
    publishedAt: cleanPublishedAt(item?.publishedAt ?? item?.published_at),
    summaryRaw: cleanText(item?.summaryRaw ?? item?.summary_raw ?? item?.summary),
    sentimentRaw: cleanText(item?.sentimentRaw ?? item?.sentiment_raw),
    category: cleanText(item?.category),
    sourceType: cleanText(item?.sourceType ?? item?.source_type),
    entityHint: safeJson(item?.entityHint ?? item?.entity_hint, {}),
    rawPayload: safeJson(item?.rawPayload ?? item?.raw_payload, {}),
    intelligence: safeJson(item?.intelligence, {}),
    retentionClass: cleanRetentionClass(item?.retentionClass ?? item?.retention_class),
    expiresAt: cleanPublishedAt(item?.expiresAt ?? item?.expires_at),
    isActiveForScoring: cleanBoolean(
      item?.isActiveForScoring ?? item?.is_active_for_scoring,
      true
    ),
    lifecycleState: cleanLifecycleState(item?.lifecycleState ?? item?.lifecycle_state),
  };
}

async function initMarketNewsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS market_news (
        id SERIAL PRIMARY KEY,
        symbol TEXT NOT NULL,
        title TEXT NOT NULL,
        source TEXT,
        url TEXT NOT NULL,
        published_at TIMESTAMP,
        summary_raw TEXT,
        sentiment_raw TEXT,
        category TEXT,
        source_type TEXT,
        entity_hint JSONB DEFAULT '{}'::jsonb,
        raw_payload JSONB DEFAULT '{}'::jsonb,
        intelligence JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      ALTER TABLE market_news
      ADD COLUMN IF NOT EXISTS summary_raw TEXT;
    `);

    await pool.query(`
      ALTER TABLE market_news
      ADD COLUMN IF NOT EXISTS sentiment_raw TEXT;
    `);

    await pool.query(`
      ALTER TABLE market_news
      ADD COLUMN IF NOT EXISTS category TEXT;
    `);

    await pool.query(`
      ALTER TABLE market_news
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
    `);

    await pool.query(`
      ALTER TABLE market_news
      ADD COLUMN IF NOT EXISTS source_type TEXT;
    `);

    await pool.query(`
      ALTER TABLE market_news
      ADD COLUMN IF NOT EXISTS entity_hint JSONB DEFAULT '{}'::jsonb;
    `);

    await pool.query(`
      ALTER TABLE market_news
      ADD COLUMN IF NOT EXISTS raw_payload JSONB DEFAULT '{}'::jsonb;
    `);

    await pool.query(`
      ALTER TABLE market_news
      ADD COLUMN IF NOT EXISTS intelligence JSONB DEFAULT '{}'::jsonb;
    `);

    await pool.query(`
      ALTER TABLE market_news
      ADD COLUMN IF NOT EXISTS retention_class TEXT DEFAULT 'standard';
    `);

    await pool.query(`
      ALTER TABLE market_news
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP NULL;
    `);

    await pool.query(`
      ALTER TABLE market_news
      ADD COLUMN IF NOT EXISTS is_active_for_scoring BOOLEAN DEFAULT TRUE;
    `);

    await pool.query(`
      ALTER TABLE market_news
      ADD COLUMN IF NOT EXISTS lifecycle_state TEXT DEFAULT 'active';
    `);

    // Legacy refresh jobs used `summary`; current repository logic stores raw text in `summary_raw`.
    // The old column is intentionally left in place for backwards compatibility with older deployments.
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'market_news'
            AND column_name = 'summary'
        ) THEN
          EXECUTE '
            UPDATE market_news
            SET summary_raw = summary
            WHERE summary_raw IS NULL
              AND summary IS NOT NULL
          ';
        END IF;
      END
      $$;
    `);

    await pool.query(`
      UPDATE market_news
      SET updated_at = COALESCE(updated_at, created_at, NOW())
      WHERE updated_at IS NULL;
    `);

    // Legacy jobs also enforced URL-only uniqueness. We now keep uniqueness scoped to (symbol, url)
    // and recreate that guarantee below via market_news_symbol_url_key so the repository can safely
    // store the same article for multiple mapped symbols without breaking existing rows.
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM pg_class
          WHERE relname = 'ux_market_news_url'
            AND relkind = 'i'
        ) THEN
          DROP INDEX IF EXISTS ux_market_news_url;
        END IF;
      END
      $$;
    `);

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = '${MARKET_NEWS_SYMBOL_URL_CONSTRAINT}'
        ) THEN
          ALTER TABLE market_news
          ADD CONSTRAINT ${MARKET_NEWS_SYMBOL_URL_CONSTRAINT} UNIQUE (symbol, url);
        END IF;
      END
      $$;
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_market_news_symbol_published_at
      ON market_news (symbol, published_at DESC);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_market_news_source_type
      ON market_news (source_type);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_market_news_lifecycle_state_expires
      ON market_news (lifecycle_state, expires_at);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_market_news_scoring_active
      ON market_news (symbol, is_active_for_scoring, published_at DESC);
    `);

    if (logger?.info) logger.info("market_news ready");
  } catch (error) {
    if (logger?.error) logger.error("initMarketNewsTable error", { message: error.message });
    throw error;
  }
}

async function upsertMarketNews(items) {
  try {
    const rows = Array.isArray(items) ? items : [];
    if (!rows.length) return { insertedOrUpdated: 0 };

    const deduped = new Map();

    for (const item of rows) {
      const normalized = normalizeNewsItem(item);
      if (!normalized) continue;
      deduped.set(`${normalized.symbol}::${normalized.url}`, normalized);
    }

    const values = [...deduped.values()];
    if (!values.length) return { insertedOrUpdated: 0 };

    const placeholders = [];
    const params = [];
    let index = 1;

    for (const item of values) {
      placeholders.push(
        `($${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++}::jsonb, $${index++}::jsonb, $${index++}::jsonb, $${index++}, $${index++}, $${index++}, $${index++}, NOW(), NOW())`
      );

      params.push(
        item.symbol,
        item.title,
        item.source,
        item.url,
        item.publishedAt,
        item.summaryRaw,
        item.sentimentRaw,
        item.category,
        item.sourceType,
        JSON.stringify(item.entityHint || {}),
        JSON.stringify(item.rawPayload || {}),
        JSON.stringify(item.intelligence || {}),
        item.retentionClass,
        item.expiresAt,
        item.isActiveForScoring,
        item.lifecycleState
      );
    }

    await pool.query(
      `
      INSERT INTO market_news (
        symbol,
        title,
        source,
        url,
        published_at,
        summary_raw,
        sentiment_raw,
        category,
        source_type,
        entity_hint,
        raw_payload,
        intelligence,
        retention_class,
        expires_at,
        is_active_for_scoring,
        lifecycle_state,
        created_at,
        updated_at
      )
      VALUES
        ${placeholders.join(",\n")}
      ON CONFLICT (symbol, url) DO UPDATE SET
        title = EXCLUDED.title,
        source = EXCLUDED.source,
        published_at = EXCLUDED.published_at,
        summary_raw = EXCLUDED.summary_raw,
        sentiment_raw = EXCLUDED.sentiment_raw,
        category = EXCLUDED.category,
        source_type = EXCLUDED.source_type,
        entity_hint = EXCLUDED.entity_hint,
        raw_payload = EXCLUDED.raw_payload,
        intelligence = EXCLUDED.intelligence,
        retention_class = EXCLUDED.retention_class,
        expires_at = EXCLUDED.expires_at,
        is_active_for_scoring = EXCLUDED.is_active_for_scoring,
        lifecycle_state = EXCLUDED.lifecycle_state,
        updated_at = NOW()
      `,
      params
    );

    if (logger?.info) logger.info("market news upserted", { count: values.length });
    return { insertedOrUpdated: values.length };
  } catch (error) {
    if (logger?.error) logger.error("upsertMarketNews error", { message: error.message });
    throw error;
  }
}

async function loadLatestMarketNewsBySymbols(symbols, limitPerSymbol = 5, options = {}) {
  try {
    const normalizedSymbols = [...new Set(
      (Array.isArray(symbols) ? symbols : [])
        .map(cleanSymbol)
        .filter(Boolean)
    )];

    if (!normalizedSymbols.length) return {};

    const limit = Math.max(1, Math.min(Number(limitPerSymbol) || 5, 100));
    const onlyScoringActive = options?.onlyScoringActive === true;
    const coolingIntervalCaseSql = buildRetentionIntervalCaseSql({
      columnName: "retention_class",
      extendedInterval: SQL_INTERVAL_COOLING_EXTENDED,
      standardInterval: SQL_INTERVAL_COOLING_STANDARD,
      shortInterval: SQL_INTERVAL_COOLING_SHORT,
    });
    const whereActiveClause = onlyScoringActive
      ? `
          AND COALESCE(is_active_for_scoring, TRUE) = TRUE
          AND COALESCE(lifecycle_state, 'active') = 'active'
          AND (
            expires_at IS NULL
            OR expires_at > NOW() + ${coolingIntervalCaseSql}
          )
        `
      : "";

    const res = await pool.query(
      `
      SELECT
        symbol,
        title,
        source,
        url,
        published_at,
        summary_raw,
        sentiment_raw,
        category,
        source_type,
        entity_hint,
        raw_payload,
        intelligence,
        retention_class,
        expires_at,
        is_active_for_scoring,
        lifecycle_state
      FROM (
        SELECT
          symbol,
          title,
          source,
          url,
          published_at,
          summary_raw,
          sentiment_raw,
          category,
          source_type,
          entity_hint,
          raw_payload,
          intelligence,
          retention_class,
          expires_at,
          is_active_for_scoring,
          lifecycle_state,
          ROW_NUMBER() OVER (
            PARTITION BY symbol
            ORDER BY published_at DESC NULLS LAST, updated_at DESC, id DESC
          ) AS row_num
        FROM market_news
        WHERE symbol = ANY($1::text[])
        ${whereActiveClause}
      ) ranked
      WHERE row_num <= $2
      ORDER BY symbol ASC, published_at DESC NULLS LAST, row_num ASC
      `,
      [normalizedSymbols, limit]
    );

    const grouped = normalizedSymbols.reduce((acc, symbol) => {
      acc[symbol] = [];
      return acc;
    }, {});

    for (const row of res.rows) {
      grouped[row.symbol].push({
        symbol: row.symbol,
        title: row.title,
        source: row.source ?? null,
        url: row.url,
        publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
        summaryRaw: row.summary_raw ?? null,
        sentimentRaw: row.sentiment_raw ?? null,
        category: row.category ?? null,
        sourceType: row.source_type ?? null,
        entityHint: safeJson(row.entity_hint, {}),
        rawPayload: safeJson(row.raw_payload, {}),
        intelligence: safeJson(row.intelligence, {}),
        retentionClass: cleanRetentionClass(row.retention_class),
        expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
        isActiveForScoring: cleanBoolean(row.is_active_for_scoring, true),
        lifecycleState: cleanLifecycleState(row.lifecycle_state),
      });
    }

    return grouped;
  } catch (error) {
    if (logger?.error) logger.error("loadLatestMarketNewsBySymbols error", { message: error.message });
    return {};
  }
}

async function countMarketNewsBySymbol(symbol) {
  try {
    const normalizedSymbol = cleanSymbol(symbol);
    if (!normalizedSymbol) return 0;

    const res = await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM market_news
      WHERE symbol = $1
      `,
      [normalizedSymbol]
    );

    return Number(res.rows?.[0]?.count ?? 0) || 0;
  } catch (error) {
    if (logger?.error) logger.error("countMarketNewsBySymbol error", { message: error.message });
    return 0;
  }
}

async function loadScoringActiveMarketNewsBySymbols(symbols, limitPerSymbol = 5) {
  return loadLatestMarketNewsBySymbols(symbols, limitPerSymbol, {
    onlyScoringActive: true,
  });
}

async function syncMarketNewsLifecycleStates() {
  try {
    await initMarketNewsTable();
    const coolingIntervalCaseSql = buildRetentionIntervalCaseSql({
      columnName: "retention_class",
      extendedInterval: SQL_INTERVAL_COOLING_EXTENDED,
      standardInterval: SQL_INTERVAL_COOLING_STANDARD,
      shortInterval: SQL_INTERVAL_COOLING_SHORT,
    });

    const coolingResult = await pool.query(`
      UPDATE market_news
      SET
        lifecycle_state = 'cooling',
        is_active_for_scoring = FALSE,
        updated_at = NOW()
      WHERE expires_at IS NOT NULL
        AND expires_at > NOW()
        AND expires_at <= NOW() + ${coolingIntervalCaseSql}
        AND COALESCE(lifecycle_state, 'active') <> 'expired'
        AND (
          COALESCE(lifecycle_state, 'active') <> 'cooling'
          OR COALESCE(is_active_for_scoring, TRUE) <> FALSE
        );
    `);

    const expiredResult = await pool.query(`
      UPDATE market_news
      SET
        lifecycle_state = 'expired',
        is_active_for_scoring = FALSE,
        updated_at = NOW()
      WHERE expires_at IS NOT NULL
        AND expires_at <= NOW()
        AND (
          COALESCE(lifecycle_state, 'active') <> 'expired'
          OR COALESCE(is_active_for_scoring, TRUE) <> FALSE
        );
    `);

    return {
      cooled: Number(coolingResult.rowCount || 0),
      expired: Number(expiredResult.rowCount || 0),
    };
  } catch (error) {
    if (logger?.error) logger.error("syncMarketNewsLifecycleStates error", { message: error.message });
    throw error;
  }
}

async function cleanupExpiredMarketNews() {
  try {
    await initMarketNewsTable();
    const deleteIntervalCaseSql = buildRetentionIntervalCaseSql({
      columnName: "retention_class",
      extendedInterval: SQL_INTERVAL_DELETE_EXTENDED,
      standardInterval: SQL_INTERVAL_DELETE_STANDARD,
      shortInterval: SQL_INTERVAL_DELETE_SHORT,
    });

    const result = await pool.query(`
      DELETE FROM market_news
      WHERE COALESCE(lifecycle_state, 'active') = 'expired'
        AND COALESCE(is_active_for_scoring, TRUE) = FALSE
        AND expires_at IS NOT NULL
        AND expires_at <= NOW() - ${deleteIntervalCaseSql};
    `);

    return {
      deleted: Number(result.rowCount || 0),
    };
  } catch (error) {
    if (logger?.error) logger.error("cleanupExpiredMarketNews error", { message: error.message });
    throw error;
  }
}

// ── Global news aggregate thresholds ────────────────────────────────────────
const NEWS_AGGREGATE_MIN_HOURS      = 1;   // minimum allowed look-back window
const NEWS_AGGREGATE_MAX_HOURS      = 168; // maximum: 1 week
const NEWS_AGGREGATE_BULLISH_THRESHOLD = 0.1;  // directionScore ≥ threshold → bullish
const NEWS_AGGREGATE_BEARISH_THRESHOLD = -0.1; // directionScore ≤ threshold → bearish

/**
 * Returns a lightweight global news aggregate for the last `hours` hours.
 * Scans all scoring-active news items regardless of symbol and returns:
 *   - totalActive: count of scoring-active items
 *   - bullish / bearish / neutral: direction counts
 *   - direction: dominant direction ("bullish"|"bearish"|"neutral")
 *   - directionScore: -1..1 composite score (positive = bullish)
 *   - capturedAt: ISO timestamp of the query
 *
 * This is intentionally lightweight (single aggregation query) and is used by
 * worldState.service.js to build the global `news_pulse` without symbol-specific
 * context.
 *
 * @param {number} hours  Look-back window in hours (default 24)
 * @returns {Promise<object>}
 */
async function getGlobalNewsAggregate(hours = 24) {
  try {
    await initMarketNewsTable();

    const hoursInt = Math.max(
      NEWS_AGGREGATE_MIN_HOURS,
      Math.min(NEWS_AGGREGATE_MAX_HOURS, Math.round(Number(hours) || 24))
    );

    const result = await pool.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE COALESCE(is_active_for_scoring, TRUE) = TRUE)  AS total_active,
        COUNT(*) FILTER (
          WHERE COALESCE(is_active_for_scoring, TRUE) = TRUE
            AND (intelligence->>'direction') = 'bullish'
        )                                                                      AS bullish_count,
        COUNT(*) FILTER (
          WHERE COALESCE(is_active_for_scoring, TRUE) = TRUE
            AND (intelligence->>'direction') = 'bearish'
        )                                                                      AS bearish_count
      FROM market_news
      WHERE published_at >= NOW() - ($1 || ' hours')::INTERVAL
        AND COALESCE(lifecycle_state, 'active') NOT IN ('expired', 'cooling')
      `,
      [hoursInt]
    );

    const row = result.rows[0] || {};
    const totalActive = Number(row.total_active || 0);
    const bullish = Number(row.bullish_count || 0);
    const bearish = Number(row.bearish_count || 0);
    const neutral = Math.max(0, totalActive - bullish - bearish);

    let directionScore = 0;
    if (totalActive > 0) {
      directionScore = parseFloat(((bullish - bearish) / totalActive).toFixed(4));
    }

    const direction =
      directionScore >= NEWS_AGGREGATE_BULLISH_THRESHOLD  ? "bullish"
        : directionScore <= NEWS_AGGREGATE_BEARISH_THRESHOLD ? "bearish"
        : "neutral";

    return {
      totalActive,
      bullish,
      bearish,
      neutral,
      direction,
      directionScore,
      lookbackHours: hoursInt,
      capturedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (logger?.error) logger.error("getGlobalNewsAggregate error", { message: error.message });
    throw error;
  }
}

module.exports = {
  initMarketNewsTable,
  upsertMarketNews,
  loadLatestMarketNewsBySymbols,
  loadScoringActiveMarketNewsBySymbols,
  countMarketNewsBySymbol,
  syncMarketNewsLifecycleStates,
  cleanupExpiredMarketNews,
  getGlobalNewsAggregate,
};
