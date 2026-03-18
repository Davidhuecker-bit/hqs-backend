"use strict";

/*
  Signal History Repository  –  Step 3: Outcome / Timing / Proof
  ---------------------------------------------------------------
  Reads from:  outcome_tracking, market_snapshots, hqs_scores, agent_forecasts
  Writes:      nothing (read-only analytics layer)

  Provides:
    1.  getSignalHistoryAll       – paginated signal list with current prices
    2.  getSignalHistoryBySymbol  – same, filtered to one symbol
    3.  getOutcomeAnalysis        – 7d / 30d outcome evaluation per signal
    4.  getTimingQuality          – timing assessment per signal
    5.  getForecastVsOutcome      – agent forecast accuracy vs actual outcome
    6.  getSignalKPIs             – aggregated hit-rates, timing distribution, etc.

  All response shapes carry a _meta block with dataStatus (full|partial|empty).
  Missing data is NEVER filled with guesses – it is returned as null with a
  clear explanation in the _meta block.
*/

const { Pool } = require("pg");
const logger = require("../utils/logger");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* ── helpers ─────────────────────────────────────────────────────────────── */

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function safeStr(v, fallback = null) {
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim();
  return s.length ? s : fallback;
}

function pct(delta) {
  if (delta === null || delta === undefined) return null;
  return Number((Number(delta) * 100).toFixed(2));
}

function signalAgedays(predictedAt) {
  if (!predictedAt) return null;
  const diff = Date.now() - new Date(predictedAt).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function dataStatusFromMissing(missingFields, totalExpected) {
  if (!missingFields || missingFields.length === 0) return "full";
  if (missingFields.length >= totalExpected) return "empty";
  return "partial";
}

/* ── timing quality ──────────────────────────────────────────────────────── */

/**
 * Derives a timing quality label from available performance windows and
 * pre-signal price context.
 *
 * Decision logic (in priority order):
 *   1. No data at all                → "unklar"
 *   2. Entry was near the recent     → "zu spät"
 *      7-day pre-signal high (>85%)
 *   3. 24h return < -5%              → "zu früh"
 *   4. 24h return > +1%              → "passend"
 *   5. 24h dropped, 7d recovered     → "zu früh"
 *   6. Fallback                      → "unklar"
 *
 * @param {object} row - outcome_tracking row
 * @param {object|null} preStats - { min_price_before, max_price_before }
 * @returns {{ quality: string, reason: string, dataAvailable: boolean }}
 */
function computeTimingQuality(row, preStats) {
  const perf24h = row.performance_24h || null;
  const perf7d  = row.performance_7d  || null;
  const entryPrice = safe(row.entry_price);

  if (!perf24h && !perf7d) {
    return {
      quality:       "unklar",
      reason:        "Noch keine Verlaufsdaten verfügbar – Signal zu jung oder Auswertung ausstehend",
      dataAvailable: false,
    };
  }

  const delta24h = perf24h ? safe(perf24h.price_delta) : null;
  const delta7d  = perf7d  ? safe(perf7d.price_delta)  : null;

  // ── "zu spät": entry was near the recent 7-day pre-signal high ───────────
  if (preStats && entryPrice > 0) {
    const minB = safe(preStats.min_price_before);
    const maxB = safe(preStats.max_price_before);
    if (maxB > minB && minB > 0) {
      const rangeB = maxB - minB;
      const entryRel = (entryPrice - minB) / rangeB;
      if (entryRel >= 0.85) {
        return {
          quality: "zu spät",
          reason:  `Signal kam nahe am 7-Tage-Hochpunkt vor dem Signal ` +
                   `(${Math.round(entryRel * 100)} % der Vorspanne von ` +
                   `${minB.toFixed(2)} – ${maxB.toFixed(2)})`,
          dataAvailable: true,
        };
      }
    }
  }

  // ── "zu früh": big drop in first 24h ─────────────────────────────────────
  if (delta24h !== null && delta24h < -0.05) {
    return {
      quality: "zu früh",
      reason:  `Preis fiel in den ersten 24h um ${Math.abs(pct(delta24h))} % – ` +
               `Signal kam vor dem Tief`,
      dataAvailable: true,
    };
  }

  // ── "passend": positive move within 24h ──────────────────────────────────
  if (delta24h !== null && delta24h > 0.01) {
    return {
      quality: "passend",
      reason:  `Preis stieg in den ersten 24h um ${pct(delta24h)} % ` +
               `– Signal kam nah am günstigen Einstieg`,
      dataAvailable: true,
    };
  }

  // ── "zu früh" with later recovery ────────────────────────────────────────
  if (delta24h !== null && delta24h < -0.02 && delta7d !== null && delta7d > 0) {
    return {
      quality: "zu früh",
      reason:  `Preis fiel zunächst ${Math.abs(pct(delta24h))} %, erholte sich aber ` +
               `innerhalb 7 Tagen auf ${pct(delta7d) >= 0 ? "+" : ""}${pct(delta7d)} %`,
      dataAvailable: true,
    };
  }

  // ── neutral 24h, positive 7d ──────────────────────────────────────────────
  if (delta7d !== null && delta7d > 0.02) {
    return {
      quality: "passend",
      reason:  `7-Tage-Return ${pct(delta7d) >= 0 ? "+" : ""}${pct(delta7d)} % – ` +
               `Signal war zeitlich solide`,
      dataAvailable: true,
    };
  }

  return {
    quality:       "unklar",
    reason:        "Datenlage nicht eindeutig für Timing-Bewertung",
    dataAvailable: perf24h !== null || perf7d !== null,
  };
}

/* ── outcome status ──────────────────────────────────────────────────────── */

/**
 * Compute outcome status for a given time window.
 *
 * Bullish signal (final_conviction >= 50):
 *   > +3%  → "richtig"
 *   ±3%    → "teilweise"
 *   < -3%  → "falsch"
 *
 * Bearish signal (final_conviction < 50):
 *   < -3%  → "richtig"
 *   ±3%    → "teilweise"
 *   > +3%  → "falsch"
 *
 * @param {object} row  - outcome_tracking row
 * @param {'7d'|'30d'|'90d'} window
 * @returns {{ status: string, returnPct: number|null, dataSource: string|null }}
 */
function computeOutcomeStatus(row, window) {
  const conviction = safe(row.final_conviction, 0);
  const isBullish  = conviction >= 50;

  let priceDelta  = null;
  let dataSource  = null;

  if (window === "7d" && row.performance_7d) {
    priceDelta = safe(row.performance_7d.price_delta);
    dataSource = "performance_7d";
  } else if (window === "30d" && row.is_evaluated && row.actual_return !== null) {
    priceDelta = safe(row.actual_return);
    dataSource = "actual_return";
  }
  // 90d: currently not stored – mark open
  // (could be added once a 90d verification window is in place)

  const returnPct = priceDelta !== null ? pct(priceDelta) : null;

  if (priceDelta === null) {
    const ageDays = signalAgedays(row.predicted_at);
    let daysNeeded;
    if (window === "7d")       daysNeeded = 7;
    else if (window === "30d") daysNeeded = 30;
    else                       daysNeeded = 90;
    const tooYoung = ageDays !== null && ageDays < daysNeeded;
    const note = tooYoung
      ? `Signal erst ${ageDays} Tage alt – ${daysNeeded}-Tage-Fenster noch nicht auswertbar`
      : `Noch keine ${window}-Daten verfügbar`;
    return {
      status:     "offen",
      returnPct:  null,
      dataSource: null,
      note,
    };
  }

  let status;
  if (isBullish) {
    if (priceDelta >  0.03) status = "richtig";
    else if (priceDelta > -0.03) status = "teilweise";
    else status = "falsch";
  } else {
    if (priceDelta < -0.03) status = "richtig";
    else if (priceDelta < 0.03) status = "teilweise";
    else status = "falsch";
  }

  return { status, returnPct, dataSource, note: null };
}

/* ─────────────────────────────────────────────────────────────────────────
   1. SIGNAL HISTORY  (paginated)
──────────────────────────────────────────────────────────────────────────── */

/**
 * Returns a paginated list of signals with basic metadata, current price
 * context, and data-completeness indicators.
 *
 * @param {{ symbol?: string, limit?: number, offset?: number }} opts
 */
async function getSignalHistoryAll({ symbol = null, limit = 50, offset = 0 } = {}) {
  const safeLimit  = Math.max(1, Math.min(Number(limit)  || 50,  200));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const sym        = symbol ? String(symbol).trim().toUpperCase() : null;

  try {
    const params = [];
    let where = "";
    if (sym) {
      params.push(sym);
      where = `WHERE ot.symbol = $${params.length}`;
    }

    // Latest market snapshot price per symbol via LATERAL join
    params.push(safeLimit);
    params.push(safeOffset);
    const limitIdx  = params.length - 1;
    const offsetIdx = params.length;

    const sql = `
      SELECT
        ot.id,
        ot.symbol,
        ot.predicted_at            AS signal_at,
        ot.hqs_score,
        ot.final_confidence,
        ot.final_conviction,
        ot.regime,
        ot.strategy,
        ot.entry_price,
        ot.is_evaluated,
        ot.horizon_days,
        ot.actual_return,
        ot.analysis_rationale,
        ot.performance_24h,
        ot.performance_7d,
        ms.price                   AS current_price,
        ms.created_at              AS price_updated_at
      FROM outcome_tracking ot
      LEFT JOIN LATERAL (
        SELECT price, created_at
        FROM   market_snapshots
        WHERE  symbol = ot.symbol
          AND  price  > 0
        ORDER BY created_at DESC
        LIMIT 1
      ) ms ON true
      ${where}
      ORDER BY ot.predicted_at DESC
      LIMIT  $${limitIdx}
      OFFSET $${offsetIdx}
    `;

    const res = await pool.query(sql, params);
    const rows = res.rows || [];

    const signals = rows.map((r) => _buildSignalRow(r));

    const totalRes = await pool.query(
      `SELECT COUNT(*) AS cnt FROM outcome_tracking${sym ? " WHERE symbol = $1" : ""}`,
      sym ? [sym] : []
    );
    const total = Number(totalRes.rows[0]?.cnt || 0);

    const missingPrices = signals.filter((s) => s.currentPrice === null).length;

    return {
      success:    true,
      dataStatus: signals.length === 0 ? "empty" : missingPrices === signals.length ? "partial" : "full",
      _meta: {
        source:           "outcome_tracking + market_snapshots",
        total,
        returned:         signals.length,
        limit:            safeLimit,
        offset:           safeOffset,
        symbolFilter:     sym,
        missingPriceCount: missingPrices,
        generatedAt:      new Date().toISOString(),
      },
      signals,
    };
  } catch (err) {
    logger.error("signalHistory.getSignalHistoryAll error", { message: err.message });
    return _errorShape("getSignalHistoryAll", err.message);
  }
}

/** Convenience wrapper for single-symbol route. */
async function getSignalHistoryBySymbol(symbol, limit = 50) {
  return getSignalHistoryAll({ symbol, limit, offset: 0 });
}

function _buildSignalRow(r) {
  const entryPrice   = safe(r.entry_price);
  const currentPrice = r.current_price ? safe(r.current_price) : null;

  let changeSinceSignalPct = null;
  if (entryPrice > 0 && currentPrice && currentPrice > 0) {
    changeSinceSignalPct = pct((currentPrice - entryPrice) / entryPrice);
  }

  const ageDays       = signalAgedays(r.signal_at);
  const missing       = [];
  if (!r.hqs_score)       missing.push("hqs_score");
  if (!r.final_confidence) missing.push("final_confidence");
  if (currentPrice === null) missing.push("current_price");
  if (!r.performance_7d)  missing.push("performance_7d");

  return {
    id:                  r.id,
    symbol:              r.symbol,
    signalAt:            r.signal_at ? new Date(r.signal_at).toISOString() : null,
    signalAgeDays:       ageDays,
    hqsScore:            r.hqs_score !== null ? safe(r.hqs_score) : null,
    finalConfidence:     r.final_confidence !== null ? safe(r.final_confidence) : null,
    finalConviction:     r.final_conviction !== null ? safe(r.final_conviction) : null,
    regime:              safeStr(r.regime),
    strategy:            safeStr(r.strategy),
    entryPrice:          entryPrice > 0 ? entryPrice : null,
    currentPrice,
    priceUpdatedAt:      r.price_updated_at ? new Date(r.price_updated_at).toISOString() : null,
    changeSinceSignalPct,
    isEvaluated:         Boolean(r.is_evaluated),
    horizonDays:         safe(r.horizon_days, null),
    analysisRationale:   safeStr(r.analysis_rationale),
    has24hPerf:          Boolean(r.performance_24h),
    has7dPerf:           Boolean(r.performance_7d),
    missingFields:       missing,
    fieldCompleteness:   dataStatusFromMissing(missing, 4),
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   2. OUTCOME ANALYSIS  (7d / 30d per signal)
──────────────────────────────────────────────────────────────────────────── */

/**
 * Returns per-signal outcome evaluation for 7d and 30d windows.
 * Also includes max-upside and max-drawdown derived from market_snapshots
 * in the post-signal window (only available if snapshots exist for the
 * symbol in that time range).
 *
 * @param {{ symbol?: string, limit?: number, offset?: number }} opts
 */
async function getOutcomeAnalysis({ symbol = null, limit = 50, offset = 0 } = {}) {
  const safeLimit  = Math.max(1, Math.min(Number(limit)  || 50,  200));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const sym        = symbol ? String(symbol).trim().toUpperCase() : null;

  try {
    const params = [];
    let where = "";
    if (sym) {
      params.push(sym);
      where = `WHERE ot.symbol = $${params.length}`;
    }
    params.push(safeLimit);
    params.push(safeOffset);
    const limitIdx  = params.length - 1;
    const offsetIdx = params.length;

    const sql = `
      SELECT
        ot.id,
        ot.symbol,
        ot.predicted_at       AS signal_at,
        ot.entry_price,
        ot.exit_price,
        ot.actual_return,
        ot.final_conviction,
        ot.is_evaluated,
        ot.horizon_days,
        ot.performance_24h,
        ot.performance_7d,
        ot.regime,
        ot.hqs_score,
        -- Post-signal max/min from stored snapshots
        ms_range.max_price_after,
        ms_range.min_price_after,
        ms_range.snapshot_count_after
      FROM outcome_tracking ot
      LEFT JOIN LATERAL (
        SELECT
          MAX(price)   AS max_price_after,
          MIN(price)   AS min_price_after,
          COUNT(*)     AS snapshot_count_after
        FROM market_snapshots
        WHERE symbol    = ot.symbol
          AND created_at > ot.predicted_at
          AND created_at <= ot.predicted_at + INTERVAL '30 days'
          AND price       > 0
      ) ms_range ON true
      ${where}
      ORDER BY ot.predicted_at DESC
      LIMIT  $${limitIdx}
      OFFSET $${offsetIdx}
    `;

    const res = await pool.query(sql, params);
    const rows = res.rows || [];

    const outcomes = rows.map((r) => _buildOutcomeRow(r));

    const totalRes = await pool.query(
      `SELECT COUNT(*) AS cnt FROM outcome_tracking${sym ? " WHERE symbol = $1" : ""}`,
      sym ? [sym] : []
    );
    const total = Number(totalRes.rows[0]?.cnt || 0);

    const open7d  = outcomes.filter((o) => o.outcome7d.status  === "offen").length;
    const open30d = outcomes.filter((o) => o.outcome30d.status === "offen").length;
    const correct7d = outcomes.filter((o) => o.outcome7d.status  === "richtig").length;
    const correct30d = outcomes.filter((o) => o.outcome30d.status === "richtig").length;
    const evaluable7d = outcomes.filter((o) => o.outcome7d.status !== "offen").length;
    const evaluable30d = outcomes.filter((o) => o.outcome30d.status !== "offen").length;

    return {
      success:    true,
      dataStatus: outcomes.length === 0 ? "empty" : (open7d === outcomes.length ? "partial" : "full"),
      _meta: {
        source:             "outcome_tracking + market_snapshots",
        total,
        returned:           outcomes.length,
        limit:              safeLimit,
        offset:             safeOffset,
        symbolFilter:       sym,
        open7dCount:        open7d,
        open30dCount:       open30d,
        evaluable7dCount:   evaluable7d,
        evaluable30dCount:  evaluable30d,
        correct7dCount:     correct7d,
        correct30dCount:    correct30d,
        hitRate7dPct:       evaluable7d > 0 ? Math.round((correct7d / evaluable7d) * 100) : null,
        hitRate30dPct:      evaluable30d > 0 ? Math.round((correct30d / evaluable30d) * 100) : null,
        note:               "max_upside und max_drawdown stammen aus gespeicherten market_snapshots (nur verfügbar soweit vorhanden)",
        generatedAt:        new Date().toISOString(),
      },
      outcomes,
    };
  } catch (err) {
    logger.error("signalHistory.getOutcomeAnalysis error", { message: err.message });
    return _errorShape("getOutcomeAnalysis", err.message);
  }
}

function _buildOutcomeRow(r) {
  const entryPrice        = safe(r.entry_price);
  const maxPriceAfter     = r.max_price_after ? safe(r.max_price_after) : null;
  const minPriceAfter     = r.min_price_after ? safe(r.min_price_after) : null;
  const snapshotCount     = safe(r.snapshot_count_after, 0);

  let maxUpsidePct    = null;
  let maxDrawdownPct  = null;

  if (entryPrice > 0 && maxPriceAfter && maxPriceAfter > 0) {
    maxUpsidePct = pct((maxPriceAfter - entryPrice) / entryPrice);
  }
  if (entryPrice > 0 && minPriceAfter && minPriceAfter > 0) {
    // Drawdown = biggest drop FROM entry price (positive value = loss)
    maxDrawdownPct = pct((entryPrice - minPriceAfter) / entryPrice);
  }

  const outcome7d  = computeOutcomeStatus(r, "7d");
  const outcome30d = computeOutcomeStatus(r, "30d");

  // 90d: no dedicated storage yet → always open with explanation
  const outcome90d = {
    status:    "offen",
    returnPct: null,
    dataSource: null,
    note:      "90-Tage-Fenster noch nicht implementiert – kein performance_90d Feld vorhanden",
  };

  return {
    id:          r.id,
    symbol:      r.symbol,
    signalAt:    r.signal_at ? new Date(r.signal_at).toISOString() : null,
    signalAgeDays: signalAgedays(r.signal_at),
    entryPrice:  entryPrice > 0 ? entryPrice : null,
    hqsScore:    r.hqs_score !== null ? safe(r.hqs_score) : null,
    regime:      safeStr(r.regime),
    isEvaluated: Boolean(r.is_evaluated),
    outcome7d,
    outcome30d,
    outcome90d,
    maxUpsidePct,
    maxDrawdownPct,
    _priceRangeSource: snapshotCount > 0
      ? `${snapshotCount} market_snapshots in 30-Tage-Fenster`
      : "keine post-Signal Snapshots verfügbar",
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   3. TIMING QUALITY  (per signal)
──────────────────────────────────────────────────────────────────────────── */

/**
 * Returns timing quality per signal, enriched with pre-signal price context.
 *
 * @param {{ symbol?: string, limit?: number, offset?: number }} opts
 */
async function getTimingQuality({ symbol = null, limit = 50, offset = 0 } = {}) {
  const safeLimit  = Math.max(1, Math.min(Number(limit)  || 50,  200));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const sym        = symbol ? String(symbol).trim().toUpperCase() : null;

  try {
    const params = [];
    let where = "";
    if (sym) {
      params.push(sym);
      where = `WHERE ot.symbol = $${params.length}`;
    }
    params.push(safeLimit);
    params.push(safeOffset);
    const limitIdx  = params.length - 1;
    const offsetIdx = params.length;

    const sql = `
      SELECT
        ot.id,
        ot.symbol,
        ot.predicted_at       AS signal_at,
        ot.entry_price,
        ot.final_conviction,
        ot.hqs_score,
        ot.regime,
        ot.performance_24h,
        ot.performance_7d,
        -- Pre-signal price context from market_snapshots (7 days before)
        pre.min_price_before,
        pre.max_price_before,
        pre.pre_snapshot_count
      FROM outcome_tracking ot
      LEFT JOIN LATERAL (
        SELECT
          MIN(price)   AS min_price_before,
          MAX(price)   AS max_price_before,
          COUNT(*)     AS pre_snapshot_count
        FROM market_snapshots
        WHERE symbol    = ot.symbol
          AND created_at < ot.predicted_at
          AND created_at >= ot.predicted_at - INTERVAL '7 days'
          AND price       > 0
      ) pre ON true
      ${where}
      ORDER BY ot.predicted_at DESC
      LIMIT  $${limitIdx}
      OFFSET $${offsetIdx}
    `;

    const res = await pool.query(sql, params);
    const rows = res.rows || [];

    const items = rows.map((r) => {
      const preStats = r.pre_snapshot_count > 0
        ? { min_price_before: r.min_price_before, max_price_before: r.max_price_before }
        : null;
      const timing = computeTimingQuality(r, preStats);
      return {
        id:              r.id,
        symbol:          r.symbol,
        signalAt:        r.signal_at ? new Date(r.signal_at).toISOString() : null,
        signalAgeDays:   signalAgedays(r.signal_at),
        entryPrice:      safe(r.entry_price) > 0 ? safe(r.entry_price) : null,
        hqsScore:        r.hqs_score !== null ? safe(r.hqs_score) : null,
        regime:          safeStr(r.regime),
        timingQuality:   timing.quality,
        timingReason:    timing.reason,
        timingDataAvailable: timing.dataAvailable,
        _preSignalSnapshotCount: safe(r.pre_snapshot_count, 0),
      };
    });

    // Distribution summary (camelCase keys match KPI output)
    const dist = { passend: 0, zuFrueh: 0, zuSpaet: 0, unklar: 0 };
    for (const item of items) {
      if (item.timingQuality === "passend")    dist.passend++;
      else if (item.timingQuality === "zu früh") dist.zuFrueh++;
      else if (item.timingQuality === "zu spät") dist.zuSpaet++;
      else dist.unklar++;
    }

    const totalRes = await pool.query(
      `SELECT COUNT(*) AS cnt FROM outcome_tracking${sym ? " WHERE symbol = $1" : ""}`,
      sym ? [sym] : []
    );
    const total = Number(totalRes.rows[0]?.cnt || 0);

    return {
      success:    true,
      dataStatus: items.length === 0 ? "empty" : (dist.unklar === items.length ? "partial" : "full"),
      _meta: {
        source:        "outcome_tracking + market_snapshots (pre-signal context)",
        total,
        returned:      items.length,
        limit:         safeLimit,
        offset:        safeOffset,
        symbolFilter:  sym,
        distribution:  dist,
        note:          "Timing-Bewertung basiert auf performance_24h/7d und market_snapshots vor dem Signal. Fehlende Snapshots führen zu 'unklar'.",
        generatedAt:   new Date().toISOString(),
      },
      timingItems: items,
    };
  } catch (err) {
    logger.error("signalHistory.getTimingQuality error", { message: err.message });
    return _errorShape("getTimingQuality", err.message);
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   4. FORECAST VS OUTCOME  (agent_forecasts vs outcome_tracking)
──────────────────────────────────────────────────────────────────────────── */

/**
 * Joins agent_forecasts with outcome_tracking to compare what was
 * predicted (agent direction) against what actually happened.
 *
 * Only covers forecasts that have been verified (verified_at IS NOT NULL).
 * Unverified forecasts are counted and reported in _meta.
 *
 * @param {{ symbol?: string, limit?: number, offset?: number, windowDays?: number }} opts
 */
async function getForecastVsOutcome({
  symbol     = null,
  limit      = 50,
  offset     = 0,
  windowDays = 30,
} = {}) {
  const safeLimit  = Math.max(1, Math.min(Number(limit)  || 50,  200));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeDays   = Math.max(1, Math.min(Number(windowDays) || 30, 365));
  const sym        = symbol ? String(symbol).trim().toUpperCase() : null;

  try {
    const params = [safeDays];
    let andSym = "";
    if (sym) {
      params.push(sym);
      andSym = `AND af.symbol = $${params.length}`;
    }
    params.push(safeLimit);
    params.push(safeOffset);
    const limitIdx  = params.length - 1;
    const offsetIdx = params.length;

    // Join agent forecasts with closest outcome_tracking entry for same symbol
    const sql = `
      SELECT
        af.id                  AS forecast_id,
        af.symbol,
        af.agent_name,
        af.forecast_dir,
        af.forecast_reason,
        af.entry_price         AS forecast_entry_price,
        af.debate_approved,
        af.forecasted_at,
        af.verified_at,
        af.actual_dir,
        af.exit_price          AS forecast_exit_price,
        af.was_correct,
        -- Nearest outcome_tracking signal within ±6 hours of forecast
        ot.id                  AS outcome_id,
        ot.hqs_score,
        ot.final_conviction,
        ot.final_confidence,
        ot.regime,
        ot.performance_7d,
        ot.actual_return       AS ot_actual_return,
        ot.is_evaluated        AS ot_is_evaluated
      FROM agent_forecasts af
      LEFT JOIN LATERAL (
        SELECT id, hqs_score, final_conviction, final_confidence,
               regime, performance_7d, actual_return, is_evaluated
        FROM   outcome_tracking
        WHERE  symbol   = af.symbol
          AND  predicted_at BETWEEN af.forecasted_at - INTERVAL '6 hours'
                                AND af.forecasted_at + INTERVAL '6 hours'
        ORDER BY ABS(EXTRACT(EPOCH FROM (predicted_at - af.forecasted_at)))
        LIMIT 1
      ) ot ON true
      WHERE af.verified_at IS NOT NULL
        AND af.forecasted_at >= NOW() - INTERVAL '1 day' * $1
        ${andSym}
      ORDER BY af.forecasted_at DESC
      LIMIT  $${limitIdx}
      OFFSET $${offsetIdx}
    `;

    const res = await pool.query(sql, params);
    const rows = res.rows || [];

    // Count unverified forecasts for _meta
    const unverifiedParams = [safeDays];
    let unverifiedSymFilter = "";
    if (sym) {
      unverifiedParams.push(sym);
      unverifiedSymFilter = `AND symbol = $${unverifiedParams.length}`;
    }
    const unverRes = await pool.query(
      `SELECT COUNT(*) AS cnt FROM agent_forecasts
       WHERE verified_at IS NULL
         AND forecasted_at >= NOW() - INTERVAL '1 day' * $1
         ${unverifiedSymFilter}`,
      unverifiedParams
    );
    const unverifiedCount = Number(unverRes.rows[0]?.cnt || 0);

    const items = rows.map((r) => _buildForecastVsOutcomeRow(r));

    const correct   = items.filter((i) => i.wasCorrect === true).length;
    const incorrect = items.filter((i) => i.wasCorrect === false).length;
    const matched   = items.filter((i) => i.outcomeId !== null).length;

    return {
      success:    true,
      dataStatus: items.length === 0 ? "empty" : (matched === 0 ? "partial" : "full"),
      _meta: {
        source:          "agent_forecasts + outcome_tracking",
        returned:        items.length,
        limit:           safeLimit,
        offset:          safeOffset,
        symbolFilter:    sym,
        windowDays:      safeDays,
        unverifiedCount,
        verifiedCount:   items.length,
        correctCount:    correct,
        incorrectCount:  incorrect,
        accuracyPct:     (() => {
          const total24h = correct + incorrect;
          return total24h > 0 ? Math.round((correct / total24h) * 100) : null;
        })(),
        matchedToOutcomeCount: matched,
        note: matched < items.length
          ? `${items.length - matched} Forecasts konnten keinem Outcome-Tracking-Eintrag zugeordnet werden (kein Signal innerhalb ±6h)`
          : null,
        generatedAt: new Date().toISOString(),
      },
      forecasts: items,
    };
  } catch (err) {
    logger.error("signalHistory.getForecastVsOutcome error", { message: err.message });
    return _errorShape("getForecastVsOutcome", err.message);
  }
}

function _buildForecastVsOutcomeRow(r) {
  // Determine outcome alignment: did the 7d outcome match the forecast direction?
  let outcomeAlignment = null;
  let alignmentNote    = null;

  if (r.performance_7d && r.forecast_dir) {
    const delta7d = safe(r.performance_7d.price_delta);
    const actualMove = delta7d > 0.01 ? "bullish" : delta7d < -0.01 ? "bearish" : "neutral";
    outcomeAlignment = actualMove === r.forecast_dir ? "getroffen"
      : r.forecast_dir === "neutral"                  ? "teilweise"
      : "verfehlt";
    alignmentNote = `Prognose: ${r.forecast_dir}, 7d-Bewegung: ${actualMove} (${pct(delta7d) >= 0 ? "+" : ""}${pct(delta7d)} %)`;
  } else if (r.ot_is_evaluated && r.ot_actual_return !== null) {
    const actualReturn = safe(r.ot_actual_return);
    const actualMove   = actualReturn > 0.01 ? "bullish" : actualReturn < -0.01 ? "bearish" : "neutral";
    outcomeAlignment   = actualMove === r.forecast_dir ? "getroffen" : "verfehlt";
    alignmentNote      = `Prognose: ${r.forecast_dir}, Evaluated Return: ${pct(actualReturn) >= 0 ? "+" : ""}${pct(actualReturn)} %`;
  } else {
    outcomeAlignment = "offen";
    alignmentNote    = "7d-Performance noch nicht verfügbar";
  }

  return {
    forecastId:          r.forecast_id,
    outcomeId:           r.outcome_id || null,
    symbol:              r.symbol,
    agentName:           r.agent_name,
    forecastDirection:   r.forecast_dir,
    forecastReason:      safeStr(r.forecast_reason),
    forecastEntryPrice:  r.forecast_entry_price ? safe(r.forecast_entry_price) : null,
    debateApproved:      Boolean(r.debate_approved),
    forecastedAt:        r.forecasted_at ? new Date(r.forecasted_at).toISOString() : null,
    verifiedAt:          r.verified_at   ? new Date(r.verified_at).toISOString()   : null,
    // 24h verification result
    actual24hDir:        safeStr(r.actual_dir),
    forecast24hExitPrice: r.forecast_exit_price ? safe(r.forecast_exit_price) : null,
    wasCorrect24h:       r.was_correct !== null ? Boolean(r.was_correct) : null,
    // 7d alignment
    outcomeAlignment,
    alignmentNote,
    // Context from linked outcome_tracking entry
    hqsScore:            r.hqs_score       !== null ? safe(r.hqs_score)       : null,
    finalConviction:     r.final_conviction !== null ? safe(r.final_conviction) : null,
    finalConfidence:     r.final_confidence !== null ? safe(r.final_confidence) : null,
    regime:              safeStr(r.regime),
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   5. SIGNAL KPIs  (aggregated dashboard metrics)
──────────────────────────────────────────────────────────────────────────── */

/**
 * Computes aggregated KPI metrics across all signals for admin dashboard use.
 *
 * Returns:
 *   - hitRate7d / hitRate30d (% correct)
 *   - evaluableCount / openCount
 *   - avgReturn7d / avgReturn30d
 *   - avgMaxUpside / avgMaxDrawdown
 *   - timing distribution (passend/zu_frueh/zu_spaet/unklar)
 *   - avgAvoidedLoss (from near_miss saved_capital data)
 *
 * @param {{ windowDays?: number }} opts
 */
async function getSignalKPIs({ windowDays = 90 } = {}) {
  const safeDays = Math.max(7, Math.min(Number(windowDays) || 90, 365));

  try {
    // ── outcome stats ──────────────────────────────────────────────────────
    const outcomeRes = await pool.query(`
      SELECT
        COUNT(*)                                                         AS total,
        COUNT(*) FILTER (WHERE is_evaluated = TRUE)                     AS evaluated,
        COUNT(*) FILTER (WHERE is_evaluated = FALSE)                    AS open_signals,
        COUNT(*) FILTER (WHERE performance_7d IS NOT NULL)              AS has_7d,
        COUNT(*) FILTER (
          WHERE performance_7d IS NOT NULL
            AND (
              (final_conviction >= 50 AND (performance_7d->>'price_delta')::numeric > 0.03)
              OR
              (final_conviction < 50  AND (performance_7d->>'price_delta')::numeric < -0.03)
            )
        )                                                                AS correct_7d,
        COUNT(*) FILTER (
          WHERE is_evaluated = TRUE AND actual_return IS NOT NULL
            AND (
              (final_conviction >= 50 AND actual_return > 0.03)
              OR
              (final_conviction < 50  AND actual_return < -0.03)
            )
        )                                                                AS correct_evaluated,
        AVG(
          CASE WHEN performance_7d IS NOT NULL
               THEN (performance_7d->>'price_delta')::numeric END
        )                                                                AS avg_return_7d,
        AVG(actual_return)
          FILTER (WHERE is_evaluated = TRUE AND actual_return IS NOT NULL) AS avg_return_evaluated
      FROM outcome_tracking
      WHERE predicted_at >= NOW() - INTERVAL '1 day' * $1
    `, [safeDays]);

    const ov = outcomeRes.rows[0] || {};

    // ── max upside / drawdown from post-signal snapshots ──────────────────
    const priceRangeRes = await pool.query(`
      SELECT
        AVG(
          CASE WHEN ms_max.max_after > ot.entry_price AND ot.entry_price > 0
               THEN (ms_max.max_after - ot.entry_price) / ot.entry_price END
        )                                                           AS avg_max_upside,
        AVG(
          CASE WHEN ms_min.min_after < ot.entry_price AND ot.entry_price > 0
               THEN (ot.entry_price - ms_min.min_after) / ot.entry_price END
        )                                                           AS avg_max_drawdown
      FROM outcome_tracking ot
      LEFT JOIN LATERAL (
        SELECT MAX(price) AS max_after
        FROM market_snapshots
        WHERE symbol    = ot.symbol
          AND created_at > ot.predicted_at
          AND created_at <= ot.predicted_at + INTERVAL '30 days'
          AND price       > 0
      ) ms_max ON true
      LEFT JOIN LATERAL (
        SELECT MIN(price) AS min_after
        FROM market_snapshots
        WHERE symbol    = ot.symbol
          AND created_at > ot.predicted_at
          AND created_at <= ot.predicted_at + INTERVAL '30 days'
          AND price       > 0
      ) ms_min ON true
      WHERE ot.predicted_at >= NOW() - INTERVAL '1 day' * $1
        AND ot.entry_price   > 0
    `, [safeDays]);

    const pr = priceRangeRes.rows[0] || {};

    // ── timing distribution ───────────────────────────────────────────────
    const timingRes = await pool.query(`
      SELECT
        ot.id,
        ot.entry_price,
        ot.performance_24h,
        ot.performance_7d,
        pre.min_price_before,
        pre.max_price_before,
        pre.cnt_before
      FROM outcome_tracking ot
      LEFT JOIN LATERAL (
        SELECT MIN(price) AS min_price_before, MAX(price) AS max_price_before, COUNT(*) AS cnt_before
        FROM market_snapshots
        WHERE symbol    = ot.symbol
          AND created_at < ot.predicted_at
          AND created_at >= ot.predicted_at - INTERVAL '7 days'
          AND price       > 0
      ) pre ON true
      WHERE ot.predicted_at >= NOW() - INTERVAL '1 day' * $1
    `, [safeDays]);

    const timingDist = { passend: 0, zuFrueh: 0, zuSpaet: 0, unklar: 0 };
    for (const r of timingRes.rows) {
      const preStats = safe(r.cnt_before, 0) > 0
        ? { min_price_before: r.min_price_before, max_price_before: r.max_price_before }
        : null;
      const tq = computeTimingQuality(r, preStats);
      if (tq.quality === "passend")      timingDist.passend++;
      else if (tq.quality === "zu früh") timingDist.zuFrueh++;
      else if (tq.quality === "zu spät") timingDist.zuSpaet++;
      else timingDist.unklar++;
    }

    // ── agent forecast accuracy (in window) ──────────────────────────────
    const agentRes = await pool.query(`
      SELECT
        COUNT(*)                                              AS total_verified,
        COUNT(*) FILTER (WHERE was_correct = TRUE)           AS correct,
        COUNT(*) FILTER (WHERE was_correct = FALSE)          AS incorrect
      FROM agent_forecasts
      WHERE verified_at IS NOT NULL
        AND forecasted_at >= NOW() - INTERVAL '1 day' * $1
    `, [safeDays]);

    const ag = agentRes.rows[0] || {};

    // ── near miss saved capital (avg) ────────────────────────────────────
    let avgSavedCapital = null;
    try {
      const nmRes = await pool.query(`
        SELECT AVG(saved_capital) AS avg_saved
        FROM guardian_near_miss
        WHERE saved_capital IS NOT NULL
          AND created_at >= NOW() - INTERVAL '1 day' * $1
      `, [safeDays]);
      if (nmRes.rows[0]?.avg_saved !== null) {
        avgSavedCapital = Number(Number(nmRes.rows[0].avg_saved).toFixed(2));
      }
    } catch (_) {
      // guardian_near_miss table may not exist in all environments
    }

    const total      = Number(ov.total      || 0);
    const evaluated  = Number(ov.evaluated  || 0);
    const openCount  = Number(ov.open_signals || 0);
    const has7d      = Number(ov.has_7d      || 0);
    const correct7d  = Number(ov.correct_7d  || 0);
    const correctEv  = Number(ov.correct_evaluated || 0);
    const agTotal    = Number(ag.total_verified || 0);
    const agCorrect  = Number(ag.correct || 0);

    return {
      success:    true,
      dataStatus: total === 0 ? "empty" : (has7d === 0 ? "partial" : "full"),
      _meta: {
        source:      "outcome_tracking + agent_forecasts + market_snapshots + guardian_near_miss",
        windowDays:  safeDays,
        generatedAt: new Date().toISOString(),
        note:        "Nur Daten aus den letzten windowDays Tagen. Alle Werte defensiv – kein Raten bei fehlenden Daten.",
      },
      kpis: {
        totalSignals:          total,
        evaluableSignals7d:    has7d,
        evaluableSignals30d:   evaluated,
        openSignals:           openCount,

        hitRate7dPct:          has7d > 0 ? Math.round((correct7d / has7d) * 100) : null,
        hitRate30dPct:         evaluated > 0 ? Math.round((correctEv / evaluated) * 100) : null,

        avgReturn7dPct:        ov.avg_return_7d !== null ? pct(ov.avg_return_7d) : null,
        avgReturn30dPct:       ov.avg_return_evaluated !== null ? pct(ov.avg_return_evaluated) : null,

        avgMaxUpsidePct:       pr.avg_max_upside    !== null ? pct(pr.avg_max_upside)    : null,
        avgMaxDrawdownPct:     pr.avg_max_drawdown  !== null ? pct(pr.avg_max_drawdown)  : null,

        avgSavedCapitalEur:    avgSavedCapital,

        agentForecastAccuracyPct: agTotal > 0 ? Math.round((agCorrect / agTotal) * 100) : null,
        agentForecastsVerified:   agTotal,

        timingDistribution: {
          passend:  timingDist.passend,
          zuFrueh:  timingDist.zuFrueh,
          zuSpaet:  timingDist.zuSpaet,
          unklar:   timingDist.unklar,
        },
      },
    };
  } catch (err) {
    logger.error("signalHistory.getSignalKPIs error", { message: err.message });
    return _errorShape("getSignalKPIs", err.message);
  }
}

/* ── error shape ─────────────────────────────────────────────────────────── */

function _errorShape(fn, message) {
  return {
    success:    false,
    dataStatus: "error",
    _meta: {
      source:      "signalHistory.repository",
      fn,
      error:       message,
      generatedAt: new Date().toISOString(),
    },
  };
}

/* ── exports ─────────────────────────────────────────────────────────────── */

module.exports = {
  getSignalHistoryAll,
  getSignalHistoryBySymbol,
  getOutcomeAnalysis,
  getTimingQuality,
  getForecastVsOutcome,
  getSignalKPIs,
};
