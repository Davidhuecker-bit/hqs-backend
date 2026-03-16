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

const { runJob } = require("../utils/jobRunner");
const { scanTechRadar } = require("../services/techRadar.service");

/**
 * Runs one Tech-Radar scan cycle.
 *
 * @returns {Promise<object>}  runJob result
 */
async function runTechRadarJob() {
  return runJob("techRadar", async () => {
    const result = await scanTechRadar();
    return { processedCount: result.inserted ?? 0, feeds: result.feeds, scanned: result.scanned };
  });
}

module.exports = { runTechRadarJob };
