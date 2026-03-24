#!/bin/bash
# Railway service dispatcher
# Routes to the correct entry point based on RAILWAY_SERVICE_NAME.
# Each cron service in Railway must have its service name match one of the
# cases below so it runs its dedicated job instead of the full backend server.
set -e

SERVICE="${RAILWAY_SERVICE_NAME:-}"

case "$SERVICE" in
  "Scan Markt Snapshot")
    echo "[start.sh] Starting job: snapshot-scan (service: $SERVICE)"
    exec npm run job:snapshot-scan
    ;;
  "Cron Markt-News"|"cron-markt-news-sammeln")
    # cron-markt-news-sammeln is a duplicate of Cron Markt-News – both run the same job.
    echo "[start.sh] Starting job: market-news-refresh (service: $SERVICE)"
    exec npm run job:market-news-refresh
    ;;
  "cron-entity-map-erstellen")
    echo "[start.sh] Starting job: build-entity-map (service: $SERVICE)"
    exec npm run job:build-entity-map
    ;;
  "Cron Aktien Universum")
    echo "[start.sh] Starting job: universe-refresh (service: $SERVICE)"
    exec npm run job:universe-refresh
    ;;
  "Cron tägliches Briefing"|"Cron taegliches Briefing"|"cron-tagliches-briefing"|"cron-taegliches-briefing")
    echo "[start.sh] Starting job: daily-briefing (service: $SERVICE)"
    exec npm run job:daily-briefing
    ;;
  "HQS Backend"|"")
    echo "[start.sh] Starting HQS Backend server (service: ${SERVICE:-<unset>})"
    exec npm start
    ;;
  *)
    echo "[start.sh] Unknown service name '${SERVICE}' – falling back to npm start"
    exec npm start
    ;;
esac
