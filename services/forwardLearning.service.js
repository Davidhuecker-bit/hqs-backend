"use strict";

/*
  Forward Learning Service (v1)
  -----------------------------------------
  Zweck:
  - Nutzt gespeicherte HQS Scores (hqs_scores)
  - Vergleicht mit nächstem Snapshot aus market_snapshots
  - Speichert Outcome als Learning-Snapshot in factor_history (symbol=PORTFOLIO)

  Warum PORTFOLIO?
  - Wir wollen Einzelaktien-Records nicht "umformen"
  - Learning-Daten sind Zusatzdaten und bleiben getrennt
*/

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Wie viele vergangene HQS-Events pro Run prüfen
const DEFAULT_LIMIT = Number(process.env.FORWARD_LEARNING_LIMIT || 40);

// Minimaler Abstand zwischen HQS-Event und Snapshot (in Minuten)
// (Falls du z.B. alle 15min snapshottest, passt 10–15 gut)
const MIN_DELAY_MINUTES = Number(process.env.FORWARD_MIN_DELAY_MINUTES || 10);

// Verhindert Doppel-Learning: speichert zuletzt gelabeltes hqs_scores.id
let lastProcessedHqsScoreId = 0;

/* =========================================================
   Helpers
========================================================= */

function safeNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pctReturn(from, to) {
  if (!from || !to) return null;
  const a = Number(from);
  const b = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return null;
  return ((b - a) / a) * 100;
}

function toIso(d) {
  try {
    return new Date(d).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/* =========================================================
   DB Queries
========================================================= */

/**
 * Holt die letzten HQS-Score Events (neueste zuerst)
 * mit hqs_scores.id, symbol, score, breakdown, timestamp
 */
async function loadRecentHqsScores(limit = DEFAULT_LIMIT) {
  const res = await pool.query(
    `
    SELECT id, symbol, hqs_score, momentum, quality, stability, relative, regime, created_at
    FROM hqs_scores
    ORDER BY id DESC
    LIMIT $1
    `,
    [limit],
  );
  return res.rows || [];
}

/**
 * Findet den nächsten Snapshot NACH einem Zeitpunkt für ein Symbol
 * (der erste Snapshot der danach kommt)
 */
async function loadNextSnapshotAfter(symbol, afterDate) {
  const res = await pool.query(
    `
    SELECT symbol, price, created_at
    FROM market_snapshots
    WHERE symbol = $1
      AND created_at > $2
    ORDER BY created_at ASC
    LIMIT 1
    `,
    [symbol, afterDate],
  );
  return res.rows?.[0] || null;
}

/**
 * Findet den Snapshot, der dem HQS-Event am nächsten ist (<= Event)
 * Damit wir einen "entry price" haben, auch wenn hqs_scores keinen price speichert.
 */
async function loadLastSnapshotBefore(symbol, beforeDate) {
  const res = await pool.query(
    `
    SELECT symbol, price, created_at
    FROM market_snapshots
    WHERE symbol = $1
      AND created_at <= $2
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [symbol, beforeDate],
  );
  return res.rows?.[0] || null;
}

/**
 * Persistiert Learning Snapshot in factor_history als PORTFOLIO record
 */
async function saveForwardLearningSnapshot(regime, portfolioReturn, factors) {
  // factor_history hat: symbol, hqs_score, regime, portfolio_return, factors
  // wir setzen hqs_score = 0 (da es ein Learning-Event ist)
  await pool.query(
    `
    INSERT INTO factor_history
      (symbol, hqs_score, regime, portfolio_return, factors)
    VALUES
      ($1, $2, $3, $4, $5)
    `,
    ["PORTFOLIO", 0, regime || "neutral", portfolioReturn, factors],
  );
}

/* =========================================================
   Main
========================================================= */

/**
 * runForwardLearning()
 * - nimmt mehrere HQS Events
 * - berechnet Forward Returns pro Symbol
 * - macht daraus eine "Portfolio" Learning Row (aggregiert)
 */
async function runForwardLearning() {
  try {
    const recent = await loadRecentHqsScores(DEFAULT_LIMIT);

    if (!recent.length) {
      console.log("🧠 ForwardLearning: keine hqs_scores vorhanden.");
      return { ok: true, processed: 0 };
    }

    // Nur neue Events seit lastProcessedHqsScoreId verarbeiten
    const candidates = recent
      .filter((r) => Number(r.id) > Number(lastProcessedHqsScoreId || 0))
      .reverse(); // älteste zuerst, damit lastProcessed sauber hochläuft

    if (!candidates.length) {
      console.log("🧠 ForwardLearning: nichts Neues zu labeln.");
      return { ok: true, processed: 0 };
    }

    const now = Date.now();
    const minDelayMs = MIN_DELAY_MINUTES * 60 * 1000;

    let processed = 0;
    const forwardReturns = [];
    const factorSums = { momentum: 0, quality: 0, stability: 0, relative: 0 };
    let factorCount = 0;

    for (const e of candidates) {
      const createdAt = new Date(e.created_at).getTime();
      if (!createdAt) continue;

      // Falls Event zu frisch ist, überspringen (noch kein "next snapshot" vorhanden)
      if (now - createdAt < minDelayMs) continue;

      const symbol = String(e.symbol || "").trim().toUpperCase();
      if (!symbol) continue;

      // Entry: Snapshot direkt vor dem Event
      const entry = await loadLastSnapshotBefore(symbol, e.created_at);
      if (!entry?.price) continue;

      // Exit: nächster Snapshot danach
      const exit = await loadNextSnapshotAfter(symbol, e.created_at);
      if (!exit?.price) continue;

      const ret = pctReturn(entry.price, exit.price);
      if (ret === null) continue;

      forwardReturns.push(ret);

      // Faktoren aggregieren (aus hqs_scores row)
      factorSums.momentum += safeNumber(e.momentum, 0) || 0;
      factorSums.quality += safeNumber(e.quality, 0) || 0;
      factorSums.stability += safeNumber(e.stability, 0) || 0;
      factorSums.relative += safeNumber(e.relative, 0) || 0;
      factorCount += 1;

      // lastProcessed hochziehen
      lastProcessedHqsScoreId = Number(e.id);
      processed += 1;
    }

    if (!processed) {
      console.log("🧠 ForwardLearning: noch kein ausreichend altes Event zum labeln.");
      return { ok: true, processed: 0 };
    }

    // Portfolio Return = Durchschnitt der Forward Returns
    const portfolioReturn =
      forwardReturns.length > 0
        ? Number((forwardReturns.reduce((a, b) => a + b, 0) / forwardReturns.length).toFixed(4))
        : null;

    // Faktoren = Durchschnitt der Faktoren der gelabelten Events
    const factors =
      factorCount > 0
        ? {
            momentum: Number((factorSums.momentum / factorCount).toFixed(4)),
            quality: Number((factorSums.quality / factorCount).toFixed(4)),
            stability: Number((factorSums.stability / factorCount).toFixed(4)),
            relative: Number((factorSums.relative / factorCount).toFixed(4)),
            sampleSize: factorCount,
            horizon: "next_snapshot",
            minDelayMinutes: MIN_DELAY_MINUTES,
            generatedAt: toIso(Date.now()),
          }
        : {
            sampleSize: 0,
            horizon: "next_snapshot",
            minDelayMinutes: MIN_DELAY_MINUTES,
            generatedAt: toIso(Date.now()),
          };

    // Regime: wir nehmen das häufigste Regime der gelabelten Events (falls vorhanden)
    // (simple fallback: neutral)
    const regimes = candidates
      .filter((r) => Number(r.id) <= Number(lastProcessedHqsScoreId))
      .map((r) => String(r.regime || "neutral"));
    const regime =
      regimes.length > 0
        ? regimes.sort((a, b) => regimes.filter((x) => x === a).length - regimes.filter((x) => x === b).length).pop()
        : "neutral";

    await saveForwardLearningSnapshot(regime, portfolioReturn, factors);

    console.log(
      `🧠 ForwardLearning saved: processed=${processed}, portfolioReturn=${portfolioReturn}, sampleSize=${factorCount}`,
    );

    return {
      ok: true,
      processed,
      portfolioReturn,
      factorCount,
      lastProcessedHqsScoreId,
    };
  } catch (err) {
    console.error("❌ ForwardLearning Error:", err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  runForwardLearning,
};
