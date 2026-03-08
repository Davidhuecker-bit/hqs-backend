"use strict";

const { Pool } = require("pg");
let logger = null;
try { logger = require("../utils/logger"); } catch (_) { logger = null; }

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initWatchlistTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS watchlist_symbols (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      is_active BOOLEAN DEFAULT TRUE,
      priority INT DEFAULT 100,
      region TEXT DEFAULT 'us',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_watchlist_active
    ON watchlist_symbols(is_active, priority, symbol);
  `);

  if (logger?.info) logger.info("watchlist_symbols ready");
}

function parseSymbolsFromEnv() {
  // Unterstützt: "AAPL,MSFT,NVDA" ODER Zeilen ODER Semikolon
  const raw = String(process.env.SYMBOLS || "").trim();
  if (!raw) return [];

  const parts = raw
    .split(/[\n,;]+/g)
    .map((s) => String(s || "").trim().toUpperCase())
    .filter(Boolean);

  return [...new Set(parts)];
}

async function seedDefaultWatchlist() {
  // Wenn schon was drin ist -> nix überschreiben
  const r = await pool.query(`SELECT COUNT(*)::int AS c FROM watchlist_symbols;`);
  if ((r.rows?.[0]?.c ?? 0) > 0) {
    if (logger?.info) logger.info("watchlist already seeded", { count: r.rows[0].c });
    return;
  }

  // 1) Wenn SYMBOLS gesetzt -> nimm die
  const envSymbols = parseSymbolsFromEnv();

  // 2) Fallback: 300er Startuniversum
  const defaults = envSymbols.length ? envSymbols : [
    "AAPL","MSFT","NVDA","AVGO","ORCL","CRM","ADBE","NOW","INTU","IBM",
    "AMD","QCOM","TXN","AMAT","MU","KLAC","LRCX","PANW","CRWD","FTNT",
    "SNPS","CDNS","ANET","MSI","ADSK","ADI","NXPI","MCHP","ACN","UBER",
    "SHOP","SQ","DOCU","ZS","DDOG","NET","OKTA","HPE","HPQ","PLTR",

    "GOOGL","META","NFLX","DIS","T","VZ","TMUS","CMCSA","CHTR","WBD",
    "EA","RBLX","SPOT","SNAP","TTWO","ROKU","MTCH","FOXA","FOX","PINS",

    "AMZN","TSLA","HD","MCD","NKE","SBUX","BKNG","ABNB","LOW","TJX",
    "ROST","CMG","MAR","HLT","AZO","ORLY","DRI","YUM","DPZ","LULU",
    "GM","F","BBY","LEN","DHI","PHM","NVR","ULTA","LVS","EBAY",

    "WMT","COST","PG","KO","PEP","PM","MO","CL","KMB","GIS",
    "KHC","KR","SYY","DG","DLTR","EL","HSY","MNST","ADM","TSN",

    "LLY","JNJ","UNH","MRK","ABBV","PFE","ABT","BMY","TMO","DHR",
    "ISRG","SYK","MDT","GILD","AMGN","CVS","HCA","HUM","CI","COR",
    "MCK","CAH","REGN","VRTX","ZTS","IQV","EW","BSX","BDX","CNC",

    "JPM","BAC","WFC","GS","MS","C","SCHW","BLK","BX","SPGI",
    "ICE","CME","CB","PGR","AIG","ALL","MMC","AJG","TRV","USB",
    "PNC","TFC","COF","MCO","AXP","V","MA","DFS","KKR","APO",
    "BRO","FITB","MTB","RF","HBAN",

    "XOM","CVX","COP","EOG","SLB","MPC","PSX","VLO","OXY","KMI",
    "WMB","HES","DVN","FANG","EPD","ET","BKR","HAL","EQT","APA",

    "GE","CAT","DE","HON","RTX","LMT","NOC","GD","BA","ETN",
    "EMR","PH","UPS","FDX","WM","RSG","UNP","NSC","CSX","JBHT",
    "ODFL","LHX","TDG","PWR","JCI","CARR","OTIS","XYL","ITW","HWM",

    "LIN","APD","SHW","ECL","NUE","FCX","NEM","DOW","DD","ALB",
    "MLM","VMC","PPG","CE","CF",

    "NEE","SO","DUK","AEP","SRE","EXC","XEL","PEG","ED","EIX",
    "D","DOM","ES","WEC","ATO",

    "AMT","PLD","EQIX","CCI","O","PSA","SPG","DLR","WELL","VICI",
    "CBRE","AVB","EQR","INVH","EXR",

    "APP","AFRM","ARM","CELH","CAVA","DASH","DUOL","HUBS","MDB","MNDY",
    "ONON","RDDT","RIVN","SNOW","SOFI","TOST","UPST","VRT","DAY","COIN",
    "HOOD","GLW","COHR","SMCI","MP","RKLB","ASTS","BILL","APPF","ZM"
  ];

  let prio = 10;
  for (const sym of defaults) {
    await pool.query(
      `
      INSERT INTO watchlist_symbols(symbol, is_active, priority, region)
      VALUES ($1, TRUE, $2, 'us')
      ON CONFLICT(symbol) DO NOTHING
      `,
      [sym, prio]
    );
    prio += 10;
  }

  if (logger?.info) {
    logger.info("watchlist seeded", {
      count: defaults.length,
      usedEnv: envSymbols.length > 0
    });
  }
}

async function getActiveWatchlistSymbols(limit = 250) {
  const lim = Math.max(1, Math.min(Number(limit) || 250, 2000));

  const res = await pool.query(
    `
    SELECT symbol
    FROM watchlist_symbols
    WHERE is_active = TRUE
    ORDER BY priority ASC, symbol ASC
    LIMIT $1
    `,
    [lim]
  );

  return res.rows.map((r) => String(r.symbol).toUpperCase());
}

module.exports = {
  initWatchlistTable,
  seedDefaultWatchlist,
  getActiveWatchlistSymbols,
};
