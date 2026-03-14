# Railway deployment checklist

## Railway steps you must do manually

1. Provision a PostgreSQL service and set `DATABASE_URL`.
2. Set `PG_SSL_REJECT_UNAUTHORIZED=false` unless you provide your own trusted certificate chain.
3. Add every frontend domain that should call this API to `CORS_ORIGINS` as a comma-separated list of literal origins, for example `https://app.up.railway.app,https://mydomain.com`.
4. Add the external provider secrets you want to use:
   - `OPENAI_API_KEY` (required for AI routes, but the API can now boot without it)
   - `FMP_API_KEY`
   - `FINNHUB_API_KEY`
   - `MASSIVE_API_KEY` and/or `TWELVE_DATA_API_KEY` for quotes/historical data (configure at least one)
5. Point Railway health checks to `GET /health`.
6. Keep `RUN_JOBS=false` for a pure API service. If you want background jobs in Railway too, run a separate worker service or enable the flag intentionally.

## What this repository now supports

- `GET /health` returns startup readiness and the last startup error.
- `CORS_ORIGINS` lets you allow additional Railway/custom frontend domains without changing code.
- `.env.example` lists the most important deployment variables.
