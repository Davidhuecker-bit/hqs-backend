"use strict";

/*
  HQS PORTFOLIO ENGINE – LEVEL 5
  Multi-Factor Global Portfolio Intelligence
*/

const { getGlobalMarketData } = require("./aggregator.service");
const axios = require("axios");

const FMP_API_KEY = process.env.FMP_API_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/* =========================================================
   CORE FACTORS
========================================================= */

function calculateMomentumScore(stock) {
  let score = 50;

  if (stock.changesPercentage !== null) {
    if (stock.changesPercentage > 4) score += 18;
    else if (stock.changesPercentage > 2) score += 10;
    else if (stock.changesPercentage < -4) score -= 18;
    else if (stock.changesPercentage < -2) score -= 10;
  }

  if (stock.volume && stock.volume > 3_000_000) score += 5;

  return Math.max(0, Math.min(100, score));
}

function calculateVolatilityAdjustment(stock) {
  if (stock.high && stock.low && stock.price) {
    const range = (stock.high - stock.low) / stock.price;
    if (range > 0.08) return -10;
    if (range > 0.05) return -6;
  }
  return 0;
}

function calculateRegionScore(stocks) {
  const regions = new Set(stocks.map(s => s.region));
  return Math.min(100, regions.size * 30);
}

function calculateConcentrationPenalty(portfolio) {
  const totalWeight = portfolio.reduce((sum, p) => sum + p.weight, 0);
  const regionWeights = {};

  for (const p of portfolio) {
    regionWeights[p.region] = (regionWeights[p.region] || 0) + p.weight;
  }

  const maxWeight = Math.max(...Object.values(regionWeights));
  const ratio = maxWeight / totalWeight;

  if (ratio > 0.75) return -30;
  if (ratio > 0.6) return -18;
  if (ratio > 0.5) return -10;

  return 0;
}

/* =========================================================
   INSIDER SIGNAL
========================================================= */

async function fetchInsiderSignal(symbol) {
  try {
    const url = `https://financialmodelingprep.com/api/v4/insider-trading?symbol=${symbol}&apikey=${FMP_API_KEY}`;
    const res = await axios.get(url, { timeout: 5000 });

    const trades = res.data;
    if (!Array.isArray(trades)) return 0;

    let buy = 0;
    let sell = 0;

    for (const t of trades.slice(0, 10)) {
      if (t.transactionType === "P-Purchase")
        buy += Number(t.securitiesTransacted) || 0;
      if (t.transactionType === "S-Sale")
        sell += Number(t.securitiesTransacted) || 0;
    }

    if (buy > sell * 1.2) return 8;
    if (sell > buy * 1.2) return -8;

    return 0;
  } catch {
    return 0;
  }
}

/* =========================================================
   SOCIAL MOMENTUM (Reddit via Finnhub)
========================================================= */

async function fetchSocialMomentum(symbol) {
  if (!FINNHUB_API_KEY) return 0;

  try {
    const url = `https://finnhub.io/api/v1/stock/social-sentiment?symbol=${symbol}&token=${FINNHUB_API_KEY}`;
    const res = await axios.get(url, { timeout: 5000 });

    const reddit = res.data?.reddit || [];
    if (!Array.isArray(reddit) || reddit.length === 0) return 0;

    const total = reddit.reduce((sum, r) => sum + (r.mention || 0), 0);
    const positive = reddit.reduce((sum, r) => sum + (r.positiveMention || 0), 0);
    const negative = reddit.reduce((sum, r) => sum + (r.negativeMention || 0), 0);

    if (!total) return 0;

    const sentiment = (positive - negative) / total;

    if (sentiment > 0.2) return 6;
    if (sentiment < -0.2) return -6;

    return 0;
  } catch {
    return 0;
  }
}

/* =========================================================
   BETA / INDEX KORRELATION
========================================================= */

async function fetchBeta(symbol) {
  try {
    const url = `https://financialmodelingprep.com/api/v3/profile/${symbol}?apikey=${FMP_API_KEY}`;
    const res = await axios.get(url, { timeout: 5000 });

    const beta = Number(res.data?.[0]?.beta);
    if (!beta) return 0;

    if (beta > 1.5) return -6;
    if (beta < 0.8) return 4;

    return 0;
  } catch {
    return 0;
  }
}

/* =========================================================
   SECTOR CYCLE LOGIC
========================================================= */

function calculateSectorCycleAdjustment(stock, marketPhase) {
  if (!stock.exchange) return 0;

  // Beispielhafte Logik
  if (marketPhase === "risk_off") {
    if (stock.exchange.includes("ETF")) return 4;
    return -3;
  }

  if (marketPhase === "risk_on") {
    return 3;
  }

  return 0;
}

/* =========================================================
   MARKET PHASE
========================================================= */

async function getMarketPhase() {
  try {
    const res = await axios.get("https://api.alternative.me/fng/?limit=1", { timeout: 4000 });
    const value = Number(res.data?.data?.[0]?.value);

    if (value >= 65) return { phase: "risk_on", value };
    if (value <= 35) return { phase: "risk_off", value };

    return { phase: "neutral", value };
  } catch {
    return { phase: "neutral", value: null };
  }
}

/* =========================================================
   AI INTERPRETATION LAYER
========================================================= */

async function generateAIInterpretation(result) {
  if (!OPENAI_API_KEY) return null;

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are a professional portfolio analyst."
          },
          {
            role: "user",
            content: `Interpret this portfolio result briefly:\n${JSON.stringify(result)}`
          }
        ],
        max_tokens: 200
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    return response.data?.choices?.[0]?.message?.content || null;
  } catch {
    return null;
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

  const marketPhaseData = await getMarketPhase();

  const enriched = [];

  for (const stock of marketData) {
    const position = portfolio.find(p => p.symbol === stock.symbol);

    const insider = await fetchInsiderSignal(stock.symbol);
    const social = await fetchSocialMomentum(stock.symbol);
    const betaAdj = await fetchBeta(stock.symbol);

    enriched.push({
      ...stock,
      weight: position?.weight || 1,
      insider,
      social,
      betaAdj
    });
  }

  const totalWeight = enriched.reduce((sum, p) => sum + p.weight, 0);

  let scoreSum = 0;

  const breakdown = enriched.map(stock => {
    const momentum = calculateMomentumScore(stock);
    const volatility = calculateVolatilityAdjustment(stock);
    const sectorAdj = calculateSectorCycleAdjustment(stock, marketPhaseData.phase);

    const combined =
      momentum +
      volatility +
      stock.insider +
      stock.social +
      stock.betaAdj +
      sectorAdj;

    scoreSum += combined * (stock.weight / totalWeight);

    return {
      symbol: stock.symbol,
      region: stock.region,
      momentum,
      volatility,
      insider: stock.insider,
      social: stock.social,
      beta: stock.betaAdj,
      sector: sectorAdj
    };
  });

  const regionScore = calculateRegionScore(enriched);
  const concentrationPenalty = calculateConcentrationPenalty(enriched);

  let phaseAdjustment = 0;
  if (marketPhaseData.phase === "risk_off") phaseAdjustment = -12;
  if (marketPhaseData.phase === "risk_on") phaseAdjustment = 6;

  const finalScore = Math.round(
    Math.max(
      0,
      Math.min(
        100,
        scoreSum * 0.6 +
          regionScore * 0.2 +
          50 * 0.2 +
          concentrationPenalty +
          phaseAdjustment
      )
    )
  );

  const result = {
    finalScore,
    marketPhase: marketPhaseData.phase,
    fearGreedValue: marketPhaseData.value,
    regionScore,
    concentrationPenalty,
    breakdown
  };

  const aiCommentary = await generateAIInterpretation(result);

  return {
    ...result,
    aiCommentary
  };
}

module.exports = {
  calculatePortfolioHQS
};
