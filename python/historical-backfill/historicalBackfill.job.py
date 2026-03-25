#!/usr/bin/env python3
"""
python/historical-backfill/historicalBackfill.job.py

Historical Price Backfill Job
==============================
Source of truth : prices_daily table
Data source     : Massive historical candles API
Scheduling      : Railway cron service "Historical Backfill"

What it does:
  1. Queries all active symbols that have < MIN_POINTS rows in prices_daily.
  2. For each such symbol, fetches up to FETCH_DAYS of daily OHLCV from Massive.
  3. Upserts the fetched rows into prices_daily (idempotent).
  4. Writes a pipeline_status row for the historical_backfill stage.

This job replaces the lazy write path that previously lived in
historicalService.js. historicalService is now a pure reader.

Usage:
  python3 historicalBackfill.job.py
"""

import math
import os
import sys
import time
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse, urlencode, urlunparse, parse_qs

import psycopg2
import psycopg2.extras
import requests
from dotenv import load_dotenv

load_dotenv()

# ── Configuration ──────────────────────────────────────────────────────────────

LOG_LEVEL     = os.environ.get("LOG_LEVEL", "INFO").upper()
DATABASE_URL  = os.environ.get("DATABASE_URL", "")
MASSIVE_KEY   = os.environ.get("MASSIVE_API_KEY", "")
MASSIVE_BASE  = "https://api.massive.com/v2/aggs/ticker"

MIN_POINTS    = 30      # minimum rows required – must match historicalService.js
LOOKBACK_DAYS = 365     # window used to count existing rows
FETCH_DAYS    = 730     # how far back to fetch from Massive (2 years)
MAX_WORKERS   = 5       # max concurrent Massive API calls
RETRY_COUNT   = 3
RETRY_BASE_S  = 0.4     # base seconds for exponential back-off

# ── Logging ────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [historical-backfill] %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger("historical-backfill")

# ── Database helpers ───────────────────────────────────────────────────────────

def _build_dsn() -> str:
    """Ensure sslmode=require is present (mirrors rejectUnauthorized:false in Node)."""
    parsed = urlparse(DATABASE_URL)
    params = parse_qs(parsed.query, keep_blank_values=True)
    if "sslmode" not in params:
        params["sslmode"] = ["require"]
    new_query = urlencode({k: v[0] for k, v in params.items()})
    return urlunparse(parsed._replace(query=new_query))


def connect_db():
    return psycopg2.connect(_build_dsn())


def ensure_prices_daily(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS prices_daily (
              id          SERIAL PRIMARY KEY,
              symbol      TEXT        NOT NULL,
              price_date  DATE        NOT NULL,
              close       NUMERIC     NOT NULL,
              open        NUMERIC,
              high        NUMERIC,
              low         NUMERIC,
              volume      BIGINT,
              source      TEXT        DEFAULT 'MASSIVE',
              created_at  TIMESTAMP   DEFAULT NOW(),
              UNIQUE (symbol, price_date)
            )
            """
        )
    conn.commit()


def load_symbols_needing_backfill(conn, days: int = LOOKBACK_DAYS, min_pts: int = MIN_POINTS, limit: int = 5000) -> list:
    """
    Return active symbols whose prices_daily row-count (within the lookback window)
    is below MIN_POINTS. These are the only symbols that need to be fetched.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT u.symbol
            FROM universe_symbols u
            LEFT JOIN (
                SELECT symbol, COUNT(*) AS cnt
                FROM prices_daily
                WHERE price_date >= CURRENT_DATE - %(days)s::int
                  AND close IS NOT NULL
                  AND close > 0
                GROUP BY symbol
            ) p ON p.symbol = u.symbol
            WHERE u.is_active = TRUE
              AND COALESCE(p.cnt, 0) < %(min_pts)s
            ORDER BY u.priority ASC, u.symbol ASC
            LIMIT %(limit)s
            """,
            {"days": days, "min_pts": min_pts, "limit": limit},
        )
        return [row[0].strip().upper() for row in cur.fetchall() if row[0]]


def upsert_candles(conn, symbol: str, candles: list) -> int:
    """
    Bulk-upsert daily candle rows into prices_daily.
    Returns number of rows written.  Idempotent on repeated runs.
    """
    rows = []
    for c in candles:
        try:
            close = float(c.get("close", 0))
            if not math.isfinite(close) or close <= 0:
                continue
            rows.append((
                symbol,
                c["date"],
                close,
                float(c["open"])   if c.get("open")   is not None else None,
                float(c["high"])   if c.get("high")   is not None else None,
                float(c["low"])    if c.get("low")    is not None else None,
                int(c["volume"])   if c.get("volume") is not None else None,
                str(c.get("source", "MASSIVE")),
            ))
        except (TypeError, ValueError, KeyError):
            continue

    if not rows:
        return 0

    with conn.cursor() as cur:
        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO prices_daily (symbol, price_date, close, open, high, low, volume, source)
            VALUES %s
            ON CONFLICT (symbol, price_date) DO UPDATE SET
              close  = EXCLUDED.close,
              open   = EXCLUDED.open,
              high   = EXCLUDED.high,
              low    = EXCLUDED.low,
              volume = EXCLUDED.volume,
              source = EXCLUDED.source
            """,
            rows,
            template="(%s, %s, %s, %s, %s, %s, %s, %s)",
        )
        count = cur.rowcount
    conn.commit()
    return count


# ── Massive API ────────────────────────────────────────────────────────────────

def fetch_massive_candles(symbol: str, from_date: str, to_date: str) -> list:
    """
    Fetch daily OHLCV candles from Massive.
    Returns list of dicts: {date, open, high, low, close, volume, source}.
    Retries on 429 / 5xx with exponential back-off.
    """
    url = f"{MASSIVE_BASE}/{symbol}/range/1/day/{from_date}/{to_date}"
    params = {
        "adjusted": "true",
        "sort": "desc",
        "limit": 5000,
        "apiKey": MASSIVE_KEY,
    }
    last_err = None
    for attempt in range(1, RETRY_COUNT + 1):
        try:
            resp = requests.get(url, params=params, timeout=30)
            if resp.status_code in (429, 500, 502, 503, 504):
                wait = RETRY_BASE_S * (2 ** (attempt - 1))
                log.warning("[massive] %s – HTTP %d, retry %d in %.1fs", symbol, resp.status_code, attempt, wait)
                time.sleep(wait)
                continue
            if resp.status_code == 404:
                return []
            resp.raise_for_status()
            data = resp.json()
            results = data.get("results") or []
            if not results:
                return []

            candles = []
            for r in results:
                t_ms      = r.get("t")
                close_raw = r.get("c")
                if t_ms is None or close_raw is None:
                    continue

                def _num(v):
                    try:
                        f = float(v)
                        return f if math.isfinite(f) else None
                    except (TypeError, ValueError):
                        return None

                date_str = datetime.fromtimestamp(t_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
                candles.append({
                    "date":   date_str,
                    "close":  _num(close_raw),
                    "open":   _num(r.get("o")),
                    "high":   _num(r.get("h")),
                    "low":    _num(r.get("l")),
                    "volume": int(r["v"]) if r.get("v") is not None else None,
                    "source": "MASSIVE",
                })
            return candles
        except requests.RequestException as exc:
            last_err = exc
            wait = RETRY_BASE_S * (2 ** (attempt - 1))
            log.warning("[massive] %s – request failed (attempt %d): %s", symbol, attempt, exc)
            time.sleep(wait)

    raise RuntimeError(f"Massive fetch failed after {RETRY_COUNT} attempts for {symbol}: {last_err}")


# ── Per-symbol worker ──────────────────────────────────────────────────────────

def fetch_and_upsert(symbol: str) -> str:
    """
    Fetch candles from Massive and upsert into prices_daily.
    Opens its own DB connection (thread-safe, one connection per worker).
    Returns "upserted", "empty", or "failed".
    """
    try:
        today     = datetime.now(timezone.utc)
        to_date   = today.strftime("%Y-%m-%d")
        from_date = (today - timedelta(days=FETCH_DAYS)).strftime("%Y-%m-%d")

        candles = fetch_massive_candles(symbol, from_date, to_date)
        if not candles:
            log.info("[backfill] %s – no candles returned by Massive", symbol)
            return "empty"

        conn = connect_db()
        try:
            n = upsert_candles(conn, symbol, candles)
        finally:
            conn.close()

        log.info("[backfill] %s – upserted %d rows", symbol, n)
        return "upserted"
    except Exception as exc:
        log.error("[backfill] %s – error: %s", symbol, exc)
        return "failed"


# ── Pipeline status ────────────────────────────────────────────────────────────

PIPELINE_STAGE = "historical_backfill"


def save_pipeline_stage(conn, input_count: int, success_count: int, failed_count: int, skipped_count: int) -> None:
    """
    Persist run counts to pipeline_status.  Never throws – a DB hiccup must
    not abort the job or mask a successful run.
    """
    status = "success" if success_count > 0 else ("failed" if failed_count > 0 else "unknown")
    now_ts = datetime.now(timezone.utc).isoformat()
    healthy_ts = now_ts if success_count > 0 else None
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS pipeline_status (
                  stage              TEXT PRIMARY KEY,
                  last_run_at        TIMESTAMPTZ,
                  last_healthy_run   TIMESTAMPTZ,
                  input_count        INT  NOT NULL DEFAULT 0,
                  success_count      INT  NOT NULL DEFAULT 0,
                  failed_count       INT  NOT NULL DEFAULT 0,
                  skipped_count      INT  NOT NULL DEFAULT 0,
                  status             TEXT NOT NULL DEFAULT 'unknown',
                  error_message      TEXT,
                  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            cur.execute(
                """
                INSERT INTO pipeline_status
                  (stage, last_run_at, last_healthy_run, input_count, success_count,
                   failed_count, skipped_count, status, error_message, updated_at)
                VALUES (%s, NOW(), %s, %s, %s, %s, %s, %s, NULL, NOW())
                ON CONFLICT (stage) DO UPDATE SET
                  last_run_at      = NOW(),
                  last_healthy_run = CASE WHEN EXCLUDED.success_count > 0 THEN NOW()
                                          ELSE pipeline_status.last_healthy_run END,
                  input_count      = EXCLUDED.input_count,
                  success_count    = EXCLUDED.success_count,
                  failed_count     = EXCLUDED.failed_count,
                  skipped_count    = EXCLUDED.skipped_count,
                  status           = EXCLUDED.status,
                  error_message    = NULL,
                  updated_at       = NOW()
                """,
                (PIPELINE_STAGE, healthy_ts, input_count, success_count, failed_count, skipped_count, status),
            )
        conn.commit()
        log.info("[pipeline] %s persisted – status=%s input=%d success=%d failed=%d skipped=%d",
                 PIPELINE_STAGE, status, input_count, success_count, failed_count, skipped_count)
    except Exception as exc:
        log.warning("[pipeline] failed to save stage %s: %s", PIPELINE_STAGE, exc)


# ── Entry point ────────────────────────────────────────────────────────────────

def main():
    start_ts = time.monotonic()
    log.info("[job:historical-backfill] started at %s", datetime.now(timezone.utc).isoformat())

    if not DATABASE_URL:
        log.error("[job:historical-backfill] DATABASE_URL not set – aborting")
        sys.exit(1)

    if not MASSIVE_KEY:
        log.warning("[job:historical-backfill] MASSIVE_API_KEY not set – no candles will be fetched")

    conn = connect_db()
    ensure_prices_daily(conn)

    symbols = load_symbols_needing_backfill(conn)
    if not symbols:
        log.info("[job:historical-backfill] all symbols already have sufficient data – nothing to backfill")
        save_pipeline_stage(conn, input_count=0, success_count=0, failed_count=0, skipped_count=0)
        conn.close()
        sys.exit(0)

    log.info("[job:historical-backfill] %d symbol(s) need backfill", len(symbols))

    success_count  = 0
    failed_count   = 0
    skipped_count  = 0

    if not MASSIVE_KEY:
        # No API key – skip all symbols without attempting fetch
        skipped_count = len(symbols)
    else:
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            futures = {executor.submit(fetch_and_upsert, sym): sym for sym in symbols}
            for future in as_completed(futures):
                sym = futures[future]
                try:
                    result = future.result()
                    if result == "upserted":
                        success_count += 1
                    elif result == "empty":
                        skipped_count += 1
                    else:
                        failed_count += 1
                except Exception as exc:
                    log.error("[backfill] %s – unhandled exception: %s", sym, exc)
                    failed_count += 1

    duration_ms = int((time.monotonic() - start_ts) * 1000)
    log.info(
        "[job:historical-backfill] finished – total=%d upserted=%d skipped=%d failed=%d durationMs=%d",
        len(symbols), success_count, skipped_count, failed_count, duration_ms,
    )

    save_pipeline_stage(
        conn,
        input_count=len(symbols),
        success_count=success_count,
        failed_count=failed_count,
        skipped_count=skipped_count,
    )
    conn.close()

    # Exit 1 only if every symbol failed (partial success is acceptable)
    sys.exit(1 if failed_count > 0 and success_count == 0 and skipped_count == 0 else 0)


if __name__ == "__main__":
    main()
