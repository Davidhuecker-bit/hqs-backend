"use strict";

const marketNewsService = require("./marketNews.service");

async function collectNewsForSymbols(symbols) {
  return marketNewsService.collectAndStoreMarketNews(symbols);
}

module.exports = {
  collectNewsForSymbols,
};
