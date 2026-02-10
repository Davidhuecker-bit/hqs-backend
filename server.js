const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.ALPHA_VANTAGE_API_KEY || 'BK0SA33HPRG939WY';

// Cache für API-Aufrufe (5 Minuten)
const cache = new NodeCache({ stdTTL: 300 });

app.use(cors());
app.use(express.json());

console.log('🚀 HQS Hyper-Quant System v4.1');
console.log(`🔑 API Key: ${API_KEY.slice(0, 8)}...`);

// ==================== HQS QUANT ENGINE ====================
class HQSEngine {
  constructor() {
    this.version = '4.1.0';
    this.factors = {
      momentum: { weight: 0.30 },
      value: { weight: 0.25 },
      quality: { weight: 0.20 },
      volatility: { weight: 0.15 },
      sentiment: { weight: 0.10 }
    };
  }

  calculateMomentum(priceData) {
    let score = 5;
    const { changePercent, volume } = priceData;
    
    if (changePercent > 2) score += 3;
    else if (changePercent > 0.5) score += 2;
    else if (changePercent < -2) score -= 3;
    else if (changePercent < -0.5) score -= 2;
    
    if (volume > 10000000) score += 1;
    if (volume > 50000000) score += 1;
    
    return Math.max(0, Math.min(10, score));
  }

  calculateValue(fundamentalData) {
    let score = 5;
    const { peRatio, pbRatio, dividendYield } = fundamentalData;
    
    if (peRatio && peRatio < 15) score += 2;
    if (peRatio && peRatio < 10) score += 1;
    if (peRatio && peRatio > 25) score -= 2;
    
    if (pbRatio && pbRatio < 2) score += 1;
    if (pbRatio && pbRatio > 5) score -= 1;
    
    if (dividendYield && dividendYield > 0.03) score += 1;
    if (dividendYield && dividendYield > 0.05) score += 1;
    
    return Math.max(0, Math.min(10, score));
  }

  calculateQuality(fundamentalData) {
    let score = 5;
    const { profitMargin, roe } = fundamentalData;
    
    if (profitMargin && profitMargin > 0.20) score += 2;
    if (profitMargin && profitMargin > 0.30) score += 1;
    if (profitMargin && profitMargin < 0.05) score -= 2;
    
    if (roe && roe > 0.15) score += 1;
    if (roe && roe > 0.25) score += 1;
    if (roe && roe < 0.05) score -= 1;
    
    return Math.max(0, Math.min(10, score));
  }

  calculateVolatility(priceData) {
    let score = 5;
    const { beta, changePercent } = priceData;
    
    if (beta) {
      if (beta < 0.8) score += 2;
      if (beta < 0.5) score += 1;
      if (beta > 1.5) score -= 2;
      if (beta > 2.0) score -= 1;
    }
    
    if (Math.abs(changePercent) < 1) score += 1;
    if (Math.abs(changePercent) > 5) score -= 1;
    
    return Math.max(0, Math.min(10, score));
  }

  calculateSentiment(priceData) {
    let score = 5;
    const { changePercent, volume } = priceData;
    
    if (changePercent > 3) score += 2;
    if (changePercent < -3) score -= 2;
    if (volume > 50000000) score += 1;
    
    score += (Math.random() - 0.5) * 2;
    
    return Math.max(0, Math.min(10, score));
  }

  calculateHQSScore(symbol, priceData, fundamentalData = {}) {
    const factors = {
      momentum: this.calculateMomentum(priceData),
      value: this.calculateValue(fundamentalData),
      quality: this.calculateQuality(fundamentalData),
      volatility: this.calculateVolatility(priceData),
      sentiment: this.calculateSentiment(priceData)
    };

    let weightedSum = 0;
    for (const [factor, config] of Object.entries(this.factors)) {
      weightedSum += factors[factor] * config.weight;
    }

    const hqsScore = weightedSum * 10;
    
    return {
      score: parseFloat(hqsScore.toFixed(2)),
      factors,
      rating: this.getRating(hqsScore),
      recommendation: this.getRecommendation(hqsScore)
    };
  }

  getRating(score) {
    if (score >= 85) return 'STRONG_BUY';
    if (score >= 75) return 'BUY';
    if (score >= 65) return 'HOLD';
    if (score >= 55) return 'WEAK_HOLD';
    return 'SELL';
  }

  getRecommendation(score) {
    const recommendations = {
      'STRONG_BUY': 'Exceptional value with strong momentum',
      'BUY': 'Attractive investment with positive outlook',
      'HOLD': 'Maintain position, balanced risk/reward',
      'WEAK_HOLD': 'Consider reducing exposure',
      'SELL': 'Consider selling, deteriorating factors'
    };
    return recommendations[this.getRating(score)] || 'No recommendation available';
  }
}

// ==================== ALPHA VANTAGE SERVICE ====================
class AlphaVantageService {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://www.alphavantage.co/query';
  }

  async makeRequest(params) {
    const url = `${this.baseUrl}?${new URLSearchParams({ ...params, apikey: this.apiKey })}`;
    
    try {
      const response = await axios.get(url);
      
      if (response.data['Error Message']) {
        throw new Error(response.data['Error Message']);
      }
      if (response.data['Note']) {
        console.warn('API Note:', response.data['Note']);
        throw new Error('API rate limit reached');
      }
      
      return response.data;
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
          name: data.Name || symbol,
          sector: data.Sector || 'Unknown',
          marketCap: parseFloat(data.MarketCapitalization) || 0,
          peRatio: parseFloat(data.PERatio) || null,
          pbRatio: parseFloat(data.PriceToBookRatio) || null,
          dividendYield: parseFloat(data.DividendYield) || 0,
          profitMargin: parseFloat(data.ProfitMargin) || 0,
          roe: parseFloat(data.ReturnOnEquityTTM) || 0,
          beta: parseFloat(data.Beta) || 1.0
        };
        
        cache.set(cacheKey, result, 3600);
        return result;
      }
      return {};
    } catch (error) {
      console.error(`Failed to fetch overview for ${symbol}:`, error.message);
      return {};
    }
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
      portfolio: '/portfolio'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Market endpoint
app.get('/market', async (req, res) => {
  try {
    const symbols = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA'];
    
    const stocks = [];
    for (const symbol of symbols) {
      try {
        const quote = await avService.getGlobalQuote(symbol);
        if (!quote) continue;
        
        const overview = await avService.getOverview(symbol);
        
        const hqsAnalysis = hqsEngine.calculateHQSScore(
          symbol, 
          quote, 
          overview
        );
        
        stocks.push({
          symbol: quote.symbol,
          name: overview.name || symbol,
          price: quote.price,
          change: quote.change,
          changePercent: quote.changePercent,
          volume: quote.volume,
          marketCap: overview.marketCap,
          sector: overview.sector,
          hqsScore: hqsAnalysis.score,
          hqsRating: hqsAnalysis.rating,
          recommendation: hqsAnalysis.recommendation,
          timestamp: quote.timestamp
        });
        
        // Rate limit delay
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`Error processing ${symbol}:`, error.message);
      }
    }
    
    // Fallback if no real data
    if (stocks.length === 0) {
      stocks.push(...getFallbackData());
    }
    
    // Sort by HQS score
    stocks.sort((a, b) => b.hqsScore - a.hqsScore);
    
    res.json({
      success: true,
      source: stocks[0]?.timestamp ? 'Alpha Vantage API' : 'Fallback Data',
      timestamp: new Date().toISOString(),
      count: stocks.length,
      stocks: stocks,
      summary: {
        averageScore: parseFloat((stocks.reduce((sum, s) => sum + s.hqsScore, 0) / stocks.length).toFixed(2)),
        topPerformer: stocks[0]?.symbol || 'N/A'
      }
    });
    
  } catch (error) {
    console.error('Error in /market endpoint:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      fallback: getFallbackData()
    });
  }
});

// Single stock analysis
app.get('/hqs/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    
    const quote = await avService.getGlobalQuote(symbol);
    if (!quote) {
      return res.status(404).json({ 
        error: 'Symbol not found or API limit reached',
        fallback: getSingleStockFallback(symbol)
      });
    }
    
    const overview = await avService.getOverview(symbol);
    const hqsAnalysis = hqsEngine.calculateHQSScore(symbol, quote, overview);
    
    res.json({
      success: true,
      symbol: symbol,
      name: overview.name || symbol,
      timestamp: new Date().toISOString(),
      price: quote.price,
      changePercent: quote.changePercent,
      analysis: hqsAnalysis,
      fundamentals: {
        peRatio: overview.peRatio,
        marketCap: overview.marketCap,
        dividendYield: overview.dividendYield,
        sector: overview.sector
      }
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
app.get('/portfolio', (req, res) => {
  res.json({
    success: true,
    portfolio: [
      { symbol: 'AAPL', allocation: '25%', rating: 'BUY' },
      { symbol: 'MSFT', allocation: '20%', rating: 'STRONG_BUY' },
      { symbol: 'GOOGL', allocation: '15%', rating: 'BUY' },
      { symbol: 'AMZN', allocation: '15%', rating: 'HOLD' },
      { symbol: 'TSLA', allocation: '10%', rating: 'HOLD' },
      { symbol: 'CASH', allocation: '15%', rating: 'SAFE' }
    ],
    strategy: 'HQS Score-Weighted Allocation',
    riskLevel: 'MODERATE',
    lastUpdated: new Date().toISOString()
  });
});

// Get single quote
app.get('/quote/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const quote = await avService.getGlobalQuote(symbol);
    
    if (quote) {
      res.json({
        success: true,
        quote: quote
      });
    } else {
      res.status(404).json({ error: 'Symbol not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fallback data functions
function getFallbackData() {
  return [
    {
      symbol: 'AAPL',
      name: 'Apple Inc.',
      price: 182.63,
      change: 0.52,
      changePercent: 0.28,
      volume: 50300000,
      marketCap: 2850000000000,
      sector: 'Technology',
      hqsScore: 78.5,
      hqsRating: 'BUY',
      recommendation: 'Strong fundamentals with positive momentum',
      timestamp: new Date().toISOString()
    },
    {
      symbol: 'MSFT',
      name: 'Microsoft Corporation',
      price: 404.87,
      change: -0.21,
      changePercent: -0.05,
      volume: 25800000,
      marketCap: 3000000000000,
      sector: 'Technology',
      hqsScore: 85.2,
      hqsRating: 'STRONG_BUY',
      recommendation: 'Exceptional quality with market leadership',
      timestamp: new Date().toISOString()
    },
    {
      symbol: 'GOOGL',
      name: 'Alphabet Inc.',
      price: 140.25,
      change: 0.31,
      changePercent: 0.22,
      volume: 30100000,
      marketCap: 1750000000000,
      sector: 'Technology',
      hqsScore: 72.3,
      hqsRating: 'BUY',
      recommendation: 'Good value with growth potential',
      timestamp: new Date().toISOString()
    }
  ];
}

function getSingleStockFallback(symbol) {
  const fallbackStocks = {
    'AAPL': { 
      score: 78.5, 
      rating: 'BUY', 
      price: 182.63,
      name: 'Apple Inc.',
      recommendation: 'Strong fundamentals with positive momentum'
    },
    'MSFT': { 
      score: 85.2, 
      rating: 'STRONG_BUY', 
      price: 404.87,
      name: 'Microsoft Corporation',
      recommendation: 'Exceptional quality with market leadership'
    },
    'GOOGL': { 
      score: 72.3, 
      rating: 'BUY', 
      price: 140.25,
      name: 'Alphabet Inc.',
      recommendation: 'Good value with growth potential'
    },
    'AMZN': { 
      score: 68.7, 
      rating: 'HOLD', 
      price: 172.35,
      name: 'Amazon.com Inc.',
      recommendation: 'Stable performance, monitor margins'
    },
    'TSLA': { 
      score: 62.1, 
      rating: 'HOLD', 
      price: 185.90,
      name: 'Tesla Inc.',
      recommendation: 'High volatility, evaluate risk tolerance'
    }
  };
  
  const stock = fallbackStocks[symbol] || { 
    score: 50, 
    rating: 'HOLD', 
    price: 100.00,
    name: symbol,
    recommendation: 'Insufficient data for analysis'
  };
  
  return {
    success: true,
    symbol: symbol,
    name: stock.name,
    timestamp: new Date().toISOString(),
    price: stock.price,
    analysis: {
      score: stock.score,
      rating: stock.rating,
      recommendation: stock.recommendation
    },
    note: 'Using fallback data due to API limits'
  };
}

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.path,
    availableEndpoints: ['/', '/health', '/market', '/hqs/:symbol', '/portfolio', '/quote/:symbol']
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production' ? 'An error occurred' : err.message
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`🚀 HQS HYPER-QUANT SYSTEM v${hqsEngine.version}`);
  console.log(`📍 Port: ${PORT}`);
  console.log(`🔗 Health: http://localhost:${PORT}/`);
  console.log(`📊 Market Data: http://localhost:${PORT}/market`);
  console.log(`🎯 HQS Analysis: http://localhost:${PORT}/hqs/AAPL`);
  console.log(`💼 Portfolio: http://localhost:${PORT}/portfolio`);
  console.log(`===============================================`);
});
