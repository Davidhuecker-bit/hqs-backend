"use strict";

const { Pool } = require("pg");
const logger = require("../utils/logger");

const {
  getPendingDiscoveries7d,
  getPendingDiscoveries30d,
  updateDiscoveryResult7d,
  updateDiscoveryResult30d,
} = require("./discoveryLearning.repository");

const {
  getDueOutcomePredictions,
  completeOutcomePrediction,
  calculateActualReturn,
  getSetupHistory,
} = require("./outcomeTracking.repository");

const { fetchQuote } = require("./providerService");
const { evaluateLearning } = require("../engines/learningEngine");
const { evaluateMarketMemory } = require("../engines/marketMemoryEngine");
const { evaluateMetaLearning } = require("../engines/metaLearningEngine");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =========================================================
   IN-MEMORY AI STORES
   (später DB/Redis möglich)
========================================================= */

let marketMemoryStore = {};
let metaLearningStore = {};

/* =========================================================
   DISCOVERY SAVE
========================================================= */

async function saveDiscovery(symbol, score, price) {
  const sym = String(symbol || "").trim().toUpperCase();
  const s = Number(score);
  const p = Number(price);

  try {
    await pool.query(
      `
      INSERT INTO discovery_history
        (symbol, discovery_score, price_at_discovery, checked_7d, checked_30d)
      VALUES
        ($1, $2, $3, FALSE, FALSE)
      `,
      [
        sym,
        Number.isFinite(s) ? s : null,
        Number.isFinite(p) ? p : null,
      ]
    );
  } catch (e) {
    logger.warn("saveDiscovery failed", {
      symbol: sym,
      message: e.message,
    });
  }
}

/* =========================================================
   DISCOVERY EVALUATION (BESTEHEND)
========================================================= */

async function evaluateDiscoveries() {
  let done7 = 0;
  let done30 = 0;

  // =========================
  // 7D Evaluation
  // =========================
  const rows7 = await getPendingDiscoveries7d(50);

  for (const row of rows7) {
    try {
      const priceNow = await getCurrentPrice(row.symbol);
      const r7 = calcReturnPct(priceNow, row.price_at_discovery);
      if (r7 === null) continue;

      await updateDiscoveryResult7d(row.id, r7);
      done7++;
    } catch (e) {
      logger.warn("7d evaluation failed", {
        id: row.id,
        symbol: row.symbol,
        message: e.message,
      });
    }
  }

  // =========================
  // 30D Evaluation
  // =========================
  const rows30 = await getPendingDiscoveries30d(50);

  for (const row of rows30) {
    try {
      const priceNow = await getCurrentPrice(row.symbol);
      const r30 = calcReturnPct(priceNow, row.price_at_discovery);
      if (r30 === null) continue;

      await updateDiscoveryResult30d(row.id, r30);
      done30++;
    } catch (e) {
      logger.warn("30d evaluation failed", {
        id: row.id,
        symbol: row.symbol,
        message: e.message,
      });
    }
  }

  logger.info("Discovery evaluation finished", {
    updated7d: done7,
    updated30d: done30,
  });

  return { updated7d: done7, updated30d: done30 };
}

/* =========================================================
   OUTCOME + LEARNING EVALUATION
========================================================= */

async function evaluateTrackedPredictions(limit = 200) {
  const due = await getDueOutcomePredictions(limit);

  if (!due.length) {
    logger.info("No due tracked predictions found");
    return {
      due: 0,
      evaluated: 0,
      failed: 0,
      learningUpdated: 0,
      memoryUpdated: 0,
      metaUpdated: 0,
    };
  }

  let evaluated = 0;
  let failed = 0;
  let learningUpdated = 0;
  let memoryUpdated = 0;
  let metaUpdated = 0;

  for (const row of due) {
    try {
      const symbol = String(row.symbol || "").trim().toUpperCase();
      if (!symbol) {
        failed++;
        continue;
      }

      const raw = await fetchQuote(symbol);
      if (!raw || !raw.length) {
        failed++;
        logger.warn("Tracked prediction: no quote found", {
          id: row.id,
          symbol,
        });
        continue;
      }

      const quote = raw[0] || {};
      const exitPrice = Number(
        quote.price ?? quote.c ?? quote.close ?? quote.lastPrice
      );

      if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
        failed++;
        logger.warn("Tracked prediction: invalid exit price", {
          id: row.id,
          symbol,
          exitPrice,
        });
        continue;
      }

      const actualReturn = calculateActualReturn(row.entry_price, exitPrice);

      const ok = await completeOutcomePrediction({
        id: row.id,
        exitPrice,
        actualReturn,
      });

      if (!ok) {
        failed++;
        continue;
      }

      evaluated++;

      const payload = row.payload || {};

      /* =========================
         LEARNING ENGINE
      ========================= */

      try {
        const learning = evaluateLearning({
          symbol,
          prediction: Number(row.ai_score || 0) / 100,
          actualReturn,
          features: payload.features || {},
          weights: {
            momentum: 0.35,
            quality: 0.35,
            stability: 0.20,
            relative: 0.10,
          },
          regime: row.regime || "neutral",
          horizonDays: row.horizon_days || 30,
        });

        if (learning) {
          learningUpdated++;
        }
      } catch (e) {
        logger.warn("Learning update failed", {
          id: row.id,
          symbol,
          message: e.message,
        });
      }

      /* =========================
         MARKET MEMORY
      ========================= */

      try {
        const memory = evaluateMarketMemory({
          memoryStore: marketMemoryStore,
          symbol,
          regime: row.regime || "neutral",
          strategy: row.strategy || "balanced",
          discoveries: payload.discoveries || [],
          narratives: payload.narratives || [],
          features: payload.features || {},
          crossSignals:
            payload?.globalContext?.crossAsset?.signals || [],
          prediction: Number(row.ai_score || 0) / 100,
          actualReturn,
          confidence: Number(row.final_confidence || 0) / 100,
          persist: true,
        });

        if (memory?.updatedStore) {
          marketMemoryStore = memory.updatedStore;
          memoryUpdated++;
        }
      } catch (e) {
        logger.warn("Market memory update failed", {
          id: row.id,
          symbol,
          message: e.message,
        });
      }

      /* =========================
         META LEARNING
      ========================= */

      try {
        const meta = evaluateMetaLearning({
          metaStore: metaLearningStore,
          context: {
            regime: row.regime || "neutral",
            riskMode:
              payload?.globalContext?.orchestrator?.riskMode?.mode || "neutral",
            strategy: row.strategy || "balanced",
            dominantNarrative:
              payload?.globalContext?.orchestrator?.dominantNarrative?.narrative ||
              "none",
          },
          signalMetrics: {
            trendScore: Number(payload?.features?.trendStrength || 0),
            discoveryCount: Array.isArray(payload?.discoveries)
              ? payload.discoveries.length
              : 0,
            capitalFlowStrength: Number(
              payload?.globalContext?.orchestrator?.capitalFlowStrength || 0
            ),
            eventCount: Array.isArray(
              payload?.globalContext?.eventIntelligence?.events
            )
              ? payload.globalContext.eventIntelligence.events.length
              : 0,
            memoryScore: Number(row.memory_score || 0),
            narrativeCount: Array.isArray(payload?.narratives)
              ? payload.narratives.length
              : 0,
            strategyScore: Number(
              payload?.strategy?.strategyAdjustedScore || 0
            ),
            crossAssetCount: Array.isArray(
              payload?.globalContext?.crossAsset?.signals
            )
              ? payload.globalContext.crossAsset.signals.length
              : 0,
          },
          actualReturn,
          symbol,
          persist: true,
        });

        if (meta?.updatedStore) {
          metaLearningStore = meta.updatedStore;
          metaUpdated++;
        }
      } catch (e) {
        logger.warn("Meta learning update failed", {
          id: row.id,
          symbol,
          message: e.message,
        });
      }

      /* =========================
         OPTIONAL SETUP HISTORY LOG
      ========================= */

      try {
        if (row.setup_signature) {
          const history = await getSetupHistory(row.setup_signature, 50);

          logger.info("Tracked prediction evaluated", {
            id: row.id,
            symbol,
            entryPrice: Number(row.entry_price || 0),
            exitPrice,
            actualReturn,
            setupSignature: row.setup_signature,
            setupHistoryCount: history.length,
          });
        } else {
          logger.info("Tracked prediction evaluated", {
            id: row.id,
            symbol,
            entryPrice: Number(row.entry_price || 0),
            exitPrice,
            actualReturn,
          });
        }
      } catch (e) {
        logger.warn("Setup history lookup failed", {
          id: row.id,
          symbol,
          message: e.message,
        });
      }
    } catch (e) {
      failed++;
      logger.warn("Tracked prediction evaluation failed", {
        id: row?.id,
        symbol: row?.symbol,
        message: e.message,
      });
    }
  }

  const result = {
    due: due.length,
    evaluated,
    failed,
    learningUpdated,
    memoryUpdated,
    metaUpdated,
  };

  logger.info("Tracked prediction evaluation finished", result);

  return result;
}

/* =========================================================
   HELPERS
========================================================= */

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

  const price = Number(res.rows[0].price);
  return Number.isFinite(price) ? price : null;
}

function calcReturnPct(priceNow, priceThen) {
  const now = Number(priceNow);
  const then = Number(priceThen);

  if (!Number.isFinite(now)) return null;
  if (!Number.isFinite(then) || then <= 0) return null;

  return ((now - then) / then) * 100;
}

module.exports = {
  saveDiscovery,
  evaluateDiscoveries,
  evaluateTrackedPredictions,
};
