-- =============================================================
-- market_snapshots FX Verification Queries
-- Run these after deploying the EUR write-path fix to confirm
-- that new snapshots are stored correctly in EUR.
-- =============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. Last 20 US snapshots: confirm EUR fields are populated
--    Expected: currency='EUR', fx_rate IS NOT NULL, price_usd IS NOT NULL
-- ─────────────────────────────────────────────────────────────
SELECT
  symbol,
  price,
  price_usd,
  currency,
  fx_rate,
  source,
  created_at
FROM market_snapshots
ORDER BY created_at DESC
LIMIT 20;


-- ─────────────────────────────────────────────────────────────
-- 2. Currency distribution: how many EUR vs USD rows
--    After backfill: currency='USD' count should drop to 0.
--    fx_rate IS NULL count should also be 0 for new rows.
-- ─────────────────────────────────────────────────────────────
SELECT
  currency,
  COUNT(*)                                        AS total_rows,
  COUNT(*) FILTER (WHERE fx_rate IS NOT NULL)     AS rows_with_fx_rate,
  COUNT(*) FILTER (WHERE fx_rate IS NULL)         AS rows_without_fx_rate,
  COUNT(*) FILTER (WHERE price_usd IS NOT NULL)   AS rows_with_price_usd,
  MIN(created_at)                                 AS oldest,
  MAX(created_at)                                 AS newest
FROM market_snapshots
GROUP BY currency
ORDER BY total_rows DESC;


-- ─────────────────────────────────────────────────────────────
-- 3. New snapshots only (since deploy timestamp)
--    Replace '2026-01-01T00:00:00Z' with your actual deploy time.
--    All rows here MUST show currency='EUR', fx_rate IS NOT NULL.
-- ─────────────────────────────────────────────────────────────
SELECT
  symbol,
  price        AS price_eur,
  price_usd,
  currency,
  fx_rate,
  source,
  created_at
FROM market_snapshots
WHERE created_at >= '2026-01-01T00:00:00Z'   -- ← replace with deploy timestamp
ORDER BY created_at DESC
LIMIT 50;


-- ─────────────────────────────────────────────────────────────
-- 4. Sanity check: are any new snapshots still storing USD?
--    Expected: 0 rows returned after deploy + warmup cycle.
-- ─────────────────────────────────────────────────────────────
SELECT
  id,
  symbol,
  price,
  price_usd,
  currency,
  fx_rate,
  created_at
FROM market_snapshots
WHERE currency = 'USD'
  AND created_at >= '2026-01-01T00:00:00Z'   -- ← replace with deploy timestamp
ORDER BY created_at DESC;


-- ─────────────────────────────────────────────────────────────
-- 5. Remaining legacy USD rows (pre-deploy / not yet backfilled)
--    Run backfillSnapshotFx.job.js to fix these.
-- ─────────────────────────────────────────────────────────────
SELECT
  COUNT(*)  AS legacy_usd_rows_to_backfill
FROM market_snapshots
WHERE currency = 'USD'
  AND fx_rate IS NULL;


-- ─────────────────────────────────────────────────────────────
-- 6. FX rate consistency check: range of stored FX rates
--    All values should be within reasonable EUR/USD range (0.80–1.20).
-- ─────────────────────────────────────────────────────────────
SELECT
  MIN(fx_rate)   AS min_fx_rate,
  MAX(fx_rate)   AS max_fx_rate,
  AVG(fx_rate)   AS avg_fx_rate,
  COUNT(*)       AS rows_with_fx_rate
FROM market_snapshots
WHERE fx_rate IS NOT NULL;


-- ─────────────────────────────────────────────────────────────
-- 7. Per-symbol verification for known US stocks
--    Spot-check that price (EUR) is consistent with price_usd / fx_rate.
--    price ≈ price_usd * fx_rate  (allowing for rounding).
-- ─────────────────────────────────────────────────────────────
SELECT
  symbol,
  price                              AS price_eur,
  price_usd,
  fx_rate,
  ROUND(price_usd * fx_rate, 6)      AS expected_price_eur,
  ABS(price - ROUND(price_usd * fx_rate, 6)) AS rounding_diff,
  currency,
  created_at
FROM market_snapshots
WHERE symbol IN ('AAPL','MSFT','NVDA','GOOGL','AMZN')
  AND price_usd IS NOT NULL
  AND fx_rate IS NOT NULL
ORDER BY symbol, created_at DESC;
