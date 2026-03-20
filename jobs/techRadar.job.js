"use strict";

/*
  Tech-Radar Job  –  Innovation Scanner
  ----------------------------------------
  Runs periodically to scan public RSS feeds (arXiv, quantitative finance,
  AI research) for new discoveries relevant to HQS signal quality.

  Discovered entries are persisted in `tech_radar_entries` and surfaced via
  GET /api/admin/tech-radar and GET /api/admin/evolution-board.

  Scheduled from server.js via scheduleTechRadarScan().
*/

const { runJob } = require("../utils/jobRunner");
const { scanTechRadar } = require("../services/techRadar.service");
const {
  acquireLock,
  initJobLocksTable,
} = require("../services/jobLock.repository");

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = console;
}

/**
 * Runs one Tech-Radar scan cycle.
 *
 * @returns {Promise<object>}  runJob result
 */
async function runTechRadarJob() {
  return runJob("techRadar", async () => {
    await initJobLocksTable();

    const won = await acquireLock("tech_radar_job", 60 * 60);
    if (!won) {
      if (logger?.warn) {
        logger.warn("Tech-Radar scan skipped (lock held)");
      }
      return { processedCount: 0 };
    }

    const result = await scanTechRadar();
    return { processedCount: result.inserted ?? 0, feeds: result.feeds, scanned: result.scanned };
  });
}

module.exports = { runTechRadarJob };
