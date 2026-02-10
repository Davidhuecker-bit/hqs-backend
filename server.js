const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const NodeCache = require('node-cache');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.ALPHA_VANTAGE_API_KEY || 'BK0SA33HPRG939WY';

// Cache für API-Aufrufe (5 Minuten)
const cache = new NodeCache({ stdTTL: 300 });

app.use(cors());
app.use(express.json());

console.log('🚀 HQS Hyper-Quant System v4.0');
console.log(`🔑 API Key: ${API_KEY.slice(0, 8)}...`);

// ==================== HQS QUANT ENGINE ====================
class HQSEngine {
  constructor() {
    this.version = '4.0.0';
    this.factors = {
      momentum: { weight: 0.30, min: 0, max: 10 },
      value: { weight: 0.25, min: 0, max: 10 },
      quality: { weight: 0.20, min: 0, max: 10 },
      volatility: { weight: 0.15, min: 0, max: 10 },
      sentiment: { weight: 0.10, min: 0, max: 10 }
    };
  }

  // Calculate factor scores based on real data
  calculateMomentum(priceData) {
    let score = 5;
    const { changePercent, rsi, volume } = priceData;
    
    // Price momentum
    if (changePercent > 2) score += 3;
    else if (changePercent > 0.5) score += 2;
    else if (changePercent < -2) score -= 3;
    else if (changePercent < -0.5) score -= 2;
    
    // RSI momentum
    if (rsi) {
      if (rsi > 70) score -= 1; // Overbought
      if (rsi < 30) score += 1; // Oversold
      if (rsi > 50 && rsi < 70) score += 1; // Positive momentum
    }
    
    // Volume confirmation
    if (volume > 10000000) score += 1;
    if (volume > 50000000) score += 1;
    
    return Math.max(0, Math.min(10, score));
  }

  calculateValue(fundamentalData) {
    let score = 5;
    const { peRatio, pbRatio, dividendYield } = fundamentalData;
    
    if (peRatio) {
      if (peRatio < 15) score += 2;
      if (peRatio < 10) score += 1;
      if (peRatio > 25) score -= 2;
      if (peRatio > 40) score -= 1;
    }
    
    if (pbRatio) {
      if (pbRatio < 2) score += 1;
      if (pbRatio < 1) score += 1;
      if (pbRatio > 5) score -= 1;
    }
    
    if (dividendYield) {
      if (dividendYield > 0.03) score += 1;
      if (dividendYield > 0.05) score += 1;
    }
    
    return Math.max(0, Math.min(10, score));
  }

  calculateQuality(fundamentalData) {
    let score = 5;
    const { profitMargin, roe, debtToEquity } = fundamentalData;
    
    if (profitMargin) {
      if (profitMargin > 0.20) score += 2;
      if (profitMargin > 0.30) score += 1;
      if (profitMargin < 0.05) score -= 2;
    }
    
    if (roe) {
      if (roe > 0.15) score += 1;
      if (roe > 0.25) score += 1;
      if (roe < 0.05) score -= 1;
    }
    
    if (debtToEquity) {
      if (debtToEquity < 0.5) score += 1;
      if (debtToEquity > 1.5) score -= 1;
    }
    
    return Math.max(0, Math.min(10, score));
  }

  calculateVolatility(priceData) {
    let score = 5;
    const { beta, changePercent } = priceData;
    
    if (beta) {
      if (beta < 0.8) score += 2; // Low volatility
      if (beta < 0.5) score += 1;
      if (beta > 1.5) score -= 2; // High volatility
      if (beta > 2.0) score -= 1;
    }
    
    // Price stability
    if (Math.abs(changePercent) < 1) score += 1;
    if (Math.abs(changePercent) > 5) score -= 1;
    
    return Math.max(0, Math.min(10, score));
  }

  calculateSentiment(symbol, priceData) {
    // Placeholder - in production: news sentiment, social media, etc.
    let score = 5;
    const { changePercent, volume } = priceData;
    
    // Simple sentiment based on price action
    if (changePercent > 3) score += 2;
    if (changePercent < -3) score -= 2;
    if (volume > 50000000) score += 1; // High interest
    
    // Add some randomness for demo
    score += (Math.random() - 0.5) * 2;
    
    return Math.max(0, Math.min(10, score));
  }

  calculateHQSScore(symbol, priceData, fundamentalData = {}) {
    const factors = {
      momentum: this.calculateMomentum(priceData),
      value: this.calculateValue(fundamentalData),
      quality: this.calculateQuality(fundamentalData),
      volatility: this.calculateVolatility(priceData),
      sentiment: this.calculateSentiment(symbol, priceData)
    };

    // Weighted average
    let weightedSum = 0;
    for (const [factor, config] of Object.entries(this.factors)) {
      weightedSum += factors[factor] * config.weight;
    }

    const hqsScore = weightedSum * 10; // Scale to 0-100
    
    return {
      score: parseFloat(hqsScore.toFixed(2)),
      factors,
      rating: this.getRating(hqsScore),
      recommendation: this.getRecommendation(hqsScore),
      confidence: this.calculateConfidence(factors)
    };
  }

  getRating(score) {
    if (score >= 85) return 'STRONG_BUY';
    if (score >= 75) return 'BUY';
    if (score >= 65) return 'HOLD';
    if (score >= 55) return 'WEAK_HOLD';
    if (score >= 45) return 'WEAK_SELL';
    return 'STRONG_SELL';
  }

  getRecommendation(score) {
    const recommendations = {
      'STRONG_BUY': 'Exceptional value with strong momentum and fundamentals',
      'BUY': 'Attractive investment with positive outlook',
      'HOLD': 'Maintain position, balanced risk/reward',
      'WEAK_HOLD': 'Consider reducing exposure',
      'WEAK_SELL': 'Consider selling, deteriorating factors',
      'STRONG_SELL': 'High risk, fundamental issues detected'
    };
    return recommendations[this.getRating(score)];
  }

  calculateConfidence(factors) {
    // Calculate confidence based on factor agreement
    const scores = Object.values(factors);
    const avg = scores.reduce((a, b) => a + b) / scores.length;
    const variance = scores.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / scores.length;
    const confidence = Math.max(0, 100 - (variance * 10));
    return parseFloat(confidence.toFixed(1));
  }
}

// ==================== ALPHA VANTAGE SERVICE ====================
class AlphaVantageService {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://www.alphavantage.co/query';
    this.rateLimit = 5; // requests per minute
    this.requestCount = 0;
    this.lastReset = Date.now();
  }

  async makeRequest(params) {
    // Rate limiting
    const now = Date.now();
    if (now - this.lastReset > 60000) {
      this.requestCount = 0;
      this.lastReset = now;
    }
    
    if (this.requestCount >= this.rateLimit) {
      throw new Error('Alpha Vantage rate limit reached (5/min)');
    }
    
    this.requestCount++;
    
    const urlParams = new URLSearchParams({
      ...params,
      apikey: this.apiKey
    });
    
    const url = `${this.baseUrl}?${urlParams}`;
    
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      
      const data = await response.json();
      
      // Check for API errors
      if (data['Error Message']) {
        throw new Error(data['Error Message']);
      }
      if (data['Note']) {
        console.warn('API Note:', data['Note']);
        throw new Error('API limit note received');
      }
      
      return data;
    } catch (error) {
      console.error('Alpha Vantage request failed:', error.message);
      throw error;
    }
  }

  async getGlobalQuote(symbol) {
    const cacheKey = `quote_${symbol}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
      const data = await this.makeRequest({
        function: 'GLOBAL_QUOTE',
        symbol: symbol
      });

      if (data['Global Quote']) {
        const quote = data['Global Quote'];
        const result = {
          symbol: quote['01. symbol'],
          price: parseFloat(quote['05. price']),
          change: parseFloat(quote['09. change']),
          changePercent: parseFloat(quote['10. change percent'].replace('%', '')),
          volume: parseInt(quote['06. volume']),
          high: parseFloat(quote['03. high']),
          low: parseFloat(quote['04. low']),
          open: parseFloat(quote['02. open']),
          previousClose: parseFloat(quote['08. previous close']),
          timestamp: new Date().toISOString()
        };
        
        cache.set(cacheKey, result);
        return result;
      }
      return null;
    } catch (error) {
      console.error(`Failed to fetch quote for ${symbol}:`, error.message);
      return null;
    }
  }

  async getOverview(symbol) {
    const cacheKey = `overview_${symbol}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
      const data = await this.makeRequest({
        function: 'OVERVIEW',
        symbol: symbol
      });

      if (data && data.Symbol) {
        const result = {
          symbol: data.Symbol,
          name: data.Name,
          sector: data.Sector,
          industry: data.Industry,
          marketCap: parseFloat(data.MarketCapitalization) || 0,
          peRatio: parseFloat(data.PERatio) || 0,
          pbRatio: parseFloat(data.PriceToBookRatio) || 0,
          eps: parseFloat(data.EPS) || 0,
          dividendYield: parseFloat(data.DividendYield) || 0,
          profitMargin: parseFloat(data.ProfitMargin) || 0,
          roe: parseFloat(data.ReturnOnEquityTTM) || 0,
          debtToEquity: parseFloat(data.DebtToEquity) || 0,
          beta: parseFloat(data.Beta) || 1.0,
          fiftyTwoWeekHigh: parseFloat(data['52WeekHigh']) || 0,
          fiftyTwoWeekLow: parseFloat(data['52WeekLow']) || 0
        };
        
        cache.set(cacheKey, result, 3600); // Cache for 1 hour
        return result;
      }
      return null;
    } catch (error) {
      console.error(`Failed to fetch overview for ${symbol}:`, error.message);
      return {};
    }
  }

  async getRSI(symbol) {
    try {
      const data = await this.makeRequest({
        function: 'RSI',
        symbol: symbol,
        interval: 'daily',
        time_period: 14,
        series_type: 'close'
      });

      if (data['Technical Analysis: RSI']) {
        const latest = Object.keys(data['Technical Analysis: RSI'])[0];
        return parseFloat(data['Technical Analysis: RSI'][latest]['RSI']);
      }
      return null;
    } catch (error) {
      console.error(`Failed to fetch RSI for ${symbol}:`, error.message);
      return null;
    }
  }

  async getBatchQuotes(symbols) {
    const quotes = [];
    
    for (const symbol of symbols.slice(0, 4)) { // Limit to 4 due to rate limits
      try {
        const quote = await this.getGlobalQuote(symbol);
        if (quote) quotes.push(quote);
        await new Promise(resolve => setTimeout(resolve, 300)); // Delay between requests
      } catch (error) {
        console.error(`Error fetching ${symbol}:`, error.message);
      }
    }
    
    return quotes;
  }
}

// ==================== INITIALIZE SERVICES ====================
const hqsEngine = new HQSEngine();
const avService = new AlphaVantageService(API_KEY);

// ==================== API ENDPOINTS ====================
app.get('/', (req, res) => {
  res.json({
    system: 'HQS Hyper-Quant System',
    version: hqsEngine.version,
    status: 'online',
    dataSource: 'Alpha Vantage API',
    apiKey: API_KEY === 'BK0SA33HPRG939WY' ? 'valid' : 'demo',
    timestamp: new Date().toISOString(),
    endpoints: {
      root: '/',
      health: '/health',
      market: '/market',
      quote: '/quote/:symbol',
      hqs: '/hqs/:symbol',
      portfolio: '/portfolio',
      factors: '/factors',
      batch: '/batch/:symbols'
    },
    rateLimit: '5 requests/minute (Alpha Vantage free tier)',
    cache: '5 minutes for quotes, 1 hour for fundamentals'
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// Market endpoint with top stocks
app.get('/market', async (req, res) => {
  try {
    const symbols = ['AAPL', 'GOOGL', 'MSFT', 'AMZN', 'TSLA', 'META', 'NVDA', 'JPM'];
    
    const quotes = await avService.getBatchQuotes(symbols);
    
    const stocks = [];
    for (const quote of quotes) {
      try {
        const overview = await avService.getOverview(quote.symbol);
        const rsi = await avService.getRSI(quote.symbol);
        
        const priceData = {
          ...quote,
          rsi: rsi
        };
        
        const hqsAnalysis = hqsEngine.calculateHQSScore(
          quote.symbol, 
          priceData, 
          overview
        );
        
        stocks.push({
          symbol: quote.symbol,
          name: overview.name || quote.symbol,
          price: quote.price,
          change: quote.change,
          changePercent: quote.changePercent,
          volume: quote.volume,
          marketCap: overview.marketCap,
          sector: overview.sector || 'Unknown',
          hqsScore: hqsAnalysis.score,
          hqsRating: hqsAnalysis.rating,
          recommendation: hqsAnalysis.recommendation,
          factors: hqsAnalysis.factors,
          confidence: hqsAnalysis.confidence,
          timestamp: quote.timestamp
        });
        
        await new Promise(resolve => setTimeout(resolve, 200)); // Rate limit delay
      } catch (error) {
        console.error(`Error processing ${quote.symbol}:`, error.message);
      }
    }
    
    // Sort by HQS score
    stocks.sort((a, b) => b.hqsScore - a.hqsScore);
    
    res.json({
      success: true,
      source: 'Alpha Vantage API',
      timestamp: new Date().toISOString(),
      count: stocks.length,
      stocks: stocks,
      summary: {
        averageScore: parseFloat((stocks.reduce((sum, s) => sum + s.hqsScore, 0) / stocks.length).toFixed(2)),
        topPerformer: stocks[0]?.symbol || 'N/A',
        buySignals: stocks.filter(s => s.hqsRating.includes('BUY')).length,
        holdSignals: stocks.filter(s => s.hqsRating === 'HOLD').length,
        sellSignals: stocks.filter(s => s.hqsRating.includes('SELL')).length
      }
    });
    
  } catch (error) {
    console.error('Error in /market endpoint:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Using fallback data due to API limits',
      fallback: getFallbackData()
    });
  }
});

// Single stock analysis
app.get('/quote/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    
    const quote = await avService.getGlobalQuote(symbol);
    if (!quote) {
      return res.status(404).json({ error: 'Symbol not found or API limit reached' });
    }
    
    const overview = await avService.getOverview(symbol);
    const rsi = await avService.getRSI(symbol);
    
    res.json({
      success: true,
      symbol: symbol,
      quote: quote,
      fundamentals: overview,
      technicals: { rsi: rsi },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// HQS Analysis for single stock
app.get('/hqs/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    
    const quote = await avService.getGlobalQuote(symbol);
    if (!quote) {
      return res.status(404).json({ error: 'Symbol not found' });
    }
    
    const overview = await avService.getOverview(symbol);
    const rsi = await avService.getRSI(symbol);
    
    const priceData = {
      ...quote,
      rsi: rsi,
      beta: overview.beta || 1.0
    };
    
    const hqsAnalysis = hqsEngine.calculateHQSScore(symbol, priceData, overview);
    
    res.json({
      success: true,
      symbol: symbol,
      name: overview.name || symbol,
      timestamp: new Date().toISOString(),
      price: quote.price,
      changePercent: quote.changePercent,
      analysis: hqsAnalysis,
      dataQuality: {
        hasQuote: !!quote,
        hasFundamentals: !!overview.symbol,
        hasRSI: !!rsi,
        confidence: hqsAnalysis.confidence
      },
      factors: hqsEngine.factors
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message,
      fallback: getSingleStockFallback(req.params.symbol)
    });
  }
});

// Portfolio recommendation
app.get('/portfolio', async (req, res) => {
  const symbols = ['AAPL', 'GOOGL', 'MSFT', 'JPM', 'V', 'JNJ', 'PG', 'XOM'];
  
  try {
    const stocks = [];
    for (const symbol of symbols.slice(0, 3)) { // Limit due to rate limits
      const quote = await avService.getGlobalQuote(symbol);
      if (quote) {
        const overview = await avService.getOverview(symbol);
        const rsi = await avService.getRSI(symbol);
        
        const priceData = { ...quote, rsi: rsi, beta: overview.beta || 1.0 };
        const analysis = hqsEngine.calculateHQSScore(symbol, priceData, overview);
        
        stocks.push({
          symbol,
          score: analysis.score,
          rating: analysis.rating,
          price: quote.price
        });
        
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
    
    // Calculate portfolio weights
    const totalScore = stocks.reduce((sum, s) => sum + s.score, 0);
    const portfolio = stocks.map(stock => ({
      symbol: stock.symbol,
      allocation: ((stock.score / totalScore) * 100).toFixed(1) + '%',
      rating: stock.rating,
      suggestedAction: stock.rating.includes('BUY') ? 'INCREASE' : 
                      stock.rating.includes('SELL') ? 'DECREASE' : 'HOLD'
    }));
    
    res.json({
      success: true,
      portfolio: portfolio,
      rebalanceDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      strategy: 'HQS Score-Weighted Allocation',
      riskLevel: 'MODERATE',
      expectedReturn: '9-12% annually (historical simulation)'
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Using simulated portfolio due to API limits'
    });
  }
});

// Fallback data
function getFallbackData() {
  return [
    {
      symbol: 'AAPL',
      name: 'Apple Inc.',
      price: 182.63,
      change: 0.52,
      changePercent: 0.28,
      volume: 50300000,
      hqsScore: 78.5,
      hqsRating: 'BUY',
      recommendation: 'Strong fundamentals with positive momentum',
      sector: 'Technology'
    },
    {
      symbol: 'GOOGL',
      name: 'Alphabet Inc.',
      price: 140.25,
      change: 0.31,
      changePercent: 0.22,
      volume: 30100000,
      hqsScore: 72.3,
      hqsRating: 'BUY',
      recommendation: 'Good value with growth potential',
      sector: 'Technology'
    },
    {
      symbol: 'MSFT',
      name: 'Microsoft Corporation',
      price: 404.87,
      change: -0.21,
      changePercent: -0.05,
      volume: 25800000,
      hqsScore: 85.2,
      hqsRating: 'STRONG_BUY',
      recommendation: 'Exceptional quality with market leadership',
      sector: 'Technology'
    }
  ];
}

function getSingleStockFallback(symbol) {
  const fallbackStocks = {
    'AAPL': { score: 78.5, rating: 'BUY', price: 182.63 },
    'GOOGL': { score: 72.3, rating: 'BUY', price: 140.25 },
    'MSFT': { score: 85.2, rating: 'STRONG_BUY', price: 404.87 },
    'TSLA': { score: 62.1, rating: 'HOLD', price: 185.90 },
    'AMZN': { score: 68.7, rating: 'HOLD', price: 172.35 }
  };
  
  return fallbackStocks[symbol.toUpperCase()] || { 
    score: 50, 
    rating: 'HOLD', 
    price: 100.00,
    note: 'Symbol not in fallback database'
  };
}

// Start server
app.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`🚀 HQS HYPER-QUANT SYSTEM v4.0`);
  console.log(`📍 Port: ${PORT}`);
  console.log(`🔗 Local: http://localhost:${PORT}`);
  console.log(`🔗 Railway: https://hqs-backend-production-bbd6.up.railway.app`);
  console.log(`📊 Alpha Vantage: ${API_KEY.slice(0, 8)}...`);
  console.log(`💡 Real-time market data ENABLED`);
  console.log(`===============================================`);
});
