"use strict";

// services/learningDiagnostics.service.js
// Zentrale Diagnose-/Status-Schicht für die Learning-Komponenten:
// feature_history, discovery_labels, outcome_tracking

let logger = console;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = console;
}

const { getSharedPool } = require("../config/database");
const pool = getSharedPool();

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toIso(value) {
  if (!value) return null;
  try {
    return new Date(value).toISOString();
  } catch (_) {
    return null;
  }
}

// ── featureHistory diagnostics ───────────────────────────────────────────────

async function getFeatureHistoryDiagnostics() {
  const defaults = {
    totalRows: 0,
    rowsLast24h: 0,
    rowsLast7d: 0,
    activeSymbols: 0,
    lastActivity: null,
    indicatorCounts: [],
  };

  try {
    // A. Summary – separate simple queries
    const [totalRes, last24hRes, last7dRes, activeSymbolsRes, lastActivityRes] =
      await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS c FROM feature_history`),
        pool.query(
          `SELECT COUNT(*)::int AS c FROM feature_history
           WHERE created_at >= NOW() - INTERVAL '24 hours'`
        ),
        pool.query(
          `SELECT COUNT(*)::int AS c FROM feature_history
           WHERE created_at >= NOW() - INTERVAL '7 days'`
        ),
        pool.query(
          `SELECT COUNT(DISTINCT symbol)::int AS c FROM feature_history
           WHERE created_at >= NOW() - INTERVAL '7 days'`
        ),
        pool.query(
          `SELECT MAX(created_at) AS last_activity FROM feature_history`
        ),
      ]);

    const totalRows = safeNum(totalRes.rows?.[0]?.c, 0);
    const rowsLast24h = safeNum(last24hRes.rows?.[0]?.c, 0);
    const rowsLast7d = safeNum(last7dRes.rows?.[0]?.c, 0);
    const activeSymbols = safeNum(activeSymbolsRes.rows?.[0]?.c, 0);
    const lastActivity = toIso(lastActivityRes.rows?.[0]?.last_activity);

    // B. Indicator distribution
    const indicatorRes = await pool.query(
      `SELECT indicator, COUNT(*)::int AS count
       FROM feature_history
       GROUP BY indicator
       ORDER BY count DESC`
    );
    const indicatorCounts = (indicatorRes.rows || []).map((r) => ({
      indicator: r.indicator,
      count: safeNum(r.count, 0),
    }));

    return {
      totalRows,
      rowsLast24h,
      rowsLast7d,
      activeSymbols,
      lastActivity,
      indicatorCounts,
    };
  } catch (err) {
    logger.warn("[learningDiagnostics] featureHistory query failed", {
      message: err.message,
    });
    return defaults;
  }
}

// ── discoveryLabels diagnostics ──────────────────────────────────────────────

async function getDiscoveryLabelsDiagnostics() {
  const defaults = {
    totalRows: 0,
    rowsLast24h: 0,
    rowsLast7d: 0,
    successCount: 0,
    failCount: 0,
    lastSignalTime: null,
    successRate: 0,
  };

  try {
    const [totalRes, last24hRes, last7dRes, successRes, failRes, lastSignalRes] =
      await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS c FROM discovery_labels`),
        pool.query(
          `SELECT COUNT(*)::int AS c FROM discovery_labels
           WHERE created_at >= NOW() - INTERVAL '24 hours'`
        ),
        pool.query(
          `SELECT COUNT(*)::int AS c FROM discovery_labels
           WHERE created_at >= NOW() - INTERVAL '7 days'`
        ),
        pool.query(
          `SELECT COUNT(*)::int AS c FROM discovery_labels
           WHERE success_label = TRUE`
        ),
        pool.query(
          `SELECT COUNT(*)::int AS c FROM discovery_labels
           WHERE success_label = FALSE`
        ),
        pool.query(
          `SELECT MAX(signal_time) AS last_signal FROM discovery_labels`
        ),
      ]);

    const totalRows = safeNum(totalRes.rows?.[0]?.c, 0);
    const rowsLast24h = safeNum(last24hRes.rows?.[0]?.c, 0);
    const rowsLast7d = safeNum(last7dRes.rows?.[0]?.c, 0);
    const successCount = safeNum(successRes.rows?.[0]?.c, 0);
    const failCount = safeNum(failRes.rows?.[0]?.c, 0);
    const lastSignalTime = toIso(lastSignalRes.rows?.[0]?.last_signal);

    const total = successCount + failCount;
    const successRate = total > 0 ? Number(((successCount / total) * 100).toFixed(2)) : 0;

    return {
      totalRows,
      rowsLast24h,
      rowsLast7d,
      successCount,
      failCount,
      lastSignalTime,
      successRate,
    };
  } catch (err) {
    logger.warn("[learningDiagnostics] discoveryLabels query failed", {
      message: err.message,
    });
    return defaults;
  }
}

// ── outcomeTracking readiness ────────────────────────────────────────────────
// Hinweis: outcome_tracking hat kein "captured_at" – wir verwenden "predicted_at"
// als zeitlichen Bezugspunkt (Zeitpunkt der Vorhersage).

async function getOutcomeTrackingReadiness() {
  const defaults = {
    totalRows: 0,
    rowsMature20d: 0,
    rowsMature30d: 0,
    lastCapture: null,
  };

  try {
    const [totalRes, mature20dRes, mature30dRes, lastCaptureRes] =
      await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS c FROM outcome_tracking`),
        pool.query(
          `SELECT COUNT(*)::int AS c FROM outcome_tracking
           WHERE predicted_at <= NOW() - INTERVAL '20 days'`
        ),
        pool.query(
          `SELECT COUNT(*)::int AS c FROM outcome_tracking
           WHERE predicted_at <= NOW() - INTERVAL '30 days'`
        ),
        pool.query(
          `SELECT MAX(predicted_at) AS last_capture FROM outcome_tracking`
        ),
      ]);

    return {
      totalRows: safeNum(totalRes.rows?.[0]?.c, 0),
      rowsMature20d: safeNum(mature20dRes.rows?.[0]?.c, 0),
      rowsMature30d: safeNum(mature30dRes.rows?.[0]?.c, 0),
      lastCapture: toIso(lastCaptureRes.rows?.[0]?.last_capture),
    };
  } catch (err) {
    logger.warn("[learningDiagnostics] outcomeTracking query failed", {
      message: err.message,
    });
    return defaults;
  }
}

// ── Statuslogik ──────────────────────────────────────────────────────────────

function deriveStatus(featureHistory, discoveryLabels, outcomeTrackingReadiness) {
  if (featureHistory.totalRows === 0) {
    return {
      status: "stalled",
      message:
        "Keine Feature-History-Daten vorhanden. Der Learning-Pipeline fehlt die Datenbasis.",
    };
  }

  if (featureHistory.rowsLast24h === 0) {
    return {
      status: "feature_history_stale",
      message:
        "Feature-History wird nicht mehr aktiv befüllt (keine Daten in den letzten 24 h).",
    };
  }

  if (
    outcomeTrackingReadiness.rowsMature20d === 0 &&
    discoveryLabels.totalRows === 0
  ) {
    return {
      status: "warming_up",
      message:
        "System befindet sich in der Aufwärmphase – Outcome-Daten noch nicht reif genug für Labeling.",
    };
  }

  if (
    outcomeTrackingReadiness.rowsMature20d > 0 &&
    discoveryLabels.totalRows === 0
  ) {
    return {
      status: "ready_to_label",
      message:
        "Ausreichend reife Outcome-Daten vorhanden. Labeling kann starten.",
    };
  }

  if (discoveryLabels.totalRows > 0 && discoveryLabels.rowsLast7d === 0) {
    return {
      status: "labels_stalled",
      message:
        "Discovery-Labels existieren, aber keine neuen Labels in den letzten 7 Tagen.",
    };
  }

  if (discoveryLabels.totalRows > 0) {
    return {
      status: "labels_active",
      message:
        "Learning-Pipeline ist aktiv – Labels werden generiert.",
    };
  }

  return {
    status: "unknown",
    message:
      "Status konnte nicht eindeutig bestimmt werden. Bitte manuelle Prüfung.",
  };
}

// ── Hauptfunktion ────────────────────────────────────────────────────────────

async function getLearningDiagnostics() {
  const [featureHistory, discoveryLabels, outcomeTrackingReadiness] =
    await Promise.all([
      getFeatureHistoryDiagnostics(),
      getDiscoveryLabelsDiagnostics(),
      getOutcomeTrackingReadiness(),
    ]);

  const { status, message } = deriveStatus(
    featureHistory,
    discoveryLabels,
    outcomeTrackingReadiness
  );

  return {
    featureHistory,
    discoveryLabels,
    outcomeTrackingReadiness,
    status,
    message,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { getLearningDiagnostics };
