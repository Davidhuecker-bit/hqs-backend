"use strict";

require("dotenv").config();

const logger = require("../utils/logger");
const { acquireLock } = require("../services/jobLock.repository");
const { evaluateDiscoveries } = require("../services/discoveryLearning.service");

async function run() {
  const won = await acquireLock("discovery_learning_job", 20 * 60);
  if (!won) {
    logger.warn("Discovery learning skipped (lock held)");
    return;
  }

  logger.info("Discovery learning started");

  const result = await evaluateDiscoveries();

  logger.info("Discovery learning finished", result);
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((e) => {
      logger.error("Discovery learning fatal", { message: e.message });
      process.exit(1);
    });
}

module.exports = { run };
