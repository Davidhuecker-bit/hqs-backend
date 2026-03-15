# Railway deployment checklist

## How Railway deploys this project

The `railway.toml` at the root of this repository configures Railway automatically:
- **Start command**: `npm start` (runs `node server.js` with a pre-start syntax check)
- **Health check**: `GET /health` — Railway monitors this endpoint and restarts on failure
- **Restart policy**: restarts on failure, up to 3 times

Railway will detect Node.js automatically via `package.json` and install dependencies with `npm install` before starting.

## Environment variables you must set in Railway

### Required

| Variable | Description |
|---|---|
| `DATABASE_URL` | Connection string for the Railway PostgreSQL plugin (added automatically if you attach a PostgreSQL service) |

### Strongly recommended

| Variable | Example | Description |
|---|---|---|
| `CORS_ORIGINS` | `https://app.up.railway.app,https://mydomain.com` | Comma-separated list of frontend origins that may call this API |
| `OPENAI_API_KEY` | `sk-...` | Required for AI analysis routes; the server boots without it but AI endpoints will fail |
| `MASSIVE_API_KEY` **or** `TWELVE_DATA_API_KEY` | | At least one market data provider must be set for quotes and historical data |

### Optional

| Variable | Default | Description |
|---|---|---|
| `FMP_API_KEY` | — | Financial Modeling Prep key; enables universe refresh and fundamental data |
| `FINNHUB_API_KEY` | — | Finnhub key; enables candlestick data |
| `RUN_JOBS` | `false` | Set to `true` only if you want background scan jobs to run inside this service |
| `OPENAI_MODEL` | `gpt-4o-mini` | OpenAI model to use for AI routes |
| `UPSTASH_REDIS_REST_URL` | — | Upstash Redis endpoint for distributed caching (optional; falls back to in-memory) |
| `UPSTASH_REDIS_REST_TOKEN` | — | Upstash Redis token (required when `UPSTASH_REDIS_REST_URL` is set) |
| `UNIVERSE_REFRESH_HOUR` | `2` | Hour (local server time) to refresh the stock universe daily |
| `UNIVERSE_REFRESH_MINUTE` | `10` | Minute for universe refresh |
| `SNAPSHOT_BATCH_SIZE` | `80` | Number of symbols per snapshot batch |
| `MC_SIMS` | `800` | Number of Monte Carlo simulations per snapshot |

## Step-by-step Railway setup

1. **Create a new Railway project** and connect this GitHub repository.
2. **Add a PostgreSQL plugin** inside the Railway project. Railway will automatically set `DATABASE_URL` for the backend service.
3. **Set the remaining environment variables** listed above under _Strongly recommended_ in the Railway service settings → Variables tab.
4. **Deploy**. Railway will pick up `railway.toml` and start the server with `npm start`.
5. **Verify** by opening `https://<your-railway-domain>/health`. You should see `"ready": true` once the database tables have been initialised on first boot.

## What this repository supports

- `GET /health` returns startup readiness, database status, and the last startup error.
- `GET /api/admin/action-plan` returns the current backend adjustments and the most important next step.
- `CORS_ORIGINS` lets you allow additional Railway/custom frontend domains without changing code.
- `.env.example` lists all supported environment variables with their defaults.
- SSL for the PostgreSQL connection uses `rejectUnauthorized: false` by default, which works with Railway's managed PostgreSQL certificate.
