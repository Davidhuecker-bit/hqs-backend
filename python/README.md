# Python Services — HQS Backend

## Overview

Python-based services are **completely separated** from the Node.js HQS Backend
to avoid build and runtime conflicts. Each Python service lives in its own
subdirectory with its own build configuration and can be deployed as a
standalone Railway service.

## Why separated?

The HQS Backend is a Node.js application. Mixing Python into the same build
(via `railpack.json`, `nixpacks.toml`, or a shared `requirements.txt` at the
repo root) caused repeated build failures:

1. `npm: not found` — Python provider took over the build
2. `node: not found` — Node runtime was not installed
3. `Cannot find module 'express'` — `npm ci` was disrupted by pip install

The fix: Python services have their own build path and never touch the
Node.js install step.

## Available Python Services

### Historical Backfill (`python/historical-backfill/`)

Bulk-backfills historical daily price data into the `prices_daily` table.

**Files:**
- `historicalBackfill.job.py` — Main job script
- `requirements.txt` — Python dependencies (psycopg2, requests, python-dotenv)
- `railpack.json` — Railpack build config (Python 3.11 only)
- `start.sh` — Entry point for Railway

**Deploy as a separate Railway service:**

1. Create a new Railway service in your project (e.g. "Historical Backfill")
2. Point it at the same GitHub repo
3. Set the **Root Directory** to `python/historical-backfill`
4. Set the **Start Command** to `bash start.sh`
5. Configure environment variables:
   - `DATABASE_URL` — PostgreSQL connection string (same as HQS Backend)
   - Any API keys needed by the backfill script
6. Deploy — Railpack will auto-detect `railpack.json` and build Python-only

## Adding More Python Services

1. Create a new subdirectory under `python/` (e.g. `python/my-new-service/`)
2. Add `requirements.txt`, `railpack.json`, and a `start.sh`
3. Deploy as a separate Railway service with root directory set to the subdirectory
4. Never add Python dependencies or build steps to the root `railpack.json` or `nixpacks.toml`
