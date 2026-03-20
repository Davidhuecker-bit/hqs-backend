"use strict";

const { Pool } = require("pg");
const logger = require("../utils/logger");

const {
  getPendingDiscoveries7d,
  getPendingDiscoveries30d,
  updateDiscoveryResult7d,
  updateDiscoveryResult30d,
  loadRuntimeState,
  saveRuntimeState,
  saveDiscovery: saveDiscoveryToDb,
  RUNTIME_STATE_MARKET_MEMORY_KEY,
  RUNTIME_STATE_META_LEARNING_KEY,
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
const { getUsdToEurRate, convertUsdToEur } = require("./fx.service");

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
let runtimeStoresLoaded = false;

async function ensureRuntimeStoresLoaded() {
  if (runtimeStoresLoaded) return;

  const [persistedMarketMemory, persistedMetaLearning] = await Promise.all([
    loadRuntimeState(RUNTIME_STATE_MARKET_MEMORY_KEY),
    loadRuntimeState(RUNTIME_STATE_META_LEARNING_KEY),
  ]);

  marketMemoryStore =
    persistedMarketMemory &&
    typeof persistedMarketMemory === "object" &&
    !Array.isArray(persistedMarketMemory)
      ? persistedMarketMemory
      : {};

  metaLearningStore =
    persistedMetaLearning &&
    typeof persistedMetaLearning === "object" &&
    !Array.isArray(persistedMetaLearning)
      ? persistedMetaLearning
      : {};

  runtimeStoresLoaded = true;
}

/* =========================================================
   DISCOVERY SAVE
   Delegates to discoveryLearning.repository (canonical owner of discovery_history writes)
========================================================= */

async function saveDiscovery(symbol, score, price) {
  try {
    await saveDiscoveryToDb(symbol, score, price);
  } catch (e) {
    logger.warn("saveDiscovery failed", {
      symbol: String(symbol || "").trim().toUpperCase(),
      message: e.message,
    });
  }
}

/* =========================================================
   DISCOVERY EVALUATION (BESTEHEND)
========================================================= */

async function evaluateDiscoveries() {
  await ensureRuntimeStoresLoaded();

  let done7 = 0;
  let done30 = 0;
  let skippedNoPrice7 = 0;
  let skippedNoPrice30 = 0;

  // =========================
  // 7D Evaluation
  // =========================
  const rows7 = await getPendingDiscoveries7d(50);

  for (const row of rows7) {
    try {
      const priceNow = await getCurrentPrice(row.symbol);
      const r7 = calcReturnPct(priceNow, row.price_at_discovery);
      if (r7 === null) {
        skippedNoPrice7++;
        logger.warn("[discovery] 7d skipped – no current price", { id: row.id, symbol: row.symbol });
        continue;
      }

      await updateDiscoveryResult7d(row.id, r7);
      done7++;
    } catch (e) {
      logger.warn("[discovery] 7d evaluation failed", {
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
      if (r30 === null) {
        skippedNoPrice30++;
        logger.warn("[discovery] 30d skipped – no current price", { id: row.id, symbol: row.symbol });
        continue;
      }

      await updateDiscoveryResult30d(row.id, r30);
      done30++;
    } catch (e) {
      logger.warn("[discovery] 30d evaluation failed", {
        id: row.id,
        symbol: row.symbol,
        message: e.message,
      });
    }
  }

  logger.info("[discovery] evaluation finished", {
    pending7d: rows7.length,
    updated7d: done7,
    skippedNoPrice7d: skippedNoPrice7,
    pending30d: rows30.length,
    updated30d: done30,
    skippedNoPrice30d: skippedNoPrice30,
  });

  return { updated7d: done7, updated30d: done30 };
}

/* =========================================================
   OUTCOME + LEARNING EVALUATION
========================================================= */

async function evaluateTrackedPredictions(limit = 200) {
  await ensureRuntimeStoresLoaded();

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
      const globalContext =
        payload?.finalView?.globalContext || payload?.globalContext || {};

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
          crossSignals: globalContext?.crossAsset?.signals || [],
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
            riskMode: globalContext?.orchestrator?.riskMode?.mode || "neutral",
            strategy: row.strategy || "balanced",
            dominantNarrative:
              globalContext?.orchestrator?.dominantNarrative?.narrative || "none",
          },
          signalMetrics: {
            trendScore: Number(payload?.features?.trendStrength || 0),
            discoveryCount: Array.isArray(payload?.discoveries)
              ? payload.discoveries.length
              : 0,
            capitalFlowStrength: Number(globalContext?.orchestrator?.capitalFlowStrength || 0),
            eventCount: Array.isArray(globalContext?.eventIntelligence?.events)
              ? globalContext.eventIntelligence.events.length
              : 0,
            memoryScore: Number(row.memory_score || 0),
            narrativeCount: Array.isArray(payload?.narratives)
              ? payload.narratives.length
              : 0,
            strategyScore: Number(
              payload?.strategy?.strategyAdjustedScore || 0
            ),
            crossAssetCount: Array.isArray(globalContext?.crossAsset?.signals)
              ? globalContext.crossAsset.signals.length
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

  if (memoryUpdated > 0) {
    await saveRuntimeState(RUNTIME_STATE_MARKET_MEMORY_KEY, marketMemoryStore);
  }

  if (metaUpdated > 0) {
    await saveRuntimeState(RUNTIME_STATE_META_LEARNING_KEY, metaLearningStore);
  }

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
    SELECT price, price_usd, currency, fx_rate
    FROM market_snapshots
    WHERE symbol = $1
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [sym]
  );

  if (!res.rows.length) return null;

  const row = res.rows[0];
  const currency = String(row.currency || "EUR").toUpperCase();

  if (currency !== "USD") {
    const price = Number(row.price);
    return Number.isFinite(price) ? price : null;
  }

  // Legacy USD snapshot: price_usd holds the original USD value on new rows;
  // on pre-fix rows price_usd is NULL and price IS the USD value.
  const priceUsdField = row.price_usd !== null ? Number(row.price_usd) : null;
  const base = priceUsdField !== null && Number.isFinite(priceUsdField)
    ? priceUsdField
    : Number(row.price); // pre-fix legacy: price field contains USD
  if (!Number.isFinite(base) || base <= 0) return null;
  const storedRate = row.fx_rate !== null ? Number(row.fx_rate) : null;
  const rate = (storedRate !== null && Number.isFinite(storedRate) && storedRate > 0)
    ? storedRate
    : await getUsdToEurRate().catch(() => null);
  const eur = convertUsdToEur(base, rate);
  return eur !== null && Number.isFinite(eur) ? eur : null;
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
