"use strict";

/**
 * historicalService – Historical price data provider.
 *
 * getHistoricalPrices: Returns an array of daily { close } price objects for a symbol.
 * Falls back to an empty array when the data source is unavailable so that callers
 * (e.g. marketService.buildMarketSnapshot) can handle the no-data path gracefully.
 *
 * factor_history persistence is owned exclusively by factorHistory.repository.js.
 */

// Pluggable provider: swap in a real API client here when available.
async function getHistoricalPrices(_symbol, _period) {
  return [];
}

module.exports = {
  getHistoricalPrices,
};
