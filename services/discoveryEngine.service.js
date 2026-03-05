"use strict";

const { Pool } = require("pg");
const logger = require("../utils/logger");

// ✅ nutzt dein neues Learning-System (7d/30d kompatibel)
const { saveDiscovery } = require("./discoveryLearning.service");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Einstellungen
const DEFAULT_LIMIT = Number(process.env.DISCOVERY_LIMIT || 10);
// verhindert, dass du jeden Tag dieselben Symbole "neu" findest
const COOLDOWN_DAYS = Number(process.env.DISCOVERY_COOLDOWN_DAYS || 7);

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// DB-Feldwerte bei dir sind teilweise 0..1 oder 0..100 je nach Tabelle.
// Wir behandeln beides robust.
function norm0to1(x) {
  const n = safeNum(x, 0);
  if (n > 1.5) return clamp(n / 100, 0, 1);
  return clamp(n, 0, 1);
}

/**
 * Hidden-Winner Score:
 * - nicht kurzfristig "pump", sondern Wochen/Monate
 * - Qualität/Stabilität wichtig
 * - Trend + relative wichtig
 * - Volatilität zieht ab
 * - Momentum "sweet spot": nicht tot, nicht überhitzt
 */
function calculateDiscoveryScore(row) {
  const hqs = safeNum(row.hqs_score, 0); // meist 0..100
  const trend = safeNum(row.trend, 0); // z.B. 0.12
  const vol = safeNum(row.volatility, 0); // annual

  const momentum = norm0to1(row.momentum);
  const quality = norm0to1(row.quality);
  const stability = norm0to1(row.stability);
  const relative = norm0to1(row.relative);

  const regime = String(row.regime || "neutral").toLowerCase();

  // Regime-aware Gewichte
  let wTrend = 22;
  let wMom = 14;
  let wQual = 18;
  let wStab = 18;
  let wRel = 12;
  let wVol = 10;

  if (regime === "bull") {
    wTrend = 26;
    wMom = 16;
    wVol = 8;
  } else if (regime === "bear" || regime === "crash") {
    wTrend = 16;
    wMom = 10;
    wQual = 22;
    wStab = 22;
    wVol = 14;
  }

  // Momentum-Sweet-Spot (Hidden Winner: noch nicht komplett gelaufen)
  const momSweet =
    momentum >= 0.45 && momentum <= 0.82 ? 1 :
    momentum >= 0.35 && momentum <= 0.90 ? 0.6 : 0;

  const score =
    hqs * 0.35 +
    (trend * wTrend) +
    (momentum * wMom) +
    (quality * wQual) +
    (stability * wStab) +
    (relative * wRel) +
    (momSweet * 8) -
    (vol * wVol);

  return Number(score.toFixed(2));
}

function buildConfidence(row, discoveryScore) {
  const hqs = safeNum(row.hqs_score, 0);
  const quality = norm0to1(row.quality);
  const stability = norm0to1(row.stability);
  const vol = safeNum(row.volatility, 0);
  const trend = safeNum(row.trend, 0);

  let c =
    hqs * 0.35 +
    quality * 25 +
    stability * 25 +
    (trend > 0 ? 10 : 0) -
    vol * 18 +
    clamp(discoveryScore, -20, 60) * 0.6;

  return clamp(Math.round(c), 0, 100);
}

function generateReason(row) {
  const reasons = [];

  const quality = norm0to1(row.quality);
  const stability = norm0to1(row.stability);
  const relative = norm0to1(row.relative);
  const momentum = norm0to1(row.momentum);
  const trend = safeNum(row.trend, 0);
  const vol = safeNum(row.volatility, 0);

  if (quality >= 0.65) reasons.push("gute Qualität");
  if (stability >= 0.65) reasons.push("stabil");
  if (relative >= 0.65) reasons.push("stärker als der Markt");
  if (trend > 0.10) reasons.push("Trend nach oben");

  // Hidden Hinweis
  if (momentum >= 0.45 && momentum <= 0.82) reasons.push("noch nicht überhitzt");
  if (vol > 0.9) reasons.push("aber schwankt stark");

  if (!reasons.length) reasons.push("solide Werte");

  // einfache Sprache (max 3 Punkte)
  return reasons.slice(0, 3).join(" + ");
}

async function getCurrentPrice(symbol) {
  const sym = String(symbol || "").trim().toUpperCase();

  const res = await pool.query(
    `
    SELECT price
    FROM market_snapshots
    WHERE symbol = $1
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [sym]
  );

  if (!res.rows.length) return null;

  const p = Number(res.rows[0].price);
  return Number.isFinite(p) ? p : null;
}

/**
 * Cooldown: wenn Symbol in den letzten X Tagen bereits gespeichert ist -> skip
 */
async function wasRecentlyDiscovered(symbol, days) {
  const sym = String(symbol || "").trim().toUpperCase();
  const d = Number(days);
  if (!sym || !Number.isFinite(d) || d <= 0) return false;

  const res = await pool.query(
    `
    SELECT 1
    FROM discovery_history
    WHERE symbol = $1
      AND created_at > NOW() - ($2 || ' days')::interval
    LIMIT 1
    `,
    [sym, String(d)]
  );

  return !!res.rows.length;
}

/* =========================================================
   MAIN: DISCOVER
========================================================= */

async function discoverStocks(limit = DEFAULT_LIMIT) {
  const lim = clamp(Number(limit) || DEFAULT_LIMIT, 1, 25);

  // DB-first: wir nutzen market_advanced_metrics (wie bisher)
  // aber holen mehr Felder, falls vorhanden (quality/stability)
  const result = await pool.query(`
    SELECT
      symbol,
      hqs_score,
      momentum,
      quality,
      stability,
      relative,
      trend,
      volatility,
      regime
    FROM market_advanced_metrics
    ORDER BY trend DESC
    LIMIT 200
  `);

  const rows = result.rows || [];

  // Hard Filter (Wochen/Monate, nicht 1-Tages-Hype)
  const filtered = rows.filter((row) => {
    const hqs = safeNum(row.hqs_score, 0);
    const q = norm0to1(row.quality);
    const s = norm0to1(row.stability);
    const vol = safeNum(row.volatility, 0);

    if (hqs < 55) return false;
    if (q < 0.45) return false;
    if (s < 0.45) return false;
    if (vol > 1.6) return false; // zu wild

    return true;
  });

  const discoveries = [];

  for (const row of filtered) {
    const discoveryScore = calculateDiscoveryScore(row);
    const confidence = buildConfidence(row, discoveryScore);
    const reason = generateReason(row);

    discoveries.push({
      symbol: String(row.symbol || "").toUpperCase(),
      regime: row.regime ?? null,
      hqsScore: safeNum(row.hqs_score, 0),
      discoveryScore,
      confidence,
      reason,
    });
  }

  // Ranking (Score + Confidence)
  discoveries.sort((a, b) => (b.discoveryScore * 0.7 + b.confidence * 0.3) - (a.discoveryScore * 0.7 + a.confidence * 0.3));

  // Cooldown rausfiltern (damit es wirklich "neu" bleibt)
  const final = [];
  for (const d of discoveries) {
    if (final.length >= lim) break;

    try {
      const recent = await wasRecentlyDiscovered(d.symbol, COOLDOWN_DAYS);
      if (recent) continue;
    } catch (_) {
      // wenn check fehlschlägt: nicht killen
    }

    final.push(d);
  }

  // Save: in discovery_history mit Preis
  let saved = 0;
  for (const d of final) {
    try {
      const priceNow = await getCurrentPrice(d.symbol);
      if (priceNow !== null) {
        await saveDiscovery(d.symbol, d.discoveryScore, priceNow);
        saved++;
      }
    } catch (e) {
      logger.warn("saveDiscovery failed", { symbol: d.symbol, message: e.message });
    }
  }

  logger.info("discoverStocks done", { requested: lim, returned: final.length, saved, cooldownDays: COOLDOWN_DAYS });

  return final;
}

module.exports = {
  discoverStocks,
};
