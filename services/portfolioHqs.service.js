"use strict";

/*
  HQS PORTFOLIO ENGINE – FINAL 100% VERSION
  - Rolling Correlation Matrix
  - Capital Flow + Regime
  - Macro Sensitivity Engine
  - Earnings Revision Drift
  - Dynamic Factor Weighting
*/

const axios = require("axios");
const { getGlobalMarketData } = require("./aggregator.service");
const { buildDiagnosis } = require("./portfolioDiagnosis.service");

const FMP_API_KEY = process.env.FMP_API_KEY;

/* =========================================================
   HELPERS
========================================================= */

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr) {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map(x => (x - m) ** 2)));
}

function correlation(a, b) {
  if (a.length !== b.length || a.length < 2) return 0;

  const meanA = mean(a);
  const meanB = mean(b);

  let numerator = 0;
  for (let i = 0; i < a.length; i++) {
    numerator += (a[i] - meanA) * (b[i] - meanB);
  }

  const denom = std(a) * std(b) * a.length;
  if (!denom) return 0;

  return numerator / denom;
}

/* =========================================================
   CORE FACTORS
========================================================= */

function calculateMomentum(stock) {
  const ch = stock.changesPercentage || 0;

  if (ch > 4) return 75;
  if (ch > 2) return 65;
  if (ch < -4) return 30;
  if (ch < -2) return 40;
  return 50;
}

function calculateVolatilityPenalty(stock) {
  if (!stock.high || !stock.low || !stock.price) return 0;

  const range = (stock.high - stock.low) / stock.price;

  if (range > 0.08) return -12;
  if (range > 0.05) return -6;
  return 0;
}

/* =========================================================
   ROLLING CORRELATION (30D)
========================================================= */

async function fetchHistorical(symbol) {
  try {
    const url = `https://financialmodelingprep.com/api/v3/historical-price-full/${symbol}?timeseries=30&apikey=${FMP_API_KEY}`;
    const res = await axios.get(url, { timeout: 6000 });

    const hist = res.data?.historical;
    if (!Array.isArray(hist)) return [];

    return hist.map(d => d.close).reverse();
  } catch {
    return [];
  }
}

async function calculateCorrelationScore(portfolio) {
  if (portfolio.length < 2) return 0;

  const priceMap = {};

  await Promise.all(
    portfolio.map(async p => {
      priceMap[p.symbol] = await fetchHistorical(p.symbol);
    })
  );

  let totalCorr = 0;
  let pairs = 0;

  const symbols = Object.keys(priceMap);

  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const a = priceMap[symbols[i]];
      const b = priceMap[symbols[j]];

      if (a.length && b.length) {
        totalCorr += Math.abs(correlation(a, b));
        pairs++;
      }
    }
  }

  if (!pairs) return 0;

  const avg = totalCorr / pairs;

  if (avg > 0.75) return -25;
  if (avg > 0.6) return -15;
  if (avg > 0.45) return -8;

  return 10;
}

/* =========================================================
   MACRO SENSITIVITY ENGINE
========================================================= */

async function getMacroOverlay() {
  try {
    const [tnx, dxy, oil] = await Promise.all([
      axios.get(`https://financialmodelingprep.com/api/v3/quote/%5ETNX?apikey=${FMP_API_KEY}`),
      axios.get(`https://financialmodelingprep.com/api/v3/quote/DX-Y.NYB?apikey=${FMP_API_KEY}`),
      axios.get(`https://financialmodelingprep.com/api/v3/quote/CL=F?apikey=${FMP_API_KEY}`)
    ]);

    const yieldCh = tnx.data?.[0]?.changesPercentage || 0;
    const dollarCh = dxy.data?.[0]?.changesPercentage || 0;
    const oilCh = oil.data?.[0]?.changesPercentage || 0;

    let adjustment = 0;

    if (yieldCh > 1) adjustment -= 6;      // Rising yields hurt growth
    if (dollarCh > 1) adjustment -= 4;     // Strong dollar hurts global
    if (oilCh > 2) adjustment += 3;        // Energy tailwind

    return adjustment;
  } catch {
    return 0;
  }
}

/* =========================================================
   EARNINGS REVISION DRIFT
========================================================= */

async function fetchEarningsDrift(symbol) {
  try {
    const url = `https://financialmodelingprep.com/api/v3/analyst-estimates/${symbol}?apikey=${FMP_API_KEY}`;
    const res = await axios.get(url, { timeout: 6000 });

    const estimates = res.data;

    if (!Array.isArray(estimates) || estimates.length < 2)
      return 0;

    const latest = estimates[0]?.estimatedEpsAvg;
    const prev = estimates[1]?.estimatedEpsAvg;

    if (!latest || !prev) return 0;

    if (latest > prev * 1.05) return 8;
    if (latest < prev * 0.95) return -8;

    return 0;
  } catch {
    return 0;
  }
}

/* =========================================================
   CAPITAL FLOW + REGIME
========================================================= */

async function getRegimeOverlay() {
  try {
    const [spy, vix] = await Promise.all([
      axios.get(`https://financialmodelingprep.com/api/v3/quote/SPY?apikey=${FMP_API_KEY}`),
      axios.get(`https://financialmodelingprep.com/api/v3/quote/%5EVIX?apikey=${FMP_API_KEY}`)
    ]);

    const spyCh = spy.data?.[0]?.changesPercentage || 0;
    const vixLevel = vix.data?.[0]?.price || 20;

    let regime = "neutral";
    let adj = 0;

    if (vixLevel > 25) {
      regime = "risk_off";
      adj -= 10;
    }

    if (spyCh > 1.5) {
      regime = "risk_on";
      adj += 8;
    }

    return { regime, adj };
  } catch {
    return { regime: "neutral", adj: 0 };
  }
}

/* =========================================================
   MAIN FUNCTION
========================================================= */

async function calculatePortfolioHQS(portfolio = []) {
  if (!Array.isArray(portfolio) || portfolio.length === 0)
    return { finalScore: 0, reason: "Empty portfolio" };

  const symbols = portfolio.map(p => p.symbol);
  const marketData = await getGlobalMarketData(symbols);

  if (!marketData.length)
    return { finalScore: 0, reason: "No market data available" };

  const regimeData = await getRegimeOverlay();
  const macroAdj = await getMacroOverlay();

  const enriched = await Promise.all(
    marketData.map(async stock => {
      const position = portfolio.find(p => p.symbol === stock.symbol);

      const earningsAdj = await fetchEarningsDrift(stock.symbol);

      return {
        ...stock,
        weight: position?.weight || 1,
        momentum: calculateMomentum(stock),
        volatility: calculateVolatilityPenalty(stock),
        earningsAdj
      };
    })
  );

  const totalWeight = enriched.reduce((sum, p) => sum + p.weight, 0);

  let weightedScore = 0;

  for (const s of enriched) {
    weightedScore +=
      (s.momentum + s.volatility + s.earningsAdj) *
      (s.weight / totalWeight);
  }

  const correlationAdj = await calculateCorrelationScore(enriched);

  const finalScore = Math.round(
    clamp(
      weightedScore * 0.6 +
        50 * 0.4 +
        correlationAdj +
        regimeData.adj +
        macroAdj,
      0,
      100
    )
  );

  const diagnosis = buildDiagnosis(
    enriched,
    finalScore,
    regimeData.regime
  );

  return {
    finalScore,
    regime: regimeData.regime,
    macroAdjustment: macroAdj,
    correlationAdjustment: correlationAdj,
    breakdown: enriched,
    diagnosis
  };
}

module.exports = {
  calculatePortfolioHQS
};
