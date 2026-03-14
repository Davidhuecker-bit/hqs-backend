"use strict";

/*
  Tech-Radar Job  –  Innovation Scanner
  ----------------------------------------
  Runs periodically to scan public RSS feeds (arXiv, quantitative finance,
  AI research) for new discoveries relevant to HQS signal quality.

  Discovered entries are persisted in `tech_radar_entries` and surfaced via
  GET /api/admin/tech-radar and GET /api/admin/evolution-board.

  Scheduled from server.js via scheduleTechRadarJob().
*/

const logger = require("../utils/logger");
const { scanTechRadar } = require("../services/techRadar.service");

/**
 * Runs one Tech-Radar scan cycle.
 *
 * @returns {Promise<{ scanned: number, inserted: number, feeds: number }>}
 */
async function runTechRadarJob() {
  try {
    const result = await scanTechRadar();
    logger.info("techRadar: scan completed", {
      feeds:    result.feeds,
      scanned:  result.scanned,
      inserted: result.inserted,
    });
    return result;
  } catch (error) {
    logger.warn("techRadar: job failed", { message: error.message });
    return { scanned: 0, inserted: 0, feeds: 0 };
  }
}

module.exports = { runTechRadarJob };
