"use strict";

// services/adminInsights.service.js
// Liest Systemzustand, Aktivität, Coverage und Lernsignale aus der DB
// Ohne dein laufendes Kernsystem zu verändern.

const { Pool } = require("pg");

let logger = console;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = console;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const DEFAULT_LOOKBACK_HOURS = Number(process.env.ADMIN_LOOKBACK_HOURS || 24);
const DEFAULT_LONG_LOOKBACK_DAYS = Number(process.env.ADMIN_LONG_LOOKBACK_DAYS || 7);

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

  return Boolean(res.rows?.[0]?.exists);
}

async function getTableColumns(tableName) {
  const res = await pool.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
    `,
    [tableName]
  );

  return (res.rows || []).map((r) => r.column_name);
}

function pickFirstExisting(columns, candidates) {
  for (const candidate of candidates) {
    if (columns.includes(candidate)) return candidate;
  }
  return null;
}

async function getLatestTimestamp(tableName, candidates = ["created_at", "updated_at", "evaluated_at", "checked_at"]) {
  const exists = await tableExists(tableName);
  if (!exists) return null;

  const columns = await getTableColumns(tableName);
  const tsCol = pickFirstExisting(columns, candidates);
  if (!tsCol) return null;

  const res = await pool.query(`SELECT MAX(${tsCol}) AS ts FROM ${tableName}`);
  return toIso(res.rows?.[0]?.ts);
}

async function getRowCount(tableName) {
  const exists = await tableExists(tableName);
  if (!exists) return 0;

  const res = await pool.query(`SELECT COUNT(*)::int AS c FROM ${tableName}`);
  return safeNum(res.rows?.[0]?.c, 0);
}

async function getRecentCount(tableName, lookbackHours = DEFAULT_LOOKBACK_HOURS) {
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

  const totalRes = await pool.query(
    `SELECT COUNT(*)::int AS c FROM watchlist_symbols`
  );
  const activeRes = await pool.query(
    `SELECT COUNT(*)::int AS c FROM watchlist_symbols WHERE is_active = TRUE`
  );
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

async function getSnapshotState() {
  const exists = await tableExists("snapshot_scan_state");
  if (!exists) {
    return {
      offset: 0,
      updatedAt: null,
    };
  }

  const res = await pool.query(`
    SELECT offset_value, updated_at
    FROM snapshot_scan_state
    WHERE key = 'snapshot_watchlist_offset'
    LIMIT 1
  `);

  return {
    offset: safeNum(res.rows?.[0]?.offset_value, 0),
    updatedAt: toIso(res.rows?.[0]?.updated_at),
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

async function getFactorHistoryStats(lookbackHours = DEFAULT_LOOKBACK_HOURS, longLookbackDays = DEFAULT_LONG_LOOKBACK_DAYS) {
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

async function getDiscoveryStats(lookbackHours = DEFAULT_LOOKBACK_HOURS, longLookbackDays = DEFAULT_LONG_LOOKBACK_DAYS) {
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

async function getCoverageStats(snapshotStats, hqsStats, advancedStats, outcomeStats, watchlistStats) {
  const activeUniverse = safeNum(watchlistStats?.active, 0);
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

  try {
    const [
      watchlist,
      snapshotState,
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
      getWatchlistStats(),
      getSnapshotState(),
      getMarketSnapshotStats(lookbackHours),
      getHqsStats(lookbackHours),
      getFactorHistoryStats(lookbackHours, longLookbackDays),
      getWeightHistoryStats(lookbackHours),
      getAdvancedMetricsStats(lookbackHours),
      getOutcomeTrackingStats(lookbackHours),
      getDiscoveryStats(lookbackHours, longLookbackDays),
      getJobLockStats(),
      getNotificationStats(),
    ]);

    const coverage = await getCoverageStats(
      snapshots,
      hqs,
      advancedMetrics,
      outcomes,
      watchlist
    );

    return {
      generatedAt: new Date().toISOString(),
      lookbackHours,
      longLookbackDays,

      system: {
        snapshotState,
        jobLocks,
        notifications,
      },

      universe: watchlist,

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
        activeUniverse: watchlist.active,
        recentProcessedSymbols: snapshots.recentSymbols,
        latestSnapshotAt: snapshots.latestRunAt,
        latestFactorUpdateAt: factorHistory.latestAt,
        latestWeightUpdateAt: weightHistory.latestAt,
        latestDiscoveryAt: discovery.latestAt,
        latestAdvancedMetricsAt: advancedMetrics.latestAt,
        latestOutcomeTrackingAt: outcomes.latestAt,
      },
    };
  } catch (error) {
    logger.error("adminInsights.getAdminInsights failed", {
      message: error.message,
    });

    return {
      generatedAt: new Date().toISOString(),
      error: error.message,
      system: {},
      universe: {},
      activity: {},
      coverage: {},
      quickFacts: {},
    };
  }
}

module.exports = {
  getAdminInsights,
};
