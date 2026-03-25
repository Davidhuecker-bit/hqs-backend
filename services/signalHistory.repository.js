"use strict";

/*
  Signal History Repository – Outcome / Timing / Proof
  ----------------------------------------------------
  Reads from:  outcome_tracking, market_snapshots, agent_forecasts, guardian_near_miss
  Writes:      nothing (read-only analytics layer)

  Provides:
    1. getSignalHistoryAll       – paginated signal list with current prices
    2. getSignalHistoryBySymbol  – same, filtered to one symbol
    3. getOutcomeAnalysis        – 7d / 30d outcome evaluation per signal
    4. getTimingQuality          – timing assessment per signal
    5. getForecastVsOutcome      – agent forecast accuracy vs actual outcome
    6. getSignalKPIs             – aggregated hit-rates, timing distribution, etc.

  All response shapes carry a _meta block with dataStatus (full|partial|empty).
  Missing data is NEVER filled with guesses – it is returned as null with a
  clear explanation in the _meta block.
*/

const logger = require("../utils/logger");
const { getUsdToEurRate, convertUsdToEur } = require("./fx.service");

const { getSharedPool } = require("../config/database");
const pool = getSharedPool();
/* ── helpers ───────────────────────────────────────────────────────────── */

function safe(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function safeNullableNumber(n) {
  if (n === null || n === undefined) return null;
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

function safeStr(v, fallback = null) {
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim();
  return s.length ? s : fallback;
}

function pct(delta) {
  if (delta === null || delta === undefined) return null;
  const v = Number(delta);
  if (!Number.isFinite(v)) return null;
  return Number((v * 100).toFixed(2));
}

function signalAgeDays(predictedAt) {
  if (!predictedAt) return null;
  const ts = new Date(predictedAt).getTime();
  if (!Number.isFinite(ts)) return null;
  const diff = Date.now() - ts;
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function dataStatusFromMissing(missingFields, totalExpected) {
  if (!Array.isArray(missingFields) || missingFields.length === 0) return "full";
  if (missingFields.length >= totalExpected) return "empty";
  return "partial";
}

function parseMaybeJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function getPerfDelta(perfObj) {
  const obj = parseMaybeJson(perfObj);
  if (!obj || typeof obj !== "object") return null;
  if (obj.price_delta !== undefined && obj.price_delta !== null) {
    const n = Number(obj.price_delta);
    return Number.isFinite(n) ? n : null;
  }
  if (obj.return !== undefined && obj.return !== null) {
    const n = Number(obj.return);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeDirection(dir) {
  const v = safeStr(dir, null);
  if (!v) return null;
  const d = v.toLowerCase();

  if (["bullish", "bull", "long", "up", "buy"].includes(d)) return "bullish";
  if (["bearish", "bear", "short", "down", "sell"].includes(d)) return "bearish";
  if (["neutral", "flat", "hold"].includes(d)) return "neutral";

  return d;
}

function _errorShape(fn, message) {
  return {
    success: false,
    dataStatus: "error",
    _meta: {
      source: "signalHistory.repository",
      fn,
      error: message,
      generatedAt: new Date().toISOString(),
    },
  };
}

/* ── timing quality ────────────────────────────────────────────────────── */

/**
 * Derives a timing quality label from available performance windows and
 * pre-signal price context.
 *
 * Decision logic (priority order):
 *   1. No data at all                → "unklar"
 *   2. Entry near recent pre-high    → "zu spät"
 *   3. 24h return < -5%              → "zu früh"
 *   4. 24h return > +1%              → "passend"
 *   5. 24h dropped, 7d recovered     → "zu früh"
 *   6. 7d clearly positive           → "passend"
 *   7. fallback                      → "unklar"
 */
function computeTimingQuality(row, preStats = null) {
  const delta24h = getPerfDelta(row?.performance_24h);
  const delta7d = getPerfDelta(row?.performance_7d);
  const entryPrice = safeNullableNumber(row?.entry_price);

  if (delta24h === null && delta7d === null) {
    return {
      quality: "unklar",
      reason: "Noch keine Verlaufsdaten verfügbar – Signal zu jung oder Auswertung ausstehend",
      dataAvailable: false,
    };
  }

  if (preStats && entryPrice && entryPrice > 0) {
    const minB = safeNullableNumber(preStats.min_price_before);
    const maxB = safeNullableNumber(preStats.max_price_before);

    if (minB !== null && maxB !== null && maxB > minB && minB > 0) {
      const rangeB = maxB - minB;
      const entryRel = (entryPrice - minB) / rangeB;

      if (Number.isFinite(entryRel) && entryRel >= 0.85) {
        return {
          quality: "zu spät",
          reason:
            `Signal kam nahe am 7-Tage-Hochpunkt vor dem Signal ` +
            `(${Math.round(entryRel * 100)} % der Vorspanne von ${minB.toFixed(2)} – ${maxB.toFixed(2)})`,
          dataAvailable: true,
        };
      }
    }
  }

  if (delta24h !== null && delta24h < -0.05) {
    return {
      quality: "zu früh",
      reason: `Preis fiel in den ersten 24h um ${Math.abs(pct(delta24h))} % – Signal kam vor dem Tief`,
      dataAvailable: true,
    };
  }

  if (delta24h !== null && delta24h > 0.01) {
    return {
      quality: "passend",
      reason: `Preis stieg in den ersten 24h um ${pct(delta24h)} % – Signal kam nah am günstigen Einstieg`,
      dataAvailable: true,
    };
  }

  if (delta24h !== null && delta24h < -0.02 && delta7d !== null && delta7d > 0) {
    return {
      quality: "zu früh",
      reason:
        `Preis fiel zunächst ${Math.abs(pct(delta24h))} %, erholte sich aber ` +
        `innerhalb 7 Tagen auf ${pct(delta7d) >= 0 ? "+" : ""}${pct(delta7d)} %`,
      dataAvailable: true,
    };
  }

  if (delta7d !== null && delta7d > 0.02) {
    return {
      quality: "passend",
      reason: `7-Tage-Return ${pct(delta7d) >= 0 ? "+" : ""}${pct(delta7d)} % – Signal war zeitlich solide`,
      dataAvailable: true,
    };
  }

  return {
    quality: "unklar",
    reason: "Datenlage nicht eindeutig für Timing-Bewertung",
    dataAvailable: delta24h !== null || delta7d !== null,
  };
}

/* ── outcome status ───────────────────────────────────────────────────── */

function computeOutcomeStatus(row, window) {
  const conviction = safe(row?.final_conviction, 0);
  const isBullish = conviction >= 50;

  let priceDelta = null;
  let dataSource = null;

  if (window === "7d") {
    priceDelta = getPerfDelta(row?.performance_7d);
    dataSource = priceDelta !== null ? "performance_7d" : null;
  } else if (window === "30d" && row?.is_evaluated && row?.actual_return !== null) {
    priceDelta = safeNullableNumber(row.actual_return);
    dataSource = priceDelta !== null ? "actual_return" : null;
  }

  const returnPct = priceDelta !== null ? pct(priceDelta) : null;

  if (priceDelta === null) {
    const ageDays = signalAgeDays(row?.predicted_at || row?.signal_at);
    const daysNeeded = window === "7d" ? 7 : window === "30d" ? 30 : 90;
    const tooYoung = ageDays !== null && ageDays < daysNeeded;

    return {
      status: "offen",
      returnPct: null,
      dataSource: null,
      note: tooYoung
        ? `Signal erst ${ageDays} Tage alt – ${daysNeeded}-Tage-Fenster noch nicht auswertbar`
        : `Noch keine ${window}-Daten verfügbar`,
    };
  }

  let status;
  if (isBullish) {
    if (priceDelta > 0.03) status = "richtig";
    else if (priceDelta > -0.03) status = "teilweise";
    else status = "falsch";
  } else {
    if (priceDelta < -0.03) status = "richtig";
    else if (priceDelta < 0.03) status = "teilweise";
    else status = "falsch";
  }

  return { status, returnPct, dataSource, note: null };
}

/* ────────────────────────────────────────────────────────────────────────
   1. SIGNAL HISTORY (paginated)
──────────────────────────────────────────────────────────────────────── */

async function getSignalHistoryAll({ symbol = null, limit = 50, offset = 0 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const sym = symbol ? String(symbol).trim().toUpperCase() : null;

  try {
    const params = [];
    let where = "";

    if (sym) {
      params.push(sym);
      where = `WHERE ot.symbol = $${params.length}`;
    }

    params.push(safeLimit);
    params.push(safeOffset);
    const limitIdx = params.length - 1;
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
        ms.price_usd               AS current_price_usd,
        ms.currency                AS current_currency,
        ms.fx_rate                 AS current_fx_rate,
        ms.created_at              AS price_updated_at
      FROM outcome_tracking ot
      LEFT JOIN LATERAL (
        SELECT price, price_usd, currency, fx_rate, created_at
        FROM market_snapshots
        WHERE symbol = ot.symbol
          AND price > 0
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

    let fxRateForLegacy = null;
    const hasLegacyUsd = rows.some(
      (r) =>
        r.current_currency &&
        String(r.current_currency).toUpperCase() === "USD" &&
        (r.current_price !== null || r.current_price_usd !== null)
    );

    if (hasLegacyUsd) {
      fxRateForLegacy = await getUsdToEurRate().catch(() => null);
    }

    const signals = rows.map((r) => _buildSignalRow(r, fxRateForLegacy));

    const totalRes = await pool.query(
      `SELECT COUNT(*) AS cnt FROM outcome_tracking${sym ? " WHERE symbol = $1" : ""}`,
      sym ? [sym] : []
    );
    const total = Number(totalRes.rows[0]?.cnt || 0);

    const missingPrices = signals.filter((s) => s.currentPrice === null).length;

    return {
      success: true,
      dataStatus:
        signals.length === 0 ? "empty" : missingPrices === signals.length ? "partial" : "full",
      _meta: {
        source: "outcome_tracking + market_snapshots",
        total,
        returned: signals.length,
        limit: safeLimit,
        offset: safeOffset,
        symbolFilter: sym,
        missingPriceCount: missingPrices,
        generatedAt: new Date().toISOString(),
      },
      signals,
    };
  } catch (err) {
    logger.error("signalHistory.getSignalHistoryAll error", { message: err.message });
    return _errorShape("getSignalHistoryAll", err.message);
  }
}

async function getSignalHistoryBySymbol(symbol, limit = 50) {
  return getSignalHistoryAll({ symbol, limit, offset: 0 });
}

function _buildSignalRow(r, legacyFxRate) {
  const entryPrice = safeNullableNumber(r.entry_price);

  let currentPrice = safeNullableNumber(r.current_price);
  const currentPriceUsd = safeNullableNumber(r.current_price_usd);
  const rowCurrency = String(r.current_currency || "EUR").toUpperCase();

  if (rowCurrency === "USD") {
    const snapshotFxRate =
      r.current_fx_rate !== null &&
      Number.isFinite(Number(r.current_fx_rate)) &&
      Number(r.current_fx_rate) > 0
        ? Number(r.current_fx_rate)
        : null;

    const rateToUse = snapshotFxRate ?? legacyFxRate ?? null;
    const baseUsd = currentPriceUsd ?? currentPrice;

    if (baseUsd !== null) {
      const converted = convertUsdToEur(baseUsd, rateToUse);
      currentPrice = converted !== null ? converted : null;
    } else {
      currentPrice = null;
    }
  }

  let changeSinceSignalPct = null;
  if (entryPrice !== null && entryPrice > 0 && currentPrice !== null && currentPrice > 0) {
    changeSinceSignalPct = pct((currentPrice - entryPrice) / entryPrice);
  }

  const ageDays = signalAgeDays(r.signal_at);
  const missing = [];

  if (r.hqs_score === null || r.hqs_score === undefined) missing.push("hqs_score");
  if (r.final_confidence === null || r.final_confidence === undefined) missing.push("final_confidence");
  if (currentPrice === null) missing.push("current_price");
  if (!r.performance_7d) missing.push("performance_7d");

  return {
    id: r.id,
    symbol: r.symbol,
    signalAt: r.signal_at ? new Date(r.signal_at).toISOString() : null,
    signalAgeDays: ageDays,
    hqsScore: r.hqs_score !== null ? safe(r.hqs_score) : null,
    finalConfidence: r.final_confidence !== null ? safe(r.final_confidence) : null,
    finalConviction: r.final_conviction !== null ? safe(r.final_conviction) : null,
    regime: safeStr(r.regime),
    strategy: safeStr(r.strategy),
    entryPrice: entryPrice !== null && entryPrice > 0 ? entryPrice : null,
    currentPrice,
    priceUpdatedAt: r.price_updated_at ? new Date(r.price_updated_at).toISOString() : null,
    changeSinceSignalPct,
    isEvaluated: Boolean(r.is_evaluated),
    horizonDays: safeNullableNumber(r.horizon_days),
    analysisRationale: safeStr(r.analysis_rationale),
    has24hPerf: Boolean(r.performance_24h),
    has7dPerf: Boolean(r.performance_7d),
    missingFields: missing,
    fieldCompleteness: dataStatusFromMissing(missing, 4),
  };
}

/* ────────────────────────────────────────────────────────────────────────
   2. OUTCOME ANALYSIS
──────────────────────────────────────────────────────────────────────── */

async function getOutcomeAnalysis({ symbol = null, limit = 50, offset = 0 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const sym = symbol ? String(symbol).trim().toUpperCase() : null;

  try {
    const params = [];
    let where = "";

    if (sym) {
      params.push(sym);
      where = `WHERE ot.symbol = $${params.length}`;
    }

    params.push(safeLimit);
    params.push(safeOffset);
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;

    const sql = `
      SELECT
        ot.id,
        ot.symbol,
        ot.predicted_at       AS signal_at,
        ot.predicted_at,
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
        ms_range.max_price_after,
        ms_range.min_price_after,
        ms_range.snapshot_count_after
      FROM outcome_tracking ot
      LEFT JOIN LATERAL (
        SELECT
          MAX(price) AS max_price_after,
          MIN(price) AS min_price_after,
          COUNT(*)   AS snapshot_count_after
        FROM market_snapshots
        WHERE symbol = ot.symbol
          AND created_at > ot.predicted_at
          AND created_at <= ot.predicted_at + INTERVAL '30 days'
          AND price > 0
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

    const open7d = outcomes.filter((o) => o.outcome7d.status === "offen").length;
    const open30d = outcomes.filter((o) => o.outcome30d.status === "offen").length;
    const correct7d = outcomes.filter((o) => o.outcome7d.status === "richtig").length;
    const correct30d = outcomes.filter((o) => o.outcome30d.status === "richtig").length;
    const evaluable7d = outcomes.filter((o) => o.outcome7d.status !== "offen").length;
    const evaluable30d = outcomes.filter((o) => o.outcome30d.status !== "offen").length;

    return {
      success: true,
      dataStatus: outcomes.length === 0 ? "empty" : open7d === outcomes.length ? "partial" : "full",
      _meta: {
        source: "outcome_tracking + market_snapshots",
        total,
        returned: outcomes.length,
        limit: safeLimit,
        offset: safeOffset,
        symbolFilter: sym,
        open7dCount: open7d,
        open30dCount: open30d,
        evaluable7dCount: evaluable7d,
        evaluable30dCount: evaluable30d,
        correct7dCount: correct7d,
        correct30dCount: correct30d,
        hitRate7dPct: evaluable7d > 0 ? Math.round((correct7d / evaluable7d) * 100) : null,
        hitRate30dPct: evaluable30d > 0 ? Math.round((correct30d / evaluable30d) * 100) : null,
        note: "maxUpsidePct und maxDrawdownPct stammen aus gespeicherten market_snapshots im 30-Tage-Fenster",
        generatedAt: new Date().toISOString(),
      },
      outcomes,
    };
  } catch (err) {
    logger.error("signalHistory.getOutcomeAnalysis error", { message: err.message });
    return _errorShape("getOutcomeAnalysis", err.message);
  }
}

function _buildOutcomeRow(r) {
  const entryPrice = safeNullableNumber(r.entry_price);
  const maxPriceAfter = safeNullableNumber(r.max_price_after);
  const minPriceAfter = safeNullableNumber(r.min_price_after);
  const snapshotCount = safe(r.snapshot_count_after, 0);

  let maxUpsidePct = null;
  let maxDrawdownPct = null;

  if (entryPrice !== null && entryPrice > 0 && maxPriceAfter !== null && maxPriceAfter > 0) {
    maxUpsidePct = pct((maxPriceAfter - entryPrice) / entryPrice);
  }

  if (entryPrice !== null && entryPrice > 0 && minPriceAfter !== null && minPriceAfter > 0) {
    maxDrawdownPct = pct((entryPrice - minPriceAfter) / entryPrice);
  }

  const outcome7d = computeOutcomeStatus(r, "7d");
  const outcome30d = computeOutcomeStatus(r, "30d");
  const outcome90d = {
    status: "offen",
    returnPct: null,
    dataSource: null,
    note: "90-Tage-Fenster noch nicht implementiert – kein performance_90d Feld vorhanden",
  };

  return {
    id: r.id,
    symbol: r.symbol,
    signalAt: r.signal_at ? new Date(r.signal_at).toISOString() : null,
    signalAgeDays: signalAgeDays(r.signal_at),
    entryPrice: entryPrice !== null && entryPrice > 0 ? entryPrice : null,
    hqsScore: r.hqs_score !== null ? safe(r.hqs_score) : null,
    regime: safeStr(r.regime),
    isEvaluated: Boolean(r.is_evaluated),
    outcome7d,
    outcome30d,
    outcome90d,
    maxUpsidePct,
    maxDrawdownPct,
    _priceRangeSource:
      snapshotCount > 0
        ? `${snapshotCount} market_snapshots in 30-Tage-Fenster`
        : "keine post-Signal Snapshots verfügbar",
  };
}

/* ────────────────────────────────────────────────────────────────────────
   3. TIMING QUALITY
──────────────────────────────────────────────────────────────────────── */

async function getTimingQuality({ symbol = null, limit = 50, offset = 0 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const sym = symbol ? String(symbol).trim().toUpperCase() : null;

  try {
    const params = [];
    let where = "";

    if (sym) {
      params.push(sym);
      where = `WHERE ot.symbol = $${params.length}`;
    }

    params.push(safeLimit);
    params.push(safeOffset);
    const limitIdx = params.length - 1;
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
        pre.min_price_before,
        pre.max_price_before,
        pre.pre_snapshot_count
      FROM outcome_tracking ot
      LEFT JOIN LATERAL (
        SELECT
          MIN(price) AS min_price_before,
          MAX(price) AS max_price_before,
          COUNT(*)   AS pre_snapshot_count
        FROM market_snapshots
        WHERE symbol = ot.symbol
          AND created_at < ot.predicted_at
          AND created_at >= ot.predicted_at - INTERVAL '7 days'
          AND price > 0
      ) pre ON true
      ${where}
      ORDER BY ot.predicted_at DESC
      LIMIT  $${limitIdx}
      OFFSET $${offsetIdx}
    `;

    const res = await pool.query(sql, params);
    const rows = res.rows || [];

    const items = rows.map((r) => {
      const preStats =
        safe(r.pre_snapshot_count, 0) > 0
          ? {
              min_price_before: r.min_price_before,
              max_price_before: r.max_price_before,
            }
          : null;

      const timing = computeTimingQuality(r, preStats);

      return {
        id: r.id,
        symbol: r.symbol,
        signalAt: r.signal_at ? new Date(r.signal_at).toISOString() : null,
        signalAgeDays: signalAgeDays(r.signal_at),
        entryPrice: safe(r.entry_price) > 0 ? safe(r.entry_price) : null,
        hqsScore: r.hqs_score !== null ? safe(r.hqs_score) : null,
        regime: safeStr(r.regime),
        timingQuality: timing.quality,
        timingReason: timing.reason,
        timingDataAvailable: timing.dataAvailable,
        _preSignalSnapshotCount: safe(r.pre_snapshot_count, 0),
      };
    });

    const dist = { passend: 0, zuFrueh: 0, zuSpaet: 0, unklar: 0 };
    for (const item of items) {
      if (item.timingQuality === "passend") dist.passend++;
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
      success: true,
      dataStatus: items.length === 0 ? "empty" : dist.unklar === items.length ? "partial" : "full",
      _meta: {
        source: "outcome_tracking + market_snapshots (pre-signal context)",
        total,
        returned: items.length,
        limit: safeLimit,
        offset: safeOffset,
        symbolFilter: sym,
        distribution: dist,
        note: "Timing-Bewertung basiert auf performance_24h/7d und market_snapshots vor dem Signal",
        generatedAt: new Date().toISOString(),
      },
      timingItems: items,
    };
  } catch (err) {
    logger.error("signalHistory.getTimingQuality error", { message: err.message });
    return _errorShape("getTimingQuality", err.message);
  }
}

/* ────────────────────────────────────────────────────────────────────────
   4. FORECAST VS OUTCOME
──────────────────────────────────────────────────────────────────────── */

async function getForecastVsOutcome({
  symbol = null,
  limit = 50,
  offset = 0,
  windowDays = 30,
} = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeDays = Math.max(1, Math.min(Number(windowDays) || 30, 365));
  const sym = symbol ? String(symbol).trim().toUpperCase() : null;

  try {
    const params = [safeDays];
    let andSym = "";

    if (sym) {
      params.push(sym);
      andSym = `AND af.symbol = $${params.length}`;
    }

    params.push(safeLimit);
    params.push(safeOffset);
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;

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
        SELECT
          id,
          hqs_score,
          final_conviction,
          final_confidence,
          regime,
          performance_7d,
          actual_return,
          is_evaluated
        FROM outcome_tracking
        WHERE symbol = af.symbol
          AND predicted_at BETWEEN af.forecasted_at - INTERVAL '6 hours'
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

    const unverifiedParams = [safeDays];
    let unverifiedSymFilter = "";

    if (sym) {
      unverifiedParams.push(sym);
      unverifiedSymFilter = `AND symbol = $${unverifiedParams.length}`;
    }

    const unverRes = await pool.query(
      `
      SELECT COUNT(*) AS cnt
      FROM agent_forecasts
      WHERE verified_at IS NULL
        AND forecasted_at >= NOW() - INTERVAL '1 day' * $1
        ${unverifiedSymFilter}
      `,
      unverifiedParams
    );

    const unverifiedCount = Number(unverRes.rows[0]?.cnt || 0);
    const items = rows.map((r) => _buildForecastVsOutcomeRow(r));

    const correct = items.filter((i) => i.wasCorrect24h === true).length;
    const incorrect = items.filter((i) => i.wasCorrect24h === false).length;
    const matched = items.filter((i) => i.outcomeId !== null).length;

    return {
      success: true,
      dataStatus: items.length === 0 ? "empty" : matched === 0 ? "partial" : "full",
      _meta: {
        source: "agent_forecasts + outcome_tracking",
        returned: items.length,
        limit: safeLimit,
        offset: safeOffset,
        symbolFilter: sym,
        windowDays: safeDays,
        unverifiedCount,
        verifiedCount: items.length,
        correctCount: correct,
        incorrectCount: incorrect,
        accuracyPct: correct + incorrect > 0 ? Math.round((correct / (correct + incorrect)) * 100) : null,
        matchedToOutcomeCount: matched,
        note:
          matched < items.length
            ? `${items.length - matched} Forecasts konnten keinem Outcome-Tracking-Eintrag zugeordnet werden`
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
  let outcomeAlignment = null;
  let alignmentNote = null;

  const forecastDir = normalizeDirection(r.forecast_dir);
  const actual24hDir = normalizeDirection(r.actual_dir);

  const delta7d = getPerfDelta(r.performance_7d);
  const actualReturn = safeNullableNumber(r.ot_actual_return);

  if (delta7d !== null && forecastDir) {
    const actualMove = delta7d > 0.01 ? "bullish" : delta7d < -0.01 ? "bearish" : "neutral";
    outcomeAlignment =
      actualMove === forecastDir ? "getroffen" : forecastDir === "neutral" ? "teilweise" : "verfehlt";
    alignmentNote =
      `Prognose: ${forecastDir}, 7d-Bewegung: ${actualMove} ` +
      `(${pct(delta7d) >= 0 ? "+" : ""}${pct(delta7d)} %)`;
  } else if (Boolean(r.ot_is_evaluated) && actualReturn !== null && forecastDir) {
    const actualMove = actualReturn > 0.01 ? "bullish" : actualReturn < -0.01 ? "bearish" : "neutral";
    outcomeAlignment = actualMove === forecastDir ? "getroffen" : "verfehlt";
    alignmentNote =
      `Prognose: ${forecastDir}, Evaluated Return: ${pct(actualReturn) >= 0 ? "+" : ""}${pct(actualReturn)} %`;
  } else {
    outcomeAlignment = "offen";
    alignmentNote = "7d-Performance noch nicht verfügbar";
  }

  return {
    forecastId: r.forecast_id,
    outcomeId: r.outcome_id || null,
    symbol: r.symbol,
    agentName: r.agent_name,
    forecastDirection: forecastDir,
    forecastReason: safeStr(r.forecast_reason),
    forecastEntryPrice: safeNullableNumber(r.forecast_entry_price),
    debateApproved: Boolean(r.debate_approved),
    forecastedAt: r.forecasted_at ? new Date(r.forecasted_at).toISOString() : null,
    verifiedAt: r.verified_at ? new Date(r.verified_at).toISOString() : null,
    actual24hDir,
    forecast24hExitPrice: safeNullableNumber(r.forecast_exit_price),
    wasCorrect24h: r.was_correct !== null ? Boolean(r.was_correct) : null,
    outcomeAlignment,
    alignmentNote,
    hqsScore: r.hqs_score !== null ? safe(r.hqs_score) : null,
    finalConviction: r.final_conviction !== null ? safe(r.final_conviction) : null,
    finalConfidence: r.final_confidence !== null ? safe(r.final_confidence) : null,
    regime: safeStr(r.regime),
  };
}

/* ────────────────────────────────────────────────────────────────────────
   5. SIGNAL KPIs
──────────────────────────────────────────────────────────────────────── */

async function getSignalKPIs({ windowDays = 90 } = {}) {
  const safeDays = Math.max(7, Math.min(Number(windowDays) || 90, 365));

  const detectTimingBucket = (row) => {
    const timing = computeTimingQuality(row, null);
    return timing?.quality || "unklar";
  };

  try {
    const [outcomeRes, timingRes, agentRes, nearMissRes] = await Promise.all([
      pool.query(
        `
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE is_evaluated = TRUE) AS evaluated,
          COUNT(*) FILTER (WHERE is_evaluated = FALSE) AS open_signals,
          COUNT(*) FILTER (WHERE performance_7d IS NOT NULL) AS has_7d,

          COUNT(*) FILTER (
            WHERE performance_7d IS NOT NULL
              AND (
                (final_conviction >= 50 AND (performance_7d->>'price_delta')::numeric > 0.03)
                OR
                (final_conviction < 50 AND (performance_7d->>'price_delta')::numeric < -0.03)
              )
          ) AS correct_7d,

          COUNT(*) FILTER (
            WHERE is_evaluated = TRUE
              AND actual_return IS NOT NULL
              AND (
                (final_conviction >= 50 AND actual_return > 0.03)
                OR
                (final_conviction < 50 AND actual_return < -0.03)
              )
          ) AS correct_evaluated,

          AVG(
            CASE
              WHEN performance_7d IS NOT NULL
              THEN (performance_7d->>'price_delta')::numeric
              ELSE NULL
            END
          ) AS avg_return_7d,

          AVG(
            CASE
              WHEN is_evaluated = TRUE AND actual_return IS NOT NULL
              THEN actual_return
              ELSE NULL
            END
          ) AS avg_return_evaluated
        FROM outcome_tracking
        WHERE predicted_at >= NOW() - INTERVAL '1 day' * $1
        `,
        [safeDays]
      ),

      pool.query(
        `
        SELECT
          entry_price,
          performance_24h,
          performance_7d
        FROM outcome_tracking
        WHERE predicted_at >= NOW() - INTERVAL '1 day' * $1
        `,
        [safeDays]
      ),

      pool.query(
        `
        SELECT
          COUNT(*) AS total_verified,
          COUNT(*) FILTER (WHERE was_correct = TRUE) AS correct,
          COUNT(*) FILTER (WHERE was_correct = FALSE) AS incorrect
        FROM agent_forecasts
        WHERE verified_at IS NOT NULL
          AND forecasted_at >= NOW() - INTERVAL '1 day' * $1
        `,
        [safeDays]
      ),

      pool
        .query(
          `
          SELECT AVG(saved_capital) AS avg_saved
          FROM guardian_near_miss
          WHERE saved_capital IS NOT NULL
            AND created_at >= NOW() - INTERVAL '1 day' * $1
          `,
          [safeDays]
        )
        .catch(() => ({ rows: [{ avg_saved: null }] })),
    ]);

    const ov = outcomeRes?.rows?.[0] || {};
    const ag = agentRes?.rows?.[0] || {};
    const nm = nearMissRes?.rows?.[0] || {};

    const timingDist = {
      passend: 0,
      zuFrueh: 0,
      zuSpaet: 0,
      unklar: 0,
    };

    for (const row of timingRes?.rows || []) {
      const bucket = detectTimingBucket(row);

      if (bucket === "passend") timingDist.passend++;
      else if (bucket === "zu früh") timingDist.zuFrueh++;
      else if (bucket === "zu spät") timingDist.zuSpaet++;
      else timingDist.unklar++;
    }

    const total = Number(ov.total || 0);
    const evaluated = Number(ov.evaluated || 0);
    const openCount = Number(ov.open_signals || 0);
    const has7d = Number(ov.has_7d || 0);
    const correct7d = Number(ov.correct_7d || 0);
    const correctEvaluated = Number(ov.correct_evaluated || 0);

    const agentVerified = Number(ag.total_verified || 0);
    const agentCorrect = Number(ag.correct || 0);

    const avgSavedCapital =
      nm.avg_saved !== null && nm.avg_saved !== undefined
        ? Number(Number(nm.avg_saved).toFixed(2))
        : null;

    return {
      success: true,
      dataStatus: total === 0 ? "empty" : has7d === 0 ? "partial" : "full",
      _meta: {
        source: "outcome_tracking + agent_forecasts + guardian_near_miss",
        windowDays: safeDays,
        generatedAt: new Date().toISOString(),
        note: "KPI-Endpoint bewusst auf schnelle Aggregation reduziert; keine schweren market_snapshots-Range-Scans.",
      },
      kpis: {
        totalSignals: total,
        evaluableSignals7d: has7d,
        evaluableSignals30d: evaluated,
        openSignals: openCount,

        hitRate7dPct: has7d > 0 ? Math.round((correct7d / has7d) * 100) : null,
        hitRate30dPct: evaluated > 0 ? Math.round((correctEvaluated / evaluated) * 100) : null,

        avgReturn7dPct: ov.avg_return_7d !== null ? pct(ov.avg_return_7d) : null,
        avgReturn30dPct: ov.avg_return_evaluated !== null ? pct(ov.avg_return_evaluated) : null,

        avgMaxUpsidePct: null,
        avgMaxDrawdownPct: null,

        avgSavedCapitalEur: avgSavedCapital,

        agentForecastAccuracyPct:
          agentVerified > 0 ? Math.round((agentCorrect / agentVerified) * 100) : null,
        agentForecastsVerified: agentVerified,

        timingDistribution: {
          passend: timingDist.passend,
          zuFrueh: timingDist.zuFrueh,
          zuSpaet: timingDist.zuSpaet,
          unklar: timingDist.unklar,
        },
      },
    };
  } catch (err) {
    logger.error("signalHistory.getSignalKPIs error", { message: err.message });
    return _errorShape("getSignalKPIs", err.message);
  }
}

/* ── exports ───────────────────────────────────────────────────────────── */

module.exports = {
  getSignalHistoryAll,
  getSignalHistoryBySymbol,
  getOutcomeAnalysis,
  getTimingQuality,
  getForecastVsOutcome,
  getSignalKPIs,
};
