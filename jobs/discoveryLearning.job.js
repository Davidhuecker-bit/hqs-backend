"use strict";

require("dotenv").config();

const logger = require("../utils/logger");
const { runJob } = require("../utils/jobRunner");
const {
  initJobLocksTable,
  acquireLock,
} = require("../services/jobLock.repository");

const {
  evaluateDiscoveries,
  evaluateTrackedPredictions,
} = require("../services/discoveryLearning.service");

const EVAL_LIMIT = Number(process.env.OUTCOME_EVAL_LIMIT || 200);

async function run() {
  return runJob("discoveryLearning", async () => {
    await initJobLocksTable();

    const won = await acquireLock("discovery_learning_job", 20 * 60);
    if (!won) {
      logger.warn("[job:discoveryLearning] skipped – lock held");
      return { processedCount: 0 };
    }

    const discoveryResult = await evaluateDiscoveries();
    const trackedPredictionResult = await evaluateTrackedPredictions(EVAL_LIMIT);

    const processedCount =
      (discoveryResult?.evaluated ?? 0) +
      (trackedPredictionResult?.evaluated ?? 0);

    return { processedCount, discoveryResult, trackedPredictionResult };
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
};
