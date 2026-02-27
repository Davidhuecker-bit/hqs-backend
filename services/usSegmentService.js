// services/usSegmentService.js
// US Segment Service - Segmentierte Datenabfrage fuer den US Markt
// Nutzt ausschliesslich getMarketData() - keine direkten API Calls

"use strict";

const { getMarketData } = require("./marketService");
const { US_SEGMENTS } = require("./segments/us.segment.js");

// ============================
// KNOWN LAYERS
// ============================

const KNOWN_LAYERS = Object.keys(US_SEGMENTS);

// ============================
// MAIN FUNCTION
// ============================

/**
 * Laedt segmentierte US-Marktdaten fuer einen bestimmten Layer.
 *
 * @param {string} layer - "core" | "macro" | "tech" | "energy" | "finance" | "health" | "consumer" | "opportunity"
 * @returns {Promise<Array>} - Array mit Marktdaten aller Symbole des Layers
 */
async function getUSSegmentData(layer) {
  const safeLayer = String(layer || "").toLowerCase().trim();

  if (!safeLayer || !KNOWN_LAYERS.includes(safeLayer)) {
    throw new Error(
      `[usSegmentService] Unbekannter Layer: "${safeLayer}". ` +
        `Gueltige Layer: ${KNOWN_LAYERS.join(", ")}`
    );
  }

  const symbols = US_SEGMENTS[safeLayer];

  if (!Array.isArray(symbols) || symbols.length === 0) {
    console.warn(`[usSegmentService] Layer "${safeLayer}" hat keine Symbole.`);
    return [];
  }

  const results = [];

  for (const symbol of symbols) {
    const safeSymbol = String(symbol || "").trim().toUpperCase();

    if (!safeSymbol) continue;

    try {
      const data = await getMarketData(safeSymbol);

      if (!Array.isArray(data)) continue;

      for (const item of data) {
        if (item) results.push(item);
      }
    } catch (err) {
      console.error(
        `[usSegmentService] Fehler bei Symbol "${safeSymbol}":`,
        err.message
      );
    }
  }

  return results;
}

// ============================
// EXPORTS
// ============================

module.exports = { getUSSegmentData };