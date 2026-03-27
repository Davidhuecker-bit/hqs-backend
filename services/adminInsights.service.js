"use strict";

// services/adminInsights.service.js
// Liest Systemzustand, Aktivität, Coverage und Lernsignale aus der DB
// Ohne dein laufendes Kernsystem zu verändern.

let logger = console;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = console;
}

const { getSharedPool } = require("../config/database");
const pool = getSharedPool();
const DEFAULT_LOOKBACK_HOURS = Number(process.env.ADMIN_LOOKBACK_HOURS || 24);
const DEFAULT_LONG_LOOKBACK_DAYS = Number(process.env.ADMIN_LONG_LOOKBACK_DAYS || 7);
// Minimum number of empty table fields required to classify the overall data status as "empty"
const EMPTY_STATUS_THRESHOLD = 4;

// ── Schema introspection cache ───────────────────────────────────────────────
// information_schema queries are slow and the schema is stable within a process
// lifetime (tables are created at startup, never dropped mid-run).  Cache the
// results for SCHEMA_CACHE_TTL_MS to avoid hitting information_schema on every
// getAdminInsights() call.
const SCHEMA_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const _schemaCache = new Map(); // "exists:<table>" | "cols:<table>" → { value, ts }

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pct(part, total) {
  const p = safeNum(part, 0);
  const t = safeNum(total, 0);
  if (t <= 0) return 0;
  return Number(((p / t) * 100).toFixed(2));
}

function toIso(value) {
  if (!value) return null;
  try {
    return new Date(value).toISOString();
  } catch (_) {
    return null;
  }
}

async function tableExists(tableName) {
  const cacheKey = `exists:${tableName}`;
  const cached = _schemaCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SCHEMA_CACHE_TTL_MS) return cached.value;

  const res = await pool.query(
    `
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
    ) AS exists
    `,
    [tableName]
  );

  const value = Boolean(res.rows?.[0]?.exists);
  _schemaCache.set(cacheKey, { value, ts: Date.now() });
  return value;
}

async function getTableColumns(tableName) {
  const cacheKey = `cols:${tableName}`;
  const cached = _schemaCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SCHEMA_CACHE_TTL_MS) return cached.value;

  const res = await pool.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
    `,
    [tableName]
  );

  const value = (res.rows || []).map((r) => r.column_name);
  _schemaCache.set(cacheKey, { value, ts: Date.now() });
  return value;
}

function pickFirstExisting(columns, candidates) {
  for (const candidate of candidates) {
    if (columns.includes(candidate)) return candidate;
  }
  return null;
}

async function getLatestTimestamp(
  tableName,
  candidates = ["created_at", "updated_at", "evaluated_at", "checked_at"]
) {
  try {
    const exists = await tableExists(tableName);
    if (!exists) return null;

    const columns = await getTableColumns(tableName);
    const tsCol = pickFirstExisting(columns, candidates);
    if (!tsCol) return null;

    const res = await pool.query(`SELECT MAX(${tsCol}) AS ts FROM ${tableName}`);
    return toIso(res.rows?.[0]?.ts);
  } catch (err) {
    logger.warn(`getLatestTimestamp(${tableName}) failed`, { message: err.message });
    return null;
  }
}

async function getRowCount(tableName) {
  try {
    const exists = await tableExists(tableName);
    if (!exists) return 0;
    const res = await pool.query(`SELECT COUNT(*)::int AS c FROM ${tableName}`);
    return safeNum(res.rows?.[0]?.c, 0);
  } catch (err) {
    logger.warn(`getRowCount(${tableName}) failed`, { message: err.message });
    return 0;
  }
}

async function getRecentCount(tableName, lookbackHours = DEFAULT_LOOKBACK_HOURS) {
  try {
    const exists = await tableExists(tableName);
    if (!exists) return 0;

    const columns = await getTableColumns(tableName);
    const tsCol = pickFirstExisting(columns, ["created_at", "updated_at", "evaluated_at", "checked_at"]);
    if (!tsCol) return 0;

    const res = await pool.query(
      `
      SELECT COUNT(*)::int AS c
      FROM ${tableName}
      WHERE ${tsCol} >= NOW() - ($1 || ' hours')::interval
      `,
      [String(lookbackHours)]
    );

    return safeNum(res.rows?.[0]?.c, 0);
  } catch (err) {
    logger.warn(`getRecentCount(${tableName}) failed`, { message: err.message });
    return 0;
  }
}

async function getWatchlistStats() {
  const exists = await tableExists("watchlist_symbols");
  if (!exists) {
    return {
      total: 0,
      active: 0,
      byRegion: {},
      byPriorityTier: {},
    };
  }

  const totalRes = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM watchlist_symbols
  `);

  const activeRes = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM watchlist_symbols
    WHERE is_active = TRUE
  `);

  const regionRes = await pool.query(`
    SELECT LOWER(COALESCE(region, 'us')) AS region, COUNT(*)::int AS c
    FROM watchlist_symbols
    WHERE is_active = TRUE
    GROUP BY 1
    ORDER BY 2 DESC
  `);

  const tierRes = await pool.query(`
    SELECT
      CASE
        WHEN COALESCE(priority, 100) <= 30 THEN 'core'
        WHEN COALESCE(priority, 100) <= 80 THEN 'high'
        WHEN COALESCE(priority, 100) <= 180 THEN 'standard'
        ELSE 'extended'
      END AS tier,
      COUNT(*)::int AS c
    FROM watchlist_symbols
    WHERE is_active = TRUE
    GROUP BY 1
    ORDER BY 2 DESC
  `);

  const byRegion = {};
  for (const row of regionRes.rows || []) {
    byRegion[row.region] = safeNum(row.c, 0);
  }

  const byPriorityTier = {};
  for (const row of tierRes.rows || []) {
    byPriorityTier[row.tier] = safeNum(row.c, 0);
  }

  return {
    total: safeNum(totalRes.rows?.[0]?.c, 0),
    active: safeNum(activeRes.rows?.[0]?.c, 0),
    byRegion,
    byPriorityTier,
  };
}

async function getUniverseStats() {
  const exists = await tableExists("universe_symbols");
  if (!exists) {
    return {
      total: 0,
      active: 0,
      byRegion: {},
    };
  }

  const columns = await getTableColumns("universe_symbols");
  const hasIsActive = columns.includes("is_active");
  const hasRegion = columns.includes("region");

  const totalRes = await pool.query(`
    SELECT COUNT(*)::int AS c
    FROM universe_symbols
  `);

  const total = safeNum(totalRes.rows?.[0]?.c, 0);
  let active = 0;
  if (hasIsActive) {
    const activeRes = await pool.query(`
      SELECT COUNT(*)::int AS c
      FROM universe_symbols
      WHERE is_active = TRUE
    `);
    active = safeNum(activeRes.rows?.[0]?.c, 0);
  } else {
    active = total;
  }

  const byRegion = {};
  if (hasRegion) {
    const regionRes = hasIsActive
      ? await pool.query(`
          SELECT LOWER(COALESCE(region, 'unknown')) AS region, COUNT(*)::int AS c
          FROM universe_symbols
          WHERE is_active = TRUE
          GROUP BY 1
          ORDER BY 2 DESC
        `)
      : await pool.query(`
          SELECT LOWER(COALESCE(region, 'unknown')) AS region, COUNT(*)::int AS c
          FROM universe_symbols
          GROUP BY 1
          ORDER BY 2 DESC
        `);

    for (const row of regionRes.rows || []) {
      byRegion[row.region] = safeNum(row.c, 0);
    }
  }

  return {
    total,
    active,
    byRegion,
  };
}

async function getMarketSnapshotStats(lookbackHours = DEFAULT_LOOKBACK_HOURS) {
  const exists = await tableExists("market_snapshots");
  if (!exists) {
    return {
      totalRows: 0,
      recentRows: 0,
      recentSymbols: 0,
      latestRunAt: null,
      bySource: {},
    };
  }

  const totalRows = await getRowCount("market_snapshots");
  const recentRows = await getRecentCount("market_snapshots", lookbackHours);
  const latestRunAt = await getLatestTimestamp("market_snapshots");

  const distinctRes = await pool.query(
    `
    SELECT COUNT(DISTINCT symbol)::int AS c
    FROM market_snapshots
    WHERE created_at >= NOW() - ($1 || ' hours')::interval
    `,
    [String(lookbackHours)]
  );

  const sourceRes = await pool.query(
    `
    SELECT UPPER(COALESCE(source, 'unknown')) AS source, COUNT(*)::int AS c
    FROM market_snapshots
    WHERE created_at >= NOW() - ($1 || ' hours')::interval
    GROUP BY 1
    ORDER BY 2 DESC
    `,
    [String(lookbackHours)]
  );

  const bySource = {};
  for (const row of sourceRes.rows || []) {
    bySource[row.source] = safeNum(row.c, 0);
  }

  return {
    totalRows,
    recentRows,
    recentSymbols: safeNum(distinctRes.rows?.[0]?.c, 0),
    latestRunAt,
    bySource,
  };
}

async function getHqsStats(lookbackHours = DEFAULT_LOOKBACK_HOURS) {
  const exists = await tableExists("hqs_scores");
  if (!exists) {
    return {
      totalRows: 0,
      recentRows: 0,
      latestAt: null,
    };
  }

  return {
    totalRows: await getRowCount("hqs_scores"),
    recentRows: await getRecentCount("hqs_scores", lookbackHours),
    latestAt: await getLatestTimestamp("hqs_scores"),
  };
}

async function getFactorHistoryStats(
  lookbackHours = DEFAULT_LOOKBACK_HOURS,
  longLookbackDays = DEFAULT_LONG_LOOKBACK_DAYS
) {
  const exists = await tableExists("factor_history");
  if (!exists) {
    return {
      totalRows: 0,
      recentRows: 0,
      latestAt: null,
      recentUniqueSymbols: 0,
      averageHqsScore7d: null,
      byRegime7d: {},
    };
  }

  const totalRows = await getRowCount("factor_history");
  const recentRows = await getRecentCount("factor_history", lookbackHours);
  const latestAt = await getLatestTimestamp("factor_history");

  const uniqueRes = await pool.query(
    `
    SELECT COUNT(DISTINCT symbol)::int AS c
    FROM factor_history
    WHERE created_at >= NOW() - ($1 || ' days')::interval
    `,
    [String(longLookbackDays)]
  );

  const avgRes = await pool.query(
    `
    SELECT AVG(hqs_score)::numeric AS avg_hqs
    FROM factor_history
    WHERE created_at >= NOW() - ($1 || ' days')::interval
    `,
    [String(longLookbackDays)]
  );

  const regimeRes = await pool.query(
    `
    SELECT LOWER(COALESCE(regime, 'unknown')) AS regime, COUNT(*)::int AS c
    FROM factor_history
    WHERE created_at >= NOW() - ($1 || ' days')::interval
    GROUP BY 1
    ORDER BY 2 DESC
    `,
    [String(longLookbackDays)]
  );

  const byRegime7d = {};
  for (const row of regimeRes.rows || []) {
    byRegime7d[row.regime] = safeNum(row.c, 0);
  }

  return {
    totalRows,
    recentRows,
    latestAt,
    recentUniqueSymbols: safeNum(uniqueRes.rows?.[0]?.c, 0),
    averageHqsScore7d:
      avgRes.rows?.[0]?.avg_hqs !== null
        ? Number(Number(avgRes.rows[0].avg_hqs).toFixed(2))
        : null,
    byRegime7d,
  };
}

async function getWeightHistoryStats(lookbackHours = DEFAULT_LOOKBACK_HOURS) {
  const exists = await tableExists("weight_history");
  if (!exists) {
    return {
      totalRows: 0,
      recentRows: 0,
      latestAt: null,
      regimesTracked: 0,
    };
  }

  const totalRows = await getRowCount("weight_history");
  const recentRows = await getRecentCount("weight_history", lookbackHours);
  const latestAt = await getLatestTimestamp("weight_history");

  const cols = await getTableColumns("weight_history");
  let regimesTracked = 0;

  if (cols.includes("regime")) {
    const regimeRes = await pool.query(`
      SELECT COUNT(DISTINCT regime)::int AS c
      FROM weight_history
      WHERE regime IS NOT NULL
    `);
    regimesTracked = safeNum(regimeRes.rows?.[0]?.c, 0);
  }

  return {
    totalRows,
    recentRows,
    latestAt,
    regimesTracked,
  };
}

async function getAdvancedMetricsStats(lookbackHours = DEFAULT_LOOKBACK_HOURS) {
  const exists = await tableExists("market_advanced_metrics");
  if (!exists) {
    return {
      totalRows: 0,
      recentRows: 0,
      latestAt: null,
    };
  }

  return {
    totalRows: await getRowCount("market_advanced_metrics"),
    recentRows: await getRecentCount("market_advanced_metrics", lookbackHours),
    latestAt: await getLatestTimestamp("market_advanced_metrics"),
  };
}

async function getOutcomeTrackingStats(lookbackHours = DEFAULT_LOOKBACK_HOURS) {
  const exists = await tableExists("outcome_tracking");
  if (!exists) {
    return {
      totalRows: 0,
      recentRows: 0,
      latestAt: null,
      completedRows: 0,
      completionRate: 0,
    };
  }

  const totalRows = await getRowCount("outcome_tracking");
  const recentRows = await getRecentCount("outcome_tracking", lookbackHours);
  const latestAt = await getLatestTimestamp("outcome_tracking", [
    "created_at",
    "updated_at",
    "evaluated_at",
  ]);

  const cols = await getTableColumns("outcome_tracking");
  let completedRows = 0;

  if (cols.includes("is_evaluated")) {
    const res = await pool.query(`
      SELECT COUNT(*)::int AS c
      FROM outcome_tracking
      WHERE is_evaluated = TRUE
    `);
    completedRows = safeNum(res.rows?.[0]?.c, 0);
  } else if (cols.includes("evaluated_at")) {
    const res = await pool.query(`
      SELECT COUNT(*)::int AS c
      FROM outcome_tracking
      WHERE evaluated_at IS NOT NULL
    `);
    completedRows = safeNum(res.rows?.[0]?.c, 0);
  }

  return {
    totalRows,
    recentRows,
    latestAt,
    completedRows,
    completionRate: pct(completedRows, totalRows),
  };
}

async function getDiscoveryStats(
  lookbackHours = DEFAULT_LOOKBACK_HOURS,
  longLookbackDays = DEFAULT_LONG_LOOKBACK_DAYS
) {
  const exists = await tableExists("discovery_history");
  if (!exists) {
    return {
      totalRows: 0,
      recentRows: 0,
      latestAt: null,
      recentUniqueSymbols: 0,
    };
  }

  const totalRows = await getRowCount("discovery_history");
  const recentRows = await getRecentCount("discovery_history", lookbackHours);
  const latestAt = await getLatestTimestamp("discovery_history");

  const cols = await getTableColumns("discovery_history");
  let recentUniqueSymbols = 0;

  if (cols.includes("symbol")) {
    const res = await pool.query(
      `
      SELECT COUNT(DISTINCT symbol)::int AS c
      FROM discovery_history
      WHERE created_at >= NOW() - ($1 || ' days')::interval
      `,
      [String(longLookbackDays)]
    );
    recentUniqueSymbols = safeNum(res.rows?.[0]?.c, 0);
  }

  return {
    totalRows,
    recentRows,
    latestAt,
    recentUniqueSymbols,
  };
}

async function getJobLockStats() {
  const exists = await tableExists("job_locks");
  if (!exists) {
    return {
      totalLocks: 0,
      activeLocks: 0,
      lockNames: [],
    };
  }

  const cols = await getTableColumns("job_locks");
  const nameCol = pickFirstExisting(cols, ["job_name", "name", "key"]);
  const untilCol = pickFirstExisting(cols, ["locked_until", "expires_at"]);

  const totalLocks = await getRowCount("job_locks");
  let activeLocks = 0;
  let lockNames = [];

  if (untilCol) {
    const activeRes = await pool.query(
      `SELECT COUNT(*)::int AS c FROM job_locks WHERE ${untilCol} > NOW()`
    );
    activeLocks = safeNum(activeRes.rows?.[0]?.c, 0);
  }

  if (nameCol) {
    const namesRes = await pool.query(
      `SELECT ${nameCol} AS name FROM job_locks ORDER BY ${nameCol} ASC`
    );
    lockNames = (namesRes.rows || []).map((r) => r.name).filter(Boolean);
  }

  return {
    totalLocks,
    activeLocks,
    lockNames,
  };
}

async function getNotificationStats() {
  const usersExists = await tableExists("briefing_users");
  const sentExists = await tableExists("notifications");

  let activeUsers = 0;
  let notificationsSent24h = 0;
  let latestNotificationAt = null;

  if (usersExists) {
    const res = await pool.query(`
      SELECT COUNT(*)::int AS c
      FROM briefing_users
      WHERE is_active = TRUE
    `);
    activeUsers = safeNum(res.rows?.[0]?.c, 0);
  }

  if (sentExists) {
    notificationsSent24h = await getRecentCount("notifications", DEFAULT_LOOKBACK_HOURS);
    latestNotificationAt = await getLatestTimestamp("notifications");
  }

  return {
    activeUsers,
    notificationsSent24h,
    latestNotificationAt,
  };
}

async function getCoverageStats(snapshotStats, hqsStats, advancedStats, outcomeStats, universeStats) {
  const activeUniverse = safeNum(universeStats?.active, 0);
  const recentSnapshotSymbols = safeNum(snapshotStats?.recentSymbols, 0);

  const snapshotUniverseCoverage = pct(recentSnapshotSymbols, activeUniverse);
  const hqsCoverageVsSnapshots = pct(hqsStats?.recentRows, snapshotStats?.recentRows);
  const advancedCoverageVsSnapshots = pct(advancedStats?.recentRows, snapshotStats?.recentRows);
  const outcomeCoverageVsSnapshots = pct(outcomeStats?.recentRows, snapshotStats?.recentRows);

  return {
    snapshotUniverseCoverage,
    hqsCoverageVsSnapshots,
    advancedCoverageVsSnapshots,
    outcomeCoverageVsSnapshots,
  };
}

async function getAdminInsights(options = {}) {
  const lookbackHours = safeNum(options.lookbackHours, DEFAULT_LOOKBACK_HOURS);
  const longLookbackDays = safeNum(options.longLookbackDays, DEFAULT_LONG_LOOKBACK_DAYS);

  const partialErrors = [];
  const emptyFields = [];

  async function safeCall(name, fn, fallback) {
    try {
      const result = await fn();
      return result;
    } catch (err) {
      logger.warn(`adminInsights: ${name} failed`, { message: err.message });
      partialErrors.push({ field: name, error: err.message });
      return fallback;
    }
  }

  // Run all independent stats queries in parallel to cut serial latency.
  const [
    universeStats,
    watchlist,
    snapshots,
    hqs,
    factorHistory,
    weightHistory,
    advancedMetrics,
    outcomes,
    discovery,
    jobLocks,
    notifications,
  ] = await Promise.all([
    safeCall(
      "universe",
      () => getUniverseStats(),
      { total: 0, active: 0, byRegion: {} }
    ),
    safeCall(
      "watchlist",
      () => getWatchlistStats(),
      { total: 0, active: 0, byRegion: {}, byPriorityTier: {} }
    ),
    safeCall(
      "snapshots",
      () => getMarketSnapshotStats(lookbackHours),
      { totalRows: 0, recentRows: 0, recentSymbols: 0, latestRunAt: null, bySource: {} }
    ),
    safeCall(
      "hqs",
      () => getHqsStats(lookbackHours),
      { totalRows: 0, recentRows: 0, latestAt: null }
    ),
    safeCall(
      "factorHistory",
      () => getFactorHistoryStats(lookbackHours, longLookbackDays),
      {
        totalRows: 0,
        recentRows: 0,
        latestAt: null,
        recentUniqueSymbols: 0,
        averageHqsScore7d: null,
        byRegime7d: {},
      }
    ),
    safeCall(
      "weightHistory",
      () => getWeightHistoryStats(lookbackHours),
      { totalRows: 0, recentRows: 0, latestAt: null, regimesTracked: 0 }
    ),
    safeCall(
      "advancedMetrics",
      () => getAdvancedMetricsStats(lookbackHours),
      { totalRows: 0, recentRows: 0, latestAt: null }
    ),
    safeCall(
      "outcomes",
      () => getOutcomeTrackingStats(lookbackHours),
      { totalRows: 0, recentRows: 0, latestAt: null, completedRows: 0, completionRate: 0 }
    ),
    safeCall(
      "discovery",
      () => getDiscoveryStats(lookbackHours, longLookbackDays),
      { totalRows: 0, recentRows: 0, latestAt: null, recentUniqueSymbols: 0 }
    ),
    safeCall(
      "jobLocks",
      () => getJobLockStats(),
      { totalLocks: 0, activeLocks: 0, lockNames: [] }
    ),
    safeCall(
      "notifications",
      () => getNotificationStats(),
      { activeUsers: 0, notificationsSent24h: 0, latestNotificationAt: null }
    ),
  ]);

  let coverage = {
    snapshotUniverseCoverage: 0,
    hqsCoverageVsSnapshots: 0,
    advancedCoverageVsSnapshots: 0,
    outcomeCoverageVsSnapshots: 0,
  };

  try {
    coverage = await getCoverageStats(snapshots, hqs, advancedMetrics, outcomes, universeStats);
  } catch (err) {
    logger.warn("adminInsights: coverage calculation failed", { message: err.message });
    partialErrors.push({ field: "coverage", error: err.message });
  }

  if (universeStats.active === 0) emptyFields.push("universe_symbols");
  if (snapshots.totalRows === 0) emptyFields.push("market_snapshots");
  if (hqs.totalRows === 0) emptyFields.push("hqs_scores");
  if (factorHistory.totalRows === 0) emptyFields.push("factor_history");
  if (advancedMetrics.totalRows === 0) emptyFields.push("market_advanced_metrics");
  if (outcomes.totalRows === 0) emptyFields.push("outcome_tracking");
  if (discovery.totalRows === 0) emptyFields.push("discovery_history");

  let dataStatus = "full";
  if (partialErrors.length > 0) {
    dataStatus = "partial";
  } else if (emptyFields.length >= EMPTY_STATUS_THRESHOLD) {
    dataStatus = "empty";
  }

  return {
    generatedAt: new Date().toISOString(),
    lookbackHours,
    longLookbackDays,

    system: {
      jobLocks,
      notifications,
    },
    universe: universeStats,
    watchlist,
    activity: {
      snapshots,
      hqs,
      factorHistory,
      weightHistory,
      advancedMetrics,
      outcomes,
      discovery,
    },
    coverage,
    quickFacts: {
      activeUniverse: universeStats.active,
      recentProcessedSymbols: snapshots.recentSymbols,
      latestSnapshotAt: snapshots.latestRunAt,
      latestFactorUpdateAt: factorHistory.latestAt,
      latestWeightUpdateAt: weightHistory.latestAt,
      latestDiscoveryAt: discovery.latestAt,
      latestAdvancedMetricsAt: advancedMetrics.latestAt,
      latestOutcomeTrackingAt: outcomes.latestAt,
    },
    _meta: {
      dataStatus,
      partialErrors,
      emptyFields,
    },
  };
}

module.exports = {
  getAdminInsights,
};
