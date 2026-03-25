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
    exec npm start
    ;;

  # ── Cron / Worker Jobs ───────────────────────────────────────────────────

  "Scan Markt Snapshot")
    echo "[start.sh] Starting job: snapshot-scan"
    exec npm run job:snapshot-scan
    ;;

  "Cron Markt-News"|"cron-markt-news-sammeln")
    # NOTE: "cron-markt-news-sammeln" is a legacy duplicate of "Cron Markt-News".
    # Both names route to the same job. The duplicate should be removed in
    # Railway once confirmed that only one service exists.
    echo "[start.sh] Starting job: market-news-refresh (service: $SERVICE)"
    exec npm run job:market-news-refresh
    ;;

  "cron-entity-map-erstellen")
    echo "[start.sh] Starting job: build-entity-map"
    exec npm run job:build-entity-map
    ;;

  "Cron Aktien Universum")
    echo "[start.sh] Starting job: universe-refresh"
    exec npm run job:universe-refresh
    ;;

  "Cron tägliches Briefing"|"Cron taegliches Briefing"|"cron-tagliches-briefing"|"cron-taegliches-briefing")
    echo "[start.sh] Starting job: daily-briefing"
    exec npm run job:daily-briefing
    ;;

  "Discovery Notify"|"discovery-notify")
    echo "[start.sh] Starting job: discovery-notify"
    exec npm run job:discovery-notify
    ;;

  "News Lifecycle Cleanup"|"news-lifecycle-cleanup")
    echo "[start.sh] Starting job: news-lifecycle-cleanup"
    exec npm run job:news-lifecycle-cleanup
    ;;

  "Forecast Verification"|"forecast-verification")
    echo "[start.sh] Starting job: forecast-verification"
    exec npm run job:forecast-verification
    ;;

  "Causal Memory"|"causal-memory")
    echo "[start.sh] Starting job: causal-memory"
    exec npm run job:causal-memory
    ;;

  "Tech Radar"|"tech-radar")
    echo "[start.sh] Starting job: tech-radar"
    exec npm run job:tech-radar
    ;;

  "Data Cleanup"|"data-cleanup")
    echo "[start.sh] Starting job: data-cleanup"
    exec npm run job:data-cleanup
    ;;

  "UI Market List"|"ui-market-list")
    echo "[start.sh] Starting job: ui-market-list"
    exec npm run job:ui-market-list
    ;;

  "UI Demo Portfolio"|"ui-demo-portfolio")
    echo "[start.sh] Starting job: ui-demo-portfolio"
    exec npm run job:ui-demo-portfolio
    ;;

  "UI Guardian Status"|"ui-guardian-status")
    echo "[start.sh] Starting job: ui-guardian-status"
    exec npm run job:ui-guardian-status
    ;;

  "Historical Backfill"|"historical-backfill")
    echo "[start.sh] Starting job: historical-backfill"
    exec npm run job:historical-backfill
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
