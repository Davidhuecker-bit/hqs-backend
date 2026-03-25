#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Railway service dispatcher
# ─────────────────────────────────────────────────────────────────────────────
# Routes to the correct entry point based on RAILWAY_SERVICE_NAME.
#
# IMPORTANT:
#   Only the "HQS Backend" service starts the full Express API server.
#   Every other Railway service MUST match one of the cron/worker cases below
#   so it runs its dedicated job script instead of server.js.
#
# If RAILWAY_SERVICE_NAME is unset or does not match any known service, the
# script exits with an error to prevent cron services from accidentally
# booting the full backend server.
# ─────────────────────────────────────────────────────────────────────────────
set -e

SERVICE="${RAILWAY_SERVICE_NAME:-}"
# Trim leading and trailing whitespace so names like " HQS Backend " match cleanly
SERVICE="${SERVICE#"${SERVICE%%[![:space:]]*}"}"
SERVICE="${SERVICE%"${SERVICE##*[![:space:]]}"}"

echo "[start.sh] RAILWAY_SERVICE_NAME = '${SERVICE:-<unset>}'"

case "$SERVICE" in

  # ── API Server ────────────────────────────────────────────────────────────
  "HQS Backend")
    echo "[start.sh] Starting HQS Backend API server"
    exec node server.js
    ;;

  # ── Cron / Worker Jobs ───────────────────────────────────────────────────

  "Scan Markt Snapshot")
    echo "[start.sh] Starting job: snapshot-scan"
    exec node jobs/snapshotScan.job.js
    ;;

  "Cron Markt-News")
    echo "[start.sh] Starting job: market-news-refresh"
    exec node jobs/marketNewsRefresh.job.js
    ;;

  "cron-entity-map-erstellen")
    echo "[start.sh] Starting job: build-entity-map"
    exec node jobs/buildEntityMap.job.js
    ;;

  "Cron Aktien Universum")
    echo "[start.sh] Starting job: universe-refresh"
    exec node jobs/universeRefresh.job.js
    ;;

  "Cron tägliches Briefing"|"Cron taegliches Briefing"|"cron-tagliches-briefing"|"cron-taegliches-briefing")
    echo "[start.sh] Starting job: daily-briefing"
    exec node jobs/dailyBriefing.job.js
    ;;

  "Discovery Notify"|"discovery-notify")
    echo "[start.sh] Starting job: discovery-notify"
    exec node jobs/discoveryNotify.job.js
    ;;

  "News Lifecycle Cleanup"|"news-lifecycle-cleanup")
    echo "[start.sh] Starting job: news-lifecycle-cleanup"
    exec node jobs/newsLifecycleCleanup.job.js
    ;;

  "Forecast Verification"|"forecast-verification")
    echo "[start.sh] Starting job: forecast-verification"
    exec node jobs/forecastVerification.job.js
    ;;

  "Causal Memory"|"causal-memory")
    echo "[start.sh] Starting job: causal-memory"
    exec node jobs/causalMemory.job.js
    ;;

  "Tech Radar"|"tech-radar")
    echo "[start.sh] Starting job: tech-radar"
    exec node jobs/techRadar.job.js
    ;;

  "Data Cleanup"|"data-cleanup")
    echo "[start.sh] Starting job: data-cleanup"
    exec node jobs/dataCleanup.job.js
    ;;

  "Evaluate Discoveries"|"evaluate-discoveries")
    echo "[start.sh] Starting job: evaluate-discoveries"
    exec node jobs/evaluateDiscoveries.job.js
    ;;

  "World State Refresh"|"world-state-refresh")
    echo "[start.sh] Starting job: world-state-refresh"
    exec node jobs/worldStateRefresh.job.js
    ;;

  "SEC EDGAR Refresh"|"sec-edgar-refresh")
    echo "[start.sh] Starting job: sec-edgar-refresh"
    exec node jobs/secEdgarRefresh.job.js
    ;;

  "UI Market List"|"ui-market-list")
    echo "[start.sh] Starting job: ui-market-list"
    exec node jobs/uiMarketList.job.js
    ;;

  "UI Demo Portfolio"|"ui-demo-portfolio")
    echo "[start.sh] Starting job: ui-demo-portfolio"
    exec node jobs/uiDemoPortfolio.job.js
    ;;

  "UI Guardian Status"|"ui-guardian-status")
    echo "[start.sh] Starting job: ui-guardian-status"
    exec node jobs/uiGuardianStatus.job.js
    ;;

  # ── Python services (OPTIONAL pre-warming – NOT required for pipeline) ──────
  # "Historical Backfill" is a Python job. It cannot run inside this Node-only
  # container. If deployed, it runs as a separate Railway service pointing at
  # python/historical-backfill/. The Node.js historicalService.js performs lazy
  # backfill on demand, so the pipeline works without this Python service.
  "Historical Backfill"|"historical-backfill")
    echo "[start.sh] ERROR: Historical Backfill is a Python service."
    echo "[start.sh] It must be deployed as a separate Railway service."
    echo "[start.sh] See python/README.md for setup instructions."
    exit 1
    ;;

  # ── Safety net ───────────────────────────────────────────────────────────
  # Unknown or unset service names must NOT fall back to npm start.
  # This prevents cron services from accidentally booting the full backend.
  "")
    echo "[start.sh] ERROR: RAILWAY_SERVICE_NAME is not set."
    echo "[start.sh] Set RAILWAY_SERVICE_NAME='HQS Backend' for the API service,"
    echo "[start.sh] or use the correct cron service name. Aborting."
    exit 1
    ;;
  *)
    echo "[start.sh] ERROR: Unknown service name '${SERVICE}'."
    echo "[start.sh] This service will NOT fall back to npm start."
    echo "[start.sh] Add this service to start.sh or fix RAILWAY_SERVICE_NAME. Aborting."
    exit 1
    ;;
esac
