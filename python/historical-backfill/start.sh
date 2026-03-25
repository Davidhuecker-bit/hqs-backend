#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Historical Backfill — standalone Python service entry point
# ─────────────────────────────────────────────────────────────────────────────
set -e
echo "[historical-backfill] Starting Python Historical Backfill job"
exec python3 historicalBackfill.job.py
