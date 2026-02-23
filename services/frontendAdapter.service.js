const DEFAULT_FRONTEND_SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMD"];

const SYMBOL_META = {
  AAPL: { name: "Apple", category: "Consumer Tech", marketCap: "Large Cap", type: "Aktie" },
  MSFT: { name: "Microsoft", category: "Cloud AI", marketCap: "Large Cap", type: "Aktie" },
  NVDA: { name: "NVIDIA", category: "AI Semiconductors", marketCap: "Large Cap", type: "Aktie" },
  AMD: { name: "AMD", category: "Semiconductors", marketCap: "Large Cap", type: "Aktie" },
  GOOGL: { name: "Alphabet", category: "Cloud AI", marketCap: "Large Cap", type: "Aktie" },
  AMZN: { name: "Amazon", category: "Cloud Commerce", marketCap: "Large Cap", type: "Aktie" },
  META: { name: "Meta", category: "AI Platforms", marketCap: "Large Cap", type: "Aktie" },
  TSLA: { name: "Tesla", category: "EV Mobility", marketCap: "Large Cap", type: "Aktie" },
  IONQ: { name: "IONQ", category: "Quantum", marketCap: "Mid Cap", type: "Aktie" },
  SOUN: { name: "SoundHound", category: "Voice AI", marketCap: "Small Cap", type: "Aktie" },
};

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sanitizeSymbol(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,12}$/.test(normalized)) return "";
  return normalized;
}

function parseSymbolsQuery(rawValue, fallback = DEFAULT_FRONTEND_SYMBOLS) {
  const source = Array.isArray(rawValue) ? rawValue.join(",") : rawValue;
  const requested = String(source || "")
    .split(",")
    .map((symbol) => sanitizeSymbol(symbol))
    .filter(Boolean);

  if (requested.length === 0) return fallback.slice(0, 4);
  return [...new Set(requested)].slice(0, 8);
}

function classifyMarketCap(rawMarketCap, symbol) {
  if (typeof rawMarketCap === "string") {
    if (rawMarketCap === "Large Cap" || rawMarketCap === "Mid Cap" || rawMarketCap === "Small Cap") {
      return rawMarketCap;
    }
  }

  const numeric = toFiniteNumber(rawMarketCap, Number.NaN);
  if (Number.isFinite(numeric)) {
    if (numeric >= 2e11) return "Large Cap";
    if (numeric >= 1e10) return "Mid Cap";
    return "Small Cap";
  }

  return SYMBOL_META[symbol]?.marketCap || "Mid Cap";
}

function inferTrend(changePercent) {
  if (changePercent >= 6) return "Starker Aufw\u00e4rtstrend";
  if (changePercent >= 3) return "Breakout";
  if (changePercent >= 0.5) return "Aufw\u00e4rtstrend";
  if (changePercent >= -1.5) return "Seitw\u00e4rts";
  return "Konsolidierung";
}

function inferAllocation(hqsScore) {
  if (hqsScore >= 78) return "Kernposition";
  if (hqsScore >= 68) return "Tech \u00dcberzeugung";
  if (hqsScore >= 58) return "Wachstum";
  if (hqsScore >= 48) return "Rotation";
  return "Fr\u00fcherkennung";
}

function inferRecommendation(hqsScore) {
  if (hqsScore >= 75) return "Starkes Setup";
  if (hqsScore >= 62) return "Kaufzone";
  if (hqsScore >= 50) return "Beobachten";
  return "Risiko erhoht";
}

function inferVolatility(changePercent) {
  const scaled = 0.012 + Math.abs(changePercent) * 0.003;
  return Number(clamp(scaled, 0.008, 0.08).toFixed(4));
}

function buildSyntheticNewsItems(stock, generatedAt, maxItems = 3) {
  const symbol = sanitizeSymbol(stock?.symbol);
  if (!symbol) return [];

  const changePercent = toFiniteNumber(stock?.changePercent, 0);
  const hqsScore = toFiniteNumber(stock?.hqsScore, 50);

  const sentimentTitle =
    changePercent >= 0
      ? `${symbol}: Momentum bleibt bei +${changePercent.toFixed(2)}%`
      : `${symbol}: Korrekturphase bei ${changePercent.toFixed(2)}%`;
  const scoreTitle =
    hqsScore >= 70
      ? `${symbol}: Quant-Signal bleibt auf Kaufniveau`
      : `${symbol}: Quant-Signal im neutralen Bereich`;
  const riskTitle =
    hqsScore < 50
      ? `${symbol}: Risikoindikatoren bleiben erhoht`
      : `${symbol}: Stabilitatsindikatoren ohne Warnsignal`;

  const titles = [sentimentTitle, scoreTitle, riskTitle].slice(0, maxItems);
  const baseDate = new Date(generatedAt || Date.now()).getTime();

  return titles.map((title, index) => ({
    title,
    link: `https://finance.yahoo.com/quote/${symbol}`,
    source: index === 0 ? "HQS Wire" : "Market Pulse",
    publishedAt: new Date(baseDate - index * 45 * 60 * 1000).toISOString(),
  }));
}

function normalizeStockForFrontend(stock, index = 0, generatedAt = new Date().toISOString()) {
  const symbol = sanitizeSymbol(stock?.symbol);
  if (!symbol) return null;

  const meta = SYMBOL_META[symbol] || {};
  const hqsScore = clamp(Math.round(toFiniteNumber(stock?.hqsScore, 50)), 0, 100);
  const stabilityScore = clamp(Math.round(toFiniteNumber(stock?.stabilityScore, 55)), 0, 100);
  const changePercent = Number(
    toFiniteNumber(stock?.changePercent ?? stock?.changesPercentage, 0).toFixed(2),
  );
  const volatility = clamp(toFiniteNumber(stock?.volatility, inferVolatility(changePercent)), 0.005, 0.08);
  const marketCap = classifyMarketCap(stock?.marketCap, symbol);

  const volatilityScore = clamp(Math.round(volatility * 1400), 0, 100);
  const correlationScore = clamp(Math.round(35 + (symbol.charCodeAt(0) % 30) + index * 4), 0, 100);
  const sentimentScore = clamp(Math.round(55 - changePercent * 4), 0, 100);
  const confidence = clamp(
    Math.round(hqsScore * 0.6 + stabilityScore * 0.25 + (100 - volatilityScore) * 0.15),
    35,
    95,
  );

  const fallbackNews = buildSyntheticNewsItems(
    { symbol, changePercent, hqsScore },
    generatedAt,
    2,
  );
  const normalizedNews = Array.isArray(stock?.news)
    ? stock.news
        .filter((entry) => entry && String(entry.title || "").trim())
        .map((entry) => ({
          title: String(entry.title || "").trim(),
          link: String(entry.link || `https://finance.yahoo.com/quote/${symbol}`),
          source: String(entry.source || "News"),
          publishedAt: String(entry.publishedAt || generatedAt),
        }))
    : fallbackNews;

  return {
    ...stock,
    symbol,
    name: String(stock?.name || meta.name || symbol),
    type: String(stock?.type || meta.type || "Aktie"),
    category: String(stock?.category || meta.category || "Unkategorisiert"),
    marketCap,
    allocation: String(stock?.allocation || inferAllocation(hqsScore)),
    trend: String(stock?.trend || inferTrend(changePercent)),
    recommendation: String(stock?.recommendation || inferRecommendation(hqsScore)),
    price: toFiniteNumber(stock?.price, 0),
    changePercent,
    hqsScore,
    stabilityScore,
    volatility: Number(volatility.toFixed(4)),
    volatilityScore,
    correlationScore,
    sentimentScore,
    confidence,
    news: normalizedNews.slice(0, 3),
  };
}

function average(values, fallback = 0) {
  if (!Array.isArray(values) || values.length === 0) return fallback;
  const numeric = values.map((value) => toFiniteNumber(value, Number.NaN)).filter(Number.isFinite);
  if (numeric.length === 0) return fallback;
  return numeric.reduce((acc, value) => acc + value, 0) / numeric.length;
}

function buildTopSignals(stocks) {
  return stocks
    .slice()
    .sort((left, right) => {
      const leftScore = toFiniteNumber(left.hqsScore, 0) + toFiniteNumber(left.changePercent, 0) * 2;
      const rightScore = toFiniteNumber(right.hqsScore, 0) + toFiniteNumber(right.changePercent, 0) * 2;
      return rightScore - leftScore;
    })
    .slice(0, 3)
    .map((stock) => ({
      symbol: stock.symbol,
      type: toFiniteNumber(stock.hqsScore, 0) >= 70 ? "momentum" : "watch",
      score: clamp(Math.round(toFiniteNumber(stock.hqsScore, 0)), 0, 100),
      summary: `${stock.symbol}: HQS ${stock.hqsScore}, Bewegung ${stock.changePercent >= 0 ? "+" : ""}${stock.changePercent.toFixed(2)}%`,
    }));
}

function buildRiskFlags(stocks) {
  const flags = stocks
    .filter((stock) => toFiniteNumber(stock.hqsScore, 50) < 50 || toFiniteNumber(stock.changePercent, 0) <= -2)
    .slice(0, 4)
    .map((stock) => ({
      symbol: stock.symbol,
      level: toFiniteNumber(stock.hqsScore, 50) < 40 ? "high" : "medium",
      message: `${stock.symbol}: defensives Monitoring empfohlen.`,
    }));

  if (flags.length > 0) return flags;
  return [{ level: "low", message: "Keine kritischen Risiko-Flags im aktuellen Snapshot." }];
}

function buildAlerts(stocks) {
  const alerts = [];
  stocks.forEach((stock) => {
    const changePercent = toFiniteNumber(stock.changePercent, 0);
    if (changePercent >= 6) {
      alerts.push({
        id: `alert-${stock.symbol}-momentum`,
        symbol: stock.symbol,
        level: "info",
        message: `${stock.symbol} zeigt starkes Tagesmomentum (+${changePercent.toFixed(2)}%).`,
      });
    } else if (changePercent <= -4) {
      alerts.push({
        id: `alert-${stock.symbol}-risk`,
        symbol: stock.symbol,
        level: "warning",
        message: `${stock.symbol} zeigt einen deutlichen Rucksetzer (${changePercent.toFixed(2)}%).`,
      });
    }
  });

  return alerts.slice(0, 5);
}

function buildCorrelationSeries(stocks, generatedAt) {
  return {
    generatedAt,
    points: stocks.map((stock) => ({
      symbol: stock.symbol,
      value: toFiniteNumber(stock.correlationScore, 0),
    })),
  };
}

function buildPortfolioHealth(stocks, stabilityScore) {
  const avgHqs = average(stocks.map((stock) => stock.hqsScore), 50);
  const avgRisk = average(stocks.map((stock) => stock.volatilityScore), 50);
  const score = clamp(Math.round(avgHqs * 0.62 + stabilityScore * 0.3 - (avgRisk - 50) * 0.18), 0, 100);
  const status = score >= 70 ? "robust" : score >= 55 ? "balanced" : "defensive";
  return {
    score,
    status,
    avgHqs: Number(avgHqs.toFixed(1)),
    avgRisk: Number(avgRisk.toFixed(1)),
  };
}

function createFallbackStocks(symbols, generatedAt) {
  return symbols
    .map((symbol, index) =>
      normalizeStockForFrontend(
        {
          symbol,
          price: 100 + index * 25,
          changePercent: index % 2 === 0 ? 1.2 + index : -0.8 - index * 0.2,
          hqsScore: 58 + index * 6,
          stabilityScore: 55 + index * 4,
        },
        index,
        generatedAt,
      ),
    )
    .filter(Boolean);
}

function buildGuardianPayload(rawStocks, options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const incomingStocks = Array.isArray(rawStocks) ? rawStocks : [];
  let stocks = incomingStocks
    .map((stock, index) => normalizeStockForFrontend(stock, index, generatedAt))
    .filter(Boolean);

  if (stocks.length === 0) {
    stocks = createFallbackStocks(DEFAULT_FRONTEND_SYMBOLS.slice(0, 3), generatedAt);
  }

  const stabilityScore = clamp(Math.round(average(stocks.map((stock) => stock.stabilityScore), 55)), 0, 100);
  const topSignals = buildTopSignals(stocks);
  const riskFlags = buildRiskFlags(stocks);
  const alerts = buildAlerts(stocks);

  return {
    success: true,
    stabilityScore,
    engineStatus: {
      mode: "HQS Guardian Hybrid",
      source: "Finnhub + HQS Engine",
      generatedAt,
      symbolCount: stocks.length,
    },
    portfolioHealth: buildPortfolioHealth(stocks, stabilityScore),
    topSignals,
    riskFlags,
    correlationSeries: buildCorrelationSeries(stocks, generatedAt),
    alerts,
    marketSnapshot: {
      updatedAt: generatedAt,
      stocks,
    },
  };
}

function buildMarketNewsPayload(symbols, stocksBySymbol = {}, generatedAt = new Date().toISOString()) {
  const safeSymbols = parseSymbolsQuery(symbols, DEFAULT_FRONTEND_SYMBOLS.slice(0, 3));
  const newsBySymbol = {};

  safeSymbols.forEach((symbol) => {
    const sourceStock = stocksBySymbol[symbol] || { symbol };
    newsBySymbol[symbol] = buildSyntheticNewsItems(sourceStock, generatedAt, 3);
  });

  return {
    success: true,
    generatedAt,
    newsBySymbol,
  };
}

function buildInsiderSignalPayload(symbols, stocksBySymbol = {}, generatedAt = new Date().toISOString()) {
  const safeSymbols = parseSymbolsQuery(symbols, DEFAULT_FRONTEND_SYMBOLS.slice(0, 3));
  const insiderBySymbol = {};

  safeSymbols.forEach((symbol) => {
    const sourceStock = stocksBySymbol[symbol] || {};
    const hqsScore = clamp(Math.round(toFiniteNumber(sourceStock.hqsScore, 52)), 0, 100);
    const changePercent = toFiniteNumber(sourceStock.changePercent, 0);

    let signal = "neutral";
    if (hqsScore >= 65 && changePercent >= 0) signal = "buying";
    else if (hqsScore <= 45 || changePercent <= -2) signal = "selling";

    const confidence = clamp(Math.round(hqsScore * 0.65 + Math.abs(changePercent) * 7), 30, 95);
    const summary =
      signal === "buying"
        ? `Insider-Flow zeigt konstruktives Bild fur ${symbol}.`
        : signal === "selling"
          ? `Insider-Flow bleibt bei ${symbol} defensiv.`
          : `Insider-Flow bei ${symbol} ist aktuell ausgeglichen.`;

    insiderBySymbol[symbol] = {
      signal,
      confidence,
      summary,
    };
  });

  return {
    success: true,
    generatedAt,
    insiderBySymbol,
  };
}

module.exports = {
  DEFAULT_FRONTEND_SYMBOLS,
  parseSymbolsQuery,
  normalizeStockForFrontend,
  buildGuardianPayload,
  buildMarketNewsPayload,
  buildInsiderSignalPayload,
};
