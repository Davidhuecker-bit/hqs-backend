"use strict";

require("dotenv").config();

const logger = require("../utils/logger");

const {
  initJobLocksTable,
  acquireLock,
} = require("../services/jobLock.repository");

const { evaluateDiscoveries } = require("../services/discoveryLearning.service");
const { fetchQuote } = require("../services/providerService");

const {
  initOutcomeTrackingTable,
  getDueOutcomePredictions,
  completeOutcomePrediction,
  calculateActualReturn,
} = require("../services/outcomeTracking.repository");

const EVAL_LIMIT = Number(process.env.OUTCOME_EVAL_LIMIT || 200);

async function evaluateTrackedOutcomes(limit = EVAL_LIMIT) {
  await initOutcomeTrackingTable();

  const due = await getDueOutcomePredictions(limit);

  if (!due.length) {
    logger.info("No due outcome predictions found");
    return {
      due: 0,
      evaluated: 0,
      failed: 0,
    };
  }

  logger.info("Outcome evaluation started", {
    due: due.length,
  });

  let evaluated = 0;
  let failed = 0;

  for (const row of due) {
    try {
      const symbol = String(row.symbol || "").toUpperCase();
      if (!symbol) {
        failed++;
        continue;
      }

      const raw = await fetchQuote(symbol);

      if (!raw || !raw.length) {
        failed++;
        logger.warn("Outcome evaluation: no quote found", { symbol, id: row.id });
        continue;
      }

      const quote = raw[0] || {};
      const exitPrice = Number(
        quote.price ?? quote.c ?? quote.close ?? quote.lastPrice
      );

      if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
        failed++;
        logger.warn("Outcome evaluation: invalid exit price", {
          symbol,
          id: row.id,
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

      logger.info("Outcome prediction evaluated", {
        id: row.id,
        symbol,
        entryPrice: Number(row.entry_price || 0),
        exitPrice,
        actualReturn,
      });
    } catch (err) {
      failed++;

      logger.error("Outcome evaluation failed", {
        id: row?.id,
        symbol: row?.symbol,
        message: err?.message || String(err),
      });
    }
  }

  const summary = {
    due: due.length,
    evaluated,
    failed,
  };

  logger.info("Outcome evaluation finished", summary);

  return summary;
}

async function run() {
  await initJobLocksTable();

  const won = await acquireLock("discovery_learning_job", 20 * 60);
  if (!won) {
    logger.warn("Discovery learning skipped (lock held)");
    return;
  }

  logger.info("Discovery learning started");

  const discoveryResult = await evaluateDiscoveries();
  const outcomeResult = await evaluateTrackedOutcomes();

  logger.info("Discovery learning finished", {
    discoveryResult,
    outcomeResult,
  });
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((e) => {
      logger.error("Discovery learning fatal", {
        message: e?.message || String(e),
        stack: e?.stack,
      });
      process.exit(1);
    });
}

module.exports = {
  run,
  evaluateTrackedOutcomes,
};
