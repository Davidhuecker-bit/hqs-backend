"use strict";

// jobs/buildEntityMap.job.js
// Run: node jobs/buildEntityMap.job.js

require("dotenv").config();

const logger = require("../utils/logger");
const { runJob } = require("../utils/jobRunner");

const {
  initEntityMapTable,
  upsertEntityMapEntries,
} = require("../services/entityMap.repository");
const { savePipelineStage } = require("../services/pipelineStatus.repository");

const { getSharedPool, closeAllPools } = require("../config/database");
const pool = getSharedPool();
function normalizeSymbol(value) {
  return String(value || "").trim().toUpperCase();
}

function guessSector(symbol) {
  const tech = new Set([
    "AAPL", "MSFT", "NVDA", "AMD", "INTC", "AVGO", "ORCL", "CRM", "ADBE",
    "NOW", "INTU", "IBM", "QCOM", "TXN", "AMAT", "MU", "KLAC", "LRCX",
    "PANW", "CRWD", "FTNT", "SNPS", "CDNS", "ANET", "MSI", "ADSK", "ADI",
    "NXPI", "MCHP", "PLTR", "SNOW", "MDB", "DDOG", "NET", "ZS", "OKTA",
    "SHOP", "SQ", "DOCU", "HUBS", "BILL", "ZM"
  ]);

  const semis = new Set([
    "NVDA", "AMD", "INTC", "QCOM", "TXN", "AMAT", "MU", "KLAC",
    "LRCX", "ADI", "NXPI", "MCHP", "AVGO", "ON", "ARM", "SMCI"
  ]);

  const energy = new Set([
    "XOM", "CVX", "COP", "EOG", "SLB", "MPC", "PSX", "VLO", "OXY",
    "KMI", "WMB", "HES", "DVN", "FANG", "EPD", "ET", "BKR", "HAL",
    "EQT", "APA"
  ]);

  const financials = new Set([
    "JPM", "BAC", "WFC", "GS", "MS", "C", "SCHW", "BLK", "BX", "SPGI",
    "ICE", "CME", "CB", "PGR", "AIG", "ALL", "MMC", "AJG", "TRV", "USB",
    "PNC", "TFC", "COF", "MCO", "AXP", "V", "MA", "DFS", "KKR", "APO"
  ]);

  const healthcare = new Set([
    "LLY", "JNJ", "UNH", "MRK", "ABBV", "PFE", "ABT", "BMY", "TMO", "DHR",
    "ISRG", "SYK", "MDT", "GILD", "AMGN", "CVS", "HCA", "HUM", "CI",
    "REGN", "VRTX", "ZTS", "IQV", "EW", "BSX", "BDX"
  ]);

  if (semis.has(symbol)) return "Technology";
  if (tech.has(symbol)) return "Technology";
  if (energy.has(symbol)) return "Energy";
  if (financials.has(symbol)) return "Financials";
  if (healthcare.has(symbol)) return "Healthcare";

  return "Unknown";
}

function guessIndustry(symbol, sector) {
  const semis = new Set([
    "NVDA", "AMD", "INTC", "QCOM", "TXN", "AMAT", "MU", "KLAC",
    "LRCX", "ADI", "NXPI", "MCHP", "AVGO", "ON", "ARM", "SMCI"
  ]);

  const software = new Set([
    "MSFT", "ORCL", "CRM", "ADBE", "NOW", "INTU", "IBM", "PANW", "CRWD",
    "FTNT", "SNPS", "CDNS", "ADSK", "PLTR", "SNOW", "MDB", "DDOG", "NET",
    "ZS", "OKTA", "DOCU", "HUBS", "BILL", "ZM"
  ]);

  const internet = new Set([
    "GOOGL", "META", "AMZN", "NFLX", "SPOT", "SNAP", "PINS", "RDDT"
  ]);

  const oilMajors = new Set(["XOM", "CVX", "COP", "OXY"]);
  const banks = new Set(["JPM", "BAC", "WFC", "C", "USB", "PNC", "TFC", "COF"]);
  const pharma = new Set(["LLY", "JNJ", "MRK", "ABBV", "PFE", "BMY", "AMGN", "REGN", "VRTX"]);

  if (semis.has(symbol)) return "Semiconductors";
  if (software.has(symbol)) return "Software";
  if (internet.has(symbol)) return "Internet Platforms";
  if (oilMajors.has(symbol)) return "Oil & Gas";
  if (banks.has(symbol)) return "Banks";
  if (pharma.has(symbol)) return "Pharmaceuticals";

  if (sector === "Technology") return "Technology";
  if (sector === "Energy") return "Energy";
  if (sector === "Financials") return "Financials";
  if (sector === "Healthcare") return "Healthcare";

  return "Unknown";
}

function buildThemes(symbol, sector, industry) {
  const themes = new Set();

  if (sector === "Technology") themes.add("technology");
  if (industry === "Semiconductors") {
    themes.add("chips");
    themes.add("ai");
    themes.add("datacenter");
    themes.add("semiconductors");
  }
  if (industry === "Software") {
    themes.add("software");
    themes.add("cloud");
    themes.add("enterprise");
  }
  if (industry === "Internet Platforms") {
    themes.add("internet");
    themes.add("ads");
    themes.add("consumer");
  }
  if (sector === "Energy") {
    themes.add("energy");
    themes.add("oil");
    themes.add("commodities");
  }
  if (sector === "Financials") {
    themes.add("finance");
    themes.add("rates");
    themes.add("credit");
  }
  if (sector === "Healthcare") {
    themes.add("healthcare");
    themes.add("biotech");
    themes.add("drugs");
  }

  if (symbol === "AAPL") {
    themes.add("iphone");
    themes.add("consumer electronics");
    themes.add("china");
  }
  if (symbol === "NVDA") {
    themes.add("ai");
    themes.add("gpu");
    themes.add("datacenter");
  }
  if (symbol === "TSLA") {
    themes.add("ev");
    themes.add("battery");
    themes.add("autonomous driving");
  }
  if (symbol === "XOM" || symbol === "CVX") {
    themes.add("oil");
    themes.add("opec");
  }

  return [...themes];
}

function buildCommodities(symbol, sector) {
  const items = new Set();

  if (sector === "Energy") items.add("oil");
  if (symbol === "XOM" || symbol === "CVX" || symbol === "COP" || symbol === "OXY") {
    items.add("oil");
    items.add("gas");
  }
  if (symbol === "FCX") items.add("copper");
  if (symbol === "NEM") items.add("gold");
  if (symbol === "ALB") items.add("lithium");

  return [...items];
}

function buildCountries(symbol) {
  const items = new Set(["us"]);

  if (symbol === "AAPL") items.add("china");
  if (symbol === "NVDA") items.add("taiwan");
  if (symbol === "TSM") items.add("taiwan");
  if (symbol === "BABA") items.add("china");

  return [...items];
}

function buildAliases(symbol) {
  const aliases = new Set([symbol]);

  const aliasMap = {
    AAPL: ["apple", "apple inc", "iphone maker"],
    MSFT: ["microsoft", "microsoft corp", "azure"],
    NVDA: ["nvidia", "nvidia corp", "gpu leader"],
    AMD: ["amd", "advanced micro devices"],
    GOOGL: ["google", "alphabet", "alphabet inc"],
    META: ["meta", "facebook", "instagram owner"],
    AMZN: ["amazon", "amazon.com"],
    TSLA: ["tesla", "tesla inc", "elon musk company"],
    XOM: ["exxon", "exxon mobil", "exxonmobil"],
    CVX: ["chevron", "chevron corp"],
    JPM: ["jpmorgan", "jp morgan", "jpmorgan chase"],
    BAC: ["bank of america", "bofa"],
    LLY: ["eli lilly", "lilly"],
    PFE: ["pfizer"],
  };

  for (const alias of aliasMap[symbol] || []) {
    aliases.add(alias);
  }

  return [...aliases];
}

async function loadUniverseSymbols(limit = 2000) {
  const res = await pool.query(
    `
    SELECT symbol
    FROM universe_symbols
    WHERE is_active = TRUE
    ORDER BY priority ASC, symbol ASC
    LIMIT $1
    `,
    [limit]
  );

  return (res.rows || [])
    .map((row) => normalizeSymbol(row.symbol))
    .filter(Boolean);
}

async function buildEntityMapBody() {
  await initEntityMapTable();

  const symbols = await loadUniverseSymbols(3000);

  if (!symbols.length) {
    logger.warn("[buildEntityMap] No active universe symbols found – skipping");
    return { processedCount: 0, skippedCount: 1, failedCount: 0 };
  }

  logger.info("[buildEntityMap] Building entity map", {
    symbolsLoaded: symbols.length,
  });

  const entries = symbols.map((symbol) => {
    const sector = guessSector(symbol);
    const industry = guessIndustry(symbol, sector);

    return {
      symbol,
      company_name: symbol,
      sector,
      industry,
      themes: buildThemes(symbol, sector, industry),
      commodities: buildCommodities(symbol, sector),
      countries: buildCountries(symbol),
      aliases: buildAliases(symbol),
      is_active: true,
    };
  });

  const result = await upsertEntityMapEntries(entries);

  // Persist pipeline status for monitoring
  savePipelineStage("build_entity_map", {
    inputCount:   symbols.length,
    successCount: result.insertedOrUpdated || 0,
    failedCount:  symbols.length - (result.insertedOrUpdated || 0),
    skippedCount: 0,
    status:       (result.insertedOrUpdated || 0) > 0 ? "success" : "failed",
  }).catch(() => {});

  return {
    processedCount: result.insertedOrUpdated,
    skippedCount: 0,
    failedCount: symbols.length - (result.insertedOrUpdated || 0),
  };
}

async function run() {
  const jobResult = await runJob("buildEntityMap", buildEntityMapBody, { pool });

  if (!jobResult.success && !jobResult.skipped) {
    process.exitCode = 1;
  }

  await closeAllPools().catch(() => {});
}

run();
